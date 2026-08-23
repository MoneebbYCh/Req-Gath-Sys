import type { BlockNoteBlock, CanvasDocument } from '../types/document'

/**
 * Serialize a canvas document to Markdown for export.
 * Pure function — no VS Code or DOM dependencies (unit-tested).
 */

function inlineText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((c) => {
      if (typeof c === 'string') return c
      if (c && typeof c === 'object' && 'text' in c) return String((c as { text: unknown }).text)
      return ''
    })
    .join('')
}

function propsOf(block: BlockNoteBlock): Record<string, unknown> {
  const p = block.props
  return p && typeof p === 'object' && !Array.isArray(p) ? (p as Record<string, unknown>) : {}
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.map((v) => String(v)) : []
}

function table(headers: string[], rows: string[][]): string {
  const esc = (v: string) => v.replace(/\|/g, '\\|')
  return [
    `| ${headers.map(esc).join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map((r) => `| ${r.map(esc).join(' | ')} |`),
  ].join('\n')
}

function blockToMarkdown(block: BlockNoteBlock): string {
  const type = String(block.type || '')
  const props = propsOf(block)
  const text = inlineText(block.content)

  switch (type) {
    case 'heading': {
      const level = Math.min(3, Math.max(1, Number(props.level) || 1))
      return `${'#'.repeat(level)} ${text}`.trimEnd()
    }
    case 'paragraph':
      return text
    case 'bulletListItem':
      return `- ${text}`
    case 'numberedListItem':
      return `1. ${text}`
    case 'checkListItem':
      return `- [${props.checked === true ? 'x' : ' '}] ${text}`
    case 'callout': {
      const title = typeof props.title === 'string' && props.title.trim() ? props.title : 'Callout'
      return `> **${title}**\n>\n> ${text}`.trimEnd()
    }
    case 'kpiGrid': {
      const items = Array.isArray(props.items)
        ? (props.items as Record<string, unknown>[])
        : []
      return table(
        ['Metric', 'Target', 'Method'],
        items.map((i) => [
          String(i?.metric ?? ''),
          String(i?.target ?? ''),
          String(i?.method ?? ''),
        ]),
      )
    }
    case 'scopeBounds': {
      const sections: string[] = []
      const inScope = stringList(props.inScope)
      const outOfScope = stringList(props.outOfScope)
      if (inScope.length) {
        sections.push(`**In scope**\n\n${inScope.map((s) => `- ${s}`).join('\n')}`)
      }
      if (outOfScope.length) {
        sections.push(`**Out of scope**\n\n${outOfScope.map((s) => `- ${s}`).join('\n')}`)
      }
      return sections.join('\n\n')
    }
    case 'stakeholderTable': {
      const rows = Array.isArray(props.rows) ? (props.rows as Record<string, unknown>[]) : []
      return table(
        ['Name / Role', 'Interest', 'Influence', 'Concern'],
        rows.map((r) => [
          String(r?.nameRole ?? ''),
          String(r?.interest ?? ''),
          String(r?.influence ?? ''),
          String(r?.concern ?? ''),
        ]),
      )
    }
    case 'riskList': {
      const rows = Array.isArray(props.rows) ? (props.rows as Record<string, unknown>[]) : []
      return table(
        ['Risk', 'Likelihood', 'Impact', 'Mitigation'],
        rows.map((r) => [
          String(r?.risk ?? ''),
          String(r?.likelihood ?? ''),
          String(r?.impact ?? ''),
          String(r?.mitigation ?? ''),
        ]),
      )
    }
    case 'diagram': {
      const code = typeof props.code === 'string' ? props.code.trimEnd() : ''
      return code ? `\`\`\`mermaid\n${code}\n\`\`\`` : ''
    }
    default:
      return '' // unknown / non-exportable blocks are skipped
  }
}

export function canvasToMarkdown(doc: CanvasDocument): string {
  return doc.blocks
    .map(blockToMarkdown)
    .filter((s) => s.length > 0)
    .join('\n\n')
}