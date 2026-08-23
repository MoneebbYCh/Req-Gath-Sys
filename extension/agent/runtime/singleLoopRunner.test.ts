import { describe, expect, it, vi } from 'vitest'
import { AgentRuntime } from './AgentRuntime'
import { singleLoopRunner } from './singleLoopRunner'
import type { AgentEvent } from '../../../shared/agentProtocol'
import type { ModelProvider } from '../model/ModelProvider'
import type { ModelRequest } from '../model/ModelTypes'
import type { ToolExecutor } from '../model/toolLoopTaskRunner'
import type { TaskNode } from '../contracts/TaskGraph'
import type { NodeRunContext, NodeRunResult } from './runTaskGraph'
import { Planner } from '../planner/Planner'
import { Scheduler } from '../workers/Scheduler'

function collect(runtime: AgentRuntime): AgentEvent[] {
  const events: AgentEvent[] = []
  runtime.onEvent((e) => events.push(e))
  return events
}

function tick(ms = 0): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

const noopExecutor: ToolExecutor = { execute: async () => ({ ok: false, error: 'unexpected host tool call' }) }

describe('singleLoopRunner', () => {
  it('routes write_plan to the live plan UI without touching the host executor', async () => {
    const provider: ModelProvider = {
      async *stream(request: ModelRequest) {
        const hasTool = request.messages.some((m) => m.role === 'tool')
        if (!hasTool) {
          yield { type: 'tool_call_started', id: 'c1', name: 'write_plan' }
          yield {
            type: 'tool_call_completed', id: 'c1', name: 'write_plan',
            arguments: JSON.stringify({ items: [{ title: 'Step one' }, { title: 'Step two', status: 'completed' }] }),
          }
          yield { type: 'finish', reason: 'tool_calls' }
          return
        }
        yield { type: 'text_delta', text: 'planned' }
        yield { type: 'finish', reason: 'stop' }
      },
    }
    const hostExecutor: ToolExecutor = { execute: vi.fn(async () => ({ ok: true, result: {} })) }
    const runtime = new AgentRuntime(singleLoopRunner({ provider, executor: hostExecutor, config: { model: 't' } }))
    const events = collect(runtime)
    runtime.start({ requestId: 'p1', text: 'Plan this out', surface: { page: 'home' } })
    await tick(20)

    expect(hostExecutor.execute).not.toHaveBeenCalled()
    const plan = events
      .filter((e): e is Extract<AgentEvent, { type: 'agentPlanUpdated' }> => e.type === 'agentPlanUpdated')
      .at(-1)
    expect(plan?.plan.nodes).toHaveLength(2)
    expect(plan?.plan.nodes[0]).toMatchObject({ title: 'Step one', status: 'queued' })
    expect(plan?.plan.nodes[1]).toMatchObject({ title: 'Step two', status: 'completed' })
    expect(events.at(-1)).toMatchObject({ type: 'agentTaskCompleted' })
  })

  it('answers simple questions directly with no plan', async () => {
    const provider: ModelProvider = {
      async *stream() {
        yield { type: 'text_delta', text: 'Direct answer.' }
        yield { type: 'finish', reason: 'stop' }
      },
    }
    const runtime = new AgentRuntime(singleLoopRunner({ provider, executor: noopExecutor, config: { model: 't' } }))
    const events = collect(runtime)
    runtime.start({ requestId: 'p2', text: 'What is 2+2?', surface: { page: 'home' } })
    await tick(20)

    const deltas = events
      .filter((e): e is Extract<AgentEvent, { type: 'agentAssistantDelta' }> => e.type === 'agentAssistantDelta')
      .map((e) => e.text)
    expect(deltas.join('')).toBe('Direct answer.')
    expect(events.some((e) => e.type === 'agentPlanUpdated')).toBe(false)
    expect(events.at(-1)).toMatchObject({ type: 'agentTaskCompleted' })
  })

  it('instructs the model to answer greetings and non-repository questions without tools', async () => {
    const systems: string[] = []
    const provider: ModelProvider = {
      async *stream(request: ModelRequest) {
        systems.push(request.system)
        yield { type: 'text_delta', text: 'Hello! How can I help?' }
        yield { type: 'finish', reason: 'stop' }
      },
    }
    const runtime = new AgentRuntime(singleLoopRunner({ provider, executor: noopExecutor, config: { model: 't' } }))
    collect(runtime)
    runtime.start({ requestId: 'sys', text: 'Hello', surface: { page: 'home' } })
    await tick(20)

    const system = systems[0]
    expect(system).toContain('Decide what the message needs')
    expect(system).toContain('answer immediately')
    expect(system).toContain('Do not call tools')
    // Still retains the repo/document/plan capabilities.
    expect(system).toContain('repository tools')
    expect(system).toContain('write_plan')
    expect(system).toContain('create_document')
    // Hidden chain-of-thought + few-shot routing examples (prompt-engineering).
    expect(system).toContain('Chain of thought')
    expect(system).toContain('private reasoning')
    expect(system).toContain('"documents"')
    expect(system).toContain('Security review')
  })

  it('passes the configured thinking policy (hidden CoT) to the provider request', async () => {
    const requests: ModelRequest[] = []
    const provider: ModelProvider = {
      async *stream(request: ModelRequest) {
        requests.push(request)
        yield { type: 'text_delta', text: 'ok' }
        yield { type: 'finish', reason: 'stop' }
      },
    }
    const runtime = new AgentRuntime(
      singleLoopRunner({ provider, executor: noopExecutor, config: { model: 't', thinking: 'enabled' } }),
    )
    collect(runtime)
    runtime.start({ requestId: 'think', text: 'Where is auth?', surface: { page: 'home' } })
    await tick(20)

    expect(requests[0]?.thinking).toBe('enabled')
  })

  it('executes multiple repository tools and preserves result order', async () => {
    const provider: ModelProvider = {
      async *stream(request: ModelRequest) {
        const toolMsgs = request.messages.filter((m) => m.role === 'tool')
        if (toolMsgs.length === 0) {
          yield { type: 'tool_call_started', id: 'c1', name: 'search_code' }
          yield { type: 'tool_call_completed', id: 'c1', name: 'search_code', arguments: '{}' }
          yield { type: 'tool_call_started', id: 'c2', name: 'read_file' }
          yield { type: 'tool_call_completed', id: 'c2', name: 'read_file', arguments: '{}' }
          yield { type: 'finish', reason: 'tool_calls' }
          return
        }
        // The second pass must see both tool results in call order.
        expect(toolMsgs.map((m) => m.name)).toEqual(['search_code', 'read_file'])
        yield { type: 'text_delta', text: 'done' }
        yield { type: 'finish', reason: 'stop' }
      },
    }
    const calls: string[] = []
    const hostExecutor: ToolExecutor = {
      execute: vi.fn(async (name) => {
        calls.push(name)
        return { ok: true, result: { matches: [] } }
      }),
    }
    const runtime = new AgentRuntime(
      singleLoopRunner({ provider, executor: hostExecutor, config: { model: 't', parallelToolCalls: 4 } }),
    )
    collect(runtime)
    runtime.start({ requestId: 'p3', text: 'Search and read', surface: { page: 'home' } })
    await tick(20)

    expect(calls).toHaveLength(2)
    expect(calls).toContain('search_code')
    expect(calls).toContain('read_file')
  })

  it('resumes a mid-loop conversation from durable loop state', async () => {
    const provider: ModelProvider = {
      async *stream(request: ModelRequest) {
        // Resumed loop must continue from the checkpointed history, not restart.
        expect(request.messages.some((m) => m.role === 'user' && m.content === 'original question')).toBe(true)
        yield { type: 'text_delta', text: 'resumed answer' }
        yield { type: 'finish', reason: 'stop' }
      },
    }
    const runtime = new AgentRuntime(singleLoopRunner({ provider, executor: noopExecutor, config: { model: 't' } }))
    const events = collect(runtime)
    runtime.restoreTask({
      taskId: 't-resume',
      requestId: 'r-resume',
      text: 'original question',
      surface: { page: 'home' },
      title: 'original question',
      status: 'running',
      assistantText: 'partial',
      activities: [],
      documents: [],
    })
    runtime.resume('t-resume', {
      loopState: {
        messages: [
          { role: 'user', content: 'original question' },
          { role: 'assistant', content: 'partial' },
        ],
        toolCallsUsed: 1,
        modelCallsUsed: 1,
        evidenceIds: ['e-1'],
      },
    })
    await tick(20)

    const deltas = events
      .filter((e): e is Extract<AgentEvent, { type: 'agentAssistantDelta' }> => e.type === 'agentAssistantDelta')
      .map((e) => e.text)
    expect(deltas.join('')).toBe('resumed answer')
    expect(events.at(-1)).toMatchObject({ type: 'agentTaskCompleted' })
  })

  it('create_document runs the document pipeline and streams document events', async () => {
    const provider: ModelProvider = {
      async *stream(request: ModelRequest) {
        const hasTool = request.messages.some((m) => m.role === 'tool')
        if (!hasTool) {
          yield { type: 'tool_call_started', id: 'c1', name: 'create_document' }
          yield { type: 'tool_call_completed', id: 'c1', name: 'create_document', arguments: JSON.stringify({ documents: [{ name: 'PRD' }] }) }
          yield { type: 'finish', reason: 'tool_calls' }
          return
        }
        yield { type: 'text_delta', text: 'document created' }
        yield { type: 'finish', reason: 'stop' }
      },
    }
    const documentRuns: string[] = []
    const runNode = vi.fn(async (node: TaskNode, ctx: NodeRunContext): Promise<NodeRunResult> => {
      if (node.roleSpec.workerType === 'document') {
        documentRuns.push(node.title)
        ctx.documentDeclared({ documentId: 'doc-prd', title: node.title, status: 'queued', completedSections: 0, totalSections: 0 })
      }
      return { outputs: [`out-${node.title}`] }
    })
    const runtime = new AgentRuntime(
      singleLoopRunner({
        provider,
        executor: noopExecutor,
        config: { model: 't' },
        includeDocumentTool: true,
        planner: new Planner({ maxNodes: 8 }),
        scheduler: new Scheduler(),
        runNode,
      }),
    )
    const events = collect(runtime)
    runtime.start({ requestId: 'p4', text: 'Create a PRD', surface: { page: 'home' } })
    await tick(30)

    expect(documentRuns.length).toBeGreaterThan(0)
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'agentDocumentDeclared',
        document: expect.objectContaining({ documentId: 'doc-prd' }),
      }),
    )
    expect(events.some((e) => e.type === 'agentPlanUpdated')).toBe(true)
    expect(events.at(-1)).toMatchObject({ type: 'agentTaskCompleted' })
  })

  it('create_document with multiple titles produces each requested document', async () => {
    const provider: ModelProvider = {
      async *stream(request: ModelRequest) {
        const hasTool = request.messages.some((m) => m.role === 'tool')
        if (!hasTool) {
          yield { type: 'tool_call_started', id: 'c1', name: 'create_document' }
          yield {
            type: 'tool_call_completed', id: 'c1', name: 'create_document',
            arguments: JSON.stringify({ documents: [{ name: 'PRD' }, { name: 'Security review' }] }),
          }
          yield { type: 'finish', reason: 'tool_calls' }
          return
        }
        yield { type: 'text_delta', text: 'documents created' }
        yield { type: 'finish', reason: 'stop' }
      },
    }
    const documentTitles: string[] = []
    const runNode = vi.fn(async (node: TaskNode): Promise<NodeRunResult> => {
      if (node.roleSpec.workerType === 'document') documentTitles.push(node.title)
      return { outputs: [`out-${node.title}`] }
    })
    const runtime = new AgentRuntime(
      singleLoopRunner({
        provider,
        executor: noopExecutor,
        config: { model: 't' },
        includeDocumentTool: true,
        planner: new Planner({ maxNodes: 12 }),
        scheduler: new Scheduler(),
        runNode,
      }),
    )
    collect(runtime)
    runtime.start({ requestId: 'p5', text: 'Create a PRD and a security review', surface: { page: 'home' } })
    await tick(30)

    expect(documentTitles).toContain('PRD')
    expect(documentTitles).toContain('Security review')
  })
})
