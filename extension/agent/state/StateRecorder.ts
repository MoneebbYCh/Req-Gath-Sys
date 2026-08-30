import type { AgentEvent } from '../../../shared/agentProtocol'
import type { TaskNode } from '../contracts/TaskGraph'
import type { EvidenceRecord } from '../contracts/Evidence'
import type { Finding, ProjectFact } from '../contracts/Finding'
import type { DocumentIR } from '../../documents/DocumentIR'
import type { AgentSession } from '../session'
import {
  MAX_PERSISTED_EVIDENCE,
  MAX_PERSISTED_TASKS,
  emptyState,
  type LoopState,
  type PersistedAgentState,
  type PersistedTask,
} from './PersistedState'

/**
 * Worker-side durable-state recorder (plan §14): mirrors runtime events and
 * the live task graph into a persistable snapshot, flushed through the host
 * state store (atomic writes). On load, tasks persisted as `running` become
 * `interrupted` — the runtime may resume them, never leave them zombie.
 *
 * Persistence is debounced (plan §14: durable checkpoints, not per-token
 * writes); terminal events flush immediately so completion/cancellation state
 * can never be lost by a crash.
 */

export interface StateSink {
  (state: PersistedAgentState): void | Promise<void>
}

export interface KnowledgeSnapshot {
  findings: Finding[]
  facts: ProjectFact[]
  evidence: EvidenceRecord[]
}

export interface StateRecorderOptions {
  /** Persist at most this often (ms). */
  debounceMs?: number
  /** Injectable timer for tests. */
  setTimeout?: typeof setTimeout
  clearTimeout?: typeof clearTimeout
}

export interface RestoredTaskRecord {
  taskId: string
  requestId: string
  text: string
  surface: PersistedTask['surface']
  title: string
  status: 'running' | 'completed' | 'failed' | 'cancelled'
  assistantText: string
  activities: string[]
  documents: PersistedTask['documents']
  error?: string
  graph?: TaskNode[]
}

export class StateRecorder {
  private readonly state: PersistedAgentState
  private readonly sink: StateSink
  private readonly debounceMs: number
  private readonly setT: typeof setTimeout
  private readonly clearT: typeof clearTimeout
  private timer: ReturnType<typeof setTimeout> | undefined
  private dirty = false

  constructor(initial: PersistedAgentState | null, sink: StateSink, options: StateRecorderOptions = {}) {
    this.state = initial ?? emptyState('local', '')
    this.sink = sink
    this.debounceMs = options.debounceMs ?? 500
    this.setT = options.setTimeout ?? setTimeout
    this.clearT = options.clearTimeout ?? clearTimeout
  }

  /** The workspaceId/repoFingerprint the restored state belongs to. */
  context(): { workspaceId: string; repoFingerprint: string } {
    return { workspaceId: this.state.workspaceId, repoFingerprint: this.state.repoFingerprint }
  }

  /**
   * Workspace identity: a different workspace wipes old tasks (no
   * cross-contamination); the same workspace only refreshes the fingerprint
   * (the persisted one was already consumed for resume gating).
   */
  setWorkspace(workspaceId: string, repoFingerprint: string): void {
    if (this.state.workspaceId === workspaceId) {
      if (this.state.repoFingerprint !== repoFingerprint) {
        this.state.repoFingerprint = repoFingerprint
        this.schedule()
      }
      return
    }
    const fresh = emptyState(workspaceId, repoFingerprint)
    this.state.workspaceId = fresh.workspaceId
    this.state.repoFingerprint = fresh.repoFingerprint
    this.state.tasks = []
    this.state.documentIRs = {}
    this.state.findings = []
    this.state.facts = []
    this.state.evidence = []
    this.schedule()
  }

  /** Mirror every runtime event into the durable task record. */
  onEvent(e: AgentEvent): void {
    const task = this.taskFor(e.taskId)
    task.nextSeq = Math.max(task.nextSeq ?? 0, e.seq + 1)
    switch (e.type) {
      case 'agentTaskStarted':
        // taskFor() above may have created a placeholder — always set the title.
        task.title = e.title
        break
      case 'agentActivity':
        task.activities = [...task.activities, e.activity].slice(-50)
        break
      case 'agentAssistantDelta':
        task.assistantText += e.text
        break
      case 'agentPlanUpdated':
        task.plan = e.plan
        break
      case 'agentDocumentDeclared':
      case 'agentDocumentProgress': {
        const idx = task.documents.findIndex((d) => d.documentId === e.document.documentId)
        if (idx === -1) task.documents.push(e.document)
        else task.documents[idx] = e.document
        // Attach the documentId to the graph node mid-generation so a crash
        // does not lose the doc→node link (regeneration/resume needs it).
        this.attachDocumentId(e.document.documentId)
        break
      }
      case 'agentTaskCompleted':
        task.status = 'completed'
        this.flush()
        return
      case 'agentTaskFailed':
        task.status = 'failed'
        task.error = e.error
        this.flush()
        return
      case 'agentTaskCancelled':
        task.status = 'cancelled'
        this.flush()
        return
      case 'agentTaskPaused':
        // The durable record keeps `running` (it rehydrates as interrupted —
        // the resumable paused form); the pause reason joins the activity log.
        task.activities = [...task.activities, `Paused: ${e.reason}`].slice(-50)
        break
      case 'agentValidationProgress':
        task.activities = [...task.activities, e.message].slice(-50)
        break
      default:
        return
    }
    this.schedule()
  }

