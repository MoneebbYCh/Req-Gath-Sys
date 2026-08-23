import type { TaskRunner } from '../runtime/AgentRuntime'
import { StreamCoalescer } from '../runtime/StreamCoalescer'
import type { EvidenceCandidate } from '../contracts/Evidence'
import type { ModelProvider } from './ModelProvider'
import type {
  ModelMessage,
  ModelRequest,
  ModelToolCall,
  ModelToolDefinition,
} from './ModelTypes'
import { ProviderError, isRetryableProviderError } from './ProviderError'
import { TaskBudgetController, type TaskTelemetry } from '../observability/TaskControls'

const DEFAULT_SYSTEM =
  'You are Charter Ai, a read-only repository analysis assistant. Answer accurately ' +
  'and distinguish repository facts from recommendations. Use the provided tools to ' +
  'ground claims in the actual repository.'

/**
 * Executes a repository tool on behalf of the model loop. The optional
 * `signal` (plan §7) propagates task cancellation into in-flight host-side
 * tool execution.
 */
export interface ToolExecutor {
  execute(
    name: string,
    input: unknown,
    signal?: AbortSignal,
  ): Promise<{ ok: boolean; result?: unknown; error?: string }>
}

export interface ToolLoopConfig {
  model: string
  system?: string
  tools?: ModelToolDefinition[]
  /** Hard bound on model passes (plan §8 fast path is bounded). */
  maxIterations?: number
  /** Hard bound on executed tool calls. */
  maxToolCalls?: number
  /** Absolute provider-call cap, including the final synthesis pass. */
  maxModelCalls?: number
  /** Per-provider-call completion cap. */
  maxOutputTokens?: number
  /** Request a provider-enforced JSON object for structured worker output. */
  responseFormat?: 'json_object'
  /** Per-workload provider reasoning policy. */
  thinking?: ModelRequest['thinking']
  /** Approximate input budget; oldest tool exchanges are removed first. */
  maxInputTokens?: number
  /**
   * Phase 7: committed to the evidence ledger for every successful tool
   * result that carries evidenceCandidates — repository observations become
   * durable, deduplicated knowledge instead of vanishing with the turn.
   * Returns the committed evidence ids so workers can attach them to findings.
   */
  recordEvidence?: (candidates: EvidenceCandidate[], repositoryVersion: string, sourceTool: string) => string[]
  /** Phase 16: shared task-wide controls, never a per-loop replacement. */
  budgetController?: TaskBudgetController
  telemetry?: TaskTelemetry
  telemetryContext?: { taskId?: string; nodeId?: string; workerType?: string; route?: 'strong' | 'fast' }
}

interface PassResult {
  toolCalls: ModelToolCall[]
  assistantContent: string
  reasoningContent: string
  usage?: { inputTokens: number; outputTokens: number }
  durationMs: number
  retries: number
}

/** Exponential backoff + jitter (plan §14 retry taxonomy). */
function retryDelay(attempt: number): number {
  return 500 * 2 ** attempt + Math.random() * 250
}

/**
 * Plan §3 edge case (429 with retry headers): when the provider sends a
 * Retry-After value, honor it instead of the local backoff schedule.
 */
