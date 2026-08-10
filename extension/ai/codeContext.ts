import { retrieve, formatChunksForPrompt } from './retrieval'
import type { EmbeddingConfig } from './embeddings'

/**
 * Retrieval-backed context: top-k code chunks most relevant to `query`.
 * Returns empty string when embeddings are unavailable or the index is empty.
 */
export async function buildGroundedContext(
  workspaceRoot: string,
  query: string,
  cfg: EmbeddingConfig,
  k = 8,
): Promise<string> {
  try {
    const chunks = await retrieve(workspaceRoot, query, k, cfg)
    if (chunks.length > 0) return formatChunksForPrompt(chunks)
  } catch {
    /* embeddings unavailable */
  }
  return ''
}
