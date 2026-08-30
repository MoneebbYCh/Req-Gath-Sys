import { remark } from 'remark'
import remarkGfm from 'remark-gfm'
import type {
  Content,
  Heading,
  List,
  ListItem,
  PhrasingContent,
  Root,
  Table,
} from 'mdast'
import { normalizeMarkdown } from './markdownNormalize'

const MAX_BLOCKS = 60
const MAX_LIST_DEPTH = 3

type InlineStyles = {
  bold?: boolean
  italic?: boolean
  code?: boolean
}

export type CanvasInline =
  | { type: 'text'; text: string; styles: InlineStyles }
  | { type: 'link'; href: string; content: CanvasInline[] }

export type CanvasBlock = {
  type: string
  props?: Record<string, unknown>
  content?: unknown
  children?: CanvasBlock[]
}

/**
 * Parse CommonMark/GFM into BlockNote-shaped canvas blocks.
 * Nested lists use `children`; in-prose headings are always level 3.
 */
export function markdownToCanvasBlocks(source: string): CanvasBlock[] {
  const normalized = normalizeMarkdown(source || '')
  if (!normalized) return []

  const tree = remark().use(remarkGfm).parse(normalized) as Root
  const out: CanvasBlock[] = []
  for (const node of tree.children) {
    out.push(...mapBlock(node, 1))
    if (out.length >= MAX_BLOCKS) break
  }
  return out.slice(0, MAX_BLOCKS)
}

function mapBlock(node: Content, listDepth: number): CanvasBlock[] {
  switch (node.type) {
    case 'paragraph':
      return [{ type: 'paragraph', content: mapInlines(node.children) }]
    case 'heading':
      return [mapHeading(node)]
    case 'list':
      return mapList(node, listDepth)
    case 'table':
      return [mapTable(node)]
    case 'code':
      return [
        {
          type: 'codeBlock',
          props: { language: node.lang ?? 'text' },
          content: node.value,
        },
      ]
    case 'blockquote': {
      const text = node.children
        .flatMap((c) => (c.type === 'paragraph' ? [inlinePlain(c.children)] : []))
        .join('\n')
        .trim()
      return text ? [{ type: 'quote', content: text }] : []
    }
    case 'thematicBreak':
      return []
    default:
      return []
  }
}

function mapHeading(node: Heading): CanvasBlock {
  // Section h2 is owned by DocumentRenderer; never emit level 1/2 from prose.
  return {
    type: 'heading',
    props: { level: 3 },
    content: mapInlines(node.children),
  }
}

function mapList(node: List, depth: number): CanvasBlock[] {
  const itemType = node.ordered ? 'numberedListItem' : 'bulletListItem'
  const blocks: CanvasBlock[] = []
  for (const item of node.children) {
    blocks.push(mapListItem(item, itemType, depth))
  }
  return blocks
}

function mapListItem(
  item: ListItem,
  itemType: 'bulletListItem' | 'numberedListItem',
  depth: number,
): CanvasBlock {
  const inlines: CanvasInline[] = []
  const children: CanvasBlock[] = []
  let deepText = ''

  for (const child of item.children) {
    if (child.type === 'paragraph') {
      inlines.push(...mapInlines(child.children))
    } else if (child.type === 'list') {
      if (depth < MAX_LIST_DEPTH) {
        children.push(...mapList(child, depth + 1))
      } else {
        deepText = appendDeepListText(deepText, child)
      }
    } else if (child.type === 'code') {
      if (inlines.length) inlines.push({ type: 'text', text: ' ', styles: {} })
      inlines.push({ type: 'text', text: child.value, styles: { code: true } })
    }
  }

  if (deepText) {
    if (inlines.length) inlines.push({ type: 'text', text: ' — ', styles: {} })
    inlines.push({ type: 'text', text: deepText, styles: {} })
  }

  const block: CanvasBlock = {
    type: itemType,
    content: inlines.length > 0 ? inlines : '',
  }
  if (children.length > 0) block.children = children
  return block
}

function appendDeepListText(existing: string, list: List): string {
  const parts: string[] = []
  for (const item of list.children) {
    const text = listItemPlain(item).trim()
    if (text) parts.push(text)
  }
  const joined = parts.join(' — ')
  if (!joined) return existing
  return existing ? `${existing} — ${joined}` : joined
}

function listItemPlain(item: ListItem): string {
  const bits: string[] = []
  for (const child of item.children) {
    if (child.type === 'paragraph') bits.push(inlinePlain(child.children))
    else if (child.type === 'list') bits.push(appendDeepListText('', child))
  }
  return bits.join(' ')
}

function mapTable(node: Table): CanvasBlock {
  const rows = node.children.map((row) => ({
    cells: row.children.map((cell) => mapInlines(cell.children)),
  }))
  return {
    type: 'table',
    content: {
      type: 'tableContent',
      rows,
    },
  }
}

export function mapInlines(nodes: PhrasingContent[]): CanvasInline[] {
  const out: CanvasInline[] = []
  for (const n of nodes) {
    switch (n.type) {
      case 'text':
        out.push({ type: 'text', text: n.value, styles: {} })
        break
      case 'strong':
        for (const child of mapInlines(n.children as PhrasingContent[])) {
          if (child.type === 'text') child.styles = { ...child.styles, bold: true }
          out.push(child)
        }
        break
      case 'emphasis':
        for (const child of mapInlines(n.children as PhrasingContent[])) {
          if (child.type === 'text') child.styles = { ...child.styles, italic: true }
          out.push(child)
        }
        break
      case 'inlineCode':
        out.push({ type: 'text', text: n.value, styles: { code: true } })
        break
      case 'link':
        out.push({
          type: 'link',
          href: n.url,
          content: mapInlines(n.children as PhrasingContent[]),
        })
        break
      case 'break':
        out.push({ type: 'text', text: '\n', styles: {} })
        break
      case 'delete':
        // GFM strikethrough — keep text without a dedicated style
        out.push(...mapInlines(n.children as PhrasingContent[]))
        break
      default:
        break
    }
  }
  return out
}

function inlinePlain(nodes: PhrasingContent[]): string {
  return mapInlines(nodes)
    .map((c) => {
      if (c.type === 'text') return c.text
      if (c.type === 'link') return inlinePlainFromCanvas(c.content)
      return ''
    })
    .join('')
}

function inlinePlainFromCanvas(nodes: CanvasInline[]): string {
  return nodes
    .map((c) => (c.type === 'text' ? c.text : c.type === 'link' ? inlinePlainFromCanvas(c.content) : ''))
    .join('')
}
