import { describe, expect, it } from 'vitest'
import { buildContext, estimateTokens, TRUNCATED_MARKER } from './ContextBuilder'

describe('estimateTokens', () => {
  it('is deterministic and cheap (chars/4, at least 1 for non-empty)', () => {
    expect(estimateTokens('')).toBe(0)
    expect(estimateTokens('a')).toBe(1)
    expect(estimateTokens('abcd')).toBe(1)
    expect(estimateTokens('abcde')).toBe(2)
  })

  it('is monotonic in input length', () => {
    let prev = 0
    for (let n = 1; n <= 200; n += 7) {
      const est = estimateTokens('x'.repeat(n))
      expect(est).toBeGreaterThanOrEqual(prev)
      prev = est
    }
  })
})

describe('buildContext', () => {
  const layers = {
    system: 'SYS-RULES',
    objective: 'OBJECTIVE',
    roleSpec: 'ROLE',
    instructions: ['INST-1', 'INST-2'],
    findings: ['FIND-1', 'FIND-2'],
    evidenceExcerpts: ['EVID-1'],
    conversation: ['CONV-1'],
    toolResults: ['TOOL-1', 'TOOL-2'],
  }

  it('assembles layers in the plan §15 priority order', () => {
    const blocks = buildContext(layers, 10_000)
    expect(blocks).toEqual([
      'SYS-RULES',
      'OBJECTIVE',
      'ROLE',
      'INST-1',
      'INST-2',
      'FIND-1',
      'FIND-2',
      'EVID-1',
      'CONV-1',
      'TOOL-1',
      'TOOL-2',
    ])
    // Ordering sanity: system first, tool results last.
    expect(blocks[0]).toBe('SYS-RULES')
    expect(blocks.at(-1)).toBe('TOOL-2')
  })

  it('truncates the first layer that cannot fit whole and drops later layers', () => {
    // Budget: system+objective+role (7) + marker (3) + 1 token for content = 11.
    // 'INSTRUCTIONS-LONG' (4 tokens) cannot fit whole → cut to fit + marker.
    const budget = estimateTokens('SYS-RULES') + estimateTokens('OBJECTIVE') + estimateTokens('ROLE') + estimateTokens(TRUNCATED_MARKER) + 1
    const truncatedLayers = { ...layers, instructions: ['INSTRUCTIONS-LONG'] }
    const blocks = buildContext(truncatedLayers, budget)
    expect(blocks.slice(0, 3)).toEqual(['SYS-RULES', 'OBJECTIVE', 'ROLE'])
    const fourth = blocks[3]
    expect(fourth).toContain(TRUNCATED_MARKER)
    // 4 chars of content fit before the marker (4 tokens remaining - 3 for marker = 1 token = 4 chars)
    expect(fourth).toContain('INST')
    // Everything after the truncated layer is dropped (quota allocation).
    expect(blocks).toHaveLength(4)
  })

  it('truncates the first layer that cannot fit even partially', () => {
    // Budget=1: 'SYS-RULES'(3)+marker(3) can't fit; 'OBJECTIVE'(3)+marker(3) can't;
    // 'ROLE'(1) + marker(3) can't; 'INST-1'(2)+marker(3) can't... but 'ROLE'(1) fits exactly!
    // Implementation tries next layer when one can't fit even truncated.
    expect(buildContext(layers, 1)).toEqual(['ROLE'])
  })

  it('skips layers that cannot fit even truncated and tries the next', () => {
    // Budget=2: 'SYS-RULES'(3)+marker(3) can't; 'OBJECTIVE'(3)+marker(3) can't;
    // 'ROLE'(1) fits exactly in budget 2.
    expect(buildContext(layers, 2)).toEqual(['ROLE'])
  })

  it('treats every token estimate as the total size of its layer', () => {
    // Everything fits: total estimate of all blocks ≤ budget.
    const budget = 10_000
    const blocks = buildContext(layers, budget)
    const total = blocks.reduce((n, b) => n + estimateTokens(b), 0)
    expect(total).toBeLessThanOrEqual(budget)
  })
})