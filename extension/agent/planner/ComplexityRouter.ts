/**
 * Complexity routing (plan §8): deterministic heuristics decide whether a
 * request gets the bounded fast path (simple) or a durable task graph
 * (complex). A structured classifier can replace the heuristics later without
 * touching the orchestrator.
 */

export type RouteDecision = 'simple' | 'complex'

export interface ComplexityRouterOptions {
  /** Optional classifier override (e.g. a cheap model call) — Phase 9+ hook. */
  classify?: (text: string) => RouteDecision
  /** Length above which a request is assumed multi-part. */
  lengthThreshold?: number
}

const DEFAULT_LENGTH_THRESHOLD = 240

const COMPLEX_KEYWORDS =
  /\b(analy[sz]e|complete|comprehensive|full|entire|audit|assessment|review|due diligence|roadmap|architecture|security|scalability|migration|performance|refactor|modernize|strategy|evaluate)\b/i

/** "generate three documents" / "create 10 docs" / multi-deliverable requests. */
const MULTI_DOC =
  /\b(create|generate|write|produce|build)\b[^.!?\n]{0,60}\b(\d+|[a-z]+)\s+(documents?|docs|deliverables)\b/i

/** Several distinct asks in one message ("…and also…"). */
const MULTI_SENTENCE =
  /\b(and|also|plus|additionally)\s+\w+\s+(analy[sz]e|audit|document|assess|review|map|generate|write|create|trace|explain|check)\b/i

export class ComplexityRouter {
  private readonly classify?: (text: string) => RouteDecision
  private readonly lengthThreshold: number

  constructor(options: ComplexityRouterOptions = {}) {
    this.classify = options.classify
    this.lengthThreshold = options.lengthThreshold ?? DEFAULT_LENGTH_THRESHOLD
  }

  route(text: string): RouteDecision {
    if (this.classify) return this.classify(text)
    const t = text.trim()
    if (hasDocumentIntent(t) || MULTI_DOC.test(t) || MULTI_SENTENCE.test(t)) return 'complex'
    if (t.length > this.lengthThreshold) return 'complex'
    return COMPLEX_KEYWORDS.test(t) ? 'complex' : 'simple'
  }
}
import { hasDocumentIntent } from './DocumentIntent'
