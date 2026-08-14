import { useEffect, useMemo, useRef, useState } from 'react'
import {
  useCreateBlockNote,
  SuggestionMenuController,
  getDefaultReactSlashMenuItems,
} from '@blocknote/react'
import { BlockNoteView } from '@blocknote/mantine'
import { BlockNoteEditor, type Block, type PartialBlock } from '@blocknote/core'
import '@blocknote/core/fonts/inter.css'
import '@blocknote/mantine/style.css'
import type { BlockNoteBlock } from '../../types/document'
import {
  canvasSchema,
  filterSuggestionItems,
  getCanvasSlashMenuItems,
  getAiSlashMenuItem,
  insertAiChatBlock,
  type CanvasEditor,
} from './schema'
import { sanitizeCanvasBlocks } from './sanitizeBlocks'
import {
  blockText,
  captureAiChatContext,
  type BlockLike,
  type CapturedSelection,
} from './aiChatCore'

interface DocumentCanvasProps {
  initialBlocks: BlockNoteBlock[]
  onChange: (blocks: BlockNoteBlock[]) => void
  externalRevision: number
  externalBlocks: BlockNoteBlock[] | null
  /** Remount key when the boundary resets the document. */
  editorKey?: string | number
  /** Expose the live editor for the tools sidebar. */
  onEditorReady?: (editor: CanvasEditor | null) => void
}

const EMPTY_CONTENT: PartialBlock[] = [{ type: 'paragraph', content: '' }]

function canCreateDocument(content: PartialBlock[]): boolean {
  try {
    const editor = BlockNoteEditor.create({ schema: canvasSchema, initialContent: content })
    try {
      editor._tiptapEditor?.destroy?.()
    } catch {
      /* ignore teardown */
    }
    return true
  } catch {
    return false
  }
}

/** Drop blocks that still crash BlockNote after sanitize (keeps the rest of the doc). */
function safeInitialContent(blocks: BlockNoteBlock[]): PartialBlock[] {
  const sanitized = sanitizeCanvasBlocks(blocks)
  if (canCreateDocument(sanitized)) return sanitized

  console.error('[DocumentCanvas] sanitized initialContent rejected; filtering blocks')

  const kept: PartialBlock[] = []
  for (const block of sanitized) {
    const candidate = [...kept, block]
    if (canCreateDocument(candidate.length > 0 ? candidate : EMPTY_CONTENT)) {
      kept.push(block)
      continue
    }
    const label = typeof block.type === 'string' ? block.type : 'block'
    const stub: PartialBlock = { type: 'paragraph', content: `[Skipped invalid ${label}]` }
    if (canCreateDocument([...kept, stub])) {
      kept.push(stub)
    }
  }

  return kept.length > 0 ? kept : EMPTY_CONTENT
}

