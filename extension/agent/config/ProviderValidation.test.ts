// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { listProviderModels, validateProviderKey } from './ProviderValidation'

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response
}

describe('validateProviderKey', () => {
  it('returns the exposed model list on success', async () => {
    const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe('https://api.deepseek.com/v1/models')
      expect(init?.headers).toMatchObject({ Authorization: 'Bearer sk-x' })
      return jsonResponse(200, {
        data: [{ id: 'deepseek-v4-flash' }, { id: 'deepseek-v4-pro' }, { id: 42 }],
      })
    })
    const result = await validateProviderKey('https://api.deepseek.com/v1/', 'sk-x', fetchFn)
    expect(result).toEqual({ ok: true, models: ['deepseek-v4-flash', 'deepseek-v4-pro'] })
  })

  it('reports invalid keys on 401/403', async () => {
    const result = await validateProviderKey(
      'https://x/v1',
      'bad',
      vi.fn(async () => jsonResponse(401, { error: {} })),
    )
    expect(result.ok).toBe(false)
    expect(result.error).toContain('Invalid API key')
  })

  it('reports other HTTP failures with the status', async () => {
    const result = await validateProviderKey(
      'https://x/v1',
      'k',
      vi.fn(async () => jsonResponse(500, {})),
    )
    expect(result.ok).toBe(false)
    expect(result.error).toContain('500')
  })

  it('reports network failures', async () => {
    const result = await validateProviderKey(
      'https://x/v1',
      'k',
      vi.fn(async () => {
        throw new TypeError('fetch failed')
      }),
    )
    expect(result.ok).toBe(false)
    expect(result.error).toContain('Could not reach the provider')
  })

  it('reports unreadable model lists', async () => {
    const result = await validateProviderKey(
      'https://x/v1',
      'k',
      vi.fn(
        async () =>
          ({
            ok: true,
            status: 200,
            json: async () => {
              throw new SyntaxError('Unexpected token')
            },
          }) as unknown as Response,
      ),
    )
    expect(result.ok).toBe(false)
    expect(result.error).toContain('unreadable model list')
  })
})

describe('listProviderModels', () => {
  const def = { baseUrl: 'https://api.deepseek.com/v1', defaultModel: 'deepseek-v4-flash' }

  it('returns the already-validated list without a network call', async () => {
    const validateFn = vi.fn()
    const models = await listProviderModels(def, 'sk-x', ['deepseek-v4-pro'], validateFn)
    expect(models).toEqual(['deepseek-v4-pro'])
    expect(validateFn).not.toHaveBeenCalled()
  })

  it('returns nothing when no key is stored', async () => {
    const validateFn = vi.fn()
    expect(await listProviderModels(def, undefined, [], validateFn)).toEqual([])
    expect(validateFn).not.toHaveBeenCalled()
  })

  it('discovers and sorts the provider model list once', async () => {
    const validateFn = vi.fn(async () => ({
      ok: true,
      models: ['deepseek-v4-pro', 'deepseek-chat', 'deepseek-v4-flash'],
    }))
    const models = await listProviderModels(def, 'sk-x', [], validateFn)
    expect(models).toEqual(['deepseek-chat', 'deepseek-v4-flash', 'deepseek-v4-pro'])
    expect(validateFn).toHaveBeenCalledWith('https://api.deepseek.com/v1', 'sk-x')
  })

  it('falls back to the default model when discovery fails', async () => {
    const validateFn = vi.fn(async () => ({ ok: false, error: 'Could not reach the provider' }))
    expect(await listProviderModels(def, 'sk-x', [], validateFn)).toEqual(['deepseek-v4-flash'])
    expect(await listProviderModels({ baseUrl: def.baseUrl }, 'sk-x', [], validateFn)).toEqual([])
  })
})
