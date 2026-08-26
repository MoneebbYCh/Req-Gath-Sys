import type { BlockNoteBlock } from '../types/document'

/** A selectable starting point for a canvas document. */
export interface DocTemplate {
  id: string
  name: string
  /** Short origin label shown as a badge, e.g. "Blank" or "Saved". */
  category: string
  /** One-line pitch shown in the card. */
  tagline: string
  /** Longer blurb shown in the preview pane. */
  description: string
  /** Whether this is the empty "start from scratch" option. */
  custom?: boolean
  /** Produces the block set applied to the canvas. */
  build: () => BlockNoteBlock[]
}

/** @deprecated Prefer DocTemplate — kept for existing imports. */
export type CharterTemplate = DocTemplate

const para = (text = ''): BlockNoteBlock => ({
  type: 'paragraph',
  content: text ? [{ type: 'text', text }] : [],
})

/** The "build it myself" option — an empty canvas. */
export const BLANK_TEMPLATE: DocTemplate = {
  id: 'custom',
  name: 'Build from scratch',
  category: 'Blank',
  tagline: 'Start with an empty canvas and craft it exactly how you want.',
  description:
    'A blank document. Use the tools sidebar (or type "/") to add headings, callouts, KPI grids, scope bounds, stakeholder tables, risk lists, and diagrams as you go.',
  custom: true,
  build: () => [para('')],
}

/** @deprecated Prefer BLANK_TEMPLATE */
export const CUSTOM_CHARTER_TEMPLATE = BLANK_TEMPLATE

/** A readable section outline for previewing a template without rendering the editor. */
export function templateOutline(template: DocTemplate): string[] {
  const shapeLabels: Record<string, string> = {
    callout: 'Callout',
    kpiGrid: 'KPI grid',
    scopeBounds: 'Scope bounds',
    stakeholderTable: 'Stakeholder table',
    riskList: 'Risk list',
    diagram: 'Diagram',
  }
  const outline: string[] = []
  for (const block of template.build()) {
    const type = String(block.type || '')
    if (type === 'heading') {
      const content = block.content
      let text = ''
      if (typeof content === 'string') text = content
      else if (Array.isArray(content)) {
        text = content
          .map((c) => {
            if (typeof c === 'string') return c
            if (c && typeof c === 'object' && 'text' in c) return String((c as { text: unknown }).text)
            return ''
          })
          .join('')
      }
      if (text.trim()) outline.push(text.trim())
    } else if (shapeLabels[type]) {
      outline.push(shapeLabels[type])
    }
  }
  return outline
}
