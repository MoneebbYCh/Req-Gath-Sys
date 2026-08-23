/**
 * Shared webview ↔ extension agent protocol.
 * Types-only + pure constants — importable from both the webview (vite) and
 * the extension host (esbuild). Runtime validation lives extension-side in
 * extension/agent/contracts/.
 *
 * Event contract (invariants):
 * - Every event belongs to a task and carries a monotonically increasing `seq`.
 * - Webviews ignore duplicate / out-of-order `seq` values idempotently.
 * - A missing sequence window triggers an agentSessionSnapshot reconciliation.
 */

export interface AgentEventBase {
  type: string
  taskId: string
  /** Monotonically increasing per task. */
  seq: number
  timestamp: number
}

export interface AgentTaskStartedEvent extends AgentEventBase {
  type: 'agentTaskStarted'
  title: string
}

export interface AgentActivityEvent extends AgentEventBase {
  type: 'agentActivity'
  /** High-level operational action — never chain-of-thought. */
  activity: string
}

/** One node of the live plan (plan §8): title + status, never chain-of-thought. */
export type PlanNodeStatus = 'queued' | 'running' | 'completed' | 'failed' | 'blocked' | 'cancelled'

export interface PlanNodeView {
  id: string
  title: string
  status: PlanNodeStatus
}

export interface PlanView {
  nodes: PlanNodeView[]
}

export interface AgentPlanUpdatedEvent extends AgentEventBase {
  type: 'agentPlanUpdated'
  plan: PlanView
}

/** Per-document generation progress (plan §12) — section counts, never fake percentages. */
export type DocumentGenerationStatus =
  | 'queued'
  | 'outlining'
  | 'generating'
  | 'validating'
  | 'completed'
  | 'failed'

export interface DocumentProgressState {
  documentId: string
  title: string
  status: DocumentGenerationStatus
  completedSections: number
  totalSections: number
  activeSection?: string
  error?: string
  /** Parked agent draft awaiting review/apply (plan §16.3 — user edits won). */
  pendingDraftId?: string
}

export interface AgentDocumentDeclaredEvent extends AgentEventBase {
  type: 'agentDocumentDeclared'
  document: DocumentProgressState
}

export interface AgentDocumentProgressEvent extends AgentEventBase {
  type: 'agentDocumentProgress'
  document: DocumentProgressState
}

export interface AgentDocumentCheckpointEvent extends AgentEventBase {
  type: 'agentDocumentCheckpoint'
  documentId: string
  title: string
  /** Section that just completed (empty for the initial empty-document checkpoint). */
  sectionTitle?: string
  completedSections: number
  totalSections: number
  /** True when the user edited meanwhile — the agent draft was parked, not applied. */
  conflict?: boolean
  pendingDraftId?: string
}

export interface AgentAssistantStartedEvent extends AgentEventBase {
  type: 'agentAssistantStarted'
}

export interface AgentAssistantDeltaEvent extends AgentEventBase {
  type: 'agentAssistantDelta'
  /** Coalesced text chunk. */
  text: string
}

export interface AgentAssistantCompletedEvent extends AgentEventBase {
  type: 'agentAssistantCompleted'
}

export interface AgentValidationProgressEvent extends AgentEventBase {
  type: 'agentValidationProgress'
  /** Which validation layer is running (plan §13) — never chain-of-thought. */
  phase: 'deterministic' | 'claim' | 'cross-document'
  message: string
  documentId?: string
  /** When a document's validation finishes, its resulting status. */
  finalStatus?: 'completed' | 'failed'
}

export interface AgentTaskCompletedEvent extends AgentEventBase {
  type: 'agentTaskCompleted'
  summary?: string
}

export interface AgentTaskFailedEvent extends AgentEventBase {
  type: 'agentTaskFailed'
  error: string
}

export interface AgentTaskCancelledEvent extends AgentEventBase {
  type: 'agentTaskCancelled'
}

export interface AgentTaskPausedEvent extends AgentEventBase {
  type: 'agentTaskPaused'
  /** Why the task paused — never chain-of-thought. */
  reason: string
}

export interface AgentSessionSnapshotEvent extends AgentEventBase {
  type: 'agentSessionSnapshot'
  snapshot: AgentSessionSnapshot
}

export type AgentEvent =
  | AgentTaskStartedEvent
  | AgentActivityEvent
  | AgentPlanUpdatedEvent
  | AgentAssistantStartedEvent
  | AgentAssistantDeltaEvent
  | AgentAssistantCompletedEvent
  | AgentDocumentDeclaredEvent
  | AgentDocumentProgressEvent
  | AgentDocumentCheckpointEvent
  | AgentValidationProgressEvent
  | AgentTaskCompletedEvent
  | AgentTaskFailedEvent
  | AgentTaskCancelledEvent
  | AgentTaskPausedEvent
  | AgentSessionSnapshotEvent

export type AgentTaskStatus = 'created' | 'running' | 'interrupted' | 'completed' | 'failed' | 'cancelled'

/** Enough to rebuild the visible task UI after a webview reload/remount. */
export interface AgentSessionSnapshot {
  taskId: string | null
  status: AgentTaskStatus | 'idle'
  title: string
  /** Recent high-level activities (oldest first). */
  activities: string[]
  /** Assistant text streamed so far (partial while running/failed). */
  assistantText: string
  /** Live plan for long tasks (plan §8). */
  plan?: PlanView
  /** Live per-document progress (plan §12). */
  documents?: DocumentProgressState[]
  summary?: string
  error?: string
}

/** What the user was looking at when they asked — request metadata, not identity. */
export interface AgentSurfaceContext {
  page: string
  activeDocumentId?: string
}

export type WebviewToExtensionAgentMessage =
  | { type: 'agentStart'; requestId: string; text: string; surface: AgentSurfaceContext }
  | { type: 'agentCancel'; taskId: string }
  | { type: 'agentResume'; taskId: string }
  | { type: 'agentLoadSession' }
  | { type: 'agentApplyDraft'; documentId: string; draftId: string; seq?: number }
