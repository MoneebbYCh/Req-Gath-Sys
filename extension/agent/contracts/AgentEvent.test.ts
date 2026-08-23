import { describe, expect, it } from 'vitest'
import { agentEventSchema, parseAgentEvent } from './AgentEvent'
import type { AgentEvent } from '../../../shared/agentProtocol'

function event(partial: Partial<AgentEvent> & { type: AgentEvent['type'] }): AgentEvent {
  return { taskId: 't1', seq: 0, timestamp: 1, ...partial } as AgentEvent
}

describe('AgentEvent contracts (plan §5/§6 runtime validation)', () => {
  it('accepts the complete event catalogue', () => {
    const events: AgentEvent[] = [
      event({ type: 'agentTaskStarted', title: 'T' }),
      event({ type: 'agentActivity', activity: 'Scanning' }),
      event({ type: 'agentPlanUpdated', plan: { nodes: [{ id: 'n1', title: 'A', status: 'running' }] } }),
      event({ type: 'agentAssistantStarted' }),
      event({ type: 'agentAssistantDelta', text: 'hi' }),
      event({ type: 'agentAssistantCompleted' }),
      event({
        type: 'agentDocumentDeclared',
        document: { documentId: 'd1', title: 'PRD', status: 'queued', completedSections: 0, totalSections: 8 },
      }),
      event({
        type: 'agentDocumentProgress',
        document: { documentId: 'd1', title: 'PRD', status: 'generating', completedSections: 3, totalSections: 8 },
      }),
      event({
        type: 'agentDocumentCheckpoint',
        documentId: 'd1',
        title: 'PRD',
        sectionTitle: 'Intro',
        completedSections: 1,
        totalSections: 8,
        conflict: true,
        pendingDraftId: 'pd-1',
      }),
      event({ type: 'agentValidationProgress', phase: 'claim', message: 'Validating', finalStatus: 'completed' }),
      event({ type: 'agentTaskCompleted', summary: 'done' }),
      event({ type: 'agentTaskFailed', error: 'boom' }),
      event({ type: 'agentTaskCancelled' }),
      event({ type: 'agentTaskPaused', reason: 'provider outage' }),
      event({
        type: 'agentSessionSnapshot',
        snapshot: { taskId: 't1', status: 'running', title: 'T', activities: [], assistantText: '' },
      }),
    ]
    for (const e of events) {
      expect(agentEventSchema.safeParse(e).success, e.type).toBe(true)
    }
  })

  it('rejects violations of the envelope invariant', () => {
    expect(agentEventSchema.safeParse(event({ type: 'agentActivity', seq: -1, activity: 'x' })).success).toBe(false)
    expect(
      agentEventSchema.safeParse({ type: 'agentActivity', seq: 0, timestamp: 1, activity: 'x' }).success,
    ).toBe(false) // missing taskId
    expect(
      agentEventSchema.safeParse(event({ type: 'agentDocumentProgress' as never })).success,
    ).toBe(false) // missing document
  })

  it('parseAgentEvent returns null on drift and the parsed event on match', () => {
    expect(parseAgentEvent(null)).toBeNull()
    expect(parseAgentEvent(event({ type: 'agentTaskCancelled' }))?.type).toBe('agentTaskCancelled')
  })
})
