import type { TaskRunner } from './AgentRuntime'
import {
  runToolLoop,
  TOOL_LOOP_BUDGET_PRESETS,
  type ToolLoopConfig,
  type ToolExecutor,
  type BudgetTier,
  type LoopCheckpoint,
} from '../model/toolLoopTaskRunner'
import type { ModelProvider } from '../model/ModelProvider'
import type { ModelMessage, ModelToolDefinition } from '../model/ModelTypes'
import { writePlanToolDefinition, createWritePlanHandler } from '../workers/writePlanTool'
import { createDocumentToolDefinition, createDocumentHandler } from '../workers/createDocumentTool'
import { type RunTaskGraphEmit, type NodeRunResult, type NodeRunContext } from './runTaskGraph'
import type { Planner } from '../planner/Planner'
import type { Scheduler } from '../workers/Scheduler'
import type { TaskNode } from '../contracts/TaskGraph'
import type { LoopState } from '../state/PersistedState'

/**
 * Single-loop ReAct runner (plan §single-loop): ONE bounded tool loop handles
 * every request. There is no deterministic complexity router — the model
 * decides whether to answer directly, plan (`write_plan`), investigate (repo
 * tools), or produce a document (`create_document`, which reuses the document
 * DAG sub-pipeline). Budgets are selected by model tier, not by request text.
 */

const SINGLE_LOOP_SYSTEM =
  'You are Charter Ai, an expert read-only repository analysis assistant. Decide what the ' +
  'message needs before calling any tools, and reason through that decision in your private ' +
  'reasoning — never as chat text.\n\n' +
  '## Routing rules\n' +
  '- Greetings, thanks, small talk, capability questions ("what can you do?"), and any ' +
  'question that does not require knowledge of THIS repository: answer immediately in ' +
  'one short turn. Do not call tools, write a plan, or inspect the codebase.\n' +
  '- Questions about this repository: call the repository tools to ground your answer.\n' +
  '- For complex or multi-step repository work, first call write_plan to lay out a short ' +
  'plan, then work through it, updating the plan as you progress.\n' +
  '- When the user asks for one or more documents (PRD, architecture, security review, ' +
  'API design, etc.), call create_document IMMEDIATELY with every requested document name ' +
  'in a single call. Do not explore the repository first — create_document runs the ' +
  'repository analysis itself and puts editable documents on the dashboard.\n\n' +
  '## Examples\n' +
  'User: "Hello" → answer "Hello! How can I help?" with no tools.\n' +
  'User: "Where is authentication handled?" → call search_code and read_file, then answer from the results.\n' +
  'User: "Create 2 docs: a PRD and a Security review" → call create_document with ' +
  '{"documents":[{"name":"PRD"},{"name":"Security review"}]}, then give a one-line confirmation.\n\n' +
  '## Chain of thought\n' +
  '- Before acting, plan your next step in private reasoning; after each tool result, ' +
  're-check whether you have enough evidence or need one more targeted call.\n' +
  '- Never write this reasoning as chat text. Visible replies contain only the final ' +
  'answer or a short confirmation.\n\n' +
  '## Constraints\n' +
  '- Read-only: never modify repository files.\n' +
  '- Every claim about the repository must be grounded in tools you actually called; ' +
  'if evidence is missing, say so instead of guessing.'

export interface SingleLoopRunnerOptions {
  provider: ModelProvider
  /** Host-side repository tool executor. */
  executor: ToolExecutor
  /** Base loop config (model, recordEvidence, telemetry, thinking, repo tools). */
  config: ToolLoopConfig
  /** Budget tier — defaults to 'standard' when unset. */
  budgetTier?: BudgetTier
  /** Enable the create_document tool (requires the graph deps below). */
  includeDocumentTool?: boolean
  planner?: Planner
  scheduler?: Scheduler
  runNode?: (node: TaskNode, ctx: NodeRunContext) => Promise<NodeRunResult | string[]>
  onGraphChange?: (nodes: TaskNode[]) => void
  onNodeDurable?: () => Promise<void> | void
  /** Durable mirror of each mid-loop checkpoint (plan §14 resume). */
  onLoopCheckpoint?: (taskId: string, state: LoopState) => void
}

