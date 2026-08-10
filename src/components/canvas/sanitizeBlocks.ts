import type { PartialBlock } from '@blocknote/core'
import type { BlockNoteBlock } from '../../types/document'

const CUSTOM_TYPES = new Set([
  'callout',
  'kpiGrid',
  'scopeBounds',
  'stakeholderTable',
  'riskList',
  'diagram',
])

const BUILTIN_TYPES = new Set([
  'paragraph',
  'heading',
  'bulletListItem',
  'numberedListItem',
  'checkListItem',
  'toggleListItem',
  'codeBlock',
  'quote',
  'divider',
  'table',
  'image',
  'file',
  'video',
  'audio',
])

const ALLOWED_TYPES = new Set([...CUSTOM_TYPES, ...BUILTIN_TYPES])

/** LLM often invents these type names — map them to our real custom blocks. */
const TYPE_ALIASES: Record<string, string> = {
  mermaid: 'diagram',
  mermaidDiagram: 'diagram',
  mermaidBlock: 'diagram',
  flowchart: 'diagram',
  architectureDiagram: 'diagram',
  diagramBlock: 'diagram',
}

/**
 * Pull Mermaid source out of the many shapes LLMs invent.
 * Returns { code, title } when found.
 */
function extractMermaidFromBlock(
  block: Record<string, unknown>,
  props: Record<string, unknown>,
): { code: string; title: string } {
  let code = ''
  let title = typeof props.title === 'string' ? props.title : ''

  const tryString = (v: unknown) =>
    typeof v === 'string' && v.trim() ? v.trim() : ''

  code =
    tryString(props.code) ||
    tryString(props.mermaid) ||
    tryString(props.sourceCode) ||
    tryString(props.diagram)
  // NOTE: do not use props.source — that is provenance ("llm" | "code-index"), not Mermaid.

  // content: "flowchart TD…" or content: { diagram, code, title, mermaid }
  const content = block.content
  if (!code && typeof content === 'string') {
    code = content.trim()
  } else if (!code && content && typeof content === 'object' && !Array.isArray(content)) {
    const c = content as Record<string, unknown>
    code =
      tryString(c.diagram) ||
      tryString(c.code) ||
      tryString(c.mermaid) ||
      tryString(c.source) ||
      tryString(c.sourceCode)
    if (!title) title = tryString(c.title)
  }

  if (!code) {
    code = extractPlainText(content)
  }

  // Strip ```mermaid fences
  const fence = code.match(/^```(?:mermaid)?\s*([\s\S]*?)\s*```$/i)
  if (fence) code = fence[1].trim()

  // <br/> in labels often breaks strict sanitizer — use Mermaid-friendly breaks
  code = code.replace(/<br\s*\/?>/gi, '<br/>')

  return { code, title }
}

const NONE_CONTENT_TYPES = new Set([
  'kpiGrid',
  'scopeBounds',
  'stakeholderTable',
  'riskList',
  'diagram',
  'divider',
  'image',
  'file',
  'video',
  'audio',
])

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function extractPlainText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => {
      if (typeof part === 'string') return part
      if (part && typeof part === 'object' && 'text' in part) {
        return String((part as { text: unknown }).text ?? '')
      }
      return ''
    })
    .join('')
}

function paragraphFallback(text: string): PartialBlock {
  return { type: 'paragraph', content: text || '' }
}

/**
 * Normalize LLM / disk JSON into BlockNote PartialBlocks.
 * Unknown types and bad props must never reach the editor — they blank the whole React tree.
 */
export function sanitizeCanvasBlocks(blocks: BlockNoteBlock[]): PartialBlock[] {
  if (!blocks.length) {
    return [paragraphFallback('')]
  }

  const out: PartialBlock[] = []

  for (const raw of blocks) {
    if (!raw || typeof raw !== 'object') continue

    const block = { ...raw } as Record<string, unknown>
    let type = String(block.type || 'paragraph')
    if (TYPE_ALIASES[type]) {
      type = TYPE_ALIASES[type]
      block.type = type
    }

    if (!ALLOWED_TYPES.has(type)) {
      const text = extractPlainText(block.content) || `[Unsupported block: ${type}]`
      out.push(paragraphFallback(text))
      continue
    }

    const props =
      block.props && typeof block.props === 'object' && !Array.isArray(block.props)
        ? { ...(block.props as Record<string, unknown>) }
        : {}

    if (type === 'heading') {
      const level = Number(props.level)
      props.level = Number.isFinite(level) && level >= 1 && level <= 6 ? Math.trunc(level) : 1
    }

    if (type === 'callout') {
      if (props.title == null) props.title = ''
      if (props.anchorId == null) props.anchorId = ''
      const allowed = new Set(['info', 'warn', 'success', 'error'])
      if (!allowed.has(String(props.variant ?? ''))) props.variant = 'info'
    }

    if (type === 'kpiGrid') {
      if (Array.isArray(props.items)) {
        props.itemsJson = JSON.stringify(props.items)
        delete props.items
      } else if (typeof props.itemsJson !== 'string') {
        props.itemsJson = '[]'
      }
      if (props.anchorId == null) props.anchorId = ''
    }

    if (type === 'stakeholderTable') {
      if (Array.isArray(props.rows)) {
        props.rowsJson = JSON.stringify(props.rows)
        delete props.rows
      } else if (typeof props.rowsJson !== 'string') {
        props.rowsJson = '[]'
      }
    }

    if (type === 'riskList') {
      if (Array.isArray(props.rows)) {
        props.rowsJson = JSON.stringify(props.rows)
        delete props.rows
      } else if (typeof props.rowsJson !== 'string') {
        props.rowsJson = '[]'
      }
    }

    if (type === 'scopeBounds') {
      if (Array.isArray(props.inScope)) {
        props.inScopeJson = JSON.stringify(props.inScope)
        delete props.inScope
      } else if (typeof props.inScopeJson !== 'string') {
        props.inScopeJson = '[]'
      }
      if (Array.isArray(props.outOfScope)) {
        props.outOfScopeJson = JSON.stringify(props.outOfScope)
        delete props.outOfScope
      } else if (typeof props.outOfScopeJson !== 'string') {
        props.outOfScopeJson = '[]'
      }
    }

    if (type === 'diagram') {
      const extracted = extractMermaidFromBlock(block, props)
      if (extracted.code) {
        props.code = extracted.code
      } else if (typeof props.code !== 'string' || !props.code.trim()) {
        // Keep a visible stub only when nothing was recoverable.
        props.code = 'graph TD\n  A[Start] --> B[End]'
      }
      if (extracted.title) props.title = extracted.title
      else if (props.title == null) props.title = ''
      if (props.source !== 'code-index') props.source = 'llm'
      delete props.mermaid
      delete props.sourceCode
      delete props.diagram
      // Object content is not valid for BlockNote diagram (content: 'none').
      delete block.content
    }

    // Drop unknown prop keys that are still arrays/objects (BlockNote propSchema is scalars/strings).
    for (const key of Object.keys(props)) {
      const value = props[key]
      if (value !== null && typeof value === 'object') {
        try {
          props[key] = JSON.stringify(value)
        } catch {
          delete props[key]
        }
      }
    }

    const next: Record<string, unknown> = { type, props }

    if (!NONE_CONTENT_TYPES.has(type) && block.content !== undefined) {
      next.content = block.content
    }

    if (Array.isArray(block.children) && block.children.length) {
      next.children = sanitizeCanvasBlocks(asArray(block.children) as BlockNoteBlock[])
    }

    out.push(next as PartialBlock)
  }

  return out.length > 0 ? out : [paragraphFallback('')]
}