function delayFor(err: unknown, attempt: number): number {
  if (err instanceof ProviderError && err.retryAfterMs !== undefined) return err.retryAfterMs
  return retryDelay(attempt)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Context-window failures trigger a rebuild-and-retry, not blind retries. */
function isContextOverflow(err: unknown): boolean {
  if (!(err instanceof ProviderError)) return false
  return /context|maximum (?:context )?length|too many tokens|reduce the length/i.test(err.message)
}

/** One provider pass: streams text deltas to the UI, collects tool calls. */
async function runPass(
  provider: ModelProvider,
  request: ModelRequest,
  signal: AbortSignal,
  onActivity: (a: string) => void,
  onAssistantStarted: () => void,
  onDelta: (text: string) => void,
  textStarted: { value: boolean },
): Promise<PassResult> {
  const startedAt = Date.now()
  const coalescer = new StreamCoalescer(onDelta, {
    maxWaitMs: 40,
    maxChars: 400,
  })
  const toolCalls = new Map<string, ModelToolCall>()
  let assistantContent = ''
  let reasoningContent = ''
  let usage: PassResult['usage']
  const MAX_STREAM_RETRIES = 2

  try {
    for (let attempt = 0; ; attempt++) {
      try {
        for await (const event of provider.stream(request, signal)) {
          switch (event.type) {
            case 'text_delta':
              assistantContent += event.text
              if (!textStarted.value) {
                onAssistantStarted()
                textStarted.value = true
              }
              coalescer.push(event.text)
              break
            case 'reasoning_delta':
              // Kept out of the chat transcript; it is only replayed to
              // providers (notably DeepSeek) after a tool call.
              reasoningContent += event.text
              break
            case 'tool_call_started':
              toolCalls.set(event.id, { id: event.id, name: event.name, arguments: '' })
              break
            case 'tool_call_delta': {
              const tc = toolCalls.get(event.id)
              if (tc) tc.arguments += event.argumentsDelta
              break
            }
            case 'tool_call_completed': {
              const existing = toolCalls.get(event.id)
              if (existing) {
                existing.name = event.name || existing.name
                existing.arguments = event.arguments || existing.arguments
              } else {
                toolCalls.set(event.id, { id: event.id, name: event.name, arguments: event.arguments })
              }
              break
            }
            case 'usage':
              usage = event.usage
              break
            case 'finish':
              break
            case 'provider_warning':
              onActivity(event.message)
              break
          }
        }
        break
      } catch (err) {
        // Plan §14: retry only transient provider failures BEFORE any output
        // arrived this pass. After text/tools started streaming, partial
        // results are preserved instead (§23.7) — a retry would re-stream the
        // pass from scratch and duplicate visible text.
        if (
          attempt >= MAX_STREAM_RETRIES ||
          !isRetryableProviderError(err) ||
          signal.aborted ||
          textStarted.value ||
          toolCalls.size > 0
        ) {
          throw err
        }
        onActivity('Provider hiccup — retrying')
        await sleep(delayFor(err, attempt))
      }
    }
    coalescer.flushNow()
    return {
      toolCalls: [...toolCalls.values()],
      assistantContent,
      reasoningContent,
      usage,
      durationMs: Date.now() - startedAt,
      retries: 0,
    }
  } catch (err) {
    // Preserve partially streamed text before failing (plan §23.7).
    coalescer.flushNow()
    coalescer.dispose()
    throw err
  }
}

function parseToolArguments(raw: string): unknown {
  const trimmed = raw.trim()
  if (!trimmed) return {}
  try {
    return JSON.parse(trimmed)
  } catch {
    // Malformed JSON reaches the gateway, which validates it structurally.
    return { raw: trimmed }
  }
}

function withinInputBudget(messages: ModelMessage[], maxInputTokens: number | undefined): ModelMessage[] {
  if (maxInputTokens === undefined) return messages
  const maxChars = Math.max(1, maxInputTokens) * 4
  const size = (items: ModelMessage[]) => items.reduce((total, message) => total + message.content.length, 0)
  const compact = [...messages]
  while (size(compact) > maxChars) {
    const toolIndex = compact.findIndex((message) => message.role === 'tool')
    if (toolIndex === -1) break
    compact.splice(Math.max(1, toolIndex - 1), 2)
  }
  if (size(compact) <= maxChars || compact.length === 0) return compact
  const first = compact[0]
  if (first.role === 'user' || first.role === 'system') {
    compact[0] = { ...first, content: first.content.slice(-maxChars) }
  }
  return compact
}

export interface ToolLoopRunOptions {
  /** The user text / node objective that starts the conversation. */
  text: string
  signal: AbortSignal
  activity?: (activity: string) => void
  /** Called before the first coalesced delta. */
  assistantStarted?: () => void
  /** Coalesced text chunks. */
  delta?: (text: string) => void
  /** Runtime-only layers consumed by ContextualModelProvider. */
  context?: ModelRequest['context']
}

export interface ToolLoopRunResult {
  /** Full assistant text (all deltas joined) — empty when nothing streamed. */
  text: string
  toolCallsUsed: number
  /** Evidence ids committed during this run (Phase 7/9). */
  evidenceIds: string[]
  /** Phase 16 content-free accounting for this loop. */
  usage: { modelCalls: number; inputTokens: number; outputTokens: number; retries: number }
  budgetExhausted: boolean
}

/**
 * Bounded ReAct fast path (plan §8's simple-question loop): streams the model
 * pass by pass, executes tool calls through the executor, and feeds results
 * back until the model answers without tools (or the bounds are hit).
 *
 * Exported so the Phase 8 orchestrator can reuse it as the node executor —
 * Phase 9 swaps in role-aware workers without changing the loop mechanics.
 */
export async function runToolLoop(
  provider: ModelProvider,
  executor: ToolExecutor,
  config: ToolLoopConfig,
  options: ToolLoopRunOptions,
): Promise<ToolLoopRunResult> {
  const signal = options.signal
  const activity = options.activity ?? (() => {})
  const onDelta = options.delta ?? (() => {})
  const onAssistantStarted = options.assistantStarted ?? (() => {})

  const messages: ModelMessage[] = [{ role: 'user', content: options.text }]
  const tools = config.tools ?? []
  const maxIterations = config.maxIterations ?? 4
  const maxModelCalls = config.maxModelCalls
  const maxToolCalls = config.maxToolCalls ?? 12
  let toolCallsUsed = 0
  const textStarted = { value: false }
  let fullText = ''
  const evidenceIds: string[] = []

  activity('Requesting model response')

  const base = (): Omit<ModelRequest, 'messages'> => ({
    model: config.model || 'default',
    system: config.system ?? DEFAULT_SYSTEM,
    tools,
    maxOutputTokens: config.maxOutputTokens,
    responseFormat: config.responseFormat,
    thinking: config.thinking,
    context: options.context,
  })

  let modelCallsUsed = 0
  let inputTokens = 0
  let outputTokens = 0
  let retries = 0
  let budgetExhausted = false
  const pass = (request: ModelRequest): Promise<PassResult> => {
    if (maxModelCalls !== undefined && modelCallsUsed >= maxModelCalls) {
      budgetExhausted = true
      activity('Model budget reached — synthesizing from available evidence only')
      return Promise.resolve({ toolCalls: [], assistantContent: '', reasoningContent: '', durationMs: 0, retries: 0 })
    }
    const estimatedInput = Math.ceil(request.messages.reduce((size, message) => size + message.content.length, 0) / 4)
    const reservation = config.budgetController?.tryReserveModel(estimatedInput, request.maxOutputTokens ?? 0)
    if (config.budgetController && !reservation) {
      budgetExhausted = true
      config.telemetry?.({ kind: 'budget', ...config.telemetryContext, model: request.model, reason: 'model budget exhausted' })
      activity('Task budget reached — synthesizing from available evidence only')
      return Promise.resolve({ toolCalls: [], assistantContent: '', reasoningContent: '', durationMs: 0, retries: 0 })
    }
    modelCallsUsed++
    return runPass(provider, request, signal, activity, onAssistantStarted, delta, textStarted).then((result) => {
      retries += result.retries
      inputTokens += result.usage?.inputTokens ?? estimatedInput
      outputTokens += result.usage?.outputTokens ?? 0
      config.budgetController?.settleModel(reservation!, result.usage)
      config.telemetry?.({
        kind: 'model', ...config.telemetryContext, model: request.model, durationMs: result.durationMs,
        inputTokens: result.usage?.inputTokens ?? estimatedInput, outputTokens: result.usage?.outputTokens ?? 0, ok: true,
      })
      return result
    })
  }

  const delta = (t: string): void => {
    fullText += t
    onDelta(t)
  }

  // One context rebuild per loop (plan §14): a context-window failure drops
  // the oldest raw tool bodies and retries once — never blind retries.
  let rebuilt = false
  while (true) {
    try {
      let needsSynthesis = false
      let lastSignature = ''
      let signatureRepeats = 0
      for (let iteration = 0; iteration < maxIterations; iteration++) {
        const passResult = await pass({ ...base(), messages: withinInputBudget(messages, config.maxInputTokens) })
        if (signal.aborted) break
        if (passResult.toolCalls.length === 0) {
          needsSynthesis = false
          break
        }
        // Loop detection (plan §14): identical tool-call sets repeated across
        // iterations mean the model is stuck — stop and synthesize instead.
        const signature = passResult.toolCalls
          .map((c) => `${c.name}:${c.arguments}`)
          .sort()
          .join('|')
        if (signature && signature === lastSignature) {
          signatureRepeats++
        } else {
          lastSignature = signature
          signatureRepeats = 0
        }
        if (signatureRepeats >= 2) {
          activity('Repeated identical tool calls — stopping the search loop')
          needsSynthesis = true
          break
        }
        // Preserve the model's complete assistant turn before tool results.
        // DeepSeek requires reasoningContent from this exact tool-call turn
        // to be echoed on the following request; one turn may contain several
        // calls, so it must not be split into one assistant message per call.
        messages.push({
          role: 'assistant',
          content: passResult.assistantContent,
          reasoningContent: passResult.reasoningContent || undefined,
          toolCalls: passResult.toolCalls,
        })
        for (const call of passResult.toolCalls) {
          if (signal.aborted) break
          activity(`Using tool: ${call.name}`)
          const canUseTool = toolCallsUsed < maxToolCalls && (config.budgetController?.tryReserveTool() ?? true)
          if (!canUseTool) {
            budgetExhausted = true
            config.telemetry?.({ kind: 'budget', ...config.telemetryContext, reason: 'tool budget exhausted' })
          }
          const startedAt = Date.now()
          const result =
            !canUseTool
              ? { ok: false, error: 'Tool budget reached — answer from available information.' }
              : await executor.execute(call.name, parseToolArguments(call.arguments), signal)
          toolCallsUsed++
          config.telemetry?.({ kind: 'tool', ...config.telemetryContext, tool: call.name, durationMs: Date.now() - startedAt, ok: result.ok })
          activity(result.ok ? `Tool ${call.name} finished` : `Tool ${call.name} failed`)
          let resultEvidenceIds: string[] = []
          if (result.ok && config.recordEvidence) {
            const payload = result.result as
              | { evidenceCandidates?: unknown; repositoryVersion?: unknown }
              | undefined
            if (payload && Array.isArray(payload.evidenceCandidates) && payload.evidenceCandidates.length > 0) {
              const ids =
                config.recordEvidence(
                  payload.evidenceCandidates as EvidenceCandidate[],
                  typeof payload.repositoryVersion === 'string' ? payload.repositoryVersion : 'unknown',
                  call.name,
                ) ?? []
              resultEvidenceIds = ids
              evidenceIds.push(...ids)
            }
          }
          messages.push({
            role: 'tool',
            content: result.ok
              ? `${JSON.stringify(result.result)}${evidenceHandleContext(resultEvidenceIds)}`
              : `Tool error: ${result.error ?? 'unknown'}`,
            toolCallId: call.id,
            name: call.name,
          })
        }
        needsSynthesis = true
      }

      // The last pass only produced tool calls — give the model one tool-free
      // pass to synthesize a final answer from the results.
      if (needsSynthesis && !signal.aborted && (maxModelCalls === undefined || modelCallsUsed < maxModelCalls)) {
        activity('Synthesizing answer from tool results')
        await pass({ ...base(), messages: withinInputBudget(messages, config.maxInputTokens), tools: [] })
      }

      return { text: fullText, toolCallsUsed, evidenceIds, usage: { modelCalls: modelCallsUsed, inputTokens, outputTokens, retries }, budgetExhausted }
    } catch (err) {
      if (signal.aborted) return { text: fullText, toolCallsUsed, evidenceIds, usage: { modelCalls: modelCallsUsed, inputTokens, outputTokens, retries }, budgetExhausted }
      if (!rebuilt && isContextOverflow(err)) {
        const toolIdx = messages.findIndex((m) => m.role === 'tool')
        if (toolIdx === -1) throw err
        // Drop the oldest assistant+tool pair; keep the user message at index 0.
        // ponytail: one rebuild pass; repeated overflow → let the caller fail.
        messages.splice(Math.max(1, toolIdx - 1), 2)
        rebuilt = true
        activity('Context window exceeded — rebuilding context and retrying')
        continue
      }
      if (err instanceof ProviderError) throw err
      throw new ProviderError('unknown', err instanceof Error ? err.message : String(err))
    }
  }
}

/** Makes provenance addressable by the model without trusting model-invented ids. */
function evidenceHandleContext(ids: string[]): string {
  if (ids.length === 0) return ''
  return `\n\nEvidence handles from this tool result (cite only these exact ids): ${ids
    .map((id) => `[EVIDENCE:${id}]`)
    .join(' ')}`
}

/** TaskRunner adapter: the bounded loop as a single-task executor. */
export function toolLoopTaskRunner(
  provider: ModelProvider,
  executor: ToolExecutor,
  config: ToolLoopConfig,
): TaskRunner {
  return async ({ handle, emit, text }) => {
    const defaultModelCalls = config.maxModelCalls ?? (config.maxIterations ?? 4) + 1
    const budgetController = config.budgetController ?? new TaskBudgetController({
      maxModelCalls: defaultModelCalls,
      maxToolCalls: config.maxToolCalls ?? 12,
      // Config limits are per provider call; preserve existing fast-path
      // behaviour while still producing one task-level aggregate controller.
      maxInputTokens: (config.maxInputTokens ?? 32_000) * defaultModelCalls,
      maxOutputTokens: (config.maxOutputTokens ?? 4_000) * defaultModelCalls,
      maxParallelWorkers: 1,
      maxReplans: 0,
    })
    const result = await runToolLoop(provider, executor, {
      ...config,
      budgetController,
      telemetryContext: { ...config.telemetryContext, taskId: handle.taskId },
    }, {
      text,
      signal: handle.signal,
      activity: (a) => emit.activity(a),
      assistantStarted: () => emit.assistantStarted(),
      delta: (t) => emit.assistantDelta(t),
      context: {
        task: { taskId: handle.taskId, title: handle.title, objective: text, status: handle.status },
        instructions: [`User request: ${text}`],
      },
    })
    if (result.text.length > 0) emit.assistantCompleted()
  }
}
