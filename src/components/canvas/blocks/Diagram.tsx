import { useState } from 'react'
import { createReactBlockSpec } from '@blocknote/react'
import { MermaidRenderer } from '../MermaidRenderer'
import { BlockActions, deleteCanvasBlock } from '../BlockActions'
import { BlockEditDialog } from '../BlockEditDialog'
import { DiagramFullscreen } from '../DiagramFullscreen'

const DEFAULT_CODE = `graph TD
  A[Start] --> B[Decision]
  B -->|Yes| C[Done]
  B -->|No| A`

function DiagramView(props: {
  block: { props: Record<string, unknown>; id?: string }
  editor: {
    updateBlock: (block: unknown, update: unknown) => void
    removeBlocks: (blocks: unknown[]) => void
  }
}) {
  const code = String(props.block.props.code || DEFAULT_CODE)
  const title = String(props.block.props.title || '')
  const source = String(props.block.props.source || 'llm')

  const [editing, setEditing] = useState(false)
  const [fullscreen, setFullscreen] = useState(false)
  const [draftCode, setDraftCode] = useState(code)
  const [draftTitle, setDraftTitle] = useState(title)

  const openEdit = () => {
    setDraftCode(code)
    setDraftTitle(title)
    setEditing(true)
  }

  const save = (next: { code: string; title: string }) => {
    props.editor.updateBlock(props.block, {
      props: {
        code: next.code,
        title: next.title,
        source: source === 'code-index' ? 'code-index' : 'llm',
      },
    })
  }

  return (
    <div className="rg-diagram" contentEditable={false} data-source={source}>
      <div className="rg-block-caption">
        <span className="rg-block-caption-id">DIAGRAM</span>
        <span className="rg-block-caption-title">{title || 'Mermaid'}</span>
        {source === 'code-index' ? (
          <span className="rg-anchor-id">from code index</span>
        ) : null}
        <BlockActions
          actions={[
            { label: 'Expand', onClick: () => setFullscreen(true), tone: 'accent' },
            { label: 'Edit', onClick: openEdit },
            {
              label: 'Delete',
              tone: 'danger',
              onClick: () => deleteCanvasBlock(props.editor, props.block),
            },
          ]}
        />
      </div>
      <button
        type="button"
        className="rg-diagram-preview"
        onClick={() => setFullscreen(true)}
        title="Open fullscreen"
      >
        <MermaidRenderer code={code} />
      </button>
      <details className="rg-diagram-source">
        <summary>Source</summary>
        <pre>{code}</pre>
      </details>

      <BlockEditDialog
        open={editing}
        title="Edit diagram"
        wide
        onClose={() => setEditing(false)}
        onSave={() => {
          save({ code: draftCode, title: draftTitle })
          setEditing(false)
        }}
      >
        <label className="rg-edit-field">
          <span>Title</span>
          <input
            type="text"
            value={draftTitle}
            onChange={(e) => setDraftTitle(e.target.value)}
            placeholder="Diagram title"
          />
        </label>
        <label className="rg-edit-field">
          <span>Mermaid source</span>
          <textarea
            className="rg-edit-code"
            value={draftCode}
            onChange={(e) => setDraftCode(e.target.value)}
            rows={12}
            spellCheck={false}
          />
        </label>
      </BlockEditDialog>

      <DiagramFullscreen
        open={fullscreen}
        code={code}
        title={title}
        onClose={() => setFullscreen(false)}
        onSave={(next) => save(next)}
      />
    </div>
  )
}

export const createDiagram = createReactBlockSpec(
  {
    type: 'diagram',
    propSchema: {
      code: {
        default: DEFAULT_CODE,
      },
      title: {
        default: '',
      },
      /** "llm" | "code-index" — how the diagram was produced */
      source: {
        default: 'llm',
      },
    },
    content: 'none',
  },
  {
    render: (props) => <DiagramView block={props.block} editor={props.editor as never} />,
  },
)

export { DEFAULT_CODE as DEFAULT_DIAGRAM_CODE }
