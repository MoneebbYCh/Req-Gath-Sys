import type { ReactNode } from 'react'

export interface BlockAction {
  label: string
  onClick: () => void
  /** visual weight */
  tone?: 'default' | 'danger' | 'accent'
  title?: string
}

interface BlockActionsProps {
  actions: BlockAction[]
  /** Extra controls after the action buttons (e.g. source badge). */
  trailing?: ReactNode
}

/** Compact Edit / Delete / Expand controls for custom canvas blocks. */
export function BlockActions({ actions, trailing }: BlockActionsProps) {
  return (
    <div className="rg-block-actions" contentEditable={false}>
      {actions.map((action) => (
        <button
          key={action.label}
          type="button"
          className={`rg-block-action rg-block-action--${action.tone ?? 'default'}`}
          title={action.title ?? action.label}
          onClick={(e) => {
            e.preventDefault()
            e.stopPropagation()
            action.onClick()
          }}
          onMouseDown={(e) => {
            // Keep BlockNote from stealing focus / starting a selection.
            e.preventDefault()
            e.stopPropagation()
          }}
        >
          {action.label}
        </button>
      ))}
      {trailing}
    </div>
  )
}

export function deleteCanvasBlock(
  editor: { removeBlocks: (blocks: unknown[]) => void },
  block: unknown,
): void {
  try {
    editor.removeBlocks([block])
  } catch (err) {
    console.error('[BlockActions] removeBlocks failed', err)
  }
}
