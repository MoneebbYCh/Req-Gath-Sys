import type { Finding } from '../contracts/Finding'
import { isGrounded } from '../contracts/Finding'

/**
 * Deterministic evaluation metrics (plan §5): pure functions computed from
 * retrieval results, findings, evidence, and event timestamps. Kept free of
 * any model provider so fixtures can be scored offline; the execution harness
 * (real repositories + real models) runs periodically, not in CI.
 */

export interface RetrievalInput {
  /** Normalized paths/symbols the retrieval surfaced (most relevant first). */
  retrieved: string[]
  /** Patterns a correct answer must surface. Substring/glob-ish match. */
  expected: string[]
  /** Rank cutoff. */
  k?: number
}

export interface EvalTimings {
  /** Task-accepted timestamp. */
  taskStartedAt: number
  /** First activity/token timestamps — 0 when absent. */
  firstActivityAt?: number
  firstTextTokenAt?: number
  taskCompletedAt?: number
}

export interface ReadEvent {
  key: string
}

/** Recall@K: fraction of expected evidence found in the top-K retrieved items. */
export function recallAtK({ retrieved, expected, k = 10 }: RetrievalInput): number {
  if (expected.length === 0) return 1
  const top = retrieved.slice(0, k).map(normalizeTerm)
  const hits = expected.filter((pattern) => top.some((r) => matches(r, normalizeTerm(pattern))))
  return hits.length / expected.length
}

/** Fraction of repository claims that are unsupported (`observed` without evidence). */
export function unsupportedClaimRate(findings: Finding[]): number {
  if (findings.length === 0) return 0
  const unsupported = findings.filter((f) => f.type === 'observed' && !isGrounded(f)).length
  return unsupported / findings.length
}

/** Evidence precision: fraction of cited evidence ids that actually exist. */
export function evidencePrecision(findings: Finding[], knownEvidenceIds: ReadonlySet<string>): number {
  const cited = findings.flatMap((f) => f.evidenceIds)
  if (cited.length === 0) return 1
  const valid = cited.filter((id) => knownEvidenceIds.has(id)).length
  return valid / cited.length
}

/** Repeated read rate: fraction of repository reads that were duplicates. */
export function repeatedReadRate(reads: ReadEvent[]): number {
  if (reads.length === 0) return 0
  const seen = new Set<string>()
  let duplicates = 0
  for (const read of reads) {
    if (seen.has(read.key)) duplicates++
    else seen.add(read.key)
  }
  return duplicates / reads.length
}

/** Task completion rate. */
export function taskCompletionRate(statuses: Array<'completed' | 'failed' | 'cancelled'>): number {
  if (statuses.length === 0) return 0
  return statuses.filter((s) => s === 'completed').length / statuses.length
}

/** First-visible-feedback latency (ms): accept → first activity. */
export function firstFeedbackLatency(t: EvalTimings): number | undefined {
  return t.firstActivityAt !== undefined ? t.firstActivityAt - t.taskStartedAt : undefined
}

/** First-text-token latency (ms): accept → first assistant text. */
export function firstTokenLatency(t: EvalTimings): number | undefined {
  return t.firstTextTokenAt !== undefined ? t.firstTextTokenAt - t.taskStartedAt : undefined
}

/** Total task latency (ms): accept → completion. */
export function totalTaskLatency(t: EvalTimings): number | undefined {
  return t.taskCompletedAt !== undefined ? t.taskCompletedAt - t.taskStartedAt : undefined
}

function normalizeTerm(term: string): string {
  return term.toLowerCase().replace(/[^a-z0-9.*_/-]/g, '').trim()
}

function matches(haystack: string, needle: string): boolean {
  if (needle === '') return false
  if (needle.includes('*')) {
    const parts = needle.split('*').filter(Boolean)
    return parts.every((p) => haystack.includes(p))
  }
  return haystack === needle || haystack.includes(needle) || needle.includes(haystack)
}
