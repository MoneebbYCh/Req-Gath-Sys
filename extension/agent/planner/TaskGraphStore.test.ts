import { describe, expect, it } from 'vitest'
import { TaskGraphStore } from './TaskGraphStore'
import type { TaskNode } from '../contracts/TaskGraph'

function node(overrides: Partial<TaskNode> = {}): TaskNode {
  return {
    id: crypto.randomUUID(),
    title: 'Some analysis',
    objective: 'Analyze something',
    dependencies: [],
    roleSpec: {
      id: 'ws-1',
      workerType: 'analysis',
      role: 'Analyst',
      objective: 'Analyze',
      scope: { roots: ['*'] },
      questions: [],
      requiredCoverage: [],
      allowedTools: ['search_code'],
      inputFindingIds: [],
      outputSchema: 'findings',
      budget: {
        maxModelCalls: 4,
        maxToolCalls: 10,
        maxInputTokens: 10_000,
        maxOutputTokens: 4_000,
        maxParallelWorkers: 1,
        maxReplans: 1,
      },
    },
    requiredCoverage: [],
    requiredEvidence: [],
    status: 'queued',
    attempts: 0,
    budget: {
      maxModelCalls: 4,
      maxToolCalls: 10,
      maxInputTokens: 10_000,
      maxOutputTokens: 4_000,
      maxParallelWorkers: 1,
      maxReplans: 1,
    },
    outputs: [],
    ...overrides,
  }
}

describe('TaskGraphStore', () => {
  it('rejects cyclic or oversize seeds', () => {
    const a = node({ id: 'a', title: 'A' })
    const b = node({ id: 'b', title: 'B', dependencies: ['a'] })
    const cyclic = node({ id: 'a', title: 'A', dependencies: ['b'] })
    expect(() => new TaskGraphStore().seed([cyclic, b])).toThrow(/cycle/)
    expect(() => new TaskGraphStore({ maxNodes: 1 }).seed([a, b])).toThrow(/limit/)
  })

  it('gates ready nodes on completed dependencies (invariant 9)', () => {
    const store = new TaskGraphStore()
    const a = node({ id: 'a', title: 'A' })
    const b = node({ id: 'b', title: 'B', dependencies: ['a'] })
    store.seed([a, b])
    expect(store.readyIds()).toEqual(['a'])
    store.complete('a', ['out-a'])
    expect(store.readyIds()).toEqual(['b'])
  })

  it('streams a topological plan view', () => {
    const store = new TaskGraphStore()
    const a = node({ id: 'a', title: 'First' })
    const b = node({ id: 'b', title: 'Second', dependencies: ['a'] })
    store.seed([b, a]) // seeded out of order
    expect(store.toPlanView().nodes.map((n) => n.title)).toEqual(['First', 'Second'])
  })

  it('fails a node and blocks its transitive dependents (US-8.3)', () => {
    const store = new TaskGraphStore()
    const a = node({ id: 'a', title: 'A' })
    const b = node({ id: 'b', title: 'B', dependencies: ['a'] })
    const c = node({ id: 'c', title: 'C', dependencies: ['b'] })
    store.seed([a, b, c])
    store.fail('a', 'boom')
    expect(store.get('a')?.status).toBe('failed')
    expect(store.get('b')?.status).toBe('blocked')
    expect(store.get('c')?.status).toBe('blocked')
    expect(store.errorFor('a')).toBe('boom')
  })

  it('replans with a bounded budget, skips duplicates, and detects stalls', () => {
    const store = new TaskGraphStore({ maxNodes: 10, maxReplans: 2 })
    store.seed([node({ id: 'n1', title: 'Original' })])

    // First replan adds a fresh node and consumes budget.
    const first = store.replan([node({ id: 'n2', title: 'Follow-up 1' })])
    expect(first.added).toEqual(['n2'])
    expect(first.stalled).toBe(false)
    expect(store.remainingReplans()).toBe(1)

    // Duplicate objective is skipped, not added.
    const second = store.replan([node({ id: 'n3', title: 'follow-up 1' })])
    expect(second.added).toEqual([])
    expect(second.duplicates).toHaveLength(1)
    expect(second.stalled).toBe(false)

    // A round with no candidates at all is a stall signal.
    const third = store.replan([])
    expect(third.stalled).toBe(true)
  })

  it('enforces the replan budget', () => {
    const store = new TaskGraphStore({ maxNodes: 10, maxReplans: 1 })
    store.seed([node({ id: 'n1', title: 'Original' })])
    expect(store.remainingReplans()).toBe(1)
    store.replan([node({ id: 'n2', title: 'Follow-up' })])
    expect(store.remainingReplans()).toBe(0)
    // Budget exhausted — nothing further is added even with valid candidates.
    const again = store.replan([node({ id: 'n3', title: 'Follow-up 2' })])
    expect(again.added).toEqual([])
  })

  it('cancelAll marks non-terminal nodes cancelled and spares completed ones', () => {
    const store = new TaskGraphStore()
    const a = node({ id: 'a', title: 'A' })
    const b = node({ id: 'b', title: 'B', dependencies: ['a'] })
    store.seed([a, b])
    store.complete('a', [])
    store.cancelAll()
    expect(store.get('a')?.status).toBe('completed')
    expect(store.get('b')?.status).toBe('cancelled')
  })
})
