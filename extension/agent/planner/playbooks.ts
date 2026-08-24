/**
 * Reusable analysis playbooks (plan §9): coverage guidance for common task
 * domains — NOT executable agent classes. The planner maps a request to one
 * or more playbooks; unknown scenarios get generic coverage generated
 * dynamically.
 *
 * `areas` are ordered highest-priority first. The planner takes only the
 * first `maxAreasPerDomain` (default 5, see Planner.ts) per matched domain,
 * so ordering — not just content — determines what actually ships in a
 * bounded analysis. Each list below is modeled on the checklist an L6+
 * reviewer at a large tech company would actually walk through for that
 * review type (OWASP ASVS / Google security design review for `security`;
 * a standard design-doc rubric for `architecture`; the AWS Well-Architected
 * "Performance Efficiency" pillar for `scalability`; a code-health audit for
 * `technical-debt`; a cloud migration runbook for `migration`; a standard
 * PRD template — Overview, Goals, Users, Functional/Non-functional
 * requirements, Success metrics, Scope, Risks — for `prd`) — trimmed to
 * areas a static repository analysis can actually substantiate with
 * evidence, not aspirational process items (e.g. "run a pentest") that no
 * amount of code reading can satisfy.
 */
export interface Playbook {
  id: string
  domain: string
  keywords: RegExp
  /** Coverage areas — one analysis node each, capped by the planner. Ordered highest-priority first. */
  areas: string[]
}

export const PLAYBOOKS: Playbook[] = [
  {
    id: 'security',
    domain: 'security',
    keywords: /\b(security|vulnerab|auth|secret|credential|privacy|gdpr|hipaa|pii|owasp|permission|access control|encrypt)\b/i,
    areas: [
      'Authentication mechanisms and entry points',
      'Authorization and access control model',
      'Secrets and credential handling',
      'Input validation and injection risk',
      'Data protection: encryption at rest and in transit',
      'Sensitive data and PII handling',
      'Dependency and supply-chain risk',
      'Session management and token lifecycle',
      'Security logging, auditing, and alerting',
      'Error handling and information disclosure',
      'Rate limiting and abuse prevention',
      'Third-party integration and external API trust boundaries',
    ],
  },
  {
    id: 'architecture',
    domain: 'architecture',
    keywords: /\b(architecture|design|structure|boundar|module|components?|codebase|system overview)\b/i,
    areas: [
      'System boundaries and module decomposition',
      'Entry points and request/response flow',
      'Data flow and persistence model',
      'API contracts and integration boundaries',
      'Cross-cutting concerns (config, logging, auth wiring)',
      'Infrastructure and deployment topology',
      'Coupling and dependency direction between modules',
      'Failure domains and fault isolation',
    ],
  },
  {
    id: 'scalability',
    domain: 'scalability',
    keywords: /\b(scalab|scal[ai]?bil(?:i)?ty|performance|bottleneck|caching|throughput|latency|load|p9[059]|sla)\b/i,
    areas: [
      'Performance-critical paths and hot code',
      'State management and caching strategy',
      'Concurrency and parallelism model',
      'Database and storage scaling bottlenecks',
      'Horizontal scaling and statelessness',
      'Load balancing and traffic distribution',
      'Resource limits, backpressure, and graceful degradation',
      'Latency and throughput budgets',
    ],
  },
  {
    id: 'technical-debt',
    domain: 'technical-debt',
    keywords: /\b(tech(?:nical)?[ -]?debt|legacy|maintainab|code smell|anti[ -]?pattern|refactor)\b/i,
    areas: [
      'Dead code and unused paths',
      'Duplicated logic and copy-paste patterns',
      'Overly complex or oversized modules',
      'Test coverage gaps',
      'Inconsistent patterns and architectural drift',
      'Outdated dependencies and deprecated APIs',
      'Error handling and exception hygiene',
      'Documentation gaps and undocumented behavior',
    ],
  },
  {
    id: 'migration',
    domain: 'migration',
    keywords: /\b(migrat|upgrade|moderniz|cloud|aws|azure|gcp|rewrite)\b/i,
    areas: [
      'Current platform dependencies and constraints',
      'Migration risks and blockers',
      'Deployment and operations constraints',
      'Data migration and consistency strategy',
      'Rollback and cutover strategy',
      'Compatibility and API surface changes',
      'Cost and licensing implications',
      'Timeline phasing and dependency ordering',
    ],
  },
  {
    id: 'prd',
    domain: 'prd',
    keywords: /\b(prd|product requirements?|product spec(?:ification)?|feature spec(?:ification)?|user stor(?:y|ies))\b/i,
    areas: [
      'Functional requirements and user-facing behavior inferred from the implementation',
      'Non-functional requirements and constraints (performance, security, compliance)',
      'Target users, personas, and primary use cases',
      'Success metrics and instrumentation/analytics present in the code',
      'Scope boundaries: in-scope vs. out-of-scope functionality',
      'Dependencies and integration points',
      'Assumptions, edge cases, and open questions',
      'Rollout surface: feature flags, configuration, and environment gating',
    ],
  },
]