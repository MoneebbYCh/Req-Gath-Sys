import { describe, expect, it } from 'vitest'
import { markdownToCanvasBlocks, type CanvasInline } from './mdastToCanvas'

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return (content as CanvasInline[])
    .map((c) => (c.type === 'text' ? c.text : textOf(c.content)))
    .join('')
}

describe('markdownToCanvasBlocks', () => {
  it('maps paragraphs and unordered lists', () => {
    const blocks = markdownToCanvasBlocks('Hello.\n\n- a\n- b')
    expect(blocks[0]).toMatchObject({ type: 'paragraph' })
    expect(textOf(blocks[0].content)).toBe('Hello.')
    expect(blocks.filter((b) => b.type === 'bulletListItem')).toHaveLength(2)
    expect(textOf(blocks[1].content)).toBe('a')
  })

  it('nests list items via children', () => {
    const blocks = markdownToCanvasBlocks('- parent\n  - child\n  - child2')
    expect(blocks).toHaveLength(1)
    expect(blocks[0].type).toBe('bulletListItem')
    expect(textOf(blocks[0].content)).toBe('parent')
    expect(blocks[0].children).toHaveLength(2)
    expect(blocks[0].children![0].type).toBe('bulletListItem')
    expect(textOf(blocks[0].children![0].content)).toBe('child')
  })

  it('maps every in-prose heading to level 3', () => {
    const blocks = markdownToCanvasBlocks('# One\n\n## Two\n\n### Three')
    const headings = blocks.filter((b) => b.type === 'heading')
    expect(headings).toHaveLength(3)
    expect(headings.every((h) => h.props?.level === 3)).toBe(true)
  })

  it('maps GFM tables with rich cell inlines', () => {
    const blocks = markdownToCanvasBlocks('| A | B |\n| --- | --- |\n| **x** | y |')
    expect(blocks).toHaveLength(1)
    expect(blocks[0].type).toBe('table')
    const rows = (blocks[0].content as { rows: { cells: CanvasInline[][] }[] }).rows
    expect(rows).toHaveLength(2)
    const boldCell = rows[1].cells[0]
    expect(boldCell.some((c) => c.type === 'text' && c.styles.bold && c.text === 'x')).toBe(true)
  })

  it('maps code fences and blockquotes', () => {
    const blocks = markdownToCanvasBlocks('```ts\nconst x = 1\n```\n\n> quoted')
    expect(blocks).toContainEqual({
      type: 'codeBlock',
      props: { language: 'ts' },
      content: 'const x = 1',
    })
    expect(blocks).toContainEqual({ type: 'quote', content: 'quoted' })
  })

  it('preserves bold and italic in paragraphs', () => {
    const blocks = markdownToCanvasBlocks('Say **hi** and *bye*')
    const inlines = blocks[0].content as CanvasInline[]
    expect(inlines.some((c) => c.type === 'text' && c.styles.bold && c.text === 'hi')).toBe(true)
    expect(inlines.some((c) => c.type === 'text' && c.styles.italic && c.text === 'bye')).toBe(true)
  })
})
