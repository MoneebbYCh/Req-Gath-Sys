import { describe, expect, it } from 'vitest'
import { Scheduler } from './Scheduler'
import { AdaptiveConcurrencyController } from '../observability/TaskControls'
import { TaskGraphStore } from '../planner/TaskGraphStore'
import type { TaskNode } from '../contracts/TaskGraph'

function node(overrides: Partial<TaskNode> = {}): TaskNode {
  return {
    id: crypto.randomUUID(),
    title: 'Analysis part',
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

function graph(nodes: TaskNode[]): TaskGraphStore {
  const store = new TaskGraphStore({ maxNodes: 20 })
  store.seed(nodes)
  return store
}

function tick(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

describe('Scheduler', () => {
  it('honors live provider-pressure concurrency limits for queued nodes', async () => {
    const active = { current: 0, max: 0 }
    const store = graph([node({ id: 'a' }), node({ id: 'b' }), node({ id: 'c' })])
    const pressure = new AdaptiveConcurrencyController(3)
    pressure.reportRateLimit(10_000)
    await new Scheduler({ limits: { analysis: 3 } }).runGraph(store, async () => {
      active.current++
      active.max = Math.max(active.max, active.current)
      await tick(5)
      active.current--
      return []
    }, { adaptiveConcurrency: pressure })
    expect(active.max).toBe(1)
  })
  it('respects per-worker-type concurrency limits', async () => {
    const active = { current: 0, max: 0 }
    const execute = async (n: TaskNode) => {
      active.current++
      active.max = Math.max(active.max, active.current)
      await tick(10)
      active.current--
      return [`out-${n.id}`]
    }
    const store = graph([node({ id: 'a', title: 'A' }), node({ id: 'b', title: 'B' }), node({ id: 'c', title: 'C' })])
    await new Scheduler({ limits: { analysis: 2 } }).runGraph(store, execute)

    expect(active.max).toBe(2) // never 3, even with three ready nodes
    expect(store.all().every((n) => n.status === 'completed')).toBe(true)
  })

  it('exposes the sum of per-type limits as the task concurrency ceiling', () => {
    expect(new Scheduler().maxConcurrency()).toBe(8) // repository 2 + analysis 2 + document 2 + validation 2
    expect(new Scheduler({ limits: { document: 1 } }).maxConcurrency()).toBe(7)
  })

  it('runs dependency chains in order', async () => {
    const order: string[] = []
    const store = graph([
      node({ id: 'a', title: 'A' }),
      node({ id: 'b', title: 'B', dependencies: ['a'] }),
      node({ id: 'c', title: 'C', dependencies: ['b'] }),
    ])
    await new Scheduler({ limits: { analysis: 1 } }).runGraph(store, async (n) => {
      order.push(n.id)
      return []
    })
    expect(order).toEqual(['a', 'b', 'c'])
    expect(store.get('c')?.status).toBe('completed')
  })

  it('honors an orchestrator-provided task parallelism budget', async () => {
    const active = { current: 0, max: 0 }
    const store = graph([node({ id: 'a' }), node({ id: 'b' })])
    await new Scheduler({ limits: { analysis: 2 } }).runGraph(store, async () => {
      active.current++
      active.max = Math.max(active.max, active.current)
      await tick(5)
      active.current--
      return []
    }, { maxParallelWorkers: 1 })
    expect(active.max).toBe(1)
  })

  it('marks a throwing node failed and still completes its siblings', async () => {
    const store = graph([
      node({ id: 'a', title: 'A' }),
      node({ id: 'b', title: 'B' }),
    ])
    await new Scheduler({ limits: { analysis: 2 } }).runGraph(store, async (n) => {
      if (n.id === 'a') throw new Error('worker crashed')
      return ['fine']
    })
    expect(store.get('a')?.status).toBe('failed')
    expect(store.errorFor('a')).toBe('worker crashed')
    expect(store.get('b')?.status).toBe('completed')
  })

  it('emits onChange after state changes and onStart before executing', async () => {
    const store = graph([node({ id: 'a', title: 'A' })])
    const changes: string[] = []
    const starts: string[] = []
    await new Scheduler().runGraph(store, async () => [], {
      onChange: () => changes.push(store.get('a')!.status),
      onStart: (n) => starts.push(n.id),
    })
    expect(starts).toEqual(['a'])
    expect(changes).toEqual(['running', 'completed'])
  })

  it('starts nothing when the signal is already aborted', async () => {
    const store = graph([node({ id: 'a', title: 'A' })])
    const controller = new AbortController()
    controller.abort()
    let ran = false
    await new Scheduler().runGraph(
      store,
      async () => {
        ran = true
        return []
      },
      { signal: controller.signal },
    )
    expect(ran).toBe(false)
    expect(store.get('a')?.status).toBe('queued')
  })
})
