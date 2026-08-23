import { describe, expect, it, vi } from 'vitest'
import { AgentRuntimeClient, type WorkerPort } from './AgentRuntimeClient'
import type { AgentEvent } from '../../shared/agentProtocol'

class FakeWorker implements WorkerPort {
  posted: unknown[] = []
  terminated = false
  private listeners = new Map<string, ((v: unknown) => void)[]>()

  postMessage(value: unknown): void {
    this.posted.push(value)
  }

  on(event: 'message' | 'error' | 'exit', listener: (value: unknown) => void): void {
    const arr = this.listeners.get(event) ?? []
    arr.push(listener)
    this.listeners.set(event, arr)
  }

  terminate(): Promise<number> {
    this.terminated = true
    return Promise.resolve(0)
  }

  emit(event: 'message' | 'error' | 'exit', value: unknown): void {
    for (const l of this.listeners.get(event) ?? []) l(value)
  }
}

function setup(fake: FakeWorker): { client: AgentRuntimeClient; events: AgentEvent[] } {
  const client = new AgentRuntimeClient('/tmp/agent-worker.cjs', { workspaceId: 'ws' }, () => fake)
  const events: AgentEvent[] = []
  client.onEvent((e) => events.push(e))
  return { client, events }
}

const started = (taskId: string, seq = 0): AgentEvent => ({
  type: 'agentTaskStarted',
  taskId,
  seq,
  timestamp: 0,
  title: 'x',
})

