import { describe, expect, it } from 'vitest'
import { AdaptiveConcurrencyController, ModelRoutingPolicy, TaskBudgetController } from './TaskControls'

const budget = { maxModelCalls: 2, maxToolCalls: 2, maxInputTokens: 100, maxOutputTokens: 80, maxParallelWorkers: 4, maxReplans: 1 }

describe('TaskBudgetController', () => {
  it('gates model calls on the call-count ceiling, not cumulative tokens', () => {
    const controls = new TaskBudgetController(budget, { inputPerMillion: 2, outputPerMillion: 8 })
    const first = controls.tryReserveModel(40, 40)
    expect(first).toEqual({ inputTokens: 40, outputTokens: 40 })
    // A second call with large tokens is still allowed — per-call input/output
    // ceilings are enforced in withinInputBudget + provider max_tokens.
    expect(controls.tryReserveModel(61, 40)).toEqual({ inputTokens: 61, outputTokens: 40 })
    // The call-count ceiling is the hard gate.
    expect(controls.tryReserveModel(1, 1)).toBeNull()
    controls.settleModel(first!, { inputTokens: 30, outputTokens: 20 })
    const snapshot = controls.snapshot()
    expect(snapshot).toMatchObject({ modelCalls: 2, toolCalls: 0 })
    expect(snapshot.inputTokens).toBe(91) // 40 + 61 - 10 (reconciled)
    expect(snapshot.outputTokens).toBe(60) // 40 + 40 - 20 (reconciled)
    expect(snapshot.estimatedCost).toBeCloseTo((91 * 2 + 60 * 8) / 1_000_000)
  })

  it('tracks tool calls with their own ceiling', () => {
    const controls = new TaskBudgetController(budget)
    expect(controls.tryReserveTool()).toBe(true)
    expect(controls.tryReserveTool()).toBe(true)
    expect(controls.tryReserveTool()).toBe(false)
  })

  it('flags approaching limits before silently claiming completion', () => {
    const controls = new TaskBudgetController(budget)
    controls.tryReserveModel(80, 64)
    expect(controls.isApproaching()).toBe(true)
  })

  it('does not starve a later node when earlier nodes accumulate input (document regression)', () => {
    // Shared budget across analysis + document nodes: maxInputTokens is a
    // per-call ceiling, not a cumulative cap the analysis nodes can exhaust
    // before the document node runs. 30 analysis calls reserve 600k input
    // tokens cumulatively — the old accounting would have rejected the
    // document's call as "task budget exhausted".
    const shared = new TaskBudgetController({
      maxModelCalls: 40, maxToolCalls: 0, maxInputTokens: 360_000, maxOutputTokens: 64_000, maxParallelWorkers: 1, maxReplans: 0,
    })
    for (let i = 0; i < 30; i++) shared.tryReserveModel(20_000, 8_000)
    expect(shared.tryReserveModel(2_500, 0)).toEqual({ inputTokens: 2_500, outputTokens: 0 })

    // Only the call-count ceiling is a hard gate.
    const capped = new TaskBudgetController({
      maxModelCalls: 1, maxToolCalls: 0, maxInputTokens: 360_000, maxOutputTokens: 64_000, maxParallelWorkers: 1, maxReplans: 0,
    })
    capped.tryReserveModel(1, 1)
    expect(capped.tryReserveModel(1, 1)).toBeNull()
  })
})

describe('ModelRoutingPolicy', () => {
  it('defaults every role to the configured strong model', () => {
    const routing = new ModelRoutingPolicy({ strongModel: 'strong', fastModel: 'fast' })
    expect(routing.select('analysis')).toEqual({ route: 'strong', model: 'strong' })
    expect(routing.select('classification')).toEqual({ route: 'strong', model: 'strong' })
  })

  it('uses the fast model only for explicitly enabled low-risk work', () => {
    const routing = new ModelRoutingPolicy({ strongModel: 'strong', fastModel: 'fast', enableFastRoutes: true })
    expect(routing.select('classification')).toEqual({ route: 'fast', model: 'fast' })
    expect(routing.select('synthesis')).toEqual({ route: 'strong', model: 'strong' })
  })
})

describe('AdaptiveConcurrencyController', () => {
  it('reduces on rate limiting and recovers only after cooldown', () => {
    const controller = new AdaptiveConcurrencyController(4)
    expect(controller.reportRateLimit(100, 10)).toBe(2)
    expect(controller.limit(50)).toBe(2)
    expect(controller.reportSuccess(110)).toBe(3)
    expect(controller.limit(111)).toBe(4)
  })
})
