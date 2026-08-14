import { describe, expect, it } from 'vitest'
import {
  captureAiChatContext,
  resolveAiChatPlan,
  type BlockLike,
} from './aiChatCore'
import type { AiChatContextPayload } from '../../../extension/protocol'

function block(id: string, type = 'paragraph', content: unknown = '', props: Record<string, unknown> = {}): BlockLike {
  return { id, type, content, props }
}

const DOC = [
  block('h-intro', 'heading', 'Intro', { level: 1 }),
  block('p1', 'paragraph', 'First paragraph about strategy.'),
  block('p2', 'paragraph', 'Second paragraph about customers.'),
  block('h-body', 'heading', 'Body', { level: 2 }),
  block('p3', 'paragraph', 'Third paragraph about enterprise.'),
  block('p4', 'paragraph', 'Fourth paragraph about pricing.'),
]

describe('captureAiChatContext', () => {
  it('captures cursor block, prev/next neighbors, and section for a mid-doc invocation', () => {
    const ctx = captureAiChatContext(DOC, 'p2', null, Date.now())
    expect(ctx.cursorBlock?.id).toBe('p2')
    expect(ctx.cursorBlock?.text).toBe('Second paragraph about customers.')
    expect(ctx.prevBlock?.id).toBe('p1')
    expect(ctx.nextBlock?.id).toBe('h-body')
    // Section = blocks strictly between the two headings.
    expect(ctx.section?.blockIds).toEqual(['p1', 'p2'])
    expect(ctx.section?.markdown).toContain('First paragraph')
    expect(ctx.section?.markdown).toContain('Second paragraph')
    expect(ctx.headings).toEqual(['Intro', 'Body'])
    expect(ctx.blank).toBe(false)
    expect(ctx.docMarkdown).toContain('First paragraph')
    expect(ctx.docMarkdown).toContain('Fourth paragraph')
  })

  it('strips a single trailing slash from the cursor block (the trigger character)', () => {
    const doc = [block('a', 'paragraph', 'Hello/'), block('b', 'paragraph', 'World')]
    const ctx = captureAiChatContext(doc, 'a', null, Date.now())
    expect(ctx.cursorBlock?.text).toBe('Hello')
  })

  it('uses the captured selection only when the slash replaced it entirely', () => {
    const doc = [block('s1', 'paragraph', '/'), block('s2', 'paragraph', 'Selected text.')]
    const sel = { blockIds: ['s1', 's2'], capturedAt: Date.now() }
    const ctx = captureAiChatContext(doc, 's1', sel, Date.now())
    expect(ctx.selection?.blockIds).toEqual(['s1', 's2'])
    expect(ctx.selection?.markdown).toContain('Selected text.')
  })

  it('ignores a captured selection when the cursor block still has other text (mid-word slash)', () => {
    const doc = [block('s1', 'paragraph', 'budget/'), block('s2', 'paragraph', 'Selected text.')]
    const sel = { blockIds: ['s1', 's2'], capturedAt: Date.now() }
    const ctx = captureAiChatContext(doc, 's1', sel, Date.now())
    expect(ctx.selection).toBeUndefined()
    expect(ctx.cursorBlock?.text).toBe('budget')
  })

  it('ignores a stale captured selection', () => {
    const doc = [block('s1', 'paragraph', '/'), block('s2', 'paragraph', 'Selected text.')]
    const sel = { blockIds: ['s1', 's2'], capturedAt: Date.now() - 60_000 }
    const ctx = captureAiChatContext(doc, 's1', sel, Date.now())
    expect(ctx.selection).toBeUndefined()
  })

  it('trusts a fresh selection even when the cursor text is intact (blip path)', () => {
    // Blip: the user selected text and clicked Ask AI — nothing was typed over it,
    // so the cursor block still holds the selected paragraph.
    const doc = [block('p1', 'paragraph', 'Selected paragraph.'), block('p2', 'paragraph', 'Next.')]
    const sel = { blockIds: ['p1'], capturedAt: Date.now() }
    const ctx = captureAiChatContext(doc, 'p1', sel, Date.now(), { trustSelection: true })
    expect(ctx.selection?.blockIds).toEqual(['p1'])
    expect(ctx.selection?.markdown).toContain('Selected paragraph.')
    expect(ctx.cursorBlock?.id).toBe('p1')
    expect(ctx.cursorBlock?.text).toBe('Selected paragraph.')
  })

  it('still requires freshness for a trusted selection (blip path)', () => {
    const doc = [block('p1', 'paragraph', 'Selected paragraph.')]
    const sel = { blockIds: ['p1'], capturedAt: Date.now() - 60_000 }
    const ctx = captureAiChatContext(doc, 'p1', sel, Date.now(), { trustSelection: true })
    expect(ctx.selection).toBeUndefined()
  })

  it('computes the section between heading boundaries when invoked inside a heading', () => {
    const doc = [
      block('h1', 'heading', 'Top', { level: 1 }),
      block('pA', 'paragraph', 'Alpha'),
      block('h2', 'heading', 'Mid', { level: 2 }),
      block('pB', 'paragraph', 'Beta'),
      block('pC', 'paragraph', 'Gamma'),
    ]
    const ctx = captureAiChatContext(doc, 'h2', null, Date.now())
    expect(ctx.section?.blockIds).toEqual(['pB', 'pC'])
    expect(ctx.section?.markdown).toContain('Beta')
    expect(ctx.section?.markdown).toContain('Gamma')
  })

  it('treats a doc without headings as one section', () => {
    const doc = [block('a', 'paragraph', 'One'), block('b', 'paragraph', 'Two')]
    const ctx = captureAiChatContext(doc, 'a', null, Date.now())
    expect(ctx.section?.blockIds).toEqual(['a', 'b'])
  })

  it('serializes shape blocks (KPI grid) so the model sees their content', () => {
    const doc = [
      block('k', 'kpiGrid', undefined, { itemsJson: JSON.stringify([{ metric: 'Revenue', target: '2x' }]) }),
      block('p', 'paragraph', 'After the grid.'),
    ]
    const ctx = captureAiChatContext(doc, 'p', null, Date.now())
    expect(ctx.docMarkdown).toContain('Revenue')
    expect(ctx.docMarkdown).toContain('2x')
    expect(ctx.section?.markdown).toContain('Revenue')
  })

  it('truncates the document markdown but keeps head and tail', () => {
    const big = Array.from({ length: 200 }, (_, i) => block(`b${i}`, 'paragraph', `Line number ${i}`))
    const ctx = captureAiChatContext(big, 'b100', null, Date.now(), { docMaxChars: 500 })
    expect(ctx.docMarkdown.length).toBeLessThanOrEqual(500 + 40)
    expect(ctx.docMarkdown.startsWith('Line number 0')).toBe(true)
    expect(ctx.docMarkdown).toContain('Line number 199')
    expect(ctx.docMarkdown).toContain('truncated')
  })

  it('marks a blank document', () => {
    const doc = [block('e', 'paragraph', '')]
    const ctx = captureAiChatContext(doc, 'e', null, Date.now())
    expect(ctx.blank).toBe(true)
    expect(ctx.docMarkdown.trim()).toBe('')
    expect(ctx.section).toBeNull()
  })
})

