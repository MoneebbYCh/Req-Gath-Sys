/**
 * Scopes webview localStorage to the VS Code folder currently open.
 * Disk persistence already lives under that folder's `.charter-ai/`;
 * this prevents drafts/templates from leaking across projects.
 */

let workspacePath: string | null = null
let workspaceId: string | null = null

/** Stable short id derived from an absolute folder path. */
export function workspaceIdFromPath(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  // FNV-1a 32-bit — compact, deterministic, good enough for key namespacing.
  let hash = 0x811c9dc5
  for (let i = 0; i < normalized.length; i++) {
    hash ^= normalized.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  const hex = (hash >>> 0).toString(16).padStart(8, '0')
  const base = normalized.split('/').filter(Boolean).pop() || 'workspace'
  const safe = base.replace(/[^a-z0-9._-]+/g, '-').slice(0, 32)
  return `${safe}-${hex}`
}

/** Apply a new workspace scope. Returns true when the folder changed. */
export function setWorkspaceScope(path: string): boolean {
  const nextPath = path.trim()
  if (!nextPath) return false
  const nextId = workspaceIdFromPath(nextPath)
  const changed = workspaceId !== nextId
  workspacePath = nextPath
  workspaceId = nextId
  return changed
}

export function getWorkspacePath(): string | null {
  return workspacePath
}

export function getWorkspaceId(): string | null {
  return workspaceId
}

export function hasWorkspaceScope(): boolean {
  return Boolean(workspaceId)
}

/**
 * Prefix a localStorage key with the active workspace id.
 * Before scope is set (e.g. pure browser preview), returns the bare key.
 */
export function workspaceScopedKey(baseKey: string): string {
  if (!workspaceId) return baseKey
  return `${baseKey}@@${workspaceId}`
}

/** localStorage base key for the templates tutorial. */
export const TEMPLATE_TUTORIAL_BASE_KEY = 'charter-ai-template-tutorial-seen-v1'

/** localStorage key for a doc/tutorial: workspace-scoped. */
export function storageKeyFor(baseKey: string): string {
  return workspaceScopedKey(baseKey)
}
