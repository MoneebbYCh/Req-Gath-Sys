import { describe, expect, it } from 'vitest'
import { renderDocument } from './DocumentRenderer'
import { documentIrSchema, type DocumentIR } from './DocumentIR'

const ir = (sections: DocumentIR['sections']): DocumentIR => ({ title: 'Test Doc', sections })

describe('DocumentRenderer', () => {
  it('renders title + section headings + paragraphs', () => {
    const canvas = renderDocument(
      ir([{ heading: 'Overview', blocks: [{ type: 'paragraph', text: 'Hello world.' }] }]),
    )
    expect(canvas.kind).toBe('blocknote')
    expect(canvas.blocks).toEqual([
      { type: 'heading', props: { level: 1 }, content: 'Test Doc' },
      { type: 'heading', props: { level: 2 }, content: 'Overview' },
      { type: 'paragraph', content: 'Hello world.' },
    ])
  })

  it('renders lists as bulletListItem/numberedListItem blocks', () => {
    const canvas = renderDocument(
      ir([
        {
          heading: 'Lists',
          blocks: [
            { type: 'bullets', items: ['a', 'b'] },
            { type: 'numbered', items: ['1', '2'] },
          ],
        },
      ]),
    )
    const types = canvas.blocks.map((b) => b.type)
    expect(types).toContain('bulletListItem')
    expect(types).toContain('numberedListItem')
    expect(canvas.blocks.filter((b) => b.type === 'bulletListItem')).toHaveLength(2)
  })

  it('renders custom blocks in canonical prop shapes (rowsJson/inScopeJson)', () => {
    const canvas = renderDocument(
      ir([
        {
          heading: 'Risks',
          blocks: [
            {
              type: 'risk',
              rows: [{ risk: 'Late deps', likelihood: 'M', impact: 'H', mitigation: 'buffer' }],
            },
            { type: 'scope', inScope: ['a'], outOfScope: ['b'] },
            { type: 'mermaid', diagram: 'flowchart TD\n  A --> B', title: 'Flow' },
            { type: 'callout', text: 'Note', variant: 'warn', title: 'Heads up' },
          ],
        },
      ]),
    )
    expect(canvas.blocks).toContainEqual({
      type: 'riskList',
      props: { rowsJson: JSON.stringify([{ risk: 'Late deps', likelihood: 'M', impact: 'H', mitigation: 'buffer' }]) },
    })
    expect(canvas.blocks).toContainEqual({
      type: 'scopeBounds',
      props: { inScopeJson: '["a"]', outOfScopeJson: '["b"]' },
    })
    expect(canvas.blocks).toContainEqual({
      type: 'diagram',
      props: { code: 'flowchart TD\n  A --> B', title: 'Flow', source: 'llm' },
    })
    expect(canvas.blocks).toContainEqual({
      type: 'callout',
      props: { variant: 'warn', title: 'Heads up', anchorId: '' },
      content: 'Note',
    })
  })

  it('renders kpiGrid and stakeholderTable blocks in canonical prop shapes', () => {
    const canvas = renderDocument(
      ir([
        {
          heading: 'Plan',
          blocks: [
            {
              type: 'kpiGrid',
              items: [{ metric: 'Uptime', target: '99.9%', method: 'SLA dashboards' }],
            },
            {
              type: 'stakeholderTable',
              rows: [{ nameRole: 'Eng lead', interest: 'H', influence: 'M', concern: 'scope creep' }],
            },
          ],
        },
      ]),
    )
    expect(canvas.blocks).toContainEqual({
      type: 'kpiGrid',
      props: { itemsJson: JSON.stringify([{ metric: 'Uptime', target: '99.9%', method: 'SLA dashboards' }]) },
    })
    expect(canvas.blocks).toContainEqual({
      type: 'stakeholderTable',
      props: { rowsJson: JSON.stringify([{ nameRole: 'Eng lead', interest: 'H', influence: 'M', concern: 'scope creep' }]) },
    })
  })

  it('renders empty documents as a single empty paragraph (always a valid canvas)', () => {
    const canvas = renderDocument({ title: '', sections: [] })
    expect(canvas.blocks).toEqual([{ type: 'paragraph', content: '' }])
  })

  it('schema accepts a full IR and rejects invalid block types', () => {
    expect(documentIrSchema.parse(ir([{ heading: 'x', blocks: [{ type: 'bullets', items: [] }] }]))).toBeTruthy()
    expect(() =>
      documentIrSchema.parse({
        title: 'x',
        sections: [{ heading: 'x', blocks: [{ type: 'rm -rf', text: '' }] }],
      }),
    ).toThrow()
  })
})
