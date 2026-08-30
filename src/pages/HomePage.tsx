import { useEffect, useMemo, useState } from 'react'
import type { View } from '../hooks/useViewState'
import { BrandMark } from '../components/BrandMark'
import { ConfirmDialog } from '../components/ConfirmDialog'
import { NewDocumentModal } from '../components/NewDocumentModal'
import {
  createDocType,
  deleteDocType,
  getDocumentType,
  listDocumentTypes,
  listPipelineDocumentTypes,
  type DocumentTypeMeta,
} from '../data/documentTypes'
import {
  documentHasContent,
  toCanvasDocument,
  type CanvasDocument,
} from '../types/document'
import { loadProfile, profileInitials } from '../utils/profile'
import { getVscodeApi } from '../utils/vscodeApi'
import { storageKeyFor, hasWorkspaceScope } from '../utils/workspaceScope'

interface HomePageProps {
  onNavigate: (view: View) => void
  /** Send a chat message from the Home ask bar (opens the side panel). */
  onAsk?: (text: string) => void
  isAsking?: boolean
  /** Bumped when the extension pushes updated doc types. */
  docTypesRev?: number
  /** No folder is open in VS Code — show a notice instead of the pipeline. */
  noWorkspace?: boolean
}

function loadSavedDoc(phaseId: string): { doc: CanvasDocument | null; hasDraft: boolean } {
  try {
    const meta = getDocumentType(phaseId)
    if (!meta) return { doc: null, hasDraft: false }
    const raw =
      localStorage.getItem(storageKeyFor(meta.storageKey)) ??
      (meta.legacyStorageKey ? localStorage.getItem(meta.legacyStorageKey) : null)
    if (!raw) return { doc: null, hasDraft: false }
    const doc = toCanvasDocument(JSON.parse(raw))
    return { doc, hasDraft: documentHasContent(doc) }
  } catch {
    return { doc: null, hasDraft: false }
  }
}

/** Wipe all pipeline documents on disk (registry + canvas files + agent IRs). */
function clearAllDocs() {
  const vscode = getVscodeApi()
  vscode?.postMessage({ type: 'documentResetAll' })
  for (const meta of listDocumentTypes()) {
    try {
      localStorage.removeItem(storageKeyFor(meta.storageKey))
      if (!hasWorkspaceScope() && meta.legacyStorageKey) {
        localStorage.removeItem(meta.legacyStorageKey)
      }
    } catch {
      /* ignore storage errors */
    }
  }
}

