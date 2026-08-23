import { describe, expect, it } from 'vitest'
import { extractJsonBlock } from './jsonBlock'

describe('extractJsonBlock', () => {
  it('extracts fenced json blocks', () => {
    expect(extractJsonBlock('text\n```json\n{"a":1}\n```\nmore')).toEqual({ a: 1 })
    expect(extractJsonBlock('```\n{"a":1}\n```')).toEqual({ a: 1 })
  })

  it('falls back to the first {...} object in plain text', () => {
    expect(extractJsonBlock('here is the result: {"a": 1} done')).toEqual({ a: 1 })
  })

  it('returns undefined (never throws) for garbage', () => {
    expect(extractJsonBlock('no json at all')).toBeUndefined()
    expect(extractJsonBlock('')).toBeUndefined()
  })
})
