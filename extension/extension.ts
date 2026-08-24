import * as vscode from 'vscode'
import * as fs from 'fs'
import * as path from 'path'
import {
  initWorkspace,
  loadDocTypes,
  loadForm,
  saveDocTypes,
} from './formStateManager'
import { resolveWorkspaceRoot } from './workspaceRoot'
import type { WebviewToExtensionMessage, ExtensionToWebviewMessage } from './protocol'
import { AgentRuntimeClient } from './agent/AgentRuntimeClient'
import {
  clearApiKey,
  loadApiKey,
  loadProviderConfig,
  storeApiKey,
  type ProviderConfig,
  type ProviderSettings,
} from './agent/config/ProviderConfig'
import { PROVIDERS, providerDef } from './agent/config/Providers'
import { listProviderModels, validateProviderKey } from './agent/config/ProviderValidation'
import { RepositoryService } from './repository/RepositoryService'
import { VscodeLspBridge } from './repository/LspBridge'
import { createWorkspaceDescriptor } from './repository/WorkspaceDescriptor'
import { DocumentService } from './documents/DocumentService'
import {
  computeRepoFingerprint,
  createFileStateStore,
  loadStateSync,
} from './agent/state/PersistedState'
import { resolvePricing, type ModelPricingRates } from './agent/model/pricing'
import type { ProvidersState } from '../shared/providersProtocol'
import { OperationalLogger } from './agent/observability/OperationalLogger'
import {
  agentFeatureFlagsSchema,
  filterModelTools,
  resolveFeatureFlags,
  rolloutStageSchema,
  type AgentFeatureFlags,
} from './agent/rollout/FeatureFlags'

const log = (msg: string) => console.log('[CharterAi]', msg)

