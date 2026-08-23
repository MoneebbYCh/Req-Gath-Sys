import type {
  AgentEvent,
  AgentSessionSnapshot,
  AgentSurfaceContext,
  DocumentProgressState,
  PlanView,
} from '../../../shared/agentProtocol'
import type { TaskNode } from '../contracts/TaskGraph'

/** Live view of a task — the executor reads it, the runtime updates it. */
export interface AgentTaskHandle {
  taskId: string
  /**
   * Lifecycle (plan §7): `created` (acknowledged, not yet running) →
   * `running` → terminal. `interrupted` (plan §14): a task that was `running`
   * when the extension host restarted — rehydrated from durable state,
   * resumable, never a live zombie.
   */
  status: 'created' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted'
  title: string
  /** Recent high-level activities (bounded, oldest first). */
  activities: string[]
  /** Assistant text streamed so far (partial while running/failed). */
  assistantText: string
  /** Live plan for long tasks (plan §8); mirrored into snapshots. */
  plan?: PlanView
  /** Live per-document progress (plan §12); mirrored into snapshots. */
  documents: DocumentProgressState[]
  summary?: string
  error?: string
  /** Next task-scoped event sequence. Emitters are disposable views. */
  nextSeq: number
  signal: AbortSignal
}

/** Emits task-scoped events with monotonically increasing seq and mirrors state into the handle. */
export class TaskEmitter {
  constructor(
    private readonly handle: AgentTaskHandle,
    private readonly onEvent: (e: AgentEvent) => void,
  ) {}

  private base(): { taskId: string; seq: number; timestamp: number } {
    return { taskId: this.handle.taskId, seq: this.handle.nextSeq++, timestamp: Date.now() }
  }

  /**
   * Once a task is terminal (cancelled/failed/completed), later activity and
   * assistant deltas are dropped — e.g. a provider delta arriving after
   * cancellation must never reach the UI. `created` (plan §7) is the
   * acknowledged-but-not-yet-running state that must still emit taskStarted.
   */
  private live(): boolean {
    return this.handle.status === 'running' || this.handle.status === 'created'
  }

  taskStarted(title: string): void {
    if (!this.live()) return
    this.onEvent({ ...this.base(), type: 'agentTaskStarted', title })
  }

  /**
   * Task lifecycle transition (plan §7: running → paused): emitted when a
   * task enters the paused/interrupted state. Not gated by live() — lifecycle
   * events are authoritative. Never chain-of-thought.
   */
  taskPaused(reason: string): void {
    this.onEvent({ ...this.base(), type: 'agentTaskPaused', reason })
  }

  activity(activity: string): void {
    if (!this.live()) return
    this.handle.activities.push(activity)
    if (this.handle.activities.length > 50) this.handle.activities.shift()
    this.onEvent({ ...this.base(), type: 'agentActivity', activity })
  }

  /** Stream a plan change (plan §8): visible progress, never chain-of-thought. */
  planUpdated(plan: PlanView): void {
    if (!this.live()) return
    this.handle.plan = plan
    this.onEvent({ ...this.base(), type: 'agentPlanUpdated', plan })
  }

  /** A new document entered the task (plan §12). */
  documentDeclared(document: DocumentProgressState): void {
    if (!this.live()) return
    this.upsertDocument(document)
    this.onEvent({ ...this.base(), type: 'agentDocumentDeclared', document })
  }

  /** Section-level progress update for a document (plan §12). */
  documentProgress(document: DocumentProgressState): void {
    if (!this.live()) return
    this.upsertDocument(document)
    this.onEvent({ ...this.base(), type: 'agentDocumentProgress', document })
  }

