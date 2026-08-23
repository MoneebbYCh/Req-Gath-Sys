import { describe, expect, it, vi } from 'vitest'
import { AgentRuntime } from '../runtime/AgentRuntime'
import type { AgentEvent } from '../../../shared/agentProtocol'
import type { ModelProvider } from './ModelProvider'
import type { ModelRequest } from './ModelTypes'
import { ProviderError } from './ProviderError'
import { toolLoopTaskRunner, type ToolExecutor } from './toolLoopTaskRunner'
import type { OperationalDiagnostic } from '../observability/OperationalLogger'

/**
 * Scripted provider: requests a tool on the first pass, answers once a tool
 * result is in the conversation.
 */
const toolThenAnswer: ModelProvider = {
  async *stream(request: ModelRequest) {
    const hasToolResult = request.messages.some((m) => m.role === 'tool')
    if (!hasToolResult) {
      yield { type: 'tool_call_started', id: 'c1', name: 'search_code' }
      yield { type: 'tool_call_delta', id: 'c1', argumentsDelta: '{"pattern":"auth"}' }
      yield { type: 'tool_call_completed', id: 'c1', name: 'search_code', arguments: '{"pattern":"auth"}' }
      yield { type: 'finish', reason: 'tool_calls' }
      return
    }
    yield { type: 'text_delta', text: 'Grounded answer from tool results.' }
    yield { type: 'finish', reason: 'stop' }
  },
}

function collect(runtime: AgentRuntime): AgentEvent[] {
  const events: AgentEvent[] = []
  runtime.onEvent((e) => events.push(e))
  return events
}

function tick(ms = 0): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

