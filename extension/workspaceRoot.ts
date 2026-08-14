/**
 * Resolve the workspace folder used for `.charter-ai/` state writes.
 * Returns null when no folder is open — callers must NOT fall back to the
 * extension install directory (that was a P0 bug: state written into the
 * extension bundle location).
 */
export function resolveWorkspaceRoot(folderPath: string | undefined): string | null {
  return folderPath && folderPath.trim() ? folderPath : null
}