export function HomePage({
  onNavigate,
  onAsk,
  isAsking,
  docTypesRev: docTypesRevProp = 0,
  noWorkspace = false,
}: HomePageProps) {
  const [profile] = useState(() => loadProfile())

  const [pendingReset, setPendingReset] = useState(false)
  // Bumped whenever the custom document-type list changes.
  const [docTypesRevLocal, setDocTypesRev] = useState(0)
  const docTypesRev = docTypesRevLocal + docTypesRevProp
  const [showNewDoc, setShowNewDoc] = useState(false)
  const [pendingDeleteDoc, setPendingDeleteDoc] = useState<DocumentTypeMeta | null>(null)
  const [workspace, setWorkspace] = useState<{ path: string; name: string } | null>(null)
  const [homeAsk, setHomeAsk] = useState('')

  const docTypes = useMemo(() => listPipelineDocumentTypes(), [docTypesRev])
  const hasDraft = useMemo(() => {
    return listPipelineDocumentTypes().some((meta) => loadSavedDoc(meta.id).hasDraft)
  }, [docTypesRev])

  const firstDocId = docTypes[0]?.id ?? null

  useEffect(() => {
    const vscode = getVscodeApi()
    if (!vscode) return
    const handler = (event: MessageEvent) => {
      const msg = event.data
      if (msg?.type === 'workspaceInfo' && typeof msg.path === 'string') {
        setWorkspace({
          path: msg.path,
          name: typeof msg.name === 'string' && msg.name ? msg.name : msg.path.split(/[/\\]/).pop() || msg.path,
        })
      }
    }
    window.addEventListener('message', handler)
    vscode.postMessage({ type: 'loadWorkspaceInfo' })
    return () => window.removeEventListener('message', handler)
  }, [])

  const confirmReset = () => {
    clearAllDocs()
    setPendingReset(false)
    if (firstDocId) onNavigate({ page: firstDocId })
  }

  const handleCreateDoc = (name: string, icon: string) => {
    const created = createDocType(name, icon)
    setShowNewDoc(false)
    setDocTypesRev((n) => n + 1)
    onNavigate({ page: created.id })
  }

  const confirmDeleteDoc = () => {
    if (!pendingDeleteDoc) return
    deleteDocType(pendingDeleteDoc.id)
    setPendingDeleteDoc(null)
    setDocTypesRev((n) => n + 1)
  }

  return (
    <div className="home-desktop h-screen w-full overflow-hidden flex flex-col dither-bg">
      {noWorkspace ? (
        <div className="home-mac-window flex-1 min-h-0 m-2 md:m-3 border-2 border-on-background bg-white mac-window-shadow flex flex-col items-center justify-center gap-4 p-8 text-center">
          <BrandMark size="lg" />
          <h2
            className="text-xl font-bold text-on-background"
            style={{ fontFamily: 'var(--font-headline)' }}
          >
            Open a folder to use Charter Ai
          </h2>
          <p className="text-sm text-on-surface-variant max-w-md" style={{ fontFamily: 'var(--font-body)' }}>
            Drafts and AI need a workspace. Open a project folder in VS Code, then run
            “Charter Ai: Open Pipeline” again.
          </p>
        </div>
      ) : (
      <div className="home-mac-window flex-1 min-h-0 m-2 md:m-3 border-2 border-on-background bg-white mac-window-shadow flex flex-col">
        <div className="flex items-center gap-2 border-b-2 border-on-background bg-secondary-container px-2 py-1 shrink-0">
          <div className="mac-striped-header flex-1 min-w-0" aria-hidden />
          <span className="px-1">
            <BrandMark size="sm" />
          </span>
          <div className="mac-striped-header flex-1 min-w-0" aria-hidden />
        </div>

        <div
          className="home-workspace-bar"
          title={workspace?.path ?? 'No workspace folder open'}
        >
          <span className="home-workspace-bar-label">Workspace</span>
          <span className="home-workspace-bar-sep" aria-hidden>
            ·
          </span>
          {workspace ? (
            <>
              <span className="home-workspace-bar-name">{workspace.name}</span>
              <span className="home-workspace-bar-path">{workspace.path}</span>
            </>
          ) : (
            <span className="home-workspace-bar-path">
              {getVscodeApi() ? 'Detecting folder…' : 'Not running inside VS Code'}
            </span>
          )}
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto">
          <div className="p-4 md:p-6 border-b-2 border-on-background">
            <div className="flex items-start justify-between gap-4 flex-wrap">
              <div className="min-w-0">
                <BrandMark size="lg" className="mb-3" />
                <p className="text-sm text-on-surface-variant mb-4 max-w-md">
                  Ask below to generate the docs this project needs — the Documents grid starts empty.
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  {firstDocId ? (
                    <button
                      type="button"
                      onClick={() => onNavigate({ page: firstDocId })}
                      className="border-2 border-on-background bg-primary text-on-primary font-bold px-6 py-2 text-sm outset-button hover:opacity-90"
                      style={{ fontFamily: 'var(--font-label)' }}
                    >
                      {hasDraft ? 'Resume Documents' : 'Open Documents'}
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setShowNewDoc(true)}
                      className="border-2 border-on-background bg-primary text-on-primary font-bold px-6 py-2 text-sm outset-button hover:opacity-90"
                      style={{ fontFamily: 'var(--font-label)' }}
                    >
                      New Document
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => onNavigate({ page: 'templates' })}
                    className="border-2 border-on-background bg-white text-on-background font-bold px-6 py-2 text-sm outset-button hover:bg-surface-container-low"
                    style={{ fontFamily: 'var(--font-label)' }}
                    title="Browse document templates"
                  >
                    Browse Templates
                  </button>
                  <button
                    type="button"
                    onClick={() => setPendingReset(true)}
                    className="border-2 border-on-background bg-white text-on-background font-bold px-6 py-2 text-sm outset-button hover:bg-surface-container-low disabled:opacity-40"
                    style={{ fontFamily: 'var(--font-label)' }}
                    title="Clear all documents back to blank"
                    disabled={!hasDraft}
                  >
                    Reset Documents
                  </button>
                </div>
              </div>

              <button
                type="button"
                className="home-profile-panel border-2 border-on-background bg-surface-container-low inset-field p-3 min-w-[200px] text-left"
                onClick={() => onNavigate({ page: 'profile' })}
                title="Open profile"
              >
                <div
                  className="text-[10px] font-bold uppercase tracking-widest text-on-surface-variant mb-2"
                  style={{ fontFamily: 'var(--font-label)' }}
                >
                  Profile
                </div>
                <div className="flex items-center gap-3">
                  <span
                    className="w-10 h-10 border-2 border-on-background bg-primary text-on-primary flex items-center justify-center text-xs font-bold mac-window-shadow shrink-0"
                    style={{ fontFamily: 'var(--font-label)' }}
                    aria-hidden
                  >
                    {profileInitials(profile.name)}
                  </span>
                  <span className="min-w-0">
                    <span
                      className="block font-bold text-sm text-on-background truncate"
                      style={{ fontFamily: 'var(--font-headline)' }}
                    >
                      {profile.name}
                    </span>
                    <span
                      className="block text-[11px] text-on-surface-variant truncate"
                      style={{ fontFamily: 'var(--font-label)' }}
                    >
                      {profile.role}
                    </span>
                    <span
                      className="block text-[10px] text-primary mt-0.5 font-bold"
                      style={{ fontFamily: 'var(--font-label)' }}
                    >
                      Open profile…
                    </span>
                  </span>
                </div>
              </button>
            </div>
          </div>

          <div className="home-ask-section border-b-2 border-on-background px-4 md:px-6 py-4">
            <div className="flex items-center gap-2 mb-2">
              <span
                className="text-xs font-bold tracking-widest text-on-surface-variant uppercase"
                style={{ fontFamily: 'var(--font-label)' }}
              >
                Ask Charter Ai
              </span>
              <div className="flex-1 h-px bg-on-background/30" />
              <span
                className="text-[11px] text-on-surface-variant"
                style={{ fontFamily: 'var(--font-label)' }}
              >
                Reads the codebase · builds your doc set
              </span>
            </div>
            <form
              className="home-ask-bar"
              onSubmit={(e) => {
                e.preventDefault()
                const text = homeAsk.trim()
                if (!text || isAsking || !onAsk) return
                onAsk(text)
                setHomeAsk('')
              }}
            >
              <input
                className="home-ask-input"
                type="text"
                value={homeAsk}
                onChange={(e) => setHomeAsk(e.target.value)}
                placeholder="e.g. What docs does this repo need? Add an ADR + API contract…"
                disabled={Boolean(isAsking) || !onAsk}
                aria-label="Ask Charter Ai to design documents for this project"
              />
              <button
                type="submit"
                className="home-ask-submit border-2 border-on-background bg-primary text-on-primary font-bold px-5 py-2 text-sm outset-button hover:opacity-90 disabled:opacity-40"
                style={{ fontFamily: 'var(--font-label)' }}
                disabled={!homeAsk.trim() || Boolean(isAsking) || !onAsk}
              >
                {isAsking ? 'Working…' : 'Ask'}
              </button>
            </form>
            <div className="home-ask-hints">
              {[
                'What documents does this project need?',
                'Build a docs pipeline for this codebase',
                'Add a migration runbook and API contract',
              ].map((hint) => (
                <button
                  key={hint}
                  type="button"
                  className="home-ask-chip"
                  disabled={Boolean(isAsking) || !onAsk}
                  onClick={() => {
                    if (!onAsk || isAsking) return
                    onAsk(hint)
                  }}
                >
                  {hint}
                </button>
              ))}
            </div>
          </div>

          {hasDraft && firstDocId && (
            <div className="border-b-2 border-on-background bg-surface-container-low px-4 md:px-6 py-2 flex items-center justify-between flex-wrap gap-2">
              <span className="text-xs text-on-surface-variant" style={{ fontFamily: 'var(--font-label)' }}>
                Active draft on disk
              </span>
              <button
                type="button"
                onClick={() => onNavigate({ page: firstDocId })}
                className="border-2 border-on-background bg-primary text-on-primary font-bold px-4 py-1 text-xs outset-button"
                style={{ fontFamily: 'var(--font-label)' }}
              >
                Open Documents
              </button>
            </div>
          )}

          <div className="p-4 md:p-6 pb-6">
            <div className="flex items-center gap-2 mb-3">
              <span
                className="text-xs font-bold tracking-widest text-on-surface-variant uppercase"
                style={{ fontFamily: 'var(--font-label)' }}
              >
                Documents
              </span>
              <div className="flex-1 h-px bg-on-background/30" />
              <span
                className="text-[11px] text-on-surface-variant"
                style={{ fontFamily: 'var(--font-label)' }}
              >
                {docTypes.length === 0
                  ? 'Empty until you ask or add one'
                  : `${docTypes.length} document${docTypes.length === 1 ? '' : 's'}`}
              </span>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-0 border-2 border-on-background">
              {docTypes.length === 0 ? (
                <div className="col-span-2 md:col-span-3 border border-on-background bg-surface-container-low p-6 text-center">
                  <p
                    className="text-sm text-on-surface-variant mb-1"
                    style={{ fontFamily: 'var(--font-body)' }}
                  >
                    No documents yet.
                  </p>
                  <p
                    className="text-[11px] text-on-surface-variant mb-3"
                    style={{ fontFamily: 'var(--font-label)' }}
                  >
                    Use Ask Charter Ai above, browse templates, or add one manually.
                  </p>
                  <button
                    type="button"
                    onClick={() => onNavigate({ page: 'templates' })}
                    className="border-2 border-on-background bg-white text-on-background font-bold px-4 py-1.5 text-xs outset-button hover:bg-surface-container-low"
                    style={{ fontFamily: 'var(--font-label)' }}
                  >
                    Browse Templates
                  </button>
                </div>
              ) : null}
              {docTypes.map((doc) => (
                <div
                  key={doc.id}
                  className="relative border border-on-background bg-white hover:bg-surface-container-low transition-colors group min-h-[110px] flex flex-col"
                >
                  <button
                    type="button"
                    onClick={() => onNavigate({ page: doc.id })}
                    className="flex-1 p-4 flex flex-col text-left cursor-pointer"
                  >
                    <span className="material-symbols-outlined text-on-background group-hover:text-primary mb-3">
                      {doc.icon}
                    </span>
                    <h3
                      className="font-bold text-sm text-on-background mb-0.5 pr-5"
                      style={{ fontFamily: 'var(--font-headline)' }}
                    >
                      {doc.title}
                    </h3>
                    <p
                      className="text-[11px] font-semibold text-on-background/75"
                      style={{ fontFamily: 'var(--font-label)' }}
                    >
                      Pipeline document
                    </p>
                  </button>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation()
                      setPendingDeleteDoc(doc)
                    }}
                    className="absolute top-1.5 right-1.5 w-5 h-5 flex items-center justify-center border border-on-background bg-white text-on-background hover:bg-error hover:text-on-primary text-[13px] leading-none"
                    title={`Delete "${doc.title}"`}
                    aria-label={`Delete ${doc.title}`}
                  >
                    ×
                  </button>
                </div>
              ))}
              <button
                type="button"
                onClick={() => setShowNewDoc(true)}
                className="border border-on-background p-4 bg-secondary-container hover:bg-surface-container-low transition-colors min-h-[110px] flex flex-col items-center justify-center text-center cursor-pointer"
                title="Add a document to the pipeline"
              >
                <span className="material-symbols-outlined text-primary mb-2 text-[28px]">add</span>
                <span
                  className="font-bold text-xs text-on-background"
                  style={{ fontFamily: 'var(--font-label)' }}
                >
                  New Document
                </span>
              </button>
            </div>
          </div>
        </div>
      </div>
      )}

      {pendingReset ? (
        <ConfirmDialog
          title="Reset Documents"
          message="Clear all documents back to blank? This can't be undone."
          confirmLabel="Reset"
          danger
          onConfirm={confirmReset}
          onCancel={() => setPendingReset(false)}
        />
      ) : null}

      {showNewDoc ? (
        <NewDocumentModal onCreate={handleCreateDoc} onCancel={() => setShowNewDoc(false)} />
      ) : null}

      {pendingDeleteDoc ? (
        <ConfirmDialog
          title="Delete Document"
          message={`Remove "${pendingDeleteDoc.title}" from the pipeline? Its saved content will no longer be reachable.`}
          confirmLabel="Delete"
          danger
          onConfirm={confirmDeleteDoc}
          onCancel={() => setPendingDeleteDoc(null)}
        />
      ) : null}
    </div>
  )
}
