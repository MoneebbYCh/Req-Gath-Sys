import { createHash } from 'node:crypto'
import {
  evidenceRecordSchema,
  type EvidenceCandidate,
  type EvidenceRecord,
} from '../contracts/Evidence'

/**
 * Durable evidence ledger (plan §7). Every evidence candidate a repository
 * tool produces is committed here — bounded excerpt + enough information
 * (path, range, content hash, repository version) to deterministically re-read
 * the exact source. In-memory for now; restart durability lands with Phase 14.
 *
 * The evidence id is a deterministic hash of provenance, so repeated identical
 * reads dedupe to the same record — parallel workers converge instead of
 * multiplying (plan §9).
 */
export class EvidenceLedger {
  private readonly records = new Map<string, EvidenceRecord>()

  /** Commit a tool-produced candidate; returns the stable id and whether it was new. */
  record(candidate: EvidenceCandidate, repositoryVersion: string): { id: string; isNew: boolean } {
    const excerpt = candidate.excerpt.slice(0, 500)
    const contentHash = candidate.contentHash ?? ''
    const id = evidenceId({
      repositoryVersion,
      path: candidate.path,
      rootId: candidate.rootId,
      root: candidate.root,
      startLine: candidate.startLine,
      endLine: candidate.endLine,
      contentHash,
      sourceTool: candidate.sourceTool,
    })
    if (this.records.has(id)) return { id, isNew: false }

    this.records.set(
      id,
      evidenceRecordSchema.parse({
        id,
        repositoryVersion,
        path: candidate.path,
        rootId: candidate.rootId,
        root: candidate.root,
        contentHash,
        symbol: candidate.symbol,
        range: { startLine: candidate.startLine, endLine: candidate.endLine },
        kind: candidate.kind,
        excerpt,
        sourceTool: candidate.sourceTool,
        createdAt: Date.now(),
      }),
    )
    return { id, isNew: true }
  }

  get(id: string): EvidenceRecord | undefined {
    return this.records.get(id)
  }

  /** All records for a root-aware path (old and new reads — oldest first). */
  forPath(path: string, rootId?: string): EvidenceRecord[] {
    return [...this.records.values()]
      .filter((r) => r.path === path && (rootId === undefined || r.rootId === rootId))
      .sort((a, b) => a.createdAt - b.createdAt)
  }

  all(): EvidenceRecord[] {
    return [...this.records.values()]
  }

  /** Plan §14: rehydrate durable evidence after a restart. */
  restore(records: EvidenceRecord[]): void {
    for (const r of records) {
      this.records.set(r.id, evidenceRecordSchema.parse(r))
    }
  }

  /**
   * Staleness detection (plan §7/§12): given the CURRENT hash per path, return
   * the ids of records whose stored hash disagrees. A record whose path is
   * absent from the map is only stale when `existingPaths` is supplied and
   * does not contain the path — the file was deleted ("finding references a
   * deleted file"). Records without a hash are not detectable and are
   * skipped, not deleted.
   */
  staleIds(currentHashes: ReadonlyMap<string, string>, existingPaths?: ReadonlySet<string>): string[] {
    const stale: string[] = []
    for (const r of this.records.values()) {
      if (!r.contentHash) continue
      // Root-aware keys prevent two workspace folders with `src/app.ts` from
      // making each other's evidence appear fresh/stale. Plain paths remain a
      // legacy fallback for callers restoring old state.
      const key = evidenceLocationKey(r.rootId, r.path)
      const current = currentHashes.get(key) ?? currentHashes.get(r.path)
      if (current !== undefined) {
        if (current !== r.contentHash) stale.push(r.id)
      } else if (existingPaths !== undefined && !existingPaths.has(key) && !existingPaths.has(r.path)) {
        stale.push(r.id)
      }
    }
    return stale
  }

  /**
   * Plan §12 edge "line numbers shift while symbol remains semantically
   * identical": for stale records that carry a `symbol`, ask the caller's
   * resolver to re-locate it. `reResolve` returns the fresh range when the
   * symbol is still in the same file, or undefined when it is gone. A
   * DIFFERENT range updates the record's range + excerpt note and the id is
   * REMOVED from `staleIds` (mutated in place) — refreshed, never deleted.
   * Returns the number of records refreshed.
   */
  async refreshRanges(
    staleIds: string[],
    reResolve: (record: EvidenceRecord) => Promise<{ startLine: number; endLine: number } | undefined>,
  ): Promise<number> {
    let refreshed = 0
    for (let i = staleIds.length - 1; i >= 0; i--) {
      const r = this.records.get(staleIds[i])
      if (!r?.symbol || !r.range) continue
      const located = await reResolve(r)
      if (!located) continue
      if (located.startLine === r.range.startLine && located.endLine === r.range.endLine) continue
      this.records.set(r.id, {
        ...r,
        range: { startLine: located.startLine, endLine: located.endLine },
        excerpt: `${r.excerpt ?? ''} [range refreshed to ${located.startLine}-${located.endLine}]`,
      })
      staleIds.splice(i, 1)
      refreshed++
    }
    return refreshed
  }
}

/** Canonical key for root-aware evidence hash and existence maps. */
export function evidenceLocationKey(rootId: string | undefined, path: string): string {
  return rootId ? `${rootId}\u0000${path}` : path
}

/** Deterministic provenance hash — identical reads yield identical ids. */
export function evidenceId(parts: {
  repositoryVersion: string
  path: string
  rootId?: string
  root?: number
  startLine: number
  endLine: number
  contentHash: string
  sourceTool: string
}): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 32)
}
