/** Rough token estimate (~4 chars/token), aligned with OpenCode's Token.estimate usage. */
export function estimateTokens(text: string): number {
  if (!text) return 0
  return Math.ceil(text.length / 4)
}

export function estimateMessagesTokens(messages: { content: string }[]): number {
  return messages.reduce((n, m) => n + estimateTokens(m.content), 0)
}

/** Default context window sizes when the provider does not specify one. */
export const DEFAULT_CONTEXT_TOKENS: Record<string, number> = {
  deepseek: 128_000,
  kimi: 128_000,
  local: 32_000,
}

export function resolveContextTokens(provider: string, override?: number): number {
  if (override !== undefined && override > 0) return override
  return DEFAULT_CONTEXT_TOKENS[provider] ?? 128_000
}
