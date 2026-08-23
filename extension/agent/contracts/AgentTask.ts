import { z } from 'zod'

/**
 * Durable task contract (plan §5 / §7). A task is linked to a session and owns
 * a stable `taskId` for its entire lifecycle.
 */
export type AgentTaskStatus =
  | 'created'
  | 'running'
  | 'completed'
  | 'cancelled'
  | 'paused'
  | 'failed'

export interface AgentTask {
  taskId: string
  sessionId: string
  requestId: string
  title: string
  status: AgentTaskStatus
  createdAt: number
  updatedAt: number
  surface: { page: string; activeDocumentId?: string }
  summary?: string
  error?: string
}

export const agentTaskStatusSchema = z.enum([
  'created',
  'running',
  'completed',
  'cancelled',
  'paused',
  'failed',
])

export const agentTaskSchema = z.object({
  taskId: z.string(),
  sessionId: z.string(),
  requestId: z.string(),
  title: z.string(),
  status: agentTaskStatusSchema,
  createdAt: z.number(),
  updatedAt: z.number(),
  surface: z.object({
    page: z.string(),
    activeDocumentId: z.string().optional(),
  }),
  summary: z.string().optional(),
  error: z.string().optional(),
})
