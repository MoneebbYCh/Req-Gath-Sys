import type { DocumentIR, DocumentSection, IRBlock } from './DocumentIR'

/** Structural mirror of the webview's CanvasDocument (extension tsconfig excludes src/). */
export interface RenderedCanvasDocument {
  version: 1
  kind: 'blocknote'
  blocks: Array<Record<string, unknown>>
  anchors: Record<string, unknown>
}

/**
 * Deterministic DocumentIR → CanvasDocument renderer (plan §11). Produces the
 * codebase's canonical simplified BlockNote shapes (string content, custom
 * blocks as `rowsJson`/`inScopeJson` JSON props) — valid complete snapshots
 * only, never partial BlockNote JSON.
 */
export function renderDocument(ir: DocumentIR): RenderedCanvasDocument {
  const blocks: Array<Record<string, unknown>> = []

  if (ir.title.trim()) {
    blocks.push({ type: 'heading', props: { level: 1 }, content: ir.title.trim() })
  }

  for (const section of ir.sections) {
    blocks.push(...renderSection(section))
  }

  if (blocks.length === 0) {
    blocks.push({ type: 'paragraph', content: '' })
  }

  return {
    version: 1,
    kind: 'blocknote',
    blocks,
    anchors: {},
  }
}

function renderSection(section: DocumentSection): Array<Record<string, unknown>> {
  const blocks: Array<Record<string, unknown>> = [
    { type: 'heading', props: { level: 2 }, content: section.heading.trim() },
  ]
  for (const block of section.blocks) blocks.push(...renderBlock(block))
  if (section.blocks.length === 0) blocks.push({ type: 'paragraph', content: '' })
  return blocks
}

function renderBlock(block: IRBlock): Array<Record<string, unknown>> {
  switch (block.type) {
    case 'paragraph':
      return [{ type: 'paragraph', content: block.text }]
    case 'bullets':
      return block.items.map((item) => ({ type: 'bulletListItem', content: item }))
    case 'numbered':
      return block.items.map((item) => ({ type: 'numberedListItem', content: item }))
    case 'table':
      // ponytail: no plain-table block in the canvas schema — render rows as
      // labeled bullets. Revisit if table fidelity matters for users.
      return block.rows.map((row) => ({
        type: 'bulletListItem',
        content: block.header.map((h, i) => `${h}: ${row[i] ?? ''}`).join('  |  '),
      }))
    case 'callout':
      return [
        {
          type: 'callout',
          props: { variant: block.variant ?? 'info', title: block.title ?? '', anchorId: '' },
          content: block.text,
        },
      ]
    case 'mermaid':
      return [
        {
          type: 'diagram',
          props: { code: block.diagram.trim(), title: block.title ?? '', source: 'llm' },
        },
      ]
    case 'risk':
      return [
        {
          type: 'riskList',
          props: {
            rowsJson: JSON.stringify(
              block.rows.map((r) => ({
                risk: r.risk,
                likelihood: r.likelihood ?? '',
                impact: r.impact ?? '',
                mitigation: r.mitigation ?? '',
              })),
            ),
          },
        },
      ]
    case 'scope':
      return [
        {
          type: 'scopeBounds',
          props: {
            inScopeJson: JSON.stringify(block.inScope),
            outOfScopeJson: JSON.stringify(block.outOfScope),
          },
        },
      ]
    case 'kpiGrid':
      return [
        {
          type: 'kpiGrid',
          props: {
            itemsJson: JSON.stringify(
              block.items.map((i) => ({ metric: i.metric, target: i.target ?? '', method: i.method ?? '' })),
            ),
          },
        },
      ]
    case 'stakeholderTable':
      return [
        {
          type: 'stakeholderTable',
          props: {
            rowsJson: JSON.stringify(
              block.rows.map((r) => ({
                nameRole: r.nameRole,
                interest: r.interest ?? '',
                influence: r.influence ?? '',
                concern: r.concern ?? '',
              })),
            ),
          },
        },
      ]
  }
}
