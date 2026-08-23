import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { createPortal } from 'react-dom'
import { MermaidRenderer } from './MermaidRenderer'
import { BlockEditDialog } from './BlockEditDialog'

interface DiagramFullscreenProps {
  open: boolean
  code: string
  title: string
  onClose: () => void
  onSave: (next: { code: string; title: string }) => void
}

/**
 * Full-screen Mermaid viewer with drag-to-pan, wheel zoom, and an edit path.
 */
export function DiagramFullscreen({
  open,
  code,
  title,
  onClose,
  onSave,
}: DiagramFullscreenProps) {
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const [scale, setScale] = useState(1)
  const [dragging, setDragging] = useState(false)
  const dragOrigin = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null)
  const [editing, setEditing] = useState(false)
  const [draftCode, setDraftCode] = useState(code)
  const [draftTitle, setDraftTitle] = useState(title)

  useEffect(() => {
    if (!open) return
    setOffset({ x: 0, y: 0 })
    setScale(1)
    setDraftCode(code)
    setDraftTitle(title)
    setEditing(false)
  }, [open, code, title])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !editing) onClose()
    }
    window.addEventListener('keydown', onKey)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = prev
    }
  }, [open, editing, onClose])

  const onPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (editing || e.button !== 0) return
      e.currentTarget.setPointerCapture(e.pointerId)
      dragOrigin.current = { x: e.clientX, y: e.clientY, ox: offset.x, oy: offset.y }
      setDragging(true)
    },
    [editing, offset.x, offset.y],
  )

  const onPointerMove = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    const origin = dragOrigin.current
    if (!origin) return
    setOffset({
      x: origin.ox + (e.clientX - origin.x),
      y: origin.oy + (e.clientY - origin.y),
    })
  }, [])

  const onPointerUp = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    dragOrigin.current = null
    setDragging(false)
    try {
      e.currentTarget.releasePointerCapture(e.pointerId)
    } catch {
      /* already released */
    }
  }, [])

  const onWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault()
    const delta = e.deltaY > 0 ? -0.08 : 0.08
    setScale((s) => Math.min(3, Math.max(0.35, s + delta)))
  }, [])

  if (!open) return null

  return createPortal(
    <div className="rg-diagram-fs" role="dialog" aria-modal="true" aria-label={title || 'Diagram'}>
      <header className="rg-diagram-fs-bar">
        <div className="rg-diagram-fs-meta">
          <span className="rg-block-caption-id">DIAGRAM</span>
          <span className="rg-diagram-fs-title">{title || 'Mermaid'}</span>
        </div>
        <div className="rg-diagram-fs-tools">
          <button
            type="button"
            className="rg-block-action"
            onClick={() => setScale((s) => Math.min(3, s + 0.15))}
            title="Zoom in"
          >
            Zoom +
          </button>
          <button
            type="button"
            className="rg-block-action"
            onClick={() => setScale((s) => Math.max(0.35, s - 0.15))}
            title="Zoom out"
          >
            Zoom −
          </button>
          <button
            type="button"
            className="rg-block-action"
            onClick={() => {
              setOffset({ x: 0, y: 0 })
              setScale(1)
            }}
            title="Reset view"
          >
            Reset
          </button>
          <button
            type="button"
            className="rg-block-action rg-block-action--accent"
            onClick={() => {
              setDraftCode(code)
              setDraftTitle(title)
              setEditing(true)
            }}
          >
            Edit
          </button>
          <button type="button" className="rg-block-action" onClick={onClose}>
            Close
          </button>
        </div>
      </header>

      <div
        className={`rg-diagram-fs-stage${dragging ? ' is-dragging' : ''}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onWheel={onWheel}
      >
        <div
          className="rg-diagram-fs-canvas"
          style={{
            transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})`,
          }}
        >
          <MermaidRenderer code={code} className="rg-diagram-fs-render" />
        </div>
        <p className="rg-diagram-fs-hint">Drag to move · scroll to zoom · Esc to close</p>
      </div>

      <BlockEditDialog
        open={editing}
        title="Edit diagram"
        wide
        onClose={() => setEditing(false)}
        onSave={() => {
          onSave({ code: draftCode, title: draftTitle })
          setEditing(false)
        }}
      >
        <label className="rg-edit-field">
          <span>Title</span>
          <input
            type="text"
            value={draftTitle}
            onChange={(e) => setDraftTitle(e.target.value)}
            placeholder="Diagram title"
          />
        </label>
        <label className="rg-edit-field">
          <span>Mermaid source</span>
          <textarea
            className="rg-edit-code"
            value={draftCode}
            onChange={(e) => setDraftCode(e.target.value)}
            rows={14}
            spellCheck={false}
          />
        </label>
      </BlockEditDialog>
    </div>,
    document.body,
  )
}
