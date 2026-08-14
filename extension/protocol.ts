export type View =
  | { page: 'home' }
  | { page: 'profile' }
  | { page: string }

/** Prior chat turns sent with each message for short-term memory. */
export interface ChatHistoryTurn {
  role: 'user' | 'assistant'
  text: string
}

// --- In-document AI chat (/Chat block) wire contract ------------------------

export type AiChatTarget = 'selection' | 'cursor' | 'section'
export type AiChatResponseKind = 'clarify' | 'answer' | 'modify' | 'insert' | 'redirect' | 'error'

/** Document context captured at the AI chat invocation point (webview-built). */
export interface AiChatContextPayload {
  /** Pre-slash text selection (guarded heuristic — only used when reliable). */
  selection?: { blockIds: string[]; markdown: string }
  /** Block the slash was invoked in (trigger "/" stripped). */
  cursorBlock?: { id: string; text: string }
  prevBlock?: { id: string; text: string }
  nextBlock?: { id: string; text: string }
  /** Heading-bounded block range around the invocation point. */
  section?: { blockIds: string[]; markdown: string } | null
  headings: string[]
  /** Whole document, markdown-ish, truncated head+tail. */
  docMarkdown: string
  blank: boolean
}

export interface AiChatResponsePayload {
  kind: AiChatResponseKind
  question?: string
  text?: string
  target?: AiChatTarget
  markdown?: string
  error?: string
}

export type ExtensionToWebviewMessage =
  | { type: 'loadCanvas'; phase: string; data: unknown }
  | { type: 'loadDocTypes'; data: unknown; mode?: 'merge' | 'replace' }
  | { type: 'navigateTo'; view: View }
  | { type: 'chatResponse'; text: string }
  | { type: 'chatStatus'; text: string | null }
  | { type: 'workspaceInfo'; path: string; name: string; available: boolean }
  | { type: 'aiChatResponse'; requestId: string } & AiChatResponsePayload

export type WebviewToExtensionMessage =
  | { type: 'saveCanvas'; phase: string; data: unknown }
  | { type: 'saveDocTypes'; data: unknown }
  | { type: 'loadDocTypes' }
  | { type: 'loadCanvas'; phase: string }
  | { type: 'navigate'; view: View }
  | { type: 'ready' }
  | { type: 'loadWorkspaceInfo' }
  | { type: 'chatMessage'; text: string; phase: string; history?: ChatHistoryTurn[] }
  | { type: 'exportMarkdown'; phase: string; markdown: string; suggestedName: string }
  | { type: 'aiChatRequest'; requestId: string; text: string; context: AiChatContextPayload }
