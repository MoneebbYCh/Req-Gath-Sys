import { z } from 'zod'

/**
 * Deterministic document intermediate representation (plan §11). The model
 * never produces BlockNote internals directly — it emits this validated IR
 * and `DocumentRenderer` converts it to a complete CanvasDocument snapshot.
 * Every checkpoint is a FULL valid document, never a partial JSON fragment.
 */

export type CalloutVariant = 'info' | 'warn' | 'success' | 'error'

export type IRBlock =
  | { type: 'paragraph'; text: string }
  | { type: 'bullets'; items: string[] }
  | { type: 'numbered'; items: string[] }
  | { type: 'table'; header: string[]; rows: string[][] }
  | { type: 'callout'; text: string; variant?: CalloutVariant; title?: string }
  | { type: 'mermaid'; diagram: string; title?: string }
  | { type: 'risk'; rows: Array<{ risk: string; likelihood?: string; impact?: string; mitigation?: string }> }
  | { type: 'scope'; inScope: string[]; outOfScope: string[] }

export interface DocumentSection {
  heading: string
  blocks: IRBlock[]
}

export interface DocumentIR {
  title: string
  sections: DocumentSection[]
}

const textBlock = z.object({ type: z.literal('paragraph'), text: z.string().max(8_000) })
const bulletsBlock = z.object({
  type: z.literal('bullets'),
  items: z.array(z.string().max(1_000)).max(40),
})
const numberedBlock = z.object({
  type: z.literal('numbered'),
  items: z.array(z.string().max(1_000)).max(40),
})
const tableBlock = z.object({
  type: z.literal('table'),
  header: z.array(z.string().max(200)).max(8),
  rows: z.array(z.array(z.string().max(500)).max(8)).max(40),
})
const calloutBlock = z.object({
  type: z.literal('callout'),
  text: z.string().max(2_000),
  variant: z.enum(['info', 'warn', 'success', 'error']).optional(),
  title: z.string().max(200).optional(),
})
const mermaidBlock = z.object({
  type: z.literal('mermaid'),
  diagram: z.string().max(10_000),
  title: z.string().max(200).optional(),
})
const riskBlock = z.object({
  type: z.literal('risk'),
  rows: z
    .array(
      z.object({
        risk: z.string().max(500),
        likelihood: z.string().max(50).optional(),
        impact: z.string().max(50).optional(),
        mitigation: z.string().max(1_000).optional(),
      }),
    )
    .max(40),
})
const scopeBlock = z.object({
  type: z.literal('scope'),
  inScope: z.array(z.string().max(1_000)).max(40),
  outOfScope: z.array(z.string().max(1_000)).max(40),
})

export const irBlockSchema = z.discriminatedUnion('type', [
  textBlock,
  bulletsBlock,
  numberedBlock,
  tableBlock,
  calloutBlock,
  mermaidBlock,
  riskBlock,
  scopeBlock,
])

export const documentSectionSchema = z.object({
  heading: z.string().min(1).max(300),
  blocks: z.array(irBlockSchema).max(60),
})

export const documentIrSchema = z.object({
  title: z.string().min(1).max(300),
  sections: z.array(documentSectionSchema).max(40),
})
