import { describe, expect, it } from 'vitest'
import { agentSessionSchema, SessionStore } from './session'

describe('SessionStore', () => {
  it('creates one active session per workspace and archives on switch', () => {
    const store = new SessionStore()
    const s1 = store.getOrCreate('ws-a')
    expect(s1.workspaceId).toBe('ws-a')
    expect(s1.status).toBe('active')
    expect(agentSessionSchema.parse(s1)).toEqual(s1)

    // same workspace returns the same session
    expect(store.getOrCreate('ws-a').id).toBe(s1.id)

    // switching workspaces archives the old and creates a new active session
    const s2 = store.getOrCreate('ws-b')
    expect(s2.id).not.toBe(s1.id)
    expect(s2.status).toBe('active')
    expect(s1.status).toBe('archived')
  })

  it('touch updates updatedAt', () => {
    const store = new SessionStore()
    const s = store.getOrCreate('ws')
    const before = s.updatedAt
    store.touch()
    expect(store.current()!.updatedAt).toBeGreaterThanOrEqual(before)
  })

  it('stores the compaction summary on the active session (plan §7)', () => {
    const store = new SessionStore()
    expect(store.summary()).toBeUndefined()
    store.getOrCreate('ws')
    store.setSummary('Earlier work: auth uses JWT middleware.')
    expect(store.summary()).toBe('Earlier work: auth uses JWT middleware.')
    expect(agentSessionSchema.parse(store.current()!).conversationSummary).toBe(
      'Earlier work: auth uses JWT middleware.',
    )
  })

  it('compacts old turns without losing objectives, decisions, evidence, or fact ids', () => {
    const store = new SessionStore()
    store.getOrCreate('ws')
    for (let index = 0; index < 13; index++) {
      store.recordUserTurn(`task-${index}`, `Objective ${index}: ${'x'.repeat(1_000)}`)
      store.recordAssistantTurn({
        taskId: `task-${index}`,
        content: `Decision ${index}`,
        decisions: [`Decision ${index}`],
        evidenceIds: [`evidence-${index}`],
        factIds: [`fact-${index}`],
      })
    }

    const session = store.current()!
    expect(session.turns.length).toBeLessThanOrEqual(12)
    expect(session.conversationSummary).toContain('Objectives:')
    expect(session.conversationSummary).toContain('Decisions:')
    expect(session.conversationSummary).toContain('evidence-0')
    expect(session.conversationSummary).toContain('fact-0')
  })

  it('restores a durable session including turn history', () => {
    const source = new SessionStore()
    source.getOrCreate('ws')
    source.recordUserTurn('task-1', 'Explain authentication')
    const restored = new SessionStore()
    restored.restore(source.snapshot())

    expect(restored.current()).toMatchObject({ workspaceId: 'ws' })
    expect(restored.current()!.turns[0]).toMatchObject({ taskId: 'task-1', role: 'user' })
  })

  it('reset wipes turns and summary', () => {
    const store = new SessionStore()
    store.getOrCreate('ws')
    store.recordUserTurn('task-1', 'Architecture is on the dashboard')
    store.setSummary('Docs exist')
    const next = store.reset('ws')
    expect(next.turns).toEqual([])
    expect(next.conversationSummary).toBeUndefined()
    expect(store.summary()).toBeUndefined()
  })
})
