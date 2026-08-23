import * as vscode from 'vscode'
import * as path from 'path'
import {
  loadDocTypes,
  loadForm,
  saveDocTypes,
  saveForm,
} from '../formStateManager'
import { STATE_DIR } from '../brand'
import { renderDocument, type RenderedCanvasDocument } from './DocumentRenderer'
import { documentIrSchema, type DocumentIR } from './DocumentIR'
import type { CheckpointResult, CreatedDocType } from '../agent/workers/DocumentGateway'

/**
 * Host-side document authority (plan §11): the canonical registry and
 * revision-safe document writes. The agent can create documents and checkpoint
 * sections even while the webview is hidden. Writes stay compatible with the
 * existing `.charter-ai/doc-types.json` registry and `<doc-id>.json` layout.
 *
 * Revision model: every host-side write (user save or agent checkpoint) bumps
 * a per-document revision. An agent checkpoint whose baseRevision is stale
 * (user edited meanwhile) NEVER overwrites — the agent draft is parked and the
 * conflict reported, so user edits always win (invariant 8). Revisions persist
 * across restarts in `.charter-ai/doc-revisions.json` (side file — the
 * doc-types.json format is shared with the webview and must stay compatible).
 *
 * Storage sits behind an interface (plan §25) so tests can inject an
 * in-memory store and a future backend can swap without touching orchestration.
 */

const REVISIONS_FILE = 'doc-revisions.json'
const PENDING_DRAFTS_FILE = 'pending-drafts.json'

