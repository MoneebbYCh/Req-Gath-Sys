/**
 * Provider catalogue for the current DeepSeek-only release. The provider
 * boundary remains OpenAI-compatible, so additional backends can be restored
 * later without changing agent orchestration.
 */
export type ProviderBackend = 'openai'

export interface ProviderDefinition {
  id: string
  label: string
  /** Base URL for the OpenAI-compatible DeepSeek API. */
  baseUrl: string
  /** Which backend adapter runs it. */
  backend: ProviderBackend
  keyRequired: boolean
  defaultModel?: string
}

export const PROVIDERS: readonly ProviderDefinition[] = [
  {
    id: 'deepseek',
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    backend: 'openai',
    keyRequired: true,
    defaultModel: 'deepseek-v4-pro',
  },
]

// Future provider definitions intentionally remain disabled for this release.
// { id: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', backend: 'openai', keyRequired: true, defaultModel: 'gpt-4o' },
// { id: 'custom', label: 'Custom (OpenAI-compatible)', baseUrl: '', backend: 'openai', keyRequired: true },

export function providerDef(id: string): ProviderDefinition {
  return PROVIDERS.find((p) => p.id === id) ?? PROVIDERS[0]
}

/** Stale or unsupported settings must never route a key to another provider. */
export function normalizeProviderId(value: string): string {
  return value === 'deepseek' ? value : 'deepseek'
}
