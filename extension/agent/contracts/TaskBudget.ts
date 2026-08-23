import { z } from 'zod'

/**
 * Task-level resource limits (plan §16). Enforced by the scheduler so a single
 * worker cannot consume the whole task budget.
 */
export interface TaskBudget {
  maxModelCalls: number
  maxToolCalls: number
  maxInputTokens: number
  maxOutputTokens: number
  maxParallelWorkers: number
  maxReplans: number
}

export const taskBudgetSchema = z.object({
  maxModelCalls: z.number().int().nonnegative(),
  maxToolCalls: z.number().int().nonnegative(),
  maxInputTokens: z.number().int().nonnegative(),
  maxOutputTokens: z.number().int().nonnegative(),
  maxParallelWorkers: z.number().int().nonnegative(),
  maxReplans: z.number().int().nonnegative(),
})