describe('toolLoopTaskRunner', () => {
  it('executes tool calls and feeds results back for the final answer', async () => {
    const executor: ToolExecutor = {
      execute: vi.fn(async (name, input) => {
        expect(name).toBe('search_code')
        expect(input).toEqual({ pattern: 'auth' })
        return { ok: true, result: { matches: [{ path: 'src/auth.ts', line: 2 }] } }
      }),
    }
    const runtime = new AgentRuntime(toolLoopTaskRunner(toolThenAnswer, executor, { model: 'test' }))
    const events = collect(runtime)
    runtime.start({ requestId: 't1', text: 'Where is auth?', surface: { page: 'home' } })
    await tick(20)

    expect(executor.execute).toHaveBeenCalledTimes(1)
    const deltas = events
      .filter((e): e is Extract<AgentEvent, { type: 'agentAssistantDelta' }> => e.type === 'agentAssistantDelta')
      .map((e) => e.text)
    expect(deltas.join('')).toBe('Grounded answer from tool results.')

    const activities = events
      .filter((e): e is Extract<AgentEvent, { type: 'agentActivity' }> => e.type === 'agentActivity')
      .map((e) => e.activity)
    expect(activities).toContain('Using tool: search_code')
    expect(activities).toContain('Tool search_code finished')

    expect(events.at(-1)).toMatchObject({ type: 'agentTaskCompleted' })
  })

  it('synthesizes a tool-free answer when iterations exhaust while tools are still requested', async () => {
    // Always requests a tool while tools are offered; answers only on the tool-free pass.
    const alwaysTool: ModelProvider = {
      async *stream(request: ModelRequest) {
        if (request.tools.length === 0) {
          yield { type: 'text_delta', text: 'final synthesis' }
          yield { type: 'finish', reason: 'stop' }
          return
        }
        yield { type: 'tool_call_started', id: 'c1', name: 'search_code' }
        yield { type: 'tool_call_completed', id: 'c1', name: 'search_code', arguments: '{}' }
        yield { type: 'finish', reason: 'tool_calls' }
      },
    }
    const executor: ToolExecutor = { execute: vi.fn(async () => ({ ok: true, result: { x: 1 } })) }
    const runtime = new AgentRuntime(
      toolLoopTaskRunner(alwaysTool, executor, {
        model: 't',
        maxIterations: 2,
        tools: [{ name: 'search_code', description: 'x', inputJsonSchema: {} }],
      }),
    )
    const events = collect(runtime)
    runtime.start({ requestId: 'ts', text: 'x', surface: { page: 'home' } })
    await tick(20)

    const activities = events
      .filter((e): e is Extract<AgentEvent, { type: 'agentActivity' }> => e.type === 'agentActivity')
      .map((e) => e.activity)
    expect(activities).toContain('Synthesizing answer from tool results')
    const deltas = events
      .filter((e): e is Extract<AgentEvent, { type: 'agentAssistantDelta' }> => e.type === 'agentAssistantDelta')
      .map((e) => e.text)
    expect(deltas.join('')).toBe('final synthesis')
  })

  it('treats malformed tool arguments as raw input for the gateway to reject', async () => {
    const malformed: ModelProvider = {
      async *stream(request: ModelRequest) {
        if (request.messages.some((m) => m.role === 'tool')) {
          yield { type: 'text_delta', text: 'done' }
          yield { type: 'finish', reason: 'stop' }
          return
        }
        yield { type: 'tool_call_started', id: 'c1', name: 'read_file' }
        yield { type: 'tool_call_completed', id: 'c1', name: 'read_file', arguments: 'not-json' }
        yield { type: 'finish', reason: 'tool_calls' }
      },
    }
    const executor: ToolExecutor = { execute: vi.fn(async () => ({ ok: true, result: {} })) }
    const runtime = new AgentRuntime(toolLoopTaskRunner(malformed, executor, { model: 't' }))
    collect(runtime)
    runtime.start({ requestId: 't2', text: 'x', surface: { page: 'home' } })
    await tick(20)
    expect(executor.execute).toHaveBeenCalledWith('read_file', { raw: 'not-json' }, expect.any(AbortSignal))
  })

  it('enforces the tool budget and still synthesizes an answer', async () => {
    const executor: ToolExecutor = { execute: vi.fn(async () => ({ ok: true, result: {} })) }
    const runtime = new AgentRuntime(
      toolLoopTaskRunner(toolThenAnswer, executor, { model: 't', maxToolCalls: 0 }),
    )
    const events = collect(runtime)
    runtime.start({ requestId: 't3', text: 'x', surface: { page: 'home' } })
    await tick(20)

    expect(executor.execute).not.toHaveBeenCalled()
    const deltas = events
      .filter((e): e is Extract<AgentEvent, { type: 'agentAssistantDelta' }> => e.type === 'agentAssistantDelta')
      .map((e) => e.text)
    expect(deltas.join('')).toContain('Grounded answer')
  })

  it('enforces per-node model and output budgets', async () => {
    const requests: ModelRequest[] = []
    const provider: ModelProvider = {
      async *stream(request) {
        requests.push(request)
        yield { type: 'tool_call_started', id: `c-${requests.length}`, name: 'search_code' }
        yield { type: 'tool_call_completed', id: `c-${requests.length}`, name: 'search_code', arguments: '{}' }
        yield { type: 'finish', reason: 'tool_calls' }
      },
    }
    const runtime = new AgentRuntime(toolLoopTaskRunner(provider, { execute: async () => ({ ok: true, result: {} }) }, {
      model: 't', maxModelCalls: 1, maxOutputTokens: 321,
    }))
    runtime.start({ requestId: 'budgeted', text: 'x', surface: { page: 'home' } })
    await tick(20)
    expect(requests).toHaveLength(1)
    expect(requests[0].maxOutputTokens).toBe(321)
  })

  it('normalizes a provider failure into taskFailed with partial text preserved', async () => {
    const failing: ModelProvider = {
      async *stream() {
        yield { type: 'text_delta', text: 'partial answer' }
        throw new ProviderError('rate_limited', 'Provider rate limit reached (429).')
      },
    }
    const runtime = new AgentRuntime(
      toolLoopTaskRunner(failing, { execute: async () => ({ ok: true }) }, { model: 't' }),
    )
    const events = collect(runtime)
    runtime.start({ requestId: 't4', text: 'x', surface: { page: 'home' } })
    await tick(20)

    const failed = events.find((e) => e.type === 'agentTaskFailed') as
      | Extract<AgentEvent, { type: 'agentTaskFailed' }>
      | undefined
    expect(failed?.error).toContain('429')
    const deltas = events
      .filter((e): e is Extract<AgentEvent, { type: 'agentAssistantDelta' }> => e.type === 'agentAssistantDelta')
      .map((e) => e.text)
    expect(deltas.join('')).toBe('partial answer')
  })

  it('stops after cancellation mid-tool-execution', async () => {
    const never: ToolExecutor = {
      execute: () => new Promise(() => {}),
    }
    const runtime = new AgentRuntime(toolLoopTaskRunner(toolThenAnswer, never, { model: 't' }))
    const events = collect(runtime)
    const { taskId } = runtime.start({ requestId: 't5', text: 'x', surface: { page: 'home' } })
    await tick(20)
    runtime.cancel(taskId)
    await tick(20)
    expect(events.some((e) => e.type === 'agentTaskCancelled')).toBe(true)
    expect(events.some((e) => e.type === 'agentTaskCompleted')).toBe(false)
  })

  it('commits tool evidenceCandidates to the ledger hook (plan §7)', async () => {
    const executor: ToolExecutor = {
      execute: async () => ({
        ok: true,
        result: {
          matches: [],
          repositoryVersion: 'rv-1',
          evidenceCandidates: [
            {
              path: 'src/auth.ts',
              startLine: 1,
              endLine: 2,
              excerpt: 'export function login()',
              kind: 'source',
              sourceTool: 'read_file',
              contentHash: 'hash-1',
            },
          ],
        },
      }),
    }
    const recordEvidence = vi.fn()
    const runtime = new AgentRuntime(
      toolLoopTaskRunner(toolThenAnswer, executor, { model: 't', recordEvidence }),
    )
    collect(runtime)
    runtime.start({ requestId: 't6', text: 'x', surface: { page: 'home' } })
    await tick(20)

    expect(recordEvidence).toHaveBeenCalledTimes(1)
    expect(recordEvidence).toHaveBeenCalledWith(
      [expect.objectContaining({ path: 'src/auth.ts', contentHash: 'hash-1' })],
      'rv-1',
      'search_code',
    )
  })

  it('exposes committed evidence handles to the synthesis pass', async () => {
    let toolContent = ''
    const provider: ModelProvider = {
      async *stream(request) {
        const tool = request.messages.find((message) => message.role === 'tool')
        if (!tool) {
          yield { type: 'tool_call_completed', id: 'c1', name: 'search_code', arguments: '{}' }
          yield { type: 'finish', reason: 'tool_calls' }
          return
        }
        toolContent = tool.content
        yield { type: 'text_delta', text: 'done' }
        yield { type: 'finish', reason: 'stop' }
      },
    }
    const executor: ToolExecutor = {
      execute: async () => ({
        ok: true,
        result: { repositoryVersion: 'rv-1', evidenceCandidates: [{ path: 'a.ts', startLine: 1, endLine: 1, excerpt: 'x', kind: 'source', sourceTool: 'search_code' }] },
      }),
    }
    const runtime = new AgentRuntime(toolLoopTaskRunner(provider, executor, { model: 't', recordEvidence: () => ['e-precise'] }))
    collect(runtime)
    runtime.start({ requestId: 'evidence', text: 'x', surface: { page: 'home' } })
    await tick(20)
    expect(toolContent).toContain('[EVIDENCE:e-precise]')
  })

  it('does not call the evidence hook for failed tools or results without candidates', async () => {
    const executor: ToolExecutor = { execute: vi.fn(async () => ({ ok: true, result: { x: 1 } })) }
    const recordEvidence = vi.fn()
    const runtime = new AgentRuntime(
      toolLoopTaskRunner(toolThenAnswer, executor, { model: 't', recordEvidence }),
    )
    collect(runtime)
    runtime.start({ requestId: 't7', text: 'x', surface: { page: 'home' } })
    await tick(20)
    expect(recordEvidence).not.toHaveBeenCalled()
  })

  it('retries a transient provider failure before any output (plan §14)', async () => {
    let calls = 0
    const flaky: ModelProvider = {
      async *stream() {
        calls++
        if (calls === 1) throw new ProviderError('network', 'connection reset')
        yield { type: 'text_delta', text: 'recovered' }
        yield { type: 'finish', reason: 'stop' }
      },
    }
    const runtime = new AgentRuntime(
      toolLoopTaskRunner(flaky, { execute: async () => ({ ok: true }) }, { model: 't' }),
    )
    const events = collect(runtime)
    runtime.start({ requestId: 't8', text: 'x', surface: { page: 'home' } })
    // Backoff is 500ms + jitter — wait past the worst case.
    await tick(1500)

    expect(calls).toBeGreaterThanOrEqual(2)
    const deltas = events
      .filter((e): e is Extract<AgentEvent, { type: 'agentAssistantDelta' }> => e.type === 'agentAssistantDelta')
      .map((e) => e.text)
    expect(deltas.join('')).toBe('recovered')
    expect(events.at(-1)).toMatchObject({ type: 'agentTaskCompleted' })
  })

  it('does NOT retry after text started streaming (partial preserved, §23.7)', async () => {
    let calls = 0
    const flaky: ModelProvider = {
      async *stream() {
        calls++
        yield { type: 'text_delta', text: 'partial ' }
        throw new ProviderError('rate_limited', 'Provider rate limit reached (429).')
      },
    }
    const runtime = new AgentRuntime(
      toolLoopTaskRunner(flaky, { execute: async () => ({ ok: true }) }, { model: 't' }),
    )
    const events = collect(runtime)
    runtime.start({ requestId: 't9', text: 'x', surface: { page: 'home' } })
    await tick(200)

    expect(calls).toBe(1) // no retry — would duplicate visible text
    expect(events.some((e) => e.type === 'agentTaskFailed')).toBe(true)
  })

  it('does NOT retry non-retryable failures (auth)', async () => {
    let calls = 0
    const authFail: ModelProvider = {
      async *stream() {
        calls++
        throw new ProviderError('auth', 'Provider authentication failed (401).')
        // Unreachable — satisfies the generator contract.
        yield { type: 'finish', reason: 'stop' }
      },
    }
    const runtime = new AgentRuntime(
      toolLoopTaskRunner(authFail, { execute: async () => ({ ok: true }) }, { model: 't' }),
    )
    collect(runtime)
    runtime.start({ requestId: 't10', text: 'x', surface: { page: 'home' } })
    await tick(200)
    expect(calls).toBe(1)
  })

  it('stops the loop on repeated identical tool calls (plan §14 loop detection)', async () => {
    const stuck: ModelProvider = {
      async *stream(request: ModelRequest) {
        if (request.tools.length === 0) {
          yield { type: 'text_delta', text: 'final synthesis' }
          yield { type: 'finish', reason: 'stop' }
          return
        }
        yield { type: 'tool_call_started', id: 'c1', name: 'search_code' }
        yield { type: 'tool_call_completed', id: 'c1', name: 'search_code', arguments: '{"pattern":"auth"}' }
        yield { type: 'finish', reason: 'tool_calls' }
      },
    }
    const executor: ToolExecutor = { execute: vi.fn(async () => ({ ok: true, result: { matches: [] } })) }
    const runtime = new AgentRuntime(
      toolLoopTaskRunner(stuck, executor, {
        model: 't',
        maxIterations: 10,
        tools: [{ name: 'search_code', description: 'x', inputJsonSchema: {} }],
      }),
    )
    const events = collect(runtime)
    runtime.start({ requestId: 't11', text: 'x', surface: { page: 'home' } })
    await tick(30)

    // 1 (identical) + 2 repeats detected → stops before exhausting 10 iterations.
    expect(executor.execute).toHaveBeenCalledTimes(2)
    const activities = events
      .filter((e): e is Extract<AgentEvent, { type: 'agentActivity' }> => e.type === 'agentActivity')
      .map((e) => e.activity)
    expect(activities).toContain('Repeated identical tool calls — stopping the search loop')
    const deltas = events
      .filter((e): e is Extract<AgentEvent, { type: 'agentAssistantDelta' }> => e.type === 'agentAssistantDelta')
      .map((e) => e.text)
    expect(deltas.join('')).toBe('final synthesis')
  })

  it('emits debug trace diagnostics for LLM approach and tool execution', async () => {
    const diagnostics: OperationalDiagnostic[] = []
    const executor: ToolExecutor = {
      execute: async () => ({ ok: true, result: { matches: [{ path: 'src/auth.ts', line: 2 }] } }),
    }
    const runtime = new AgentRuntime(
      toolLoopTaskRunner(toolThenAnswer, executor, {
        model: 'trace-model',
        system: 'Trace system prompt',
        thinking: 'enabled',
        tools: [{ name: 'search_code', description: 'x', inputJsonSchema: {} }],
        diagnostic: (d) => diagnostics.push(d),
      }),
    )
    collect(runtime)
    runtime.start({ requestId: 'trace', text: 'Where is auth?', surface: { page: 'home' } })
    await tick(20)

    const approach = diagnostics.find((d) => d.event === 'llm.approach')
    expect(approach).toMatchObject({
      model: 'trace-model',
      systemPrompt: 'Trace system prompt',
      thinking: 'enabled',
      toolNames: ['search_code'],
    })

    const executed = diagnostics.find((d) => d.event === 'tool.executed')
    expect(executed).toMatchObject({ tool: 'search_code', toolArgs: { pattern: 'auth' } })
    expect(executed?.toolOutput).toEqual({ matches: [{ path: 'src/auth.ts', line: 2 }] })
  })

  it('rebuilds context and retries once when the window overflows (plan §14)', async () => {
    let call = 0
    const executor: ToolExecutor = { execute: async () => ({ ok: true, result: { matches: [] } }) }
    // Prime the conversation with tool messages by giving the provider a tool
    // call on the FIRST pass — the overflow then happens on the second pass.
    const flow: ModelProvider = {
      async *stream(request: ModelRequest) {
        const hasTool = request.messages.some((m) => m.role === 'tool')
        if (!hasTool && request.tools.length > 0) {
          yield { type: 'tool_call_started', id: 'c1', name: 'search_code' }
          yield { type: 'tool_call_completed', id: 'c1', name: 'search_code', arguments: '{}' }
          yield { type: 'finish', reason: 'tool_calls' }
          return
        }
        // Second pass (with tool results): overflow once, then succeed.
        call++
        if (call === 1) {
          throw new ProviderError('unknown', 'Provider request failed (400). maximum context length exceeded.')
        }
        yield { type: 'text_delta', text: 'trimmed answer' }
        yield { type: 'finish', reason: 'stop' }
      },
    }
    const runtime = new AgentRuntime(
      toolLoopTaskRunner(flow, executor, {
        model: 't',
        tools: [{ name: 'search_code', description: 'x', inputJsonSchema: {} }],
      }),
    )
    const events = collect(runtime)
    runtime.start({ requestId: 't12', text: 'x', surface: { page: 'home' } })
    await tick(50)

    const activities = events
      .filter((e): e is Extract<AgentEvent, { type: 'agentActivity' }> => e.type === 'agentActivity')
      .map((e) => e.activity)
    expect(activities).toContain('Context window exceeded — rebuilding context and retrying')
    const deltas = events
      .filter((e): e is Extract<AgentEvent, { type: 'agentAssistantDelta' }> => e.type === 'agentAssistantDelta')
      .map((e) => e.text)
    expect(deltas.join('')).toBe('trimmed answer')
    expect(events.at(-1)).toMatchObject({ type: 'agentTaskCompleted' })
  })
})
