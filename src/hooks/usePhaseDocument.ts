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

function hasPendingSaveForVersion(pending: Map<number, number>, editVersion: number) {
  for (const version of pending.values()) {
    if (version === editVersion) return true
  }
  return false
}

/** Shared load/save hook for every BlockNote canvas document (built-in or custom). */
export function usePhaseDocument(
  phaseId: string,
  options?: { onReplaced?: (message: string) => void },
) {
  const { onReplaced } = options ?? {}
  const onReplacedRef = useRef(onReplaced)
  useEffect(() => {
    onReplacedRef.current = onReplaced
  }, [onReplaced])
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
  // Plan §16.2: last-known host revision — every save carries it as
  // baseRevision so the extension can refuse to overwrite concurrent writes.
  const revisionRef = useRef(0)
  const saveSeqRef = useRef(0)
  const editVersionRef = useRef(0)
  const pendingSaveVersionsRef = useRef(new Map<number, number>())
  const saveBlockedRef = useRef(false)
  const docRef = useRef(doc)
  // Mirror isDirty for the loadCanvas handler without re-running the effect
  // (re-running would re-post loadCanvas on every keystroke → remount loop).
  const dirtyRef = useRef(isDirty)
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

  const persist = useCallback(
    (next: CanvasDocument, force = false) => {
      localStorage.setItem(storageKey, JSON.stringify(next))
      if (vscode) {
        if (saveBlockedRef.current && !force) return
        if (
          hasPendingSaveForVersion(
            pendingSaveVersionsRef.current,
            editVersionRef.current,
          )
        ) {
          return
        }
        const seq = ++saveSeqRef.current
        const base = revisionRef.current
        pendingSaveVersionsRef.current.set(seq, editVersionRef.current)
        vscode.postMessage({ type: 'saveCanvas', phase: phaseId, data: next, baseRevision: base, seq })
      } else {
        setLastSaved(new Date())
        setIsDirty(false)
      }
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
    editVersionRef.current += 1
    const next: CanvasDocument = {
      version: 1,
      kind: 'blocknote',
      blocks,
      anchors: docRef.current.anchors ?? {},
    }
    docRef.current = next
    dirtyRef.current = true
    setDoc(next)
    setIsDirty(true)
  }, [])

  const applyExternalDocument = useCallback(
    (next: CanvasDocument, options?: { persistToDisk?: boolean }) => {
      const normalized = toCanvasDocument(next)
      editVersionRef.current += 1
      docRef.current = normalized
      setDoc(normalized)
      localStorage.setItem(storageKey, JSON.stringify(normalized))
      // Persist to disk when the change originates in the webview (e.g. applying a template),
      // so the extension's loadCanvas round-trip doesn't clobber it on the next open.
      if (options?.persistToDisk) {
        dirtyRef.current = true
        setIsDirty(true)
        saveBlockedRef.current = false
        persist(normalized, true)
      } else {
        dirtyRef.current = false
        setIsDirty(false)
        setLastSaved(new Date())
      }
      setExternalBlocks(normalized.blocks)
      setExternalRevision((n) => n + 1)
    },
    [persist, storageKey],
  )

  const saveNow = useCallback(() => {
    saveBlockedRef.current = false
    persist(docRef.current, true)
  }, [persist])

  const reset = useCallback(() => {
    const fresh = emptyCanvasDocument()
    editVersionRef.current += 1
    docRef.current = fresh
    dirtyRef.current = true
    setDoc(fresh)
    setIsDirty(true)
    saveBlockedRef.current = false
    persist(fresh, true)
    setExternalBlocks(fresh.blocks)
    setExternalRevision((n) => n + 1)
  }, [persist])

  useEffect(() => {
    if (!vscode) return
    const handler = (event: MessageEvent) => {
      const msg = event.data
      if (msg.type === 'loadCanvas' && msg.phase === phaseId) {
        if (typeof msg.revision === 'number') {
          revisionRef.current = msg.revision
        }
        if (!loadedOnceRef.current) {
          loadedOnceRef.current = true
          // N2: the user typed before the disk read returned — keep their edits,
          // never clobber them with the (already stale) disk version.
          if (dirtyRef.current) {
            setReady(true)
            return
          }
        } else if (dirtyRef.current) {
          // N7: preserve both sides of a conflict. Keep the user's local
          // document visible and dirty, but require an explicit Save Draft
          // before overwriting the newer host revision.
          saveBlockedRef.current = true
          onReplacedRef.current?.(
            'The document was updated externally — your unsaved edits were kept. Review them, then choose Save Draft to overwrite the external version.',
          )
          setReady(true)
          return
        }
        // null/empty from disk must clear the workspace-scoped cache — never keep
        // another folder's draft that happened to share a bare localStorage key.
        if (msg.data) {
          applyExternalDocument(toCanvasDocument(msg.data))
        } else {
          applyExternalDocument(emptyCanvasDocument())
        }
        setReady(true)
      } else if (msg.type === 'saveCanvasAck' && msg.phase === phaseId) {
        if (typeof msg.seq !== 'number') return
        const savedEditVersion = pendingSaveVersionsRef.current.get(msg.seq)
        if (savedEditVersion === undefined) return
        pendingSaveVersionsRef.current.delete(msg.seq)
        revisionRef.current = Math.max(revisionRef.current, msg.revision)
        if (savedEditVersion === editVersionRef.current) {
          saveBlockedRef.current = false
          dirtyRef.current = false
          setLastSaved(new Date())
          setIsDirty(false)
        }
      } else if (msg.type === 'saveCanvasConflict' && msg.phase === phaseId) {
        if (typeof msg.seq !== 'number') return
        const conflictedEditVersion = pendingSaveVersionsRef.current.get(msg.seq)
        if (conflictedEditVersion === undefined) return
        pendingSaveVersionsRef.current.delete(msg.seq)
        revisionRef.current = Math.max(revisionRef.current, msg.currentRevision)
        if (conflictedEditVersion === editVersionRef.current) {
          saveBlockedRef.current = true
          dirtyRef.current = true
          setIsDirty(true)
          onReplacedRef.current?.(
            'Save conflict: the document changed externally. Your edits remain local; review them, then choose Save Draft to overwrite the newer version.',
          )
        }
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
