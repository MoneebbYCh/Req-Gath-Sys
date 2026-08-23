import { describe, expect, it } from 'vitest'
import {
  API_KEY_SECRET,
  apiKeySecret,
  clearApiKey,
  loadProviderConfig,
  storeApiKey,
  type SecretStoreLike,
} from './ProviderConfig'

function fakeSecrets(initial?: Record<string, string>): SecretStoreLike & { data: Record<string, string> } {
  const data = { ...initial }
  return {
    data,
    get: async (key) => data[key],
    store: async (key, value) => {
      data[key] = value
    },
    delete: async (key) => {
      delete data[key]
    },
  }
}

describe('ProviderConfig', () => {
  it('loads a catalog provider with backend, baseUrl, and stored key', async () => {
    const secrets = fakeSecrets({ [apiKeySecret('deepseek')]: 'sk-secret' })
    const config = await loadProviderConfig(secrets, {
      provider: 'deepseek',
      model: '',
      baseUrl: '',
    })
    expect(config).toEqual({
      providerId: 'deepseek',
      backend: 'openai',
      model: 'deepseek-v4-pro', // catalogue default
      baseUrl: 'https://api.deepseek.com/v1',
      apiKey: 'sk-secret',
    })
  })

  it('ignores stale non-DeepSeek settings and still uses DeepSeek', async () => {
    const config = await loadProviderConfig(fakeSecrets(), {
      provider: 'custom',
      model: 'deepseek-v4-flash',
      baseUrl: 'https://local:11434/v1',
    })
    expect(config.backend).toBe('openai')
    expect(config.providerId).toBe('deepseek')
    expect(config.baseUrl).toBe('https://api.deepseek.com/v1')
    expect(config.model).toBe('deepseek-v4-flash')
    expect(config.apiKey).toBeUndefined()
  })

  it('rejects a stale non-DeepSeek model setting', async () => {
    const config = await loadProviderConfig(fakeSecrets(), {
      provider: 'deepseek',
      model: 'gpt-4o',
      baseUrl: '',
    })
    expect(config.model).toBe('deepseek-v4-pro')
  })

  it('falls back to DeepSeek for unknown ids', async () => {
    const config = await loadProviderConfig(fakeSecrets(), {
      provider: 'garbage',
      model: '',
      baseUrl: '',
    })
    expect(config.providerId).toBe('deepseek')
    expect(config.backend).toBe('openai')
    expect(config.baseUrl).toBe('https://api.deepseek.com/v1')
  })

  it('stores and clears keys under a provider-scoped secret name', async () => {
    const secrets = fakeSecrets()
    await storeApiKey(secrets, 'deepseek', 'sk-new')
    expect(secrets.data[apiKeySecret('deepseek')]).toBe('sk-new')
    await clearApiKey(secrets, 'deepseek')
    expect(secrets.data[apiKeySecret('deepseek')]).toBeUndefined()
  })

  it('migrates the legacy key to the active provider once', async () => {
    const secrets = fakeSecrets({ [API_KEY_SECRET]: 'sk-legacy' })
    const config = await loadProviderConfig(secrets, { provider: 'deepseek', model: '', baseUrl: '' })
    expect(config.apiKey).toBe('sk-legacy')
    expect(secrets.data[apiKeySecret('deepseek')]).toBe('sk-legacy')
    expect(secrets.data[API_KEY_SECRET]).toBeUndefined()
  })
})