  /** The orchestrator reports the live graph after every change. */
  onGraphChange(nodes: TaskNode[]): void {
    const task = this.state.tasks.find((t) => t.status === 'running')
    if (!task) return
    task.graph = nodes.map((n) => ({ ...n, outputs: [...n.outputs] }))
    this.schedule()
  }

  /** The document worker reports every checkpointed IR (regeneration base). */
  onDocumentCheckpoint(documentId: string, ir: DocumentIR): void {
    this.state.documentIRs[documentId] = ir
    this.schedule()
  }

  /** User deleted a dashboard document — drop its regeneration IR. */
  dropDocumentIR(documentId: string): void {
    if (!(documentId in this.state.documentIRs)) return
    delete this.state.documentIRs[documentId]
    this.schedule()
  }

  /** Clear conversation (and task transcripts) while keeping repo facts. */
  resetConversation(_workspaceId: string, session: AgentSession): void {
    this.state.session = structuredCloneSafe(session)
    this.state.tasks = []
    this.state.updatedAt = Date.now()
    this.flush()
  }

  /**
   * Shared knowledge layer (plan §14): persisted so resumed tasks never
   * repeat completed repository analysis. Bounded by design — but invariant 10
   * (plan §0): evidence referenced by persisted findings/facts is NEVER
   * dropped by the size cap. Only unreferenced records age out.
   */
  onKnowledgeSnapshot(snapshot: KnowledgeSnapshot): void {
    this.state.findings = snapshot.findings.map((f) => ({ ...f, evidenceIds: [...f.evidenceIds] }))
    this.state.facts = snapshot.facts.map((f) => ({ ...f, evidenceIds: [...f.evidenceIds], sourceFindingIds: [...f.sourceFindingIds] }))
    this.state.evidence = keepReferencedEvidence(snapshot.evidence, snapshot.findings, snapshot.facts)
    this.schedule()
  }

  /** Persist the runtime-owned session and its compacted turn log. */
  onSessionSnapshot(session: AgentSession | undefined): void {
    this.state.session = session ? structuredCloneSafe(session) : undefined
    this.schedule()
  }

  restoredSession(): AgentSession | undefined {
    return this.state.session ? structuredCloneSafe(this.state.session) : undefined
  }

  /** Rehydrate the knowledge layer after a restart. */
  restoredKnowledge(): KnowledgeSnapshot {
    return {
      findings: this.state.findings,
      facts: this.state.facts,
      evidence: this.state.evidence,
    }
  }

  /** Attach the request identity after the runtime has allocated its task id. */
  setRequestIdentityForTask(
    taskId: string,
    requestId: string,
    text: string,
    surface: PersistedTask['surface'],
  ): void {
    const task = this.state.tasks.find((t) => t.taskId === taskId)
    if (!task) return
    task.requestId = requestId
    task.text = text
    task.surface = surface
    this.schedule()
  }

  /**
   * Tasks to rehydrate into the runtime after a restart. Persisted `running`
   * tasks come back as interrupted — never as live zombies.
   */
  restoredTasks(): Array<RestoredTaskRecord & { interrupted: boolean }> {
    return this.state.tasks.map((t) => ({
      ...t,
      interrupted: t.status === 'running',
    }))
  }

  /** Resume payload for a complex task: graph + dependency outputs. */
  resumeGraph(taskId: string): { graph: TaskNode[]; outputs: Record<string, string[]> } | undefined {
    const task = this.state.tasks.find((t) => t.taskId === taskId)
    if (!task?.graph) return undefined
    const outputs: Record<string, string[]> = {}
    for (const n of task.graph) {
      if (n.status === 'completed') outputs[n.id] = n.outputs
    }
    return { graph: task.graph, outputs }
  }