export function activate(context: vscode.ExtensionContext) {
  let panel: vscode.WebviewPanel | undefined
  const diagnosticsChannel = vscode.window.createOutputChannel('CharterAI Agent Diagnostics')
  context.subscriptions.push(diagnosticsChannel)
  const diagnosticsLevel = vscode.workspace.getConfiguration('charterAi').get<'debug' | 'info' | 'warn' | 'error'>('diagnosticsLevel') ?? 'info'
  const diagnostics = new OperationalLogger((line) => diagnosticsChannel.appendLine(line), true, diagnosticsLevel)

  function getHtml(webview: vscode.Webview): string {
    const distPath = path.join(context.extensionPath, 'dist', 'index.html')
    let html = fs.readFileSync(distPath, 'utf8')

    const rootUri = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'dist'))

    html = html.replace(/(src|href)=["']\.\/assets\//g, `$1="${rootUri}/assets/`)

    const csp = [
      `default-src 'none'`,
      `style-src ${webview.cspSource} 'unsafe-inline' https://fonts.googleapis.com`,
      `font-src ${webview.cspSource} data: https://fonts.gstatic.com`,
      `script-src ${webview.cspSource}`,
      `img-src ${webview.cspSource} data: blob:`,
      `worker-src ${webview.cspSource} blob:`,
      `connect-src ${webview.cspSource}`,
      `wasm-src ${webview.cspSource} blob:`,
    ].join('; ')

    html = html.replace('<head>', `<head><meta http-equiv="Content-Security-Policy" content="${csp}">`)

    return html
  }

  function postMessage(msg: ExtensionToWebviewMessage): void {
    panel?.webview.postMessage(msg)
  }

  // Agent runtime client: orchestration runs in an isolated worker thread
  // (out/agent-worker.cjs). The host only brokers VS Code APIs + webview messages.
  // Provider credentials pass to the worker in workerData (runtime memory only,
  // never the webview).
  let agent: AgentRuntimeClient | undefined
  let agentConfig: ProviderConfig = { providerId: 'deepseek', backend: 'openai', model: 'deepseek-v4-flash' }

  function readProviderSettings(): ProviderSettings {
    const cfg = vscode.workspace.getConfiguration('charterAi')
    return {
      // Retained in the settings shape for migration compatibility; the
      // DeepSeek-only configuration loader deliberately ignores it.
      provider: cfg.get<string>('provider') ?? 'deepseek',
      model: cfg.get<string>('model') ?? '',
      baseUrl: cfg.get<string>('baseUrl') ?? '',
    }
  }

  /** Read rollout controls at the host boundary; malformed settings fail closed. */
  function readFeatureFlags(): AgentFeatureFlags {
    const cfg = vscode.workspace.getConfiguration('charterAi')
    const stage = rolloutStageSchema.safeParse(cfg.get<unknown>('rolloutStage'))
    const override = agentFeatureFlagsSchema.partial().safeParse(cfg.get<unknown>('featureFlags'))
    if (!stage.success || !override.success) {
      diagnostics.write({ event: 'rollout.invalidConfiguration', ok: false })
      return resolveFeatureFlags('gate-a')
    }
    return resolveFeatureFlags(stage.data, override.data)
  }

  async function startAgent(): Promise<void> {
    agent?.dispose()
    const workspaceId =
      resolveWorkspaceRoot(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath) ?? 'local'
    const workerPath = vscode.Uri.joinPath(context.extensionUri, 'out', 'agent-worker.cjs').fsPath
    const repo = ensureRepositoryService()
    const roots = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath)
    // Plan §14/§25: durable private agent state under workspace extension
    // storage (atomic writes). Never `.charter-ai/` and never the webview.
    // Loaded synchronously so the worker has it BEFORE its first task.
    const stateStore = createAgentStateStore(workspaceId)
    const initialState = stateStore.loadSync()
    const repoFingerprint = computeRepoFingerprint(roots)
    const featureFlags = readFeatureFlags()
    // Resolve per-model pricing from models.dev catalog (lazy fetch, cached).
    const settings = readProviderSettings()
    const storagePath = context.globalStorageUri?.fsPath ?? ''
    const pricingRates = storagePath
      ? await resolvePricing(settings.provider, settings.model, storagePath)
      : undefined
    const pricing = pricingRates
      ? {
          inputPerMillion: pricingRates.inputPerMillion,
          outputPerMillion: pricingRates.outputPerMillion,
          cacheReadPerMillion: pricingRates.cacheReadPerMillion,
          cacheWritePerMillion: pricingRates.cacheWritePerMillion,
          reasoningPerMillion: pricingRates.reasoningPerMillion,
        }
      : undefined
    agent = new AgentRuntimeClient(
      workerPath,
      {
        workspaceId,
        repoFingerprint,
        initialState: initialState ?? null,
        provider: agentConfig.backend,
        model: agentConfig.model,
        baseUrl: agentConfig.baseUrl ?? '',
        apiKey: agentConfig.apiKey ?? '',
        // Capability hiding must happen before tool definitions enter a model
        // prompt. The worker also receives the resolved snapshot for runtime
        // routing and scheduler limits.
        tools: filterModelTools(repo.modelToolDefinitions(), featureFlags),
        featureFlags,
        pricing,
      },
      undefined,
      {
        // Repository tools execute host-side (VS Code APIs + fs); the worker
        // reaches them through typed RPC. The per-call signal aborts in-flight
        // execution on task cancellation (plan §7).
        toolHandler: async ({ name, input }, signal) => {
          try {
            const result = await repo.executeTool(name, input, signal)
            return { ok: true, result }
          } catch (err) {
            return { ok: false, error: err instanceof Error ? err.message : String(err) }
          }
        },
        // Document ops execute host-side through the revision-safe service
        // (plan §11): the worker can generate documents while the webview is
        // hidden, and user edits always win over agent checkpoints.
        documentHandler: async ({ op, payload }) => {
          const ws = workspaceRoot()
          if (!ws) return { ok: false, error: 'Open a folder to generate documents.' }
          const docs = ensureDocumentService(ws)
          try {
            if (op === 'createDocument') {
              const p = payload as { name?: string; icon?: string }
              const meta = await docs.createDocType(p.name ?? 'Untitled Document', p.icon ?? 'article')
              // Push the authoritative registry to the webview so the new type
              // appears in the pipeline without a reload. Do NOT auto-navigate:
              // opening the canvas mounts the editor, whose spurious save bumps
              // the revision and parks the agent's next checkpoint as a false
              // "edited during generation" conflict.
              postMessage({ type: 'loadDocTypes', data: await docs.listDocTypes(), mode: 'replace' })
              return { ok: true, result: meta }
            }
            if (op === 'loadDocumentIR') {
              const p = payload as { documentId?: string }
              if (!p.documentId) return { ok: false, error: 'Invalid loadDocumentIR payload.' }
              return { ok: true, result: docs.loadIR(p.documentId) }
            }
            const p = payload as { documentId?: string; baseRevision?: number; ir?: unknown }
            if (!p.documentId || typeof p.baseRevision !== 'number') {
              return { ok: false, error: 'Invalid checkpoint payload.' }
            }
            const result = await docs.checkpoint(p.documentId, p.baseRevision, p.ir)
            // Keep an open canvas in sync with agent generation. Persisted
            // checkpoints otherwise remain invisible until the user reloads.
            if (result.ok && !result.conflict) {
              postMessage({
                type: 'loadCanvas',
                phase: p.documentId,
                data: await docs.loadDocument(p.documentId),
                revision: result.revision,
              })
            }
            return { ok: true, result }
          } catch (err) {
            return { ok: false, error: err instanceof Error ? err.message : String(err) }
          }
        },
        // Durable state (plan §14): persist worker-reported snapshots and
        // restore agent IRs into the workspace's DocumentService so
        // regeneration still works after a restart.
        statePersistHandler: async (state) => {
          await stateStore.save(state)
          const ws = workspaceRoot()
          if (!ws) return
          const docs = ensureDocumentService(ws)
          for (const [documentId, ir] of Object.entries(state.documentIRs ?? {})) {
            docs.restoreAgentIR(documentId, ir)
          }
        },
        diagnostic: (event) => diagnostics.write(event),
      },
    )
    agent.onEvent((event) => postMessage({ type: 'agentEvent', event }))
  }

  /** Per-workspace state store (storageUri is workspace-scoped; memory fallback). */
  const stateStores = new Map<string, StateStore & { loadSync: () => PersistedAgentState | null }>()
  function createAgentStateStore(workspaceId: string): StateStore & { loadSync: () => PersistedAgentState | null } {
    const existing = stateStores.get(workspaceId)
    if (existing) return existing
    const storageUri = context.storageUri
    const fileName = `agent-state/${workspaceId.replace(/[^a-z0-9]+/gi, '-').slice(0, 64)}.json`
    const storagePath = storageUri === undefined ? '' : vscode.Uri.joinPath(storageUri, fileName).fsPath
    const store = {
      ...(storagePath ? createFileStateStore(storagePath) : memoryStateStore()),
      loadSync: () => (storagePath ? loadStateSync(storagePath) : null),
    }
    stateStores.set(workspaceId, store)
    return store
  }

  // Host-side repository intelligence (plan §10): all analysis roots, dirty
  // open buffers win over disk (US-5.3).
  let repoService: RepositoryService | undefined
  // Host-side document authority (plan §11): canonical registry + revisions.
  const documentServices = new Map<string, DocumentService>()

  function ensureDocumentService(ws: string): DocumentService {
    let service = documentServices.get(ws)
    if (!service) {
      service = new DocumentService(ws)
      documentServices.set(ws, service)
    }
    return service
  }

  function ensureRepositoryService(): RepositoryService {
    if (!repoService) {
      const folders = vscode.workspace.workspaceFolders ?? []
      const roots = folders.map((f) => f.uri.fsPath)
      const workspaceId =
        resolveWorkspaceRoot(folders[0]?.uri.fsPath) ?? 'local'
      // Plan §10 multi-root: the WorkspaceDescriptor carries ALL analysis
      // roots — secondary folders are never silently ignored.
      const descriptor = createWorkspaceDescriptor(workspaceId, roots)
      repoService = new RepositoryService({
        roots,
        workspace: descriptor,
        repositoryVersion: `repo:${workspaceId}:${Date.now()}`,
        readOpenBuffer: (p) =>
          vscode.workspace.textDocuments.find((d) => d.uri.fsPath === p && d.isDirty)?.getText(),
        // Phase 6: LSP symbols/references/diagnostics execute through the
        // host bridge (the worker cannot touch vscode).
        lspBridge: new VscodeLspBridge(),
        // Phase 15: persistent incremental index + lazy summaries.
        storageUri: context.storageUri,
        log: (msg) => log(msg),
      })
      // Initialize the incremental index asynchronously (non-blocking)
      repoService.initializeIndex().catch((err) => log(`RepositoryService initializeIndex failed: ${err}`))
    }
    return repoService
  }

  /** Reload provider config; restart the worker only when something changed. */
  async function refreshAgentConfig(): Promise<void> {
    const next = await loadProviderConfig(context.secrets, readProviderSettings())
    if (JSON.stringify(next) !== JSON.stringify(agentConfig)) {
      agentConfig = next
      if (agent) await startAgent()
    }
  }

  // In-memory result of the last key validation for the active provider.
  interface KeyValidation {
    providerId: string
    ok: boolean
    models: string[]
    error?: string
  }
  let lastValidation: KeyValidation | undefined

  /**
   * One silent /models discovery per host session, so the chat model picker
   * lists every model a stored key exposes without a manual "Validate" trip.
   * An explicit validation always wins over this cached list.
   */
  let discoveredModels: Promise<string[]> | undefined

  function availableModels(def: ReturnType<typeof providerDef>, apiKey: string | undefined): Promise<string[]> {
    const validated =
      lastValidation?.providerId === 'deepseek' && lastValidation.ok ? lastValidation.models : []
    if (validated.length > 0 || !apiKey) return Promise.resolve(validated)
    discoveredModels ??= listProviderModels(def, apiKey, [])
    return discoveredModels
  }

  /** Snapshot of provider state for the picker UI (keys themselves stay in SecretStorage). */
  async function buildProvidersState(): Promise<ProvidersState> {
    const settings = readProviderSettings()
    const providerId = 'deepseek'
    const def = providerDef(providerId)
    const apiKey = await loadApiKey(context.secrets, providerId)
    const validation = lastValidation?.providerId === providerId ? lastValidation : undefined
    return {
      providers: PROVIDERS.map((p) => ({
        id: p.id,
        label: p.label,
        baseUrl: p.baseUrl,
        keyRequired: p.keyRequired,
        defaultModel: p.defaultModel,
      })),
      activeProviderId: providerId,
      hasKey: Boolean(apiKey),
      keyValidated: validation?.ok ?? false,
      model: settings.model.trim().startsWith('deepseek-')
        ? settings.model.trim()
        : def.defaultModel || 'deepseek-v4-flash',
      baseUrl: def.baseUrl,
      models: await availableModels(def, apiKey),
      error: validation && !validation.ok ? validation.error : undefined,
    }
  }

  async function setAndValidateProviderKey(): Promise<string | undefined> {
    const providerId = 'deepseek'
    const def = providerDef(providerId)
    const baseUrl = def.baseUrl

    const key = await vscode.window.showInputBox({
      title: 'Configure DeepSeek',
      prompt: 'DeepSeek API key (stored in VS Code SecretStorage)',
      password: true,
      ignoreFocusOut: true,
    })
    if (!key?.trim()) return 'Provider setup was cancelled.'

    const result = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Validating API key…' },
      async () => validateProviderKey(baseUrl, key.trim()),
    )
    lastValidation = {
      providerId,
      ok: result.ok,
      models: result.models ?? [],
      error: result.error,
    }
    if (!result.ok) return `API key validation failed: ${result.error}`

    await storeApiKey(context.secrets, providerId, key.trim())
    await refreshAgentConfig()
    vscode.window.showInformationMessage(`Key validated — ${result.models?.length ?? 0} models available.`)
    return undefined
  }

  /**
   * Blocks a message until a real model has a configured credential. This is
   * host-side so keys are never exposed to the webview.
   */
  async function ensureProviderReadyForAgentStart(): Promise<string | undefined> {
    if (await loadApiKey(context.secrets, 'deepseek')) {
      await refreshAgentConfig()
      return undefined
    }
    return setAndValidateProviderKey()
  }

  async function ensureAgent(): Promise<AgentRuntimeClient | undefined> {
    if (!agent) await startAgent()
    return agent
  }

  // No folder open → explain why a repository task cannot start (plan §30).
  function failNoWorkspace(): void {
    failAgentStart('Open a folder to use Charter Ai.')
  }

  /** Fail through the normal event contract so the webview keeps task state coherent. */
  function failAgentStart(error: string): void {
    const taskId = crypto.randomUUID()
    const now = Date.now()
    postMessage({
      type: 'agentEvent',
      event: { type: 'agentTaskStarted', taskId, seq: 0, timestamp: now, title: 'Charter Ai' },
    })
    postMessage({
      type: 'agentEvent',
      event: {
        type: 'agentTaskFailed',
        taskId,
        seq: 1,
        timestamp: now,
        error,
      },
    })
  }

  async function handleMessage(msg: WebviewToExtensionMessage): Promise<void> {
    log(`message: ${msg.type}`)
    diagnostics.write({
      event: msg.type === 'agentStart' ? 'task.start_requested' : 'webview.message_received',
      level: msg.type === 'agentStart' ? 'info' : 'debug',
    })
    if (msg.type === 'loadWorkspaceInfo') {
      await ensureWorkspaceFolder()
      return
    }

    // Agent lifecycle messages: the runtime owns sessions/tasks and does not
    // need a workspace for cancel/resume/snapshot. agentStart gates on a
    // workspace because the product is a read-only repository agent.
    // Provider picker messages work without a workspace (settings + secrets).
    switch (msg.type) {
      case 'agentStart': {
        try {
          if (!readFeatureFlags().streaming) {
            failAgentStart('The CharterAI streaming shell is disabled for this rollout stage.')
          } else if (!workspaceRoot()) {
            failNoWorkspace()
          } else {
            const setupError = await ensureProviderReadyForAgentStart()
            if (setupError) failAgentStart(setupError)
            else (await ensureAgent())?.start(msg.requestId, msg.text, msg.surface)
          }
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err)
          diagnostics.write({ event: 'task.start_failed', level: 'error', errorKind: 'configuration', ok: false })
          failAgentStart(`Unable to start the DeepSeek agent: ${detail}`)
        }
        return
      }
      case 'agentCancel':
        (await ensureAgent())?.cancel(msg.taskId)
        return
      case 'agentResume':
        (await ensureAgent())?.resume(msg.taskId)
        return
      case 'agentLoadSession':
        (await ensureAgent())?.sendSnapshot()
        return
      case 'agentApplyDraft': {
        // Plan §16.3: the user reviewed a parked agent draft and accepted it —
        // the draft replaces the document (their explicit choice wins).
        const ws = workspaceRoot()
        if (!ws) return
        const result = await ensureDocumentService(ws).applyPendingDraft(msg.documentId, msg.draftId)
        if (result.ok && result.canvas) {
          postMessage({
            type: 'loadCanvas',
            phase: msg.documentId,
            data: result.canvas,
            revision: result.revision,
          })
        }
        return
      }
      case 'providersLoad':
        postMessage({ type: 'providersState', state: await buildProvidersState() })
        return
      case 'providersSetKey': {
        const error = await setAndValidateProviderKey()
        if (error && error !== 'Provider setup was cancelled.') vscode.window.showErrorMessage(error)
        postMessage({ type: 'providersState', state: await buildProvidersState() })
        return
      }
      case 'providersValidate': {
        const providerId = 'deepseek'
        const def = providerDef(providerId)
        const baseUrl = def.baseUrl
        const apiKey = await loadApiKey(context.secrets, providerId)
        if (!baseUrl || !apiKey) {
          lastValidation = {
            providerId,
            ok: false,
            models: [],
            error: 'No API key stored for this provider.',
          }
        } else {
          const result = await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: 'Validating API key…' },
            async () => validateProviderKey(baseUrl, apiKey),
          )
          lastValidation = {
            providerId,
            ok: result.ok,
            models: result.models ?? [],
            error: result.error,
          }
          if (result.ok) {
            vscode.window.showInformationMessage(
              `Key valid — ${result.models?.length ?? 0} models available.`,
            )
          } else {
            vscode.window.showErrorMessage(`API key validation failed: ${result.error}`)
          }
        }
        postMessage({ type: 'providersState', state: await buildProvidersState() })
        return
      }
      case 'providersClearKey': {
        await clearApiKey(context.secrets, 'deepseek')
        lastValidation = undefined
        discoveredModels = undefined
        await refreshAgentConfig()
        postMessage({ type: 'providersState', state: await buildProvidersState() })
        return
      }
      case 'providersSetModel': {
        await vscode.workspace
          .getConfiguration('charterAi')
          .update('model', msg.model, vscode.ConfigurationTarget.Global)
        postMessage({ type: 'providersState', state: await buildProvidersState() })
        return
      }
    }

    const ws = workspaceRoot()
    // No folder open: refuse to persist into the extension install directory.
    if (!ws) {
      log('no workspace folder — refusing to persist')
      return
    }

    switch (msg.type) {
      case 'loadDocTypes': {
        const data = await loadDocTypes(ws)
        postMessage({ type: 'loadDocTypes', data })
        break
      }
      case 'saveDocTypes': {
        await saveDocTypes(ws, msg.data)
        break
      }
      // Plan §16.1: document registry mutations run extension-side — the
      // extension is the authority, then pushes the canonical snapshot back.
      case 'documentCreate': {
        await ensureDocumentService(ws).createDocType(msg.name, msg.icon ?? 'article')
        postMessage({ type: 'loadDocTypes', data: await ensureDocumentService(ws).listDocTypes(), mode: 'replace' })
        break
      }
      case 'documentRename': {
        await ensureDocumentService(ws).renameDocType(msg.id, msg.name)
        postMessage({ type: 'loadDocTypes', data: await ensureDocumentService(ws).listDocTypes(), mode: 'replace' })
        break
      }
      case 'documentDelete': {
        await ensureDocumentService(ws).deleteDocType(msg.id)
        postMessage({ type: 'loadDocTypes', data: await ensureDocumentService(ws).listDocTypes(), mode: 'replace' })
        break
      }
      case 'documentMove': {
        await ensureDocumentService(ws).moveDocType(msg.id, msg.from, msg.to)
        postMessage({ type: 'loadDocTypes', data: await ensureDocumentService(ws).listDocTypes(), mode: 'replace' })
        break
      }
      case 'documentApplyDraft': {
        const docs = ensureDocumentService(ws)
        await docs.ready()
        const result = await docs.applyPendingDraft(msg.documentId, msg.draftId)
        if (result.ok) {
          postMessage({ type: 'loadCanvas', phase: msg.documentId, data: result.canvas, revision: result.revision })
        } else {
          postMessage({ type: 'saveCanvasConflict', phase: msg.documentId, currentRevision: result.revision, seq: msg.seq ?? 0 })
        }
        break
      }
      case 'loadCanvas': {
        const data = await loadForm(ws, msg.phase)
        const docs = ensureDocumentService(ws)
        await docs.ready()
        postMessage({ type: 'loadCanvas', phase: msg.phase, data, revision: docs.revisionOf(msg.phase) })
        break
      }
      case 'saveCanvas': {
        // Plan §16.2: revision-safe save. A stale baseRevision means the doc
        // changed on disk since the webview loaded it — refuse to overwrite
        // and tell the webview the current revision instead.
        const docs = ensureDocumentService(ws)
        await docs.ready()
        if (typeof msg.baseRevision === 'number' && docs.revisionOf(msg.phase) !== msg.baseRevision) {
          postMessage({
            type: 'saveCanvasConflict',
            phase: msg.phase,
            currentRevision: docs.revisionOf(msg.phase),
            seq: msg.seq,
          })
          break
        }
        const revision = await docs.saveUserDocument(msg.phase, msg.data)
        postMessage({ type: 'saveCanvasAck', phase: msg.phase, revision, seq: msg.seq })
        break
      }
      case 'exportMarkdown': {
        const safeName =
          msg.suggestedName.replace(/[^\w\- ]+/g, '').trim() || 'document'
        const defaultUri = vscode.Uri.joinPath(vscode.Uri.file(ws), `${safeName}.md`)
        log(`export: suggested "${safeName}.md" in ${ws}`)
        const uri = await vscode.window.showSaveDialog({
          defaultUri,
          filters: { Markdown: ['md'] },
        })
        if (!uri) {
          log('export: cancelled by user')
          break
        }
        try {
          await vscode.workspace.fs.writeFile(
            uri,
            new TextEncoder().encode(msg.markdown),
          )
          log(`export: wrote ${uri.fsPath} (${msg.markdown.length} chars)`)
          vscode.window.showInformationMessage('Exported document to Markdown.')
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : String(err)
          log(`export: FAILED ${errorMsg}`)
          vscode.window.showErrorMessage(`Export failed: ${errorMsg}`)
        }
        break
      }
    }
  }

  function workspaceRoot(): string | null {
    // Never fall back to the extension install directory — that writes state
    // into the bundle location when no folder is open.
    return resolveWorkspaceRoot(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath)
  }

  /** Create `.charter-ai/` in the open folder (if needed) and tell the webview the path. */
  async function ensureWorkspaceFolder(): Promise<void> {
    const ws = workspaceRoot()
    if (!ws) {
      log('workspaceInfo: available=false (no folder)')
      postMessage({ type: 'workspaceInfo', path: '', name: '', available: false })
      return
    }
    try {
      await initWorkspace(ws)
    } catch {
      /* folder may be read-only; docs will surface errors later */
    }
    const folder = vscode.workspace.workspaceFolders?.[0]
    const fullPath = folder?.uri.fsPath ?? ws
    const name = folder?.name ?? path.basename(fullPath)
    postMessage({ type: 'workspaceInfo', path: fullPath, name, available: true })
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('charter-ai.openPipeline', async () => {
      if (panel) {
        panel.reveal(vscode.ViewColumn.One)
        await ensureWorkspaceFolder()
        return
      }

      panel = vscode.window.createWebviewPanel(
        'charterAiPanel',
        'Charter Ai',
        vscode.ViewColumn.One,
        {
          enableScripts: true,
          retainContextWhenHidden: true,
          localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist')],
        },
      )

      panel.webview.html = getHtml(panel.webview)

      panel.webview.onDidReceiveMessage((message: WebviewToExtensionMessage) => {
        void handleMessage(message).catch((err) => {
          diagnostics.write({ event: 'webview.message_failed', level: 'error', errorKind: 'unknown', ok: false })
          log(`webview message failed: ${err instanceof Error ? err.message : String(err)}`)
        })
      })

      panel.onDidDispose(() => {
        panel = undefined
      })

      await ensureWorkspaceFolder()
    }),

    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      void ensureWorkspaceFolder()
      // Workspace changed: reset the runtime (disposes the worker → cancels the running task).
      if (agent) void startAgent()
    }),

    vscode.commands.registerCommand('charter-ai.initializeWorkspace', async () => {
      const ws = workspaceRoot()
      if (!ws) { vscode.window.showErrorMessage('Open a workspace first.'); return }

      try {
        const created = await initWorkspace(ws)
        if (created) {
          vscode.window.showInformationMessage('Charter Ai workspace initialized!')
        } else {
          vscode.window.showInformationMessage('Charter Ai already initialized in this workspace.')
        }
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err)
        vscode.window.showErrorMessage(`Failed to initialize workspace: ${errorMsg}`)
      }
    }),

    // SecretStorage only: the key never touches settings, `.charter-ai/`, or the webview.
    vscode.commands.registerCommand('charter-ai.setProviderKey', async () => {
      const key = await vscode.window.showInputBox({
        prompt: 'Paste your DeepSeek API key (stored in VS Code SecretStorage)',
        password: true,
        ignoreFocusOut: true,
      })
      if (!key) return
      try {
        await storeApiKey(context.secrets, 'deepseek', key.trim())
        await refreshAgentConfig()
        vscode.window.showInformationMessage('Charter Ai DeepSeek API key saved.')
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err)
        vscode.window.showErrorMessage(`Failed to save the provider key: ${errorMsg}`)
      }
    }),

    vscode.commands.registerCommand('charter-ai.showAgentDiagnostics', () => {
      diagnosticsChannel.show(true)
    }),

    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('charterAi')) void refreshAgentConfig()
    }),

    { dispose: () => agent?.dispose() },
  )

  // Load provider config (settings + SecretStorage) before the webview asks.
  void refreshAgentConfig()
}

export function deactivate() {}
