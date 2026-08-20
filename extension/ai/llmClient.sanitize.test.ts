import { describe, expect, it } from 'vitest'
import { sanitizeMessagesForApi, type ChatMessage } from './llmClient'

describe('sanitizeMessagesForApi', () => {
  it('drops tool messages that are not a response to tool_calls', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'hi' },
      { role: 'tool', tool_call_id: 'x', name: 'read_file', content: 'orphan' },
      { role: 'assistant', content: 'ok' },
    ]
    const out = sanitizeMessagesForApi(messages)
    expect(out.some((m) => m.role === 'tool')).toBe(false)
  })

  it('keeps tool results that follow their assistant tool_calls', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'list routes' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'c1', name: 'read_file', args: { path: 'a.js' } }],
      },
      { role: 'tool', tool_call_id: 'c1', name: 'read_file', content: 'GET /' },
    ]
    const out = sanitizeMessagesForApi(messages)
    expect(out.filter((m) => m.role === 'tool')).toHaveLength(1)
  })
})
