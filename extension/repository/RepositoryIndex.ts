import * as vscode from 'vscode'
import { IncrementalFileCatalog } from './IncrementalFileCatalog'
import type { CatalogEntry } from './Catalog'
import { SummaryService, type FileSummary, type ModuleSummary, type SummaryServiceOptions } from './SummaryService'
import { createVscodeFileWatcher } from './VscodeFileWatcher'
import type { WorkspaceDescriptor } from './WorkspaceDescriptor'
import {
  describeWorkspaceRoots,
  describePackageTopology,
  describeModules,
  describeFiles,
  rankPackagesByQuery,
} from './ProgressiveNarrowing'

/**
 * RepositoryIndex (plan §15):
 * - High-level facade combining IncrementalFileCatalog + SummaryService
 * - Manages VS Code file watching
 * - Provides progressive narrowing API for the agent
 * - Persists index and summaries under extension storage
 * - Handles workspace changes (add/remove roots)
 */

export interface RepositoryIndexOptions {
  /** All analysis roots (multi-root). */
  roots: string[]
  /** Workspace descriptor for identity. */
  workspace: WorkspaceDescriptor
  /** Extension storage URI for persistence. */
  storageUri: vscode.Uri
  /** Repository version for evidence staleness. */
  repositoryVersion: string
  /** Optional model provider for summary generation. */
  summaryModelProvider?: SummaryServiceOptions['modelProvider']
  /** Called after a watched repository mutation has been incorporated. */
  onMutation?: () => void
  log?: (msg: string) => void
}

export interface IndexStats {
  totalEntries: number
  truncated: boolean
  fileSummaries: number
  moduleSummaries: number
  roots: string[]
  lastScan: number
}

export class RepositoryIndex {
  private catalog: IncrementalFileCatalog
  private summaryService: SummaryService
  private readonly workspace: WorkspaceDescriptor
  private readonly storageUri: vscode.Uri
  private readonly log: (msg: string) => void
  private readonly onMutation?: () => void
  private initialized = false

  constructor(options: RepositoryIndexOptions) {
    this.workspace = options.workspace
    this.storageUri = options.storageUri
    this.log = options.log ?? (() => {})
    this.onMutation = options.onMutation

    // Storage paths
    const indexPath = vscode.Uri.joinPath(options.storageUri, 'repository-index', `${options.workspace.workspaceId}.json`).fsPath
    const summariesDir = vscode.Uri.joinPath(options.storageUri, 'repository-index', 'summaries').fsPath

    // Create file watcher
    const watcher = createVscodeFileWatcher(options.roots)

    // Create catalog
    this.catalog = new IncrementalFileCatalog(options.roots, {
      indexPath,
      watcher,
      maxEntries: 100_000, // Support 100k+ files
      onChange: () => {
        this.log('RepositoryIndex: catalog changed')
        this.onMutation?.()
      },
      log: this.log,
    })

    // Create summary service
    this.summaryService = new SummaryService({
      storageDir: summariesDir,
      modelProvider: options.summaryModelProvider,
      log: this.log,
    })
  }

  /** Initialize the index (load persisted, scan if needed, start watching). */
  async initialize(): Promise<void> {
    if (this.initialized) return
    await this.catalog.initialize()
    this.initialized = true
    this.log(`RepositoryIndex: initialized for ${this.workspace.workspaceId} (${this.workspace.roots.length} roots)`)
  }

  /** Get the incremental catalog for direct tool access. */
  getCatalog(): IncrementalFileCatalog {
    return this.catalog
  }

  /** Get the summary service. */
  getSummaryService(): SummaryService {
    return this.summaryService
  }

  /** Get all catalog entries. */
  private async getAllEntries(): Promise<CatalogEntry[]> {
    await this.catalog.ensureScanned()
    return this.catalog.allEntries()
  }

  /** Progressive narrowing: workspace roots overview. */
  async getWorkspaceRootsOverview(): Promise<ReturnType<typeof describeWorkspaceRoots>> {
    const entries = await this.getAllEntries()
    return describeWorkspaceRoots(entries)
  }

