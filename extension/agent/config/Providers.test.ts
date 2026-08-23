import { describe, expect, it } from 'vitest'
import { PROVIDERS, normalizeProviderId, providerDef } from './Providers'

describe('Providers catalogue', () => {
  it('exposes DeepSeek as the only active provider and normalizes stale ids to it', () => {
    expect(PROVIDERS).toHaveLength(1)
    expect(normalizeProviderId('garbage')).toBe('deepseek')
    expect(providerDef('garbage').id).toBe('deepseek')
    expect(providerDef('garbage').backend).toBe('openai')
  })

  it('covers every provider with a backend', () => {
    for (const p of PROVIDERS) {
      expect(normalizeProviderId(p.id)).toBe(p.id)
      expect(p.backend).toBe('openai')
    }
  })

  it('deepseek uses the openai backend with its base URL', () => {
    const def = providerDef('deepseek')
    expect(def.backend).toBe('openai')
    expect(def.baseUrl).toBe('https://api.deepseek.com/v1')
    expect(def.keyRequired).toBe(true)
  })
})
