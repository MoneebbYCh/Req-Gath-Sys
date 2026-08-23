import type { TaskRunner } from './AgentRuntime'
import { ComplexityRouter } from '../planner/ComplexityRouter'
import { DOC_REQUEST, Planner } from '../planner/Planner'
import { Scheduler } from '../workers/Scheduler'
import type { TaskNode } from '../contracts/TaskGraph'
import { runTaskGraph, type NodeRunResult, type NodeRunContext } from './runTaskGraph'

export type { NodeRunResult, NodeRunContext } from './runTaskGraph'
export { deriveTaskBudget } from './runTaskGraph'

/**
 * Legacy orchestrator runner (plan §8/§9/§12): routes each request to the
 * bounded fast path (simple) or a durable task graph (complex). The graph
 * execution is shared with the single-loop runner's `create_document` tool via
 * `runTaskGraph`. Kept as the flag-gated fallback when `singleLoop` is off.
 */

export interface FinalSynthesisInput {
  objective: string
  nodes: ReadonlyArray<Pick<TaskNode, 'id' | 'title' | 'status' | 'outputs'>>
  validationSummary?: string
}

export interface FinalSynthesisContext {
  signal: AbortSignal
  activity: (activity: string) => void
  assistantStarted: () => void
  delta: (text: string) => void
  assistantCompleted: () => void
}

export interface OrchestratorRunnerOptions {
  /** Fast path for simple questions (the bounded tool loop). */
  simpleRunner: TaskRunner
  router?: ComplexityRouter
  planner?: Planner
  /** Per-worker-type concurrency limits (plan §9 semaphore). */
  scheduler?: Scheduler
  maxNodes?: number
  maxReplans?: number
  /**
   * Executes one graph node. Returns string outputs (legacy) or a structured
   * result carrying replan signals.
   */
  runNode?: (node: TaskNode, ctx: NodeRunContext) => Promise<NodeRunResult | string[]>
  /** Durable-state hook (plan §14): the live graph after every change. */
  onGraphChange?: (nodes: TaskNode[]) => void
  /** Node-level retry budget for transient provider failures (plan §14). */
  maxNodeRetries?: number
  /** Awaited after a node's outputs are durably committed. */
  onNodeDurable?: () => Promise<void> | void
  /**
   * One user-facing model pass after the concurrent graph settles.
   */
  synthesize?: (input: FinalSynthesisInput, ctx: FinalSynthesisContext) => Promise<void>
  /** Recent durable conversation turns used to resolve terse follow-ups. */
  conversationContext?: () => readonly string[]
}

const CONTINUATION_REQUEST =
  /^(?:yes|yep|yeah|ok(?:ay)?|sure|continue|cotniue|proceed|do (?:it|that)|go ahead|please (?:do|continue)|sounds good|carry on)(?:\s+(?:please|now|then|with (?:it|that)|that|it))*[.!\s]*$/i

export function orchestratorRunner(options: OrchestratorRunnerOptions): TaskRunner {
  const router = options.router ?? new ComplexityRouter()
  const planner = options.planner ?? new Planner({ maxNodes: options.maxNodes })
  const scheduler = options.scheduler ?? new Scheduler()
  let pendingDocumentObjective: string | undefined

  return async ({ handle, emit, text, surface, resume }) => {
    const explicitDocumentRequest = DOC_REQUEST.test(text)
    if (explicitDocumentRequest) pendingDocumentObjective = text
    const planningObjective = resolvePlanningObjective(
      text,
      router,
      options.conversationContext?.() ?? [],
      pendingDocumentObjective,
    )
    if (!explicitDocumentRequest && !CONTINUATION_REQUEST.test(text.trim())) {
      pendingDocumentObjective = undefined
    }
    if (router.route(planningObjective) === 'simple') {
      return options.simpleRunner({ handle, emit, text, surface })
    }

    if (DOC_REQUEST.test(planningObjective)) {
      emit.assistantStarted()
      emit.assistantDelta(
        'I’m creating this as an editable canvas document. It will appear on the dashboard and update section by section.\n\n',
      )
      emit.assistantCompleted()
    }

    const { nodes, outputs, validationSummary } = await runTaskGraph({
      taskId: handle.taskId,
      signal: handle.signal,
      objective: planningObjective,
      planner,
      scheduler,
      maxNodes: options.maxNodes,
      maxReplans: options.maxReplans,
      maxNodeRetries: options.maxNodeRetries,
      runNode: options.runNode,
      onGraphChange: options.onGraphChange,
      onNodeDurable: options.onNodeDurable,
      resume: resume ? { graph: resume.graph } : undefined,
      emit: {
        activity: (a) => emit.activity(a),
        planUpdated: (p) => emit.planUpdated(p),
        documentDeclared: (d) => emit.documentDeclared(d),
        documentProgress: (d) => emit.documentProgress(d),
        documentCheckpoint: (i) => emit.documentCheckpoint(i),
        validationProgress: (i) => emit.validationProgress(i),
      },
    })

    if (options.synthesize) {
      emit.activity('Preparing final answer')
      await options.synthesize(
        {
          objective: text,
          nodes: nodes.map((node) => ({
            id: node.id,
            title: node.title,
            status: node.status,
            outputs: outputs.get(node.id) ?? node.outputs,
          })),
          validationSummary,
        },
        {
          signal: handle.signal,
          activity: (activity) => emit.activity(activity),
          assistantStarted: () => emit.assistantStarted(),
          delta: (chunk) => emit.assistantDelta(chunk),
          assistantCompleted: () => emit.assistantCompleted(),
        },
      )
    } else if (validationSummary) {
      // Compatibility fallback for callers that have not yet installed the
      // production synthesis port.
      emit.assistantDelta(validationSummary)
    }
  }
}

function resolvePlanningObjective(
  text: string,
  router: ComplexityRouter,
  conversation: readonly string[],
  pendingDocumentObjective?: string,
): string {
  if (router.route(text) === 'complex' || !CONTINUATION_REQUEST.test(text.trim())) return text
  const priorContext = conversation
    .map((turn) => turn.trim())
    .filter(Boolean)
    .slice(-6)
  if (priorContext.length === 0 && !pendingDocumentObjective) return text
  const contextualObjective = [
    'Continue the following conversation while preserving its requested deliverable:',
    pendingDocumentObjective ? `PENDING DELIVERABLE: ${pendingDocumentObjective}` : '',
    ...priorContext,
    `USER FOLLOW-UP: ${text}`,
  ].filter(Boolean).join('\n')
  return router.route(contextualObjective) === 'complex' ? contextualObjective : text
}
