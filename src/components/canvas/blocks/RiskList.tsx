import { useState } from 'react'
import { createReactBlockSpec } from '@blocknote/react'
import { BlockActions, deleteCanvasBlock } from '../BlockActions'
import { BlockEditDialog } from '../BlockEditDialog'
import { parseRiskRows, type RiskRow } from '../blockParsers'

export type { RiskRow }
export { parseRiskRows }

function normalizeLevel(value: string): 'H' | 'M' | 'L' | string {
  const v = value.trim().toUpperCase()
  if (v === 'H' || v === 'HIGH') return 'H'
  if (v === 'M' || v === 'MED' || v === 'MEDIUM') return 'M'
  if (v === 'L' || v === 'LOW') return 'L'
  return value.trim() || '—'
}

function levelLabel(level: string): string {
  if (level === 'H') return 'High'
  if (level === 'M') return 'Med'
  if (level === 'L') return 'Low'
  return level
}

const EMPTY_ROW: RiskRow = {
  risk: '',
  likelihood: 'M',
  impact: 'H',
  mitigation: '',
}

function RiskListView(props: {
  block: { props: Record<string, unknown> }
  editor: {
    updateBlock: (block: unknown, update: unknown) => void
    removeBlocks: (blocks: unknown[]) => void
  }
}) {
  const rows = parseRiskRows(String(props.block.props.rowsJson || '[]'))
  const shown =
    rows.length > 0
      ? rows
      : [{ risk: 'Risk', likelihood: 'M', impact: 'H', mitigation: '—' }]

  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState<RiskRow[]>(rows)

  const openEdit = () => {
    setDraft(rows.length > 0 ? rows.map((r) => ({ ...r })) : [{ ...EMPTY_ROW }])
    setEditing(true)
  }

  const updateRow = (index: number, patch: Partial<RiskRow>) => {
    setDraft((prev) => prev.map((row, i) => (i === index ? { ...row, ...patch } : row)))
  }

  return (
    <div className="rg-panel" contentEditable={false}>
      <div className="rg-block-caption">
        <span className="rg-block-caption-id">RISKS</span>
        <span className="rg-block-caption-title">Likelihood × impact</span>
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
      <table className="rg-exec-table">
        <thead>
          <tr>
            <th scope="col">Risk</th>
            <th scope="col">Likelihood</th>
            <th scope="col">Impact</th>
            <th scope="col">Mitigation</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((row, i) => {
            const likelihood = normalizeLevel(row.likelihood)
            const impact = normalizeLevel(row.impact)
            return (
              <tr key={`${row.risk}-${i}`}>
                <td className="rg-exec-primary">{row.risk || '—'}</td>
                <td>
                  <span className={`rg-level rg-level--${String(likelihood).toLowerCase()}`}>
                    {levelLabel(likelihood)}
                  </span>
                </td>
                <td>
                  <span className={`rg-level rg-level--${String(impact).toLowerCase()}`}>
                    {levelLabel(impact)}
                  </span>
                </td>
                <td className="rg-exec-muted">{row.mitigation || '—'}</td>
              </tr>
            )
          })}
        </tbody>
      </table>

      <BlockEditDialog
        open={editing}
        title="Edit risks"
        wide
        onClose={() => setEditing(false)}
        onSave={() => {
          props.editor.updateBlock(props.block, {
            props: { rowsJson: JSON.stringify(draft) },
          })
          setEditing(false)
        }}
      >
        <div className="rg-edit-rows">
          {draft.map((row, i) => (
            <div key={i} className="rg-edit-row">
              <input
                placeholder="Risk"
                value={row.risk}
                onChange={(e) => updateRow(i, { risk: e.target.value })}
              />
              <select
                value={
                  normalizeLevel(row.likelihood) === '—' ? 'M' : normalizeLevel(row.likelihood)
                }
                onChange={(e) => updateRow(i, { likelihood: e.target.value })}
              >
                <option value="H">Likelihood: High</option>
                <option value="M">Likelihood: Med</option>
                <option value="L">Likelihood: Low</option>
              </select>
              <select
                value={normalizeLevel(row.impact) === '—' ? 'H' : normalizeLevel(row.impact)}
                onChange={(e) => updateRow(i, { impact: e.target.value })}
              >
                <option value="H">Impact: High</option>
                <option value="M">Impact: Med</option>
                <option value="L">Impact: Low</option>
              </select>
              <input
                placeholder="Mitigation"
                value={row.mitigation}
                onChange={(e) => updateRow(i, { mitigation: e.target.value })}
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
          onClick={() => setDraft((prev) => [...prev, { ...EMPTY_ROW }])}
        >
          Add row
        </button>
      </BlockEditDialog>
    </div>
  )
}

export const createRiskList = createReactBlockSpec(
  {
    type: 'riskList',
    propSchema: {
      rowsJson: {
        default: '[]',
      },
    },
    content: 'none',
  },
  {
    render: (props) => <RiskListView block={props.block} editor={props.editor as never} />,
  },
)