  /** Progressive narrowing: package topology. */
  async getPackageTopology(options?: { includeFlagged?: boolean; maxSamples?: number }): Promise<ReturnType<typeof describePackageTopology>> {
    const entries = await this.getAllEntries()
    return describePackageTopology(entries, options)
  }

  /** Progressive narrowing: modules within a package. */
  async getModules(packagePath: string, options?: { includeFlagged?: boolean; maxSamples?: number }): Promise<ReturnType<typeof describeModules>> {
    const entries = await this.getAllEntries()
    return describeModules(entries, packagePath, options)
  }

  /** Progressive narrowing: files within a scope. */
  async getFiles(
    scopePath: string,
    options?: { includeFlagged?: boolean; maxSamples?: number; language?: string; extension?: string }
  ): Promise<ReturnType<typeof describeFiles>> {
    const entries = await this.getAllEntries()
    return describeFiles(entries, scopePath, options)
  }

  /** Progressive narrowing: rank packages by query relevance. */
  async rankPackagesByQuery(query: string): Promise<ReturnType<typeof rankPackagesByQuery>> {
    const entries = await this.getAllEntries()
    return rankPackagesByQuery(entries, query)
  }

  /** Get file summaries for a set of entries (lazy, cached by content hash). */
  async getFileSummaries(
    entries: CatalogEntry[],
    readFileFn: (absolutePath: string) => Promise<string>
  ): Promise<FileSummary[]> {
    return this.summaryService.getFileSummaries(entries, readFileFn)
  }

  /** Get module summary for a package/module path. */
  async getModuleSummary(
    modulePath: string,
    entries: CatalogEntry[],
    readFileFn: (absolutePath: string) => Promise<string>
  ): Promise<ModuleSummary> {
    return this.summaryService.getModuleSummary(modulePath, entries, readFileFn)
  }

  /** Get a single entry by absolute path. */
  async getEntry(absolutePath: string): Promise<CatalogEntry | undefined> {
    return this.catalog.getEntry(absolutePath)
  }

  /** Get content hash for a file (evidence staleness). */
  async getContentHash(absolutePath: string): Promise<string | undefined> {
    return this.catalog.getContentHash(absolutePath)
  }

  /** Check if catalog is truncated. */
  isTruncated(): boolean {
    return this.catalog.isTruncated()
  }

  /** Current stats for observability. */
  stats(): IndexStats {
    const summaryStats = this.summaryService.stats()
    return {
      totalEntries: this.catalog.size(),
      truncated: this.catalog.isTruncated(),
      fileSummaries: summaryStats.fileSummaries,
      moduleSummaries: summaryStats.moduleSummaries,
      roots: this.workspace.roots,
      lastScan: Date.now(),
    }
  }

  /** Update roots (workspace folders added/removed). */
  async updateRoots(newRoots: string[], newWorkspace: WorkspaceDescriptor): Promise<void> {
    this.log(`RepositoryIndex: updating roots from ${this.workspace.roots.length} to ${newRoots.length}`)
    // Dispose old catalog
    this.catalog.dispose()
    this.summaryService.clear()

    // Create new catalog with new roots
    const indexPath = vscode.Uri.joinPath(this.storageUri, 'repository-index', `${newWorkspace.workspaceId}.json`).fsPath
    const watcher = createVscodeFileWatcher(newRoots)

    this.catalog = new IncrementalFileCatalog(newRoots, {
      indexPath,
      watcher,
      maxEntries: 100_000,
      onChange: () => {
        this.log('RepositoryIndex: catalog changed')
        // Root updates use a newly supplied descriptor but retain the same
        // mutation observer from the original index construction.
        this.onMutation?.()
      },
      log: this.log,
    })

    // Re-initialize
    await this.catalog.initialize()
    this.initialized = true
  }

  /** Dispose all resources. */
  dispose(): void {
    this.catalog.dispose()
    this.summaryService.clear()
  }
}
