import type { ModelEvent, ModelRequest } from './ModelTypes'
import type { ModelProvider } from './ModelProvider'
import { ProviderError } from './ProviderError'

const DEFAULT_BASE_URL = 'https://api.openai.com/v1'
const REQUEST_TIMEOUT_MS = 120_000

export interface OpenAICompatibleOptions {
  /** Base URL, e.g. https://api.openai.com/v1 (works with gateways/local servers). */
  baseUrl?: string
  apiKey?: string
  timeoutMs?: number
  /** Injectable for tests. Defaults to the global fetch. */
  fetchFn?: (url: string, init?: RequestInit) => Promise<Response>
}

interface ToolCallState {
  id: string
  name: string
  arguments: string
}

interface StreamDeltaToolCall {
  index?: number
  id?: string
  function?: { name?: string; arguments?: string }
}

interface StreamChunk {
  choices?: Array<{
    delta?: { content?: string | null; reasoning_content?: string | null; tool_calls?: StreamDeltaToolCall[] }
    finish_reason?: string | null
  }>
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null
}

interface ProviderResponseLike {
  ok: boolean
  status: number
  headers?: { get(name: string): string | null }
  body: { getReader(): ReadableStreamDefaultReader<Uint8Array> } | null
  json(): Promise<unknown>
}

function toErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function isDeepSeekBaseUrl(baseUrl: string): boolean {
  try {
    const hostname = new URL(baseUrl).hostname.toLowerCase()
    return hostname === 'deepseek.com' || hostname.endsWith('.deepseek.com')
  } catch {
    return false
  }
}

async function readErrorDetail(response: ProviderResponseLike): Promise<string> {
  try {
    const data = (await response.json()) as { error?: { message?: string } }
    return data.error?.message ?? ''
  } catch {
    return ''
  }
}

/** Cap a provider-suggested retry delay so one header cannot hang a task (plan §3). */
const MAX_RETRY_AFTER_MS = 60_000

/**
 * Parse the `Retry-After` header (plan §3 edge case: 429 with retry headers).
 * Accepts delta-seconds and HTTP-date forms; capped at MAX_RETRY_AFTER_MS.
 */
function parseRetryAfter(value: string | null | undefined): number | undefined {
  if (!value) return undefined
  const seconds = Number(value.trim())
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(Math.round(seconds * 1000), MAX_RETRY_AFTER_MS)
  }
  const date = Date.parse(value)
  if (!Number.isNaN(date)) {
    return Math.min(Math.max(0, date - Date.now()), MAX_RETRY_AFTER_MS)
  }
  return undefined
}

function errorFromStatus(response: ProviderResponseLike, detail: string): ProviderError {
  const status = response.status
  const suffix = detail ? ` ${detail}` : ''
  if (status === 401 || status === 403) {
    return new ProviderError('auth', `Provider authentication failed (${status}).${suffix}`)
  }
  if (429 === status) {
    return new ProviderError(
      'rate_limited',
      `Provider rate limit reached (429).${suffix}`,
      parseRetryAfter(response.headers?.get('retry-after')),
    )
  }
  if (status >= 500) {
    return new ProviderError('server', `Provider server error (${status}).${suffix}`)
  }
  return new ProviderError('unknown', `Provider request failed (${status}).${suffix}`)
}

/**
 * OpenAI-compatible streaming adapter (chat completions, SSE). No SDK
 * dependency — global fetch + manual SSE parsing keep the interface thin and
 * vendor-swappable.
 */
export class OpenAICompatibleProvider implements ModelProvider {
  constructor(private readonly options: OpenAICompatibleOptions = {}) {}

