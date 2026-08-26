import { useMemo } from 'react'
import type { BlockNoteBlock } from '../types/document'
import {
  parseStakeholderRows,
  parseRiskRows,
  parseKpiItems,
} from './canvas/blockParsers'

interface TemplateDocPreviewProps {
  blocks: BlockNoteBlock[]
  /** Compact thumbnail mode for marketplace cards. */
  mode?: 'full' | 'thumb'
  className?: string
}

function plain(content: unknown): string {
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

function parseJsonList(raw: unknown): string[] {
  try {
    const parsed = JSON.parse(String(raw || '[]'))
    return Array.isArray(parsed) ? parsed.map((x) => String(x)) : []
  } catch {
    return []
  }
}

function tableRows(content: unknown): string[][] {
  if (!content || typeof content !== 'object') return []
  const rows = (content as { rows?: unknown }).rows
  if (!Array.isArray(rows)) return []
  return rows.map((row) => {
    const cells = row && typeof row === 'object' ? (row as { cells?: unknown }).cells : null
    if (!Array.isArray(cells)) return []
    return cells.map((cell) => {
      if (typeof cell === 'string' || typeof cell === 'number') return String(cell)
      if (cell && typeof cell === 'object' && 'content' in cell) {
        return plain((cell as { content: unknown }).content)
      }
      if (Array.isArray(cell)) return plain(cell)
      return ''
    })
  })
}

type PreviewNode =
  | { kind: 'block'; block: BlockNoteBlock }
  | { kind: 'ul'; items: string[] }
  | { kind: 'ol'; items: string[] }

function groupBlocks(blocks: BlockNoteBlock[]): PreviewNode[] {
  const out: PreviewNode[] = []
  let i = 0
  while (i < blocks.length) {
    const type = String(blocks[i].type || '')
    if (type === 'bulletListItem') {
      const items: string[] = []
      while (i < blocks.length && String(blocks[i].type || '') === 'bulletListItem') {
        items.push(plain(blocks[i].content))
        i += 1
      }
      out.push({ kind: 'ul', items })
      continue
    }
    if (type === 'numberedListItem') {
      const items: string[] = []
      while (i < blocks.length && String(blocks[i].type || '') === 'numberedListItem') {
        items.push(plain(blocks[i].content))
        i += 1
      }
      out.push({ kind: 'ol', items })
      continue
    }
    out.push({ kind: 'block', block: blocks[i] })
    i += 1
  }
  return out
}

function BlockView({ block }: { block: BlockNoteBlock }) {
  const type = String(block.type || '')

  if (type === 'heading') {
    const level = Number((block.props as { level?: number } | undefined)?.level) || 2
    const text = plain(block.content)
    const Tag = (level === 1 ? 'h1' : level === 3 ? 'h3' : 'h2') as 'h1' | 'h2' | 'h3'
    return <Tag className={`tdp-h tdp-h${level}`}>{text}</Tag>
  }

  if (type === 'paragraph') {
    const text = plain(block.content)
    if (!text.trim()) return <p className="tdp-p tdp-p--empty">&nbsp;</p>
    return <p className="tdp-p">{text}</p>
  }

  if (type === 'callout') {
    const props = (block.props || {}) as { variant?: string; title?: string }
    const variant = props.variant || 'info'
    const tone =
      variant === 'warn' ? 'caution' : variant === 'success' ? 'positive' : variant === 'error' ? 'critical' : 'neutral'
    const label =
      variant === 'warn' ? 'CAUTION' : variant === 'success' ? 'CONFIRMED' : variant === 'error' ? 'CRITICAL' : 'NOTE'
    return (
      <aside className={`tdp-callout tdp-callout--${tone}`}>
        <div className="tdp-callout-rail" aria-hidden />
        <div className="tdp-callout-inner">
          <div className="tdp-callout-meta">
            <span className="tdp-callout-label">{label}</span>
            {props.title ? <span className="tdp-callout-title">{props.title}</span> : null}
          </div>
          <p>{plain(block.content)}</p>
        </div>
      </aside>
    )
  }

  if (type === 'codeBlock') {
    const lang = String((block.props as { language?: string } | undefined)?.language || '')
    return (
      <pre className="tdp-code">
        {lang ? <span className="tdp-code-lang">{lang}</span> : null}
        <code>{plain(block.content)}</code>
      </pre>
    )
  }

  if (type === 'table') {
    const rows = tableRows(block.content)
    if (rows.length === 0) return null
    const [header, ...body] = rows
    return (
      <div className="tdp-table-wrap">
        <table className="tdp-table">
          <thead>
            <tr>
              {header.map((c, i) => (
                <th key={i}>{c}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {body.map((row, ri) => (
              <tr key={ri}>
                {row.map((c, ci) => (
                  <td key={ci}>{c}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )
  }

  if (type === 'kpiGrid') {
    const items = parseKpiItems(String((block.props as { itemsJson?: string })?.itemsJson || '[]'))
    return (
      <div className="tdp-table-wrap">
        <table className="tdp-table">
          <thead>
            <tr>
              <th>Metric</th>
              <th>Target</th>
              <th>Method</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item, i) => (
              <tr key={i}>
                <td>{item.metric}</td>
                <td>{item.target}</td>
                <td>{item.method}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )
  }

  if (type === 'stakeholderTable') {
    const rows = parseStakeholderRows(String((block.props as { rowsJson?: string })?.rowsJson || '[]'))
    return (
      <div className="tdp-table-wrap">
        <table className="tdp-table">
          <thead>
            <tr>
              <th>Name / Role</th>
              <th>Interest</th>
              <th>Influence</th>
              <th>Concern</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={i}>
                <td>{row.nameRole}</td>
                <td>{row.interest}</td>
                <td>{row.influence}</td>
                <td>{row.concern}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )
  }

  if (type === 'riskList') {
    const rows = parseRiskRows(String((block.props as { rowsJson?: string })?.rowsJson || '[]'))
    return (
      <div className="tdp-table-wrap">
        <table className="tdp-table">
          <thead>
            <tr>
              <th>Risk</th>
              <th>L</th>
              <th>I</th>
              <th>Mitigation</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={i}>
                <td>{row.risk}</td>
                <td>{row.likelihood}</td>
                <td>{row.impact}</td>
                <td>{row.mitigation}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )
  }

  if (type === 'scopeBounds') {
    const props = (block.props || {}) as { inScopeJson?: string; outOfScopeJson?: string }
    const inn = parseJsonList(props.inScopeJson)
    const out = parseJsonList(props.outOfScopeJson)
    return (
      <div className="tdp-scope">
        <div className="tdp-scope-col">
          <p className="tdp-scope-h">In scope</p>
          <ul>
            {inn.map((x, i) => (
              <li key={i}>{x}</li>
            ))}
          </ul>
        </div>
        <div className="tdp-scope-col tdp-scope-col--out">
          <p className="tdp-scope-h">Out of scope</p>
          <ul>
            {out.map((x, i) => (
              <li key={i}>{x}</li>
            ))}
          </ul>
        </div>
      </div>
    )
  }

  if (type === 'diagram') {
    return <p className="tdp-diagram">[Diagram]</p>
  }

  return null
}

/** Static render of template blocks for marketplace cards + preview modal. */
export function TemplateDocPreview({ blocks, mode = 'full', className = '' }: TemplateDocPreviewProps) {
  const nodes = useMemo(() => {
    const source = mode === 'thumb' ? blocks.slice(0, 22) : blocks
    return groupBlocks(source)
  }, [blocks, mode])

  return (
    <div className={`tdp tdp--${mode} ${className}`.trim()}>
      {nodes.map((node, i) => {
        if (node.kind === 'ul') {
          return (
            <ul key={i} className="tdp-ul">
              {node.items.map((item, j) => (
                <li key={j}>{item}</li>
              ))}
            </ul>
          )
        }
        if (node.kind === 'ol') {
          return (
            <ol key={i} className="tdp-ol">
              {node.items.map((item, j) => (
                <li key={j}>{item}</li>
              ))}
            </ol>
          )
        }
        return <BlockView key={i} block={node.block} />
      })}
    </div>
  )
}
