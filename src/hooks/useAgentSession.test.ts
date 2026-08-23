import { describe, expect, it } from 'vitest'
import {
  agentReducer,
  eventToAction,
  type AgentUiState,
} from './useAgentSession'
import type { AgentEvent } from '../../shared/agentProtocol'

function base(): AgentUiState {
  return {
    sessionId: null,
    activeTaskId: null,
    messages: [],
    activities: [],
    documents: [],
    taskStatus: 'idle',
  }
}

function event(partial: Partial<AgentEvent> & { type: AgentEvent['type']; taskId: string }): AgentEvent {
  return { seq: 0, timestamp: 1, ...partial } as AgentEvent
}

describe('agentReducer', () => {
  it('creates one assistant bubble and appends deltas to it', () => {
    let s = base()
    s = agentReducer(s, eventToAction(event({ type: 'agentTaskStarted', taskId: 't' })))
    expect(s.taskStatus).toBe('running')

    s = agentReducer(s, eventToAction(event({ type: 'agentAssistantStarted', taskId: 't' })))
    expect(s.messages.filter((m) => m.role === 'assistant')).toHaveLength(1)

    s = agentReducer(s, eventToAction(event({ type: 'agentAssistantDelta', taskId: 't', text: 'Hello ' })))
    s = agentReducer(s, eventToAction(event({ type: 'agentAssistantDelta', taskId: 't', text: 'world' })))
    expect(s.messages.filter((m) => m.role === 'assistant')).toHaveLength(1)
    expect(s.messages.find((m) => m.role === 'assistant')!.text).toBe('Hello world')
  })

  it('tracks activities and keeps them bounded', () => {
    let s = base()
    for (let i = 0; i < 60; i++) {
      s = agentReducer(s, { type: 'activity', taskId: 't', activity: `act ${i}`, timestamp: i })
    }
    expect(s.activities).toHaveLength(50)
    expect(s.activities[0].text).toBe('act 10') // oldest 10 dropped
  })

  it('preserves partial assistant text on failure, marks it incomplete, and sets error (plan §23.7)', () => {
    let s = base()
    s = agentReducer(s, eventToAction(event({ type: 'agentAssistantDelta', taskId: 't', text: 'partial' })))
    s = agentReducer(s, eventToAction(event({ type: 'agentTaskFailed', taskId: 't', error: 'provider 500' })))
    expect(s.taskStatus).toBe('failed')
    expect(s.error).toBe('provider 500')
    const assistant = s.messages.find((m) => m.role === 'assistant')!
    expect(assistant.text).toBe('partial')
    expect(assistant.incomplete).toBe(true)
  })

  it('agentTaskPaused sets the paused status with the reason as activity', () => {
    let s = base()
    s = agentReducer(s, eventToAction(event({ type: 'agentTaskStarted', taskId: 't' })))
    s = agentReducer(
      s,
      eventToAction(event({ type: 'agentTaskPaused', taskId: 't', reason: 'Interrupted by restart.' })),
    )
    expect(s.taskStatus).toBe('paused')
    expect(s.activities.some((a) => a.text.includes('Interrupted by restart'))).toBe(true)
  })

  it('reconstructs failed-task snapshots with the incomplete marker', () => {
    let s = base()
    s = agentReducer(s, {
      type: 'snapshot',
      snapshot: {
        taskId: 't',
        status: 'failed',
        title: 'x',
        activities: [],
        assistantText: 'partial answer',
        error: 'boom',
      },
    })
    expect(s.taskStatus).toBe('failed')
    expect(s.messages.find((m) => m.role === 'assistant')!.incomplete).toBe(true)
  })

  it('reconstructs state from a snapshot', () => {
    let s = base()
    s = agentReducer(s, {
      type: 'snapshot',
      snapshot: {
        taskId: 't',
        status: 'running',
        title: 'Where is auth?',
        activities: ['Scanning repository'],
        assistantText: 'partial answer',
      },
    })
    expect(s.activeTaskId).toBe('t')
    expect(s.taskStatus).toBe('running')
    expect(s.activities.map((a) => a.text)).toEqual(['Scanning repository'])
    expect(s.messages.find((m) => m.role === 'assistant')!.text).toBe('partial answer')
  })

  it('clear resets to welcome state', () => {
    let s = base()
    s = agentReducer(s, eventToAction(event({ type: 'agentAssistantDelta', taskId: 't', text: 'x' })))
    s = agentReducer(s, { type: 'clear' })
    expect(s.messages).toHaveLength(1)
    expect(s.taskStatus).toBe('idle')
    expect(s.activeTaskId).toBeNull()
  })

  it('tracks per-document progress and checkpoints (plan §12)', () => {
    let s = base()
    s = agentReducer(s, eventToAction(event({ type: 'agentTaskStarted', taskId: 't' })))
    s = agentReducer(
      s,
      eventToAction(
        event({
          type: 'agentDocumentDeclared',
          taskId: 't',
          document: {
            documentId: 'doc-1',
            title: 'PRD',
            status: 'queued',
            completedSections: 0,
            totalSections: 0,
          },
        }),
      ),
    )
    expect(s.documents).toHaveLength(1)

    s = agentReducer(
      s,
      eventToAction(
        event({
          type: 'agentDocumentProgress',
          taskId: 't',
          document: {
            documentId: 'doc-1',
            title: 'PRD',
            status: 'generating',
            completedSections: 1,
            totalSections: 4,
          },
        }),
      ),
    )
    expect(s.documents[0]).toMatchObject({ status: 'generating', completedSections: 1, totalSections: 4 })

    s = agentReducer(
      s,
      eventToAction(event({ type: 'agentDocumentCheckpoint', taskId: 't', documentId: 'doc-1', completedSections: 2, totalSections: 4 })),
    )
    expect(s.documents[0].completedSections).toBe(2)
  })

  it('moves documents through validating → completed/failed and logs validation activity (plan §13)', () => {
    let s = base()
    s = agentReducer(s, eventToAction(event({ type: 'agentTaskStarted', taskId: 't' })))
    s = agentReducer(
      s,
      eventToAction(
        event({
          type: 'agentDocumentProgress',
          taskId: 't',
          document: {
            documentId: 'doc-1',
            title: 'PRD',
            status: 'generating',
            completedSections: 4,
            totalSections: 4,
          },
        }),
      ),
    )

    s = agentReducer(
      s,
      eventToAction(
        event({
          type: 'agentValidationProgress',
          taskId: 't',
          phase: 'claim',
          message: 'Validating repository claims in PRD',
          documentId: 'doc-1',
        }),
      ),
    )
    expect(s.documents[0].status).toBe('validating')
    expect(s.activities.at(-1)!.text).toBe('Validating repository claims in PRD')

    s = agentReducer(
      s,
      eventToAction(
        event({
          type: 'agentValidationProgress',
          taskId: 't',
          phase: 'claim',
          message: 'Validation FAILED for PRD: 1 section contradicts evidence.',
          documentId: 'doc-1',
          finalStatus: 'failed',
        }),
      ),
    )
    expect(s.documents[0].status).toBe('failed')
    expect(s.documents[0].error).toContain('FAILED')
  })
})
