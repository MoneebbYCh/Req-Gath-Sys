import type { TaskGraphStore } from '../planner/TaskGraphStore'
import type { TaskNode } from '../contracts/TaskGraph'
import type { WorkerType } from '../contracts/WorkerSpec'
import type { AdaptiveConcurrencyController } from '../observability/TaskControls'

/**
 * Worker scheduler semaphore (plan §9): executes ready graph nodes respecting
 * per-worker-type concurrency limits — runtime limits, not limits on logical
 * tasks. Ten queued document nodes may exist while only two model calls run.
 * Node failure marks the node failed and its dependents blocked via the store.
 */

export interface SchedulerOptions {
  /** Per-worker-type concurrency limits (analysis 2–3, document 2–3, validation 2). */
  limits?: Partial<Record<WorkerType, number>>
}

export interface RunGraphOptions {
  signal?: AbortSignal
  /** Emitted after every node state change. */
  onChange?: () => void
  /** Emitted right before a node starts executing. */
  onStart?: (node: TaskNode) => void
  /** Task-level cap supplied by the orchestrator. */
  maxParallelWorkers?: number
  /** Phase 16: provider-wide rate-limit pressure can reduce queued starts. */
  adaptiveConcurrency?: AdaptiveConcurrencyController
  onConcurrencyChange?: (current: number) => void
}

const DEFAULT_LIMITS: Record<WorkerType, number> = {
  repository: 2,
  analysis: 2,
  document: 2,
  validation: 2,
}

export class Scheduler {
  private readonly limits: Record<WorkerType, number>
  private readonly counts = new Map<WorkerType, number>()

  constructor(options: SchedulerOptions = {}) {
    this.limits = { ...DEFAULT_LIMITS, ...options.limits }
  }

  /**
   * Total concurrent nodes allowed across all worker types — the sum of the
   * per-type limits. This is the authoritative task-level concurrency ceiling;
   * orchestrators should use it instead of deriving a cap from per-node
   * budgets (a node's `maxParallelWorkers` describes its own internal model
   * concurrency, not a whole-graph cap).
   */
  maxConcurrency(): number {
    return Object.values(this.limits).reduce((sum, limit) => sum + limit, 0)
  }

  /**
   * Runs every runnable node until no ready nodes remain. `execute` returns
   * the node's outputs; a throw marks the node failed. Starts no new work once
   * `signal` aborts (in-flight workers observe the abort themselves).
   */
  async runGraph(
    graph: TaskGraphStore,
    execute: (node: TaskNode) => Promise<string[]>,
    options: RunGraphOptions = {},
  ): Promise<void> {
    const { signal, onChange, onStart } = options
    const inflight = new Set<Promise<void>>()

    const pump = (): void => {
      if (signal?.aborted) return
      for (const id of graph.readyIds()) {
        if (signal?.aborted) return
        const node = graph.get(id)
        if (!node || node.status !== 'queued') continue
        const adaptiveLimit = options.adaptiveConcurrency?.limit()
        const taskLimit = Math.min(options.maxParallelWorkers ?? Number.POSITIVE_INFINITY, adaptiveLimit ?? Number.POSITIVE_INFINITY)
        if (inflight.size >= taskLimit) return
        const type = node.roleSpec.workerType
        if ((this.counts.get(type) ?? 0) >= (this.limits[type] ?? 1)) continue

        this.counts.set(type, (this.counts.get(type) ?? 0) + 1)
        if (adaptiveLimit !== undefined) options.onConcurrencyChange?.(adaptiveLimit)
        graph.markRunning(id)
        onChange?.()
        onStart?.(node)

        const p = execute(node)
          .then((outputs) => graph.complete(id, outputs))
          .catch((err) => graph.fail(id, err instanceof Error ? err.message : String(err)))
          .finally(() => {
            this.counts.set(type, (this.counts.get(type) ?? 1) - 1)
            inflight.delete(p)
            onChange?.()
            pump() // newly freed dependency slots may unlock more nodes
          })
        inflight.add(p)
      }
    }

    pump()
    while (inflight.size > 0) {
      await Promise.race([...inflight])
    }
  }
}
