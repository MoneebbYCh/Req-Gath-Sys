import { z } from 'zod'

/**
 * Identifies the repository snapshot being analyzed (plan §5). Evidence and
 * findings carry a `repositoryVersion` so staleness is detectable when the
 * source changes.
 */
export interface RepositoryVersion {
  id: string
  workspaceId: string
  /** Per-workspace-root content hash used to detect drift. */
  rootHashes?: Record<string, string>
  createdAt: number
}

export const repositoryVersionSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  rootHashes: z.record(z.string(), z.string()).optional(),
  createdAt: z.number(),
})
