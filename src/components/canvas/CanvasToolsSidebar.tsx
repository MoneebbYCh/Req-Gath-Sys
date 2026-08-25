import {
  CANVAS_INSERT_ITEMS,
  type CanvasEditor,
} from './canvasInsert'

interface CanvasToolsSidebarProps {
  editor: CanvasEditor | null
  phaseTitle: string
  collapsed: boolean
  onToggleCollapsed: () => void
}

export function CanvasToolsSidebar({
  editor,
  phaseTitle,
  collapsed,
  onToggleCollapsed,
}: CanvasToolsSidebarProps) {
  const shapes = CANVAS_INSERT_ITEMS.filter((i) => i.group === 'Shapes')
  const textItems = CANVAS_INSERT_ITEMS.filter((i) => i.group === 'Text')

  if (collapsed) {
    return (
      <aside className="canvas-tools canvas-tools--collapsed" aria-label="Document tools">
        <button
          type="button"
          className="canvas-tools-expand"
          onClick={onToggleCollapsed}
          title="Show document tools"
        >
          Tools
        </button>
      </aside>
    )
  }

  return (
    <aside className="canvas-tools" aria-label="Document tools">
      <header className="canvas-tools-header">
        <div>
          <p className="canvas-tools-kicker">Document tools</p>
          <h2 className="canvas-tools-title">{phaseTitle}</h2>
        </div>
        <button
          type="button"
          className="canvas-tools-collapse"
          onClick={onToggleCollapsed}
          title="Collapse sidebar"
          aria-label="Collapse sidebar"
        >
          ‹
        </button>
      </header>

      <div className="canvas-tools-body">
        <section className="canvas-tools-section">
          <h3 className="canvas-tools-section-title">Shapes</h3>
          <p className="canvas-tools-section-hint">
            Insert at the cursor — same as typing <kbd>/</kbd> in the page.
          </p>
          <div className="canvas-tools-grid">
            {shapes.map((item) => (
              <button
                key={item.id}
                type="button"
                className="canvas-tools-insert"
                disabled={!editor}
                title={item.description}
                onClick={() => editor && item.insert(editor)}
              >
                <span className="canvas-tools-insert-title">{item.title}</span>
                <span className="canvas-tools-insert-desc">{item.description}</span>
              </button>
            ))}
          </div>
        </section>

        <section className="canvas-tools-section">
          <h3 className="canvas-tools-section-title">Text</h3>
          <div className="canvas-tools-grid canvas-tools-grid--compact">
            {textItems.map((item) => (
              <button
                key={item.id}
                type="button"
                className="canvas-tools-insert canvas-tools-insert--compact"
                disabled={!editor}
                title={item.description}
                onClick={() => editor && item.insert(editor)}
              >
                <span className="canvas-tools-insert-title">{item.title}</span>
              </button>
            ))}
          </div>
        </section>
      </div>
    </aside>
  )
}
