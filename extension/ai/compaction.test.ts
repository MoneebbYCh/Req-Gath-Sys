import { describe, expect, it } from 'vitest'
import type { ChatMessage } from './llmClient'
import {
  buildCompactionPrompt,
  extractPriorSummary,
  extractReadEvidence,
  selectMessagesForCompaction,
  SUMMARY_TEMPLATE,
} from './compaction'
import { analyzeReadAccuracyRun, extractCitations, READ_ACCURACY_FIXTURES } from './readAccuracy.fixtures'

describe('readAccuracy.fixtures', () => {
  it('defines baseline fixtures', () => {
    expect(READ_ACCURACY_FIXTURES.length).toBeGreaterThanOrEqual(5)
  })

  it('extractCitations finds path:line references', () => {
    const cites = extractCitations('See extension/ai/agent.ts:93 for details.')
    expect(cites).toContain('extension/ai/agent.ts:93')
  })

  it('analyzeReadAccuracyRun flags truncation without follow-up', () => {
    const log = analyzeReadAccuracyRun({
      fixtureId: 'read-truncation',
      toolSequence: ['grep', 'read_file'],
      transcript: 'Found matches.\n[truncated at line 2000 of 4500]\nDone.',
    })
    expect(log.truncationWithoutFollowUp).toBe(true)
  })
})

describe('compaction', () => {
  it('extractReadEvidence collects citations from read_file observations', () => {
    const messages: ChatMessage[] = [
      {
        role: 'tool',
        name: 'read_file',
        content: 'extension/ai/agent.ts:47-50\n47\texport async function processChat',
      },
    ]
    const evidence = extractReadEvidence(messages)
    expect(evidence.some((e) => e.includes('extension/ai/agent.ts:47'))).toBe(true)
  })

  it('buildCompactionPrompt includes structured template', () => {
    const prompt = buildCompactionPrompt({ context: ['[User]: hello'] })
    expect(prompt).toContain('## Objective')
    expect(prompt).toContain(SUMMARY_TEMPLATE)
  })

  it('buildCompactionPrompt chains prior summary updates', () => {
    const prompt = buildCompactionPrompt({
      previousSummary: '## Objective\n- Draft docs',
      context: ['[User]: add redis section'],
    })
    expect(prompt).toContain('<prior-summary>')
    expect(prompt).toContain('Draft docs')
  })

  it('selectMessagesForCompaction keeps recent turns by token budget', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'system' },
      { role: 'user', content: 'old question '.repeat(200) },
      { role: 'assistant', content: 'old answer '.repeat(200) },
      { role: 'user', content: 'recent question' },
      { role: 'assistant', content: 'recent answer' },
    ]
    const selected = selectMessagesForCompaction(messages, 500)
    expect(selected).not.toBeNull()
    expect(selected!.toSummarize.length).toBeGreaterThan(0)
    expect(selected!.keep.length).toBeGreaterThan(0)
  })

  it('selectMessagesForCompaction does not orphan tool results from their assistant turn', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'system' },
      { role: 'user', content: 'list every API endpoint '.repeat(80) },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'c1', name: 'read_file', args: { path: 'a.js' } }],
      },
      { role: 'tool', tool_call_id: 'c1', name: 'read_file', content: 'router.get("/health") '.repeat(40) },
      { role: 'user', content: 'ok continue' },
    ]
    const selected = selectMessagesForCompaction(messages, 80)
    expect(selected).not.toBeNull()
    if (selected!.keep[0]?.role === 'tool') {
      throw new Error('keep started with an orphan tool message')
    }
    const keepTools = selected!.keep.filter((m) => m.role === 'tool')
    for (const tool of keepTools) {
      const idx = selected!.keep.indexOf(tool)
      const before = selected!.keep.slice(0, idx).reverse().find((m) => m.role !== 'tool')
      expect(before?.role).toBe('assistant')
      expect(before?.tool_calls?.some((tc) => tc.id === tool.tool_call_id)).toBe(true)
    }
  })
})
