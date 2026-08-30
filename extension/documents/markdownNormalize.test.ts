import { describe, expect, it } from 'vitest'
import { normalizeMarkdown } from './markdownNormalize'

describe('normalizeMarkdown', () => {
  it('converts bullet glyphs to hyphen markers', () => {
    expect(normalizeMarkdown('• one\n‣ two\n– three')).toBe('- one\n- two\n- three')
  })

  it('inserts a blank line before a list that follows prose', () => {
    expect(normalizeMarkdown('Intro\n- a\n- b')).toBe('Intro\n\n- a\n- b')
    expect(normalizeMarkdown('Intro\n1. a')).toBe('Intro\n\n1. a')
  })

  it('normalizes CRLF and trims', () => {
    expect(normalizeMarkdown('  hi\r\n\r\nthere  ')).toBe('hi\n\nthere')
  })
})
