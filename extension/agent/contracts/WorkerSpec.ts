import { z } from 'zod'
import { taskBudgetSchema, type TaskBudget } from './TaskBudget'
import {
  repositoryToolNameSchema,
  type RepositoryToolName,
} from './ToolDefinition'

/**
 * Generic worker runtime types (plan §9). Worker specs are generated dynamically
 * by the planner — there must be no `SecurityAgent.ts`, `UXAgent.ts`, etc.
 */
export type WorkerType = 'repository' | 'analysis' | 'document' | 'validation'
export type WorkerOutputSchema = 'findings' | 'document-section' | 'validation'

/** Bounded scope a worker may inspect. Refined during planning (Phase 8/9). */
export interface WorkerScope {
  roots: string[]
  /** Optional path/glob filters narrowing the scope. */
  include?: string[]
  /** Domains this worker is responsible for. */
  domains?: string[]
}

export const workerScopeSchema = z.object({
  roots: z.array(z.string()),
  include: z.array(z.string()).optional(),
  domains: z.array(z.string()).optional(),
})

export interface WorkerSpec {
  id: string
  workerType: WorkerType
  role: string
  objective: string
  scope: WorkerScope
  questions: string[]
  requiredCoverage: string[]
  allowedTools: RepositoryToolName[]
  inputFindingIds: string[]
  outputSchema: WorkerOutputSchema
  budget: TaskBudget
  /**
   * Validation-worker mode (plan §13): 'document' validates one generated
   * document against evidence; 'cross-document' compares the whole set.
   */
  validationKind?: 'document' | 'cross-document'
}

export const workerSpecSchema = z.object({
  id: z.string(),
  workerType: z.enum(['repository', 'analysis', 'document', 'validation']),
  role: z.string(),
  objective: z.string(),
  scope: workerScopeSchema,
  questions: z.array(z.string()),
  requiredCoverage: z.array(z.string()),
  allowedTools: z.array(repositoryToolNameSchema),
  inputFindingIds: z.array(z.string()),
  outputSchema: z.enum(['findings', 'document-section', 'validation']),
  budget: taskBudgetSchema,
  validationKind: z.enum(['document', 'cross-document']).optional(),
})
