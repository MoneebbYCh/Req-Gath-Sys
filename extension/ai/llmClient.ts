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

export interface EmbeddingProviderInfo {
  baseUrl: string
  defaultModel: string
  /** Env var holding the API key, if the provider needs one. */
  env: string
}

/** Providers used for code embeddings (separate from the chat model). */
export const EMBEDDING_PROVIDERS: Record<string, EmbeddingProviderInfo> = {
  ollama: {
    baseUrl: 'http://localhost:11434/v1',
    defaultModel: 'nomic-embed-text',
    env: '',
  },
  openai: {
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'text-embedding-3-small',
    env: 'OPENAI_API_KEY',
  },
}

// Checked after the provider-specific variable above.
const GENERIC_ENV_VARS = ['REQ_GATH_SYS_API_KEY', 'LLM_API_KEY'] as const

export interface LlmConfig {
  provider: string
  model?: string | null
  apiKey: string
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

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
  const { jsonMode = true, timeout = 180_000, maxTokens = 8192, retries = 2 } = options
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
    messages,
    max_tokens: maxTokens,
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
          ? `The model hit the token limit before writing an answer (finish_reason=length` +
            `${reasoningLen ? `, reasoning_chars=${reasoningLen}` : ''}). Try a shorter request or open the document and ask again.`
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
