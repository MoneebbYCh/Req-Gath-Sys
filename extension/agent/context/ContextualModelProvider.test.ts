import { describe, expect, it } from 'vitest'
import type { ModelEvent, ModelRequest } from '../model/ModelTypes'
import type { ModelProvider } from '../model/ModelProvider'
import { SessionStore } from '../session'
import { ContextualModelProvider } from './ContextualModelProvider'

class CapturingProvider implements ModelProvider {
  request?: ModelRequest

  async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
    this.request = request
    yield { type: 'finish', reason: 'stop' }
  }
}

describe('ContextualModelProvider', () => {
  it('adds durable session, fact and evidence context at the sole model boundary', async () => {
    const sessions = new SessionStore()
    sessions.getOrCreate('ws')
    sessions.recordUserTurn('old-task', 'Earlier objective')
    sessions.recordAssistantTurn({
      taskId: 'old-task',
      content: 'Earlier outcome',
      decisions: ['Use typed repository tools'],
      evidenceIds: ['ev-1'],
      factIds: ['fact-1'],
    })
    const delegate = new CapturingProvider()
    const provider = new ContextualModelProvider(delegate, {
      session: () => sessions.snapshot(),
      findings: () => [{
        id: 'finding-1', claim: 'Auth uses middleware', type: 'observed', domain: 'auth', evidenceIds: ['ev-1'],
        confidence: 'high', assumptions: [], contradictions: [], repositoryVersion: 'r1',
      }],
      facts: () => [{
        id: 'fact-1', key: 'auth.middleware', statement: 'Auth is middleware based', domain: 'auth', sourceFindingIds: ['finding-1'], evidenceIds: ['ev-1'], confidence: 'high', repositoryVersion: 'r1', updatedAt: 1,
      }],
      evidence: () => [{
        id: 'ev-1', repositoryVersion: 'r1', path: 'src/auth.ts', contentHash: 'hash', range: { startLine: 1, endLine: 3 }, kind: 'source', excerpt: 'authenticate()', sourceTool: 'read_file', createdAt: 1,
      }],
      projectInstructions: () => ['Follow the repository contribution guide.', 'Do not modify source files.'],
    })

    for await (const _ of provider.stream({
      model: 'test', system: 'SYSTEM', messages: [{ role: 'user', content: 'Current objective' }], tools: [],
    }, new AbortController().signal)) { /* exhaust */ }

    expect(delegate.request!.system).toContain('SYSTEM')
    expect(delegate.request!.system).toContain('Current objective')
    expect(delegate.request!.system).toContain('[FACT:fact-1]')
    expect(delegate.request!.system).toContain('[EVIDENCE:ev-1]')
    expect(delegate.request!.system).toContain('Earlier outcome')
    expect(delegate.request!.system).toContain('Follow the repository contribution guide.')
  })

  it('adds explicit task-node and request instructions without leaking runtime metadata to the provider', async () => {
    const delegate = new CapturingProvider()
    const provider = new ContextualModelProvider(delegate, {
      session: () => undefined,
      findings: () => [],
      facts: () => [],
      evidence: () => [],
      projectInstructions: () => ['Use UK spelling.'],
    })

    for await (const _ of provider.stream({
      model: 'test', system: 'SYSTEM', messages: [{ role: 'user', content: 'Review authentication.' }], tools: [],
      context: {
        task: { taskId: 'task-7', nodeId: 'node-auth', title: 'Authentication review', objective: 'Find auth gaps.', status: 'running', dependencies: ['node-map'] },
        instructions: ['Prioritize security findings.'],
      },
    }, new AbortController().signal)) { /* exhaust */ }

    expect(delegate.request!.system).toContain('Current task state:')
    expect(delegate.request!.system).toContain('Node: node-auth (Authentication review)')
    expect(delegate.request!.system).toContain('Node objective: Find auth gaps.')
    expect(delegate.request!.system).toContain('Dependencies: node-map')
    expect(delegate.request!.system).toContain('Use UK spelling.')
    expect(delegate.request!.system).toContain('Prioritize security findings.')
    expect(delegate.request!.context).toBeUndefined()
  })
})