/** Atomic write: temp file + rename (plan §14 durable-state rule). */
async function writeJsonAtomic(filePath: string, data: unknown): Promise<void> {
  const dir = path.dirname(filePath)
  try {
    await vscode.workspace.fs.stat(vscode.Uri.file(dir))
  } catch {
    await vscode.workspace.fs.createDirectory(vscode.Uri.file(dir))
  }
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`
  await vscode.workspace.fs.writeFile(
    vscode.Uri.file(tmp),
    new TextEncoder().encode(JSON.stringify(data)),
  )
  try {
    await vscode.workspace.fs.rename(vscode.Uri.file(tmp), vscode.Uri.file(filePath))
  } catch {
    // rename across filesystems can fail — fall back to a direct write.
    await vscode.workspace.fs.writeFile(
      vscode.Uri.file(filePath),
      new TextEncoder().encode(JSON.stringify(data)),
    )
    await vscode.workspace.fs.delete(vscode.Uri.file(tmp)).then(() => {}, () => {})
  }
}

async function readJson<T>(filePath: string): Promise<T | null> {
  try {
    const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(filePath))
    return JSON.parse(new TextDecoder().decode(bytes)) as T
  } catch {
    return null
  }
}

/** Storage seam — default implementation is `.charter-ai/` via formStateManager. */
export interface DocumentStore {
  listDocTypes(): Promise<unknown[]>
  saveDocTypes(data: unknown[]): Promise<void>
  loadDocument(documentId: string): Promise<unknown | null>
  saveDocument(documentId: string, data: unknown): Promise<void>
  /** Optional revision persistence; absent = revisions live in memory only. */
  loadRevisions?(): Promise<Record<string, number>>
  saveRevisions?(data: Record<string, number>): Promise<void>
  /** Optional durable parking for drafts that lost a revision race. */
  loadPendingDrafts?(): Promise<PendingDraft[]>
  savePendingDrafts?(drafts: PendingDraft[]): Promise<void>
}

export function formStateDocumentStore(workspaceRoot: string): DocumentStore {
  const revisionsPath = path.join(workspaceRoot, STATE_DIR, REVISIONS_FILE)
  const pendingDraftsPath = path.join(workspaceRoot, STATE_DIR, PENDING_DRAFTS_FILE)
  return {
    listDocTypes: () => loadDocTypes(workspaceRoot),
    saveDocTypes: (data) => saveDocTypes(workspaceRoot, data),
    loadDocument: (documentId) => loadForm(workspaceRoot, documentId),
    saveDocument: (documentId, data) => saveForm(workspaceRoot, documentId, data),
    loadRevisions: () => readJson<Record<string, number>>(revisionsPath).then((v) => v ?? {}),
    saveRevisions: (data) => writeJsonAtomic(revisionsPath, data),
    loadPendingDrafts: () => readJson<PendingDraft[]>(pendingDraftsPath).then((v) => v ?? []),
    savePendingDrafts: (drafts) => writeJsonAtomic(pendingDraftsPath, drafts),
  }
}

/** In-memory store for tests. */
export function memoryDocumentStore(): DocumentStore & { documents: Map<string, unknown>; docTypes: unknown[]; revisions: Record<string, number>; pendingDrafts: PendingDraft[] } {
  const store = {
    docTypes: [] as unknown[],
    documents: new Map<string, unknown>(),
    revisions: {} as Record<string, number>,
    pendingDrafts: [] as PendingDraft[],
    async listDocTypes() {
      return [...store.docTypes]
    },
    async saveDocTypes(data: unknown[]) {
      store.docTypes = data
    },
    async loadDocument(documentId: string) {
      return store.documents.get(documentId) ?? null
    },
    async saveDocument(documentId: string, data: unknown) {
      store.documents.set(documentId, data)
    },
    async loadRevisions() {
      return { ...store.revisions }
    },
    async saveRevisions(data: Record<string, number>) {
      store.revisions = { ...data }
    },
    async loadPendingDrafts() {
      return [...store.pendingDrafts]
    },
    async savePendingDrafts(drafts: PendingDraft[]) {
      store.pendingDrafts = [...drafts]
    },
  }
  return store
}

export interface PendingDraft {
  id: string
  documentId: string
  ir: DocumentIR
  canvas: RenderedCanvasDocument
  createdAt: number
}

const EMPTY_CANVAS: RenderedCanvasDocument = {
  version: 1,
  kind: 'blocknote',
  blocks: [{ type: 'paragraph', content: '' }],
  anchors: {},
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
}

export class DocumentService {
  private readonly revisions = new Map<string, number>()
  private readonly drafts = new Map<string, PendingDraft>()
  private readonly pendingByDocument = new Map<string, string[]>()
  /** Latest full agent IR per document — the regeneration base (plan §13). */
  private readonly lastAgentIRs = new Map<string, DocumentIR>()
  private readonly store: DocumentStore
  private readonly stateReady: Promise<void>
  /** Serializes revision-file writes so concurrent saves never interleave. */
  private revisionsSaveChain: Promise<void> = Promise.resolve()
  private draftsSaveChain: Promise<void> = Promise.resolve()
  private readonly documentWriteChains = new Map<string, Promise<void>>()
  /**
   * Serializes registry mutations (create/rename/delete/move). Each is a
   * read-modify-write over the whole doc-types list, so parallel document
   * creation must not interleave or the later write clobbers the earlier one.
   */
  private registryChain: Promise<unknown> = Promise.resolve()

  constructor(workspaceRootOrStore: string | DocumentStore) {
    this.store = typeof workspaceRootOrStore === 'string' ? formStateDocumentStore(workspaceRootOrStore) : workspaceRootOrStore
    this.stateReady = this.hydrateState()
  }

  /** Resolves when persisted revisions (if any) have been loaded. */
  ready(): Promise<void> {
    return this.stateReady
  }

  /** In-memory bumps made before the disk load finished must win — merge only missing ids. */
  private async hydrateState(): Promise<void> {
    const loaded = this.store.loadRevisions ? await this.store.loadRevisions() : {}
    for (const [id, rev] of Object.entries(loaded)) {
      if (!this.revisions.has(id) && typeof rev === 'number' && Number.isFinite(rev) && rev >= 0) {
        this.revisions.set(id, rev)
      }
    }
    const drafts = this.store.loadPendingDrafts ? await this.store.loadPendingDrafts() : []
    for (const draft of drafts) {
      if (!draft || !draft.id || !draft.documentId || !documentIrSchema.safeParse(draft.ir).success) continue
      this.drafts.set(draft.id, draft)
      this.pendingByDocument.set(draft.documentId, [...(this.pendingByDocument.get(draft.documentId) ?? []), draft.id])
    }
  }

  private scheduleRevisionsSave(): void {
    if (!this.store.saveRevisions) return
    const snapshot = Object.fromEntries(this.revisions)
    // ponytail: last-writer-wins chain; a revision counter per doc is enough here.
    this.revisionsSaveChain = this.revisionsSaveChain
      .then(() => this.store.saveRevisions?.(snapshot))
      .catch(() => {})
  }

  private async savePendingDrafts(): Promise<void> {
    if (!this.store.savePendingDrafts) return
    const snapshot = [...this.drafts.values()]
    this.draftsSaveChain = this.draftsSaveChain
      .then(() => this.store.savePendingDrafts?.(snapshot))
      .catch(() => {})
    await this.draftsSaveChain
  }

  /** Serialize every content write for one document, including its revision check. */
  private async withDocumentWriteLock<T>(documentId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.documentWriteChains.get(documentId) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>((resolve) => { release = resolve })
    const queued = previous.then(() => current)
    this.documentWriteChains.set(documentId, queued)
    await previous
    try {
      return await operation()
    } finally {
      release()
      if (this.documentWriteChains.get(documentId) === queued) this.documentWriteChains.delete(documentId)
    }
  }

  /** Run a registry read-modify-write after any in-flight registry mutation settles. */
  private withRegistryLock<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.registryChain.then(operation)
    // Never let a failed mutation poison the chain for later callers.
    this.registryChain = result.then(() => {}, () => {})
    return result
  }

  /** Current revision for a document (0 = created but never written). */
  revisionOf(documentId: string): number {
    return this.revisions.get(documentId) ?? 0
  }

  /** User saved the document through the editor — their edit wins over agents. */
  noteUserWrite(documentId: string): void {
    this.revisions.set(documentId, this.revisionOf(documentId) + 1)
    this.scheduleRevisionsSave()
  }

  /** User save through the editor: writes the canvas and bumps the revision. */
  async saveUserDocument(documentId: string, data: unknown): Promise<number> {
    return this.withDocumentWriteLock(documentId, async () => {
      await this.store.saveDocument(documentId, data)
      this.noteUserWrite(documentId)
      return this.revisionOf(documentId)
    })
  }

  async listDocTypes(): Promise<unknown[]> {
    return this.store.listDocTypes()
  }

  private docIdOf(value: unknown): string {
    return value && typeof value === 'object' ? String((value as { id?: unknown }).id ?? '') : ''
  }

  /**
   * Create a document type in the canonical registry (idempotent on slug/id
   * collision) plus an empty canvas so the document is immediately openable.
   */
  async createDocType(name: string, icon = 'article'): Promise<CreatedDocType> {
    return this.withRegistryLock(async () => {
      const trimmed = name.trim() || 'Untitled Document'
      const existing = await this.store.listDocTypes()
      const taken = new Set(existing.map((v) => this.docIdOf(v)))
      const base = `doc-${slugify(trimmed) || 'document'}`
      let id = base
      let n = 2
      while (taken.has(id)) id = `${base}-${n++}`

      const created: unknown = { id, name: trimmed, icon, createdAt: Date.now(), order: existing.length }
      await this.store.saveDocTypes([...existing, created])
      await this.store.saveDocument(id, EMPTY_CANVAS)
      return { id, name: trimmed, icon, created: true }
    })
  }

  /** Rename a registry entry (extension is the authority — plan §16.1). */
  async renameDocType(id: string, name: string): Promise<void> {
    return this.withRegistryLock(async () => {
      const trimmed = name.trim()
      if (!trimmed) return
      const existing = await this.store.listDocTypes()
      await this.store.saveDocTypes(
        existing.map((v) => (this.docIdOf(v) === id ? { ...(v as object), name: trimmed } : v)),
      )
    })
  }

  /** Remove a registry entry (the canvas file is left in place, like the webview did). */
  async deleteDocType(id: string): Promise<void> {
    return this.withRegistryLock(async () => {
      const existing = await this.store.listDocTypes()
      await this.store.saveDocTypes(existing.filter((v) => this.docIdOf(v) !== id))
      this.revisions.delete(id)
      this.scheduleRevisionsSave()
      this.pendingByDocument.delete(id)
    })
  }

  /** Reorder the registry: move the entry at `from` to index `to`. */
  async moveDocType(_id: string, from: number, to: number): Promise<void> {
    return this.withRegistryLock(async () => {
      const existing = await this.store.listDocTypes()
      if (
        !Number.isInteger(from) ||
        !Number.isInteger(to) ||
        from < 0 ||
        to < 0 ||
        from >= existing.length ||
        to >= existing.length
      ) {
        return
      }
      const next = [...existing]
      const [moved] = next.splice(from, 1)
      next.splice(to, 0, moved)
      await this.store.saveDocTypes(next.map((v, i) => ({ ...(v as object), order: i })))
    })
  }

  async loadDocument(documentId: string): Promise<RenderedCanvasDocument | null> {
    const data = await this.store.loadDocument(documentId)
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null
    const d = data as Record<string, unknown>
    if (d.kind !== 'blocknote' || !Array.isArray(d.blocks)) return null
    return {
      version: 1,
      kind: 'blocknote',
      blocks: d.blocks as Array<Record<string, unknown>>,
      anchors: (d.anchors && typeof d.anchors === 'object' ? d.anchors : {}) as Record<string, unknown>,
    }
  }

  /**
   * Revision-safe agent checkpoint: writes the FULL rendered document when the
   * baseRevision is still current; otherwise parks a pending draft and reports
   * the conflict (user edits always win).
   */
  async checkpoint(
    documentId: string,
    baseRevision: number,
    ir: unknown,
  ): Promise<CheckpointResult> {
    await this.ready()
    const parsed = documentIrSchema.safeParse(ir)
    if (!parsed.success) {
      const issue = parsed.error.issues[0]
      return {
        ok: false,
        revision: this.revisionOf(documentId),
        conflict: false,
        error: `Invalid document IR: ${issue?.path.join('.') || 'input'} ${issue?.message}`,
      }
    }

    // The agent's latest full IR is the base for targeted regeneration (plan §13).
    this.lastAgentIRs.set(documentId, parsed.data)

    return this.withDocumentWriteLock(documentId, async () => {
      const current = this.revisionOf(documentId)
      if (current !== baseRevision) {
        const draft: PendingDraft = {
          id: `draft-${documentId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          documentId,
          ir: parsed.data,
          canvas: renderDocument(parsed.data),
          createdAt: Date.now(),
        }
        this.drafts.set(draft.id, draft)
        this.pendingByDocument.set(documentId, [...(this.pendingByDocument.get(documentId) ?? []), draft.id])
        await this.savePendingDrafts()
        return { ok: true, revision: current, conflict: true, pendingDraftId: draft.id }
      }

      await this.store.saveDocument(documentId, renderDocument(parsed.data))
      const next = current + 1
      this.revisions.set(documentId, next)
      this.scheduleRevisionsSave()
      return { ok: true, revision: next, conflict: false }
    })
  }

  /**
   * User reviewed and accepted a parked agent draft (plan §16.3): the draft
   * replaces the document content, revision-safe or not the user chose it.
   */
  async applyPendingDraft(
    documentId: string,
    draftId: string,
  ): Promise<{ ok: boolean; revision: number; canvas?: RenderedCanvasDocument; error?: string }> {
    return this.withDocumentWriteLock(documentId, async () => {
      const draft = this.drafts.get(draftId)
      if (!draft || draft.documentId !== documentId) {
        return { ok: false, revision: this.revisionOf(documentId), error: 'Draft not found.' }
      }
      await this.store.saveDocument(documentId, draft.canvas)
      this.lastAgentIRs.set(documentId, draft.ir)
      const next = this.revisionOf(documentId) + 1
      this.revisions.set(documentId, next)
      this.scheduleRevisionsSave()
      this.drafts.delete(draftId)
      this.pendingByDocument.set(
        documentId,
        (this.pendingByDocument.get(documentId) ?? []).filter((d) => d !== draftId),
      )
      await this.savePendingDrafts()
      return { ok: true, revision: next, canvas: draft.canvas }
    })
  }

  /**
   * The agent's latest stored IR for a document, plus the current host
   * revision — regeneration checkpoints against it (plan §13).
   */
  loadIR(documentId: string): { ir: DocumentIR; revision: number } | null {
    const ir = this.lastAgentIRs.get(documentId)
    if (!ir) return null
    return { ir, revision: this.revisionOf(documentId) }
  }

  /** Restore persisted agent IRs after a restart (plan §14 durable state). */
  restoreAgentIR(documentId: string, ir: DocumentIR): void {
    this.lastAgentIRs.set(documentId, ir)
  }

  pendingDraft(id: string): PendingDraft | undefined {
    return this.drafts.get(id)
  }

  pendingDraftsFor(documentId: string): PendingDraft[] {
    return (this.pendingByDocument.get(documentId) ?? []).map((id) => this.drafts.get(id)).filter((d): d is PendingDraft => Boolean(d))
  }
}
