import { useEffect, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

interface BlockEditDialogProps {
  open: boolean
  title: string
  onClose: () => void
  onSave: () => void
  children: ReactNode
  saveLabel?: string
  wide?: boolean
}

/** Lightweight modal for editing custom block props. */
export function BlockEditDialog({
  open,
  title,
  onClose,
  onSave,
  children,
  saveLabel = 'Save',
  wide = false,
}: BlockEditDialogProps) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  return createPortal(
    <div
      className="rg-edit-overlay"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        className={`rg-edit-dialog${wide ? ' rg-edit-dialog--wide' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="rg-edit-dialog-header">
          <h2 className="rg-edit-dialog-title">{title}</h2>
          <button type="button" className="rg-edit-dialog-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>
        <div className="rg-edit-dialog-body">{children}</div>
        <footer className="rg-edit-dialog-footer">
          <button type="button" className="rg-btn rg-btn--ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="rg-btn rg-btn--primary" onClick={onSave}>
            {saveLabel}
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  )
}
