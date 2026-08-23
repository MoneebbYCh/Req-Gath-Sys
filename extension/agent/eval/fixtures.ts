/**
 * Evaluation fixtures (plan §5). Contract-level only — they define repeatable
 * question sets and the metrics to track, but are NOT executed yet: repository
 * retrieval requires the Phase 4/5 tools, and multi-document runs require the
 * Phase 12 scheduler. Execution harnesses land with those phases.
 */

export type EvalMetricId =
  | 'recallAtK'
  | 'unsupportedClaimRate'
  | 'evidencePrecision'
  | 'repeatedReadRate'
  | 'taskCompletionRate'
  | 'firstFeedbackLatency'
  | 'firstTokenLatency'
  | 'totalTaskLatency'
  | 'tokenUsage'

export interface EvalQuestion {
  id: string
  text: string
  /** Paths/symbols a correct retrieval must surface. */
  expectedEvidence: string[]
  /** Analysis domains a correct answer must cover. */
  expectedDomains: string[]
}

export interface EvalFixture {
  id: string
  label: string
  questions: EvalQuestion[]
  metrics: EvalMetricId[]
}

/** Metrics tracked per plan §5. */
export const EVAL_METRICS: readonly EvalMetricId[] = [
  'recallAtK',
  'unsupportedClaimRate',
  'evidencePrecision',
  'repeatedReadRate',
  'taskCompletionRate',
  'firstFeedbackLatency',
  'firstTokenLatency',
  'totalTaskLatency',
  'tokenUsage',
]

/** Simple retrieval: grounded answers to pointed repository questions. */
export const simpleRetrievalFixture: EvalFixture = {
  id: 'simple-retrieval',
  label: 'Simple repository retrieval',
  metrics: [
    'recallAtK',
    'unsupportedClaimRate',
    'evidencePrecision',
    'firstFeedbackLatency',
    'firstTokenLatency',
  ],
  questions: [
    {
      id: 'q-auth',
      text: 'Where is authentication enforced?',
      expectedEvidence: ['src/auth*', 'middleware*'],
      expectedDomains: ['auth'],
    },
    {
      id: 'q-registration',
      text: 'Trace user registration from route to persistence.',
      expectedEvidence: ['register', 'users', 'repository'],
      expectedDomains: ['auth', 'storage'],
    },
    {
      id: 'q-billing',
      text: 'What consumes the billing service?',
      expectedEvidence: ['billing', 'invoice'],
      expectedDomains: ['billing'],
    },
    {
      id: 'q-caching',
      text: 'Which modules are responsible for caching?',
      expectedEvidence: ['cache', 'redis'],
      expectedDomains: ['caching'],
    },
  ],
}

/** Multi-document: three documents must agree on shared project facts. */
export const multiDocumentFixture: EvalFixture = {
  id: 'multi-document',
  label: 'Three-document shared-fact consistency',
  metrics: ['taskCompletionRate', 'unsupportedClaimRate', 'evidencePrecision', 'totalTaskLatency', 'tokenUsage'],
  questions: [
    {
      id: 'q-three-docs',
      text: 'Generate a PRD, an architecture doc, and a security doc for this repository.',
      expectedEvidence: [],
      expectedDomains: ['product', 'architecture', 'security'],
    },
  ],
}
