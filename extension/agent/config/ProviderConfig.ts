import { normalizeProviderId, providerDef } from './Providers'

/**
 * Provider configuration (plan §3): API credentials live ONLY in VS Code
 * SecretStorage and runtime memory — never in settings, `.charter-ai/`, or
 * webview state. Non-secret preferences (provider/model/baseUrl) come from
 * VS Code settings.
 */
/** Legacy unscoped secret, retained solely to migrate existing installations. */
export const API_KEY_SECRET = 'charterAi.apiKey'

/** Keys are provider-scoped so changing providers can never reuse another provider's credential. */
export function apiKeySecret(providerId: string): string {
  return `${API_KEY_SECRET}.${normalizeProviderId(providerId)}`
}

export interface ProviderConfig {
  providerId: string
  /** DeepSeek uses the OpenAI-compatible adapter. */
  backend: 'openai'
  model: string
  baseUrl?: string
  apiKey?: string
}

export interface ProviderSettings {
  provider: string
  model: string
  baseUrl: string
}

/** Minimal SecretStorage surface (satisfied by vscode.SecretStorage and fakes). */
export interface SecretStoreLike {
  get(key: string): Thenable<string | undefined>
  store(key: string, value: string): Thenable<void>
  delete(key: string): Thenable<void>
}

function normalizeDeepSeekModel(model: string, fallback: string): string {
  const requested = model.trim()
  return requested.startsWith('deepseek-') ? requested : fallback
}

/** Reads a provider's key and migrates the legacy single-key storage if needed. */
export async function loadApiKey(secrets: SecretStoreLike, providerId: string): Promise<string | undefined> {
  const normalizedProviderId = normalizeProviderId(providerId)
  let apiKey = await secrets.get(apiKeySecret(normalizedProviderId))
  if (!apiKey) {
    const legacyKey = await secrets.get(API_KEY_SECRET)
    if (legacyKey) {
      await secrets.store(apiKeySecret(normalizedProviderId), legacyKey)
      await secrets.delete(API_KEY_SECRET)
      apiKey = legacyKey
    }
  }
  return apiKey
}

export async function loadProviderConfig(
  secrets: SecretStoreLike,
  settings: ProviderSettings,
): Promise<ProviderConfig> {
  // Provider selection is intentionally ignored while DeepSeek is the sole
  // supported provider. This also makes legacy OpenAI/custom settings safe.
  const providerId = normalizeProviderId(settings.provider)
  const def = providerDef(providerId)
  const apiKey = await loadApiKey(secrets, providerId)
  return {
    providerId,
    backend: def.backend,
    model: normalizeDeepSeekModel(settings.model, def.defaultModel || 'deepseek-v4-flash'),
    baseUrl: def.baseUrl,
    apiKey: apiKey || undefined,
  }
}

export async function storeApiKey(secrets: SecretStoreLike, providerId: string, key: string): Promise<void> {
  await secrets.store(apiKeySecret(providerId), key)
}

export async function clearApiKey(secrets: SecretStoreLike, providerId: string): Promise<void> {
  await secrets.delete(apiKeySecret(providerId))
}
