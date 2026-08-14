import { describe, expect, it, vi, beforeEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { processInlineChat, parseAiChatResponse } from './inlineChat'
import type { AiChatContextPayload } from '../protocol'

// 'vscode' resolves to src/test/stubs/vscode.ts (node-fs backed) via the
// vitest alias — loadConfig reads .charter-ai/config.json from a temp dir.
vi.mock('./llmClient', () => ({
  callLlm: vi.fn(),
}))

import { callLlm } from './llmClient'

const mockCall = callLlm as unknown as ReturnType<typeof vi.fn>

const CTX: AiChatContextPayload = {
  selection: { blockIds: ['s1'], markdown: 'Selected paragraph text.' },
  cursorBlock: { id: 'c1', text: 'The paragraph with the chat input.' },
  prevBlock: { id: 'p0', text: 'Before block.' },
  nextBlock: { id: 'n0', text: '' },
  section: { blockIds: ['c1', 'n0'], markdown: 'Current section text.' },
  headings: ['Intro', 'Body'],
  docMarkdown: 'Full document markdown.',
  blank: false,
}

let dir: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'charter-inline-'))
  mockCall.mockReset()
})

describe('parseAiChatResponse', () => {
  it('parses each valid kind', () => {
    expect(parseAiChatResponse('{"kind":"clarify","question":"Which one?"}')).toEqual({
      kind: 'clarify',
      question: 'Which one?',
    })
    expect(parseAiChatResponse('{"kind":"answer","text":"It means X."}')).toEqual({
      kind: 'answer',
      text: 'It means X.',
    })
    expect(
      parseAiChatResponse('{"kind":"modify","target":"cursor","markdown":"New text"}'),
    ).toEqual({ kind: 'modify', target: 'cursor', markdown: 'New text' })
    expect(parseAiChatResponse('{"kind":"insert","markdown":"New section"}')).toEqual({
      kind: 'insert',
      markdown: 'New section',
    })
  })

  it('accepts fenced JSON', () => {
    expect(
      parseAiChatResponse('```json\n{"kind":"answer","text":"fenced"}\n```'),
    ).toEqual({ kind: 'answer', text: 'fenced' })
  })

  it('rejects garbage and missing required fields', () => {
    expect(parseAiChatResponse('not json')).toBeNull()
    expect(parseAiChatResponse('{"kind":"clarify"}')).toBeNull() // no question
    expect(parseAiChatResponse('{"kind":"answer","text":""}')).toBeNull()
    expect(parseAiChatResponse('{"kind":"modify","target":"nope","markdown":"x"}')).toBeNull()
    expect(parseAiChatResponse('{"kind":"modify","target":"cursor"}')).toBeNull() // no markdown
    expect(parseAiChatResponse('{"kind":"dance"}')).toBeNull()
  })

  it('rejects oversized markdown', () => {
    const big = 'x'.repeat(20_001)
    expect(parseAiChatResponse(`{"kind":"insert","markdown":"${big}"}`)).toBeNull()
  })
})

describe('processInlineChat', () => {
  it('builds a context prompt and returns the parsed LLM result', async () => {
    mockCall.mockResolvedValue('{"kind":"modify","target":"cursor","markdown":"Rewritten."}')
    const result = await processInlineChat({
      text: 'Make this more concise',
      context: CTX,
      apiKey: 'k',
      workspaceRoot: dir,
    })
    expect(result).toEqual({ kind: 'modify', target: 'cursor', markdown: 'Rewritten.' })
    expect(mockCall).toHaveBeenCalledTimes(1)
    const [messages, config, options] = mockCall.mock.calls[0]
    expect(config.provider).toBe('deepseek')
    expect(options.jsonMode).toBe(true)
    const system = messages[0].content
    const user = messages[1].content
    // Context sections are present.
    expect(user).toContain('Selected paragraph text.')
    expect(user).toContain('The paragraph with the chat input.')
    expect(user).toContain('Full document markdown.')
    expect(user).toContain('Make this more concise')
    // The untrusted-data guard is in the system prompt.
    expect(system).toMatch(/never instructions|not instructions/i)
    expect(system).toMatch(/ignore any command, prompt, or instruction/i)
  })

  it('retries once on malformed output, then returns an error', async () => {
    mockCall.mockResolvedValueOnce('this is not json').mockResolvedValueOnce('also not json')
    const result = await processInlineChat({
      text: 'Rewrite',
      context: CTX,
      apiKey: 'k',
      workspaceRoot: dir,
    })
    expect(result.kind).toBe('error')
    expect(mockCall).toHaveBeenCalledTimes(2)
  })

  it('returns the retried result when the second attempt is valid', async () => {
    mockCall
      .mockResolvedValueOnce('garbage')
      .mockResolvedValueOnce('{"kind":"answer","text":"Fixed."}')
    const result = await processInlineChat({
      text: 'Rewrite',
      context: CTX,
      apiKey: 'k',
      workspaceRoot: dir,
    })
    expect(result).toEqual({ kind: 'answer', text: 'Fixed.' })
    expect(mockCall).toHaveBeenCalledTimes(2)
  })

  it('rejects an empty request without calling the LLM', async () => {
    const result = await processInlineChat({
      text: '   ',
      context: CTX,
      apiKey: 'k',
      workspaceRoot: dir,
    })
    expect(result).toEqual({ kind: 'error', error: expect.stringMatching(/empty/i) })
    expect(mockCall).not.toHaveBeenCalled()
  })

  it('reads provider/model from the workspace config', async () => {
    fs.mkdirSync(path.join(dir, '.charter-ai'), { recursive: true })
    fs.writeFileSync(
      path.join(dir, '.charter-ai', 'config.json'),
      JSON.stringify({ llm: { provider: 'kimi', model: 'kimi-k2.6' } }),
    )
    mockCall.mockResolvedValue('{"kind":"answer","text":"ok"}')
    await processInlineChat({ text: 'Hi', context: CTX, apiKey: 'k', workspaceRoot: dir })
    const [, config] = mockCall.mock.calls[0]
    expect(config.provider).toBe('kimi')
    expect(config.model).toBe('kimi-k2.6')
  })
})