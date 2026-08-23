import type { TaskRunner } from './AgentRuntime'
import { ComplexityRouter } from '../planner/ComplexityRouter'
import { DOC_REQUEST, Planner, type ReplanSignal } from '../planner/Planner'
import type { RegenerateSectionSignal } from '../contracts/Validation'
import { TaskGraphStore } from '../planner/TaskGraphStore'
import { Scheduler } from '../workers/Scheduler'
import { ProviderError, isRetryableProviderError } from '../model/ProviderError'
import type { TaskNode } from '../contracts/TaskGraph'
import type { DocumentProgressState } from '../../../shared/agentProtocol'
import { AdaptiveConcurrencyController, TaskBudgetController } from '../observability/TaskControls'
import type { TaskBudget } from '../contracts/TaskBudget'

/**
 * Orchestrator runner (plan §8/§9/§12): routes each request to the bounded
 * fast path (simple) or a durable task graph (complex). Complex tasks stream a
 * live plan (agentPlanUpdated) and execute ready nodes through a per-type
 * semaphore scheduler. Workers return structured results; `followups` feed a
 * bounded replan through the graph store (duplicate/stall detection included).
 * Document nodes emit live per-document progress/checkpoint events.
 */

export interface NodeRunResult {
  /** Compact structured summaries handed to dependent nodes. */
  outputs: string[]
  /**
   * Replan signals (recommended follow-ups / missing coverage / targeted
   * document-section regenerations, plan §8/§13). Strings are analysis
   * follow-ups; `regenerate-section` signals fix a failed validation.
   */
  followups?: ReplanSignal[]
  /**
   * Structured coverage strings the worker achieved (plan §13 completion
   * gates). Absent for legacy string[] results — the orchestrator falls back
   * to parsing `"coverage":` out of the outputs.
   */
  coverageAchieved?: string[]
  /** Worker-reported open questions (plan §13) — replanned like follow-ups. */
  newQuestions?: string[]
  /** Worker-reported coverage gaps (plan §13) — replanned like follow-ups. */
  missingCoverage?: string[]
}

export interface NodeRunContext {
  /** Primary diagnostics correlation id for every node execution. */
  taskId?: string
  signal: AbortSignal
  activity: (activity: string) => void
  delta: (text: string) => void
  /** Outputs of the node's completed dependencies (oldest first). */
  dependencyOutputs: string[]
  /** Plan §12: document node event emitters (task-scoped, seq'd). */
  documentDeclared: (document: DocumentProgressState) => void
  documentProgress: (document: DocumentProgressState) => void
  documentCheckpoint: (info: {
    documentId: string
    title: string
    sectionTitle?: string
    completedSections: number
    totalSections: number
    conflict?: boolean
    pendingDraftId?: string
  }) => void
  /** Plan §13: validation layer progress (task-scoped, seq'd). */
  validationProgress: (info: {
    phase: 'deterministic' | 'claim' | 'cross-document'
    message: string
    documentId?: string
    finalStatus?: 'completed' | 'failed'
  }) => void
  budgetController?: TaskBudgetController
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
   * result carrying replan signals. Default: no-op executor — tests and the
   * host supply the real Phase 9 worker.
   */
  runNode?: (node: TaskNode, ctx: NodeRunContext) => Promise<NodeRunResult | string[]>
  /** Durable-state hook (plan §14): the live graph after every change. */
  onGraphChange?: (nodes: TaskNode[]) => void
  /** Node-level retry budget for transient provider failures (plan §14). */
  maxNodeRetries?: number
  /**
   * Plan §14: awaited after a node's outputs are recorded and the plan is
   * persisted, BEFORE any dependent node may start (the scheduler awaits
   * execute). worker.ts wires this to the recorder's durable flush
   * (Agent C adds `recorder.flushAsync`).
   */
  onNodeDurable?: () => Promise<void> | void
  /**
   * One user-facing model pass after the concurrent graph settles. Node
   * streams are deliberately internal; only this pass may emit answer prose.
   */
  synthesize?: (input: FinalSynthesisInput, ctx: FinalSynthesisContext) => Promise<void>
  /**
   * Recent durable conversation turns used only to resolve terse follow-ups
   * before the deterministic router runs. Model calls already receive the
   * same history through ContextualModelProvider.
   */
  conversationContext?: () => readonly string[]
}

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

