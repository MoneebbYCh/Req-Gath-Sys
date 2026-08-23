import { z } from 'zod'
import type { ModelToolDefinition } from '../model/ModelTypes'
import {
  runTaskGraph,
  type RunTaskGraphEmit,
  type NodeRunResult,
  type NodeRunContext,
} from '../runtime/runTaskGraph'
import type { TaskNode } from '../contracts/TaskGraph'
import type { Planner } from '../planner/Planner'
import type { Scheduler } from '../workers/Scheduler'

/**
 * create_document tool (single-loop runner): the model can spawn the existing
 * document DAG sub-pipeline (analysis → document → validation → cross-document
 * → regeneration) without leaving the loop. It reuses `runTaskGraph`, so
 * documents get per-section checkpointing, revision safety, and validation —
 * identical to the legacy orchestrator's document path.
 */

const createDocumentInputSchema = z.object({
  documents: z.array(z.object({ name: z.string().min(1).max(160) })).min(1).max(10),
})

export const createDocumentToolDefinition: ModelToolDefinition = {
  name: 'create_document',
  description:
    'Generate one or more editable canvas documents (PRD, architecture, security review, API design, etc.) grounded in repository analysis. Provide every requested document name in a single call. Produces documents on the dashboard the user can edit section by section. Use when the user asks for a document or deliverable.',
  inputJsonSchema: z.toJSONSchema(createDocumentInputSchema) as Record<string, unknown>,
}

export interface CreateDocumentHandlerDeps {
  taskId: string
  signal: AbortSignal
  planner: Planner
  scheduler: Scheduler
  runNode?: (node: TaskNode, ctx: NodeRunContext) => Promise<NodeRunResult | string[]>
  onGraphChange?: (nodes: TaskNode[]) => void
  onNodeDurable?: () => Promise<void> | void
  emit: RunTaskGraphEmit
}

export function createDocumentHandler(deps: CreateDocumentHandlerDeps) {
  return async (input: unknown): Promise<{ ok: boolean; result?: unknown; error?: string }> => {
    const parsed = createDocumentInputSchema.safeParse(input)
    if (!parsed.success) {
      return { ok: false, error: `Invalid create_document input: ${parsed.error.issues[0]?.message ?? 'unknown'}` }
    }
    // Capture declared document ids as they stream so the model knows what was
    // produced without trusting planner-invented ids.
    const documentIds: string[] = []
    const emit: RunTaskGraphEmit = {
      ...deps.emit,
      documentDeclared: (document) => {
        if (!documentIds.includes(document.documentId)) documentIds.push(document.documentId)
        deps.emit.documentDeclared(document)
      },
    }
    const objective = parsed.data.documents
      .map((d) => d.name.trim())
      .filter(Boolean)
      .join(', ')
    try {
      const result = await runTaskGraph({
        taskId: deps.taskId,
        signal: deps.signal,
        objective: `Create the following documents: ${objective}`,
        documentTitles: parsed.data.documents.map((d) => d.name.trim()).filter(Boolean),
        planner: deps.planner,
        scheduler: deps.scheduler,
        runNode: deps.runNode,
        onGraphChange: deps.onGraphChange,
        onNodeDurable: deps.onNodeDurable,
        emit,
      })
      return {
        ok: true,
        result: {
          documentIds,
          titles: parsed.data.documents.map((d) => d.name.trim()).filter(Boolean),
          completedParts: result.nodes.filter((n) => n.status === 'completed').length,
          failedParts: result.nodes.filter((n) => n.status === 'failed').length,
          validationSummary: result.validationSummary,
        },
      }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }
}
