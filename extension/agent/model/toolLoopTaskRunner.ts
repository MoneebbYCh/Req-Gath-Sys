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
import { TaskBudgetController, type TaskTelemetry, type ModelPricing } from '../observability/TaskControls'
import type { OperationalDiagnostic } from '../observability/OperationalLogger'

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
  /** Per-model pricing for cost estimation. If omitted, cost is not calculated. */
  pricing?: ModelPricing
  telemetry?: TaskTelemetry
  telemetryContext?: { taskId?: string; nodeId?: string; workerType?: string; route?: 'strong' | 'fast' }
  /**
   * Content-bearing debug trace (LLM approach, tool args/output). Optional and
   * only wired in when a caller wants full detail; emit at `level: 'debug'`.
   */
  diagnostic?: (d: OperationalDiagnostic) => void
  /**
   * Batched execution of independent tool calls within a pass. Unset/0 keeps
   * the legacy sequential behavior; a value >1 is the concurrency ceiling.
   * All repository tools are read-only, so batching is safe.
   */
  parallelToolCalls?: number
  /** Invoked after each pass so callers can mirror mid-loop state durably. */
  onLoopCheckpoint?: (state: LoopCheckpoint) => void
  /** Called after each model call settles with the budget snapshot (tokens + cost). */
  onUsageUpdated?: (usage: {
    inputTokens: number
    outputTokens: number
    cacheReadTokens?: number
    cacheWriteTokens?: number
    reasoningTokens?: number
    estimatedCost?: number
  }) => void
}

/** Mid-loop snapshot handed to durable state (plan §14 single-loop resume). */
export interface LoopCheckpoint {
  messages: ModelMessage[]
  toolCallsUsed: number
  modelCallsUsed: number
  evidenceIds: string[]
}

/** Budget presets selected by model tier (plan §16 model tiering). */
export type BudgetTier = 'fast' | 'standard' | 'reasoner'

