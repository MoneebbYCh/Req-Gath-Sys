import { useState } from 'react'
import { createReactBlockSpec } from '@blocknote/react'
import { BlockActions, deleteCanvasBlock } from '../BlockActions'
import { BlockEditDialog } from '../BlockEditDialog'
import { parseKpiItems, type KpiItem } from '../blockParsers'

export type { KpiItem }
export { parseKpiItems }

const EMPTY_ITEM: KpiItem = { metric: '', target: '', method: '' }

function KpiGridView(props: {
  block: { props: Record<string, unknown> }
  editor: {
    updateBlock: (block: unknown, update: unknown) => void
    removeBlocks: (blocks: unknown[]) => void
  }
}) {
  const items = parseKpiItems(String(props.block.props.itemsJson || '[]'))
  const shown = items.length > 0 ? items : [{ metric: 'Metric', target: '—', method: '—' }]
  const anchorId = String(props.block.props.anchorId || '')

  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState<KpiItem[]>(items)
  const [draftAnchor, setDraftAnchor] = useState(anchorId)

  const openEdit = () => {
    setDraft(items.length > 0 ? items.map((i) => ({ ...i })) : [{ ...EMPTY_ITEM }])
    setDraftAnchor(anchorId)
    setEditing(true)
  }

  const updateItem = (index: number, patch: Partial<KpiItem>) => {
    setDraft((prev) => prev.map((item, i) => (i === index ? { ...item, ...patch } : item)))
  }

  return (
    <div className="rg-kpi" contentEditable={false} data-anchor={anchorId || undefined}>
      <div className="rg-block-caption">
        <span className="rg-block-caption-id">OBJECTIVES</span>
        <span className="rg-block-caption-title">Measurable success criteria</span>
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
      <table className="rg-kpi-table">
        <thead>
          <tr>
            <th scope="col">Objective</th>
            <th scope="col">Target</th>
            <th scope="col">Measurement</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((item, i) => (
            <tr key={`${item.metric}-${i}`}>
              <td className="rg-kpi-metric">{item.metric || '—'}</td>
              <td className="rg-kpi-target">{item.target || '—'}</td>
              <td className="rg-kpi-method">{item.method || '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <BlockEditDialog
        open={editing}
        title="Edit objectives"
        wide
        onClose={() => setEditing(false)}
        onSave={() => {
          props.editor.updateBlock(props.block, {
            props: {
              itemsJson: JSON.stringify(draft),
              anchorId: draftAnchor.trim(),
            },
          })
          setEditing(false)
        }}
      >
        <label className="rg-edit-field">
          <span>Anchor id (optional)</span>
          <input
            type="text"
            value={draftAnchor}
            onChange={(e) => setDraftAnchor(e.target.value)}
            placeholder="obj-…"
          />
        </label>
        <div className="rg-edit-rows">
          {draft.map((item, i) => (
            <div key={i} className="rg-edit-row">
              <input
                placeholder="Objective"
                value={item.metric}
                onChange={(e) => updateItem(i, { metric: e.target.value })}
              />
              <input
                placeholder="Target"
                value={item.target}
                onChange={(e) => updateItem(i, { target: e.target.value })}
              />
              <input
                placeholder="Measurement"
                value={item.method}
                onChange={(e) => updateItem(i, { method: e.target.value })}
              />
              <button
                type="button"
                className="rg-btn rg-btn--ghost"
                onClick={() => setDraft((prev) => prev.filter((_, j) => j !== i))}
              >
                Remove
              </button>
            </div>
          ))}
        </div>
        <button
          type="button"
          className="rg-btn rg-btn--ghost"
          onClick={() => setDraft((prev) => [...prev, { ...EMPTY_ITEM }])}
        >
          Add row
        </button>
      </BlockEditDialog>
    </div>
  )
}

export const createKpiGrid = createReactBlockSpec(
  {
    type: 'kpiGrid',
    propSchema: {
      itemsJson: {
        default: '[]',
      },
      anchorId: {
        default: '',
      },
    },
    content: 'none',
  },
  {
    render: (props) => <KpiGridView block={props.block} editor={props.editor as never} />,
  },
)
