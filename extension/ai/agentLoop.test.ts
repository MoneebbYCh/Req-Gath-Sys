import { describe, expect, it } from 'vitest'
import { historyToMessages, parseStep } from './agentLoop'

describe('historyToMessages', () => {
  it('includes research checkpoints on assistant turns', () => {
    const messages = historyToMessages([
      {
        role: 'assistant',
        text: 'Short answer',
        researchCheckpoint: '<prior-research>Tool sequence: grep → read_file</prior-research>',
      },
      { role: 'user', text: 'Follow up question' },
    ])
    expect(messages).toHaveLength(2)
    expect(messages[0].content).toContain('<prior-research>')
    expect(messages[0].content).toContain('Short answer')
  })
})

describe('parseStep final JSON', () => {
  it('still parses final responses without legacy tool calls', () => {
    const step = parseStep('{"message":"done","document":null,"anchors":null}')
    expect(step?.final?.message).toBe('done')
    expect(step?.tool).toBeUndefined()
  })
})