export const TOOL_LOOP_BUDGET_PRESETS: Record<BudgetTier, { maxIterations: number; maxToolCalls: number; maxInputTokens: number; maxOutputTokens: number }> = {
  fast: { maxIterations: 8, maxToolCalls: 24, maxInputTokens: 48_000, maxOutputTokens: 8_000 },
  standard: { maxIterations: 6, maxToolCalls: 18, maxInputTokens: 40_000, maxOutputTokens: 6_000 },
  reasoner: { maxIterations: 4, maxToolCalls: 12, maxInputTokens: 32_000, maxOutputTokens: 4_000 },
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

function toWorkerType(value: string | undefined): OperationalDiagnostic['workerType'] {
  return value === 'repository' || value === 'analysis' || value === 'document' || value === 'validation'
    ? value
    : undefined
}

interface ToolCallSlot {
  call: ModelToolCall
  canUse: boolean
}

interface ToolExecution {
  name: string
  result: { ok: boolean; result?: unknown; error?: string }
  durationMs: number
}

/**
 * Executes affordable tool calls with bounded concurrency and re-orders results
 * back to call order (deterministic history for the model). Non-executable
 * slots (budget/abort) resolve in place with a structured error.
 */
async function executeToolCalls(
  slots: ToolCallSlot[],
  executor: ToolExecutor,
  signal: AbortSignal,
  concurrency: number,
): Promise<ToolExecution[]> {
  const results: ToolExecution[] = new Array(slots.length)
  const runnable = slots
    .map((slot, index) => ({ slot, index }))
    .filter((entry) => entry.slot.canUse)
  const limit = concurrency > 1 ? concurrency : 1
  let cursor = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      const next = cursor++
      if (next >= runnable.length) return
      const { slot, index } = runnable[next]
      const startedAt = Date.now()
      const result = signal.aborted
        ? { ok: false as const, error: 'Tool call cancelled.' }
        : await executor.execute(slot.call.name, parseToolArguments(slot.call.arguments), signal)
      results[index] = { name: slot.call.name, result, durationMs: Date.now() - startedAt }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, runnable.length)) }, () => worker()))
  for (let i = 0; i < slots.length; i++) {
    if (!results[i]) {
      results[i] = {
        name: slots[i].call.name,
        result: { ok: false, error: 'Tool budget reached — answer from available information.' },
        durationMs: 0,
      }
    }
  }
  return results
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
  /** Resume a mid-loop conversation (plan §14 single-loop crash recovery). */
  resume?: LoopCheckpoint
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

  const messages: ModelMessage[] = options.resume
    ? options.resume.messages.map((m) => ({ ...m }))
    : [{ role: 'user', content: options.text }]
  const tools = config.tools ?? []
  const maxIterations = config.maxIterations ?? 4
  const maxModelCalls = config.maxModelCalls
  const maxToolCalls = config.maxToolCalls ?? 12
  let toolCallsUsed = options.resume?.toolCallsUsed ?? 0
  const textStarted = { value: false }
  let fullText = ''
  const evidenceIds: string[] = options.resume?.evidenceIds ? [...options.resume.evidenceIds] : []

  activity('Requesting model response')

  // Debug-only trace of the LLM approach this loop was configured with.
  config.diagnostic?.({
    event: 'llm.approach',
    level: 'debug',
    taskId: config.telemetryContext?.taskId,
    nodeId: config.telemetryContext?.nodeId,
    workerType: toWorkerType(config.telemetryContext?.workerType),
    route: config.telemetryContext?.route,
    model: config.model,
    systemPrompt: config.system ?? DEFAULT_SYSTEM,
    thinking: config.thinking,
    responseFormat: config.responseFormat,
    toolNames: tools.map((t) => t.name),
    maxOutputTokens: config.maxOutputTokens,
    maxIterations,
    maxToolCalls,
    parallelToolCalls: config.parallelToolCalls,
  })

  const base = (): Omit<ModelRequest, 'messages'> => ({
    model: config.model || 'default',
    system: config.system ?? DEFAULT_SYSTEM,
    tools,
    maxOutputTokens: config.maxOutputTokens,
    responseFormat: config.responseFormat,
    thinking: config.thinking,
    context: options.context,
  })

  let modelCallsUsed = options.resume?.modelCallsUsed ?? 0
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
      // Emit live usage update (tokens + cost) after each model call.
      if (config.onUsageUpdated) {
        if (config.budgetController) {
          const snapshot = config.budgetController.snapshot()
          config.onUsageUpdated({
            inputTokens: snapshot.inputTokens,
            outputTokens: snapshot.outputTokens,
            cacheReadTokens: snapshot.cacheReadTokens,
            cacheWriteTokens: snapshot.cacheWriteTokens,
            reasoningTokens: snapshot.reasoningTokens,
            estimatedCost: snapshot.estimatedCost,
          })
        } else {
          config.onUsageUpdated({ inputTokens, outputTokens })
        }
      }
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
        // Reserve budget in call order (mirrors the sequential path), then run
        // the affordable calls with bounded parallelism. Tool messages are
        // appended back in call order for a deterministic model history.
        const slots: ToolCallSlot[] = passResult.toolCalls.map((call) => {
          const canUse =
            !signal.aborted &&
            toolCallsUsed < maxToolCalls &&
            (config.budgetController?.tryReserveTool() ?? true)
          toolCallsUsed++
          if (!canUse) {
            budgetExhausted = true
            config.telemetry?.({ kind: 'budget', ...config.telemetryContext, reason: 'tool budget exhausted' })
          }
          return { call, canUse }
        })
        for (const slot of slots) activity(`Using tool: ${slot.call.name}`)
        const executions = await executeToolCalls(slots, executor, signal, config.parallelToolCalls ?? 0)
        for (let i = 0; i < slots.length; i++) {
          const execution = executions[i]
          const call = slots[i].call
          config.telemetry?.({
            kind: 'tool', ...config.telemetryContext, tool: call.name, durationMs: execution.durationMs, ok: execution.result.ok,
          })
          config.diagnostic?.({
            event: 'tool.executed',
            level: 'debug',
            taskId: config.telemetryContext?.taskId,
            nodeId: config.telemetryContext?.nodeId,
            workerType: toWorkerType(config.telemetryContext?.workerType),
            tool: call.name,
            toolArgs: parseToolArguments(call.arguments),
            toolOutput: execution.result.ok ? execution.result.result : { error: execution.result.error },
            ok: execution.result.ok,
            durationMs: execution.durationMs,
          })
          activity(execution.result.ok ? `Tool ${call.name} finished` : `Tool ${call.name} failed`)
          let resultEvidenceIds: string[] = []
          if (execution.result.ok && config.recordEvidence) {
            const payload = execution.result.result as
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
            content: execution.result.ok
              ? `${JSON.stringify(execution.result.result)}${evidenceHandleContext(resultEvidenceIds)}`
              : `Tool error: ${execution.result.error ?? 'unknown'}`,
            toolCallId: call.id,
            name: call.name,
          })
        }
        config.onLoopCheckpoint?.({
          messages: messages.map((m) => ({ ...m, toolCalls: m.role === 'assistant' ? m.toolCalls?.map((c) => ({ ...c })) : undefined })),
          toolCallsUsed,
          modelCallsUsed,
          evidenceIds: [...evidenceIds],
        })
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
    const budgetController = config.budgetController ?? new TaskBudgetController(
      {
        maxModelCalls: defaultModelCalls,
        maxToolCalls: config.maxToolCalls ?? 12,
        maxInputTokens: (config.maxInputTokens ?? 32_000) * defaultModelCalls,
        maxOutputTokens: (config.maxOutputTokens ?? 4_000) * defaultModelCalls,
        maxParallelWorkers: 1,
        maxReplans: 0,
      },
      config.pricing,
    )
    const result = await runToolLoop(provider, executor, {
      ...config,
      budgetController,
      onUsageUpdated: (usage) => emit.usageUpdated(usage),
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
