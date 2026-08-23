import type { TaskNode } from '../contracts/TaskGraph'
import type { TaskBudget } from '../contracts/TaskBudget'
import type { PlanView, DocumentProgressState } from '../../../shared/agentProtocol'
import type { ReplanSignal } from '../planner/Planner'
import type { RegenerateSectionSignal } from '../contracts/Validation'
import type { Planner } from '../planner/Planner'
import { TaskGraphStore } from '../planner/TaskGraphStore'
import type { Scheduler } from '../workers/Scheduler'
import { ProviderError, isRetryableProviderError } from '../model/ProviderError'
import { AdaptiveConcurrencyController, TaskBudgetController } from '../observability/TaskControls'

/**
 * Shared task-graph execution (plan §8/§9/§12/§13/§14): seed a durable plan
 * graph, execute ready nodes through a per-type semaphore scheduler, apply
 * coverage gates + bounded replanning, and summarize validation. Used by the
 * legacy orchestrator and by the single-loop runner's `create_document` tool —
 * both reuse identical document/validation/regeneration machinery.
 */

export interface NodeRunResult {
  /** Compact structured summaries handed to dependent nodes. */
  outputs: string[]
  /** Replan signals (follow-ups / missing coverage / section regenerations). */
  followups?: ReplanSignal[]
  /** Structured coverage strings the worker achieved (plan §13). */
  coverageAchieved?: string[]
  /** Worker-reported open questions (plan §13). */
  newQuestions?: string[]
  /** Worker-reported coverage gaps (plan §13). */
  missingCoverage?: string[]
}

export interface NodeRunContext {
  taskId?: string
  signal: AbortSignal
  activity: (activity: string) => void
  delta: (text: string) => void
  /** Outputs of the node's completed dependencies (oldest first). */
  dependencyOutputs: string[]
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
  validationProgress: (info: {
    phase: 'deterministic' | 'claim' | 'cross-document'
    message: string
    documentId?: string
    finalStatus?: 'completed' | 'failed'
  }) => void
  budgetController?: TaskBudgetController
}

/** Task-scoped emit surface used by graph execution. */
export interface RunTaskGraphEmit {
  activity(activity: string): void
  planUpdated(plan: PlanView): void
  documentDeclared(document: DocumentProgressState): void
  documentProgress(document: DocumentProgressState): void
  documentCheckpoint(info: {
    documentId: string
    title: string
    sectionTitle?: string
    completedSections: number
    totalSections: number
    conflict?: boolean
    pendingDraftId?: string
  }): void
  validationProgress(info: {
    phase: 'deterministic' | 'claim' | 'cross-document'
    message: string
    documentId?: string
    finalStatus?: 'completed' | 'failed'
  }): void
}

export interface RunTaskGraphOptions {
  taskId: string
  signal: AbortSignal
  /** Planning objective for a fresh run (ignored when resuming a graph). */
  objective: string
  /**
   * Explicit document titles (model-supplied). When present, planning skips
   * deterministic keyword guessing and builds a document graph for exactly
   * these titles via `Planner.planDocumentsByTitle`.
   */
  documentTitles?: string[]
  planner: Planner
  scheduler: Scheduler
  maxNodes?: number
  maxReplans?: number
  maxNodeRetries?: number
  runNode?: (node: TaskNode, ctx: NodeRunContext) => Promise<NodeRunResult | string[]>
  onGraphChange?: (nodes: TaskNode[]) => void
  onNodeDurable?: () => Promise<void> | void
  resume?: { graph?: TaskNode[] }
  emit: RunTaskGraphEmit
}

export interface RunTaskGraphResult {
  nodes: TaskNode[]
  outputs: Map<string, string[]>
  validationSummary?: string
}

const DEFAULT_MAX_NODE_RETRIES = 2

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
    maxParallelWorkers: Math.max(1, nodes.reduce((total, node) => total + node.budget.maxParallelWorkers, 0)),
    maxReplans: Math.max(...nodes.map((node) => node.budget.maxReplans)),
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function retryDelay(attempt: number): number {
  return 500 * 2 ** attempt + Math.random() * 250
}

function delayFor(err: unknown, attempt: number): number {
  if (err instanceof ProviderError && err.retryAfterMs !== undefined) return err.retryAfterMs
  return retryDelay(attempt)
}

function normalizeCoverageItem(item: string): string {
  return item.toLowerCase().trim().replace(/\s+/g, ' ')
}

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

