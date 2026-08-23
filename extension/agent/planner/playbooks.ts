/**
 * Reusable analysis playbooks (plan §9): coverage guidance for common task
 * domains — NOT executable agent classes. The planner maps a request to one
 * or more playbooks; unknown scenarios get generic coverage generated
 * dynamically.
 */
export interface Playbook {
  id: string
  domain: string
  keywords: RegExp
  /** Coverage areas — one analysis node each, capped by the planner. */
  areas: string[]
}

export const PLAYBOOKS: Playbook[] = [
  {
    id: 'security',
    domain: 'security',
    keywords: /\b(security|vulnerab|auth|secret|credential|privacy|gdpr|pii|owasp|permission|access control)\b/i,
    areas: [
      'Authentication entry points',
      'Authorization and access control',
      'Secrets and credential handling',
      'Data protection and sensitive information',
      'Dependency and supply-chain risks',
    ],
  },
  {
    id: 'architecture',
    domain: 'architecture',
    keywords: /\b(architecture|design|structure|boundar|module|components?|codebase|system overview)\b/i,
    areas: [
      'System boundaries and modules',
      'Entry points and request flow',
      'Data flow and persistence',
      'Cross-cutting concerns and infrastructure',
    ],
  },
  {
    id: 'scalability',
    domain: 'scalability',
    keywords: /\b(scalab|scal[ai]?bil(?:i)?ty|performance|bottleneck|caching|throughput|latency|load)\b/i,
    areas: [
      'Performance-critical paths',
      'State and caching strategy',
      'Concurrency and parallelism',
      'Scaling bottlenecks',
    ],
  },
  {
    id: 'technical-debt',
    domain: 'technical-debt',
    keywords: /\b(tech(?:nical)?[ -]?debt|legacy|maintainab|code smell|anti[ -]?pattern|refactor)\b/i,
    areas: [
      'Dead code and unused paths',
      'Duplicated logic',
      'Overly complex modules',
      'Test coverage gaps',
    ],
  },
  {
    id: 'migration',
    domain: 'migration',
    keywords: /\b(migrat|upgrade|moderniz|cloud|aws|azure|gcp|rewrite)\b/i,
    areas: [
      'Current platform dependencies',
      'Migration risks and blockers',
      'Deployment and operations constraints',
    ],
  },
]
