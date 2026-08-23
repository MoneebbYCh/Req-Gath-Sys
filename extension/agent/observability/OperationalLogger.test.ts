import { describe, expect, it } from 'vitest'
import { OperationalLogger } from './OperationalLogger'

describe('OperationalLogger', () => {
  it('emits only allow-listed operational fields', () => {
    const lines: string[] = []
    const logger = new OperationalLogger((line) => lines.push(line))
    logger.write({ event: 'tool.completed', taskId: 'task-1', tool: 'search', durationMs: 12, ok: true })
    logger.write({ event: 'unsafe', taskId: 'task-2', prompt: 'const apiKey = secret' } as unknown as { event: string })
    expect(JSON.parse(lines[0]!)).toMatchObject({ service: 'charter-ai-agent', event: 'tool.completed', taskId: 'task-1', tool: 'search', durationMs: 12, ok: true })
    expect(lines[1]).not.toContain('prompt')
    expect(lines[1]).not.toContain('secret')
  })

  it('filters diagnostics below the configured level', () => {
    const lines: string[] = []
    const logger = new OperationalLogger((line) => lines.push(line), true, 'warn')
    logger.write({ event: 'task.started', level: 'info' })
    logger.write({ event: 'task.failed', level: 'error', errorKind: 'provider' })
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0]!).event).toBe('task.failed')
  })

  it('emits bounded document parsing metadata without document content', () => {
    const lines: string[] = []
    const logger = new OperationalLogger((line) => lines.push(line))
    logger.write({
      event: 'document.section_parse_attempt',
      taskId: 'task-1',
      workerType: 'document',
      documentOperation: 'generate',
      sectionIndex: 2,
      attempt: 1,
      parseOutcome: 'schema_mismatch',
      responseBytes: 512,
      jsonExtracted: true,
      schemaIssueCount: 7,
      schemaIssueCodes: ['invalid_type', 'too_big', 'unrecognized_keys', 'custom', 'extra'],
      response: 'private document content',
    } as unknown as { event: string })

    expect(JSON.parse(lines[0]!)).toMatchObject({
      event: 'document.section_parse_attempt',
      documentOperation: 'generate',
      sectionIndex: 2,
      parseOutcome: 'schema_mismatch',
      schemaIssueCodes: ['invalid_type', 'too_big', 'unrecognized_keys', 'custom'],
    })
    expect(lines[0]).not.toContain('private document content')
  })

  it('emits nothing when diagnostics are disabled', () => {
    const lines: string[] = []
    new OperationalLogger((line) => lines.push(line), false).write({ event: 'task.started' })
    expect(lines).toEqual([])
  })

  it('serializes content-bearing trace fields (debug-level LLM/tool detail)', () => {
    const lines: string[] = []
    const logger = new OperationalLogger((line) => lines.push(line), true, 'debug')
    logger.write({
      event: 'llm.approach',
      level: 'debug',
      taskId: 'task-1',
      model: 'deepseek-v4-pro',
      systemPrompt: 'You are Charter Ai…',
      thinking: 'enabled',
      responseFormat: 'json_object',
      route: 'strong',
      toolNames: ['search_code', 'read_file'],
      maxOutputTokens: 1500,
      parallelToolCalls: 4,
    })
    logger.write({
      event: 'tool.executed',
      level: 'debug',
      taskId: 'task-1',
      tool: 'search_code',
      toolArgs: { pattern: 'auth' },
      toolOutput: { matches: [{ path: 'src/auth.ts' }] },
      ok: true,
    })

    const first = JSON.parse(lines[0]!)
    expect(first).toMatchObject({
      event: 'llm.approach',
      systemPrompt: 'You are Charter Ai…',
      thinking: 'enabled',
      responseFormat: 'json_object',
      route: 'strong',
      toolNames: ['search_code', 'read_file'],
    })
    const second = JSON.parse(lines[1]!)
    expect(second.toolArgs).toEqual({ pattern: 'auth' })
    expect(second.toolOutput).toEqual({ matches: [{ path: 'src/auth.ts' }] })
  })

  it('never serializes a circular tool value (trace stays crash-safe)', () => {
    const lines: string[] = []
    const logger = new OperationalLogger((line) => lines.push(line), true, 'debug')
    const circular: Record<string, unknown> = {}
    circular.self = circular
    logger.write({ event: 'tool.executed', level: 'debug', toolArgs: circular })
    expect(JSON.parse(lines[0]!).toolArgs).toBe('[unserializable]')
  })
})
