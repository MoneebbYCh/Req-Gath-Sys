import { useState } from 'react'
import { createReactBlockSpec } from '@blocknote/react'
import { BlockActions, deleteCanvasBlock } from '../BlockActions'
import { BlockEditDialog } from '../BlockEditDialog'

const VARIANT_META: Record<string, { label: string; tone: string }> = {
  info: { label: 'NOTE', tone: 'neutral' },
  warn: { label: 'CAUTION', tone: 'caution' },
  success: { label: 'CONFIRMED', tone: 'positive' },
  error: { label: 'CRITICAL', tone: 'critical' },
}

function CalloutView(props: {
  block: { props: Record<string, unknown> }
  editor: {
    updateBlock: (block: unknown, update: unknown) => void
    removeBlocks: (blocks: unknown[]) => void
  }
  contentRef: (node: HTMLElement | null) => void
}) {
  const variant = String(props.block.props.variant || 'info')
  const meta = VARIANT_META[variant] ?? VARIANT_META.info
  const title = String(props.block.props.title || '')
  const anchorId = String(props.block.props.anchorId || '')

  const [editing, setEditing] = useState(false)
  const [draftTitle, setDraftTitle] = useState(title)
  const [draftVariant, setDraftVariant] = useState(variant)
  const [draftAnchor, setDraftAnchor] = useState(anchorId)

  const openEdit = () => {
    setDraftTitle(title)
    setDraftVariant(variant)
    setDraftAnchor(anchorId)
    setEditing(true)
  }

  return (
    <aside className={`rg-callout rg-callout--${meta.tone}`} data-anchor={anchorId || undefined}>
      <div className="rg-callout-rail" aria-hidden />
      <div className="rg-callout-content">
        <div className="rg-callout-meta">
          <span className="rg-callout-label">{meta.label}</span>
          {title ? <span className="rg-callout-title">{title}</span> : null}
          {anchorId ? <span className="rg-anchor-id">{anchorId}</span> : null}
          <BlockActions
            actions={[
              { label: 'Edit', onClick: openEdit },
              {
                label: 'Delete',
                tone: 'danger',
                onClick: () => deleteCanvasBlock(props.editor, props.block),
              },
            ]}
          />
        </div>
        <div className="rg-callout-body" ref={props.contentRef} />
      </div>

      <BlockEditDialog
        open={editing}
        title="Edit callout"
        onClose={() => setEditing(false)}
        onSave={() => {
          props.editor.updateBlock(props.block, {
            props: {
              title: draftTitle,
              variant: draftVariant,
              anchorId: draftAnchor.trim(),
            },
          })
          setEditing(false)
        }}
      >
        <label className="rg-edit-field">
          <span>Variant</span>
          <select value={draftVariant} onChange={(e) => setDraftVariant(e.target.value)}>
            <option value="info">Note</option>
            <option value="warn">Caution</option>
            <option value="success">Confirmed</option>
            <option value="error">Critical</option>
          </select>
        </label>
        <label className="rg-edit-field">
          <span>Title</span>
          <input
            type="text"
            value={draftTitle}
            onChange={(e) => setDraftTitle(e.target.value)}
            placeholder="Optional title"
          />
        </label>
        <label className="rg-edit-field">
          <span>Anchor id (optional)</span>
          <input
            type="text"
            value={draftAnchor}
            onChange={(e) => setDraftAnchor(e.target.value)}
            placeholder="stable-id"
          />
        </label>
        <p className="rg-edit-hint">Body text is edited inline in the document.</p>
      </BlockEditDialog>
    </aside>
  )
}

export const createCallout = createReactBlockSpec(
  {
    type: 'callout',
    propSchema: {
      variant: {
        default: 'info',
        values: ['info', 'warn', 'success', 'error'] as const,
      },
      title: {
        default: '',
      },
      anchorId: {
        default: '',
      },
    },
    content: 'inline',
  },
  {
    render: (props) => (
      <CalloutView block={props.block} editor={props.editor as never} contentRef={props.contentRef} />
    ),
  },
)
