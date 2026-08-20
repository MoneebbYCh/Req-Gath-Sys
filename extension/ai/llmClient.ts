import OpenAI from 'openai'

export interface ProviderInfo {
  baseUrl: string
  defaultModel: string
  env: string
}

export const PROVIDERS: Record<string, ProviderInfo> = {
  deepseek: {
    baseUrl: 'https://api.deepseek.com',
    defaultModel: 'deepseek-v4-flash',
    env: 'DEEPSEEK_API_KEY',
  },
  kimi: {
    baseUrl: 'https://api.moonshot.ai/v1',
    defaultModel: 'kimi-k2.6',
    env: 'MOONSHOT_API_KEY',
  },
  local: {
    baseUrl: 'http://localhost:11434/v1',
    defaultModel: 'llama3.2',
    env: '',
  },
}

// Checked after the provider-specific variable above.
const GENERIC_ENV_VARS = ['REQ_GATH_SYS_API_KEY', 'LLM_API_KEY'] as const

export interface LlmConfig {
  provider: string
  model?: string | null
  apiKey: string
  /** Override default context window for compaction triggers. */
  contextTokens?: number
}

export interface ChatToolCall {
  id: string
  name: string
  args: Record<string, unknown>
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  /** Native tool calls on assistant turns. */
  tool_calls?: ChatToolCall[]
  /** Links tool result messages to the originating call. */
  tool_call_id?: string
  /** Tool name on tool-role messages. */
  name?: string
}

export type LlmStepResult =
  | { kind: 'text'; text: string }
  | { kind: 'tool_calls'; text: string | null; toolCalls: ChatToolCall[] }

function getProvider(provider: string): ProviderInfo {
  return PROVIDERS[provider] ?? PROVIDERS.deepseek
}

export function resolveApiKey(config: LlmConfig): string {
  if (config.apiKey) return config.apiKey

  const provider = getProvider(config.provider)
  if (provider.env) {
    const value = process.env[provider.env]
    if (value) return value
  }

  for (const name of GENERIC_ENV_VARS) {
    const value = process.env[name]
    if (value) return value
  }

  return ''
}

export function resolveModel(config: LlmConfig): string {
  if (config.model) return config.model
  return getProvider(config.provider).defaultModel
}

export function resolveBaseUrl(provider: string): string {
  return getProvider(provider).baseUrl
}

type AssistantMessageLike = {
  content?: string | null
  reasoning_content?: string | null
  reasoning?: string | null
}

/** Pull usable text from content or reasoning fields (DeepSeek thinking mode). */
function extractMessageText(message: AssistantMessageLike | undefined): string {
  if (!message) return ''
  const content = typeof message.content === 'string' ? message.content.trim() : ''
  if (content) return content

  const reasoning =
    (typeof message.reasoning_content === 'string' && message.reasoning_content.trim()) ||
    (typeof message.reasoning === 'string' && message.reasoning.trim()) ||
    ''
  if (!reasoning) return ''

  // Sometimes the model only puts JSON in the reasoning channel — salvage it.
  const fence = reasoning.match(/```(?:json)?\s*([\s\S]*?)\s*```/)
  if (fence?.[1]?.trim()) return fence[1].trim()
  const brace = reasoning.indexOf('{')
  if (brace >= 0) {
    const slice = reasoning.slice(brace)
    if (slice.includes('"message"') || slice.includes('"tool"') || slice.includes('"document"')) {
      return slice
    }
  }
  return ''
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function callLlm(
  messages: ChatMessage[],
  config: LlmConfig,
  options: { jsonMode?: boolean; timeout?: number; maxTokens?: number; retries?: number } = {},
): Promise<string> {
  // Drafting full canvases needs headroom; 60s was too tight for DeepSeek thinking.
  // Do not set a default max_tokens — let the provider use the model's full output limit.
  const { jsonMode = true, timeout = 180_000, maxTokens, retries = 2 } = options
  const apiKey = resolveApiKey(config)

  if (!apiKey && config.provider !== 'local') {
    const provider = getProvider(config.provider)
    const envName = provider.env || 'DEEPSEEK_API_KEY'
    throw new Error(
      `No API key configured. Set the ${envName} environment variable ` +
        "or run 'Charter Ai: Configure API Key' in VS Code.",
    )
  }

  const client = new OpenAI({
    apiKey: apiKey || 'ollama',
    baseURL: resolveBaseUrl(config.provider),
    timeout,
  })

  const model = resolveModel(config)
  const body: Record<string, unknown> = {
    model,
    messages: toOpenAiMessages(messages),
  }
  if (typeof maxTokens === 'number' && maxTokens > 0) {
    body.max_tokens = maxTokens
  }

  if (jsonMode) {
    body.response_format = { type: 'json_object' }
  }

  // DeepSeek v4 enables thinking by default — reasoning can consume the whole
  // token budget and leave content empty. Kimi similarly dumps reasoning unless disabled.
  if (config.provider === 'deepseek' || config.provider === 'kimi') {
    body.thinking = { type: 'disabled' }
  }

  let lastError = 'The model returned an empty response.'

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await client.chat.completions.create(
        body as unknown as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
      )
      const choice = response.choices[0]
      const message = choice?.message as AssistantMessageLike | undefined
      const text = extractMessageText(message)
      if (text) return text

      const finish = choice?.finish_reason ?? 'unknown'
      const reasoningLen =
        (typeof message?.reasoning_content === 'string' ? message.reasoning_content.length : 0) ||
        (typeof message?.reasoning === 'string' ? message.reasoning.length : 0)
      lastError =
        finish === 'length'
          ? `The model hit its output token limit before finishing (finish_reason=length` +
            `${reasoningLen ? `, reasoning_chars=${reasoningLen}` : ''}). Open the document and ask it to continue, or try again.`
          : `The model returned an empty response (finish_reason=${finish}` +
            `${reasoningLen ? `, reasoning_chars=${reasoningLen}` : ''}).`

      if (attempt < retries) {
        await sleep(400 * (attempt + 1))
        continue
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      lastError = msg
      // Retry transient empties / timeouts once or twice.
      if (attempt < retries && /timeout|empty|ECONNRESET|429|503/i.test(msg)) {
        await sleep(600 * (attempt + 1))
        continue
      }
      throw err instanceof Error ? err : new Error(msg)
    }
  }

  throw new Error(lastError)
}

