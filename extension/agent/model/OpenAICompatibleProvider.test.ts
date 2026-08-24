// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { OpenAICompatibleProvider } from './OpenAICompatibleProvider'
import type { ModelEvent, ModelRequest } from './ModelTypes'

const request: ModelRequest = {
  model: 'gpt-x',
  system: 'sys',
  messages: [{ role: 'user', content: 'Where is auth?' }],
  tools: [{ name: 'search_code', description: 'search', inputJsonSchema: { type: 'object' } }],
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

function sseResponse(chunks: string[]): Response {
  const encoded = chunks.map((c) => new TextEncoder().encode(c))
  let i = 0
  return {
    ok: true,
    status: 200,
    body: {
      getReader() {
        return {
          read: async () =>
            i < encoded.length
              ? { done: false, value: encoded[i++] }
              : { done: true, value: undefined },
        }
      },
    },
    json: async () => ({}),
  } as unknown as Response
}

function errorResponse(status: number, message: string): Response {
  return {
    ok: false,
    status,
    body: null,
    json: async () => ({ error: { message } }),
  } as unknown as Response
}

function provider(fetchFn: FetchLike): OpenAICompatibleProvider {
  return new OpenAICompatibleProvider({ apiKey: 'sk-test', fetchFn })
}

async function collect(
  provider: OpenAICompatibleProvider,
  signal?: AbortSignal,
): Promise<ModelEvent[]> {
  const events: ModelEvent[] = []
  for await (const e of provider.stream(request, signal ?? new AbortController().signal)) {
    events.push(e)
  }
  return events
}

describe('OpenAICompatibleProvider', () => {
  it('disables thinking by default for DeepSeek requests', async () => {
    const fetchFn = vi.fn<FetchLike>(async () =>
      sseResponse(['data: {"choices":[{"delta":{"content":"Done"},"finish_reason":"stop"}]}\n\n']),
    )
    const deepSeekProvider = new OpenAICompatibleProvider({
      apiKey: 'sk-test',
      baseUrl: 'https://api.deepseek.com',
      fetchFn,
    })

    const events: ModelEvent[] = []
    for await (const event of deepSeekProvider.stream(
      { ...request, thinking: 'disabled' },
      new AbortController().signal,
    )) {
      events.push(event)
    }

    const body = JSON.parse(String(fetchFn.mock.calls[0][1]?.body)) as {
      thinking?: { type: string }
    }
    expect(body.thinking).toEqual({ type: 'disabled' })
    expect(events).toContainEqual({ type: 'text_delta', text: 'Done' })
  })

  it('preserves a quality-sensitive DeepSeek thinking policy', async () => {
    const fetchFn = vi.fn<FetchLike>(async () =>
      sseResponse(['data: {"choices":[{"delta":{"content":"Done"},"finish_reason":"stop"}]}\n\n']),
    )
    const deepSeekProvider = new OpenAICompatibleProvider({
      apiKey: 'sk-test',
      baseUrl: 'https://api.deepseek.com/v1',
      fetchFn,
    })

    const events: ModelEvent[] = []
    for await (const event of deepSeekProvider.stream(
      { ...request, thinking: 'enabled' },
      new AbortController().signal,
    )) {
      events.push(event)
    }

    const body = JSON.parse(String(fetchFn.mock.calls[0][1]?.body)) as {
      thinking?: { type: string }
    }
    expect(body.thinking).toEqual({ type: 'enabled' })
    expect(events).toContainEqual({ type: 'text_delta', text: 'Done' })
  })

  it('normalizes SSE content, tool calls, usage, and finish', async () => {
    const fetchFn = vi.fn<FetchLike>(async () =>
      sseResponse([
        'data: {"choices":[{"delta":{"content":"Hello "}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"world"}}]}\n\n',
        'data: {"choices":[{"delta":{"reasoning_content":"Need repository context."}}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"search_code","arguments":""}}]}}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"pattern\\":"}}]}}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"auth\\"}"}}]}}]}\n\n',
        'data: {"choices":[{"finish_reason":"tool_calls"}]}\n\n',
        'data: {"usage":{"prompt_tokens":10,"completion_tokens":20}}\n\n',
        'data: [DONE]\n\n',
      ]),
    )

    const events = await collect(provider(fetchFn))

    const text = events
      .filter((e): e is Extract<ModelEvent, { type: 'text_delta' }> => e.type === 'text_delta')
      .map((e) => e.text)
      .join('')
    expect(text).toBe('Hello world')
    expect(events).toContainEqual({ type: 'reasoning_delta', text: 'Need repository context.' })

    const started = events.find((e) => e.type === 'tool_call_started') as Extract<
      ModelEvent,
      { type: 'tool_call_started' }
    >
    expect(started.name).toBe('search_code')

    const completed = events.find((e) => e.type === 'tool_call_completed') as Extract<
      ModelEvent,
      { type: 'tool_call_completed' }
    >
    expect(completed.arguments).toBe('{"pattern":"auth"}')

    expect(events.find((e) => e.type === 'usage')).toMatchObject({
      usage: { inputTokens: 10, outputTokens: 20 },
    })
    expect(events.find((e) => e.type === 'finish')).toMatchObject({ reason: 'tool_calls' })

    // Credentials go only in the Authorization header.
    const [url, init] = fetchFn.mock.calls[0]
    expect(url).toBe('https://api.openai.com/v1/chat/completions')
    expect(init?.headers).toMatchObject({ Authorization: 'Bearer sk-test' })
    const body = JSON.parse(String(init?.body)) as { thinking?: unknown }
    expect(body).not.toHaveProperty('thinking')
  })

  it('replays thinking content on an assistant tool-call message', async () => {
    const fetchFn = vi.fn<FetchLike>(async () =>
      sseResponse(['data: {"choices":[{"delta":{"content":"Done"},"finish_reason":"stop"}]}\n\n']),
    )
    const replayRequest: ModelRequest = {
      ...request,
      messages: [
        { role: 'user', content: 'Inspect this repository.' },
        {
          role: 'assistant',
          content: 'I will inspect the project first.',
          reasoningContent: 'I need the project structure before answering.',
          toolCalls: [{ id: 'call_1', name: 'get_project_structure', arguments: '{}' }],
        },
        { role: 'tool', toolCallId: 'call_1', name: 'get_project_structure', content: '{"files":[]}' },
      ],
    }
    const p = provider(fetchFn)
    const events: ModelEvent[] = []
    for await (const event of p.stream(replayRequest, new AbortController().signal)) events.push(event)

    const body = JSON.parse(String(fetchFn.mock.calls[0][1]?.body)) as {
      messages: Array<{ role: string; content: string | null; reasoning_content?: string }>
    }
    expect(body.messages[2]).toMatchObject({
      role: 'assistant',
      content: 'I will inspect the project first.',
      reasoning_content: 'I need the project structure before answering.',
    })
    expect(events).toContainEqual({ type: 'text_delta', text: 'Done' })
  })

  it('maps HTTP errors into the retry taxonomy', async () => {
    await expect(
      collect(provider(async () => errorResponse(401, 'bad key'))),
    ).rejects.toMatchObject({ kind: 'auth', retryable: false })
    await expect(
      collect(provider(async () => errorResponse(429, 'slow down'))),
    ).rejects.toMatchObject({ kind: 'rate_limited', retryable: true })
    await expect(
      collect(provider(async () => errorResponse(503, 'down'))),
    ).rejects.toMatchObject({ kind: 'server', retryable: true })
    await expect(
      collect(provider(async () => errorResponse(400, 'bad request'))),
    ).rejects.toMatchObject({ kind: 'unknown', retryable: false })
  })

  it('honors the Retry-After header on 429 (plan §3 edge case)', async () => {
    const withRetryAfter = (value: string): Response =>
      ({
        ok: false,
        status: 429,
        headers: { get: (name: string) => (name === 'retry-after' ? value : null) },
        body: null,
        json: async () => ({ error: { message: 'slow down' } }),
      }) as unknown as Response

    await expect(
      collect(provider(async () => withRetryAfter('12'))),
    ).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 12_000 })

    // Absurd values are capped so one header cannot hang a task.
    await expect(
      collect(provider(async () => withRetryAfter('999999999'))),
    ).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 60_000 })

    // No header → no suggested delay.
    await expect(
      collect(provider(async () => errorResponse(429, 'slow down'))),
    ).rejects.toMatchObject({ retryAfterMs: undefined })
  })

  it('throws auth before calling fetch when no key is configured', async () => {
    const fetchFn = vi.fn()
    const p = new OpenAICompatibleProvider({ fetchFn })
    await expect(collect(p)).rejects.toMatchObject({ kind: 'auth' })
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('maps network failures and user aborts', async () => {
    const network = vi.fn(async () => {
      throw new TypeError('fetch failed')
    })
    await expect(collect(provider(network))).rejects.toMatchObject({
      kind: 'network',
      retryable: true,
    })

    const abortable = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
          )
        }),
    )
    const controller = new AbortController()
    const promise = collect(provider(abortable), controller.signal)
    controller.abort()
    await expect(promise).rejects.toMatchObject({ kind: 'cancelled', retryable: false })
  })

  it('finishes gracefully when the stream ends without [DONE]', async () => {
    const fetchFn = vi.fn(async () =>
      sseResponse(['data: {"choices":[{"delta":{"content":"partial"}}]}\n\n']),
    )
    const events = await collect(provider(fetchFn))
    expect(events.at(-1)).toMatchObject({ type: 'finish', reason: 'stop' })
  })

  it('rejects malformed stream data as invalid_response', async () => {
    const fetchFn = vi.fn(async () => sseResponse(['data: not-json\n\n']))
    await expect(collect(provider(fetchFn))).rejects.toMatchObject({
      kind: 'invalid_response',
    })
  })

  it('parses DeepSeek cache and reasoning tokens from usage', async () => {
    const fetchFn = vi.fn<FetchLike>(async () =>
      sseResponse([
        'data: {"choices":[{"delta":{"content":"Done"},"finish_reason":"stop"}]}\n\n',
        'data: {"usage":{"prompt_tokens":100,"completion_tokens":50,"prompt_cache_hit_tokens":80,"prompt_cache_miss_tokens":10,"completion_tokens_details":{"reasoning_tokens":20}}}\n\n',
        'data: [DONE]\n\n',
      ]),
    )

    const events = await collect(provider(fetchFn))

    const usageEvent = events.find((e) => e.type === 'usage') as Extract<
      ModelEvent,
      { type: 'usage' }
    >
    expect(usageEvent).toBeDefined()
    expect(usageEvent.usage.inputTokens).toBe(100)
    expect(usageEvent.usage.outputTokens).toBe(50)
    expect(usageEvent.usage.cacheReadTokens).toBe(80)
    expect(usageEvent.usage.cacheWriteTokens).toBe(10)
    expect(usageEvent.usage.reasoningTokens).toBe(20)
  })

  it('throws ProviderError from a stream that yields nothing at all', async () => {
    const fetchFn = vi.fn(async () => sseResponse([]))
    await expect(collect(provider(fetchFn))).rejects.toMatchObject({
      kind: 'invalid_response',
    })
  })
})
