import fg from 'fast-glob'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { createHash } from 'node:crypto'
import { EXCLUDED_GLOBS, classifyFlags, languageFor } from './IgnorePolicy'
import { CatalogEntry, CatalogInterface } from './Catalog'

/**
 * Incremental file catalogue (plan §15):
 * - Initial scan walks roots (capped for safety)
 * - File watchers update entries on create/change/delete
 * - Metadata-first initial scan; content hashes are computed lazily on use
 * - Persistent index survives restarts (atomic JSON + rename)
 * - Bounded: generated/vendor deprioritized, cap on total entries
 */

export type IndexedFileEntry = CatalogEntry

export interface IncrementalCatalogOptions {
  /** Max total entries across all roots (safety cap). */
  maxEntries?: number
  /** Persisted index file (under extension storage). */
  indexPath?: string
  /** File system watcher (VS Code or chokidar). */
  watcher?: FileWatcher
  /** Called when the catalog changes (debounced). */
  onChange?: () => void
  log?: (msg: string) => void
}

export interface FileWatcher {
  watch(roots: string[]): void
  onChange(callback: (event: FileChangeEvent) => void): void
  dispose(): void
}

export interface FileChangeEvent {
  type: 'create' | 'change' | 'delete'
  absolutePath: string
  root: string
}

/** In-memory fallback when no watcher is provided (tests, CI). */
export class NoOpWatcher implements FileWatcher {
  watch() {}
  onChange() {}
  dispose() {}
}

const DEFAULT_MAX_ENTRIES = 100_000

export class IncrementalFileCatalog implements CatalogInterface {
  private entries = new Map<string, CatalogEntry>() // key: `${root}\0${relPath}`
  private scanTruncated = false
  private scanning = false
  private changeDebounceTimer: ReturnType<typeof setTimeout> | null = null
  private readonly roots: string[]
  private readonly maxEntries: number
  private readonly indexPath?: string
  private readonly watcher: FileWatcher
  private readonly onChange?: () => void
  private readonly log: (msg: string) => void

  constructor(
    roots: string[],
    options: IncrementalCatalogOptions = {}
  ) {
    this.roots = roots
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES
    this.indexPath = options.indexPath
    this.watcher = options.watcher ?? new NoOpWatcher()
    this.onChange = options.onChange
    this.log = options.log ?? (() => {})
  }

  /** Start watching and load persisted index if available. */
  async initialize(): Promise<void> {
    await this.loadIndex()
    this.watcher.onChange((event) => this.handleFileChange(event))
    this.watcher.watch(this.roots)
    // An index loaded from disk predates the current VS Code session. Reconcile
    // metadata before serving it so changes made while the extension was closed
    // are visible without eagerly reading every file's contents.
    await this.fullScan()
  }

  /** Ensure an initial scan has run (idempotent). */
  async ensureScanned(): Promise<void> {
    if (this.scanning || this.entries.size > 0) return
    this.scanning = true
    try {
      await this.fullScan()
    } finally {
      this.scanning = false
    }
  }

  /** Full walk of all roots (used on first load or when index is stale). */
  async scan(): Promise<{ entries: CatalogEntry[]; truncated: boolean }> {
    return this.fullScan()
  }

  /** Snapshot the catalog without exposing its mutable internal map. */
  allEntries(): CatalogEntry[] {
    return [...this.entries.values()]
  }

  async fullScan(): Promise<{ entries: CatalogEntry[]; truncated: boolean }> {
    const newEntries = new Map<string, CatalogEntry>()
    let total = 0

    for (const root of this.roots) {
      if (total >= this.maxEntries) break
      try {
        const batch = (await fg('**/*', {
          cwd: root,
          dot: true,
          onlyFiles: false,
          markDirectories: true,
          stats: true,
          unique: true,
          ignore: EXCLUDED_GLOBS,
        })) as unknown as Array<{ path: string; stats?: { size: number; mtimeMs: number } }>

        for (const e of batch) {
          if (total >= this.maxEntries) break
          const isDir = e.path.endsWith('/')
          const rel = isDir ? e.path.slice(0, -1) : e.path
          const key = `${root}\0${rel}`
          const prior = this.entries.get(key)
          const size = e.stats?.size ?? 0
          const mtimeMs = e.stats?.mtimeMs ?? 0
          newEntries.set(key, {
            path: rel,
            kind: isDir ? 'dir' : 'file',
            size,
            extension: isDir ? undefined : extensionOf(rel),
            language: isDir ? undefined : languageFor(rel),
            flags: classifyFlags(rel),
            root,
            // Preserve a known hash only while metadata proves the content is
            // unchanged. New or changed files are hashed lazily when needed.
            contentHash: !isDir && prior?.size === size && prior.mtimeMs === mtimeMs ? prior.contentHash : undefined,
            mtimeMs,
          })
          total++
        }
      } catch (err) {
        this.log(`IncrementalFileCatalog: scan error in ${root}: ${err}`)
      }
    }

    this.entries = newEntries
    this.scanTruncated = total >= this.maxEntries
    await this.saveIndex()
    this.log(`IncrementalFileCatalog: scanned ${this.entries.size} entries (truncated=${this.scanTruncated})`)
    return { entries: [...this.entries.values()], truncated: this.scanTruncated }
  }

