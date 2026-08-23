import {
  claimKey,
  dedupeFindings,
  findingSchema,
  isGrounded,
  type Confidence,
  type Finding,
  type FindingType,
} from '../contracts/Finding'

/**
 * Finding store (plan §7): the commit step where workers' findings are
 * normalized. Workers never write shared state directly — findings pass
 * through here, where equivalent claims (same domain + normalized claim)
 * merge instead of multiplying. In-memory; durability lands with Phase 14.
 */
const TYPE_STRENGTH: Record<FindingType, number> = { unknown: 0, proposed: 1, inferred: 2, observed: 3 }
const CONF_STRENGTH: Record<Confidence, number> = { low: 0, medium: 1, high: 2 }

export class FindingStore {
  private readonly findings = new Map<string, Finding>()
  private readonly staleEvidence = new Set<string>()

  /** Add a finding; an equivalent claim merges instead of duplicating. */
  add(input: Omit<Finding, 'id'>): { finding: Finding; merged: boolean } {
    const key = `${input.domain}::${claimKey(input.claim)}`
    // ponytail: O(n) scan — fine until finding counts get large; a key index arrives with Phase 15.
    const existing = [...this.findings.values()].find(
      (f) => `${f.domain}::${claimKey(f.claim)}` === key,
    )
    if (existing) {
      const merged = findingSchema.parse({
        ...existing,
        type: TYPE_STRENGTH[input.type] > TYPE_STRENGTH[existing.type] ? input.type : existing.type,
        confidence:
          CONF_STRENGTH[input.confidence] > CONF_STRENGTH[existing.confidence]
            ? input.confidence
            : existing.confidence,
        evidenceIds: [...new Set([...existing.evidenceIds, ...input.evidenceIds])],
        assumptions: [...new Set([...existing.assumptions, ...input.assumptions])],
        contradictions: [...new Set([...existing.contradictions, ...input.contradictions])],
      })
      this.findings.set(merged.id, merged)
      return { finding: merged, merged: true }
    }
    const finding = findingSchema.parse({ ...input, id: crypto.randomUUID() })
    this.findings.set(finding.id, finding)
    return { finding, merged: false }
  }

  /**
   * Invariant 4 (plan §0/§7): the normalization/commit step. Workers hand
   * their RAW findings here; the store dedupes equivalent claims and enforces
   * grounding — an `observed` claim without evidence is downgraded to
   * `inferred` (invariant 3), never stored as unsupported fact. Workers never
   * mutate shared state field-by-field.
   */
  commit(inputs: Array<Omit<Finding, 'id'>>): Finding[] {
    const normalized = inputs.map((input) => {
      if (input.type !== 'observed' || input.evidenceIds.length > 0) return input
      return {
        ...input,
        type: 'inferred' as const,
        assumptions: [...new Set([...(input.assumptions ?? []), 'No repository evidence was read for this claim.'])],
      }
    })
    const committed: Finding[] = []
    for (const input of dedupeFindings(
      normalized.map((i) => findingSchema.parse({ ...i, id: `pending:${crypto.randomUUID()}` })),
    )) {
      const { finding } = this.add(input)
      if (isGrounded(finding)) committed.push(finding)
    }
    return committed
  }

  get(id: string): Finding | undefined {
    return this.findings.get(id)
  }

  all(): Finding[] {
    return [...this.findings.values()]
  }

  /** Plan §14: rehydrate durable findings after a restart. */
  restore(findings: Finding[]): void {
    for (const f of findings) {
      this.findings.set(f.id, findingSchema.parse(f))
    }
  }

  byDomain(domain: string): Finding[] {
    return [...this.findings.values()].filter((f) => f.domain === domain)
  }

  byType(type: FindingType): Finding[] {
    return [...this.findings.values()].filter((f) => f.type === type)
  }

  /** Findings that cite the given evidence. */
  byEvidence(evidenceId: string): Finding[] {
    return [...this.findings.values()].filter((f) => f.evidenceIds.includes(evidenceId))
  }

  /** Stale evidence invalidates dependent findings without deleting them (plan §7). */
  markStaleEvidence(evidenceIds: string[]): void {
    for (const id of evidenceIds) this.staleEvidence.add(id)
  }

  needsRevalidation(finding: Finding): boolean {
    return finding.evidenceIds.some((id) => this.staleEvidence.has(id))
  }

  clearStaleEvidence(evidenceIds: string[]): void {
    for (const id of evidenceIds) this.staleEvidence.delete(id)
  }
}
