import {
  insertOrUpdateBlockForSlashMenu,
  type BlockNoteEditor,
} from '@blocknote/core'
import type { DefaultReactSuggestionItem } from '@blocknote/react'
import { canvasSchema } from './schema'
import { DEFAULT_DIAGRAM_CODE } from './blocks/Diagram'
import { captureAiChatContext, type BlockLike, type CapturedSelection } from './aiChatCore'

export type CanvasEditor = BlockNoteEditor<
  typeof canvasSchema.blockSchema,
  typeof canvasSchema.inlineContentSchema,
  typeof canvasSchema.styleSchema
>

export interface CanvasInsertItem {
  id: string
  title: string
  description: string
  group: 'Shapes' | 'Text'
  aliases?: string[]
  insert: (editor: CanvasEditor) => void
}

function insert(editor: CanvasEditor, block: Record<string, unknown>) {
  insertOrUpdateBlockForSlashMenu(editor as never, block as never)
}

/** Shared catalog for slash menu + tools sidebar. */
export const CANVAS_INSERT_ITEMS: CanvasInsertItem[] = [
  {
    id: 'heading-1',
    title: 'Heading 1',
    description: 'Section title',
    group: 'Text',
    aliases: ['h1', 'title'],
    insert: (editor) => insert(editor, { type: 'heading', props: { level: 1 }, content: '' }),
  },
  {
    id: 'heading-2',
    title: 'Heading 2',
    description: 'Subsection',
    group: 'Text',
    aliases: ['h2'],
    insert: (editor) => insert(editor, { type: 'heading', props: { level: 2 }, content: '' }),
  },
  {
    id: 'heading-3',
    title: 'Heading 3',
    description: 'Minor heading',
    group: 'Text',
    aliases: ['h3'],
    insert: (editor) => insert(editor, { type: 'heading', props: { level: 3 }, content: '' }),
  },
  {
    id: 'paragraph',
    title: 'Paragraph',
    description: 'Body text',
    group: 'Text',
    aliases: ['text', 'p'],
    insert: (editor) => insert(editor, { type: 'paragraph', content: '' }),
  },
  {
    id: 'bullet',
    title: 'Bullet list',
    description: 'Unordered list item',
    group: 'Text',
    aliases: ['ul', 'list'],
    insert: (editor) => insert(editor, { type: 'bulletListItem', content: '' }),
  },
  {
    id: 'numbered',
    title: 'Numbered list',
    description: 'Ordered list item',
    group: 'Text',
    aliases: ['ol', 'numbered'],
    insert: (editor) => insert(editor, { type: 'numberedListItem', content: '' }),
  },
  {
    id: 'callout',
    title: 'Callout',
    description: 'Highlighted note / warning',
    group: 'Shapes',
    aliases: ['alert', 'note', 'info', 'warn'],
    insert: (editor) =>
      insert(editor, {
        type: 'callout',
        props: { variant: 'info', title: 'Note' },
        content: 'Write the callout body…',
      }),
  },
  {
    id: 'kpiGrid',
    title: 'KPI Grid',
    description: 'Measurable objectives',
    group: 'Shapes',
    aliases: ['kpi', 'metrics', 'targets', 'objectives'],
    insert: (editor) =>
      insert(editor, {
        type: 'kpiGrid',
        props: {
          itemsJson: JSON.stringify([
            { metric: 'Primary objective', target: 'Measurable target', method: 'How verified' },
          ]),
        },
      }),
  },
  {
    id: 'scopeBounds',
    title: 'Scope Bounds',
    description: 'In scope vs exclusions',
    group: 'Shapes',
    aliases: ['scope', 'in scope', 'out of scope'],
    insert: (editor) =>
      insert(editor, {
        type: 'scopeBounds',
        props: {
          inScopeJson: JSON.stringify(['In-scope item']),
          outOfScopeJson: JSON.stringify(['Explicit exclusion']),
        },
      }),
  },
  {
    id: 'stakeholderTable',
    title: 'Stakeholders',
    description: 'Interest & influence table',
    group: 'Shapes',
    aliases: ['stakeholders', 'people', 'roles'],
    insert: (editor) =>
      insert(editor, {
        type: 'stakeholderTable',
        props: {
          rowsJson: JSON.stringify([
            { nameRole: 'Name / Role', interest: 'H', influence: 'M', concern: 'Concern' },
          ]),
        },
      }),
  },
  {
    id: 'riskList',
    title: 'Risk List',
    description: 'Likelihood × impact',
    group: 'Shapes',
    aliases: ['risks', 'risk', 'mitigation'],
    insert: (editor) =>
      insert(editor, {
        type: 'riskList',
        props: {
          rowsJson: JSON.stringify([
            { risk: 'Risk', likelihood: 'M', impact: 'H', mitigation: 'Mitigation' },
          ]),
        },
      }),
  },
  {
    id: 'diagram',
    title: 'Diagram',
    description: 'Mermaid flowchart',
    group: 'Shapes',
    aliases: ['mermaid', 'flowchart', 'graph', 'diagram'],
    insert: (editor) =>
      insert(editor, {
        type: 'diagram',
        props: {
          code: DEFAULT_DIAGRAM_CODE,
          title: 'Diagram',
          source: 'llm',
        },
      }),
  },
]

