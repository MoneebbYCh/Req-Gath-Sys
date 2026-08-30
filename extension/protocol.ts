import type { AgentEvent, WebviewToExtensionAgentMessage } from '../shared/agentProtocol'
import type {
  ProvidersState,
  WebviewToExtensionProvidersMessage,
} from '../shared/providersProtocol'

export type View =
  | { page: 'home' }
  | { page: 'profile' }
  | { page: string }

export type ExtensionToWebviewMessage =
  | { type: 'loadCanvas'; phase: string; data: unknown; revision?: number }
  | { type: 'loadDocTypes'; data: unknown; mode?: 'merge' | 'replace' }
  | { type: 'navigateTo'; view: View }
  | { type: 'agentEvent'; event: AgentEvent }
  | { type: 'providersState'; state: ProvidersState }
  | { type: 'workspaceInfo'; path: string; name: string; available: boolean }
  | { type: 'saveCanvasAck'; phase: string; revision: number; seq?: number }
  | { type: 'saveCanvasConflict'; phase: string; currentRevision: number; seq?: number }

export type WebviewToExtensionMessage =
  | { type: 'saveCanvas'; phase: string; data: unknown; baseRevision?: number; seq?: number }
  | { type: 'saveDocTypes'; data: unknown }
  | { type: 'loadDocTypes' }
  | { type: 'loadCanvas'; phase: string }
  | { type: 'navigate'; view: View }
  | { type: 'ready' }
  | { type: 'loadWorkspaceInfo' }
  | { type: 'exportMarkdown'; phase: string; markdown: string; suggestedName: string }
  | { type: 'documentCreate'; name: string; icon?: string }
  | { type: 'documentRename'; id: string; name: string }
  | { type: 'documentDelete'; id: string }
  | { type: 'documentResetAll' }
  | { type: 'documentMove'; id: string; from: number; to: number }
  | { type: 'documentApplyDraft'; documentId: string; draftId: string; seq?: number }
  | WebviewToExtensionAgentMessage
  | WebviewToExtensionProvidersMessage
