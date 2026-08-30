import { describe, expect, it } from 'vitest'
import { sanitizeBlock, sanitizeBlockList, sanitizePartsList } from './blockSanitize'

describe('sanitizeBlock', () => {
  it('normalizes callout variant aliases and trims text', () => {
    const block = sanitizeBlock({ type: 'callout', text: '  watch out  ', variant: 'warning' })
    expect(block).toEqual({ type: 'callout', text: 'watch out', variant: 'warn' })
  })

  it('drops an empty callout', () => {
    expect(sanitizeBlock({ type: 'callout', text: '   ' })).toBeNull()
  })

  it('strips mermaid fences, quotes label specials, and keeps titles', () => {
    const block = sanitizeBlock({
      type: 'mermaid',
      diagram: '```mermaid\nflowchart TD\n  A[GET /users/{id}] --> B\n```',
      title: 'Flow',
    })
    expect(block).toEqual({
      type: 'mermaid',
      diagram: 'flowchart TD\n  A["GET /users/{id}"] --> B',
      title: 'Flow',
    })
  })

  it('pads ragged table rows to header width and drops empty rows', () => {
    const block = sanitizeBlock({
      type: 'table',
      header: ['A', 'B', 'C'],
      rows: [['1'], ['2', '3', '4', '5'], ['', '', '']],
    })
    expect(block).toEqual({
      type: 'table',
      header: ['A', 'B', 'C'],
      rows: [['1', '', ''], ['2', '3', '4']],
    })
  })

  it('normalizes risk levels and drops rows without a risk', () => {
    const block = sanitizeBlock({
      type: 'risk',
      rows: [
        { risk: 'Leak', likelihood: 'High', impact: 'low' },
        { risk: ' ', likelihood: 'M' },
      ],
    })
    expect(block).toEqual({ type: 'risk', rows: [{ risk: 'Leak', likelihood: 'H', impact: 'L' }] })
  })

  it('drops kpiGrid items without a metric', () => {
    const block = sanitizeBlock({
      type: 'kpiGrid',
      items: [{ metric: 'Latency', target: '<100ms' }, { target: 'no metric' }],
    })
    expect(block).toEqual({ type: 'kpiGrid', items: [{ metric: 'Latency', target: '<100ms' }] })
  })

  it('drops empty scope strings', () => {
    const block = sanitizeBlock({ type: 'scope', inScope: ['X', ' '], outOfScope: ['', 'Y'] })
    expect(block).toEqual({ type: 'scope', inScope: ['X'], outOfScope: ['Y'] })
  })

  it('normalizes stakeholder levels and drops rows without nameRole', () => {
    const block = sanitizeBlock({
      type: 'stakeholderTable',
      rows: [
        { nameRole: 'SecOps', interest: 'high' },
        { concern: 'orphaned' },
      ],
    })
    expect(block).toEqual({ type: 'stakeholderTable', rows: [{ nameRole: 'SecOps', interest: 'H' }] })
  })

  it('trims list items and drops empties', () => {
    expect(sanitizeBlock({ type: 'bullets', items: [' a ', ' ', 'b'] })).toEqual({
      type: 'bullets',
      items: ['a', 'b'],
    })
    expect(sanitizeBlock({ type: 'numbered', items: [] })).toBeNull()
  })

  it('trims paragraphs and rejects empty ones', () => {
    expect(sanitizeBlock({ type: 'paragraph', text: ' hi ' })).toEqual({ type: 'paragraph', text: 'hi' })
    expect(sanitizeBlock({ type: 'paragraph', text: '' })).toBeNull()
  })

  it('normalizes markdown source and rejects empty', () => {
    expect(sanitizeBlock({ type: 'markdown', source: '  Hello\n• item  ' })).toEqual({
      type: 'markdown',
      source: 'Hello\n\n- item',
    })
    expect(sanitizeBlock({ type: 'markdown', source: '   ' })).toBeNull()
  })

  it('returns null for unknown or hopeless shapes', () => {
    expect(sanitizeBlock({ type: 'gizmo' })).toBeNull()
    expect(sanitizeBlock('nope')).toBeNull()
    expect(sanitizeBlock(null)).toBeNull()
    expect(sanitizeBlock({ type: 'table', header: 'x', rows: [] })).toBeNull()
  })
})

describe('sanitizeBlockList', () => {
  it('keeps valid blocks and coerces hopeless ones into editable callouts', () => {
    const result = sanitizeBlockList({
      blocks: [
        { type: 'paragraph', text: 'ok' },
        { type: 'unknown' },
        { type: 'callout', text: 'c', variant: 'danger' },
      ],
    })
    expect(result?.blocks).toEqual([
      { type: 'paragraph', text: 'ok' },
      { type: 'callout', variant: 'warn', title: 'Unsupported content', text: '{"type":"unknown"}' },
      { type: 'callout', text: 'c', variant: 'error' },
    ])
    expect(result?.coerced).toBe(1)
  })

  it('returns null when the payload is malformed or has no blocks', () => {
    expect(sanitizeBlockList({ nope: [] })).toBeNull()
    expect(sanitizeBlockList('x')).toBeNull()
    expect(sanitizeBlockList({ blocks: [] })).toBeNull()
  })
})

describe('sanitizePartsList', () => {
  it('maps md parts to markdown IR and keeps widgets', () => {
    const result = sanitizePartsList({
      parts: [
        { md: 'Hello\n\n- a\n- b' },
        { type: 'callout', text: 'Note', variant: 'info' },
      ],
    })
    expect(result?.blocks).toEqual([
      { type: 'markdown', source: 'Hello\n\n- a\n- b' },
      { type: 'callout', text: 'Note', variant: 'info' },
    ])
    expect(result?.coerced).toBe(0)
  })

  it('returns null for missing parts', () => {
    expect(sanitizePartsList({ blocks: [] })).toBeNull()
    expect(sanitizePartsList({ parts: [] })).toBeNull()
  })
})
