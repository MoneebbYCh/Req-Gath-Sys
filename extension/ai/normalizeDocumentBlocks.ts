/**
 * Normalize LLM-authored BlockNote-ish blocks before save / validation.
 * Mirrors webview sanitizeCanvasBlocks for diagram aliases + Mermaid extraction.
 */

const DIAGRAM_ALIASES = new Set([
  'diagram',
  'mermaid',
  'mermaidDiagram',
  'mermaidBlock',
  'flowchart',
  'architectureDiagram',
  'diagramBlock',
])

function tryString(v: unknown): string {
  return typeof v === 'string' && v.trim() ? v.trim() : ''
}

function extractMermaidCode(block: Record<string, unknown>): { code: string; title: string } {
  const props =
    block.props && typeof block.props === 'object' && !Array.isArray(block.props)
      ? (block.props as Record<string, unknown>)
      : {}

  let code =
    tryString(props.code) ||
    tryString(props.mermaid) ||
    tryString(props.sourceCode) ||
    tryString(props.diagram)

  let title = tryString(props.title)
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

  const fence = code.match(/^```(?:mermaid)?\s*([\s\S]*?)\s*```$/i)
  if (fence) code = fence[1].trim()

  return { code, title }
}

/** Rewrite mermaid* / content.diagram shapes into real diagram blocks with props.code. */
export function normalizeDocumentBlocks(blocks: unknown[]): unknown[] {
  return blocks.map((raw) => {
    if (!raw || typeof raw !== 'object') return raw
    const block = { ...(raw as Record<string, unknown>) }
    const type = String(block.type || '')

    if (!DIAGRAM_ALIASES.has(type)) return block

    const props =
      block.props && typeof block.props === 'object' && !Array.isArray(block.props)
        ? { ...(block.props as Record<string, unknown>) }
        : {}

    const { code, title } = extractMermaidCode(block)
    if (code) props.code = code
    if (title) props.title = title
    else if (typeof props.title !== 'string') props.title = ''
    if (props.source !== 'code-index') props.source = 'llm'

    delete props.mermaid
    delete props.sourceCode
    delete props.diagram
    delete block.content

    return { ...block, type: 'diagram', props }
  })
}
