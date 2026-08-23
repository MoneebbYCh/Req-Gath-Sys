/**
 * API-key validation (plan: "The api key should be validated"): hits the
 * provider's `GET /models` endpoint with the key and returns the exposed model
 * list on success. Runs in the extension host, where SecretStorage lives.
 */
export interface ProviderValidationResult {
  ok: boolean
  models?: string[]
  error?: string
}

const VALIDATION_TIMEOUT_MS = 15_000

export async function validateProviderKey(
  baseUrl: string,
  apiKey: string,
  fetchFn: (url: string, init?: RequestInit) => Promise<Response> = fetch,
): Promise<ProviderValidationResult> {
  const url = `${baseUrl.replace(/\/+$/, '')}/models`
  let response: Response
  try {
    response = await fetchFn(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(VALIDATION_TIMEOUT_MS),
    })
  } catch (err) {
    if (err instanceof Error && err.name === 'TimeoutError') {
      return { ok: false, error: 'Validation timed out — check the base URL and network.' }
    }
    return {
      ok: false,
      error: `Could not reach the provider: ${err instanceof Error ? err.message : String(err)}`,
    }
  }

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      return { ok: false, error: 'Invalid API key — the provider rejected it.' }
    }
    return { ok: false, error: `Validation failed (HTTP ${response.status}).` }
  }

  try {
    const data = (await response.json()) as { data?: Array<{ id?: unknown }> }
    const models = (data.data ?? [])
      .map((m) => m.id)
      .filter((id): id is string => typeof id === 'string' && id.length > 0)
    return { ok: true, models }
  } catch {
    return { ok: false, error: 'Provider returned an unreadable model list.' }
  }
}

/**
 * Models a configured provider exposes (chat model picker). A list already
 * validated this session wins; otherwise ONE silent /models discovery runs
 * when a key exists. Discovery failure falls back to the default model so
 * the picker still offers something usable instead of nothing.
 */
export async function listProviderModels(
  def: { baseUrl: string; defaultModel?: string },
  apiKey: string | undefined,
  known: string[],
  validateFn: (baseUrl: string, apiKey: string) => Promise<ProviderValidationResult> = validateProviderKey,
): Promise<string[]> {
  if (known.length > 0) return known
  if (!apiKey) return []
  const result = await validateFn(def.baseUrl, apiKey)
  if (result.ok && result.models && result.models.length > 0) return [...result.models].sort()
  return def.defaultModel ? [def.defaultModel] : []
}
