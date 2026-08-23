import fg from 'fast-glob'
import { EXCLUDED_GLOBS, classifyFlags, languageFor } from './IgnorePolicy'
import { CatalogEntry, CatalogInterface } from './Catalog'

/**
 * Lazy file catalogue (plan §10): walks each workspace root once, keeps
 * metadata only (path/kind/size/extension/flags), and serves bounded listings
 * and name searches. No source content ever enters the catalogue.
 */
export type FileEntry = CatalogEntry

export interface CatalogOptions {
  /** Safety cap on total entries (plan §15: this grows into incremental indexing). */
  maxEntries?: number
}

const DEFAULT_MAX_ENTRIES = 5_000

export class FileCatalog implements CatalogInterface {
  private readonly maxEntries: number
  private scanned: CatalogEntry[] | null = null
  private scanTruncated = false

  constructor(
    private readonly roots: string[],
    options: CatalogOptions = {},
  ) {
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES
  }

  /** Run the full walk (once); returns cached results afterwards. */
  async scan(): Promise<{ entries: CatalogEntry[]; truncated: boolean }> {
    if (this.scanned) return { entries: this.scanned, truncated: this.scanTruncated }

    const entries: CatalogEntry[] = []
    for (const root of this.roots) {
      if (entries.length >= this.maxEntries) break
      // stats:true switches fast-glob into object mode ({ path, stats }).
      const batch = (await fg('**/*', {
        cwd: root,
        dot: true,
        onlyFiles: false,
        markDirectories: true,
        stats: true,
        unique: true,
        ignore: EXCLUDED_GLOBS,
      })) as unknown as Array<{ path: string; stats?: { size: number } }>
      for (const e of batch) {
        if (entries.length >= this.maxEntries) break
        const isDir = e.path.endsWith('/')
        const rel = isDir ? e.path.slice(0, -1) : e.path
        entries.push({
          path: rel,
          kind: isDir ? 'dir' : 'file',
          size: e.stats?.size ?? 0,
          extension: isDir ? undefined : extensionOf(rel),
          language: isDir ? undefined : languageFor(rel),
          flags: classifyFlags(rel),
          root,
        })
      }
    }
    this.scanTruncated = entries.length >= this.maxEntries
    this.scanned = entries
    return { entries, truncated: this.scanTruncated }
  }

  /** Bounded listing under a directory ('' = roots' top level), with an offset cursor. */
  async list(
    dir: string | undefined,
    limit = 100,
    cursor = 0,
    filter?: (e: CatalogEntry) => boolean,
  ): Promise<{ entries: CatalogEntry[]; nextCursor?: number }> {
    const { entries } = await this.scan()
    const scope = normalizeScope(dir)
    const filtered = entries.filter((e) => {
      if (filter && !filter(e)) return false
      if (!scope) return !e.path.includes('/')
      if (e.path === scope) return false // list the contents, not the dir itself
      return e.path.startsWith(`${scope}/`)
    })
    const page = filtered.slice(cursor, cursor + limit)
    const next = cursor + limit < filtered.length ? cursor + limit : undefined
    return { entries: page, nextCursor: next }
  }

  /** Name search: every query token must appear in some path segment. */
  async searchByName(query: string, limit = 50): Promise<CatalogEntry[]> {
    const { entries } = await this.scan()
    const tokens = query.toLowerCase().split(/\s+/).filter(Boolean)
    if (tokens.length === 0) return []
    return entries
      .filter((e) => {
        const p = e.path.toLowerCase()
        return tokens.every((t) => p.includes(t))
      })
      .slice(0, limit)
  }

  isTruncated(): boolean {
    return this.scanTruncated
  }

  size(): number {
    return this.scanned?.length ?? 0
  }

  dispose(): void {
    // No-op for FileCatalog
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
