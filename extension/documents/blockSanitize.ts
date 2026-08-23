import { irBlockSchema, type CalloutVariant, type IRBlock } from './DocumentIR'
import { sanitizeMermaidLabels } from '../../shared/mermaidSanitize'

/**
 * Deterministic, LLM-tolerant block sanitation. The model is asked for a
 * precise JSON shape, but minor deviations (variant aliases, ragged table
 * rows, fence-wrapped diagrams, empty items, out-of-range enum casing) must
 * not wipe an otherwise valid block or document. Every block emitted by the
 * model passes through here before zod validation; hopeless shapes return
 * null and the caller's salvage path handles them.
 */

const FENCE = /^```(?:mermaid)?\s*([\s\S]*?)\s*```$/i

const LIMITS = {
  paragraph: 8_000,
  listItems: 1_000,
  listMax: 40,
  tableHeader: 200,
  tableCell: 500,
  tableCols: 8,
  tableRows: 40,
  calloutText: 2_000,
  calloutTitle: 200,
  mermaidDiagram: 10_000,
  blockTitle: 200,
  riskText: 500,
  riskLevel: 50,
  riskMitigation: 1_000,
  rowsMax: 40,
  scopeItem: 1_000,
  scopeMax: 40,
  kpiMetric: 200,
  kpiMax: 40,
  stakeholderName: 200,
  stakeholderLevel: 20,
  stakeholderConcern: 500,
}

function string(raw: unknown): string | undefined {
  return typeof raw === 'string' ? raw : undefined
}

function clean(value: unknown, max: number): string | undefined {
  const s = string(value)
  if (s === undefined) return undefined
  const trimmed = s.trim()
  return trimmed ? trimmed.slice(0, max) : undefined
}

function cleanList(raw: unknown, itemMax: number, listMax: number): string[] {
  if (!Array.isArray(raw)) return []
  const items: string[] = []
  for (const entry of raw) {
    const item = clean(entry, itemMax)
    if (item !== undefined) items.push(item)
    if (items.length >= listMax) break
  }
  return items
}

function title(raw: unknown): string | undefined {
  return clean(raw, LIMITS.blockTitle)
}

/** Common LLM casing for callout variants, normalized to the four canonical ones. */
function calloutVariant(raw: unknown): CalloutVariant | undefined {
  const s = string(raw)?.trim().toLowerCase()
  if (s === 'warning' || s === 'caution' || s === 'attention') return 'warn'
  if (s === 'danger' || s === 'critical') return 'error'
  if (s === 'note' || s === 'tip') return 'info'
  if (s === 'ok' || s === 'good') return 'success'
  return s === 'info' || s === 'warn' || s === 'success' || s === 'error' ? s : undefined
}

/** H|M|L normalization for risk / stakeholder levels ("High" → "H"). */
function level(raw: unknown, max = LIMITS.riskLevel): string | undefined {
  const s = string(raw)?.trim().toLowerCase()
  if (!s) return undefined
  const short = s === 'high' || s === 'h' ? 'H' : s === 'medium' || s === 'med' || s === 'm' ? 'M' : s === 'low' || s === 'l' ? 'L' : s.toUpperCase()
  return short.slice(0, max)
}

function mermaidCode(raw: unknown): string | undefined {
  let code = string(raw)
  if (code === undefined) return undefined
  const fenced = code.trim().match(FENCE)
  if (fenced) code = fenced[1]!
  code = sanitizeMermaidLabels(code.trim())
  return code ? code.slice(0, LIMITS.mermaidDiagram) : undefined
}

interface Dict {
  [key: string]: unknown
}

function asDict(raw: unknown): Dict | undefined {
  return raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Dict) : undefined
}

/**
 * Sanitizes one raw model-emitted block into a valid IRBlock, or null when the
 * shape is unrecoverable (the caller's salvage/fallback then applies). Coerces
 * common deviations; strings are trimmed and bounded to the IR schema limits.
 */
export function sanitizeBlock(raw: unknown): IRBlock | null {
  const dict = asDict(raw)
  if (!dict) return null
  const sanitized = sanitizeByType(dict.type, dict)
  if (!sanitized) return null
  // Final shape guard: the sanitized block must satisfy the IR schema.
  const parsed = irBlockSchema.safeParse(sanitized)
  return parsed.success ? parsed.data : null
}

