import { Worker } from 'node:worker_threads'
import type { AgentEvent, AgentSurfaceContext } from '../../shared/agentProtocol'
import {
  parseHostToWorkerMessage,
  parseWorkerToHostMessage,
  type HostToWorkerMessage,
  type WorkerToHostMessage,
} from './runtime/workerProtocol'
import type { PersistedAgentState } from './state/PersistedState'
import { parseAgentEvent } from './contracts/AgentEvent'
import { toolResultEnvelopeSchema, type ToolResult } from './contracts/RepositoryTool'
import type { OperationalDiagnostic } from './observability/OperationalLogger'

/** Minimal surface of a worker_threads Worker (injectable for tests). */
export interface WorkerPort {
  postMessage(value: unknown): void
  on(event: 'message' | 'error' | 'exit', listener: (value: unknown) => void): void
  terminate?(): void | Promise<number>
}

export type WorkerFactory = (scriptPath: string, workerData: unknown) => WorkerPort

const defaultFactory: WorkerFactory = (scriptPath, workerData) =>
  new Worker(scriptPath, { workerData }) as unknown as WorkerPort

/**
 * Executes repository tool calls requested by the worker (host-side gateway).
 * The per-call `signal` aborts in-flight execution when the task is cancelled
 * (plan §7: cancellation reaches in-flight model requests AND worker tasks).
 */
export interface ToolCallHandler {
  (
    call: { callId: string; name: string; input: unknown },
    signal: AbortSignal,
  ): Promise<{
    ok: boolean
    result?: unknown
    error?: string
  }>
}

/** Executes document operations requested by the worker (host-side DocumentService). */
export interface DocumentCallHandler {
  (call: { op: 'createDocument' | 'checkpointDocument' | 'loadDocumentIR'; payload: unknown }): Promise<{
    ok: boolean
    result?: unknown
    error?: string
  }>
}

export interface AgentRuntimeClientOptions {
  toolHandler?: ToolCallHandler
  documentHandler?: DocumentCallHandler
  /** Persists worker-reported durable state (plan §14, atomic host-side). */
  statePersistHandler?: (state: PersistedAgentState) => Promise<void>
  /** Safe, content-free operational diagnostics (Phase 16). */
  diagnostic?: (event: OperationalDiagnostic) => void
}

/**
 * Extension-host side of the agent runtime. Talks to the isolated worker over
 * typed RPC; the host only brokers VS Code APIs, repository tools, and webview
 * messages.
 *
 * A worker crash is translated into a structured `agentTaskFailed` event for
 * every running task (with a valid `seq`), never an extension-host crash.
 */
export class AgentRuntimeClient {
  private readonly worker: WorkerPort
  private readonly listeners = new Set<(e: AgentEvent) => void>()
  /** Running tasks: taskId → highest seq seen (for a valid synthetic failure). */
  private readonly running = new Map<string, number>()
  /** In-flight host-side tool executions: callId → abort controller (plan §7). */
  private readonly toolAborters = new Map<string, AbortController>()
  /** Start sent before the worker has acknowledged the task id. */
  private pendingStart: { requestId: string; title: string } | undefined
  private disposed = false

  constructor(
    workerScriptPath: string,
    workerData: unknown,
    createWorker: WorkerFactory = defaultFactory,
    private readonly options: AgentRuntimeClientOptions = {},
  ) {
    this.worker = createWorker(workerScriptPath, workerData)
    this.worker.on('message', (value) => this.onRawMessage(value))
    this.worker.on('error', (value) => this.onFailure(value))
    this.worker.on('exit', (code) => {
      if (!this.disposed && code !== 0) {
        this.onFailure(new Error(`agent worker exited with code ${code}`))
      }
    })
  }