function DocumentCanvasInner({
  initialBlocks,
  onChange,
  externalRevision,
  externalBlocks,
  onEditorReady,
}: DocumentCanvasProps) {
  const applyingExternal = useRef(false)
  const lastExternalRevision = useRef(0)
  const hostRef = useRef<HTMLDivElement | null>(null)
  // Last non-collapsed selection, for the "rewrite what I selected" heuristic.
  const lastSelectionRef = useRef<CapturedSelection | null>(null)
  // Floating "Ask AI" blip anchored above the current DOM selection.
  const [blip, setBlip] = useState<{ top: number; left: number; blockIds: string[] } | null>(null)

  const initialContent = useMemo(() => {
    const base = safeInitialContent(initialBlocks)
    if (base.length === 0) return EMPTY_CONTENT
    // Truly blank document: seed a self-contained "Ask AI" block (post-sanitize,
    // so it is never mistaken for persisted content).
    if (base.every((b) => !blockText(b as unknown as BlockLike).trim())) {
      return [
        {
          type: 'aiChat',
          props: {
            placeholder: 'What would you like to create?',
            contextJson: JSON.stringify(captureAiChatContext([], { selection: null })),
          },
        },
        ...base,
      ]
    }
    return base
    // Only for first mount — editor owns content after that.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const editor = useCreateBlockNote({
    schema: canvasSchema,
    initialContent,
    placeholders: {
      default: "Type '/' for Scope, KPIs, Diagram…",
      heading: 'Heading',
    },
  })

  useEffect(() => {
    onEditorReady?.(editor as CanvasEditor)
    return () => onEditorReady?.(null)
  }, [editor, onEditorReady])

  // Track the last non-collapsed selection so /Ask AI can target "this".
  useEffect(() => {
    const unsubscribe = editor.onSelectionChange(() => {
      const sel = editor.getSelection()
      const blocks = sel?.blocks
      if (!blocks?.length) {
        lastSelectionRef.current = null
        setBlip(null)
        return
      }
      const ids = blocks.map((b) => String(b.id))
      lastSelectionRef.current = { blockIds: ids, capturedAt: Date.now() }

      // Blip only over a visible non-collapsed DOM selection outside chat blocks.
      if (document.activeElement?.closest('.rg-ai-chat')) {
        setBlip(null)
        return
      }
      const domSel = window.getSelection()
      if (!domSel || domSel.isCollapsed || domSel.rangeCount === 0) {
        setBlip(null)
        return
      }
      const rect = domSel.getRangeAt(0).getBoundingClientRect()
      if (rect.width === 0 && rect.height === 0) {
        setBlip(null)
        return
      }
      // Host-relative coords, so the blip survives any ancestor transforms.
      const hostRect = hostRef.current?.getBoundingClientRect()
      setBlip({
        top: rect.top - (hostRect?.top ?? 0),
        left: rect.left - (hostRect?.left ?? 0),
        blockIds: ids,
      })
    })
    return () => unsubscribe?.()
  }, [editor])

  // A scrolled selection is stale — hide the blip; it reappears on next selection.
  useEffect(() => {
    const hide = () => setBlip(null)
    window.addEventListener('scroll', hide, true)
    window.addEventListener('resize', hide)
    return () => {
      window.removeEventListener('scroll', hide, true)
      window.removeEventListener('resize', hide)
    }
  }, [])

  useEffect(() => {
    if (!externalBlocks || externalRevision === lastExternalRevision.current) return
    lastExternalRevision.current = externalRevision
    applyingExternal.current = true
    try {
      const next = safeInitialContent(externalBlocks)
      editor.replaceBlocks(editor.document, next)
    } catch (err) {
      console.error('[DocumentCanvas] replaceBlocks failed', err)
      try {
        editor.replaceBlocks(editor.document, EMPTY_CONTENT)
      } catch {
        /* ignore secondary failure — ErrorBoundary will catch render issues */
      }
    } finally {
      queueMicrotask(() => {
        applyingExternal.current = false
      })
    }
  }, [editor, externalBlocks, externalRevision])

  return (
    <div className="bn-canvas-host" ref={hostRef}>
      {blip ? (
        <button
          type="button"
          className="rg-ai-blip"
          style={{
            top: Math.max(6, blip.top - 6),
            left: Math.max(4, blip.left),
          }}
          // Keep the editor selection alive while the blip is clicked.
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            insertAiChatBlock(editor as CanvasEditor, {
              blockIds: blip.blockIds,
              capturedAt: Date.now(),
            })
            setBlip(null)
          }}
        >
          <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden focusable="false">
            <path
              fill="currentColor"
              d="M8 .75a.5.5 0 0 1 .46.31l1.45 3.31 3.31 1.45a.5.5 0 0 1 0 .92l-3.31 1.45-1.45 3.31a.5.5 0 0 1-.92 0L6.09 8.19 2.78 6.74a.5.5 0 0 1 0-.92l3.31-1.45L7.54 1.06A.5.5 0 0 1 8 .75Zm6.5 9.5a.5.5 0 0 1 .46.31l.72 1.65 1.65.72a.5.5 0 0 1 0 .92l-1.65.72-.72 1.65a.5.5 0 0 1-.92 0l-.72-1.65-1.65-.72a.5.5 0 0 1 0-.92l1.65-.72.72-1.65a.5.5 0 0 1 .46-.31Z"
            />
          </svg>
          Ask AI
        </button>
      ) : null}
      <BlockNoteView
        editor={editor}
        theme="light"
        slashMenu={false}
        onChange={() => {
          if (applyingExternal.current) return
          // aiChat blocks are ephemeral UI — never persist/save/export them.
          const persisted = editor.document.filter((b) => b.type !== 'aiChat')
          onChange(persisted as unknown as BlockNoteBlock[])
        }}
      >
        <SuggestionMenuController
          triggerCharacter="/"
          getItems={async (query) =>
            filterSuggestionItems(
              [
                getAiSlashMenuItem(editor as CanvasEditor, () => lastSelectionRef.current),
                ...getDefaultReactSlashMenuItems(editor),
                ...getCanvasSlashMenuItems(editor as CanvasEditor),
              ],
              query,
            )
          }
        />
      </BlockNoteView>
    </div>
  )
}

export function DocumentCanvas(props: DocumentCanvasProps) {
  return <DocumentCanvasInner key={props.editorKey ?? 'canvas'} {...props} />
}

export type { Block, CanvasEditor }
