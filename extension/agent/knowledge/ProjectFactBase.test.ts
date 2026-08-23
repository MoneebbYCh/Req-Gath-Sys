import { describe, expect, it } from 'vitest'
import { ProjectFactBase } from './ProjectFactBase'
import type { Finding } from '../contracts/Finding'

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: crypto.randomUUID(),
    claim: 'Node.js',
    type: 'observed',
    domain: 'runtime',
    evidenceIds: ['ev-1'],
    confidence: 'high',
    assumptions: [],
    contradictions: [],
    repositoryVersion: 'rv-1',
    ...overrides,
  }
}

describe('ProjectFactBase', () => {
  it('promotes a finding to a canonical fact keyed by domain', () => {
    const facts = new ProjectFactBase()
    const { fact } = facts.upsert(finding())
    expect(fact.statement).toBe('Node.js')
    expect(facts.get('runtime')).toBe(fact)
    expect(facts.all()).toHaveLength(1)
  })

  it('merges provenance for the same statement', () => {
    const facts = new ProjectFactBase()
    const a = facts.upsert(finding())
    const b = facts.upsert(finding({ id: 'f-2', evidenceIds: ['ev-2'] }))
    expect(b.replaced).toBe(false)
    expect(b.fact.id).toBe(a.fact.id)
    expect(b.fact.sourceFindingIds).toEqual([a.fact.sourceFindingIds[0], 'f-2'])
    expect(b.fact.evidenceIds).toEqual(['ev-1', 'ev-2'])
    expect(facts.all()).toHaveLength(1)
  })

  it('never silently discards a conflicting statement for the same domain', () => {
    const facts = new ProjectFactBase()
    facts.upsert(finding({ factKey: 'runtime.backend' })) // "Node.js" with 1 evidence id
    const { fact, replaced, conflict } = facts.upsert(
      finding({ claim: 'Python', factKey: 'runtime.backend', evidenceIds: ['ev-a', 'ev-b'] }),
    )
    // Better-evidenced statement becomes canonical; the old one is preserved as a conflict.
    expect(replaced).toBe(true)
    expect(fact.statement).toBe('Python')
    expect(conflict?.statement).toBe('Node.js')
    expect(facts.conflictsFor('runtime').map((c) => c.statement)).toEqual(['Node.js'])
    expect(facts.get('runtime')?.statement).toBe('Python')
  })

  it('keeps the better-evidenced statement when the challenger has less evidence', () => {
    const facts = new ProjectFactBase()
    facts.upsert(finding({ factKey: 'runtime.backend', evidenceIds: ['ev-1', 'ev-2', 'ev-3'] }))
    const { fact, replaced, conflict } = facts.upsert(finding({ claim: 'Deno', factKey: 'runtime.backend', evidenceIds: ['ev-9'] }))
    expect(replaced).toBe(false)
    expect(fact.statement).toBe('Node.js')
    expect(conflict?.statement).toBe('Deno')
    expect(facts.get('runtime')?.statement).toBe('Node.js')
  })

  it('flags facts needing revalidation when their evidence goes stale', () => {
    const facts = new ProjectFactBase()
    const { fact } = facts.upsert(finding({ evidenceIds: ['ev-1'] }))
    expect(facts.needsRevalidation(fact)).toBe(false)
    facts.markStaleEvidence(['ev-1'])
    expect(facts.needsRevalidation(fact)).toBe(true)
  })
})
