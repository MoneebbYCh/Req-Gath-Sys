import { z } from 'zod'
import { RepositoryToolGateway } from './RepositoryToolGateway'
import { FileCatalog } from './FileCatalog'
import type { CatalogInterface } from './Catalog'
import { RipgrepSearch } from './RipgrepSearch'
import { FileReader } from './FileReader'
import { createRepositoryTools } from './tools'
import { createLspTools } from './lspTools'
import { createDependencyTools } from './dependencyTools'
import { typescriptAdapter, pythonAdapter, goAdapter, type DependencyAdapter } from './DependencyAdapters'
import type { LspBridge } from './LspBridge'
import { createWorkspaceDescriptor, type WorkspaceDescriptor } from './WorkspaceDescriptor'
import type { ToolResult } from '../agent/contracts/RepositoryTool'
import type { ToolDefinition } from '../agent/contracts/ToolDefinition'
import { RepositoryIndex } from './RepositoryIndex'
import type { SummaryService } from './SummaryService'
import type { Uri } from 'vscode'

/**
 * Repository Intelligence v1 + Phase 6 semantic layer + Phase 15 scale (plan §10/§11/§15):
 * deterministic discovery, lexical search, bounded reads, LSP symbols/
 * references, dependency intelligence, incremental indexing, lazy summaries —
 * all behind the Phase 4 gateway.
 * Host-side — the worker reaches tools through typed RPC.
 */
export interface RepositoryServiceOptions {
  roots: string[]
  workspace?: WorkspaceDescriptor
  repositoryVersion: string
  readOpenBuffer?: (absolutePath: string) => string | undefined
  lspBridge?: LspBridge
  dependencyAdapters?: DependencyAdapter[]
  storageUri?: Uri
  summaryModelProvider?: SummaryService['modelProvider']
  log?: (msg: string) => void
}

/**
 * Package-function-style state: gateway/catalog/tools are mutable
 * so initializeIndex() can swap in the incremental catalog (ponytail).
 */
interface MutableRepoState {
  gateway: RepositoryToolGateway
  catalog: CatalogInterface
  tools: ReturnType<typeof createRepositoryTools>[number][]
}

export class RepositoryService {
  readonly workspace: WorkspaceDescriptor
  readonly searcher = new RipgrepSearch()
  readonly reader: FileReader

  private _state: MutableRepoState
  private index?: RepositoryIndex
  private repositoryGeneration = 0
  private readonly storageUri?: Uri
  private readonly summaryModelProvider?: SummaryService['modelProvider']

  constructor(private readonly options: RepositoryServiceOptions) {
    this.workspace =
      options.workspace ??
      createWorkspaceDescriptor('', options.roots)

    if (options.storageUri) this.storageUri = options.storageUri
    if (options.summaryModelProvider) this.summaryModelProvider = options.summaryModelProvider

    const catalog: CatalogInterface = new FileCatalog(options.roots)
    this.reader = new FileReader({ readOpenBuffer: options.readOpenBuffer })
    const adapters = options.dependencyAdapters ?? [typescriptAdapter, pythonAdapter, goAdapter]

    const gateway = new RepositoryToolGateway()
    const tools: ReturnType<typeof createRepositoryTools>[number][] = [
      ...createRepositoryTools({
        catalog,
        searcher: this.searcher,
        reader: this.reader,
        roots: options.roots,
        repositoryVersion: options.repositoryVersion,
      }),
      ...(options.lspBridge
        ? createLspTools({
            roots: options.roots,
            repositoryVersion: options.repositoryVersion,
            bridge: options.lspBridge,
            catalog,
            dependencyAdapters: adapters,
          })
        : []),
      ...createDependencyTools({
        catalog,
        searcher: this.searcher,
        reader: this.reader,
        roots: options.roots,
        repositoryVersion: options.repositoryVersion,
        adapters,
      }),
    ]
    for (const tool of tools) gateway.register(tool)

    this._state = { gateway, catalog, tools }
  }

  get gateway(): RepositoryToolGateway {
    return this._state.gateway
  }

  get catalog(): CatalogInterface {
    return this._state.catalog
  }

  async initializeIndex(): Promise<void> {
    if (!this.storageUri) {
      this.options.log?.('RepositoryService: no storageUri — skipping incremental index')
      return
    }

    this.index = new RepositoryIndex({
      roots: this.options.roots,
      workspace: this.workspace,
      storageUri: this.storageUri,
      repositoryVersion: this.options.repositoryVersion,
      onMutation: () => {
        this.repositoryGeneration++
        this.options.log?.(`RepositoryService: repository generation ${this.repositoryGeneration}`)
      },
      summaryModelProvider: this.summaryModelProvider,
      log: this.options.log,
    })

    await this.index.initialize()
    this.rebuildGateway(this.index.getCatalog())
    this.options.log?.('RepositoryService: incremental index initialized')
  }

  private rebuildGateway(catalog: CatalogInterface): void {
    const gateway = new RepositoryToolGateway()
    const adapters = this.options.dependencyAdapters ?? [typescriptAdapter, pythonAdapter, goAdapter]
    const tools: ReturnType<typeof createRepositoryTools>[number][] = [
      ...createRepositoryTools({
        catalog,
        searcher: this.searcher,
        reader: this.reader,
        roots: this.options.roots,
        repositoryVersion: this.options.repositoryVersion,
      }),
      ...(this.options.lspBridge
        ? createLspTools({
            roots: this.options.roots,
            repositoryVersion: this.options.repositoryVersion,
            bridge: this.options.lspBridge,
            catalog,
            dependencyAdapters: adapters,
          })
        : []),
      ...createDependencyTools({
        catalog,
        searcher: this.searcher,
        reader: this.reader,
        roots: this.options.roots,
        repositoryVersion: this.options.repositoryVersion,
        adapters,
      }),
    ]
    for (const tool of tools) gateway.register(tool)
    this._state = { gateway, catalog, tools }
  }

  getIndex(): RepositoryIndex | undefined {
    return this.index
  }

  executeTool(name: string, input: unknown, signal: AbortSignal): Promise<ToolResult<unknown>> {
    return this._state.gateway.execute(name, input, {
      workspaceRoots: this.options.roots,
      repositoryVersion: this.currentRepositoryVersion(),
      signal,
      log: this.options.log,
    })
  }

  /** Stable at startup, then changes after each incorporated filesystem mutation. */
  private currentRepositoryVersion(): string {
    return `${this.options.repositoryVersion}:g${this.repositoryGeneration}`
  }

  modelToolDefinitions(): ToolDefinition[] {
    return this._state.tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputJsonSchema: z.toJSONSchema(t.inputSchema) as unknown as Record<string, unknown>,
    }))
  }
}
