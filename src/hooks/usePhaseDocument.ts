import { useCallback, useEffect, useRef, useState } from 'react'
import {
  emptyCanvasDocument,
  toCanvasDocument,
  type CanvasDocument,
  type BlockNoteBlock,
} from '../types/document'
import { getDocumentType } from '../data/documentTypes'
import { getVscodeApi } from '../utils/vscodeApi'
import { storageKeyFor, hasWorkspaceScope } from '../utils/workspaceScope'

const vscode = getVscodeApi()

function loadFromStorage(storageKey: string, legacyStorageKey?: string): CanvasDocument {
  try {
    const raw =
      localStorage.getItem(storageKey) ??
      (legacyStorageKey ? localStorage.getItem(legacyStorageKey) : null)
    if (!raw) return emptyCanvasDocument()
    return toCanvasDocument(JSON.parse(raw))
  } catch {
    return emptyCanvasDocument()
  }
}

/** Shared load/save hook for every BlockNote canvas document (built-in or custom). */
export function usePhaseDocument(
  phaseId: string,
  options?: { onReplaced?: (message: string) => void },
) {
  const { onReplaced } = options ?? {}
  const onReplacedRef = useRef(onReplaced)
  onReplacedRef.current = onReplaced
  const meta = getDocumentType(phaseId)
  if (!meta) {
    throw new Error(`Unknown document type: ${phaseId}`)
  }
  const storageKey = storageKeyFor(meta.storageKey)
  // Never fall back to unscoped legacy keys once a workspace folder is active —
  // that was the cross-project leak.
  const legacyStorageKey = !hasWorkspaceScope() ? meta.legacyStorageKey : undefined

  const [doc, setDoc] = useState<CanvasDocument>(() => loadFromStorage(storageKey, legacyStorageKey))
  const [lastSaved, setLastSaved] = useState<Date | null>(null)
  const [isDirty, setIsDirty] = useState(false)
  const [ready, setReady] = useState(!vscode)
  const [externalRevision, setExternalRevision] = useState(0)
  const [externalBlocks, setExternalBlocks] = useState<BlockNoteBlock[] | null>(null)
  const docRef = useRef(doc)
  docRef.current = doc
  // Mirror isDirty for the loadCanvas handler without re-running the effect
  // (re-running would re-post loadCanvas on every keystroke → remount loop).
  const dirtyRef = useRef(isDirty)
  dirtyRef.current = isDirty
  // False until the first loadCanvas response has been handled.
  const loadedOnceRef = useRef(false)
  // Tracks real unmounts so the debounce cleanup can flush pending edits only
  // when navigating away — not on every debounce re-arm.
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  // When navigating between phases, remount state from that phase's storage.
  useEffect(() => {
    setDoc(loadFromStorage(storageKey, legacyStorageKey))
    setIsDirty(false)
    setLastSaved(null)
    setExternalBlocks(null)
    setExternalRevision(0)
    loadedOnceRef.current = false
    setReady(!vscode)
  }, [storageKey, legacyStorageKey])

  const persist = useCallback(
    (next: CanvasDocument) => {
      localStorage.setItem(storageKey, JSON.stringify(next))
      if (vscode) {
        vscode.postMessage({ type: 'saveCanvas', phase: phaseId, data: next })
      }
      setLastSaved(new Date())
      setIsDirty(false)
    },
    [phaseId, storageKey],
  )

  useEffect(() => {
    if (!isDirty) return
    const timer = setTimeout(() => {
      persist(docRef.current)
    }, 500)
    return () => {
      clearTimeout(timer)
      // Navigate-away within the debounce window would drop the edit — flush it.
      if (!mountedRef.current) persist(docRef.current)
    }
  }, [doc, isDirty, persist])

  const setBlocks = useCallback((blocks: BlockNoteBlock[]) => {
    setDoc((prev) => ({
      version: 1,
      kind: 'blocknote',
      blocks,
      anchors: prev.anchors ?? {},
    }))
    setIsDirty(true)
  }, [])

  const applyExternalDocument = useCallback(
    (next: CanvasDocument, options?: { persistToDisk?: boolean }) => {
      const normalized = toCanvasDocument(next)
      setDoc(normalized)
      localStorage.setItem(storageKey, JSON.stringify(normalized))
      // Persist to disk when the change originates in the webview (e.g. applying a template),
      // so the extension's loadCanvas round-trip doesn't clobber it on the next open.
      if (options?.persistToDisk && vscode) {
        vscode.postMessage({ type: 'saveCanvas', phase: phaseId, data: normalized })
      }
      setExternalBlocks(normalized.blocks)
      setExternalRevision((n) => n + 1)
      setIsDirty(false)
      setLastSaved(new Date())
    },
    [storageKey, phaseId],
  )

  const saveNow = useCallback(() => {
    persist(docRef.current)
  }, [persist])

  const reset = useCallback(() => {
    const fresh = emptyCanvasDocument()
    setDoc(fresh)
    persist(fresh)
    setExternalBlocks(fresh.blocks)
    setExternalRevision((n) => n + 1)
  }, [persist])

  useEffect(() => {
    if (!vscode) return
    const handler = (event: MessageEvent) => {
      const msg = event.data
      if (msg.type === 'loadCanvas' && msg.phase === phaseId) {
        if (!loadedOnceRef.current) {
          loadedOnceRef.current = true
          // N2: the user typed before the disk read returned — keep their edits,
          // never clobber them with the (already stale) disk version.
          if (dirtyRef.current) {
            setReady(true)
            return
          }
        } else if (dirtyRef.current) {
          // N7: an external replacement (e.g. an AI draft) landed while the user
          // has unsaved edits — save those first, then apply, then tell the page.
          persist(docRef.current)
          onReplacedRef.current?.(
            'The AI draft replaced this document — your unsaved edits were saved first.',
          )
        }
        // null/empty from disk must clear the workspace-scoped cache — never keep
        // another folder's draft that happened to share a bare localStorage key.
        if (msg.data) {
          applyExternalDocument(toCanvasDocument(msg.data))
        } else {
          applyExternalDocument(emptyCanvasDocument())
        }
        setReady(true)
      }
    }
    window.addEventListener('message', handler)
    vscode.postMessage({ type: 'loadCanvas', phase: phaseId })
    return () => window.removeEventListener('message', handler)
  }, [applyExternalDocument, phaseId, persist])

  return {
    meta,
    doc,
    blocks: doc.blocks,
    setBlocks,
    applyExternalDocument,
    reset,
    saveNow,
    lastSaved,
    isDirty,
    ready,
    externalRevision,
    externalBlocks,
  }
}
