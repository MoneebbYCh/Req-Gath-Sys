/**
 * Per-model pricing resolver backed by models.dev catalog.
 * - Fetches models.dev/api.json lazily, caches to VS Code globalStorage (7-day TTL)
 * - Falls back to vendored DeepSeek snapshot for offline/first-run
 * - Config override from VS Code settings 'charterAi.pricing' wins over catalog
 * - Unknown models return null (UI shows '—', never fake $0.00)
 */
import * as vscode from 'vscode'

const MODELS_DEV_URL = 'https://models.dev/api.json'
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000 // 7 days
const CACHE_FILENAME = 'models-dev-pricing-cache.json'

export interface ModelPricingRates {
  inputPerMillion: number
  outputPerMillion: number
  cacheReadPerMillion?: number
  cacheWritePerMillion?: number
  reasoningPerMillion?: number
}

interface ModelsDevCatalog {
  [providerId: string]: {
    models: {
      [modelId: string]: {
        cost: {
          input?: number
          output?: number
          cache_read?: number
          cache_write?: number
          reasoning?: number
        }
      }
    }
  }
}

interface CachedCatalog {
  fetchedAt: number
  data: ModelsDevCatalog
}

/** Minimal vendored DeepSeek pricing for offline/first-run fallback. */
const VENDORED_DEEPSEEK: ModelsDevCatalog = {
  deepseek: {
    models: {
      'deepseek-v4-flash': {
        cost: { input: 0.14, output: 0.28, cache_read: 0.0028, cache_write: 0.0028, reasoning: 0.28 },
      },
      'deepseek-v4': {
        cost: { input: 0.14, output: 0.28, cache_read: 0.0028, cache_write: 0.0028, reasoning: 0.28 },
      },
    },
  },
}

/**
 * Resolves per-model pricing from models.dev catalog with config override.
 * @param storagePath Path to VS Code globalStorage directory (context.globalStorageUri.fsPath)
 * @param configPricing Optional override from charterAi.pricing settings
 */
export async function resolvePricing(
  providerId: string,
  modelId: string,
  storagePath: string,
  configPricing?: Record<string, ModelPricingRates>,
): Promise<ModelPricingRates | null> {
  // 1. Config override wins
  const configKey = `${providerId}/${modelId}`
  if (configPricing?.[configKey]) {
    return configPricing[configKey]
  }

  // 2. Try cached catalog
  const catalog = await loadCatalog(storagePath)

  const provider = catalog[providerId]
  if (!provider) return null

  const model = provider.models[modelId]
  if (!model?.cost) return null

  const cost = model.cost
  return {
    inputPerMillion: cost.input ?? 0,
    outputPerMillion: cost.output ?? 0,
    cacheReadPerMillion: cost.cache_read,
    cacheWritePerMillion: cost.cache_write,
    reasoningPerMillion: cost.reasoning,
  }
}

/** Loads catalog from cache or fetches from models.dev with background refresh. */
async function loadCatalog(storagePath: string): Promise<ModelsDevCatalog> {
  const cachePath = vscode.Uri.joinPath(vscode.Uri.file(storagePath), CACHE_FILENAME)
  let catalog: ModelsDevCatalog = VENDORED_DEEPSEEK
  let cacheValid = false

  // Try read cached catalog
  try {
    const data = await vscode.workspace.fs.readFile(cachePath)
    const parsed = JSON.parse(new TextDecoder().decode(data)) as CachedCatalog
    const age = Date.now() - parsed.fetchedAt
    if (age < CACHE_TTL_MS) {
      catalog = { ...VENDORED_DEEPSEEK, ...parsed.data }
      cacheValid = true
    }
  } catch {
    // Cache miss or corrupt — use vendored fallback
  }

  // Fire-and-forget background refresh if stale or missing
  if (!cacheValid) {
    fetchAndCacheCatalog(cachePath).catch(() => {})
  }

  return catalog
}

/** Fetches models.dev and writes to cache. */
async function fetchAndCacheCatalog(cachePath: vscode.Uri): Promise<void> {
  const res = await fetch(MODELS_DEV_URL)
  if (!res.ok) return
  const data = (await res.json()) as ModelsDevCatalog
  const cached: CachedCatalog = { fetchedAt: Date.now(), data }
  await vscode.workspace.fs.writeFile(cachePath, new TextEncoder().encode(JSON.stringify(cached)))
}

/** Clears the pricing cache (for testing or manual refresh). */
export async function clearPricingCache(storagePath: string): Promise<void> {
  const cachePath = vscode.Uri.joinPath(vscode.Uri.file(storagePath), CACHE_FILENAME)
  try {
    await vscode.workspace.fs.delete(cachePath)
  } catch {
    // Ignore
  }
}