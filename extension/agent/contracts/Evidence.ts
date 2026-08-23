import { z } from 'zod'

/**
 * A piece of repository content a tool observed. Deterministic — produced by
 * repository tools, never by the model directly.
 */
export interface EvidenceCandidate {
  path: string
  /** Stable workspace root identity. Required for all newly-produced evidence. */
  rootId?: string
  /** @deprecated Legacy root index, retained only to read old persisted state. */
  root?: number
  startLine: number
  endLine: number
  /** Bounded excerpt shown to the model/UI. */
  excerpt: string
  kind: 'source' | 'manifest' | 'structure' | 'git' | 'lsp'
  sourceTool: string
  /** Hash of the full source at read time — enables staleness detection (plan §7). Empty = unknown. */
  contentHash?: string
  /** Symbol this read captures (plan §12) — enables range remap when lines shift. */
  symbol?: string
}

export const evidenceCandidateSchema = z.object({
  path: z.string(),
  rootId: z.string().min(1).optional(),
  root: z.number().int().nonnegative().optional(),
  startLine: z.number().int().nonnegative(),
  endLine: z.number().int().nonnegative(),
  excerpt: z.string(),
  kind: z.enum(['source', 'manifest', 'structure', 'git', 'lsp']),
  sourceTool: z.string(),
  contentHash: z.string().optional(),
  symbol: z.string().optional(),
})

/**
 * A durable, re-readable evidence record. Stores a bounded excerpt plus enough
 * information to deterministically re-read the exact source (path + range +
 * content hash + repository version).
 */
export interface EvidenceRecord {
  id: string
  repositoryVersion: string
  path: string
  /** Stable workspace root identity. Missing only on legacy persisted records. */
  rootId?: string
  /** @deprecated Legacy persisted root index. */
  root?: number
  contentHash: string
  symbol?: string
  range?: { startLine: number; endLine: number }
  kind: 'source' | 'manifest' | 'git' | 'lsp' | 'structure'
  excerpt?: string
  sourceTool: string
  createdAt: number
}

export const evidenceRecordSchema = z.object({
  id: z.string(),
  repositoryVersion: z.string(),
  path: z.string(),
  rootId: z.string().min(1).optional(),
  root: z.number().int().nonnegative().optional(),
  contentHash: z.string(),
  symbol: z.string().optional(),
  range: z
    .object({
      startLine: z.number().int().nonnegative(),
      endLine: z.number().int().nonnegative(),
    })
    .optional(),
  kind: z.enum(['source', 'manifest', 'git', 'lsp', 'structure']),
  excerpt: z.string().optional(),
  sourceTool: z.string(),
  createdAt: z.number(),
})