  private async handleFileChange(event: FileChangeEvent): Promise<void> {
    const { type, absolutePath, root } = event
    const rel = path.relative(root, absolutePath).replace(/\\/g, '/')
    const key = `${root}\0${rel}`

    if (type === 'delete') {
      this.entries.delete(key)
      this.scheduleSaveAndNotify()
      return
    }

    try {
      const stat = await fs.stat(absolutePath)
      if (!stat.isFile()) return

      const existing = this.entries.get(key)
      if (existing && existing.mtimeMs === stat.mtimeMs && existing.size === stat.size) {
        return // unchanged
      }

      this.entries.set(key, {
        path: rel,
        kind: 'file',
        size: stat.size,
        extension: extensionOf(rel),
        language: languageFor(rel),
        flags: classifyFlags(rel),
        root,
        contentHash: undefined,
        mtimeMs: stat.mtimeMs,
      })

      this.scheduleSaveAndNotify()
    } catch {
      // File may have been deleted between event and stat
    }
  }

  private scheduleSaveAndNotify(): void {
    if (this.changeDebounceTimer) clearTimeout(this.changeDebounceTimer)
    this.changeDebounceTimer = setTimeout(async () => {
      await this.saveIndex()
      this.onChange?.()
    }, 300)
  }

  private async loadIndex(): Promise<void> {
    if (!this.indexPath) return
    try {
      const data = await fs.readFile(this.indexPath, 'utf8')
      const parsed = JSON.parse(data) as { version: number; entries: CatalogEntry[]; roots: string[] }
      if (parsed.version === 1 && arraysEqual(parsed.roots, this.roots)) {
        for (const e of parsed.entries) {
          const key = `${e.root}\0${e.path}`
          this.entries.set(key, e)
        }
        this.log(`IncrementalFileCatalog: loaded ${this.entries.size} entries from index`)
      } else {
        this.log('IncrementalFileCatalog: index roots mismatch — will rescan')
      }
    } catch {
      this.log('IncrementalFileCatalog: no existing index or corrupt — will scan')
    }
  }

  private async saveIndex(): Promise<void> {
    if (!this.indexPath) return
    try {
      const dir = path.dirname(this.indexPath)
      await fs.mkdir(dir, { recursive: true })
      const data = JSON.stringify({
        version: 1,
        roots: this.roots,
        entries: [...this.entries.values()],
      })
      const tmp = `${this.indexPath}.tmp-${process.pid}-${Date.now()}`
      await fs.writeFile(tmp, data, 'utf8')
      await fs.rename(tmp, this.indexPath)
    } catch {
      // best effort
    }
  }

  async list(
    dir: string | undefined,
    limit = 100,
    cursor = 0,
    filter?: (e: CatalogEntry) => boolean,
  ): Promise<{ entries: CatalogEntry[]; nextCursor?: number }> {
    await this.ensureScanned()
    const scope = normalizeScope(dir)
    const filtered = [...this.entries.values()].filter((e) => {
      if (filter && !filter(e)) return false
      if (!scope) return !e.path.includes('/')
      if (e.path === scope) return false
      return e.path.startsWith(`${scope}/`)
    })
    const page = filtered.slice(cursor, cursor + limit)
    const next = cursor + limit < filtered.length ? cursor + limit : undefined
    return { entries: page, nextCursor: next }
  }

  async searchByName(query: string, limit = 50): Promise<CatalogEntry[]> {
    await this.ensureScanned()
    const tokens = query.toLowerCase().split(/\s+/).filter(Boolean)
    if (tokens.length === 0) return []
    return [...this.entries.values()]
      .filter((e) => tokens.every((t) => e.path.toLowerCase().includes(t)))
      .slice(0, limit)
  }

  async getEntry(absolutePath: string): Promise<CatalogEntry | undefined> {
    await this.ensureScanned()
    for (const root of this.roots) {
      if (absolutePath.startsWith(root)) {
        const rel = path.relative(root, absolutePath).replace(/\\/g, '/')
        return this.entries.get(`${root}\0${rel}`)
      }
    }
    return undefined
  }

  async getContentHash(absolutePath: string): Promise<string | undefined> {
    const entry = await this.getEntry(absolutePath)
    if (!entry || entry.kind !== 'file') return entry?.contentHash
    if (entry.contentHash) return entry.contentHash
    try {
      const content = await fs.readFile(absolutePath)
      const contentHash = createHash('sha256').update(content).digest('hex')
      entry.contentHash = contentHash
      return contentHash
    } catch {
      return undefined
    }
  }

  isTruncated(): boolean {
    return this.scanTruncated
  }

  size(): number {
    return this.entries.size
  }

  dispose(): void {
    this.watcher.dispose()
    if (this.changeDebounceTimer) clearTimeout(this.changeDebounceTimer)
  }
}

function normalizeScope(dir: string | undefined): string {
  if (!dir) return ''
  let d = dir.trim().replace(/^\.\//, '').replace(/^\/+|\/+$/g, '')
  if (d === '.') d = ''
  return d
}

function extensionOf(rel: string): string | undefined {
  const base = rel.split('/').pop() ?? ''
  const idx = base.lastIndexOf('.')
  return idx > 0 ? base.slice(idx + 1).toLowerCase() : undefined
}

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  return a.every((v, i) => v === b[i])
}
