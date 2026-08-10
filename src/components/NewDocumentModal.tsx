import { useEffect, useState } from 'react'
import { CUSTOM_DOC_ICONS } from '../data/documentTypes'

interface NewDocumentModalProps {
  onCreate: (name: string, icon: string) => void
  onCancel: () => void
}

export function NewDocumentModal({ onCreate, onCancel }: NewDocumentModalProps) {
  const [name, setName] = useState('')
  const [icon, setIcon] = useState(CUSTOM_DOC_ICONS[0])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  const submit = () => {
    if (!name.trim()) return
    onCreate(name.trim(), icon)
  }

  return (
    <div
      className="tut-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="New document"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel()
      }}
    >
      <div className="tmpl-window tut-window">
        <div className="tmpl-titlebar">
          <span className="tmpl-titlebar-lines" aria-hidden="true" />
          <span className="tmpl-titlebar-name">New Document</span>
          <span className="tmpl-titlebar-lines" aria-hidden="true" />
        </div>

        <div className="tut-body">
          <p className="tut-desc" style={{ minHeight: 'auto' }}>
            Add a custom document to this pipeline. It gets its own canvas, AI chat, and templates.
          </p>

          <label className="newdoc-label" htmlFor="newdoc-name">
            Document name
          </label>
          <input
            id="newdoc-name"
            className="newdoc-input"
            type="text"
            value={name}
            autoFocus
            placeholder="e.g. Meeting Notes, RFC, Launch Plan"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit()
            }}
          />

          <p className="newdoc-label">Icon</p>
          <div className="newdoc-icons" role="listbox" aria-label="Icon">
            {CUSTOM_DOC_ICONS.map((sym) => (
              <button
                key={sym}
                type="button"
                role="option"
                aria-selected={icon === sym}
                className={`newdoc-icon${icon === sym ? ' is-active' : ''}`}
                onClick={() => setIcon(sym)}
              >
                <span className="material-symbols-outlined">{sym}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="tut-foot">
          <span className="tmpl-hint" />
          <div className="tut-actions">
            <button type="button" className="tmpl-btn" onClick={onCancel}>
              Cancel
            </button>
            <button
              type="button"
              className="tmpl-btn tmpl-btn--primary"
              onClick={submit}
              disabled={!name.trim()}
            >
              Create document
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