export async function runTaskGraph(options: RunTaskGraphOptions): Promise<RunTaskGraphResult> {
  const { emit } = options
  const planner = options.planner
  const scheduler = options.scheduler
  const maxNodeRetries = options.maxNodeRetries ?? DEFAULT_MAX_NODE_RETRIES
  const signal = options.signal
  const taskId = options.taskId

  emit.activity('Planning analysis tasks')
  const graph = new TaskGraphStore({ maxNodes: options.maxNodes, maxReplans: options.maxReplans })
  const outputs = new Map<string, string[]>()
  const achievedCoverage = new Set<string>()
  const missingByNode = new Map<string, string[]>()
  interface ReplanRound { ids: string[]; baseline: number }
  const replanRounds: ReplanRound[] = []
  let stopFollowups = false
  let stopLoop = false
  let zeroCoverageStreak = 0
  const SKIP_REASON = 'Skipped: repeated zero-coverage work terminated the plan loop.'
  if (options.resume?.graph && options.resume.graph.length > 0) {
    // Plan §14 restart recovery: rehydrate the durable graph; completed nodes
    // (and their outputs) are NEVER repeated.
    const restored = options.resume.graph.map((n) =>
      n.status === 'running' ? { ...n, status: 'queued' as const } : { ...n },
    )
    graph.seed(restored)
    for (const n of restored) {
      if (n.status === 'completed') outputs.set(n.id, n.outputs)
    }
    emit.activity('Restored plan from durable state')
  } else {
    const plan = options.documentTitles
      ? planner.planDocumentsByTitle(options.objective, options.documentTitles)
      : await planner.planAsync(options.objective, signal)
    graph.seed(plan)
  }
  const taskBudget = new TaskBudgetController(deriveTaskBudget(graph.all()))
  // Global concurrency is a scheduler concern (the sum of its per-worker-type
  // limits), not the minimum of per-node `maxParallelWorkers`. Every node
  // budget declares `maxParallelWorkers: 1` (a node runs its own model calls
  // serially); taking the minimum collapsed the whole graph to one in-flight
  // node and serialized otherwise-parallel documents.
  const maxParallelWorkers = scheduler.maxConcurrency()
  const adaptiveConcurrency = new AdaptiveConcurrencyController(maxParallelWorkers)
  emit.planUpdated(graph.toPlanView())
  options.onGraphChange?.(graph.all())

  const execute = async (node: TaskNode): Promise<string[]> => {
    if (stopLoop) {
      for (const n of graph.all()) {
        if (n.id === node.id || n.status === 'queued') graph.block(n.id, SKIP_REASON)
      }
      return []
    }
    const deps = node.dependencies.flatMap((d) => outputs.get(d) ?? [])
    let raw: NodeRunResult | string[] | undefined
    for (let attempt = 0; ; attempt++) {
      try {
        raw = options.runNode
          ? await options.runNode(node, {
            taskId,
            signal,
            activity: (a) => emit.activity(a),
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
          signal.aborted
        ) {
          throw err
        }
        emit.activity(`Provider hiccup on "${node.title}" — retrying (attempt ${attempt + 1})`)
        await sleep(delayFor(err, attempt))
      }
    }
    const result: NodeRunResult = Array.isArray(raw) ? { outputs: raw } : raw
    const finalOutputs = [...result.outputs]

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
    for (const a of achievedNorm) if (a !== '') achievedCoverage.add(a)
    for (const c of node.requiredCoverage) if (satisfied(c)) achievedCoverage.add(normalizeCoverageItem(c))

    if (achieved.length === 0 && finalOutputs.every((o) => o.trim() === '')) {
      zeroCoverageStreak++
      if (zeroCoverageStreak >= 2) {
        stopLoop = true
        emit.activity('Repeated zero-coverage work — terminating the plan loop')
      }
    } else {
      zeroCoverageStreak = 0
    }

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
          finalOutputs.push(JSON.stringify({ kind: 'missingCoverage', items: missing }))
          missingByNode.set(node.id, missing)
          outputs.set(node.id, finalOutputs)
        }
      } else if (replan.added.length > 0) {
        emit.activity(`Added ${replan.added.length} follow-up part(s)`)
        if (analysisSignals.length > 0 || missingFollowups.length > 0) {
          replanRounds.push({ ids: replan.added, baseline: achievedCoverage.size })
        }
      }
      emit.planUpdated(graph.toPlanView())
      options.onGraphChange?.(graph.all())
    }

    for (const round of replanRounds) {
      round.ids = round.ids.filter((id) => id !== node.id)
    }
    for (const round of [...replanRounds]) {
      if (round.ids.length > 0) continue
      replanRounds.splice(replanRounds.indexOf(round), 1)
      if (achievedCoverage.size <= round.baseline) {
        stopFollowups = true
        emit.activity('No new coverage after replanning — stopping follow-ups')
      }
    }

    await options.onNodeDurable?.()

    return finalOutputs
  }

  await scheduler.runGraph(graph, execute, {
    signal,
    maxParallelWorkers,
    adaptiveConcurrency,
    onChange: () => {
      emit.planUpdated(graph.toPlanView())
      options.onGraphChange?.(graph.all())
    },
    onStart: (node) => emit.activity(`Working on: ${node.title}`),
  })

  if (signal.aborted) {
    graph.cancelAll()
    emit.planUpdated(graph.toPlanView())
    options.onGraphChange?.(graph.all())
    return { nodes: graph.all(), outputs }
  }

  const nodes = graph.all()
  const failed = nodes.filter((n) => n.status === 'failed').length
  const completed = nodes.filter((n) => n.status === 'completed').length
  if (failed > 0) {
    emit.activity(`${completed} of ${nodes.length} analysis parts completed — see plan for failures.`)
  } else {
    emit.activity('Analysis complete')
  }

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

  return { nodes, outputs, validationSummary }
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
