import { z } from 'zod'
import type { ModelToolDefinition } from '../model/ModelTypes'
import type { PlanView, PlanNodeStatus } from '../../../shared/agentProtocol'

/**
 * Plan-as-a-tool (single-loop runner): the model writes a structured plan of
 * points that streams to the live plan UI (`agentPlanUpdated`) and is mirrored
 * into durable state by the recorder. It is a state tool, not a repository tool
 * — it mutates the task plan, never the workspace.
 */

const planNodeStatuses: PlanNodeStatus[] = ['queued', 'running', 'completed', 'failed', 'blocked', 'cancelled']

const writePlanInputSchema = z.object({
  title: z.string().max(120).optional(),
  items: z
    .array(
      z.object({
        title: z.string().min(1).max(160),
        status: z.enum(['queued', 'running', 'completed', 'failed', 'blocked', 'cancelled']).default('queued'),
      }),
    )
    .max(20),
})

export const writePlanToolDefinition: ModelToolDefinition = {
  name: 'write_plan',
  description:
    'Write or update a short structured plan of steps for the current task. Use for complex or multi-step work; update items in place as you progress. Each item has a title and a status.',
  inputJsonSchema: z.toJSONSchema(writePlanInputSchema) as Record<string, unknown>,
}

export interface WritePlanHandlerDeps {
  planUpdated(plan: PlanView): void
  activity(activity: string): void
}

/** Worker-side tool handler: validates input, emits the plan, returns a summary. */
export function createWritePlanHandler(deps: WritePlanHandlerDeps) {
  return (input: unknown): { ok: boolean; result?: unknown; error?: string } => {
    const parsed = writePlanInputSchema.safeParse(input)
    if (!parsed.success) {
      return { ok: false, error: `Invalid write_plan input: ${parsed.error.issues[0]?.message ?? 'unknown'}` }
    }
    const nodes: PlanView['nodes'] = parsed.data.items.map((item, index) => ({
      id: `plan-${index + 1}-${slug(item.title)}`,
      title: item.title,
      status: item.status,
    }))
    deps.planUpdated({ nodes })
    deps.activity(`Plan updated — ${nodes.length} step(s)`)
    return { ok: true, result: { updated: true, steps: nodes.length } }
  }
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40)
}

export { planNodeStatuses }
