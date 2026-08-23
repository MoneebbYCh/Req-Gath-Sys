import { z } from 'zod'
import { taskBudgetSchema, type TaskBudget } from './TaskBudget'
import { workerSpecSchema, type WorkerSpec } from './WorkerSpec'

/**
 * Durable task-graph node contract (plan §5 / §8). A node's dependencies must be
 * durably completed before the node may be scheduled (invariant 9).
 */
export type TaskNodeStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'blocked'
  | 'cancelled'

export interface TaskNode {
  id: string
  title: string
  objective: string
  dependencies: string[]
  roleSpec: WorkerSpec
  requiredCoverage: string[]
  requiredEvidence: string[]
  status: TaskNodeStatus
  attempts: number
  budget: TaskBudget
  outputs: string[]
  /**
   * Document-regeneration nodes (plan §13): the document to fix and the exact
   * section headings to regenerate — the affected sections only, never the
   * whole document. Absent on analysis/validation/initial document nodes.
   */
  documentId?: string
  regenerateSections?: string[]
}

export const taskNodeStatusSchema = z.enum([
  'queued',
  'running',
  'completed',
  'failed',
  'blocked',
  'cancelled',
])

export const taskNodeSchema = z.object({
  id: z.string(),
  title: z.string(),
  objective: z.string(),
  dependencies: z.array(z.string()),
  roleSpec: workerSpecSchema,
  requiredCoverage: z.array(z.string()),
  requiredEvidence: z.array(z.string()),
  status: taskNodeStatusSchema,
  attempts: z.number().int().nonnegative(),
  budget: taskBudgetSchema,
  outputs: z.array(z.string()),
  documentId: z.string().optional(),
  regenerateSections: z.array(z.string().max(300)).max(12).optional(),
})

/** True when the graph has no dependency cycle. */
export function isAcyclic(nodes: TaskNode[]): boolean {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const visiting = new Set<string>()
  const visited = new Set<string>()

  const visit = (id: string): boolean => {
    if (visited.has(id)) return true
    if (visiting.has(id)) return false
    visiting.add(id)
    const node = byId.get(id)
    if (node) {
      for (const dep of node.dependencies) {
        if (byId.has(dep) && !visit(dep)) return false
      }
    }
    visiting.delete(id)
    visited.add(id)
    return true
  }

  for (const n of nodes) {
    if (!visit(n.id)) return false
  }
  return true
}

/** Throws if the graph references missing nodes or contains a cycle. */
export function validateTaskGraph(nodes: TaskNode[]): void {
  const ids = new Set(nodes.map((n) => n.id))
  for (const n of nodes) {
    for (const dep of n.dependencies) {
      if (!ids.has(dep)) {
        throw new Error(`Node "${n.id}" references missing dependency "${dep}"`)
      }
    }
  }
  if (!isAcyclic(nodes)) throw new Error('Task graph contains a cycle')
}

/** Ids of non-terminal nodes whose dependencies are all `completed`. */
export function readyNodes(nodes: TaskNode[]): string[] {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  return nodes
    .filter((n) => n.status === 'queued' || n.status === 'blocked')
    .filter((n) => n.dependencies.every((d) => byId.get(d)?.status === 'completed'))
    .map((n) => n.id)
}