  async *stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent> {
    const apiKey = (this.options.apiKey ?? '').trim()
    if (!apiKey) {
      throw new ProviderError(
        'auth',
        'No API key configured — run "Charter Ai: Set Provider API Key" from the command palette.',
      )
    }

    const baseUrl = (this.options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '')
    const timeoutMs = this.options.timeoutMs ?? REQUEST_TIMEOUT_MS
    const fetchFn = this.options.fetchFn ?? fetch

    const body = {
      model: request.model || 'default',
      ...(isDeepSeekBaseUrl(baseUrl) && request.thinking
        ? { thinking: { type: request.thinking } }
        : {}),
      messages: [
        ...(request.system ? [{ role: 'system', content: request.system }] : []),
        ...request.messages.map((m) => {
          if (m.role === 'assistant' && m.toolCalls?.length) {
            return {
              role: 'assistant',
              content: m.content || null,
              ...(m.reasoningContent ? { reasoning_content: m.reasoningContent } : {}),
              tool_calls: m.toolCalls.map((c) => ({
                id: c.id,
                type: 'function',
                function: { name: c.name, arguments: c.arguments },
              })),
            }
          }
          if (m.role === 'tool') {
            return {
              role: 'tool',
              tool_call_id: m.toolCallId,
              name: m.name,
              content: m.content,
            }
          }
          return { role: m.role, content: m.content }
        }),
      ],
      ...(request.tools.length > 0
        ? {
            tools: request.tools.map((t) => ({
              type: 'function',
              function: {
                name: t.name,
                description: t.description,
                parameters: t.inputJsonSchema,
              },
            })),
          }
        : {}),
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      ...(request.maxOutputTokens !== undefined ? { max_tokens: request.maxOutputTokens } : {}),
      ...(request.responseFormat ? { response_format: { type: request.responseFormat } } : {}),
      stream: true,
      stream_options: { include_usage: true },
    }

    // User cancellation + a hard timeout both abort the fetch (plan: no outbound
    // call without a timeout).
    const combined = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])

    let response: ProviderResponseLike
    try {
      response = (await fetchFn(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal: combined,
      })) as unknown as ProviderResponseLike
    } catch (err) {
      if (signal.aborted) throw new ProviderError('cancelled', 'Request cancelled.')
      if (err instanceof Error && err.name === 'AbortError') {
        throw new ProviderError('timeout', `Provider request timed out after ${timeoutMs}ms.`)
      }
      throw new ProviderError('network', `Network error contacting the provider: ${toErrorMessage(err)}`)
    }

    if (!response.ok) {
      throw errorFromStatus(response, await readErrorDetail(response))
    }
    if (!response.body) {
      throw new ProviderError('invalid_response', 'Provider returned an empty response body.')
    }

    yield* this.readStream(response, signal)
  }

  private async *readStream(
    response: ProviderResponseLike,
    signal: AbortSignal,
  ): AsyncIterable<ModelEvent> {
    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    const toolCalls = new Map<number, ToolCallState>()
    let sawContent = false
    let finished = false

    const finalizeToolCalls = (): ModelEvent[] => {
      const out: ModelEvent[] = []
      for (const [index, tc] of toolCalls) {
        out.push({
          type: 'tool_call_completed',
          id: tc.id || `call-${index}`,
          name: tc.name,
          arguments: tc.arguments,
        })
      }
      toolCalls.clear()
      return out
    }

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })

        let nl: number
        while ((nl = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, nl).replace(/\r$/, '')
          buffer = buffer.slice(nl + 1)
          if (!line.startsWith('data:')) continue

          const payload = line.slice(5).trim()
          if (payload === '[DONE]') {
            finished = true
            continue
          }

          let chunk: StreamChunk
          try {
            chunk = JSON.parse(payload) as StreamChunk
          } catch {
            throw new ProviderError('invalid_response', 'Provider stream contained malformed data.')
          }

          if (chunk.usage) {
            yield {
              type: 'usage',
              usage: {
                inputTokens: chunk.usage.prompt_tokens ?? 0,
                outputTokens: chunk.usage.completion_tokens ?? 0,
              },
            }
          }

          const choice = chunk.choices?.[0]
          if (!choice) continue

          if (choice.finish_reason) {
            for (const e of finalizeToolCalls()) yield e
            const reason =
              choice.finish_reason === 'tool_calls'
                ? 'tool_calls'
                : choice.finish_reason === 'length'
                  ? 'length'
                  : 'stop'
            yield { type: 'finish', reason }
            finished = true
          }

          const delta = choice.delta
          if (!delta) continue

          if (delta.content) {
            sawContent = true
            yield { type: 'text_delta', text: delta.content }
          }

          // DeepSeek thinking-mode tool calls require this exact reasoning
          // content to be included in the next assistant tool-call message.
          // It deliberately remains outside UI-visible text events.
          if (delta.reasoning_content) {
            yield { type: 'reasoning_delta', text: delta.reasoning_content }
          }

          for (const tc of delta.tool_calls ?? []) {
            const index = tc.index ?? 0
            let state = toolCalls.get(index)
            const isNew = !state
            if (!state) {
              state = { id: '', name: '', arguments: '' }
              toolCalls.set(index, state)
            }
            if (tc.id) state.id = tc.id
            if (tc.function?.name) state.name += tc.function.name
            if (tc.function?.arguments) {
              state.arguments += tc.function.arguments
              if (!isNew) {
                yield {
                  type: 'tool_call_delta',
                  id: state.id || `call-${index}`,
                  argumentsDelta: tc.function.arguments,
                }
              }
            }
            if (isNew) {
              sawContent = true
              yield { type: 'tool_call_started', id: state.id || `call-${index}`, name: state.name }
              if (state.arguments) {
                yield {
                  type: 'tool_call_delta',
                  id: state.id || `call-${index}`,
                  argumentsDelta: state.arguments,
                }
              }
            }
          }
        }
      }

      if (!finished) {
        // Stream ended without an explicit completion (plan §3 edge case):
        // salvage a graceful finish, or fail if literally nothing arrived.
        if (sawContent) {
          for (const e of finalizeToolCalls()) yield e
          yield { type: 'finish', reason: 'stop' }
        } else {
          throw new ProviderError('invalid_response', 'Provider stream ended without a completion event.')
        }
      }
    } catch (err) {
      if (err instanceof ProviderError) throw err
      if (signal.aborted) throw new ProviderError('cancelled', 'Request cancelled.')
      throw new ProviderError('network', `Provider stream failed: ${toErrorMessage(err)}`)
    }
  }
}
