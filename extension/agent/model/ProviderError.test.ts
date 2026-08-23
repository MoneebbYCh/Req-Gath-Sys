import { describe, expect, it } from 'vitest'
import { ProviderError, isRetryableProviderError, providerErrorMessage } from './ProviderError'

describe('ProviderError', () => {
  it('categorizes retryable kinds', () => {
    expect(new ProviderError('rate_limited', 'x').retryable).toBe(true)
    expect(new ProviderError('server', 'x').retryable).toBe(true)
    expect(new ProviderError('network', 'x').retryable).toBe(true)
    expect(new ProviderError('timeout', 'x').retryable).toBe(true)
  })

  it('categorizes non-retryable kinds', () => {
    expect(new ProviderError('auth', 'x').retryable).toBe(false)
    expect(new ProviderError('cancelled', 'x').retryable).toBe(false)
    expect(new ProviderError('invalid_response', 'x').retryable).toBe(false)
    expect(new ProviderError('unknown', 'x').retryable).toBe(false)
  })

  it('isRetryableProviderError distinguishes provider errors from generic ones', () => {
    expect(isRetryableProviderError(new ProviderError('rate_limited', 'x'))).toBe(true)
    expect(isRetryableProviderError(new ProviderError('auth', 'x'))).toBe(false)
    expect(isRetryableProviderError(new Error('rate_limited'))).toBe(false)
    expect(isRetryableProviderError('rate_limited')).toBe(false)
  })

  it('produces friendly messages for the UI', () => {
    expect(providerErrorMessage('auth')).toContain('API Key')
    expect(providerErrorMessage('rate_limited', 'Retry-After: 30')).toContain('Retry-After: 30')
  })
})
