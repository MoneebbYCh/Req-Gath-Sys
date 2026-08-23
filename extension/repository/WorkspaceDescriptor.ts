import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import path from 'node:path'

/**
 * Multi-root workspace identity (plan §5): repository analysis must never
 * silently ignore secondary workspace folders. The legacy `.charter-ai`
 * document storage keeps using the first folder (`primaryRoot`); analysis
 * tools operate over `roots` — ALL workspace folders.
 */
export interface WorkspaceDescriptor {
  /** Stable workspace identity (reused for session/state scoping). */
  workspaceId: string
  /** All analysis roots. */
  roots: string[]
  /** Stable identifiers parallel to `roots`. Never use a mutable root index in persisted provenance. */
  rootIds: string[]
  /** First workspace folder — legacy document storage location. */
  primaryRoot?: string
}

/**
 * A root id is derived from its canonical absolute path rather than workspace
 * folder order. Reordering folders therefore cannot reinterpret persisted
 * evidence or a model-supplied location.
 */
export function workspaceRootId(root: string): string {
  const canonicalRoot = canonicalPath(root)
  return `root_${createHash('sha256').update(canonicalRoot).digest('hex').slice(0, 16)}`
}

export function createWorkspaceDescriptor(workspaceId: string, roots: string[]): WorkspaceDescriptor {
  return { workspaceId, roots, rootIds: roots.map(workspaceRootId), primaryRoot: roots[0] }
}

export function rootIdAt(roots: string[], index: number): string | undefined {
  return roots[index] === undefined ? undefined : workspaceRootId(roots[index])
}

export function rootIndexForId(roots: string[], rootId: string): number {
  return roots.findIndex((root) => workspaceRootId(root) === rootId)
}

export function rootIdForAbsolutePath(absolutePath: string, roots: string[]): string | undefined {
  const resolved = canonicalPath(absolutePath)
  const root = roots.find((candidate) => {
    const relative = path.relative(canonicalPath(candidate), resolved)
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
  })
  return root === undefined ? undefined : workspaceRootId(root)
}
function canonicalPath(value: string): string {
  try {
    return realpathSync.native(value).replace(/\\/g, '/')
  } catch {
    return path.resolve(value).replace(/\\/g, '/')
  }
}

/** A path is only meaningful together with its workspace root. */
export interface RepositoryLocation {
  rootId: string
  path: string
}
