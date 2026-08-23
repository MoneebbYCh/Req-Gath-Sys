import { describe, expect, it } from 'vitest'
import { EvidenceLedger, evidenceLocationKey } from './EvidenceLedger'
import type { EvidenceCandidate } from '../contracts/Evidence'

function candidate(overrides: Partial<EvidenceCandidate> = {}): EvidenceCandidate {
  return {
    path: 'src/auth.ts',
    startLine: 10,
    endLine: 14,
    excerpt: 'export function login() {',
    kind: 'source',
    sourceTool: 'read_file_range',
    contentHash: 'hash-1',
    ...overrides,
  }
}

describe('EvidenceLedger', () => {
  it('commits validated records and dedupes identical reads to one stable id', () => {
    const ledger = new EvidenceLedger()
    const first = ledger.record(candidate(), 'rv-1')
    expect(first.isNew).toBe(true)
    expect(first.id).toMatch(/^[0-9a-f]{32}$/)

    const again = ledger.record(candidate(), 'rv-1')
    expect(again.isNew).toBe(false)
    expect(again.id).toBe(first.id)
    expect(ledger.all()).toHaveLength(1)

    const record = ledger.get(first.id)
    expect(record).toMatchObject({
      path: 'src/auth.ts',
      range: { startLine: 10, endLine: 14 },
      kind: 'source',
      sourceTool: 'read_file_range',
      repositoryVersion: 'rv-1',
      contentHash: 'hash-1',
    })
  })

  it('treats a changed file as new evidence, not a duplicate', () => {
    const ledger = new EvidenceLedger()
    const before = ledger.record(candidate(), 'rv-1')
    const after = ledger.record(candidate({ contentHash: 'hash-2' }), 'rv-1')
    expect(after.id).not.toBe(before.id)
    expect(ledger.forPath('src/auth.ts')).toHaveLength(2)
  })

  it('keeps same relative paths in separate workspace roots distinct', () => {
    const ledger = new EvidenceLedger()
    const left = ledger.record(candidate({ rootId: 'root_left' }), 'rv-1')
    const right = ledger.record(candidate({ rootId: 'root_right' }), 'rv-1')
    expect(left.id).not.toBe(right.id)
    expect(ledger.forPath('src/auth.ts', 'root_left')).toHaveLength(1)
    expect(ledger.forPath('src/auth.ts', 'root_right')).toHaveLength(1)
    expect(ledger.staleIds(new Map([
      [evidenceLocationKey('root_left', 'src/auth.ts'), 'hash-2'],
      [evidenceLocationKey('root_right', 'src/auth.ts'), 'hash-1'],
    ]))).toEqual([left.id])
  })

  it('bounds stored excerpts to 500 chars', () => {
    const ledger = new EvidenceLedger()
    const { id } = ledger.record(candidate({ excerpt: 'x'.repeat(2_000) }), 'rv-1')
    expect(ledger.get(id)?.excerpt).toHaveLength(500)
  })

  it('detects stale evidence by content hash without deleting records', () => {
    const ledger = new EvidenceLedger()
    const { id } = ledger.record(candidate(), 'rv-1')
    expect(ledger.staleIds(new Map([['src/auth.ts', 'hash-1']]))).toEqual([])
    expect(ledger.staleIds(new Map([['src/auth.ts', 'hash-2']]))).toEqual([id])
    // Staleness marks — nothing is deleted.
    expect(ledger.get(id)).toBeDefined()
  })

  it('skips records without a hash in staleness checks', () => {
    const ledger = new EvidenceLedger()
    const { id } = ledger.record(candidate({ contentHash: undefined }), 'rv-1')
    expect(ledger.staleIds(new Map([['src/auth.ts', 'anything']]))).toEqual([])
    expect(ledger.get(id)?.contentHash).toBe('')
  })

  it('marks evidence whose file was deleted as stale when existingPaths is supplied (plan §12)', () => {
    const ledger = new EvidenceLedger()
    const { id } = ledger.record(candidate(), 'rv-1')
    // Path absent from the hash map AND from the filesystem → the file is gone.
    expect(ledger.staleIds(new Map(), new Set(['other.ts']))).toEqual([id])
    // Path still on disk → not stale (its hash was simply not sampled).
    expect(ledger.staleIds(new Map(), new Set(['src/auth.ts']))).toEqual([])
    // Backward compatibility: one-arg call skips paths absent from the map.
    expect(ledger.staleIds(new Map())).toEqual([])
    expect(ledger.get(id)).toBeDefined()
  })

  it('skips hashless records for deletion staleness too', () => {
    const ledger = new EvidenceLedger()
    const { id } = ledger.record(candidate({ contentHash: undefined }), 'rv-1')
    expect(ledger.staleIds(new Map(), new Set())).toEqual([])
    expect(ledger.get(id)?.contentHash).toBe('')
  })

  it('refreshes a stale symbol range and removes it from the stale set (plan §12)', async () => {
    const ledger = new EvidenceLedger()
    const { id } = ledger.record(candidate({ symbol: 'login' }), 'rv-1')
    const stale = ledger.staleIds(new Map([['src/auth.ts', 'hash-2']]))
    expect(stale).toEqual([id])

    const seen: string[] = []
    const refreshed = await ledger.refreshRanges(stale, async (record) => {
      seen.push(record.symbol ?? '')
      return { startLine: 22, endLine: 26 }
    })
    expect(refreshed).toBe(1)
    expect(stale).toEqual([])
    expect(seen).toEqual(['login'])

    const updated = ledger.get(id)
    expect(updated).toBeDefined()
    expect(updated?.range).toEqual({ startLine: 22, endLine: 26 })
    expect(updated?.excerpt).toContain('range refreshed')
  })

  it('leaves records stale when the symbol cannot be re-resolved or the range is unchanged', async () => {
    const ledger = new EvidenceLedger()
    const { id } = ledger.record(candidate({ symbol: 'login' }), 'rv-1')
    const stale = ledger.staleIds(new Map([['src/auth.ts', 'hash-2']]))

    const unresolved = await ledger.refreshRanges(stale, async () => undefined)
    expect(unresolved).toBe(0)
    expect(stale).toEqual([id])

    const unchanged = await ledger.refreshRanges(stale, async () => ({ startLine: 10, endLine: 14 }))
    expect(unchanged).toBe(0)
    expect(stale).toEqual([id])
    expect(ledger.get(id)?.range).toEqual({ startLine: 10, endLine: 14 })
  })

  it('never re-resolves records without a symbol', async () => {
    const ledger = new EvidenceLedger()
    const { id } = ledger.record(candidate(), 'rv-1')
    const stale = ledger.staleIds(new Map([['src/auth.ts', 'hash-2']]))
    let called = false
    const refreshed = await ledger.refreshRanges(stale, async () => {
      called = true
      return { startLine: 99, endLine: 99 }
    })
    expect(refreshed).toBe(0)
    expect(called).toBe(false)
    expect(stale).toEqual([id])
  })
})