  onEvent(listener: (e: AgentEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  start(requestId: string, text: string, surface: AgentSurfaceContext): void {
    this.options.diagnostic?.({ event: 'task.received', level: 'info' })
    this.pendingStart = { requestId, title: text.slice(0, 120) || 'Charter Ai task' }
    this.post({ type: 'start', requestId, text, surface })
  }

  cancel(taskId: string): void {
    this.options.diagnostic?.({ event: 'task.cancel_requested', level: 'info', taskId })
    this.post({ type: 'cancel', taskId })
  }

  resume(taskId: string): void {
    this.options.diagnostic?.({ event: 'task.resume_requested', level: 'info', taskId })
    this.post({ type: 'resume', taskId })
  }

  sendSnapshot(): void {
    this.post({ type: 'snapshot' })
  }

  dispose(): void {
    this.disposed = true
    this.worker.terminate?.()
  }

  private post(msg: HostToWorkerMessage): void {
    // Keep the extension host honest too: a future call site cannot send an
    // invalid command merely because TypeScript was bypassed at runtime.
    const parsed = parseHostToWorkerMessage(msg)
    if (!parsed) throw new Error(`Invalid host-to-worker message: ${msg.type}`)
    this.worker.postMessage(parsed)
  }

  private onRawMessage(value: unknown): void {
    const msg = parseWorkerToHostMessage(value)
    if (!msg) {
      this.options.diagnostic?.({ event: 'worker.message_rejected' })
      return
    }
    this.onMessage(msg)
  }

  private onMessage(msg: WorkerToHostMessage): void {
    if (msg.type === 'toolCall') {
      void this.handleToolCall(msg)
      return
    }
    if (msg.type === 'toolCancel') {
      // Plan §7: cancellation reaches in-flight host-side tool execution.
      this.toolAborters.get(msg.callId)?.abort()
      return
    }
    if (msg.type === 'documentCall') {
      void this.handleDocumentCall(msg)
      return
    }
    if (msg.type === 'statePersist') {
      void this.handleStatePersist(msg)
      return
    }
    if (msg.type === 'diagnostic') {
      this.options.diagnostic?.(msg.diagnostic)
      return
    }
    if (msg.type !== 'event') return
    // This is redundant with the envelope parser, but keeps event validation
    // local to the event-forwarding boundary if the schema changes later.
    const event = parseAgentEvent(msg.event)
    if (!event) return
    this.track(event)
    this.logAgentEvent(event)
    this.emit(event)
  }

  private async handleStatePersist(msg: Extract<WorkerToHostMessage, { type: 'statePersist' }>): Promise<void> {
    const startedAt = Date.now()
    let reply: { ok: boolean; error?: string }
    try {
      await this.options.statePersistHandler?.(msg.state)
      reply = { ok: true }
    } catch (err) {
      reply = { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    this.options.diagnostic?.({ event: reply.ok ? 'state.persist_completed' : 'state.persist_failed', level: reply.ok ? 'debug' : 'warn', durationMs: Date.now() - startedAt, ok: reply.ok, errorKind: reply.ok ? undefined : 'worker' })
    this.post({ type: 'statePersistAck', persistenceId: msg.persistenceId, ...reply })
  }

  private async handleDocumentCall(
    msg: Extract<WorkerToHostMessage, { type: 'documentCall' }>,
  ): Promise<void> {
    const startedAt = Date.now()
    let reply: { ok: boolean; result?: unknown; error?: string }
    try {
      reply = this.options.documentHandler
        ? await this.options.documentHandler({ op: msg.op, payload: msg.payload })
        : { ok: false, error: 'Document service unavailable.' }
    } catch (err) {
      reply = { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    this.options.diagnostic?.({
      event: reply.ok ? 'document.operation_completed' : 'document.operation_failed',
      level: reply.ok ? 'info' : 'warn',
      documentOperation: msg.op,
      durationMs: Date.now() - startedAt,
      ok: reply.ok,
      errorKind: reply.ok ? undefined : 'document',
    })
    this.post({ type: 'documentResult', callId: msg.callId, ...reply })
  }

  private async handleToolCall(msg: Extract<WorkerToHostMessage, { type: 'toolCall' }>): Promise<void> {
    // Per-call abort controller: a worker `toolCancel` (driven by the task's
    // AbortController) interrupts this execution.
    const controller = new AbortController()
    const startedAt = Date.now()
    this.toolAborters.set(msg.callId, controller)
    let reply: { ok: boolean; result?: unknown; error?: string }
    try {
      reply = this.options.toolHandler
        ? await this.options.toolHandler(msg, controller.signal)
        : { ok: false, error: 'No repository tools available.' }
    } catch (err) {
      reply = { ok: false, error: err instanceof Error ? err.message : String(err) }
    } finally {
      this.toolAborters.delete(msg.callId)
    }
    // Validate host-produced tool data before it reaches the isolated worker.
    // A handler bug must become a normal tool failure, never untrusted input.
    if (reply.ok && reply.result !== undefined) {
      const parsed = toolResultEnvelopeSchema.safeParse(reply.result)
      if (!parsed.success) {
        reply = { ok: false, error: `Invalid host tool result: ${parsed.error.message}` }
      } else {
        reply = { ...reply, result: parsed.data }
      }
    }
    this.post({
      type: 'toolResult',
      callId: msg.callId,
      ok: reply.ok,
      result: reply.result as ToolResult<unknown> | undefined,
      error: reply.error,
    })
    this.options.diagnostic?.({ event: 'tool.completed', level: reply.ok ? 'info' : 'warn', tool: msg.name, durationMs: Date.now() - startedAt, ok: reply.ok, errorKind: reply.ok ? undefined : 'tool' })
  }

  private track(e: AgentEvent): void {
    switch (e.type) {
      case 'agentTaskStarted':
        this.pendingStart = undefined
        this.running.set(e.taskId, e.seq)
        break
      case 'agentTaskCompleted':
      case 'agentTaskFailed':
      case 'agentTaskCancelled':
        this.running.delete(e.taskId)
        break
      default:
        if (this.running.has(e.taskId)) {
          this.running.set(e.taskId, Math.max(this.running.get(e.taskId)!, e.seq))
        }
    }
  }

  private onFailure(err: unknown): void {
    this.options.diagnostic?.({ event: 'runtime.worker_failed', level: 'error', errorKind: 'worker', count: this.running.size, ok: false })
    const message = err instanceof Error ? err.message : String(err)
    // A worker can fail during bootstrap, before emitting agentTaskStarted.
    // Synthesize the normal lifecycle so the user never sees a silent send.
    if (this.pendingStart) {
      const pending = this.pendingStart
      this.pendingStart = undefined
      const timestamp = Date.now()
      this.emit({
        type: 'agentTaskStarted',
        taskId: pending.requestId,
        seq: 0,
        timestamp,
        title: pending.title,
      })
      this.emit({
        type: 'agentTaskFailed',
        taskId: pending.requestId,
        seq: 1,
        timestamp,
        error: `Agent runtime failed to start: ${message}`,
      })
    }
    for (const [taskId, lastSeq] of this.running) {
      this.emit({
        type: 'agentTaskFailed',
        taskId,
        seq: lastSeq + 1,
        timestamp: Date.now(),
        error: `Agent runtime crashed: ${message}`,
      })
    }
    this.running.clear()
  }

  /** Metadata only: never log activity, deltas, document content, or raw errors. */
  private logAgentEvent(event: AgentEvent): void {
    const terminal = event.type === 'agentTaskCompleted' || event.type === 'agentTaskFailed' || event.type === 'agentTaskCancelled'
    this.options.diagnostic?.({
      event: terminal ? `task.${event.type.slice('agentTask'.length).toLowerCase()}` : `agent.${event.type.slice('agent'.length).toLowerCase()}`,
      level: event.type === 'agentTaskFailed' ? 'error' : terminal ? 'info' : 'debug',
      taskId: event.taskId,
      errorKind: event.type === 'agentTaskFailed' ? classifyFailure(event.error) : undefined,
      ok: event.type === 'agentTaskFailed' ? false : undefined,
    })
  }

  private emit(e: AgentEvent): void {
    for (const l of this.listeners) l(e)
  }
}

function classifyFailure(error: string): NonNullable<OperationalDiagnostic['errorKind']> {
  if (/cancel/i.test(error)) return 'cancelled'
  if (/rate limit|429/i.test(error)) return 'rate_limited'
  if (/timed? out|timeout/i.test(error)) return 'timeout'
  if (/budget|configuration|not configured|unavailable/i.test(error)) return 'configuration'
  if (/document|checkpoint|revision|draft/i.test(error)) return 'document'
  if (/schema|validation|invalid (?:json|content|output)/i.test(error)) return 'validation'
  if (/worker|runtime|thread|crash/i.test(error)) return 'worker'
  if (/provider|model|api key|authentication/i.test(error)) return 'provider'
  if (/tool|repository|file/i.test(error)) return 'tool'
  return 'unknown'
}
