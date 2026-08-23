import { useEffect, useRef, useState } from 'react'
import type { View } from '../../hooks/useViewState'
import {
  listPipelineDocumentTypes,
  renameDocType,
} from '../../data/documentTypes'
import { BrandMark } from '../BrandMark'

interface PipelineHeaderProps {
  onHome: () => void
  onExport: () => void
  onSave: () => void
  saveLabel?: string
  /** Current phase — highlights the active tab. */
  currentPhaseId?: string
  /** Jump between phases from the header strip. */
  onNavigate?: (view: View) => void
  /** Fired after a document is renamed (so the page masthead can refresh). */
  onDocRenamed?: (id: string, name: string) => void
}

export function PipelineHeader({
  onHome,
  onExport,
  onSave,
  saveLabel = 'Save Draft',
  currentPhaseId,
  onNavigate,
  onDocRenamed,
}: PipelineHeaderProps) {
  const [listRev, setListRev] = useState(0)
  const phases = listPipelineDocumentTypes()
  void listRev

  const [editingId, setEditingId] = useState<string | null>(null)
  const [draftName, setDraftName] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!editingId) return
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [editingId])

  // Leave rename mode when switching documents.
  useEffect(() => {
    setEditingId(null)
    setDraftName('')
  }, [currentPhaseId])

  const beginRename = (id: string, currentTitle: string) => {
    setEditingId(id)
    setDraftName(currentTitle)
  }

  const commitRename = () => {
    if (!editingId) return
    const id = editingId
    const next = draftName.trim()
    setEditingId(null)
    if (!next) return
    const current = listPipelineDocumentTypes().find((p) => p.id === id)
    if (!current || current.title === next) return
    renameDocType(id, next)
    setListRev((n) => n + 1)
    onDocRenamed?.(id, next)
  }

  const cancelRename = () => {
    setEditingId(null)
    setDraftName('')
  }

  return (
    <header className="sticky top-0 w-full z-50 flex flex-col border-b-2 border-on-background bg-secondary-container">
      <div className="flex justify-between items-center px-6 py-2">
        <button
          type="button"
          onClick={onHome}
          className="hover:opacity-80 transition-opacity"
          aria-label="Home"
        >
          <BrandMark size="sm" />
        </button>
        <div className="flex gap-4">
          <button
            type="button"
            onClick={onExport}
            className="outset-button border-2 border-on-background bg-white text-primary font-bold px-4 py-1 text-xs"
            style={{ fontFamily: 'var(--font-label)' }}
          >
            Export
          </button>
          <button
            type="button"
            onClick={onSave}
            className="outset-button border-2 border-on-background bg-secondary-container text-on-background px-4 py-1 text-xs font-bold"
            style={{ fontFamily: 'var(--font-label)' }}
          >
            {saveLabel}
          </button>
        </div>
      </div>
      <nav className="flex w-full overflow-x-auto" aria-label="Pipeline documents">
        {phases.map((phase) => {
          const active = phase.id === currentPhaseId
          const editing = editingId === phase.id
          const className = [
            'pipeline-doc-tab flex-1 min-w-[160px] px-3 py-2 flex items-center gap-2 border-r border-on-background transition-colors text-left',
            active
              ? 'bg-white text-on-background'
              : 'bg-secondary-container text-on-background hover:bg-surface-container-low',
          ].join(' ')

          if (editing) {
            return (
              <div key={phase.id} className={className}>
                <input
                  ref={inputRef}
                  type="text"
                  className="pipeline-doc-tab-input"
                  value={draftName}
                  aria-label="Document name"
                  onChange={(e) => setDraftName(e.target.value)}
                  onBlur={commitRename}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      commitRename()
                    } else if (e.key === 'Escape') {
                      e.preventDefault()
                      cancelRename()
                    }
                  }}
                />
                <span className="material-symbols-outlined text-[16px] shrink-0" aria-hidden>
                  radio_button_checked
                </span>
              </div>
            )
          }

          return (
            <div key={phase.id} className={className}>
              <button
                type="button"
                className={[
                  'pipeline-doc-tab-label flex-1 min-w-0 text-left truncate text-xs font-bold',
                  active ? 'pipeline-doc-tab-label--editable cursor-text' : 'cursor-pointer',
                ].join(' ')}
                style={{ fontFamily: 'var(--font-label)' }}
                onClick={() => {
                  if (active) {
                    beginRename(phase.id, phase.title)
                    return
                  }
                  onNavigate?.({ page: phase.id })
                }}
                title={active ? 'Click to rename' : `Open ${phase.title}`}
              >
                {phase.title}
              </button>
              <span className="material-symbols-outlined text-[16px] shrink-0" aria-hidden>
                {active ? 'radio_button_checked' : 'radio_button_unchecked'}
              </span>
            </div>
          )
        })}
      </nav>
    </header>
  )
}
