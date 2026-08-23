import { type FileFlag } from './IgnorePolicy'

/**
 * Common interface for file catalogs (plan §15).
 * Both FileCatalog and IncrementalFileCatalog implement this.
 */

export interface CatalogEntry {
  /** Path relative to its workspace root. */
  path: string
  kind: 'file' | 'dir'
  size: number
  extension?: string
  language?: string
  flags: FileFlag[]
  /** Absolute workspace root this entry was discovered under (multi-root). */
  root: string
  /** SHA256 of file content (empty for dirs). Enables staleness detection. */
  contentHash?: string
  /** File modification time (ms) for quick invalidation. */
  mtimeMs?: number
}

export interface CatalogInterface {
  /** Run the full walk (once); returns cached results afterwards. */
  scan(): Promise<{ entries: CatalogEntry[]; truncated: boolean }>
  
  /** Bounded listing under a directory ('' = roots' top level), with an offset cursor. */
  list(
    dir: string | undefined,
    limit: number,
    cursor: number,
    filter?: (e: CatalogEntry) => boolean
  ): Promise<{ entries: CatalogEntry[]; nextCursor?: number }>
  
  /** Name search: every query token must appear in some path segment. */
  searchByName(query: string, limit: number): Promise<CatalogEntry[]>
  
  /** Check if catalog is truncated (hit maxEntries cap). */
  isTruncated(): boolean
  
  /** Total entry count. */
  size(): number
  
  /** Dispose watchers and cleanup. */
  dispose(): void
}