describe('resolveAiChatPlan', () => {
  const ctx: AiChatContextPayload = {
    selection: { blockIds: ['s1'], markdown: 'Selected' },
    cursorBlock: { id: 'c1', text: 'Cursor text' },
    prevBlock: { id: 'p0', text: 'Prev' },
    nextBlock: { id: 'n0', text: '' },
    section: { blockIds: ['c1', 'n0'], markdown: 'Section' },
    headings: [],
    docMarkdown: 'doc',
    blank: false,
  }
  const live = (ids: string[]) => ids.map((id) => ({ id }))

  it('modify targets the selection first', () => {
    const plan = resolveAiChatPlan({ kind: 'modify', target: 'selection' }, ctx, 'chat', { liveBlocks: live(['s1', 'c1']) })
    expect(plan.removeIds).toEqual(['s1'])
    expect(plan.mode).toBe('replace')
    expect(plan.insertAfterId).toBeNull()
  })

  it('modify cursor also removes the empty split-tail block', () => {
    const plan = resolveAiChatPlan({ kind: 'modify', target: 'cursor' }, ctx, 'chat', { liveBlocks: live(['c1', 'n0']) })
    expect(plan.removeIds).toEqual(['c1', 'n0'])
  })

  it('upgrades a cursor-targeted modify to the selection when the cursor is inside it', () => {
    // Model fell back to the caret block (last selected paragraph) despite the
    // selection: the user's pointer is the whole selection, never just the caret.
    const selCtx: AiChatContextPayload = {
      ...ctx,
      selection: { blockIds: ['c1', 's1'], markdown: 'Both paragraphs selected' },
    }
    const plan = resolveAiChatPlan({ kind: 'modify', target: 'cursor' }, selCtx, 'chat', {
      liveBlocks: live(['c1', 's1', 'n0']),
    })
    expect(plan.mode).toBe('replace')
    expect(plan.removeIds).toEqual(['c1', 's1'])
    expect(plan.note).toMatch(/selection/i)
  })

  it('keeps the cursor target when the cursor is outside the selection', () => {
    const outside: AiChatContextPayload = { ...ctx, cursorBlock: { id: 'x1', text: 'Elsewhere' } }
    const plan = resolveAiChatPlan({ kind: 'modify', target: 'cursor' }, outside, 'chat', {
      liveBlocks: live(['x1', 's1']),
    })
    expect(plan.removeIds).toEqual(['x1'])
  })

  it('modify cursor keeps a non-empty following block (real paragraph)', () => {
    const withText: AiChatContextPayload = { ...ctx, nextBlock: { id: 'n0', text: 'Real paragraph' } }
    const plan = resolveAiChatPlan({ kind: 'modify', target: 'cursor' }, withText, 'chat', { liveBlocks: live(['c1', 'n0']) })
    expect(plan.removeIds).toEqual(['c1'])
  })

  it('falls back to insert-after when the target is gone or no target exists', () => {
    const plan = resolveAiChatPlan({ kind: 'modify', target: 'section' }, ctx, 'chat', { liveBlocks: live(['zzz']) })
    expect(plan.mode).toBe('after-chat')
    expect(plan.insertAfterId).toBe('chat')
    expect(plan.removeIds).toEqual([])
  })

  it('never clobbers a cursor block the user edited while generating', () => {
    const plan = resolveAiChatPlan({ kind: 'modify', target: 'cursor' }, ctx, 'chat', {
      liveBlocks: live(['c1', 'n0']),
      cursorLiveText: 'Cursor text, but edited by the user',
    })
    expect(plan.mode).toBe('after-chat')
    expect(plan.removeIds).toEqual([])
    expect(plan.note).toMatch(/changed/i)
  })

  it('insert places new content after the chat block', () => {
    const plan = resolveAiChatPlan({ kind: 'insert' }, ctx, 'chat', { liveBlocks: live(['c1']) })
    expect(plan.mode).toBe('after-chat')
    expect(plan.insertAfterId).toBe('chat')
    expect(plan.removeIds).toEqual([])
  })

  it('answers and clarifications produce no document plan', () => {
    expect(resolveAiChatPlan({ kind: 'answer' }, ctx, 'chat', { liveBlocks: live(['c1']) }).mode).toBe('none')
    expect(resolveAiChatPlan({ kind: 'clarify' }, ctx, 'chat', { liveBlocks: live(['c1']) }).mode).toBe('none')
  })
})
