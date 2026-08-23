import type { ReactNode } from 'react'

/**
 * Lightweight markdown for chat bubbles: bold, italic, inline code,
 * paragraphs, and simple bullet/numbered lists. Escapes raw HTML.
 */

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = []
  // **bold**, *italic*, `code` — non-greedy, no nested spans across types
  const re = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/g
  let last = 0
  let m: RegExpExecArray | null
  let i = 0
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) {
      nodes.push(text.slice(last, m.index))
    }
    const token = m[0]
    const key = `${keyPrefix}-${i++}`
    if (token.startsWith('**') && token.endsWith('**')) {
      nodes.push(<strong key={key}>{token.slice(2, -2)}</strong>)
    } else if (token.startsWith('`') && token.endsWith('`')) {
      nodes.push(<code key={key}>{token.slice(1, -1)}</code>)
    } else if (token.startsWith('*') && token.endsWith('*')) {
      nodes.push(<em key={key}>{token.slice(1, -1)}</em>)
    } else {
      nodes.push(token)
    }
    last = m.index + token.length
  }
  if (last < text.length) nodes.push(text.slice(last))
  return nodes
}

function isBullet(line: string): boolean {
  return /^\s*[-*]\s+/.test(line)
}

function isNumbered(line: string): boolean {
  return /^\s*\d+\.\s+/.test(line)
}

function stripListMarker(line: string): string {
  return line.replace(/^\s*(?:[-*]|\d+\.)\s+/, '')
}

export function ChatMarkdown({ text }: { text: string }) {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const blocks: ReactNode[] = []
  let i = 0
  let blockKey = 0

  while (i < lines.length) {
    // Skip blank lines between blocks
    if (!lines[i].trim()) {
      i++
      continue
    }

    if (isBullet(lines[i])) {
      const items: string[] = []
      while (i < lines.length && isBullet(lines[i])) {
        items.push(stripListMarker(lines[i]))
        i++
      }
      blocks.push(
        <ul key={`ul-${blockKey++}`} className="chat-md-list">
          {items.map((item, idx) => (
            <li key={idx}>{renderInline(item, `ul-${blockKey}-${idx}`)}</li>
          ))}
        </ul>,
      )
      continue
    }

    if (isNumbered(lines[i])) {
      const items: string[] = []
      while (i < lines.length && isNumbered(lines[i])) {
        items.push(stripListMarker(lines[i]))
        i++
      }
      blocks.push(
        <ol key={`ol-${blockKey++}`} className="chat-md-list chat-md-list--ordered">
          {items.map((item, idx) => (
            <li key={idx}>{renderInline(item, `ol-${blockKey}-${idx}`)}</li>
          ))}
        </ol>,
      )
      continue
    }

    // Paragraph: consecutive non-blank, non-list lines
    const para: string[] = []
    while (
      i < lines.length &&
      lines[i].trim() &&
      !isBullet(lines[i]) &&
      !isNumbered(lines[i])
    ) {
      para.push(lines[i])
      i++
    }
    blocks.push(
      <p key={`p-${blockKey++}`} className="chat-md-p">
        {renderInline(para.join(' '), `p-${blockKey}`)}
      </p>,
    )
  }

  if (blocks.length === 0) {
    return <div className="chat-md">{renderInline(text, 'empty')}</div>
  }

  return <div className="chat-md">{blocks}</div>
}
