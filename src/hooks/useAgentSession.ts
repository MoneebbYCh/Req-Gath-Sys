import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import type {
  AgentEvent,
  AgentSessionSnapshot,
  AgentSurfaceContext,
  DocumentProgressState,
  PlanView,
} from '../../shared/agentProtocol'
import { getVscodeApi } from '../utils/vscodeApi'
import { BRAND_NAME } from '../brand'

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  timestamp: number
  /**
   * Plan §23.7: when a task fails after partial text streamed, the visible
   * answer is preserved and marked incomplete — never deleted, never
   * presented as a complete answer.
   */
  incomplete?: boolean
}

export interface AgentActivity {
  id: string
  text: string
  timestamp: number
}

export type AgentTaskStatus = 'idle' | 'running' | 'paused' | 'failed'

/** Plan §6 — the streaming session UI state. */
export interface AgentUiState {
  sessionId: string | null
  activeTaskId: string | null
  messages: ChatMessage[]
  activities: AgentActivity[]
  taskStatus: AgentTaskStatus
  /** Live plan for long tasks (plan §8); cleared when idle. */
  plan?: PlanView
  /** Live per-document progress (plan §12). */
  documents: DocumentProgressState[]
  error?: string
}

export type AgentAction =
  | { type: 'taskStarted'; taskId: string }
  | { type: 'activity'; taskId: string; activity: string; timestamp: number }
  | { type: 'assistantStarted'; taskId: string }
  | { type: 'assistantDelta'; taskId: string; text: string }
  | { type: 'assistantCompleted'; taskId: string }
  | { type: 'planUpdated'; taskId: string; plan: PlanView }
  | { type: 'documentDeclared'; taskId: string; document: DocumentProgressState }
  | { type: 'documentProgress'; taskId: string; document: DocumentProgressState }
  | { type: 'documentCheckpoint'; taskId: string; documentId: string; completedSections: number; totalSections: number; conflict?: boolean; pendingDraftId?: string }
  | { type: 'documentApplyDraft'; taskId: string; documentId: string; draftId: string }
  | {
      type: 'validationProgress'
      taskId: string
      phase: 'deterministic' | 'claim' | 'cross-document'
      message: string
      timestamp: number
      documentId?: string
      finalStatus?: 'completed' | 'failed'
    }
  | { type: 'taskCompleted'; taskId: string }
  | { type: 'taskFailed'; taskId: string; error: string }
  | { type: 'taskCancelled'; taskId: string }
  | { type: 'taskPaused'; taskId: string; reason: string }
  | { type: 'snapshot'; snapshot: AgentSessionSnapshot }
  | { type: 'userMessage'; text: string; timestamp: number }
  | { type: 'clear' }

const WELCOME: ChatMessage = {
  id: 'chat-welcome',
  role: 'assistant',
  text: `Hello! I'm your ${BRAND_NAME} assistant. Ask me about your repository.`,
  timestamp: 0,
}

let msgSeq = 0
function nextMessageId(): string {
  return `chat-${++msgSeq}`
}

function assistantMessageId(taskId: string): string {
  return `assistant-${taskId}`
}

function initialState(): AgentUiState {
  return {
    sessionId: null,
    activeTaskId: null,
    messages: [{ ...WELCOME }],
    activities: [],
    documents: [],
    taskStatus: 'idle',
  }
}

function mapStatus(status: AgentSessionSnapshot['status']): AgentTaskStatus {
  switch (status) {
    case 'created':
    case 'running':
      return 'running'
    case 'interrupted':
      // Plan §14: a task interrupted by an extension restart shows as paused
      // until the runtime resumes it from its durable checkpoint.
      return 'paused'
    case 'failed':
      return 'failed'
    case 'completed':
    case 'cancelled':
    case 'idle':
      return 'idle'
  }
}

function applySnapshot(state: AgentUiState, snapshot: AgentSessionSnapshot): AgentUiState {
  let messages = state.messages
  if (snapshot.taskId && snapshot.assistantText) {
    const id = assistantMessageId(snapshot.taskId)
    const idx = messages.findIndex((m) => m.id === id)
    const incomplete = snapshot.status === 'failed' // partial text from a failed task (plan §23.7)
    if (idx === -1) {
      messages = [...messages, { id, role: 'assistant', text: snapshot.assistantText, timestamp: Date.now(), incomplete }]
    } else {
      messages = messages.slice()
      messages[idx] = { ...messages[idx], text: snapshot.assistantText, incomplete }
    }
  }
  return {
    ...state,
    activeTaskId: snapshot.taskId,
    activities: (snapshot.activities ?? []).map((text, i) => ({
      id: `act-${snapshot.taskId ?? 'session'}-snap-${i}`,
      text,
      timestamp: Date.now(),
    })),
    messages,
    taskStatus: mapStatus(snapshot.status),
    plan: snapshot.plan,
    documents: snapshot.documents ?? [],
    error: snapshot.error,
  }
}

