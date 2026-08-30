import { parentPort, workerData } from 'node:worker_threads'
import { AgentRuntime } from '../agent/runtime/AgentRuntime'
import { orchestratorRunner } from '../agent/runtime/OrchestratorRunner'
import { Planner } from '../agent/planner/Planner'
import { SessionStore } from '../agent/session'
import { ContextualModelProvider } from '../agent/context/ContextualModelProvider'
import { OpenAICompatibleProvider } from '../agent/model/OpenAICompatibleProvider'
import {
  runToolLoop,
  toolLoopTaskRunner,
  type ToolExecutor,
  type ToolLoopConfig,
  type BudgetTier,
} from '../agent/model/toolLoopTaskRunner'
import { singleLoopRunner } from '../agent/runtime/singleLoopRunner'
import { EvidenceLedger } from '../agent/knowledge/EvidenceLedger'
import { FindingStore } from '../agent/knowledge/FindingStore'
import { ProjectFactBase } from '../agent/knowledge/ProjectFactBase'
import { KnowledgeCommitService } from '../agent/knowledge/KnowledgeCommitService'
import { toolResultEnvelopeSchema } from '../agent/contracts/RepositoryTool'
import { AnalysisWorker } from '../agent/workers/AnalysisWorker'
import { RepositoryExplorerWorker } from '../agent/workers/RepositoryExplorerWorker'
import { DocumentWorker } from '../agent/workers/DocumentWorker'
import { ValidationWorker } from '../agent/workers/ValidationWorker'
import { Scheduler } from '../agent/workers/Scheduler'
import { StateRecorder } from '../agent/state/StateRecorder'
import type { PersistedAgentState } from '../agent/state/PersistedState'
import type { DocumentGateway, CheckpointResult, CreatedDocType } from '../agent/workers/DocumentGateway'
import type { DocumentIR } from '../documents/DocumentIR'
import type { ModelProvider } from '../agent/model/ModelProvider'
import type { ModelToolDefinition } from '../agent/model/ModelTypes'
import type { TaskNode } from '../agent/contracts/TaskGraph'
import type { FinalSynthesisInput, FinalSynthesisContext, NodeRunContext } from '../agent/runtime/OrchestratorRunner'
import {
  parseHostToWorkerMessage,
  type WorkerToHostMessage,
} from '../agent/runtime/workerProtocol'
import { resolveFeatureFlags, type AgentFeatureFlags } from '../agent/rollout/FeatureFlags'
import { ComplexityRouter } from '../agent/planner/ComplexityRouter'
import type { OperationalDiagnostic } from '../agent/observability/OperationalLogger'
import type { TaskTelemetryEvent } from '../agent/observability/TaskControls'
import type { ModelPricing } from '../agent/observability/TaskControls'

/**
 * Agent runtime entrypoint — runs in an isolated worker thread (out/agent-worker.cjs).
 * Owns session state, task lifecycle, orchestration, and the bounded tool loop.
 * Kept vscode-free; repository tools execute host-side through typed RPC.
 *
 * The API key arrives via workerData and lives only in worker memory +
 * SecretStorage — it is never sent to the webview.
 */
interface WorkerInit {
  workspaceId?: string
  provider?: string
  model?: string
  baseUrl?: string
  apiKey?: string
  /** Model-facing tool definitions, mirrored from the host gateway. */
  tools?: ModelToolDefinition[]
  /** Plan §14: durable state from the previous session (null on first run). */
  initialState?: PersistedAgentState | null
  /** Repo fingerprint at startup — resume is refused when it changes. */
  repoFingerprint?: string
  /** Workspace-level instructions loaded by the host (for example AGENTS.md). */
  projectInstructions?: string[]
  /** Host-resolved capability snapshot for this worker lifetime. */
  featureFlags?: AgentFeatureFlags
  /** Per-model pricing resolved host-side from models.dev catalog. */
  pricing?: ModelPricing
}

const TOOL_CALL_TIMEOUT_MS = 60_000
const PERSIST_TIMEOUT_MS = 15_000

const init = (workerData ?? {}) as WorkerInit
const workspaceId = init.workspaceId ?? 'local'
const featureFlags = resolveFeatureFlags('full', init.featureFlags)

/** Worker internals may emit only this allow-listed metadata to the host. */
function emitDiagnostic(diagnostic: OperationalDiagnostic): void {
  parentPort?.postMessage({ type: 'diagnostic', diagnostic } satisfies WorkerToHostMessage)
}

