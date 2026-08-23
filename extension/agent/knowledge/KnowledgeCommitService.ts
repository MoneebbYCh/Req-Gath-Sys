import type { Finding } from '../contracts/Finding'
import { FindingStore } from './FindingStore'
import { ProjectFactBase } from './ProjectFactBase'

/**
 * The sole write boundary for shared repository knowledge.
 *
 * Workers submit raw findings here. This service normalizes them through the
 * finding store and promotes eligible statements to the canonical fact base.
 * Keeping this sequence together prevents individual worker implementations
 * from diverging on dedupe, grounding, or fact-promotion rules.
 */
export class KnowledgeCommitService {
  constructor(
    readonly findings: FindingStore,
    readonly facts: ProjectFactBase,
  ) {}

  commit(inputs: Array<Omit<Finding, 'id'>>): Finding[] {
    const committed = this.findings.commit(inputs)
    for (const finding of committed) {
      // Unknowns and proposals are useful findings, but are not statements of
      // repository truth that document workers should treat as canonical.
      if (finding.type === 'observed' || finding.type === 'inferred') {
        this.facts.upsert(finding)
      }
    }
    return committed
  }
}