  /** A complete section checkpointed (or a conflict parked the agent draft). */
  documentCheckpoint(info: {
    documentId: string
    title: string
    sectionTitle?: string
    completedSections: number
    totalSections: number
    conflict?: boolean
    pendingDraftId?: string
  }): void {
    if (!this.live()) return
    const existing = this.handle.documents.find((d) => d.documentId === info.documentId)
    if (existing) {
      existing.completedSections = info.completedSections
      existing.totalSections = info.totalSections
      existing.activeSection = info.sectionTitle
      existing.status = 'generating'
    }
    this.onEvent({ ...this.base(), type: 'agentDocumentCheckpoint', ...info })
  }

  /**
   * Validation layer progress (plan §13): messages + the validated document's
   * status transition (validating → completed/failed). Never chain-of-thought.
   */
  validationProgress(info: {
    phase: 'deterministic' | 'claim' | 'cross-document'
    message: string
    documentId?: string
    finalStatus?: 'completed' | 'failed'
  }): void {
    if (!this.live()) return
    this.handle.activities.push(info.message)
    if (this.handle.activities.length > 50) this.handle.activities.shift()
    if (info.documentId) {
      const existing = this.handle.documents.find((d) => d.documentId === info.documentId)
      if (existing) {
        existing.status = info.finalStatus === 'failed' ? 'failed' : info.finalStatus === 'completed' ? 'completed' : 'validating'
        if (info.finalStatus === 'failed') existing.error = info.message
      }
    }
    this.onEvent({ ...this.base(), type: 'agentValidationProgress', ...info })
  }

  private upsertDocument(document: DocumentProgressState): void {
    const existing = this.handle.documents.find((d) => d.documentId === document.documentId)
    if (existing) Object.assign(existing, document)
    else this.handle.documents.push(document)
  }

  assistantStarted(): void {
    if (!this.live()) return
    this.onEvent({ ...this.base(), type: 'agentAssistantStarted' })
  }

  assistantDelta(text: string): void {
    if (!this.live()) return
    this.handle.assistantText += text
    this.onEvent({ ...this.base(), type: 'agentAssistantDelta', text })
  }

  assistantCompleted(): void {
    if (!this.live()) return
    this.onEvent({ ...this.base(), type: 'agentAssistantCompleted' })
  }

  taskCompleted(summary?: string): void {
    this.handle.status = 'completed'
    this.handle.summary = summary
    this.onEvent({ ...this.base(), type: 'agentTaskCompleted', summary })
  }

  taskFailed(error: string): void {
    this.handle.status = 'failed'
    this.handle.error = error
    this.onEvent({ ...this.base(), type: 'agentTaskFailed', error })
  }

  taskCancelled(): void {
    this.handle.status = 'cancelled'
    this.onEvent({ ...this.base(), type: 'agentTaskCancelled' })
  }

  snapshot(): void {
    this.onEvent({
      ...this.base(),
      type: 'agentSessionSnapshot',
      snapshot: toSnapshot(this.handle),
    })
  }
}

export interface AgentTaskRequest {
  requestId: string
  text: string
  surface: AgentSurfaceContext
}

/** Plan §14 resume: durable graph + dependency outputs for an interrupted task. */
export interface TaskResumePayload {
  graph?: TaskNode[]
  /** Completed-node outputs (dependency inputs) restored from durable state. */
  outputs?: Record<string, string[]>
}

/** Executes the actual task work (ReAct loop, analysis, …). */
export type TaskRunner = (ctx: {
  handle: AgentTaskHandle
  emit: TaskEmitter
  text: string
  surface: AgentSurfaceContext
  /** Present when resuming an interrupted complex task (plan §14). */
  resume?: TaskResumePayload
}) => Promise<void>

export interface StartResult {
  taskId: string
  started: boolean
}

const MAX_TASKS = 20

function toErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function toSnapshot(handle: AgentTaskHandle): AgentSessionSnapshot {
  return {
    taskId: handle.taskId,
    status: handle.status,
    title: handle.title,
    activities: [...handle.activities],
    assistantText: handle.assistantText,
    plan: handle.plan,
    documents: handle.documents.map((d) => ({ ...d })),
    summary: handle.summary,
    error: handle.error,
  }
}

