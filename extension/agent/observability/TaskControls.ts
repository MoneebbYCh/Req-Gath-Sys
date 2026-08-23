import type { TaskBudget } from '../contracts/TaskBudget'

export type ModelRoute = 'strong' | 'fast'

export interface ModelPricing {
  inputPerMillion: number
  outputPerMillion: number
}

export interface TaskUsage {
  modelCalls: number
  toolCalls: number
  inputTokens: number
  outputTokens: number
  estimatedCost?: number
}

export interface BudgetReservation {
  inputTokens: number
  outputTokens: number
}

/**
 * Task-scoped, synchronous reservations prevent concurrently running nodes
 * from collectively exceeding the task's declared limits. Model output is
 * reserved before a provider call because the final usage arrives too late to
 * prevent a second worker from spending the same remaining budget.
 */
export class TaskBudgetController {
  private usage: TaskUsage = { modelCalls: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0 }

  constructor(readonly budget: TaskBudget, private readonly pricing?: ModelPricing) {}

  tryReserveModel(inputTokens: number, maxOutputTokens: number): BudgetReservation | null {
    const input = Math.max(0, Math.ceil(inputTokens))
    const output = Math.max(0, Math.ceil(maxOutputTokens))
    // Gate model calls on the call-count ceiling ONLY. Per-call input and
    // output are bounded elsewhere: `withinInputBudget` truncates each request
    // to the node's maxInputTokens, and the provider's max_tokens caps each
    // response. Gating on cumulative input/output double-counts a growing
    // message history and starves later graph nodes (a document node runs
    // after the analysis nodes and would otherwise find the shared token
    // budget already exhausted). Tokens stay tracked for cost telemetry.
    if (this.usage.modelCalls >= this.budget.maxModelCalls) return null
    this.usage.modelCalls++
    this.usage.inputTokens += input
    this.usage.outputTokens += output
    return { inputTokens: input, outputTokens: output }
  }

  settleModel(reservation: BudgetReservation, actual?: { inputTokens: number; outputTokens: number }): void {
    if (!actual) return
    this.usage.inputTokens += Math.max(0, actual.inputTokens) - reservation.inputTokens
    this.usage.outputTokens += Math.max(0, actual.outputTokens) - reservation.outputTokens
  }

  tryReserveTool(): boolean {
    if (this.usage.toolCalls >= this.budget.maxToolCalls) return false
    this.usage.toolCalls++
    return true
  }

  snapshot(): TaskUsage {
    const base = { ...this.usage }
    if (!this.pricing) return base
    return {
      ...base,
      estimatedCost: (base.inputTokens * this.pricing.inputPerMillion + base.outputTokens * this.pricing.outputPerMillion) / 1_000_000,
    }
  }

  isApproaching(): boolean {
    const u = this.usage
    return u.modelCalls >= this.budget.maxModelCalls * 0.8 || u.toolCalls >= this.budget.maxToolCalls * 0.8 ||
      u.inputTokens >= this.budget.maxInputTokens * 0.8 || u.outputTokens >= this.budget.maxOutputTokens * 0.8
  }
}

export interface TaskTelemetryEvent {
  kind: 'model' | 'tool' | 'budget' | 'concurrency' | 'document'
  taskId?: string
  nodeId?: string
  workerType?: string
  model?: string
  route?: ModelRoute
  durationMs?: number
  inputTokens?: number
  outputTokens?: number
  tool?: string
  ok?: boolean
  reason?: string
  concurrency?: number
  /** Content-free document-structure diagnostics. */
  documentEvent?: 'section_parse_attempt' | 'section_fallback' | 'section_fallback_checkpointed' | 'mermaid_parse_attempt' | 'mermaid_fallback'
  documentOperation?: 'generate' | 'regenerate' | 'createDocument' | 'checkpointDocument' | 'loadDocumentIR'
  sectionIndex?: number
  attempt?: 1 | 2
  parseOutcome?: 'valid' | 'empty' | 'markdown' | 'malformed_json' | 'schema_mismatch'
  responseBytes?: number
  jsonExtracted?: boolean
  blockCount?: number
  schemaIssueCount?: number
  schemaIssueCodes?: string[]
  fallbackReason?: 'empty' | 'malformed_json' | 'schema_mismatch'
  checkpointPending?: boolean
}

/** Content-free event sink. Its type intentionally has no prompt/result/path fields. */
export type TaskTelemetry = (event: TaskTelemetryEvent) => void

export interface ModelRoutingOptions {
  strongModel: string
  fastModel?: string
  enableFastRoutes?: boolean
}

/** Default remains one strong model; inexpensive routing is opt-in. */
export class ModelRoutingPolicy {
  constructor(private readonly options: ModelRoutingOptions) {}

  select(role: 'planning' | 'analysis' | 'validation' | 'synthesis' | 'classification' | 'extraction'): { route: ModelRoute; model: string } {
    const fast = this.options.enableFastRoutes && this.options.fastModel && (role === 'classification' || role === 'extraction')
    return fast ? { route: 'fast', model: this.options.fastModel! } : { route: 'strong', model: this.options.strongModel }
  }
}

/** Shared rate-limit pressure signal consumed by the scheduler. */
export class AdaptiveConcurrencyController {
  private readonly baseline: number
  private current: number
  private cooldownUntil = 0

  constructor(maxParallelWorkers: number) {
    this.baseline = Math.max(1, maxParallelWorkers)
    this.current = this.baseline
  }

  limit(now = Date.now()): number {
    if (now >= this.cooldownUntil && this.current < this.baseline) this.current++
    return this.current
  }

  reportRateLimit(retryAfterMs?: number, now = Date.now()): number {
    this.current = Math.max(1, Math.floor(this.current / 2))
    this.cooldownUntil = Math.max(this.cooldownUntil, now + (retryAfterMs ?? 1_000))
    return this.current
  }

  reportSuccess(now = Date.now()): number {
    if (now >= this.cooldownUntil && this.current < this.baseline) this.current++
    return this.current
  }
}