  /** Mid-loop conversation for a single-loop task (plan §14 resume). */
  resumeLoop(taskId: string): LoopState | undefined {
    return this.state.tasks.find((t) => t.taskId === taskId)?.loopState
  }

  /** Mirror a mid-loop checkpoint into the durable task record. */
  onLoopCheckpoint(taskId: string, loopState: LoopState): void {
    const task = this.state.tasks.find((t) => t.taskId === taskId)
    if (!task) return
    task.loopState = loopState
    this.schedule()
  }

  /** Combined resume payload the runtime passes to a single-loop or graph runner. */
  resumePayload(taskId: string): { graph?: TaskNode[]; outputs?: Record<string, string[]>; loopState?: LoopState } {
    const graph = this.resumeGraph(taskId)
    return {
      ...(graph ?? {}),
      loopState: this.resumeLoop(taskId),
    }
  }

  /** The document IRs that must survive a restart (host restores them). */
  documentIRs(): Record<string, DocumentIR> {
    return this.state.documentIRs
  }

  /** Immediate durable flush — used by the worker before exit. */
  flush(): void {
    this.dirty = false
    if (this.timer) {
      this.clearT(this.timer)
      this.timer = undefined
    }
    this.persist()
  }

  /**
   * Async flush for node-durability hooks (plan §14): persists immediately
   * when dirty, cancelling any pending debounce; resolves once the sink has
   * posted the state.
   */
  async flushAsync(): Promise<void> {
    if (this.timer) {
      this.clearT(this.timer)
      this.timer = undefined
    }
    this.dirty = false
    await this.persistAsync()
  }

  private schedule(): void {
    this.dirty = true
    if (this.timer) return
    this.timer = this.setT(() => {
      this.timer = undefined
      if (this.dirty) {
        this.dirty = false
        this.persist()
      }
    }, this.debounceMs)
  }

  private persist(): void {
    // Best-effort lifecycle/debounce persistence must never produce an
    // unhandled rejection. Critical node checkpoints call flushAsync() and
    // deliberately receive persistence failures.
    void this.persistAsync().catch(() => {})
  }

  private async persistAsync(): Promise<void> {
    this.prune()
    this.state.updatedAt = Date.now()
    await this.sink(structuredCloneSafe(this.state))
  }

  /** Bounded: keep only the most recent tasks (plan §14/§15). */
  private prune(): void {
    if (this.state.tasks.length <= MAX_PERSISTED_TASKS) return
    this.state.tasks = this.state.tasks.slice(-MAX_PERSISTED_TASKS)
  }

  private taskFor(taskId: string): PersistedTask {
    const existing = this.state.tasks.find((t) => t.taskId === taskId)
    if (existing) return existing
    const created: PersistedTask = {
      taskId,
      requestId: '',
      text: '',
      surface: { page: '' },
      title: 'Untitled request',
      status: 'running',
      assistantText: '',
      activities: [],
      documents: [],
      nextSeq: 0,
    }
    this.state.tasks.push(created)
    return created
  }

  /**
   * Persisted graph nodes must point at their document so a resumed document
   * node continues instead of creating a duplicate (plan §14).
   */
  private attachDocumentId(documentId: string): void {
    for (const task of this.state.tasks) {
      const node = task.graph?.find(
        (n) => n.roleSpec.workerType === 'document' && n.status === 'running' && !n.documentId,
      )
      if (node) {
        node.documentId = documentId
        this.schedule()
        return
      }
    }
  }
}

function structuredCloneSafe<T>(value: T): T {
  return typeof structuredClone === 'function' ? structuredClone(value) : JSON.parse(JSON.stringify(value)) as T
}

/**
 * Invariant 10: the persisted-evidence cap must never drop a record that a
 * persisted finding/fact cites (dropping it would orphan claims). Referenced
 * records always survive; the cap only ages out unreferenced ones (oldest
 * first). Referenced records may therefore push the total slightly over the
 * cap — correctness wins over the byte budget.
 */
function keepReferencedEvidence(
  evidence: EvidenceRecord[],
  findings: Finding[],
  facts: ProjectFact[],
): EvidenceRecord[] {
  const referenced = new Set<string>()
  for (const f of findings) for (const id of f.evidenceIds) referenced.add(id)
  for (const f of facts) for (const id of f.evidenceIds) referenced.add(id)
  const kept = evidence.filter((e) => referenced.has(e.id))
  const unreferenced = evidence.filter((e) => !referenced.has(e.id))
  const room = Math.max(0, MAX_PERSISTED_EVIDENCE - kept.length)
  return [...kept, ...unreferenced.slice(-room)].map((e) => ({ ...e }))
}
