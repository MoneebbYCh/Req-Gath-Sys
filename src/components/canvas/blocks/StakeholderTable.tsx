import { useState } from 'react'
import { createReactBlockSpec } from '@blocknote/react'
import { BlockActions, deleteCanvasBlock } from '../BlockActions'
import { BlockEditDialog } from '../BlockEditDialog'

export interface StakeholderRow {
  nameRole: string
  interest: string
  influence: string
  concern: string
}

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

export function parseStakeholderRows(raw: string): StakeholderRow[] {
  try {
    const parsed = JSON.parse(raw || '[]')
    if (!Array.isArray(parsed)) return []
    return parsed.map((row) => ({
      nameRole: String(row?.nameRole ?? ''),
      interest: String(row?.interest ?? ''),
      influence: String(row?.influence ?? ''),
      concern: String(row?.concern ?? ''),
    }))
  } catch {
    return []
  }
}

const EMPTY_ROW: StakeholderRow = {
  nameRole: '',
  interest: 'M',
  influence: 'M',
  concern: '',
}

function StakeholderTableView(props: {
  block: { props: Record<string, unknown> }
  editor: {
    updateBlock: (block: unknown, update: unknown) => void
    removeBlocks: (blocks: unknown[]) => void
  }
}) {
  const rows = parseStakeholderRows(String(props.block.props.rowsJson || '[]'))
  const shown =
    rows.length > 0
      ? rows
      : [{ nameRole: 'Name / Role', interest: 'H', influence: 'M', concern: '—' }]

  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState<StakeholderRow[]>(rows)

  const openEdit = () => {
    setDraft(rows.length > 0 ? rows.map((r) => ({ ...r })) : [{ ...EMPTY_ROW }])
    setEditing(true)
  }

  const updateRow = (index: number, patch: Partial<StakeholderRow>) => {
    setDraft((prev) => prev.map((row, i) => (i === index ? { ...row, ...patch } : row)))
  }

  return (
    <div className="rg-panel" contentEditable={false}>
      <div className="rg-block-caption">
        <span className="rg-block-caption-id">STAKEHOLDERS</span>
        <span className="rg-block-caption-title">Interest & influence</span>
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
            <th scope="col">Name / Role</th>
            <th scope="col">Interest</th>
            <th scope="col">Influence</th>
            <th scope="col">Primary concern</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((row, i) => {
            const interest = normalizeLevel(row.interest)
            const influence = normalizeLevel(row.influence)
            return (
              <tr key={`${row.nameRole}-${i}`}>
                <td className="rg-exec-primary">{row.nameRole || '—'}</td>
                <td>
                  <span className={`rg-level rg-level--${String(interest).toLowerCase()}`}>
                    {levelLabel(interest)}
                  </span>
                </td>
                <td>
                  <span className={`rg-level rg-level--${String(influence).toLowerCase()}`}>
                    {levelLabel(influence)}
                  </span>
                </td>
                <td className="rg-exec-muted">{row.concern || '—'}</td>
              </tr>
            )
          })}
        </tbody>
      </table>

      <BlockEditDialog
        open={editing}
        title="Edit stakeholders"
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
                placeholder="Name / Role"
                value={row.nameRole}
                onChange={(e) => updateRow(i, { nameRole: e.target.value })}
              />
              <select
                value={normalizeLevel(row.interest) === '—' ? 'M' : normalizeLevel(row.interest)}
                onChange={(e) => updateRow(i, { interest: e.target.value })}
              >
                <option value="H">Interest: High</option>
                <option value="M">Interest: Med</option>
                <option value="L">Interest: Low</option>
              </select>
              <select
                value={normalizeLevel(row.influence) === '—' ? 'M' : normalizeLevel(row.influence)}
                onChange={(e) => updateRow(i, { influence: e.target.value })}
              >
                <option value="H">Influence: High</option>
                <option value="M">Influence: Med</option>
                <option value="L">Influence: Low</option>
              </select>
              <input
                placeholder="Primary concern"
                value={row.concern}
                onChange={(e) => updateRow(i, { concern: e.target.value })}
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

export const createStakeholderTable = createReactBlockSpec(
  {
    type: 'stakeholderTable',
    propSchema: {
      rowsJson: {
        default: '[]',
      },
    },
    content: 'none',
  },
  {
    render: (props) => <StakeholderTableView block={props.block} editor={props.editor as never} />,
  },
)