function telemetryDiagnostic(event: TaskTelemetryEvent): void {
  const level = event.kind === 'budget' || event.ok === false ? 'warn' : 'debug'
  emitDiagnostic({
    event: `${event.kind}.completed`, level, taskId: event.taskId, nodeId: event.nodeId,
    workerType: toWorkerType(event.workerType), tool: event.tool, model: event.model,
    durationMs: event.durationMs, inputTokens: event.inputTokens, outputTokens: event.outputTokens,
    concurrency: event.concurrency, ok: event.ok,
    documentEvent: event.documentEvent, documentOperation: event.documentOperation,
    sectionIndex: event.sectionIndex, attempt: event.attempt, parseOutcome: event.parseOutcome,
    responseBytes: event.responseBytes, jsonExtracted: event.jsonExtracted, blockCount: event.blockCount,
    schemaIssueCount: event.schemaIssueCount, schemaIssueCodes: event.schemaIssueCodes,
    fallbackReason: event.fallbackReason, checkpointPending: event.checkpointPending,
    errorKind: event.kind === 'budget' ? 'configuration' : event.ok === false ? 'provider' : undefined,
  })
}

function toWorkerType(value: string | undefined): OperationalDiagnostic['workerType'] {
  return value === 'repository' || value === 'analysis' || value === 'document' || value === 'validation'
    ? value
    : undefined
}

/** Budget tier inferred from the configured model id (plan §16 model tiering). */
function resolveBudgetTier(model: string): BudgetTier {
  if (/flash|mini|small|haiku|turbo/i.test(model)) return 'fast'
  if (/pro|opus|sonnet|reason|preview/i.test(model)) return 'reasoner'
  return 'standard'
}

function createProvider(): ModelProvider {
  return new OpenAICompatibleProvider({
    baseUrl: init.baseUrl?.trim() || 'https://api.deepseek.com/v1',
    apiKey: init.apiKey ?? '',
  })
}

/** Executes repository tools by asking the host over parentPort. */
function createHostToolExecutor(): ToolExecutor {
  const pending = new Map<
    string,
    { resolve: (v: { ok: boolean; result?: unknown; error?: string }) => void }
  >()
  let nextId = 0

  parentPort?.on('message', (raw: unknown) => {
    const msg = parseHostToWorkerMessage(raw)
    if (!msg) return
    if (msg.type === 'toolResult') {
      const entry = pending.get(msg.callId)
      if (entry) {
        pending.delete(msg.callId)
        entry.resolve({ ok: msg.ok, result: msg.result, error: msg.error })
      }
    }
  })

  return {
    execute: (name, input, signal) =>
      new Promise((resolve) => {
        const callId = `tool-${++nextId}`
        const timer = setTimeout(() => {
          if (pending.delete(callId)) resolve({ ok: false, error: 'Tool call timed out.' })
        }, TOOL_CALL_TIMEOUT_MS)
        // Plan §7: task cancellation reaches in-flight host-side tool
        // execution — the host aborts the call and replies with the error.
        const onAbort = () => parentPort?.postMessage({ type: 'toolCancel', callId } satisfies WorkerToHostMessage)
        if (signal) {
          if (signal.aborted) {
            resolve({ ok: false, error: 'Tool call cancelled.' })
            return
          }
          signal.addEventListener('abort', onAbort, { once: true })
        }
        pending.set(callId, {
          resolve: (v) => {
            clearTimeout(timer)
            signal?.removeEventListener('abort', onAbort)
            // Plan §5: runtime validation at the tool boundary — a result that
            // violates the ToolResult envelope is a tool failure, not data.
            if (v.ok && v.result !== undefined) {
              const parsed = toolResultEnvelopeSchema.safeParse(v.result)
              if (!parsed.success) {
                resolve({ ok: false, error: `Invalid tool result envelope: ${parsed.error.message}` })
                return
              }
            }
            resolve(v)
          },
        })
        parentPort?.postMessage({ type: 'toolCall', callId, name, input } satisfies WorkerToHostMessage)
      }),
  }
}

/**
 * Durable checkpoints wait for the extension host's atomic-write acknowledgement.
 * Ordinary recorder flushes use the same channel but intentionally do not await it.
 */
