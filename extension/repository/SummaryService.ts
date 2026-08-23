import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { createHash } from 'node:crypto'
import type { IndexedFileEntry } from './IncrementalFileCatalog'

/**
 * Summary Service (plan §15):
 * - Lazy, on-demand summaries keyed by content hash
 * - Two levels: file summary → module/package summary
 * - Stored in extension storage (atomic JSON)
 * - Never eager — only generated when a task actually needs them
 * - Invalidated automatically when file content hash changes
 */

export interface FileSummary {
  path: string
  contentHash: string
  language?: string
  summary: string
  /** Key symbols/functions/classes for quick navigation. */
  symbols: Array<{ name: string; kind: string; line: number }>
  /** Import/export statements for dependency awareness. */
  imports: string[]
  exports: string[]
  /** Generated at timestamp. */
  createdAt: number
}

export interface ModuleSummary {
  /** Module identifier (e.g., "src/auth" or "pkg/user"). */
  modulePath: string
  /** Aggregated from file summaries in this module. */
  fileSummaries: string[]
  /** Combined symbol index. */
  symbols: Array<{ name: string; kind: string; file: string; line: number }>
  /** Module-level purpose/description. */
  description: string
  /** Content hash of the concatenated file hashes — invalidates when any file changes. */
  contentHash: string
  createdAt: number
}

export interface SummaryServiceOptions {
  /** Storage directory under extension storageUri. */
  storageDir: string
  /** Model provider for generating summaries (optional; if not provided, returns structured data only). */
  modelProvider?: SummaryModelProvider
  /** Max file summaries to keep in memory (LRU). */
  maxMemoryEntries?: number
  /** Max tokens for a file summary. */
  maxSummaryTokens?: number
  log?: (msg: string) => void
}

/** Minimal interface for summary generation. */
export interface SummaryModelProvider {
  summarizeFile(filePath: string, content: string, language?: string): Promise<FileSummary>
  summarizeModule(modulePath: string, fileSummaries: FileSummary[]): Promise<ModuleSummary>
}

/** No-op provider for when model isn't available or for tests. */
export class NoOpSummaryProvider implements SummaryModelProvider {
  async summarizeFile(filePath: string, content: string, language?: string): Promise<FileSummary> {
    return {
      path: filePath,
      contentHash: createHash('sha256').update(content).digest('hex'),
      language,
      summary: `(no model provider) ${content.slice(0, 200)}...`,
      symbols: [],
      imports: [],
      exports: [],
      createdAt: Date.now(),
    }
  }

  async summarizeModule(modulePath: string, fileSummaries: FileSummary[]): Promise<ModuleSummary> {
    const combinedHash = createHash('sha256')
      .update(fileSummaries.map(f => f.contentHash).sort().join('|'))
      .digest('hex')
    return {
      modulePath,
      fileSummaries: fileSummaries.map(f => f.path),
      symbols: [],
      description: `(no model provider) ${fileSummaries.length} files`,
      contentHash: combinedHash,
      createdAt: Date.now(),
    }
  }
}

const DEFAULT_MAX_MEMORY = 500

export class SummaryService {
  private readonly storageDir: string
  private readonly modelProvider: SummaryModelProvider
  private readonly maxMemoryEntries: number
  private readonly log: (msg: string) => void

  private fileSummaries = new Map<string, FileSummary>() // key: contentHash
  private moduleSummaries = new Map<string, ModuleSummary>() // key: modulePath + contentHash
  private fileSummaryOrder: string[] = [] // LRU order (contentHashes)

  constructor(options: SummaryServiceOptions) {
    this.storageDir = options.storageDir
    this.modelProvider = options.modelProvider ?? new NoOpSummaryProvider()
    this.maxMemoryEntries = options.maxMemoryEntries ?? DEFAULT_MAX_MEMORY
    this.log = options.log ?? (() => {})
  }

  /** Get or generate a file summary. Returns cached if contentHash matches. */
  async getFileSummary(entry: IndexedFileEntry, content: string): Promise<FileSummary> {
    if (!entry.contentHash || entry.contentHash === 'unreadable') {
      return this.modelProvider.summarizeFile(entry.path, content, entry.language)
    }

    // Check memory cache
    const cached = this.fileSummaries.get(entry.contentHash)
    if (cached) {
      this.touchLRU(entry.contentHash)
      return cached
    }

    // Check disk cache
    const diskCached = await this.loadFileSummaryFromDisk(entry.contentHash)
    if (diskCached) {
      this.cacheFileSummary(entry.contentHash, diskCached)
      return diskCached
    }

    // Generate new summary
    const summary = await this.modelProvider.summarizeFile(entry.path, content, entry.language)
    this.cacheFileSummary(entry.contentHash, summary)
    await this.saveFileSummaryToDisk(entry.contentHash, summary)
    return summary
  }

