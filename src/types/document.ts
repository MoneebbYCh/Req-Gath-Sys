/** BlockNote document persisted for canvas phases. */

export type BlockNoteBlock = Record<string, unknown>

/** Stable IDs for later traceability (templateId, shortName, etc.). */
export interface CharterAnchors {
  shortName?: string
  /** Which starting template the document was created from ('custom' for a blank start). */
  templateId?: string
  [key: string]: string | undefined
}

export interface CanvasDocument {
  version: 1
  kind: 'blocknote'
  blocks: BlockNoteBlock[]
  anchors?: CharterAnchors
}

export function emptyCanvasDocument(): CanvasDocument {
  return {
    version: 1,
    kind: 'blocknote',
    blocks: [
      {
        type: 'paragraph',
        content: '',
      },
    ],
    anchors: {},
  }
}

/** True when stored JSON is a canvas doc (not the legacy form shape). */
export function isCanvasDocument(data: unknown): data is CanvasDocument {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false
  const d = data as Record<string, unknown>
  return d.kind === 'blocknote' && Array.isArray(d.blocks)
}

/** Normalize anything loaded from disk into a canvas document. Legacy forms become empty. */
export function toCanvasDocument(data: unknown): CanvasDocument {
  if (isCanvasDocument(data)) {
    return {
      version: 1,
      kind: 'blocknote',
      blocks: data.blocks.length > 0 ? data.blocks : emptyCanvasDocument().blocks,
      anchors: data.anchors && typeof data.anchors === 'object' ? data.anchors : {},
    }
  }
  return emptyCanvasDocument()
}

export function documentHasContent(doc: CanvasDocument): boolean {
  return doc.blocks.some((block) => {
    const type = String(block.type || '')
    // Custom prop-only blocks count as content.
    if (['kpiGrid', 'scopeBounds', 'stakeholderTable', 'riskList', 'callout', 'diagram'].includes(type)) {
      return true
    }
    const content = block.content
    if (typeof content === 'string') return content.trim().length > 0
    if (Array.isArray(content)) {
      return content.some((c) => {
        if (typeof c === 'string') return c.trim().length > 0
        if (c && typeof c === 'object' && 'text' in c) {
          return String((c as { text: unknown }).text).trim().length > 0
        }
        return false
      })
    }
    const children = block.children
    return Array.isArray(children) && children.length > 0
  })
}

function blockPlainText(content: unknown): string {
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

/** True when the canvas already has its own title heading — page chrome masthead should hide. */
export function documentHasOwnHeading(blocks: BlockNoteBlock[]): boolean {
  return blocks.some(
    (block) => String(block.type || '') === 'heading' && blockPlainText(block.content).length > 0,
  )
}