const MAX_LOOP_MESSAGES = 6
const MAX_CONTENT = 2_000

export function singleLoopRunner(options: SingleLoopRunnerOptions): TaskRunner {
  const tier = options.budgetTier ?? 'standard'
  const preset = TOOL_LOOP_BUDGET_PRESETS[tier]

  return async ({ handle, emit, text, resume }) => {
    const workerTools: ModelToolDefinition[] = [writePlanToolDefinition]
    const canCreateDocument = Boolean(options.includeDocumentTool && options.planner && options.scheduler && options.runNode)
    if (canCreateDocument) workerTools.push(createDocumentToolDefinition)

    const graphEmit: RunTaskGraphEmit = {
      activity: (a) => emit.activity(a),
      planUpdated: (p) => emit.planUpdated(p),
      documentDeclared: (d) => emit.documentDeclared(d),
      documentProgress: (d) => emit.documentProgress(d),
      documentCheckpoint: (i) => emit.documentCheckpoint(i),
      validationProgress: (i) => emit.validationProgress(i),
    }
    const writePlan = createWritePlanHandler({
      planUpdated: (p) => emit.planUpdated(p),
      activity: (a) => emit.activity(a),
    })
    const createDocument = canCreateDocument
      ? createDocumentHandler({
        taskId: handle.taskId,
        signal: handle.signal,
        planner: options.planner!,
        scheduler: options.scheduler!,
        runNode: options.runNode,
        onGraphChange: options.onGraphChange,
        onNodeDurable: options.onNodeDurable,
        emit: graphEmit,
      })
      : undefined

    const compositeExecutor: ToolExecutor = {
      execute: async (name, input, signal) => {
        if (name === 'write_plan') return writePlan(input)
        if (name === 'create_document') {
          return createDocument
            ? await createDocument(input)
            : { ok: false, error: 'Document generation is unavailable.' }
        }
        return options.executor.execute(name, input, signal)
      },
    }

    const loopConfig: ToolLoopConfig = {
      ...options.config,
      ...preset,
      tools: [...(options.config.tools ?? []), ...workerTools],
      system: options.config.system ?? SINGLE_LOOP_SYSTEM,
      onLoopCheckpoint: (state) => {
        options.onLoopCheckpoint?.(handle.taskId, compactLoopState(state))
      },
    }

    const result = await runToolLoop(options.provider, compositeExecutor, loopConfig, {
      text,
      signal: handle.signal,
      activity: (a) => emit.activity(a),
      assistantStarted: () => emit.assistantStarted(),
      delta: (t) => emit.assistantDelta(t),
      context: {
        task: { taskId: handle.taskId, title: handle.title, objective: text, status: handle.status },
        instructions: [`User request: ${text}`],
      },
      resume: resume?.loopState,
    })
    if (result.text.length > 0) emit.assistantCompleted()
  }
}

/** Compact a checkpoint into a bounded, durable LoopState (plan §14). */
function compactLoopState(checkpoint: LoopCheckpoint): LoopState {
  const messages: ModelMessage[] = checkpoint.messages.slice(-MAX_LOOP_MESSAGES).map((m) => {
    if (m.role === 'assistant') {
      return {
        role: 'assistant',
        content: truncate(m.content),
        reasoningContent: m.reasoningContent ? truncate(m.reasoningContent) : undefined,
        toolCalls: m.toolCalls?.map((c) => ({ id: c.id, name: c.name, arguments: truncate(c.arguments) })),
      }
    }
    if (m.role === 'tool') {
      return { role: 'tool', content: truncate(m.content), toolCallId: m.toolCallId, name: m.name }
    }
    return { role: 'user', content: truncate(m.content) }
  })
  return {
    messages,
    toolCallsUsed: checkpoint.toolCallsUsed,
    modelCallsUsed: checkpoint.modelCallsUsed,
    evidenceIds: [...checkpoint.evidenceIds],
  }
}

function truncate(text: string): string {
  return text.length > MAX_CONTENT ? text.slice(0, MAX_CONTENT) : text
}