  /** Get or generate a module/package summary. */
  async getModuleSummary(
    modulePath: string,
    entries: IndexedFileEntry[],
    readFileFn: (absolutePath: string) => Promise<string>
  ): Promise<ModuleSummary> {
    const fileEntries = entries.filter(e => e.kind === 'file' && e.contentHash)
    if (fileEntries.length === 0) {
      return {
        modulePath,
        fileSummaries: [],
        symbols: [],
        description: '(empty module)',
        contentHash: '',
        createdAt: Date.now(),
      }
    }

    // Compute module content hash from file hashes
    const fileHashes = fileEntries.map(e => e.contentHash).sort()
    const moduleContentHash = createHash('sha256').update(fileHashes.join('|')).digest('hex')
    const cacheKey = `${modulePath}\0${moduleContentHash}`

    // Check memory cache
    const cached = this.moduleSummaries.get(cacheKey)
    if (cached) return cached

    // Check disk cache
    const diskCached = await this.loadModuleSummaryFromDisk(modulePath, moduleContentHash)
    if (diskCached) {
      this.moduleSummaries.set(cacheKey, diskCached)
      return diskCached
    }

    // Load file summaries for each file
    const fileSummaries: FileSummary[] = []
    for (const entry of fileEntries) {
      try {
        const content = await readFileFn(path.join(entry.root, entry.path))
        const summary = await this.getFileSummary(entry, content)
        fileSummaries.push(summary)
      } catch {
        // Skip unreadable files
      }
    }

    // Generate module summary
    const summary = await this.modelProvider.summarizeModule(modulePath, fileSummaries)
    this.moduleSummaries.set(cacheKey, summary)
    await this.saveModuleSummaryToDisk(modulePath, moduleContentHash, summary)
    return summary
  }

  /** Get all file summaries for a set of entries (used by progressive narrowing). */
  async getFileSummaries(
    entries: IndexedFileEntry[],
    readFileFn: (absolutePath: string) => Promise<string>
  ): Promise<FileSummary[]> {
    const results: FileSummary[] = []
    for (const entry of entries) {
      if (entry.kind !== 'file' || !entry.contentHash || entry.contentHash === 'unreadable') continue
      try {
        const content = await readFileFn(path.join(entry.root, entry.path))
        const summary = await this.getFileSummary(entry, content)
        results.push(summary)
      } catch {
        // Skip
      }
    }
    return results
  }

  private cacheFileSummary(contentHash: string, summary: FileSummary): void {
    if (this.fileSummaries.has(contentHash)) {
      this.touchLRU(contentHash)
      return
    }
    if (this.fileSummaries.size >= this.maxMemoryEntries) {
      const oldest = this.fileSummaryOrder.shift()
      if (oldest) this.fileSummaries.delete(oldest)
    }
    this.fileSummaries.set(contentHash, summary)
    this.fileSummaryOrder.push(contentHash)
  }

  private touchLRU(contentHash: string): void {
    const idx = this.fileSummaryOrder.indexOf(contentHash)
    if (idx >= 0) {
      this.fileSummaryOrder.splice(idx, 1)
      this.fileSummaryOrder.push(contentHash)
    }
  }

  private fileSummaryPath(contentHash: string): string {
    return path.join(this.storageDir, 'summaries', 'files', `${contentHash}.json`)
  }

  private moduleSummaryPath(modulePath: string, contentHash: string): string {
    const safeModule = modulePath.replace(/[^a-zA-Z0-9]/g, '_')
    return path.join(this.storageDir, 'summaries', 'modules', `${safeModule}_${contentHash}.json`)
  }

  private async loadFileSummaryFromDisk(contentHash: string): Promise<FileSummary | null> {
    try {
      const data = await fs.readFile(this.fileSummaryPath(contentHash), 'utf8')
      return JSON.parse(data) as FileSummary
    } catch {
      return null
    }
  }

  private async saveFileSummaryToDisk(contentHash: string, summary: FileSummary): Promise<void> {
    try {
      const filePath = this.fileSummaryPath(contentHash)
      await fs.mkdir(path.dirname(filePath), { recursive: true })
      const tmp = `${filePath}.tmp`
      await fs.writeFile(tmp, JSON.stringify(summary), 'utf8')
      await fs.rename(tmp, filePath)
    } catch (err) {
      this.log(`SummaryService: save file summary failed: ${err}`)
    }
  }

  private async loadModuleSummaryFromDisk(modulePath: string, contentHash: string): Promise<ModuleSummary | null> {
    try {
      const data = await fs.readFile(this.moduleSummaryPath(modulePath, contentHash), 'utf8')
      return JSON.parse(data) as ModuleSummary
    } catch {
      return null
    }
  }

  private async saveModuleSummaryToDisk(modulePath: string, contentHash: string, summary: ModuleSummary): Promise<void> {
    try {
      const filePath = this.moduleSummaryPath(modulePath, contentHash)
      await fs.mkdir(path.dirname(filePath), { recursive: true })
      const tmp = `${filePath}.tmp`
      await fs.writeFile(tmp, JSON.stringify(summary), 'utf8')
      await fs.rename(tmp, filePath)
    } catch (err) {
      this.log(`SummaryService: save module summary failed: ${err}`)
    }
  }

  /** Clear all caches (used on workspace change). */
  clear(): void {
    this.fileSummaries.clear()
    this.moduleSummaries.clear()
    this.fileSummaryOrder = []
  }

  /** Stats for observability. */
  stats(): { fileSummaries: number; moduleSummaries: number } {
    return {
      fileSummaries: this.fileSummaries.size,
      moduleSummaries: this.moduleSummaries.size,
    }
  }
}