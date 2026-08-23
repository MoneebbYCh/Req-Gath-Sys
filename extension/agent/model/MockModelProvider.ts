import type { ModelEvent, ModelRequest } from './ModelTypes'
import type { ModelProvider } from './ModelProvider'
import { ProviderError, type ProviderErrorKind } from './ProviderError'

const sleep = (ms: number) =>
  ms <= 0 ? Promise.resolve() : new Promise<void>((resolve) => setTimeout(resolve, ms))

export interface MockModelProviderOptions {
  /** Delay between simulated tokens. 0 makes tests run instantly. */
  tokenDelayMs?: number
  /** Simulate a provider failure after a few tokens (plan §23.7). */
  fail?: ProviderErrorKind
}

function buildAnswer(question: string): string {
  return [
    `Here's a mock answer about "${question}".`,
    '',
    '- Repository tools, the evidence ledger, and a real model are not connected yet.',
    '- This response streamed through the ModelProvider abstraction, tool-call normalization, and the isolated worker runtime.',
    '',
    'Run "Charter Ai: Set Provider API Key" from the command palette to switch to a real model.',
  ].join('\n')
}

/**
 * Deterministic fake provider implementing the same `ModelProvider` interface
 * a real SDK adapter implements. Streams a tool call, text deltas, usage, and
 * finish — and honors `AbortSignal`.
 */
export class MockModelProvider implements ModelProvider {
  constructor(private readonly options: MockModelProviderOptions = {}) {}

  async *stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent> {
    const delay = this.options.tokenDelayMs ?? 12

    yield {
      type: 'provider_warning',
      message: 'Using the built-in mock provider — set an API key to use a real model.',
    }

    // Loop-aware: only request the simulated tool on the first pass; once a
    // tool result is in the conversation, answer instead of looping forever.
    const toolAlreadyAnswered = request.messages.some((m) => m.role === 'tool')
    if (!toolAlreadyAnswered) {
      yield { type: 'tool_call_started', id: 'call-1', name: 'search_code' }
      yield { type: 'tool_call_delta', id: 'call-1', argumentsDelta: '{"pattern":"auth"}' }
      yield { type: 'tool_call_completed', id: 'call-1', name: 'search_code', arguments: '{"pattern":"auth"}' }
      // A tool-call pass must not emit user-visible prose. The tool loop will
      // run a second pass with the tool result; emitting here duplicates the
      // final answer in the chat transcript.
      yield { type: 'finish', reason: 'tool_calls' }
      return
    }

    const userText = request.messages.find((m) => m.role === 'user')?.content ?? ''
    const words = buildAnswer(userText).split(' ')
    for (let i = 0; i < words.length; i++) {
      if (signal.aborted) return
      yield { type: 'text_delta', text: i === words.length - 1 ? words[i] : `${words[i]} ` }
      await sleep(delay)
      if (this.options.fail && i >= 3) {
        // Fail after a few tokens so partial streaming is observable.
        throw new ProviderError(this.options.fail, `Mock provider failure (${this.options.fail})`)
      }
    }

    yield { type: 'usage', usage: { inputTokens: 124, outputTokens: 96 } }
    yield { type: 'finish', reason: 'stop' }
  }
}
