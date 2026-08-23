import { z } from 'zod'

/**
 * Evidence-backed knowledge contracts (plan §5 / §7). Findings distinguish
 * `observed` (has evidence), `inferred`, `proposed`, and `unknown` claims —
 * these must stay distinct through document generation.
 */
export type FindingType = 'observed' | 'inferred' | 'proposed' | 'unknown'
export type Confidence = 'high' | 'medium' | 'low'

export interface Finding {
  id: string
  claim: string
  type: FindingType
  domain: string
  evidenceIds: string[]
  confidence: Confidence
  assumptions: string[]
  contradictions: string[]
  repositoryVersion: string
  /**
   * Optional planner/worker supplied semantic identity for a canonical fact.
   * Different claims in one domain must not overwrite one another; claims with
   * the same key represent competing statements about the same subject.
   */
  factKey?: string
}

export const findingSchema = z.object({
  id: z.string(),
  claim: z.string(),
  type: z.enum(['observed', 'inferred', 'proposed', 'unknown']),
  domain: z.string(),
  evidenceIds: z.array(z.string()),
  confidence: z.enum(['high', 'medium', 'low']),
  assumptions: z.array(z.string()),
  contradictions: z.array(z.string()),
  repositoryVersion: z.string(),
  factKey: z.string().min(1).optional(),
})

/** A normalized, accepted finding reusable across tasks and documents. */
export interface ProjectFact {
  id: string
  key: string
  statement: string
  domain: string
  sourceFindingIds: string[]
  evidenceIds: string[]
  confidence: Confidence
  repositoryVersion: string
  updatedAt: number
}

export const projectFactSchema = z.object({
  id: z.string(),
  key: z.string(),
  statement: z.string(),
  domain: z.string(),
  sourceFindingIds: z.array(z.string()),
  evidenceIds: z.array(z.string()),
  confidence: z.enum(['high', 'medium', 'low']),
  repositoryVersion: z.string(),
  updatedAt: z.number(),
})

/**
 * Invariant 3: a finding that claims current implementation behavior
 * (`observed`) must be backed by evidence. Inferred/proposed/unknown findings
 * may be ungrounded but must carry their uncertainty explicitly.
 */
export function isGrounded(finding: Finding): boolean {
  return finding.type !== 'observed' || finding.evidenceIds.length > 0
}

/** Normalized claim key for deduplication. */
export function claimKey(claim: string): string {
  return claim.toLowerCase().replace(/\s+/g, ' ').trim()
}

/**
 * Invariant 4: workers never directly mutate shared fact state — equivalent
 * findings are normalized into a single record here (the commit step). The
 * finding with the most evidence wins.
 */
export function dedupeFindings(findings: Finding[]): Finding[] {
  const seen = new Map<string, Finding>()
  for (const f of findings) {
    const key = `${f.domain}::${claimKey(f.claim)}`
    const existing = seen.get(key)
    if (!existing || f.evidenceIds.length > existing.evidenceIds.length) {
      seen.set(key, f)
    }
  }
  return [...seen.values()]
}