function createStatePersistenceSink(): (state: PersistedAgentState) => Promise<void> {
  const pending = new Map<string, { resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  let nextId = 0

  parentPort?.on('message', (raw: unknown) => {
    const msg = parseHostToWorkerMessage(raw)
    if (!msg) return
    if (msg.type !== 'statePersistAck') return
    const request = pending.get(msg.persistenceId)
    if (!request) return
    pending.delete(msg.persistenceId)
    clearTimeout(request.timer)
    if (msg.ok) request.resolve()
    else request.reject(new Error(msg.error ?? 'State persistence failed.'))
  })

  return (state) =>
    new Promise<void>((resolve, reject) => {
      const persistenceId = `state-${++nextId}`
      const timer = setTimeout(() => {
        if (!pending.delete(persistenceId)) return
        reject(new Error('State persistence acknowledgement timed out.'))
      }, PERSIST_TIMEOUT_MS)
      pending.set(persistenceId, { resolve, reject, timer })
      parentPort?.postMessage({ type: 'statePersist', persistenceId, state } satisfies WorkerToHostMessage)
    })
}

/** Document operations execute host-side (DocumentService) over parentPort. */
function createDocumentGateway(): DocumentGateway {
  const pending = new Map<
    string,
    { resolve: (v: { ok: boolean; result?: unknown; error?: string }) => void }
  >()
  let nextId = 0

  parentPort?.on('message', (raw: unknown) => {
    const msg = parseHostToWorkerMessage(raw)
    if (!msg) return
    if (msg.type === 'documentResult') {
      const entry = pending.get(msg.callId)
      if (entry) {
        pending.delete(msg.callId)
        entry.resolve({ ok: msg.ok, result: msg.result, error: msg.error })
      }
    }
  })

  const call = (op: 'createDocument' | 'checkpointDocument' | 'loadDocumentIR', payload: unknown) =>
    new Promise<{ ok: boolean; result?: unknown; error?: string }>((resolve) => {
      const callId = `doc-${++nextId}`
      const timer = setTimeout(() => {
        if (pending.delete(callId)) resolve({ ok: false, error: 'Document call timed out.' })
      }, TOOL_CALL_TIMEOUT_MS)
      pending.set(callId, {
        resolve: (v) => {
          clearTimeout(timer)
          resolve(v)
        },
      })
      parentPort?.postMessage({ type: 'documentCall', callId, op, payload } satisfies WorkerToHostMessage)
    })

  return {
    create: async (name, icon) => {
      const r = await call('createDocument', { name, icon })
      if (!r.ok) throw new Error(r.error ?? 'Document creation failed.')
      return r.result as CreatedDocType
    },
    checkpoint: async (documentId, baseRevision, ir: DocumentIR) => {
      const r = await call('checkpointDocument', { documentId, baseRevision, ir })
      if (!r.ok) throw new Error(r.error ?? 'Document checkpoint failed.')
      return r.result as CheckpointResult
    },
    loadIR: async (documentId) => {
      const r = await call('loadDocumentIR', { documentId })
      if (!r.ok) throw new Error(r.error ?? 'Document IR load failed.')
      return r.result as { ir: DocumentIR; revision: number } | null
    },
  }
}

const tools: ModelToolDefinition[] = Array.isArray(init.tools) ? init.tools : []
const sessions = new SessionStore()

// Phase 7 knowledge layer: tool observations become durable evidence; workers
// later commit findings through FindingStore/ProjectFactBase. In-memory only —
// restart durability arrives with Phase 14.
const evidence = new EvidenceLedger()
export const knowledge = {
  evidence,
  findings: new FindingStore(),
  facts: new ProjectFactBase(),
}
const knowledgeCommitter = new KnowledgeCommitService(knowledge.findings, knowledge.facts)

// One provider/executor/loop shared by the fast path and graph node execution.
const provider = createProvider()
// Every model invocation crosses this boundary: simple chat, planning and all
// graph workers receive the same durable, bounded session/fact/evidence context.
const contextualProvider = new ContextualModelProvider(provider, {
  session: () => sessions.snapshot(),
  findings: () => knowledge.findings.all(),
  facts: () => knowledge.facts.all(),
  evidence: () => knowledge.evidence.all(),
  projectInstructions: () => init.projectInstructions ?? [],
})
const executor = createHostToolExecutor()
const loopConfig: ToolLoopConfig = {
  model: init.model ?? '',
  tools,
  thinking: 'disabled',
  // Workers (analysis/repository/validation) batch independent read-only tool
  // calls within a pass when enabled — cuts serial read latency.
  parallelToolCalls: featureFlags.parallelToolCalls ? 4 : 0,
  pricing: init.pricing,
  recordEvidence: (candidates, repositoryVersion) => {
    return candidates.map((c) => evidence.record(c, repositoryVersion).id)
  },
  telemetry: telemetryDiagnostic,
  // Full-detail debug trace (LLM approach + tool args/output), separate from
  // the content-free telemetry path above.
  diagnostic: emitDiagnostic,
}

/**
 * The only complex-task prose path. Graph workers may execute concurrently,
 * but their model streams are never exposed to the chat; this final, bounded
 * pass turns their structured outputs into one evidence-aware response.
 */
async function synthesizeFinalAnswer(input: FinalSynthesisInput, ctx: FinalSynthesisContext): Promise<void> {
  const work = input.nodes.map((node) => ({
    title: node.title,
    status: node.status,
    outputs: node.outputs.slice(0, 4),
  }))
  const result = await runToolLoop(
    contextualProvider,
    { execute: async () => ({ ok: false, error: 'Final synthesis does not use tools.' }) },
    {
      model: loopConfig.model,
      tools: [],
      maxIterations: 1,
      maxModelCalls: 1,
      maxToolCalls: 0,
      maxOutputTokens: 1_500,
      diagnostic: emitDiagnostic,
      system:
        'You are Charter Ai. Produce the final user-facing answer from completed structured analysis. ' +
        'Do not reveal worker reasoning, planning traces, or invented repository facts. ' +
        'Clearly distinguish completed work, caveats, failed analysis parts, and validation results. ' +
        'Be concise and use evidence identifiers only when they are present in the supplied results.',
    },
    {
      text: `User objective:\n${input.objective}\n\nCompleted task results:\n${JSON.stringify(work)}\n\nValidation:\n${input.validationSummary ?? 'No validation report was produced.'}`,
      signal: ctx.signal,
      activity: ctx.activity,
      assistantStarted: ctx.assistantStarted,
      delta: ctx.delta,
      context: {
        task: { title: 'Final synthesis', objective: input.objective, status: 'synthesizing' },
        instructions: ['Write one coherent final response for the user.'],
      },
    },
  )
  if (result.text.trim()) {
    ctx.assistantCompleted()
    return
  }
  // A provider may legally finish without text. Keep the task's user-facing
  // completion contract intact without exposing any internal worker output.
  ctx.assistantStarted()
  ctx.delta('Analysis completed. The task plan contains the completed work and any recorded caveats.')
  ctx.assistantCompleted()
}

// Phase 9: generic dynamic worker runtime — roles come from WorkerSpecs, not
// hard-coded agent classes. Nodes run under a per-type semaphore.
const analysisWorker = new AnalysisWorker({
  provider: contextualProvider,
  executor,
  baseConfig: loopConfig,
  knowledge: knowledgeCommitter,
  evidence,
})
const explorerWorker = new RepositoryExplorerWorker({
  provider: contextualProvider,
  executor,
  baseConfig: loopConfig,
  knowledge: knowledgeCommitter,
  evidence,
})
// Plan §14 durable state: mirror runtime events + the live graph + the shared
// knowledge layer into a persistable snapshot; the host stores it atomically
// (temp file + rename).
const recorder = new StateRecorder(init.initialState ?? null, createStatePersistenceSink())
sessions.restore(recorder.restoredSession())
// Resume gating: read the PERSISTED identity before refreshing it below.
const persistedContext = recorder.context()
const sameWorkspace = persistedContext.workspaceId === workspaceId
const currentFingerprint = init.repoFingerprint ?? ''
const fingerprintChanged =
  sameWorkspace && Boolean(persistedContext.repoFingerprint) && persistedContext.repoFingerprint !== currentFingerprint
// Refresh workspace identity (wipes tasks when the workspace itself changed).
recorder.setWorkspace(workspaceId, currentFingerprint)

// Phase 12: document workers consume the shared fact base and checkpoint
// sections through the host DocumentService (revision-safe).
const documentWorker = new DocumentWorker({
  provider: contextualProvider,
  baseConfig: { ...loopConfig, thinking: 'enabled' },
  findings: knowledge.findings,
  facts: knowledge.facts,
  gateway: createDocumentGateway(),
  // Plan §14: every checkpointed IR survives a restart (regeneration base).
  onCheckpoint: (documentId, ir) => recorder.onDocumentCheckpoint(documentId, ir),
})
// Phase 13: validation workers check generated documents against evidence
// (deterministic + model-based) and compare the document set for consistency.
const validationWorker = new ValidationWorker({
  provider: contextualProvider,
  executor,
  baseConfig: { ...loopConfig, thinking: 'enabled' },
  findings: knowledge.findings,
  facts: knowledge.facts,
  evidence,
})
// A stage below multi-document rollout serializes document execution. This
// preserves deterministic single-document behavior while keeping the same
// generic worker runtime.
const scheduler = new Scheduler({ limits: { document: featureFlags.parallelDocuments ? 2 : 1 } })
const planner = new Planner({ modelProvider: contextualProvider, model: init.model ?? '' })

// Shared node executor: dispatches a graph node to the matching typed worker.
const runNode = async (node: TaskNode, ctx: NodeRunContext) => {
  if (node.roleSpec.workerType === 'repository') {
    const result = await explorerWorker.run(node, ctx)
    return { outputs: result.outputs }
  }
  if (node.roleSpec.workerType === 'document') {
    const result = await documentWorker.run(node, ctx)
    return { outputs: result.outputs }
  }
  if (node.roleSpec.workerType === 'validation') {
    const result = await validationWorker.run(node, ctx)
    return { outputs: result.outputs, followups: result.followups }
  }
  const result = await analysisWorker.run(node, ctx)
  return { outputs: result.outputs, followups: result.recommendedFollowups }
}

// Plan §14: graph changes and the shared knowledge layer are mirrored into
// durable state so a resumed task never repeats completed work.
const onGraphChange = (nodes: TaskNode[]) => {
  recorder.onGraphChange(nodes)
  recorder.onKnowledgeSnapshot({
    findings: knowledge.findings.all(),
    facts: knowledge.facts.all(),
    evidence: knowledge.evidence.all(),
  })
}

// A dependent DAG node cannot start until the previous node's graph and
// outputs have reached the host's atomic state store.
const onNodeDurable = () => recorder.flushAsync()

const runtime = new AgentRuntime(
  featureFlags.singleLoop
    ? singleLoopRunner({
      provider: contextualProvider,
      executor,
      config: {
        ...loopConfig,
        // Hidden chain-of-thought: routing and tool planning are exactly the
        // "complex decision making" CoT helps. The loop routes reasoning
        // deltas to the provider's private reasoning channel — never chat.
        thinking: 'enabled',
        parallelToolCalls: featureFlags.parallelToolCalls ? 4 : 0,
      },
      budgetTier: resolveBudgetTier(init.model ?? ''),
      includeDocumentTool: featureFlags.documentGeneration,
      planner,
      scheduler,
      runNode,
      onGraphChange,
      onNodeDurable,
      onLoopCheckpoint: (taskId, state) => recorder.onLoopCheckpoint(taskId, state),
    })
    : orchestratorRunner({
      // Fast path for simple questions (plan §8).
      simpleRunner: toolLoopTaskRunner(contextualProvider, executor, loopConfig),
      // Disabling the task graph removes dynamic workers altogether rather than
      // allowing an unseen graph to execute behind a flag.
      router: featureFlags.taskGraph && featureFlags.subagents
        ? undefined
        : new ComplexityRouter({ classify: () => 'simple' }),
      scheduler,
      planner,
      conversationContext: () =>
        (sessions.snapshot()?.turns ?? [])
          .slice(-6)
          .map((turn) => `${turn.role.toUpperCase()}: ${turn.content}`),
      // Analysis + per-document validation + cross-document consistency +
      // regeneration follow-ups all fit within one durable graph.
      maxNodes: 40,
      // Plan §14: graph changes and the shared knowledge layer are mirrored
      // into durable state so a resumed task never repeats completed work.
      onGraphChange,
      // A dependent DAG node cannot start until the previous node's graph and
      // outputs have reached the host's atomic state store.
      onNodeDurable,
      synthesize: synthesizeFinalAnswer,
      pricing: init.pricing,
      runNode,
    }),
)

const taskResponses = new Map<string, string>()
const taskTitles = new Map<string, string>()

runtime.onEvent((event) => {
  recorder.onEvent(event)
  if (event.type === 'agentTaskStarted') taskTitles.set(event.taskId, event.title)
  if (event.type === 'agentAssistantDelta') {
    taskResponses.set(event.taskId, `${taskResponses.get(event.taskId) ?? ''}${event.text}`)
  }
  if (event.type === 'agentTaskCompleted' || event.type === 'agentTaskFailed' || event.type === 'agentTaskCancelled') {
    const response = taskResponses.get(event.taskId) ||
      (event.type === 'agentTaskCompleted' ? event.summary : undefined) ||
      `Task ${event.type === 'agentTaskCompleted' ? 'completed' : 'ended'}: ${taskTitles.get(event.taskId) ?? 'Untitled request'}`
    sessions.recordAssistantTurn({
      taskId: event.taskId,
      content: response,
      decisions: event.type === 'agentTaskCompleted' ? [`Completed: ${taskTitles.get(event.taskId) ?? 'task'}`] : [],
      evidenceIds: knowledge.evidence.all().slice(-20).map((record) => record.id),
      factIds: knowledge.facts.all().slice(-30).map((fact) => fact.id),
    })
    taskResponses.delete(event.taskId)
    taskTitles.delete(event.taskId)
  }
  recorder.onSessionSnapshot(sessions.snapshot())
  parentPort?.postMessage({ type: 'event', event } satisfies WorkerToHostMessage)
})

parentPort?.on('message', (raw: unknown) => {
  const msg = parseHostToWorkerMessage(raw)
  if (!msg) return
  switch (msg.type) {
    case 'start':
      sessions.getOrCreate(workspaceId)
      // Record before runtime.start(): the simple fast path may begin its
      // first provider pass synchronously, so the current objective must be
      // available even to that call.
      if (!runtime.taskIdForRequest(msg.requestId)) sessions.recordUserTurn(msg.requestId, msg.text)
      {
        const start = runtime.start({ requestId: msg.requestId, text: msg.text, surface: msg.surface })
        if (start.started) sessions.assignTaskId(msg.requestId, start.taskId)
        recorder.setRequestIdentityForTask(start.taskId, msg.requestId, msg.text, msg.surface)
        recorder.onSessionSnapshot(sessions.snapshot())
      }
      break
    case 'cancel':
      runtime.cancel(msg.taskId)
      break
    case 'resume':
      runtime.resume(msg.taskId, recorder.resumePayload(msg.taskId))
      break
    case 'snapshot':
      runtime.sendSnapshot()
      break
    case 'resetSession': {
      const next = sessions.reset(workspaceId)
      recorder.resetConversation(workspaceId, next)
      break
    }
    case 'forgetDocument':
      recorder.dropDocumentIR(msg.documentId)
      recorder.flush()
      break
    case 'toolResult':
      break // handled by createHostToolExecutor's listener
  }
})

// Plan §14 restart recovery: rehydrate the previous session's tasks and the
// shared knowledge layer, then resume interrupted complex tasks from their
// first incomplete node (completed nodes are never repeated). Resume is
// refused when the repository fingerprint changed since the task started —
// the task fails with a clear explanation instead of resuming unsafely.
if (sameWorkspace) {
  const restoredKnowledge = recorder.restoredKnowledge()
  knowledge.evidence.restore(restoredKnowledge.evidence)
  knowledge.findings.restore(restoredKnowledge.findings)
  knowledge.facts.restore(restoredKnowledge.facts)
  for (const record of recorder.restoredTasks()) {
    runtime.restoreTask(record)
    if (record.interrupted && fingerprintChanged && record.graph && record.graph.length > 0) {
      runtime.failInterrupted(
        record.taskId,
        'Repository changed while the task was interrupted — resume refused. Please ask again.',
      )
    }
  }
  // Simple tasks (no graph) resume by re-running their original question.
  // Single-loop tasks resume from their last durable loop checkpoint; when the
  // repository changed mid-task, that checkpoint's evidence is stale, so the
  // loop re-runs from scratch instead of trusting it.
  for (const taskId of runtime.interruptedTasks()) {
    const payload = recorder.resumePayload(taskId)
    const safe = fingerprintChanged ? { graph: payload.graph, outputs: payload.outputs } : payload
    runtime.resume(taskId, safe)
  }
}
recorder.flush()
