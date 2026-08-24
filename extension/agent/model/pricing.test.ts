// @vitest-environment node
import { describe, expect, it, vi, beforeEach } from 'vitest'
import {
  resolvePricing,
  clearPricingCache,
  type ModelPricingRates,
} from './pricing'

// Mock vscode before importing pricing
const fakeFS = new Map<string, Uint8Array>()

vi.mock('vscode', () => ({
  workspace: {
    fs: {
      readFile: vi.fn(async (uri: { fsPath: string }) => {
        const data = fakeFS.get(uri.fsPath)
        if (!data) throw new Error('File not found')
        return data
      }),
      writeFile: vi.fn(async (uri: { fsPath: string }, data: Uint8Array) => {
        fakeFS.set(uri.fsPath, data)
      }),
      delete: vi.fn(async (uri: { fsPath: string }) => {
        fakeFS.delete(uri.fsPath)
      }),
    },
    getConfiguration: vi.fn(() => ({ get: () => undefined })),
  },
  Uri: {
    file: (path: string) => ({ fsPath: path }),
    joinPath: (base: { fsPath: string }, ...parts: string[]) => ({
      fsPath: [base.fsPath, ...parts].join('/'),
    }),
  },
}))

describe('pricing.ts', () => {
  const storagePath = '/fake/storage'
  const cachePath = `${storagePath}/models-dev-pricing-cache.json`

  beforeEach(() => {
    fakeFS.clear()
    vi.clearAllMocks()
  })

  it('returns config override when present', async () => {
    const config: Record<string, ModelPricingRates> = {
      'deepseek/deepseek-v4-flash': {
        inputPerMillion: 1.0,
        outputPerMillion: 2.0,
        cacheReadPerMillion: 0.01,
        cacheWritePerMillion: 0.02,
        reasoningPerMillion: 2.0,
      },
    }
    const rates = await resolvePricing('deepseek', 'deepseek-v4-flash', storagePath, config)
    expect(rates).toEqual(config['deepseek/deepseek-v4-flash'])
  })

  it('returns vendored DeepSeek pricing when cache empty and offline', async () => {
    const rates = await resolvePricing('deepseek', 'deepseek-v4-flash', storagePath)
    expect(rates).toEqual({
      inputPerMillion: 0.14,
      outputPerMillion: 0.28,
      cacheReadPerMillion: 0.0028,
      cacheWritePerMillion: 0.0028,
      reasoningPerMillion: 0.28,
    })
  })

  it('returns null for unknown provider', async () => {
    const rates = await resolvePricing('unknown', 'model', storagePath)
    expect(rates).toBeNull()
  })

  it('returns null for unknown model', async () => {
    const rates = await resolvePricing('deepseek', 'unknown-model', storagePath)
    expect(rates).toBeNull()
  })

  it('uses cached catalog when fresh', async () => {
    const cached = {
      fetchedAt: Date.now(),
      data: {
        deepseek: {
          models: {
            'deepseek-v4-flash': {
              cost: { input: 0.15, output: 0.30, cache_read: 0.003, cache_write: 0.004, reasoning: 0.30 },
            },
          },
        },
      },
    }
    await fakeFS.set(
      cachePath,
      new TextEncoder().encode(JSON.stringify(cached)),
    )

    const rates = await resolvePricing('deepseek', 'deepseek-v4-flash', storagePath)
    expect(rates).toEqual({
      inputPerMillion: 0.15,
      outputPerMillion: 0.30,
      cacheReadPerMillion: 0.003,
      cacheWritePerMillion: 0.004,
      reasoningPerMillion: 0.30,
    })
  })

  it('ignores stale cache and falls back to vendored', async () => {
    const stale = {
      fetchedAt: Date.now() - 8 * 24 * 60 * 60 * 1000, // 8 days old
      data: {
        deepseek: {
          models: {
            'deepseek-v4-flash': {
              cost: { input: 999, output: 999 },
            },
          },
        },
      },
    }
    await fakeFS.set(
      cachePath,
      new TextEncoder().encode(JSON.stringify(stale)),
    )

    const rates = await resolvePricing('deepseek', 'deepseek-v4-flash', storagePath)
    // Should fall back to vendored (0.14/0.28) not stale (999)
    expect(rates?.inputPerMillion).toBe(0.14)
  })

  it('clears cache', async () => {
    await fakeFS.set(
      cachePath,
      new TextEncoder().encode('{}'),
    )
    await clearPricingCache(storagePath)
    expect(fakeFS.has(cachePath)).toBe(false)
  })
})