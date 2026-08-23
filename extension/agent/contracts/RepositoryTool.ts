import { z } from 'zod'
import { evidenceCandidateSchema, type EvidenceCandidate } from './Evidence'

/** Context every repository tool receives on each call. */
export interface ToolContext {
  /** All analysis roots (multi-root aware — never silently only the first). */
  workspaceRoots: string[]
  /** Opaque version token identifying the repository snapshot being analyzed. */
  repositoryVersion: string
  /** Task-scoped abort signal; tools must respect it. */
  signal: AbortSignal
  log: (msg: string) => void
  /**
   * Resolves a user-supplied path and enforces workspace containment.
   * Throws `ToolError` on traversal/escape or symlink escape.
   */
  resolvePath(input: string): Promise<string>
  /** True when the path hits the sensitive-file policy (.env, keys, credentials…). */
  isSensitivePath(input: string): boolean
}

/**
 * A deterministic, read-only repository tool. No write/shell tool may exist
 * anywhere — read-only is enforced by the absence of write capabilities.
 */
export interface RepositoryTool<I, O> {
  name: string
  description: string
  inputSchema: z.ZodType<I>
  execute(input: I, ctx: ToolContext): Promise<ToolResult<O>>
}

/** Common result envelope — every tool returns bounded output (plan §9). */
export interface ToolResult<T> {
  data: T
  truncated: boolean
  nextCursor?: string
  warnings?: string[]
  repositoryVersion: string
  evidenceCandidates?: EvidenceCandidate[]
}

/**
 * Runtime validation for the tool boundary (plan §5: model/tool boundaries
 * need runtime validation). `toolResultSchema(dataSchema)` builds the full
 * envelope schema; `toolResultEnvelopeSchema` validates the envelope shape
 * with `data` left as unknown (used when the worker receives a result over
 * the host↔worker RPC boundary).
 */
export function toolResultSchema<D extends z.ZodTypeAny>(data: D) {
  return z.object({
    data,
    truncated: z.boolean(),
    nextCursor: z.string().optional(),
    warnings: z.array(z.string()).optional(),
    repositoryVersion: z.string(),
    evidenceCandidates: z.array(evidenceCandidateSchema).optional(),
  })
}

export const toolResultEnvelopeSchema = toolResultSchema(z.unknown())

/** Failure of a repository tool after normalization. */
export class ToolError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean = false,
  ) {
    super(message)
    this.name = 'ToolError'
  }
}
