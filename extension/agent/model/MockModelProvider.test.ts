import { describe, expect, it } from 'vitest'
import { MockModelProvider } from './MockModelProvider'
import type { ModelEvent } from './ModelTypes'
import { ProviderError } from './ProviderError'

const request = {
  model: 'mock',
  system: 'sys',
  messages: [{ role: 'user' as const, content: 'Where is auth handled?' }],
  tools: [],
}

async function collect(signal?: AbortSignal): Promise<ModelEvent[]> {
  const events: ModelEvent[] = []
  const provider = new MockModelProvider({ tokenDelayMs: 0 })
  for await (const e of provider.stream(request, signal ?? new AbortController().signal)) {
    events.push(e)
  }
  return events
}

describe('MockModelProvider', () => {
  it('requests a tool before the answer pass without streaming duplicate prose', async () => {
    const events = await collect()
    const types = events.map((e) => e.type)
    expect(types[0]).toBe('provider_warning')
    expect(types).toContain('tool_call_started')
    expect(types).toContain('tool_call_completed')
    expect(types.at(-1)).toBe('finish')
    expect(types).not.toContain('usage')

    const text = events
      .filter((e): e is Extract<ModelEvent, { type: 'text_delta' }> => e.type === 'text_delta')
      .map((e) => e.text)
      .join('')
    expect(text).toBe('')

    const answerEvents: ModelEvent[] = []
    const answerRequest = {
      ...request,
      messages: [
        ...request.messages,
        { role: 'tool' as const, content: '{}', toolCallId: 'call-1', name: 'search_code' },
      ],
    }
    const provider = new MockModelProvider({ tokenDelayMs: 0 })
    for await (const event of provider.stream(answerRequest, new AbortController().signal)) answerEvents.push(event)
    expect(answerEvents.some((event) => event.type === 'text_delta')).toBe(true)
  })

  it('stops iterating when the signal aborts', async () => {
    const controller = new AbortController()
    const events: ModelEvent[] = []
    const provider = new MockModelProvider({ tokenDelayMs: 2 })
    const answerRequest = {
      ...request,
      messages: [
        ...request.messages,
        { role: 'tool' as const, content: '{}', toolCallId: 'call-1', name: 'search_code' },
      ],
    }
    for await (const e of provider.stream(answerRequest, controller.signal)) {
      events.push(e)
      controller.abort()
    }
    // Abort fires during the text loop — no usage/finish afterwards.
    expect(events.some((e) => e.type === 'finish')).toBe(false)
  })

  it('injects a failure mid-stream with the requested kind', async () => {
    const provider = new MockModelProvider({ tokenDelayMs: 0, fail: 'rate_limited' })
    const events: ModelEvent[] = []
    const answerRequest = {
      ...request,
      messages: [
        ...request.messages,
        { role: 'tool' as const, content: '{}', toolCallId: 'call-1', name: 'search_code' },
      ],
    }
    await expect(
      (async () => {
        for await (const e of provider.stream(answerRequest, new AbortController().signal)) {
          events.push(e)
        }
      })(),
    ).rejects.toThrow(ProviderError)
    expect(events.some((e) => e.type === 'text_delta')).toBe(true)
    expect(events.some((e) => e.type === 'finish')).toBe(false)
  })
})