const DEFAULT_MAX_NODE_RETRIES = 2

const CONTINUATION_REQUEST =
  /^(?:yes|yep|yeah|ok(?:ay)?|sure|continue|cotniue|proceed|do (?:it|that)|go ahead|please (?:do|continue)|sounds good|carry on)(?:\s+(?:please|now|then|with (?:it|that)|that|it))*[.!\s]*$/i

const EMPTY_TASK_BUDGET: TaskBudget = {
  maxModelCalls: 1,
  maxToolCalls: 0,
  maxInputTokens: 1,
  maxOutputTokens: 1,
  maxParallelWorkers: 1,
  maxReplans: 0,
}

/** Aggregate node ceilings into the task-wide allowance shared by the graph. */
export function deriveTaskBudget(nodes: readonly TaskNode[]): TaskBudget {
  if (nodes.length === 0) return EMPTY_TASK_BUDGET
  return {
    maxModelCalls: nodes.reduce((total, node) => total + node.budget.maxModelCalls, 0),
    maxToolCalls: nodes.reduce((total, node) => total + node.budget.maxToolCalls, 0),
    maxInputTokens: nodes.reduce((total, node) => total + node.budget.maxInputTokens, 0),
    maxOutputTokens: nodes.reduce((total, node) => total + node.budget.maxOutputTokens, 0),
    maxParallelWorkers: Math.max(1, Math.min(...nodes.map((node) => node.budget.maxParallelWorkers))),
    maxReplans: Math.max(...nodes.map((node) => node.budget.maxReplans)),
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Exponential backoff + jitter (plan §14 retry taxonomy). */
function retryDelay(attempt: number): number {
  return 500 * 2 ** attempt + Math.random() * 250
}

/**
 * Plan §3 edge case (429 with retry headers): the provider's Retry-After
 * beats the local backoff schedule when present.
 */
function delayFor(err: unknown, attempt: number): number {
  if (err instanceof ProviderError && err.retryAfterMs !== undefined) return err.retryAfterMs
  return retryDelay(attempt)
}

/** Coverage comparison is lenient: case-insensitive, whitespace-collapsed. */
function normalizeCoverageItem(item: string): string {
  return item.toLowerCase().trim().replace(/\s+/g, ' ')
}

/** Fallback coverage source (plan §13): `"coverage":` arrays inside JSON outputs. */
function parseCoverageFromOutputs(outputs: string[]): string[] {
  const found: string[] = []
  for (const raw of outputs) {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown> | null
      if (!parsed || typeof parsed !== 'object') continue
      for (const key of ['coverage', 'coverage_achieved']) {
        const list = parsed[key]
        if (Array.isArray(list)) for (const c of list) if (typeof c === 'string') found.push(c)
      }
    } catch {
      // Not JSON — legacy plain-text outputs.
    }
  }
  return found
}

export function orchestratorRunner(options: OrchestratorRunnerOptions): TaskRunner {
  const router = options.router ?? new ComplexityRouter()
  const planner = options.planner ?? new Planner({ maxNodes: options.maxNodes })
  const scheduler = options.scheduler ?? new Scheduler()
  const maxNodeRetries = options.maxNodeRetries ?? DEFAULT_MAX_NODE_RETRIES
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
    emit.activity('Planning analysis tasks')
    const graph = new TaskGraphStore({ maxNodes: options.maxNodes, maxReplans: options.maxReplans })
    const outputs = new Map<string, string[]>()
    // Plan §13/§14 loop-detection state: coverage growth across replan rounds
    // and repeated zero-coverage work.
    const achievedCoverage = new Set<string>()
    const missingByNode = new Map<string, string[]>()
    interface ReplanRound { ids: string[]; baseline: number }
    const replanRounds: ReplanRound[] = []
    let stopFollowups = false
    let stopLoop = false
    let zeroCoverageStreak = 0
    const SKIP_REASON = 'Skipped: repeated zero-coverage work terminated the plan loop.'
    if (resume?.graph && resume.graph.length > 0) {
      // Plan §14 restart recovery: rehydrate the durable graph. Nodes that
      // were mid-flight come back queued; completed nodes (and their outputs)
      // are NEVER repeated. Blocked nodes whose dependencies are complete now
      // become schedulable again.
      const restored = resume.graph.map((n) =>
        n.status === 'running' ? { ...n, status: 'queued' as const } : { ...n },
      )
      graph.seed(restored)
      for (const n of restored) {
        if (n.status === 'completed') outputs.set(n.id, n.outputs)
      }
      emit.activity('Restored plan from durable state')
    } else {
      graph.seed(await planner.planAsync(planningObjective, handle.signal))
    }
    const taskBudget = new TaskBudgetController(deriveTaskBudget(graph.all()))
    const adaptiveConcurrency = new AdaptiveConcurrencyController(taskBudget.budget.maxParallelWorkers)
    emit.planUpdated(graph.toPlanView())
    options.onGraphChange?.(graph.all())

    const execute = async (node: TaskNode): Promise<string[]> => {
      // Plan §14 zero-coverage loop: remaining work is skipped, not aborted.
      if (stopLoop) {
        for (const n of graph.all()) {
          if (n.id === node.id || n.status === 'queued') graph.block(n.id, SKIP_REASON)
        }
        return []
      }
      const deps = node.dependencies.flatMap((d) => outputs.get(d) ?? [])
      // Plan §14: transient provider failures retry with backoff + jitter;
      // deterministic/authorization failures do NOT blind-retry.
      let raw: NodeRunResult | string[] | undefined
      for (let attempt = 0; ; attempt++) {
        try {
          raw = options.runNode
              ? await options.runNode(node, {
                taskId: handle.taskId,
                signal: handle.signal,
                activity: (a) => emit.activity(a),
                // Graph workers may run concurrently. Their prose and JSON
                // envelopes remain internal; progress streams as activity.
                delta: () => {},
                dependencyOutputs: deps,
                documentDeclared: (document) => emit.documentDeclared(document),
                documentProgress: (document) => emit.documentProgress(document),
                documentCheckpoint: (info) => emit.documentCheckpoint(info),
                validationProgress: (info) => emit.validationProgress(info),
                budgetController: taskBudget,
              })
            : []
          break
        } catch (err) {
          if (err instanceof ProviderError && err.kind === 'rate_limited') {
            const reduced = adaptiveConcurrency.reportRateLimit(err.retryAfterMs)
            emit.activity(`Provider rate limit detected — reducing worker concurrency to ${reduced}`)
          }
          if (
            attempt >= maxNodeRetries ||
            !isRetryableProviderError(err) ||
            handle.signal.aborted
          ) {
            throw err
          }
          emit.activity(`Provider hiccup on "${node.title}" — retrying (attempt ${attempt + 1})`)
          await sleep(delayFor(err, attempt))
        }
      }
      const result: NodeRunResult = Array.isArray(raw) ? { outputs: raw } : raw
      const finalOutputs = [...result.outputs]

      // Plan §13 completion gate: requiredCoverage is compared against what
      // the worker ACTUALLY covered — never merely a model saying "done".
      const achieved = result.coverageAchieved ?? parseCoverageFromOutputs(finalOutputs)
      const achievedNorm = achieved.map(normalizeCoverageItem)
      const outputsNorm = finalOutputs.map(normalizeCoverageItem)
      const satisfied = (item: string): boolean => {
        const n = normalizeCoverageItem(item)
        if (n === '') return true
        return (
          achievedNorm.some((a) => a.includes(n) || n.includes(a)) ||
          outputsNorm.some((o) => o.includes(n))
        )
      }
      const missing = node.requiredCoverage.filter((c) => !satisfied(c))
      // Stall-detection bookkeeping: only real coverage items count as growth
      // (structured achieved strings + satisfied required items).
      for (const a of achievedNorm) if (a !== '') achievedCoverage.add(a)
      for (const c of node.requiredCoverage) if (satisfied(c)) achievedCoverage.add(normalizeCoverageItem(c))

      // Plan §14 loop detection: repeated empty work terminates the loop.
      if (achieved.length === 0 && finalOutputs.every((o) => o.trim() === '')) {
        zeroCoverageStreak++
        if (zeroCoverageStreak >= 2) {
          stopLoop = true
          emit.activity('Repeated zero-coverage work — terminating the plan loop')
        }
      } else {
        zeroCoverageStreak = 0
      }

      // Missing coverage is never silent: replan an investigation while the
      // budget lasts, otherwise persist a structured note into the outputs.
      const missingFollowups: TaskNode[] = []
      if (missing.length > 0) {
        if (!stopFollowups && graph.remainingReplans() > 0) {
          missingFollowups.push(
            ...planner.planFollowups(missing, node.roleSpec.scope.domains?.[0] ?? node.title),
          )
        } else {
          finalOutputs.push(JSON.stringify({ kind: 'missingCoverage', items: missing }))
          missingByNode.set(node.id, missing)
        }
      } else {
        missingByNode.delete(node.id)
      }

      outputs.set(node.id, finalOutputs)

      // Dynamic replanning (plan §8 + §13): analysis follow-ups, worker
      // new_questions/missing_coverage, missing-coverage investigations, and
      // targeted section regenerations become nodes, bounded by the replan
      // budget.
      const signals = result.followups ?? []
      const analysisSignals = [
        ...signals.filter((s): s is string => typeof s === 'string'),
        ...(result.newQuestions ?? []),
        ...(result.missingCoverage ?? []),
      ]
      const regenSignals = signals.filter(
        (s): s is RegenerateSectionSignal => typeof s === 'object' && s.kind === 'regenerate-section',
      )
      if (!stopFollowups && (analysisSignals.length > 0 || regenSignals.length > 0 || missingFollowups.length > 0)) {
        const candidates = [
          ...planner.planFollowups(analysisSignals, node.roleSpec.scope.domains?.[0] ?? node.title),
          ...planner.planRegenerations(regenSignals),
          ...missingFollowups,
        ]
        const replan = graph.replan(candidates)
        if (replan.stalled) {
          emit.activity('Replan budget exhausted or nothing new to add — continuing.')
          if (missing.length > 0) {
            // The gap was never investigated — record it rather than lose it.
            finalOutputs.push(JSON.stringify({ kind: 'missingCoverage', items: missing }))
            missingByNode.set(node.id, missing)
            outputs.set(node.id, finalOutputs)
          }
        } else if (replan.added.length > 0) {
          emit.activity(`Added ${replan.added.length} follow-up part(s)`)
          // Coverage-driven rounds only: regen-only replans don't grow coverage.
          if (analysisSignals.length > 0 || missingFollowups.length > 0) {
            replanRounds.push({ ids: replan.added, baseline: achievedCoverage.size })
          }
        }
        emit.planUpdated(graph.toPlanView())
        options.onGraphChange?.(graph.all())
      }

      // Plan §13: a replan round that yields no NEW coverage stalls the plan.
      for (const round of replanRounds) {
        round.ids = round.ids.filter((id) => id !== node.id)
      }
      // ponytail: a round containing a failed node never closes — known ceiling.
      for (const round of [...replanRounds]) {
        if (round.ids.length > 0) continue
        replanRounds.splice(replanRounds.indexOf(round), 1)
        if (achievedCoverage.size <= round.baseline) {
          stopFollowups = true
          emit.activity('No new coverage after replanning — stopping follow-ups')
        }
      }

      // Plan §14: dependents must not start until this node's outputs are
      // durably committed. worker.ts wires this to recorder.flushAsync
      // (Agent C); the scheduler awaits execute, so this gates dependents.
      await options.onNodeDurable?.()

      return finalOutputs
    }

    await scheduler.runGraph(graph, execute, {
      signal: handle.signal,
      // Every node carries the planner-issued task budget. A graph may only
      // use the tightest active/queued budget, in addition to type limits.
      maxParallelWorkers: Math.max(
        1,
        Math.min(...graph.all().map((node) => node.budget.maxParallelWorkers)),
      ),
      adaptiveConcurrency,
      onChange: () => {
        emit.planUpdated(graph.toPlanView())
        options.onGraphChange?.(graph.all())
      },
      onStart: (node) => emit.activity(`Working on: ${node.title}`),
    })

    if (handle.signal.aborted) {
      graph.cancelAll()
      emit.planUpdated(graph.toPlanView())
      options.onGraphChange?.(graph.all())
      return
    }

    const nodes = graph.all()
    const failed = nodes.filter((n) => n.status === 'failed').length
    const completed = nodes.filter((n) => n.status === 'completed').length
    if (failed > 0) {
      // Partial success is preserved (US-8.3); the task itself completes.
      emit.activity(
        `${completed} of ${nodes.length} analysis parts completed — see plan for failures.`,
      )
    } else {
      emit.activity('Analysis complete')
    }

    // Validation is part of the final answer input, not an independently
    // interleaved user stream. This preserves a single coherent answer after
    // concurrent graph workers have settled.
    const validationNodes = nodes.filter((n) => n.roleSpec.workerType === 'validation')
    const reports = validationNodes
      .flatMap((n) => outputs.get(n.id) ?? [])
      .map(parseValidationReport)
      .filter((r): r is ValidationReportShape => Boolean(r))
    const validationSummary = reports.length > 0
      ? formatValidationSummary(reports, validationNodes.filter((n) => n.status !== 'completed').length)
      : undefined
    if (validationSummary) {
      emit.activity('Validation complete')
    }

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

interface ValidationReportShape {
  mode: 'document' | 'cross-document'
  status?: 'passed' | 'issues' | 'failed'
  staleEvidenceIds?: unknown[]
  failedSections?: unknown[]
  contradictions?: unknown[]
}

function parseValidationReport(raw: string): ValidationReportShape | undefined {
  try {
    const parsed = JSON.parse(raw) as ValidationReportShape | null
    if (!parsed || typeof parsed !== 'object') return undefined
    return parsed
  } catch {
    return undefined
  }
}

/** Concise, honest validation summary streamed as assistant text (plan §13). */
function formatValidationSummary(reports: ValidationReportShape[], unvalidated: number): string {
  const docs = reports.filter((r) => r.mode === 'document')
  const cross = reports.filter((r) => r.mode === 'cross-document')
  const failedDocs = docs.filter((r) => r.status === 'failed').length
  const caveatedDocs = docs.filter((r) => r.status === 'issues').length
  const staleCount = docs.reduce((n, r) => n + (r.staleEvidenceIds?.length ?? 0), 0)
  const unresolved = cross.reduce(
    (n, r) => n + ((r.contradictions ?? []) as Array<{ resolved?: boolean }>).filter((c) => !c.resolved).length,
    0,
  )

  const lines = [
    `**Validation summary**\n`,
    `${docs.length} document(s) validated — ${failedDocs} failed, ${caveatedDocs} with caveats, ${docs.length - failedDocs - caveatedDocs} passed.`,
    staleCount > 0
      ? `${staleCount} evidence item(s) are stale — affected findings need revalidation.`
      : null,
    failedDocs > 0
      ? `Failed sections were queued for targeted regeneration — only the affected sections, not the whole documents.`
      : null,
    cross.length > 0
      ? `Cross-document check: ${unresolved} unresolved contradiction(s).`
      : null,
    unvalidated > 0 ? `${unvalidated} validation part(s) did not run (see plan).` : null,
  ].filter((l): l is string => Boolean(l))
  return lines.join('\n')
}
