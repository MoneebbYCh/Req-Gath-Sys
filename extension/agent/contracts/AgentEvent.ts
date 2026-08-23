import { z } from 'zod'

/**
 * Runtime validation for the streaming event protocol (plan §5/§6, invariant:
 * every event belongs to a task and carries a monotonically increasing `seq`).
 * The shared webview↔extension types live in `shared/agentProtocol.ts`; this
 * module is the extension-side zod authority for events crossing the
 * worker↔host↔webview boundaries.
 */

export const agentEventBaseSchema = z.object({
  type: z.string(),
  taskId: z.string(),
  seq: z.number().int().nonnegative(),
  timestamp: z.number(),
})

export const planNodeStatusSchema = z.enum([
  'queued',
  'running',
  'completed',
  'failed',
  'blocked',
  'cancelled',
])

export const planViewSchema = z.object({
  nodes: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      status: planNodeStatusSchema,
    }),
  ),
})

export const documentGenerationStatusSchema = z.enum([
  'queued',
  'outlining',
  'generating',
  'validating',
  'completed',
  'failed',
])

export const documentProgressStateSchema = z.object({
  documentId: z.string(),
  title: z.string(),
  status: documentGenerationStatusSchema,
  completedSections: z.number().int().nonnegative(),
  totalSections: z.number().int().nonnegative(),
  activeSection: z.string().optional(),
  error: z.string().optional(),
})

export const agentSessionSnapshotSchema = z.object({
  taskId: z.string().nullable(),
  status: z.enum(['running', 'interrupted', 'completed', 'failed', 'cancelled', 'idle']),
  title: z.string(),
  activities: z.array(z.string()),
  assistantText: z.string(),
  plan: planViewSchema.optional(),
  documents: z.array(documentProgressStateSchema).optional(),
  summary: z.string().optional(),
  error: z.string().optional(),
})

export const agentTaskStartedSchema = agentEventBaseSchema.extend({
  type: z.literal('agentTaskStarted'),
  title: z.string(),
})

export const agentActivitySchema = agentEventBaseSchema.extend({
  type: z.literal('agentActivity'),
  activity: z.string(),
})

export const agentPlanUpdatedSchema = agentEventBaseSchema.extend({
  type: z.literal('agentPlanUpdated'),
  plan: planViewSchema,
})

export const agentAssistantStartedSchema = agentEventBaseSchema.extend({
  type: z.literal('agentAssistantStarted'),
})

export const agentAssistantDeltaSchema = agentEventBaseSchema.extend({
  type: z.literal('agentAssistantDelta'),
  text: z.string(),
})

export const agentAssistantCompletedSchema = agentEventBaseSchema.extend({
  type: z.literal('agentAssistantCompleted'),
})

export const agentDocumentDeclaredSchema = agentEventBaseSchema.extend({
  type: z.literal('agentDocumentDeclared'),
  document: documentProgressStateSchema,
})

export const agentDocumentProgressSchema = agentEventBaseSchema.extend({
  type: z.literal('agentDocumentProgress'),
  document: documentProgressStateSchema,
})

export const agentDocumentCheckpointSchema = agentEventBaseSchema.extend({
  type: z.literal('agentDocumentCheckpoint'),
  documentId: z.string(),
  title: z.string(),
  sectionTitle: z.string().optional(),
  completedSections: z.number().int().nonnegative(),
  totalSections: z.number().int().nonnegative(),
  conflict: z.boolean().optional(),
  pendingDraftId: z.string().optional(),
})

export const agentValidationProgressSchema = agentEventBaseSchema.extend({
  type: z.literal('agentValidationProgress'),
  phase: z.enum(['deterministic', 'claim', 'cross-document']),
  message: z.string(),
  documentId: z.string().optional(),
  finalStatus: z.enum(['completed', 'failed']).optional(),
})

export const agentTaskCompletedSchema = agentEventBaseSchema.extend({
  type: z.literal('agentTaskCompleted'),
  summary: z.string().optional(),
})

export const agentTaskFailedSchema = agentEventBaseSchema.extend({
  type: z.literal('agentTaskFailed'),
  error: z.string(),
})

export const agentTaskCancelledSchema = agentEventBaseSchema.extend({
  type: z.literal('agentTaskCancelled'),
})

export const agentTaskPausedSchema = agentEventBaseSchema.extend({
  type: z.literal('agentTaskPaused'),
  reason: z.string(),
})

export const agentSessionSnapshotEventSchema = agentEventBaseSchema.extend({
  type: z.literal('agentSessionSnapshot'),
  snapshot: agentSessionSnapshotSchema,
})

/** The complete runtime-validated event catalogue (plan §6 event set). */
export const agentEventSchema = z.discriminatedUnion('type', [
  agentTaskStartedSchema,
  agentActivitySchema,
  agentPlanUpdatedSchema,
  agentAssistantStartedSchema,
  agentAssistantDeltaSchema,
  agentAssistantCompletedSchema,
  agentDocumentDeclaredSchema,
  agentDocumentProgressSchema,
  agentDocumentCheckpointSchema,
  agentValidationProgressSchema,
  agentTaskCompletedSchema,
  agentTaskFailedSchema,
  agentTaskCancelledSchema,
  agentTaskPausedSchema,
  agentSessionSnapshotEventSchema,
])

export type AgentEventParsed = z.infer<typeof agentEventSchema>

/**
 * Boundary validation: returns the parsed event when it matches the contract,
 * `null` otherwise. Callers log and forward defensively — schema drift must
 * never silently drop user-visible state.
 */
export function parseAgentEvent(input: unknown): AgentEventParsed | null {
  const result = agentEventSchema.safeParse(input)
  return result.success ? result.data : null
}
