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
})
