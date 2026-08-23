import { useEffect } from 'react'

interface ConfirmDialogProps {
  title: string
  message: string
  confirmLabel?: string
  cancelLabel?: string
  danger?: boolean
  onConfirm: () => void
  onCancel: () => void
}

export function ConfirmDialog({
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  danger = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  return (
    <div
      className="tut-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel()
      }}
    >
      <div className="tmpl-window tut-window">
        <div className="tmpl-titlebar">
          <span className="tmpl-titlebar-lines" aria-hidden="true" />
          <span className="tmpl-titlebar-name">{title}</span>
          <span className="tmpl-titlebar-lines" aria-hidden="true" />
        </div>

        <div className="tut-body">
          <p className="tut-desc" style={{ minHeight: 'auto' }}>
            {message}
          </p>
        </div>

        <div className="tut-foot">
          <span className="tmpl-hint" />
          <div className="tut-actions">
            <button type="button" className="tmpl-btn" onClick={onCancel}>
              {cancelLabel}
            </button>
            <button
              type="button"
              className={`tmpl-btn${danger ? ' tmpl-btn--danger' : ' tmpl-btn--primary'}`}
              onClick={onConfirm}
            >
              {confirmLabel}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
