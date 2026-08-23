import {
  taskNodeSchema,
  validateTaskGraph,
  readyNodes,
  type TaskNode,
  type TaskNodeStatus,
} from '../contracts/TaskGraph'
import type { PlanNodeView, PlanView } from '../../../shared/agentProtocol'

/**
 * Durable task-graph store (plan §8). The graph is validated acyclic before
 * anything may be scheduled (acceptance §8), bounded by maxNodes, and replanning
 * has a bounded budget. Stalled replans — rounds that add nothing new — are
 * detected so the orchestrator can terminate instead of looping forever.
 * In-memory for now; persistence lands with Phase 14.
 */

export interface TaskGraphStoreOptions {
  maxNodes?: number
  maxReplans?: number
}

const DEFAULT_MAX_NODES = 20
const DEFAULT_MAX_REPLANS = 3

export interface ReplanResult {
  added: string[]
  /** Nodes skipped because they duplicate an existing objective. */
  duplicates: TaskNode[]
  /** True when this replan added nothing — a stall signal for the orchestrator. */
  stalled: boolean
}

export class TaskGraphStore {
  private readonly nodes = new Map<string, TaskNode>()
  private readonly errors = new Map<string, string>()
  private readonly maxNodes: number
  private readonly maxReplans: number
  private replansUsed = 0

  constructor(options: TaskGraphStoreOptions = {}) {
    this.maxNodes = options.maxNodes ?? DEFAULT_MAX_NODES
    this.maxReplans = options.maxReplans ?? DEFAULT_MAX_REPLANS
  }

  /** Seed the initial graph — throws on cycles, missing deps, or oversize. */
  seed(nodes: TaskNode[]): void {
    if (nodes.length > this.maxNodes) {
      throw new Error(`Plan exceeds the node limit (${nodes.length} > ${this.maxNodes}).`)
    }
    const validated = nodes.map((n) => taskNodeSchema.parse(n))
    validateTaskGraph(validated)
    for (const n of validated) this.nodes.set(n.id, n)
  }

  get(id: string): TaskNode | undefined {
    return this.nodes.get(id)
  }

  all(): TaskNode[] {
    return [...this.nodes.values()]
  }

  errorFor(id: string): string | undefined {
    return this.errors.get(id)
  }

  remainingReplans(): number {
    return Math.max(0, this.maxReplans - this.replansUsed)
  }

  /**
   * Replanning (plan §8): add follow-up nodes discovered while executing —
   * bounded by the replan budget and the node cap. Duplicate objectives
   * (same normalized title) are skipped; a round that adds nothing is a stall.
   */
  replan(candidates: TaskNode[]): ReplanResult {
    // Budget exhausted: a replan that can add nothing is a stall signal.
    if (this.replansUsed >= this.maxReplans) {
      return { added: [], duplicates: candidates, stalled: true }
    }

    const added: string[] = []
    const duplicates: TaskNode[] = []

    for (const candidate of candidates) {
      const existing = [...this.nodes.values()].some(
        (n) => n.title.trim().toLowerCase() === candidate.title.trim().toLowerCase(),
      )
      if (existing) {
        duplicates.push(candidate)
        continue
      }
      if (this.nodes.size + added.length >= this.maxNodes) break
      const node = taskNodeSchema.parse({ ...candidate, status: 'queued', attempts: 0 })
      // Follow-ups may depend on existing nodes; validate incrementally.
      validateTaskGraph([...this.nodes.values(), node])
      this.nodes.set(node.id, node)
      added.push(node.id)
    }

    if (added.length > 0) this.replansUsed++
    return { added, duplicates, stalled: added.length === 0 && duplicates.length === 0 }
  }

  /** Ids ready to execute: non-terminal with all dependencies completed. */
  readyIds(): string[] {
    return readyNodes([...this.nodes.values()])
  }

  /** Topological execution order (sequential for now; Phase 9 adds a scheduler). */
  executionOrder(): string[] {
    const order: string[] = []
    const visited = new Set<string>()
    const visit = (id: string): void => {
      if (visited.has(id)) return
      visited.add(id)
      const node = this.nodes.get(id)
      if (!node) return
      for (const dep of node.dependencies) visit(dep)
      order.push(id)
    }
    for (const id of this.nodes.keys()) visit(id)
    return order
  }

  markRunning(id: string): void {
    this.transition(id, 'running')
  }

  complete(id: string, outputs: string[]): void {
    const node = this.nodes.get(id)
    // ponytail: blocked nodes were deliberately skipped by loop detection —
    // never re-complete them.
    if (!node || node.status === 'blocked') return
    node.status = 'completed'
    node.outputs = outputs.slice(0, 20)
  }

  /** Skips a node without failing it (plan §14 loop detection) — not an error. */
  block(id: string, reason: string): void {
    const node = this.nodes.get(id)
    if (!node || (node.status !== 'queued' && node.status !== 'running')) return
    node.status = 'blocked'
    this.errors.set(id, reason)
  }

  /** Marks the node failed and its (transitive) dependents blocked (US-8.3). */
  fail(id: string, error: string): void {
    const node = this.nodes.get(id)
    if (!node) return
    node.status = 'failed'
    this.errors.set(id, error)
    const dependents = new Set<string>()
    const collect = (failedId: string): void => {
      for (const n of this.nodes.values()) {
        if (n.dependencies.includes(failedId) && !dependents.has(n.id)) {
          dependents.add(n.id)
          collect(n.id)
        }
      }
    }
    collect(id)
    for (const depId of dependents) {
      const n = this.nodes.get(depId)
      if (n && (n.status === 'queued' || n.status === 'blocked')) {
        n.status = 'blocked'
        this.errors.set(depId, `Blocked: dependency "${id}" failed.`)
      }
    }
  }

  cancelAll(): void {
    for (const n of this.nodes.values()) {
      if (n.status === 'queued' || n.status === 'blocked' || n.status === 'running') {
        n.status = 'cancelled'
      }
    }
  }

  /** UI-facing plan view (plan §8): titles + statuses, never reasoning. */
  toPlanView(): PlanView {
    const order = this.executionOrder()
    return {
      nodes: order
        .map((id) => this.nodes.get(id))
        .filter((n): n is TaskNode => Boolean(n))
        .map((n): PlanNodeView => ({ id: n.id, title: n.title, status: n.status as PlanNodeView['status'] })),
    }
  }

  private transition(id: string, status: TaskNodeStatus): void {
    const node = this.nodes.get(id)
    if (!node) return
    if (node.status === 'queued' && status === 'running') {
      node.status = status
      node.attempts++
    }
  }
}