export function agentReducer(state: AgentUiState, action: AgentAction): AgentUiState {
  switch (action.type) {
    case 'taskStarted':
      return {
        ...state,
        activeTaskId: action.taskId,
        taskStatus: 'running',
        error: undefined,
        plan: undefined,
        documents: [],
      }
    case 'activity': {
      const activities = [
        ...state.activities,
        { id: `act-${action.taskId}-${action.timestamp}`, text: action.activity, timestamp: action.timestamp },
      ].slice(-50)
      return { ...state, activities }
    }
    case 'assistantStarted': {
      const id = assistantMessageId(action.taskId)
      if (state.messages.some((m) => m.id === id)) return state
      return {
        ...state,
        messages: [...state.messages, { id, role: 'assistant', text: '', timestamp: Date.now() }],
      }
    }
    case 'assistantDelta': {
      const id = assistantMessageId(action.taskId)
      const idx = state.messages.findIndex((m) => m.id === id)
      if (idx === -1) {
        return {
          ...state,
          messages: [...state.messages, { id, role: 'assistant', text: action.text, timestamp: Date.now() }],
        }
      }
      const messages = state.messages.slice()
      messages[idx] = { ...messages[idx], text: messages[idx].text + action.text }
      return { ...state, messages }
    }
    case 'assistantCompleted':
      return state
    case 'planUpdated':
      return { ...state, plan: action.plan }
    case 'documentDeclared':
    case 'documentProgress': {
      const documents = state.documents.slice()
      const idx = documents.findIndex((d) => d.documentId === action.document.documentId)
      if (idx === -1) documents.push(action.document)
      else documents[idx] = action.document
      return { ...state, documents }
    }
    case 'documentCheckpoint': {
      const documents = state.documents.slice()
      const idx = documents.findIndex((d) => d.documentId === action.documentId)
      if (idx !== -1) {
        documents[idx] = {
          ...documents[idx],
          completedSections: action.completedSections,
          totalSections: action.totalSections,
          pendingDraftId: action.pendingDraftId,
        }
      }
      return { ...state, documents }
    }
    case 'documentApplyDraft': {
      const documents = state.documents.slice()
      const idx = documents.findIndex((d) => d.documentId === action.documentId)
      if (idx !== -1) {
        documents[idx] = {
          ...documents[idx],
          pendingDraftId: undefined,
        }
      }
      return { ...state, documents }
    }
    case 'validationProgress': {
      // Plan §13: the validated document's status transitions (validating →
      // completed/failed) plus an operational activity line.
      let documents = state.documents
      if (action.documentId) {
        const idx = documents.findIndex((d) => d.documentId === action.documentId)
        if (idx !== -1) {
          documents = documents.slice()
          documents[idx] = {
            ...documents[idx],
            status: action.finalStatus === 'failed' ? 'failed' : action.finalStatus === 'completed' ? 'completed' : 'validating',
            error: action.finalStatus === 'failed' ? action.message : undefined,
          }
        }
      }
      return {
        ...state,
        documents,
        activities: [
          ...state.activities,
          { id: `act-${action.taskId}-val-${action.timestamp ?? Date.now()}`, text: action.message, timestamp: Date.now() },
        ].slice(-50),
      }
    }
    case 'taskCompleted':
      return { ...state, taskStatus: 'idle' }
    case 'taskFailed': {
      // Plan §23.7: partial streamed answer survives the failure and is
      // marked incomplete.
      const id = assistantMessageId(action.taskId)
      const idx = state.messages.findIndex((m) => m.id === id)
      let messages = state.messages
      if (idx !== -1 && state.messages[idx].text) {
        messages = state.messages.slice()
        messages[idx] = { ...messages[idx], incomplete: true }
      }
      return { ...state, messages, taskStatus: 'failed', error: action.error }
    }
    case 'taskCancelled':
      return { ...state, taskStatus: 'idle', error: undefined }
    case 'taskPaused':
      return {
        ...state,
        taskStatus: 'paused',
        activities: [
          ...state.activities,
          { id: `act-${action.taskId}-paused`, text: action.reason, timestamp: Date.now() },
        ].slice(-50),
      }
    case 'snapshot':
      return applySnapshot(state, action.snapshot)
    case 'userMessage':
      return {
        ...state,
        messages: [...state.messages, { id: nextMessageId(), role: 'user', text: action.text, timestamp: action.timestamp }],
      }
    case 'clear':
      return initialState()
  }
}

