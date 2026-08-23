import { describe, expect, it } from 'vitest'
import { AdaptiveConcurrencyController, ModelRoutingPolicy, TaskBudgetController } from './TaskControls'

const budget = { maxModelCalls: 2, maxToolCalls: 2, maxInputTokens: 100, maxOutputTokens: 80, maxParallelWorkers: 4, maxReplans: 1 }

describe('TaskBudgetController', () => {
  it('atomically reserves shared model and tool capacity', () => {
    const controls = new TaskBudgetController(budget, { inputPerMillion: 2, outputPerMillion: 8 })
    const first = controls.tryReserveModel(40, 40)
    expect(first).toEqual({ inputTokens: 40, outputTokens: 40 })
    expect(controls.tryReserveModel(61, 40)).toBeNull()
    expect(controls.tryReserveTool()).toBe(true)
    expect(controls.tryReserveTool()).toBe(true)
    expect(controls.tryReserveTool()).toBe(false)
    controls.settleModel(first!, { inputTokens: 30, outputTokens: 20 })
    expect(controls.snapshot()).toMatchObject({ modelCalls: 1, toolCalls: 2, inputTokens: 30, outputTokens: 20 })
    expect(controls.snapshot().estimatedCost).toBeCloseTo(0.00022)
  })

  it('flags approaching limits before silently claiming completion', () => {
    const controls = new TaskBudgetController(budget)
    controls.tryReserveModel(80, 64)
    expect(controls.isApproaching()).toBe(true)
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
