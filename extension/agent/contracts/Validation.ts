import { z } from 'zod'

/**
 * Validation contracts (plan §13). Validation happens in three layers:
 *
 * 1. Deterministic — evidence ids resolve, files still exist, content hashes
 *    are current (stale evidence → refresh/caveat, never silent deletion).
 * 2. Model-based claim validation — important claims from a generated document
 *    are judged against the evidence ledger / fact base (supports / weak /
 *    contradicted). `current` claims (implementation behavior) and `proposed`
 *    claims (future intent) are validated differently.
 * 3. Cross-document consistency — claims across the document set are compared;
 *    conflicts are resolved against the shared fact base or explicitly
 *    reported as unresolved.
 *
 * A `contradicted` CURRENT-state claim marks its section for targeted
 * regeneration — the affected section only, never the whole document.
 */

export type ClaimKind = 'current' | 'proposed'
export type ClaimVerdict = 'supported' | 'weak' | 'contradicted' | 'unsupported'

export interface ClaimResult {
  claim: string
  kind: ClaimKind
  verdict: ClaimVerdict
  evidenceIds: string[]
  /** Section the claim came from — used to target regeneration. */
  sectionHeading?: string
  note: string
}

export const claimResultSchema = z.object({
  claim: z.string().min(1).max(2_000),
  kind: z.enum(['current', 'proposed']),
  verdict: z.enum(['supported', 'weak', 'contradicted', 'unsupported']),
  evidenceIds: z.array(z.string()).max(20),
  sectionHeading: z.string().max(300).optional(),
  note: z.string().max(2_000).default(''),
})

export interface CrossDocumentContradiction {
  /** Claim from one document. */
  a: string
  /** Contradicting claim from another document. */
  b: string
  note: string
  /** True when the fact base deterministically resolved the conflict. */
  resolved: boolean
  resolution?: string
}

export const crossDocumentContradictionSchema = z.object({
  a: z.string().min(1).max(2_000),
  b: z.string().min(1).max(2_000),
  note: z.string().max(2_000).default(''),
  resolved: z.boolean(),
  resolution: z.string().max(2_000).optional(),
})

export type ValidationReportStatus = 'passed' | 'issues' | 'failed'

/** Shared fields for both validation modes. */
interface ValidationReportBase {
  mode: 'document' | 'cross-document'
  status: ValidationReportStatus
  issues: string[]
}

/** Per-document validation result. */
export interface DocumentValidationReport extends ValidationReportBase {
  mode: 'document'
  documentId?: string
  title: string
  claims: ClaimResult[]
  /** Evidence ids whose source changed since they were recorded. */
  staleEvidenceIds: string[]
  /** Sections with contradicted current-state claims — regeneration targets. */
  failedSections: string[]
}

/** Cross-document consistency result. */
export interface CrossDocumentReport extends ValidationReportBase {
  mode: 'cross-document'
  contradictions: CrossDocumentContradiction[]
}

export type ValidationReport = DocumentValidationReport | CrossDocumentReport

const reportBase = {
  mode: z.enum(['document', 'cross-document']),
  status: z.enum(['passed', 'issues', 'failed']),
  issues: z.array(z.string().max(2_000)).max(50),
}

export const documentValidationReportSchema = z.object({
  ...reportBase,
  mode: z.literal('document'),
  documentId: z.string().optional(),
  title: z.string(),
  claims: z.array(claimResultSchema).max(40),
  staleEvidenceIds: z.array(z.string()).max(50),
  failedSections: z.array(z.string().max(300)).max(12),
})

export const crossDocumentReportSchema = z.object({
  ...reportBase,
  mode: z.literal('cross-document'),
  contradictions: z.array(crossDocumentContradictionSchema).max(40),
})

export const validationReportSchema = z.discriminatedUnion('mode', [
  documentValidationReportSchema,
  crossDocumentReportSchema,
])

/** A signal the validator hands the orchestrator to fix a failed section. */
export interface RegenerateSectionSignal {
  kind: 'regenerate-section'
  documentId: string
  title: string
  sectionHeading: string
  /** Why regeneration was requested (validation feedback). */
  note: string
  /** Nodes this regeneration depends on (the validating node). */
  dependencies: string[]
}

/** Replan signals accepted by the orchestrator (strings = analysis follow-ups). */
export type ReplanSignal = string | RegenerateSectionSignal
