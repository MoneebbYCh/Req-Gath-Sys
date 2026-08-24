import { describe, expect, it } from 'vitest'
import {
  grepReadNudge,
  inferPromptMode,
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
    expect(profile.promptMode).toBe('research')
    expect(profile.steps).toBeUndefined()
    expect(maxRoundTrips(profile)).toBe(SAFETY_MAX_STEPS)
  })

  it('classifies API/endpoint totals as full inventory', () => {
    const profile = inferToolBudgetProfile('hey tell me the total apis and routes in this project', 'home')
    expect(profile.kind).toBe('full-inventory')
    expect(profile.promptMode).toBe('research')
  })

  it('classifies drafting separately', () => {
    const profile = inferToolBudgetProfile('Draft the architecture section with a diagram', 'architecture')
    expect(profile.kind).toBe('drafting')
    expect(profile.promptMode).toBe('draft')
  })
})

describe('inferPromptMode', () => {
  it('prefers draft when writing content', () => {
    expect(inferPromptMode('draft a BRD and add it to the pipeline', 'home')).toBe('draft')
  })

  it('uses pipeline for Home slot management without drafting', () => {
    expect(inferPromptMode('list the docs on the pipeline', 'home')).toBe('pipeline')
    expect(inferPromptMode('what docs exist?', 'home')).toBe('pipeline')
  })

  it('defaults to research for Q&A', () => {
    expect(inferPromptMode('Where is processChat defined?', 'home')).toBe('research')
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
    const nudge = grepReadNudge(['grep'], false)
    expect(nudge).toMatch(/read_file/)
    expect(nudge).toMatch(/<system-reminder>/)
  })

  it('skips nudge when read_file in same batch', () => {
    expect(grepReadNudge(['grep', 'read_file'], false)).toBeNull()
  })

  it('skips nudge when read_file already used earlier', () => {
    expect(grepReadNudge(['grep'], true)).toBeNull()
  })
})

describe('inventoryMountNudge', () => {
  it('fires once for full-inventory profiles with system-reminder', () => {
    const profile = inferToolBudgetProfile('enumerate all API routes', 'home')
    const nudge = inventoryMountNudge(profile, false)
    expect(nudge).toMatch(/UNREAD/)
    expect(nudge).toMatch(/grep/)
    expect(nudge).toMatch(/<system-reminder>/)
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
    expect(maxStepsPrompt('home')).toMatch(/<system-reminder>/)
  })
})