/** Maps a raw AgentEvent to the reducer action (snapshots handled by the caller). */
export function eventToAction(e: AgentEvent): AgentAction {
  switch (e.type) {
    case 'agentTaskStarted':
      return { type: 'taskStarted', taskId: e.taskId }
    case 'agentActivity':
      return { type: 'activity', taskId: e.taskId, activity: e.activity, timestamp: e.timestamp }
    case 'agentAssistantStarted':
      return { type: 'assistantStarted', taskId: e.taskId }
    case 'agentAssistantDelta':
      return { type: 'assistantDelta', taskId: e.taskId, text: e.text }
    case 'agentAssistantCompleted':
      return { type: 'assistantCompleted', taskId: e.taskId }
    case 'agentPlanUpdated':
      return { type: 'planUpdated', taskId: e.taskId, plan: e.plan }
    case 'agentDocumentDeclared':
      return { type: 'documentDeclared', taskId: e.taskId, document: e.document }
    case 'agentDocumentProgress':
      return { type: 'documentProgress', taskId: e.taskId, document: e.document }
    case 'agentDocumentCheckpoint':
      return {
        type: 'documentCheckpoint',
        taskId: e.taskId,
        documentId: e.documentId,
        completedSections: e.completedSections,
        totalSections: e.totalSections,
        conflict: e.conflict,
        pendingDraftId: e.pendingDraftId,
      }
    case 'agentValidationProgress':
      return {
        type: 'validationProgress',
        taskId: e.taskId,
        phase: e.phase,
        message: e.message,
        timestamp: e.timestamp,
        documentId: e.documentId,
        finalStatus: e.finalStatus,
      }
    case 'agentTaskCompleted':
      return { type: 'taskCompleted', taskId: e.taskId }
    case 'agentTaskFailed':
      return { type: 'taskFailed', taskId: e.taskId, error: e.error }
    case 'agentTaskCancelled':
      return { type: 'taskCancelled', taskId: e.taskId }
    case 'agentTaskPaused':
      return { type: 'taskPaused', taskId: e.taskId, reason: e.reason }
    case 'agentSessionSnapshot':
      return { type: 'snapshot', snapshot: e.snapshot }
  }
}

export function useAgentSession(surface: AgentSurfaceContext) {
  const vscode = getVscodeApi()
  const [isOpen, setIsOpen] = useState(false)
  const [state, dispatch] = useReducer(agentReducer, undefined, initialState)
  const lastSeqRef = useRef(new Map<string, number>())
  const vscodeRef = useRef(vscode)
  vscodeRef.current = vscode
  const surfaceRef = useRef(surface)
  surfaceRef.current = surface

  const toggleOpen = useCallback(() => setIsOpen((v) => !v), [])
  const close = useCallback(() => setIsOpen(false), [])

  // Reconcile after webview reload/remount: ask the runtime for its snapshot.
  useEffect(() => {
    vscodeRef.current?.postMessage({ type: 'agentLoadSession' })
  }, [])

  useEffect(() => {
    const handler = (event: MessageEvent) => {
      const msg = event.data
      if (msg?.type !== 'agentEvent') return
      const e = msg.event as AgentEvent
      // Snapshots always apply (they carry authoritative state).
      if (e.type === 'agentSessionSnapshot') {
        dispatch({ type: 'snapshot', snapshot: e.snapshot })
        return
      }
      // Idempotent dedupe: ignore duplicate / out-of-order seq (plan §6).
      const last = lastSeqRef.current.get(e.taskId)
      if (last !== undefined && e.seq <= last) return
      if (last !== undefined && e.seq > last + 1) {
        // Missed events — request a snapshot reconciliation.
        vscodeRef.current?.postMessage({ type: 'agentResume', taskId: e.taskId })
      }
      lastSeqRef.current.set(e.taskId, e.seq)
      dispatch(eventToAction(e))
    }
    window.addEventListener('message', handler)
    return () => window.removeEventListener('message', handler)
  }, [])

  const send = useCallback(
    (text: string) => {
      const trimmed = text.trim()
      if (!trimmed) return
      if (state.taskStatus === 'running') return // one foreground task per session
      const requestId = crypto.randomUUID()
      dispatch({ type: 'userMessage', text: trimmed, timestamp: Date.now() })
      if (!vscodeRef.current) {
        dispatch({ type: 'taskStarted', taskId: requestId })
        dispatch({
          type: 'taskFailed',
          taskId: requestId,
          error: 'Charter Ai is not connected to the VS Code extension host. Reload the VS Code window and reopen Charter Ai.',
        })
        return
      }
      vscodeRef.current.postMessage({
        type: 'agentStart',
        requestId,
        text: trimmed,
        surface: surfaceRef.current,
      })
    },
    [state.taskStatus],
  )

  const cancel = useCallback(() => {
    if (state.activeTaskId && state.taskStatus === 'running') {
      vscodeRef.current?.postMessage({ type: 'agentCancel', taskId: state.activeTaskId })
    }
  }, [state.activeTaskId, state.taskStatus])

  const applyPendingDraft = useCallback((documentId: string, draftId: string) => {
    vscodeRef.current?.postMessage({ type: 'documentApplyDraft', documentId, draftId })
  }, [])

  const clearMessages = useCallback(() => dispatch({ type: 'clear' }), [])

  return {
    isOpen,
    toggleOpen,
    close,
    ...state,
    send,
    cancel,
    clearMessages,
    applyPendingDraft,
    isRunning: state.taskStatus === 'running',
  }
}
