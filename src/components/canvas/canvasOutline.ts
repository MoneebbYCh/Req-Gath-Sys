import type { BlockNoteBlock } from '../../types/document'

export interface OutlineEntry {
  id: string
  type: string
  label: string
  kind: 'heading' | 'shape' | 'text'
}

function plainText(content: unknown): string {
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  return content
    .map((c) => {
      if (typeof c === 'string') return c
      if (c && typeof c === 'object' && 'text' in c) return String((c as { text: unknown }).text)
      return ''
    })
    .join('')
    .trim()
}

function propsOf(block: BlockNoteBlock): Record<string, unknown> {
  const props = block.props
  return props && typeof props === 'object' && !Array.isArray(props)
    ? (props as Record<string, unknown>)
    : {}
}

const SHAPE_TYPES = new Set([
  'callout',
  'kpiGrid',
  'scopeBounds',
  'stakeholderTable',
  'riskList',
  'diagram',
])

/** Build a navigable outline from BlockNote document blocks. */
export function buildCanvasOutline(blocks: BlockNoteBlock[]): OutlineEntry[] {
  const out: OutlineEntry[] = []

  for (const block of blocks) {
    const id = typeof block.id === 'string' ? block.id : ''
    if (!id) continue
    const type = String(block.type || 'paragraph')
    const props = propsOf(block)
    const text = plainText(block.content)

    if (type === 'heading') {
      const level = Number(props.level) || 1
      out.push({
        id,
        type,
        kind: 'heading',
        label: text || `Heading ${level}`,
      })
      continue
    }

    if (SHAPE_TYPES.has(type)) {
      let label = type
      if (type === 'callout') label = String(props.title || 'Callout')
      else if (type === 'kpiGrid') label = 'Objectives / KPIs'
      else if (type === 'scopeBounds') label = 'Scope bounds'
      else if (type === 'stakeholderTable') label = 'Stakeholders'
      else if (type === 'riskList') label = 'Risks'
      else if (type === 'diagram') label = String(props.title || 'Diagram')
      out.push({ id, type, kind: 'shape', label })
      continue
    }

    // Skip empty paragraphs to keep the outline useful
    if (type === 'paragraph' && !text) continue
    if (
      (type === 'bulletListItem' || type === 'numberedListItem' || type === 'checkListItem') &&
      !text
    ) {
      continue
    }

    const short =
      text.length > 48 ? `${text.slice(0, 48).trimEnd()}…` : text || type.replace(/([A-Z])/g, ' $1')
    out.push({
      id,
      type,
      kind: 'text',
      label: short,
    })
  }

  return out
}

export function outlineTypeBadge(type: string): string {
  switch (type) {
    case 'heading':
      return 'H'
    case 'callout':
      return 'NOTE'
    case 'kpiGrid':
      return 'KPI'
    case 'scopeBounds':
      return 'SCOPE'
    case 'stakeholderTable':
      return 'PPL'
    case 'riskList':
      return 'RISK'
    case 'diagram':
      return 'DIAG'
    case 'bulletListItem':
      return '•'
    case 'numberedListItem':
      return '#'
    default:
      return 'TXT'
  }
}
