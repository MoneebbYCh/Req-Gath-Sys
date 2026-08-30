import { describe, expect, it } from 'vitest'
import { canvasToMarkdown } from './exportMarkdown'
import type { BlockNoteBlock } from '../types/document'

function doc(blocks: BlockNoteBlock[]) {
  return { version: 1 as const, kind: 'blocknote' as const, blocks, anchors: {} }
}

describe('canvasToMarkdown', () => {
  it('renders headings with level-based prefixes', () => {
    expect(
      canvasToMarkdown(
        doc([
          { type: 'heading', props: { level: 1 }, content: 'Title' },
          { type: 'heading', props: { level: 2 }, content: 'Section' },
          { type: 'heading', props: { level: 3 }, content: 'Sub' },
        ]),
      ),
    ).toBe('# Title\n\n## Section\n\n### Sub')
  })

  it('clamps heading levels above 3', () => {
    expect(
      canvasToMarkdown(doc([{ type: 'heading', props: { level: 6 }, content: 'Deep' }])),
    ).toBe('### Deep')
  })

  it('renders paragraph string content', () => {
    expect(canvasToMarkdown(doc([{ type: 'paragraph', content: 'hello' }]))).toBe('hello')
  })

  it('extracts text from inline content arrays', () => {
    expect(
      canvasToMarkdown(
        doc([
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: 'Hello ' },
              { type: 'text', text: 'world', styles: { bold: true } },
            ],
          },
        ]),
      ),
    ).toBe('Hello world')
  })

  it('renders bullet, numbered, and checklist items', () => {
    expect(
      canvasToMarkdown(
        doc([
          { type: 'bulletListItem', content: 'one' },
          { type: 'numberedListItem', content: 'two' },
          { type: 'checkListItem', content: 'done', props: { checked: true } },
          { type: 'checkListItem', content: 'todo', props: { checked: false } },
        ]),
      ),
    ).toBe('- one\n\n1. two\n\n- [x] done\n\n- [ ] todo')
  })

  it('renders callout as a blockquote with bold title', () => {
    expect(
      canvasToMarkdown(
        doc([{ type: 'callout', props: { variant: 'warn', title: 'Heads up' }, content: 'Watch out' }]),
      ),
    ).toBe('> **Heads up**\n>\n> Watch out')
  })

  it('renders callout without title', () => {
    expect(
      canvasToMarkdown(doc([{ type: 'callout', props: { variant: 'info' }, content: 'Note' }])),
    ).toBe('> **Callout**\n>\n> Note')
  })

  it('renders kpiGrid as a table', () => {
    expect(
      canvasToMarkdown(
        doc([
          {
            type: 'kpiGrid',
            props: { items: [{ metric: 'Uptime', target: '99.9%', method: 'ping' }] },
          },
        ]),
      ),
    ).toBe('| Metric | Target | Method |\n| --- | --- | --- |\n| Uptime | 99.9% | ping |')
  })

  it('renders scopeBounds with in/out lists, omitting empty sections', () => {
    expect(
      canvasToMarkdown(
        doc([{ type: 'scopeBounds', props: { inScope: ['a', 'b'], outOfScope: ['c'] } }]),
      ),
    ).toBe('**In scope**\n\n- a\n- b\n\n**Out of scope**\n\n- c')
    expect(
      canvasToMarkdown(doc([{ type: 'scopeBounds', props: { inScope: ['a'], outOfScope: [] } }])),
    ).toBe('**In scope**\n\n- a')
  })

  it('renders stakeholderTable as a table', () => {
    expect(
      canvasToMarkdown(
        doc([
          {
            type: 'stakeholderTable',
            props: { rows: [{ nameRole: 'Jane / PM', interest: 'H', influence: 'M', concern: 'schedule' }] },
          },
        ]),
      ),
    ).toBe(
      '| Name / Role | Interest | Influence | Concern |\n| --- | --- | --- | --- |\n| Jane / PM | H | M | schedule |',
    )
  })

  it('renders riskList as a table', () => {
    expect(
      canvasToMarkdown(
        doc([
          {
            type: 'riskList',
            props: { rows: [{ risk: 'Late deps', likelihood: 'M', impact: 'H', mitigation: 'buffer' }] },
          },
        ]),
      ),
    ).toBe(
      '| Risk | Likelihood | Impact | Mitigation |\n| --- | --- | --- | --- |\n| Late deps | M | H | buffer |',
    )
  })

  it('renders diagram as a mermaid fence', () => {
    expect(
      canvasToMarkdown(
        doc([
          { type: 'diagram', props: { code: 'flowchart TD\n  A --> B', title: 'Flow' } },
        ]),
      ),
    ).toBe('```mermaid\nflowchart TD\n  A --> B\n```')
  })

  it('renders native table, codeBlock, and quote', () => {
    expect(
      canvasToMarkdown(
        doc([
          {
            type: 'table',
            content: {
              type: 'tableContent',
              rows: [{ cells: ['A', 'B'] }, { cells: ['1', '2'] }],
            },
          },
          { type: 'codeBlock', props: { language: 'ts' }, content: 'const x = 1' },
          { type: 'quote', content: 'cited' },
        ]),
      ),
    ).toBe('| A | B |\n| --- | --- |\n| 1 | 2 |\n\n```ts\nconst x = 1\n```\n\n> cited')
  })

  it('skips unknown blocks', () => {
    expect(
      canvasToMarkdown(
        doc([
          { type: 'paragraph', content: 'kept' },
          { type: 'mystery', props: { anything: 1 } },
        ]),
      ),
    ).toBe('kept')
  })

  it('returns empty string for no blocks', () => {
    expect(canvasToMarkdown(doc([]))).toBe('')
  })

  it('does not throw on malformed props', () => {
    expect(() =>
      canvasToMarkdown(
        doc([
          { type: 'kpiGrid', props: null },
          { type: 'riskList', props: { rows: 'not-an-array' } },
          { type: 'diagram', props: { code: 42 } },
        ]),
      ),
    ).not.toThrow()
  })
})