function sanitizeByType(type: unknown, d: Dict): IRBlock | null {
  switch (type) {
    case 'paragraph': {
      const text = clean(d.text, LIMITS.paragraph)
      return text !== undefined ? { type: 'paragraph', text } : null
    }
    case 'bullets': {
      const items = cleanList(d.items, LIMITS.listItems, LIMITS.listMax)
      return items.length > 0 ? { type: 'bullets', items } : null
    }
    case 'numbered': {
      const items = cleanList(d.items, LIMITS.listItems, LIMITS.listMax)
      return items.length > 0 ? { type: 'numbered', items } : null
    }
    case 'callout': {
      const text = clean(d.text, LIMITS.calloutText)
      if (text === undefined) return null
      const variant = calloutVariant(d.variant)
      return { type: 'callout', text, ...(variant ? { variant } : {}), ...(title(d.title) ? { title: title(d.title) } : {}) }
    }
    case 'mermaid': {
      const diagram = mermaidCode(d.diagram)
      if (diagram === undefined) return null
      return { type: 'mermaid', diagram, ...(title(d.title) ? { title: title(d.title) } : {}) }
    }
    case 'table': {
      if (!Array.isArray(d.rows) || !Array.isArray(d.header)) return null
      const header = d.header
        .map((h) => clean(h, LIMITS.tableHeader))
        .filter((h): h is string => h !== undefined)
        .slice(0, LIMITS.tableCols)
      if (header.length === 0) return null
      const rows: string[][] = []
      for (const rawRow of d.rows) {
        if (!Array.isArray(rawRow)) continue
        const cells = rawRow
          .map((c) => clean(c, LIMITS.tableCell) ?? '')
          .slice(0, LIMITS.tableCols)
        // Rectangular: pad short rows, drop cells beyond the header width.
        while (cells.length < header.length) cells.push('')
        cells.length = header.length
        if (cells.every((c) => c === '')) continue
        rows.push(cells)
        if (rows.length >= LIMITS.tableRows) break
      }
      return rows.length > 0 ? { type: 'table', header, rows } : null
    }
    case 'risk': {
      if (!Array.isArray(d.rows)) return null
      const rows: IRBlock & { rows: Array<{ risk: string; likelihood?: string; impact?: string; mitigation?: string }> } = { type: 'risk', rows: [] }
      for (const rawRow of d.rows) {
        const row = asDict(rawRow)
        const risk = clean(row?.risk, LIMITS.riskText)
        if (risk === undefined) continue
        const likelihood = level(row?.likelihood)
        const impact = level(row?.impact)
        const mitigation = clean(row?.mitigation, LIMITS.riskMitigation)
        rows.rows.push({
          risk,
          ...(likelihood ? { likelihood } : {}),
          ...(impact ? { impact } : {}),
          ...(mitigation ? { mitigation } : {}),
        })
        if (rows.rows.length >= LIMITS.rowsMax) break
      }
      return rows.rows.length > 0 ? rows : null
    }
    case 'scope': {
      const inScope = cleanList(d.inScope, LIMITS.scopeItem, LIMITS.scopeMax)
      const outOfScope = cleanList(d.outOfScope, LIMITS.scopeItem, LIMITS.scopeMax)
      return inScope.length > 0 || outOfScope.length > 0 ? { type: 'scope', inScope, outOfScope } : null
    }
    case 'kpiGrid': {
      if (!Array.isArray(d.items)) return null
      const items: Array<{ metric: string; target?: string; method?: string }> = []
      for (const rawItem of d.items) {
        const item = asDict(rawItem)
        const metric = clean(item?.metric, LIMITS.kpiMetric)
        if (metric === undefined) continue
        const target = clean(item?.target, LIMITS.kpiMetric)
        const method = clean(item?.method, LIMITS.kpiMetric)
        items.push({
          metric,
          ...(target ? { target } : {}),
          ...(method ? { method } : {}),
        })
        if (items.length >= LIMITS.kpiMax) break
      }
      return items.length > 0 ? { type: 'kpiGrid', items } : null
    }
    case 'stakeholderTable': {
      if (!Array.isArray(d.rows)) return null
      const rows: Array<{ nameRole: string; interest?: string; influence?: string; concern?: string }> = []
      for (const rawRow of d.rows) {
        const row = asDict(rawRow)
        const nameRole = clean(row?.nameRole, LIMITS.stakeholderName)
        if (nameRole === undefined) continue
        const interest = level(row?.interest, LIMITS.stakeholderLevel)
        const influence = level(row?.influence, LIMITS.stakeholderLevel)
        const concern = clean(row?.concern, LIMITS.stakeholderConcern)
        rows.push({
          nameRole,
          ...(interest ? { interest } : {}),
          ...(influence ? { influence } : {}),
          ...(concern ? { concern } : {}),
        })
        if (rows.length >= LIMITS.rowsMax) break
      }
      return rows.length > 0 ? { type: 'stakeholderTable', rows } : null
    }
    default:
      return null
  }
}

/** Sanitizes a raw `{"blocks":[...]}` payload; hopeless blocks become editable warn callouts (never dropped). */
export function sanitizeBlockList(raw: unknown): { blocks: IRBlock[]; coerced: number } | null {
  const dict = asDict(raw)
  if (!dict || !Array.isArray(dict.blocks)) return null
  const blocks: IRBlock[] = []
  let coerced = 0
  for (const entry of dict.blocks) {
    const block = sanitizeBlock(entry)
    if (block) {
      blocks.push(block)
    } else {
      // Same salvage philosophy as the worker's section fallback: nothing is
      // silently dropped — unparseable output becomes an editable callout.
      const text = typeof entry === 'string' ? entry : safeJson(entry)
      blocks.push({
        type: 'callout',
        variant: 'warn',
        title: 'Unsupported content',
        text: (text ?? '').slice(0, 2_000) || 'Empty block.',
      })
      coerced++
    }
    if (blocks.length >= 60) break
  }
  return blocks.length > 0 ? { blocks, coerced } : null
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}
