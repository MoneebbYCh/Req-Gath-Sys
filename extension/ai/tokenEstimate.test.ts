import { describe, expect, it } from 'vitest'
import { estimateTokens, resolveContextTokens } from './tokenEstimate'

describe('tokenEstimate', () => {
  it('estimateTokens rounds up by char length', () => {
    expect(estimateTokens('abcd')).toBe(1)
    expect(estimateTokens('a'.repeat(8))).toBe(2)
  })

  it('resolveContextTokens uses provider defaults', () => {
    expect(resolveContextTokens('deepseek')).toBe(128_000)
    expect(resolveContextTokens('local')).toBe(32_000)
    expect(resolveContextTokens('deepseek', 64_000)).toBe(64_000)
  })
})