describe('AgentRuntimeClient', () => {
  it('forwards start/cancel/resume/snapshot and relays events', () => {
    const fake = new FakeWorker()
    const { client, events } = setup(fake)

    client.start('r1', 'hello', { page: 'home' })
    expect(fake.posted).toEqual([{ type: 'start', requestId: 'r1', text: 'hello', surface: { page: 'home' } }])

    fake.emit('message', { type: 'event', event: started('t') })
    expect(events).toHaveLength(1)

    client.cancel('t')
    client.resume('t')
    client.sendSnapshot()
    expect(fake.posted.map((p) => (p as { type: string }).type)).toEqual([
      'start',
      'cancel',
      'resume',
      'snapshot',
    ])
  })

  it('synthesizes a structured failure for a running task on worker error', () => {
    const fake = new FakeWorker()
    const { events } = setup(fake)
    fake.emit('message', { type: 'event', event: started('t', 0) })
    fake.emit('message', {
      type: 'event',
      event: { type: 'agentAssistantDelta', taskId: 't', seq: 3, timestamp: 0, text: 'x' },
    })
    fake.emit('error', new Error('boom'))

    const failure = events.find((e) => e.type === 'agentTaskFailed')
    expect(failure).toBeTruthy()
    expect(failure!.taskId).toBe('t')
    expect(failure!.seq).toBe(4) // > last seen seq so the webview accepts it
    expect((failure as Extract<AgentEvent, { type: 'agentTaskFailed' }>).error).toContain('boom')
  })

  it('reports a worker startup failure even before the task-started event arrives', () => {
    const fake = new FakeWorker()
    const { client, events } = setup(fake)

    client.start('request-before-start', 'hello', { page: 'home' })
    fake.emit('error', new Error('worker bootstrap failed'))

    expect(events).toEqual([
      expect.objectContaining({ type: 'agentTaskStarted', taskId: 'request-before-start' }),
      expect.objectContaining({
        type: 'agentTaskFailed',
        taskId: 'request-before-start',
        error: expect.stringContaining('worker bootstrap failed'),
      }),
    ])
  })

  it('does not fail an already-completed task on worker exit', () => {
    const fake = new FakeWorker()
    const { events } = setup(fake)
    fake.emit('message', { type: 'event', event: started('t', 0) })
    fake.emit('message', {
      type: 'event',
      event: { type: 'agentTaskCompleted', taskId: 't', seq: 1, timestamp: 0 },
    })
    fake.emit('exit', 1)
    expect(events.some((e) => e.type === 'agentTaskFailed')).toBe(false)
  })

  it('drops invalid worker events at the protocol boundary', () => {
    const fake = new FakeWorker()
    const { events } = setup(fake)
    fake.emit('message', { type: 'event', event: { type: 'agentTaskStarted', taskId: 42 } })
    expect(events).toEqual([])
  })

  it('forwards content-free worker telemetry and logs lifecycle without answer text', () => {
    const fake = new FakeWorker()
    const diagnostics: unknown[] = []
    const client = new AgentRuntimeClient('/tmp/agent-worker.cjs', { workspaceId: 'ws' }, () => fake, {
      diagnostic: (event) => diagnostics.push(event),
    })
    fake.emit('message', { type: 'diagnostic', diagnostic: { event: 'model.completed', taskId: 't', model: 'mock', inputTokens: 2, outputTokens: 3, ok: true } })
    fake.emit('message', { type: 'event', event: { ...started('t'), title: 'secret user request' } })
    fake.emit('message', { type: 'event', event: { type: 'agentAssistantDelta', taskId: 't', seq: 1, timestamp: 0, text: 'private model response' } })
    expect(diagnostics).toContainEqual(expect.objectContaining({ event: 'model.completed', taskId: 't', model: 'mock' }))
    expect(diagnostics).toContainEqual(expect.objectContaining({ event: 'agent.taskstarted', taskId: 't' }))
    expect(JSON.stringify(diagnostics)).not.toContain('secret user request')
    expect(JSON.stringify(diagnostics)).not.toContain('private model response')
    client.dispose()
  })

  it('drops malformed worker RPC commands before they reach host services', async () => {
    const fake = new FakeWorker()
    const toolHandler = vi.fn()
    const documentHandler = vi.fn()
    const client = new AgentRuntimeClient('/tmp/agent-worker.cjs', { workspaceId: 'ws' }, () => fake, {
      toolHandler,
      documentHandler,
    })

    fake.emit('message', { type: 'toolCall', callId: '', name: 'search_code', input: {} })
    fake.emit('message', { type: 'documentCall', callId: 'd', op: 'deleteDocument', payload: {} })
    fake.emit('message', {
      type: 'event',
      event: { type: 'agentDocumentCheckpoint', taskId: 't', seq: 1, timestamp: 0, documentId: 'd', title: 'D', completedSections: -1, totalSections: 1 },
    })
    fake.emit('message', { type: 'unknownCommand' })
    await new Promise((resolve) => setTimeout(resolve, 5))

    expect(toolHandler).not.toHaveBeenCalled()
    expect(documentHandler).not.toHaveBeenCalled()
    expect(fake.posted).toEqual([])
    client.dispose()
  })

  it('dispose terminates the worker without emitting a failure', () => {
    const fake = new FakeWorker()
    const { client, events } = setup(fake)
    fake.emit('message', { type: 'event', event: started('t', 0) })
    client.dispose()
    fake.emit('exit', 1) // disposed → ignored
    expect(fake.terminated).toBe(true)
    expect(events.some((e) => e.type === 'agentTaskFailed')).toBe(false)
  })

  it('routes worker tool calls through the host handler', async () => {
    const fake = new FakeWorker()
    const handler = vi.fn(async (call: { name: string; input: unknown }) => {
      expect(call.name).toBe('search_code')
      expect(call.input).toEqual({ pattern: 'auth' })
      return {
        ok: true,
        result: { data: { matches: [{ path: 'src/auth.ts' }] }, truncated: false, repositoryVersion: 'v1' },
      }
    })
    const client = new AgentRuntimeClient('/tmp/agent-worker.cjs', { workspaceId: 'ws' }, () => fake, {
      toolHandler: handler,
    })

    fake.emit('message', { type: 'toolCall', callId: 'c1', name: 'search_code', input: { pattern: 'auth' } })
    await new Promise((r) => setTimeout(r, 10))

    expect(handler).toHaveBeenCalledTimes(1)
    const reply = fake.posted[0] as { type: string; callId: string; ok: boolean }
    expect(reply).toMatchObject({ type: 'toolResult', callId: 'c1', ok: true })
    client.dispose()
  })

  it('answers tool calls with a structured error when no handler exists', async () => {
    const fake = new FakeWorker()
    const client = new AgentRuntimeClient('/tmp/agent-worker.cjs', { workspaceId: 'ws' }, () => fake)
    fake.emit('message', { type: 'toolCall', callId: 'c2', name: 'search_code', input: {} })
    await new Promise((r) => setTimeout(r, 10))
    const reply = fake.posted[0] as { type: string; ok: boolean; error: string }
    expect(reply.ok).toBe(false)
    expect(reply.error).toContain('No repository tools')
    client.dispose()
  })

  it('worker toolCancel aborts the in-flight host-side tool execution (plan §7)', async () => {
    const fake = new FakeWorker()
    let receivedSignal: AbortSignal | undefined
    const handler = vi.fn(
      async (_call: { name: string; input: unknown }, signal: AbortSignal) => {
        receivedSignal = signal
        // Simulate an abortable long-running tool: resolve when aborted.
        await new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => resolve(), { once: true })
        })
        return { ok: false, error: 'aborted' }
      },
    )
    const client = new AgentRuntimeClient('/tmp/agent-worker.cjs', { workspaceId: 'ws' }, () => fake, {
      toolHandler: handler,
    })

    fake.emit('message', { type: 'toolCall', callId: 'c3', name: 'search_code', input: {} })
    await new Promise((r) => setTimeout(r, 10))
    expect(receivedSignal?.aborted).toBe(false)

    fake.emit('message', { type: 'toolCancel', callId: 'c3' })
    await new Promise((r) => setTimeout(r, 10))
    expect(receivedSignal!.aborted).toBe(true)
    const reply = fake.posted[0] as { type: string; callId: string; ok: boolean }
    expect(reply).toMatchObject({ type: 'toolResult', callId: 'c3', ok: false })
    client.dispose()
  })
})
