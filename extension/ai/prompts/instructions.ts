import * as fs from 'fs/promises'
import * as path from 'path'
import { STATE_DIR } from '../../brand'

/** Cap project instructions so they cannot dominate the system prompt. */
export const AGENTS_MD_CHAR_CAP = 8_000

/**
 * Load first existing project instruction file (Charter then root AGENTS.md).
 * Returns undefined when none exist.
 */
export async function loadProjectInstructions(workspaceRoot: string): Promise<string | undefined> {
  const candidates = [
    path.join(workspaceRoot, STATE_DIR, 'AGENTS.md'),
    path.join(workspaceRoot, 'AGENTS.md'),
  ]
  for (const filePath of candidates) {
    try {
      const raw = await fs.readFile(filePath, 'utf8')
      const trimmed = raw.trim()
      if (!trimmed) continue
      const body =
        trimmed.length > AGENTS_MD_CHAR_CAP
          ? `${trimmed.slice(0, AGENTS_MD_CHAR_CAP)}\n…(truncated)`
          : trimmed
      return `Instructions from: ${filePath}\n${body}`
    } catch {
      // try next
    }
  }
  return undefined
}
