import { describe, expect, it } from 'vitest'
import { evidenceCandidateSchema, evidenceRecordSchema } from './Evidence'

describe('evidence contracts', () => {
  it('accepts a well-formed evidence candidate', () => {
    const candidate = {
      path: 'src/auth.ts',
      startLine: 10,
      endLine: 14,
      excerpt: 'export function login() {',
      kind: 'source',
      sourceTool: 'read_file_range',
    }
    expect(evidenceCandidateSchema.parse(candidate)).toEqual(candidate)
  })

  it('rejects a candidate missing required fields', () => {
    const bad = { path: 'src/auth.ts', excerpt: 'x' }
    expect(() => evidenceCandidateSchema.parse(bad)).toThrow()
  })

  it('rejects negative line numbers', () => {
    expect(() =>
      evidenceCandidateSchema.parse({
        path: 'a.ts',
        startLine: -1,
        endLine: 2,
        excerpt: 'x',
        kind: 'source',
        sourceTool: 'read_file',
      }),
    ).toThrow()
  })

  it('accepts a well-formed evidence record', () => {
    const record = {
      id: 'ev-1',
      repositoryVersion: 'repo-abc',
      path: 'src/auth.ts',
      contentHash: 'sha256:deadbeef',
      symbol: 'login',
      range: { startLine: 10, endLine: 14 },
      kind: 'source',
      excerpt: 'export function login() {',
      sourceTool: 'read_file_range',
      createdAt: 1_700_000_000_000,
    }
    expect(evidenceRecordSchema.parse(record)).toEqual(record)
  })

  it('rejects an evidence record with an unknown kind', () => {
    expect(() =>
      evidenceRecordSchema.parse({
        id: 'ev-1',
        repositoryVersion: 'repo-abc',
        path: 'a.ts',
        contentHash: 'h',
        kind: 'telepathy',
        sourceTool: 'x',
        createdAt: 0,
      }),
    ).toThrow()
  })
})
