import { useMemo } from 'react'
import { templateOutline, type CharterTemplate } from '../../data/docTemplates'

interface TemplateGalleryProps {
  documentLabel: string
  /** The template currently being previewed. */
  template: CharterTemplate
  /** The template already applied to the document, if any. */
  currentTemplateId?: string
  /** True when the document already has content (applying will replace it). */
  hasExistingContent: boolean
  onApply: (template: CharterTemplate) => void
  onCancel: () => void
}

export function TemplateGallery({
  documentLabel,
  template,
  currentTemplateId,
  hasExistingContent,
  onApply,
  onCancel,
}: TemplateGalleryProps) {
  const outline = useMemo(
    () => (template.custom ? [] : templateOutline(template)),
    [template],
  )

  const isCurrent = template.id === currentTemplateId
  const willReplace = hasExistingContent && !isCurrent
  const applyLabel = template.custom
    ? 'Start from scratch'
    : isCurrent
      ? 'Re-apply template'
      : willReplace
        ? 'Replace with this template'
        : 'Use this template'

  return (
    <div className="tmpl-gallery">
      <div className="tmpl-window">
        <div className="tmpl-titlebar">
          <span className="tmpl-titlebar-lines" aria-hidden="true" />
          <span className="tmpl-titlebar-name">{template.name}</span>
          <span className="tmpl-titlebar-lines" aria-hidden="true" />
        </div>

        <div className="tmpl-window-body">
          <p className="tmpl-kicker">{documentLabel} · Starting point</p>
          <div className="tmpl-heading-row">
            <h2 className="tmpl-name">{template.name}</h2>
            <span className="tmpl-badge">{template.category}</span>
            {isCurrent ? <span className="tmpl-badge tmpl-badge--applied">Applied</span> : null}
          </div>

          <p className="tmpl-desc">{template.description}</p>

          {template.custom ? (
            <div className="tmpl-blank">
              <p className="tmpl-section-title">Blank canvas</p>
              <p className="tmpl-blank-hint">
                Start with an empty page and build it your way. Add sections and shapes from the
                Insert tab or by typing <kbd>/</kbd> anywhere on the page.
              </p>
            </div>
          ) : (
            <div className="tmpl-inside">
              <p className="tmpl-section-title">What's inside</p>
              <ol className="tmpl-outline">
                {outline.map((line, i) => (
                  <li key={i} className="tmpl-outline-item">
                    <span className="tmpl-outline-num">{String(i + 1).padStart(2, '0')}</span>
                    <span className="tmpl-outline-text">{line}</span>
                  </li>
                ))}
              </ol>
            </div>
          )}
        </div>

        <div className="tmpl-actionbar">
          {willReplace ? (
            <p className="tmpl-warn">Applying replaces the current document content.</p>
          ) : (
            <span className="tmpl-hint">Preview another template from the sidebar list.</span>
          )}
          <div className="tmpl-actions">
            <button type="button" className="tmpl-btn" onClick={onCancel}>
              Back to canvas
            </button>
            <button type="button" className="tmpl-btn tmpl-btn--primary" onClick={() => onApply(template)}>
              {applyLabel}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
