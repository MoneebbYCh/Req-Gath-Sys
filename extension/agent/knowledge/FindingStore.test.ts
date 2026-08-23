import { describe, expect, it } from 'vitest'
import { FindingStore } from './FindingStore'
import type { Finding } from '../contracts/Finding'

function finding(overrides: Partial<Finding> = {}): Omit<Finding, 'id'> {
  return {
    claim: 'Authentication is enforced by JWT middleware.',
    type: 'observed',
    domain: 'auth',
    evidenceIds: ['ev-1'],
    confidence: 'high',
    assumptions: [],
    contradictions: [],
    repositoryVersion: 'rv-1',
    ...overrides,
  }
}

describe('FindingStore', () => {
  it('stores validated findings and queries by domain/type/evidence', () => {
    const store = new FindingStore()
    const { finding: f } = store.add(finding())
    expect(f.id).toBeTruthy()
    expect(store.byDomain('auth')).toHaveLength(1)
    expect(store.byType('observed')).toHaveLength(1)
    expect(store.byEvidence('ev-1')).toHaveLength(1)
    expect(store.byEvidence('nope')).toHaveLength(0)
  })

  it('merges equivalent claims instead of duplicating (invariant 4 commit step)', () => {
    const store = new FindingStore()
    const a = store.add(finding())
    const b = store.add(
      finding({
        claim: '  Authentication is enforced by   JWT middleware. ', // same claim, noisy whitespace/case
        evidenceIds: ['ev-2'],
        confidence: 'low',
      }),
    )
    expect(b.merged).toBe(true)
    expect(b.finding.id).toBe(a.finding.id)
    expect(store.all()).toHaveLength(1)
    // Provenance merges; the strongest type/confidence survives.
    expect(b.finding.evidenceIds).toEqual(['ev-1', 'ev-2'])
    expect(b.finding.confidence).toBe('high')
  })

  it('keeps distinct claims in the same domain separate', () => {
    const store = new FindingStore()
    store.add(finding())
    store.add(finding({ claim: 'Authentication uses session cookies.' }))
    expect(store.byDomain('auth')).toHaveLength(2)
  })

  it('flags findings needing revalidation when their evidence goes stale', () => {
    const store = new FindingStore()
    const { finding: f } = store.add(finding({ evidenceIds: ['ev-1', 'ev-2'] }))
    expect(store.needsRevalidation(f)).toBe(false)

    store.markStaleEvidence(['ev-2'])
    expect(store.needsRevalidation(f)).toBe(true)
    // The finding is preserved, not deleted (plan §7).
    expect(store.get(f.id)).toBeDefined()

    store.clearStaleEvidence(['ev-2'])
    expect(store.needsRevalidation(f)).toBe(false)
  })

  it('commit() is the batch normalization step (invariant 4): dedupes and downgrades ungrounded observed claims', () => {
    const store = new FindingStore()
    const committed = store.commit([
      finding(),
      finding({ claim: '  Authentication is enforced by   JWT middleware. ' }), // duplicate claim
      finding({ claim: 'Ungrounded observed claim.', type: 'observed', evidenceIds: [] }),
    ])
    // Duplicate merged; ungrounded observed downgraded to inferred (invariant 3).
    expect(store.all()).toHaveLength(2)
    expect(committed).toHaveLength(2)
    const merged = committed.find((f) => f.evidenceIds.length === 1)!
    expect(merged.evidenceIds).toEqual(['ev-1'])
    const downgraded = committed.find((f) => f.claim === 'Ungrounded observed claim.')!
    expect(downgraded.type).toBe('inferred')
    expect(downgraded.assumptions).toContain('No repository evidence was read for this claim.')
  })
})
