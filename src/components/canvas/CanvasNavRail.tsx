import { useEffect, useMemo, useState, type RefObject } from 'react'
import type { BlockNoteBlock } from '../../types/document'
import { buildCanvasOutline, outlineTypeBadge } from './canvasOutline'
import { focusCanvasBlock, type CanvasEditor } from './canvasInsert'

interface CanvasNavRailProps {
  editor: CanvasEditor | null
  blocks: BlockNoteBlock[]
  /** The scrollable canvas column. */
  scrollRef: RefObject<HTMLElement | null>
}

function findBlockEl(id: string): HTMLElement | null {
  return (
    (document.querySelector(`.bn-canvas-host [data-id="${CSS.escape(id)}"]`) as HTMLElement | null) ??
    (document.querySelector(`[data-id="${CSS.escape(id)}"]`) as HTMLElement | null)
  )
}

/**
 * Jump-to-section nav rail.
 * Collapsed = slim evenly-spaced dots. Expanded = readable stacked list (no overlap).
 */
export function CanvasNavRail({ editor, blocks, scrollRef }: CanvasNavRailProps) {
  const outlineSource = useMemo(() => {
    if (editor?.document?.length) {
      return editor.document as unknown as BlockNoteBlock[]
    }
    return blocks
  }, [editor, blocks])

  const entries = useMemo(() => {
    // Headings only — shapes + every H3 on arc42-style docs made the rail unreadable.
    return buildCanvasOutline(outlineSource).filter((e) => e.kind === 'heading')
  }, [outlineSource])

  const [activeId, setActiveId] = useState<string | null>(null)
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const [expanded, setExpanded] = useState(false)

  // Track which heading is in view.
  useEffect(() => {
    if (entries.length === 0) {
      setActiveId(null)
      return
    }
    const scroller = scrollRef.current
    const els = entries
      .map((e) => findBlockEl(e.id))
      .filter((el): el is HTMLElement => Boolean(el))
    if (els.length === 0) return

    const observer = new IntersectionObserver(
      (observed) => {
        const visible = observed
          .filter((o) => o.isIntersecting)
          .sort(
            (a, b) =>
              b.intersectionRatio - a.intersectionRatio ||
              a.boundingClientRect.top - b.boundingClientRect.top,
          )
        if (visible[0]?.target instanceof HTMLElement) {
          const id = visible[0].target.getAttribute('data-id')
          if (id) setActiveId(id)
        }
      },
      {
        root: scroller,
        rootMargin: '-10% 0px -60% 0px',
        threshold: [0, 0.2, 0.5, 1],
      },
    )
    els.forEach((el) => observer.observe(el))
    return () => observer.disconnect()
  }, [entries, scrollRef, editor])

  // Keep the active row visible in the expanded list.
  useEffect(() => {
    if (!expanded || !activeId) return
    const el = document.querySelector(
      `.canvas-nav-rib[data-nav-id="${CSS.escape(activeId)}"]`,
    ) as HTMLElement | null
    el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [activeId, expanded])

  const jumpTo = (id: string) => {
    if (editor) focusCanvasBlock(editor, id)
    else findBlockEl(id)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }

  if (entries.length === 0) return null

  const preview = hoveredId ? entries.find((e) => e.id === hoveredId) : null
  const hoverIndex = hoveredId ? entries.findIndex((e) => e.id === hoveredId) : -1
  const previewTop =
    hoverIndex >= 0 && entries.length > 1
      ? (hoverIndex / (entries.length - 1)) * 100
      : hoverIndex === 0
        ? 0
        : 50

  return (
    <aside
      className={`canvas-nav-rail${expanded ? ' is-expanded' : ''}`}
      aria-label="Jump to section"
      onMouseEnter={() => setExpanded(true)}
      onMouseLeave={() => {
        setExpanded(false)
        setHoveredId(null)
      }}
      onFocus={() => setExpanded(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) {
          setExpanded(false)
          setHoveredId(null)
        }
      }}
    >
      <div className="canvas-nav-rail-track" role="navigation">
        {entries.map((entry, index) => {
          const active = entry.id === activeId
          const hovered = entry.id === hoveredId
          // Even spacing when collapsed so dots never stack on top of each other.
          const topPct =
            entries.length === 1 ? 50 : (index / (entries.length - 1)) * 100

          return (
            <button
              key={entry.id}
              type="button"
              data-nav-id={entry.id}
              className={`canvas-nav-rib${active ? ' is-active' : ''}${hovered ? ' is-hovered' : ''}`}
              style={expanded ? undefined : { top: `${topPct}%` }}
              aria-label={`Jump to ${entry.label}`}
              aria-current={active ? 'true' : undefined}
              title={entry.label}
              onMouseEnter={() => setHoveredId(entry.id)}
              onFocus={() => setHoveredId(entry.id)}
              onClick={() => jumpTo(entry.id)}
            >
              <span className="canvas-nav-rib-dot" />
              <span className="canvas-nav-rib-label">
                <span className="canvas-nav-rib-badge">{outlineTypeBadge(entry.type)}</span>
                <span className="canvas-nav-rib-text">{entry.label}</span>
              </span>
            </button>
          )
        })}
      </div>

      {!expanded && preview ? (
        <div className="canvas-nav-preview" role="tooltip" style={{ top: `${previewTop}%` }}>
          <span className="canvas-nav-preview-badge">{outlineTypeBadge(preview.type)}</span>
          <span className="canvas-nav-preview-text">{preview.label}</span>
        </div>
      ) : null}
    </aside>
  )
}
