import { describe, expect, it } from 'vitest'
import { truncateStringsToBudget } from './OutputLimiter'

describe('truncateStringsToBudget', () => {
  it('returns small values unchanged', () => {
    const value = { a: 'hello', b: [1, 2, 3] }
    const result = truncateStringsToBudget(value, 10_000)
    expect(result.truncated).toBe(false)
    expect(result.value).toEqual(value)
  })

  it('halves the largest string until the result fits the budget', () => {
    const value = { a: 'x'.repeat(2_000), b: 'y'.repeat(100) }
    const result = truncateStringsToBudget(value, 500)
    expect(result.truncated).toBe(true)
    const bytes = JSON.stringify(result.value).length
    expect(bytes).toBeLessThanOrEqual(500)
    const data = result.value as { a: string; b: string }
    expect(data.b).toBe('y'.repeat(100)) // the small string survives
    expect(data.a.length).toBeLessThan(2_000)
  })

  it('truncates strings inside nested arrays and objects', () => {
    const value = { rows: [{ text: 'a'.repeat(5_000) }, { text: 'b' }] }
    const result = truncateStringsToBudget(value, 300)
    expect(result.truncated).toBe(true)
    expect(JSON.stringify(result.value).length).toBeLessThanOrEqual(300)
  })

  it('reports truncated even when there are no strings to cut', () => {
    const value = { numbers: Array.from({ length: 1_000 }, (_, i) => i) }
    const result = truncateStringsToBudget(value, 200)
    expect(result.truncated).toBe(true)
  })
})