function toOpenAiMessages(messages: ChatMessage[]): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  return sanitizeMessagesForApi(messages).map((msg) => {
    if (msg.role === 'tool') {
      return {
        role: 'tool' as const,
        content: msg.content,
        tool_call_id: msg.tool_call_id ?? '',
      }
    }
    if (msg.role === 'assistant' && msg.tool_calls?.length) {
      return {
        role: 'assistant' as const,
        content: msg.content || null,
        tool_calls: msg.tool_calls.map((tc) => ({
          id: tc.id,
          type: 'function' as const,
          function: { name: tc.name, arguments: JSON.stringify(tc.args) },
        })),
      }
    }
    return { role: msg.role as 'system' | 'user' | 'assistant', content: msg.content }
  })
}

/**
 * Drop orphan tool results and strip unanswered tool_calls so providers
 * do not 400 ("tool must follow a tool_calls message").
 */
export function sanitizeMessagesForApi(messages: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = []
  let pending = new Set<string>()

  const closeUnansweredToolCalls = () => {
    if (pending.size === 0) return
    const last = out[out.length - 1]
    if (last?.role === 'assistant' && last.tool_calls?.length) {
      const kept = last.tool_calls.filter((tc) => !pending.has(tc.id))
      out[out.length - 1] = kept.length
        ? { ...last, tool_calls: kept }
        : { role: 'assistant', content: last.content }
    }
    pending = new Set()
  }

  for (const msg of messages) {
    if (msg.role === 'assistant' && msg.tool_calls?.length) {
      closeUnansweredToolCalls()
      out.push(msg)
      pending = new Set(msg.tool_calls.map((tc) => tc.id))
      continue
    }
    if (msg.role === 'tool') {
      const id = msg.tool_call_id ?? ''
      if (pending.has(id)) {
        out.push(msg)
        pending.delete(id)
      }
      continue
    }
    closeUnansweredToolCalls()
    out.push(msg)
  }
  closeUnansweredToolCalls()
  return out
}

/** Agent loop step: native tool calls when available, otherwise JSON text. */
export async function callLlmAgentStep(
  messages: ChatMessage[],
  config: LlmConfig,
  options: {
    tools?: OpenAI.Chat.Completions.ChatCompletionTool[]
    jsonMode?: boolean
    timeout?: number
    retries?: number
  } = {},
): Promise<LlmStepResult> {
  const { tools, jsonMode = false, timeout = 180_000, retries = 2 } = options
  const apiKey = resolveApiKey(config)

  if (!apiKey && config.provider !== 'local') {
    const provider = getProvider(config.provider)
    const envName = provider.env || 'DEEPSEEK_API_KEY'
    throw new Error(
      `No API key configured. Set the ${envName} environment variable ` +
        "or run 'Charter Ai: Configure API Key' in VS Code.",
    )
  }

  const client = new OpenAI({
    apiKey: apiKey || 'ollama',
    baseURL: resolveBaseUrl(config.provider),
    timeout,
  })

  const model = resolveModel(config)
  const body: Record<string, unknown> = {
    model,
    messages: toOpenAiMessages(messages),
  }

  if (tools?.length) {
    body.tools = tools
    body.tool_choice = 'auto'
  } else if (jsonMode) {
    body.response_format = { type: 'json_object' }
  }

  if (config.provider === 'deepseek' || config.provider === 'kimi') {
    body.thinking = { type: 'disabled' }
  }

  let lastError = 'The model returned an empty response.'

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await client.chat.completions.create(
        body as unknown as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
      )
      const choice = response.choices[0]
      const message = choice?.message as AssistantMessageLike & {
        tool_calls?: Array<{
          id: string
          function?: { name?: string; arguments?: string }
        }>
      }

      const rawToolCalls = message?.tool_calls ?? []
      if (rawToolCalls.length > 0) {
        const toolCalls: ChatToolCall[] = []
        for (const tc of rawToolCalls) {
          const name = tc.function?.name ?? ''
          if (!name) continue
          let args: Record<string, unknown> = {}
          try {
            args = JSON.parse(tc.function?.arguments ?? '{}') as Record<string, unknown>
          } catch {
            args = {}
          }
          toolCalls.push({ id: tc.id, name, args })
        }
        if (toolCalls.length > 0) {
          return {
            kind: 'tool_calls',
            text: extractMessageText(message) || null,
            toolCalls,
          }
        }
      }

      const text = extractMessageText(message)
      if (text) return { kind: 'text', text }

      const finish = choice?.finish_reason ?? 'unknown'
      lastError = `The model returned an empty response (finish_reason=${finish}).`
      if (attempt < retries) {
        await sleep(400 * (attempt + 1))
        continue
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      lastError = msg
      if (attempt < retries && /timeout|empty|ECONNRESET|429|503/i.test(msg)) {
        await sleep(600 * (attempt + 1))
        continue
      }
      throw err instanceof Error ? err : new Error(msg)
    }
  }

  throw new Error(lastError)
}
