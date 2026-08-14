import { useState } from 'react'
import { createReactBlockSpec } from '@blocknote/react'
import { BlockActions, deleteCanvasBlock } from '../BlockActions'
import { BlockEditDialog } from '../BlockEditDialog'

function parseList(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw || '[]')
    if (!Array.isArray(parsed)) return []
    return parsed.map((item) => String(item ?? '').trim()).filter(Boolean)
  } catch {
    return []
  }
}

function ScopeBoundsView(props: {
  block: { props: Record<string, unknown> }
  editor: {
    updateBlock: (block: unknown, update: unknown) => void
    removeBlocks: (blocks: unknown[]) => void
  }
}) {
  const inScope = parseList(String(props.block.props.inScopeJson || '[]'))
  const outOfScope = parseList(String(props.block.props.outOfScopeJson || '[]'))
  const inItems = inScope.length > 0 ? inScope : ['[Define what is included]']
  const outItems = outOfScope.length > 0 ? outOfScope : ['[Define what is explicitly excluded]']

  const [editing, setEditing] = useState(false)
  const [draftIn, setDraftIn] = useState(inScope.join('\n'))
  const [draftOut, setDraftOut] = useState(outOfScope.join('\n'))

  const openEdit = () => {
    setDraftIn(inScope.join('\n'))
    setDraftOut(outOfScope.join('\n'))
    setEditing(true)
  }

  const linesToJson = (text: string) =>
    JSON.stringify(
      text
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean),
    )

  return (
    <div className="rg-panel rg-scope" contentEditable={false}>
      <div className="rg-block-caption">
        <span className="rg-block-caption-id">SCOPE</span>
        <span className="rg-block-caption-title">In bounds · out of bounds</span>
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
      <div className="rg-scope-grid">
        <section className="rg-scope-col">
          <h3 className="rg-scope-heading">In scope</h3>
          <ul className="rg-scope-list">
            {inItems.map((item, i) => (
              <li key={`in-${i}`}>{item}</li>
            ))}
          </ul>
        </section>
        <section className="rg-scope-col rg-scope-col--out">
          <h3 className="rg-scope-heading">Out of scope</h3>
          <ul className="rg-scope-list">
            {outItems.map((item, i) => (
              <li key={`out-${i}`}>{item}</li>
            ))}
          </ul>
        </section>
      </div>

      <BlockEditDialog
        open={editing}
        title="Edit scope"
        wide
        onClose={() => setEditing(false)}
        onSave={() => {
          props.editor.updateBlock(props.block, {
            props: {
              inScopeJson: linesToJson(draftIn),
              outOfScopeJson: linesToJson(draftOut),
            },
          })
          setEditing(false)
        }}
      >
        <label className="rg-edit-field">
          <span>In scope (one item per line)</span>
          <textarea
            className="rg-edit-code"
            value={draftIn}
            onChange={(e) => setDraftIn(e.target.value)}
            rows={8}
          />
        </label>
        <label className="rg-edit-field">
          <span>Out of scope (one item per line)</span>
          <textarea
            className="rg-edit-code"
            value={draftOut}
            onChange={(e) => setDraftOut(e.target.value)}
            rows={8}
          />
        </label>
      </BlockEditDialog>
    </div>
  )
}

export const createScopeBounds = createReactBlockSpec(
  {
    type: 'scopeBounds',
    propSchema: {
      inScopeJson: { default: '[]' },
      outOfScopeJson: { default: '[]' },
    },
    content: 'none',
  },
  {
    render: (props) => <ScopeBoundsView block={props.block} editor={props.editor as never} />,
  },
)
