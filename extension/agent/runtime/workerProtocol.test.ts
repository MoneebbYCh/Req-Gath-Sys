import { describe, expect, it } from 'vitest'
import { emptyState } from '../state/PersistedState'
import { parseHostToWorkerMessage, parseWorkerToHostMessage } from './workerProtocol'

describe('worker protocol runtime schemas', () => {
  it('accepts every valid host-to-worker command', () => {
    const state = emptyState('workspace', 'fingerprint')
    const messages = [
      { type: 'start', requestId: 'request-1', text: 'Inspect auth', surface: { page: 'home' } },
      { type: 'cancel', taskId: 'task-1' },
      { type: 'resume', taskId: 'task-1' },
      { type: 'snapshot' },
      { type: 'toolResult', callId: 'call-1', ok: true, result: { data: [] } },
      { type: 'documentResult', callId: 'call-1', ok: false, error: 'conflict' },
      { type: 'statePersistAck', persistenceId: 'persist-1', ok: true },
    ]
    expect(messages.every((message) => parseHostToWorkerMessage(message))).toBe(true)
    expect(parseWorkerToHostMessage({ type: 'statePersist', persistenceId: 'persist-1', state })).not.toBeNull()
    expect(parseWorkerToHostMessage({ type: 'diagnostic', diagnostic: { event: 'model.completed', taskId: 'task-1', model: 'gpt', durationMs: 10, inputTokens: 4, outputTokens: 2, ok: true } })).not.toBeNull()
  })

  it('rejects malformed and unknown host-to-worker commands', () => {
    expect(parseHostToWorkerMessage({ type: 'start', requestId: '', text: 'x', surface: { page: 'home' } })).toBeNull()
    expect(parseHostToWorkerMessage({ type: 'cancel', taskId: 42 })).toBeNull()
    expect(parseHostToWorkerMessage({ type: 'documentResult', callId: 'd', ok: 'yes' })).toBeNull()
    expect(parseHostToWorkerMessage({ type: 'deleteWorkspace', path: '/' })).toBeNull()
  })

  it('accepts document-structure diagnostics emitted by the document worker (plan §13)', () => {
    const message = {
      type: 'diagnostic',
      diagnostic: {
        event: 'document.completed',
        taskId: 'task-1',
        nodeId: 'node-1',
        workerType: 'document',
        documentEvent: 'section_parse_attempt',
        documentOperation: 'generate',
        sectionIndex: 0,
        attempt: 1,
        parseOutcome: 'valid',
        responseBytes: 100,
        jsonExtracted: true,
        blockCount: 3,
        schemaIssueCount: 0,
        schemaIssueCodes: [],
        checkpointPending: false,
        ok: true,
      },
    }
    expect(parseWorkerToHostMessage(message)).not.toBeNull()
    // A leaked content field is still rejected (strict schema).
    expect(
      parseWorkerToHostMessage({ type: 'diagnostic', diagnostic: { event: 'x', documentEvent: 'section_parse_attempt', prompt: 'secret' } }),
    ).toBeNull()
  })

  it('rejects malformed worker events, tool requests, document checkpoints, and persistence', () => {
    expect(parseWorkerToHostMessage({ type: 'event', event: { type: 'unknown', taskId: 't', seq: 0, timestamp: 0 } })).toBeNull()
    expect(parseWorkerToHostMessage({ type: 'event', event: { type: 'agentTaskStarted', taskId: 4, seq: 0, timestamp: 0, title: 'x' } })).toBeNull()
    expect(parseWorkerToHostMessage({
      type: 'event',
      event: { type: 'agentDocumentCheckpoint', taskId: 't', seq: 1, timestamp: 0, documentId: 'd', title: 'D', completedSections: -1, totalSections: 2 },
    })).toBeNull()
    expect(parseWorkerToHostMessage({ type: 'toolCall', callId: '', name: 'search_code', input: {} })).toBeNull()
    expect(parseWorkerToHostMessage({ type: 'documentCall', callId: 'd', op: 'deleteDocument', payload: {} })).toBeNull()
    expect(parseWorkerToHostMessage({ type: 'statePersist', persistenceId: 'p', state: { version: 99 } })).toBeNull()
    expect(parseWorkerToHostMessage({ type: 'diagnostic', diagnostic: { event: 'leak', prompt: 'secret' } })).toBeNull()
  })
})