/**
 * In-process agent runtime: one active session per workspace, one foreground
 * task per session. Owns task lifecycle, cancellation, and the monotonic
 * event stream. This public API is the worker-thread boundary for later —
 * a future worker swap changes only how the extension host constructs it.
 */
export class AgentRuntime {
  private readonly listeners = new Set<(e: AgentEvent) => void>()
  private readonly tasks = new Map<string, AgentTaskHandle>()
  private readonly aborters = new Map<string, AbortController>()
  private readonly byRequestId = new Map<string, string>()
  /** Per-task runner inputs — needed to resume after a restart (plan §14). */
  private readonly runs = new Map<string, { text: string; surface: AgentSurfaceContext }>()
  private activeTaskId: string | null = null

  constructor(private readonly run: TaskRunner) {}

  onEvent(listener: (e: AgentEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Exposes request idempotency without leaking mutable task handles. */
  taskIdForRequest(requestId: string): string | undefined {
    return this.byRequestId.get(requestId)
  }

  start(request: AgentTaskRequest): StartResult {
    // Idempotent: a duplicate requestId reuses the existing task without re-running.
    const existing = this.byRequestId.get(request.requestId)
    if (existing) return { taskId: existing, started: false }

    const taskId = crypto.randomUUID()
    const controller = new AbortController()
    // Plan §7 lifecycle: `created` first — the task is acknowledged (taskStarted
    // streams) BEFORE any model call, then transitions to `running`.
    const handle: AgentTaskHandle = {
      taskId,
      status: 'created',
      title: request.text.trim().slice(0, 80) || 'Untitled request',
      activities: [],
      assistantText: '',
      documents: [],
      nextSeq: 0,
      signal: controller.signal,
    }
    this.tasks.set(taskId, handle)
    this.aborters.set(taskId, controller)
    this.byRequestId.set(request.requestId, taskId)
    this.runs.set(taskId, { text: request.text, surface: request.surface })
    this.prune()

    const emit = this.emitter(handle)

    const active = this.activeTaskId ? this.tasks.get(this.activeTaskId) : undefined
    if (active && active.status === 'running') {
      // v1: one foreground task per session — reject the second visibly.
      emit.taskStarted(handle.title)
      emit.taskFailed('Another task is still running. Stop it or wait for it to finish.')
      return { taskId, started: true }
    }

    this.activeTaskId = taskId
    emit.taskStarted(handle.title)
    handle.status = 'running'
    this.launch(handle, emit, request.text, request.surface)
    return { taskId, started: true }
  }

  /**
   * Rehydrate a task from durable state (plan §14). A persisted `running`
   * task comes back `interrupted` — resumable, but never left running without
   * an owner.
   */
  restoreTask(record: {
    taskId: string
    requestId: string
    text: string
    surface: AgentSurfaceContext
    title: string
    status: 'running' | 'completed' | 'failed' | 'cancelled'
    assistantText: string
    activities: string[]
    plan?: PlanView
    documents: DocumentProgressState[]
    error?: string
    nextSeq?: number
  }): string {
    const controller = new AbortController()
    const handle: AgentTaskHandle = {
      taskId: record.taskId,
      status: record.status === 'running' ? 'interrupted' : record.status,
      title: record.title,
      activities: [...record.activities],
      assistantText: record.assistantText,
      plan: record.plan,
      documents: record.documents.map((d) => ({ ...d })),
      error: record.error,
      nextSeq: record.nextSeq ?? 0,
      signal: controller.signal,
    }
    this.tasks.set(record.taskId, handle)
    this.aborters.set(record.taskId, controller)
    this.byRequestId.set(record.requestId, record.taskId)
    this.runs.set(record.taskId, { text: record.text, surface: record.surface })
    // Plan §7: running → paused. A task rehydrated as interrupted was running
    // when the host died — surface the pause transition before any resume.
    if (handle.status === 'interrupted') {
      this.emitter(handle).taskPaused('The task was interrupted by an extension restart.')
    }
    return record.taskId
  }

  /** Task ids currently `interrupted` (worker auto-resumes them, plan §14). */
  interruptedTasks(): string[] {
    return [...this.tasks.values()].filter((h) => h.status === 'interrupted').map((h) => h.taskId)
  }

  /**
   * Plan §14: refuse a resume with a clear explanation (e.g. the repository
   * changed while the task was interrupted — safe resume is impossible).
   */
  failInterrupted(taskId: string, message: string): void {
    const handle = this.tasks.get(taskId)
    if (!handle || handle.status !== 'interrupted') return
    this.emitter(handle).taskFailed(message)
  }

  private launch(handle: AgentTaskHandle, emit: TaskEmitter, text: string, surface: AgentSurfaceContext, resume?: TaskResumePayload): void {
    void this.run({ handle, emit, text, surface, resume }).then(
      () => {
        if (handle.status === 'running') emit.taskCompleted()
      },
      (err) => {
        if (handle.status === 'running') emit.taskFailed(toErrorMessage(err))
      },
    )
  }

  /** Aborts the task's signal and children; preserves committed partial work. */
  cancel(taskId: string): boolean {
    const handle = this.tasks.get(taskId)
    if (
      !handle ||
      (handle.status !== 'running' && handle.status !== 'interrupted' && handle.status !== 'created')
    ) {
      return false
    }
    this.aborters.get(taskId)?.abort()
    this.emitter(handle).taskCancelled()
    return true
  }

  /**
   * Re-emits the snapshot so a webview can reconcile after reload — or, for an
   * interrupted task, RESUMES execution from the first incomplete node
   * (plan §14: completed nodes are never repeated).
   */
  resume(taskId: string, payload?: TaskResumePayload): void {
    const handle = this.tasks.get(taskId)
    if (!handle) return
    if (handle.status !== 'interrupted') {
      this.emitter(handle).snapshot()
      return
    }
    const inputs = this.runs.get(taskId)
    if (!inputs) {
      this.emitter(handle).taskFailed('Task state is incomplete — cannot resume.')
      return
    }
    handle.status = 'running'
    this.activeTaskId = taskId
    const emit = this.emitter(handle)
    emit.activity('Resuming task from the last durable checkpoint')
    this.launch(handle, emit, inputs.text, inputs.surface, payload)
  }

  /** Re-emits the snapshot for the active task (or idle) — webview remount. */
  sendSnapshot(): void {
    const handle = this.activeTaskId ? this.tasks.get(this.activeTaskId) : undefined
    const snapshot: AgentSessionSnapshot = handle
      ? toSnapshot(handle)
      : { taskId: null, status: 'idle', title: '', activities: [], assistantText: '' }
    // No task id → synthetic one so the envelope stays valid.
    this.onEventRaw({
      type: 'agentSessionSnapshot',
      taskId: handle?.taskId ?? 'session',
      seq: 0,
      timestamp: Date.now(),
      snapshot,
    })
  }

  private emitter(handle: AgentTaskHandle): TaskEmitter {
    return new TaskEmitter(handle, (e) => this.onEventRaw(e))
  }

  private onEventRaw(e: AgentEvent): void {
    for (const listener of this.listeners) listener(e)
  }

  /** Bounded memory: drop the oldest terminal tasks beyond MAX_TASKS. */
  private prune(): void {
    if (this.tasks.size <= MAX_TASKS) return
    const terminal = [...this.tasks.entries()].filter(
      ([, h]) => h.status !== 'running' && h.status !== 'interrupted' && h.status !== 'created',
    )
    const excess = this.tasks.size - MAX_TASKS
    for (const [id] of terminal.slice(0, excess)) {
      this.tasks.delete(id)
      this.aborters.delete(id)
      this.runs.delete(id)
      for (const [rid, tid] of this.byRequestId) {
        if (tid === id) this.byRequestId.delete(rid)
      }
    }
  }
}
