import {
  claimKey,
  projectFactSchema,
  type Finding,
  type ProjectFact,
} from '../contracts/Finding'

/**
 * Canonical project fact base (plan §7): one accepted statement per semantic
 * fact key (e.g. "runtime.backend"), reused across tasks and documents so ten
 * document workers never build ten divergent models of the repository.
 *
 * Conflicting statements for the same domain are never silently discarded —
 * the better-evidenced one becomes canonical and the displaced statement is
 * kept in the domain's conflict list. In-memory; durability lands Phase 14.
 */
export class ProjectFactBase {
  private readonly facts = new Map<string, ProjectFact>()
  private readonly conflicts = new Map<string, ProjectFact[]>()
  private readonly staleEvidence = new Set<string>()

  /**
   * Promote a finding to a canonical fact. Same statement → merge provenance;
   * different statement → the one with more evidence wins, the loser is
   * recorded as a conflict.
   */
  upsert(finding: Finding): { fact: ProjectFact; replaced: boolean; conflict?: ProjectFact } {
    const domain = finding.domain.toLowerCase().trim()
    const key = factKey(finding, domain)
    const existing = this.facts.get(key)

    if (!existing) {
      const fact = this.toFact(key, domain, finding)
      this.facts.set(key, fact)
      return { fact, replaced: false }
    }

    const sameStatement = claimKey(existing.statement) === claimKey(finding.claim)
    if (sameStatement) {
      const fact = projectFactSchema.parse({
        ...existing,
        sourceFindingIds: [...new Set([...existing.sourceFindingIds, finding.id])],
        evidenceIds: [...new Set([...existing.evidenceIds, ...finding.evidenceIds])],
        updatedAt: Date.now(),
      })
      this.facts.set(key, fact)
      return { fact, replaced: false }
    }

    const incomingWins = finding.evidenceIds.length > existing.evidenceIds.length
    const displaced: ProjectFact = {
      ...(incomingWins ? existing : this.toFact(key, domain, finding)),
      updatedAt: Date.now(),
    }
    this.conflicts.set(key, [...(this.conflicts.get(key) ?? []), displaced])
    if (!incomingWins) return { fact: existing, replaced: false, conflict: displaced }

    const fact = this.toFact(key, domain, finding)
    this.facts.set(key, fact)
    return { fact, replaced: true, conflict: displaced }
  }

  get(domain: string): ProjectFact | undefined {
    const normalized = domain.toLowerCase().trim()
    const direct = this.facts.get(normalized)
    if (direct) return direct
    // Compatibility for domain lookups while callers migrate to fact keys.
    const inDomain = this.byDomain(normalized)
    return inDomain.length === 1 ? inDomain[0] : undefined
  }

  all(): ProjectFact[] {
    return [...this.facts.values()]
  }

  byDomain(domain: string): ProjectFact[] {
    const normalized = domain.toLowerCase().trim()
    return [...this.facts.values()].filter((fact) => fact.domain === normalized)
  }

  /** Plan §14: rehydrate durable canonical facts after a restart. */
  restore(facts: ProjectFact[]): void {
    for (const f of facts) {
      this.facts.set(f.key, projectFactSchema.parse(f))
    }
  }

  conflictsFor(domain: string): ProjectFact[] {
    const normalized = domain.toLowerCase().trim()
    const direct = this.conflicts.get(normalized)
    if (direct) return direct
    return [...this.conflicts.entries()]
      .filter(([key]) => key.startsWith(`${normalized}.`))
      .flatMap(([, conflicts]) => conflicts)
  }

  /** Stale evidence invalidates dependent facts without deleting them (plan §7). */
  markStaleEvidence(evidenceIds: string[]): void {
    for (const id of evidenceIds) this.staleEvidence.add(id)
  }

  needsRevalidation(fact: ProjectFact): boolean {
    return fact.evidenceIds.some((id) => this.staleEvidence.has(id))
  }

  private toFact(key: string, domain: string, finding: Finding): ProjectFact {
    return projectFactSchema.parse({
      id: crypto.randomUUID(),
      key,
      statement: finding.claim,
      domain,
      sourceFindingIds: [finding.id],
      evidenceIds: finding.evidenceIds,
      confidence: finding.confidence,
      repositoryVersion: finding.repositoryVersion,
      updatedAt: Date.now(),
    })
  }
}

function factKey(finding: Finding, domain: string): string {
  if (finding.factKey) return finding.factKey.toLowerCase().trim()
  // A claim-level fallback preserves distinct facts even when a model does not
  // provide an explicit semantic key. It is deterministic, so later matching
  // claims still converge.
  return `${domain}.${claimKey(finding.claim)}`
}
