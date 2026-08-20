import { describe, expect, it } from 'vitest'
import {
  grepReadNudge,
  inferToolBudgetProfile,
  inventoryMountNudge,
  maxRoundTrips,
  maxStepsPrompt,
  resolveAgentSteps,
  SAFETY_MAX_STEPS,
} from './agentBudget'

describe('inferToolBudgetProfile', () => {
  it('classifies lookup questions without a tool-call cap', () => {
    const profile = inferToolBudgetProfile('Where is processChat defined?', 'home')
    expect(profile.kind).toBe('inventory')
    expect(profile.steps).toBeUndefined()
    expect(maxRoundTrips(profile)).toBe(SAFETY_MAX_STEPS)
  })

  it('classifies API/endpoint totals as full inventory', () => {
    const profile = inferToolBudgetProfile('hey tell me the total apis and routes in this project', 'home')
    expect(profile.kind).toBe('full-inventory')
  })

  it('classifies drafting separately', () => {
    const profile = inferToolBudgetProfile('Draft the architecture section with a diagram', 'architecture')
    expect(profile.kind).toBe('drafting')
  })
})

describe('resolveAgentSteps', () => {
  it('defaults to unlimited (undefined)', () => {
    const prev = process.env.CHARTER_AGENT_STEPS
    delete process.env.CHARTER_AGENT_STEPS
    expect(resolveAgentSteps()).toBeUndefined()
    if (prev !== undefined) process.env.CHARTER_AGENT_STEPS = prev
  })

  it('honors CHARTER_AGENT_STEPS like OpenCode agent.steps', () => {
    const prev = process.env.CHARTER_AGENT_STEPS
    process.env.CHARTER_AGENT_STEPS = '12'
    expect(resolveAgentSteps()).toBe(12)
    expect(maxRoundTrips(inferToolBudgetProfile('hello', 'home'))).toBe(12)
    if (prev === undefined) delete process.env.CHARTER_AGENT_STEPS
    else process.env.CHARTER_AGENT_STEPS = prev
  })
})

describe('grepReadNudge', () => {
  it('nudges after grep-only batch when read_file not seen', () => {
    expect(grepReadNudge(['grep'], false)).toMatch(/read_file/)
  })

  it('skips nudge when read_file in same batch', () => {
    expect(grepReadNudge(['grep', 'read_file'], false)).toBeNull()
  })

  it('skips nudge when read_file already used earlier', () => {
    expect(grepReadNudge(['grep'], true)).toBeNull()
  })
})

describe('inventoryMountNudge', () => {
  it('fires once for full-inventory profiles', () => {
    const profile = inferToolBudgetProfile('enumerate all API routes', 'home')
    expect(inventoryMountNudge(profile, false)).toMatch(/UNREAD/)
    expect(inventoryMountNudge(profile, true)).toBeNull()
  })

  it('skips lookup-style inventory', () => {
    const profile = inferToolBudgetProfile('Where is processChat defined?', 'home')
    expect(inventoryMountNudge(profile, false)).toBeNull()
  })
})

describe('maxStepsPrompt', () => {
  it('disables tools and asks for VERIFIED vs UNREAD', () => {
    expect(maxStepsPrompt('home')).toMatch(/MAXIMUM STEPS/)
    expect(maxStepsPrompt('home')).toMatch(/VERIFIED/)
    expect(maxStepsPrompt('home')).toMatch(/Do NOT make any tool calls/)
  })
})