export function getCanvasSlashMenuItems(editor: CanvasEditor): DefaultReactSuggestionItem[] {
  return CANVAS_INSERT_ITEMS.filter((item) => item.group === 'Shapes').map((item) => ({
    title: item.title,
    subtext: item.description,
    aliases: item.aliases,
    group: 'Charter shapes',
    onItemClick: () => item.insert(editor),
  }))
}

/**
 * Insert an "Ask AI" chat block, capturing document context at the invocation
 * point. Shared by the slash menu and the selection blip so both hand the AI
 * exactly the same context.
 */
export function insertAiChatBlock(
  editor: CanvasEditor,
  selection: CapturedSelection | null,
  options: { trustSelection?: boolean } = {},
): void {
  const ctx = captureAiChatContext(
    editor.document as BlockLike[],
    String(editor.getTextCursorPosition().block.id),
    selection,
    Date.now(),
    options,
  )
  insertOrUpdateBlockForSlashMenu(editor, {
    type: 'aiChat',
    props: {
      placeholder: 'Ask AI what you would like to change or create…',
      contextJson: JSON.stringify(ctx),
    },
  })
}

/**
 * "Ask AI" slash item. Context is captured BEFORE insertOrUpdateBlockForSlashMenu
 * splits the current paragraph, so the cursor block still contains the text the
 * user typed before the "/".
 */
export function getAiSlashMenuItem(
  editor: CanvasEditor,
  getLastSelection: () => CapturedSelection | null,
): DefaultReactSuggestionItem {
  return {
    title: 'Ask AI',
    subtext: 'Rewrite, generate, or answer right here',
    aliases: ['ai', 'assistant', 'chat', 'rewrite'],
    group: 'AI',
    onItemClick: () => insertAiChatBlock(editor, getLastSelection()),
  }
}

export function focusCanvasBlock(editor: CanvasEditor, blockId: string): void {
  try {
    editor.setTextCursorPosition(blockId, 'start')
  } catch {
    /* block may not support a text cursor */
  }
  requestAnimationFrame(() => {
    const el =
      document.querySelector(`.bn-canvas-host [data-id="${CSS.escape(blockId)}"]`) ??
      document.querySelector(`[data-id="${CSS.escape(blockId)}"]`)
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  })
}

export function removeCanvasBlockById(editor: CanvasEditor, blockId: string): void {
  const block = editor.document.find((b) => b.id === blockId)
  if (!block) return
  try {
    editor.removeBlocks([block])
  } catch (err) {
    console.error('[canvasInsert] removeBlocks failed', err)
  }
}
