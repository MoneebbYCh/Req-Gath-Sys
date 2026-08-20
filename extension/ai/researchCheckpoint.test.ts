import { describe, expect, it } from 'vitest'
import {
  attachCheckpointToAssistantText,
  buildResearchCheckpoint,
  extractGrepPatterns,
  extractToolSequence,
  formatHistoryTurnContent,
} from './researchCheckpoint'
import type { ChatMessage } from './llmClient'

describe('researchCheckpoint', () => {
  it('extracts tool sequence from native tool messages', () => {
    const messages: ChatMessage[] = [
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: '1', name: 'grep', args: { pattern: 'foo' } },
          { id: '2', name: 'read_file', args: { path: 'a.ts' } },
        ],
      },
      { role: 'tool', tool_call_id: '1', name: 'grep', content: 'hits' },
      { role: 'tool', tool_call_id: '2', name: 'read_file', content: 'extension/a.ts:1-5\n1\tconst x = 1' },
    ]
    expect(extractToolSequence(messages)).toEqual(['grep', 'read_file'])
  })

  it('builds checkpoint with read evidence', () => {
    const messages: ChatMessage[] = [
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: '1', name: 'read_file', args: { path: 'extension/ai/agent.ts' } }],
      },
      {
        role: 'tool',
        tool_call_id: '1',
        name: 'read_file',
        content: 'extension/ai/agent.ts:93-95\n93\texport async function processChat',
      },
    ]
    const checkpoint = buildResearchCheckpoint(messages)
    expect(checkpoint).toContain('<prior-research>')
    expect(checkpoint).toContain('read_file')
    expect(checkpoint).toContain('extension/ai/agent.ts:93')
  })

  it('extracts grep patterns from tool call args', () => {
    const messages: ChatMessage[] = [
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: '1', name: 'grep', args: { patterns: ['redis', 'ioredis'] } },
        ],
      },
    ]
    expect(extractGrepPatterns(messages)).toEqual(['redis', 'ioredis'])
  })

  it('formatHistoryTurnContent attaches checkpoint to assistant turns', () => {
    const formatted = formatHistoryTurnContent({
      role: 'assistant',
      text: 'Found processChat in agent.ts',
      researchCheckpoint: '<prior-research>grep → read_file</prior-research>',
    })
    expect(formatted).toContain('processChat')
    expect(formatted).toContain('<prior-research>')
  })

  it('attachCheckpointToAssistantText avoids duplicate blocks', () => {
    const text = 'Answer\n\n<prior-research>existing</prior-research>'
    expect(attachCheckpointToAssistantText(text, '<prior-research>new</prior-research>')).toBe(text)
  })
})
