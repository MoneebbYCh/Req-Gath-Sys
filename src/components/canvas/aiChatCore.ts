/**
 * Pure logic for the in-document AI chat (/Chat) block: context capture at the
 * invocation point, and plan resolution for applying the AI result. No BlockNote
 * imports — operates on a structural BlockLike shape so it is unit-testable.
 */
import type { AiChatContextPayload, AiChatResponsePayload, AiChatTarget } from '../../../extension/protocol'

export interface BlockLike {
  id?: unknown
  type?: unknown
  content?: unknown
  props?: unknown
  children?: unknown
}

export interface CapturedSelection {
  blockIds: string[]
  capturedAt: number
}

export interface CaptureOptions {
  /** Whole-document markdown cap (head+tail kept). */
  docMaxChars?: number
  /** How old a captured selection may be to still be trusted. */
  selectionMaxAgeMs?: number
}

const SHAPE_TYPES = new Set([
  'callout',
  'kpiGrid',
  'scopeBounds',
  'stakeholderTable',
  'riskList',
  'diagram',
])

const HEADING_TYPES = new Set(['heading'])

function plainText(content: unknown): string {
  if (typeof content === 'string') return content.trim()
  if (typeof content === 'number' || typeof content === 'boolean') return String(content).trim()
  if (!content || typeof content !== 'object') return ''
  if (!Array.isArray(content)) {
    const obj = content as Record<string, unknown>
    return typeof obj.text === 'string' ? obj.text.trim() : ''
  }
  return content
    .map((part) => {
      if (typeof part === 'string') return part
      if (part && typeof part === 'object' && 'text' in part) {
        return String((part as { text: unknown }).text ?? '')
      }
      return ''
    })
    .join('')
    .trim()
}

function propsOf(block: BlockLike): Record<string, unknown> {
  return block.props && typeof block.props === 'object' && !Array.isArray(block.props)
    ? (block.props as Record<string, unknown>)
    : {}
}

/** Compact human-readable summary of a custom shape block's props. */
function shapeSummary(block: BlockLike): string {
  const props = propsOf(block)
  const parts: string[] = []
  for (const [key, value] of Object.entries(props)) {
    if (key === 'anchorId') continue
    if (typeof value === 'string' && value.startsWith('[')) {
      try {
        const parsed: unknown = JSON.parse(value)
        if (Array.isArray(parsed)) {
          for (const item of parsed) {
            if (item && typeof item === 'object') {
              for (const v of Object.values(item as Record<string, unknown>)) {
                const s = typeof v === 'string' || typeof v === 'number' ? String(v).trim() : ''
                if (s) parts.push(s)
              }
            } else if (typeof item === 'string' && item.trim()) {
              parts.push(item.trim())
            }
          }
          continue
        }
      } catch {
        /* fall through to raw string */
      }
    }
    if (typeof value === 'string' && value.trim()) parts.push(value.trim())
  }
  return parts.length ? parts.join(' · ') : String(block.type ?? 'shape')
}

export function blockText(block: BlockLike | undefined): string {
  if (!block) return ''
  const type = String(block.type ?? 'paragraph')
  if (SHAPE_TYPES.has(type)) return shapeSummary(block)
  return plainText(block.content)
}

function headingLevel(block: BlockLike): number {
  const level = Number(propsOf(block).level)
  return Number.isFinite(level) && level >= 1 && level <= 6 ? Math.trunc(level) : 1
}

/** Markdown-ish serialization of a single block (custom blocks become summaries). */
function serializeBlock(block: BlockLike, depth = 0): string {
  const type = String(block.type ?? 'paragraph')
  const indent = '  '.repeat(depth)
  const text = blockText(block)

  if (HEADING_TYPES.has(type)) {
    return `${indent}${'#'.repeat(headingLevel(block))} ${text}`.trimEnd()
  }
  if (type === 'bulletListItem') return `${indent}- ${text}`
  if (type === 'numberedListItem') return `${indent}1. ${text}`
  if (type === 'checkListItem') return `${indent}- [${text ? 'x' : ' '}] ${text}`
  if (type === 'codeBlock') {
    return `${indent}\`\`\`\n${text}\n${indent}\`\`\``
  }
  if (type === 'divider') return `${indent}---`
  if (SHAPE_TYPES.has(type)) {
    return `${indent}[${type}] ${text}`
  }
  if (text) return `${indent}${text}`
  return ''
}

function serializeBlocks(blocks: BlockLike[]): string {
  const out: string[] = []
  for (const block of blocks) {
    const line = serializeBlock(block)
    if (line) out.push(line)
    if (Array.isArray(block.children) && block.children.length) {
      out.push(serializeBlocks(block.children as BlockLike[]))
    }
  }
  return out.join('\n')
}

/** Keep head and tail of an oversized serialization — both ends carry meaning. */
function truncateHeadTail(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  const head = Math.floor(maxChars * 0.6)
  const tail = maxChars - head
  return `${text.slice(0, head)}\n…[truncated]…\n${text.slice(-tail)}`
}

function stripTrailingSlash(text: string): string {
  return text.endsWith('/') ? text.slice(0, -1).trim() : text.trim()
}

/** Find the heading-bounded section around the cursor block (headings excluded). */
function findSection(blocks: BlockLike[], cursorIndex: number): BlockLike[] {
  const start = (() => {
    let i = cursorIndex
    if (HEADING_TYPES.has(String(blocks[i]?.type ?? ''))) return i + 1
    while (i > 0 && !HEADING_TYPES.has(String(blocks[i - 1]?.type ?? ''))) i -= 1
    return i
  })()
  let end = start
  while (end < blocks.length && !HEADING_TYPES.has(String(blocks[end]?.type ?? ''))) end += 1
  return blocks.slice(start, end)
}

/**
 * Capture the document context at the AI chat invocation point. Must be called
 * BEFORE the slash menu inserts the chat block (the insertion splits the
 * paragraph, destroying the cursor/selection snapshot).
 */
export function captureAiChatContext(
  blocks: BlockLike[],
  cursorBlockId: string,
  selection: CapturedSelection | null,
  now: number,
  options: CaptureOptions = {},
): AiChatContextPayload {
  const { docMaxChars = 25_000, selectionMaxAgeMs = 30_000 } = options

  const byId = new Map(blocks.map((b, i) => [String(b.id ?? ''), i]))
  const cursorIndex = byId.get(cursorBlockId) ?? -1
  const cursorBlock = cursorIndex >= 0 ? blocks[cursorIndex] : null

  const cursorText = cursorBlock ? stripTrailingSlash(blockText(cursorBlock)) : ''
  const prevBlock = cursorIndex > 0 ? blocks[cursorIndex - 1] : null
  const nextBlock =
    cursorIndex >= 0 && cursorIndex < blocks.length - 1 ? blocks[cursorIndex + 1] : null

  // The slash character replaced the user's selection. A captured selection is
  // trusted only when it is fresh AND the cursor block now holds just "/" —
  // i.e. the user selected text, typed "/" over it, and opened the menu.
  let selectionPayload: AiChatContextPayload['selection']
  if (
    selection &&
    selection.blockIds.length > 0 &&
    now - selection.capturedAt <= selectionMaxAgeMs &&
    cursorText === '' &&
    selection.blockIds.every((id) => byId.has(id))
  ) {
    const selBlocks = selection.blockIds
      .map((id) => blocks[byId.get(id) ?? -1])
      .filter((b): b is BlockLike => Boolean(b))
    selectionPayload = { blockIds: selection.blockIds, markdown: serializeBlocks(selBlocks) }
  }

  const sectionBlocks = cursorIndex >= 0 ? findSection(blocks, cursorIndex) : []
  const sectionMarkdown = serializeBlocks(sectionBlocks)
  const blank = blocks.every((b) => !blockText(b))

  return {
    ...(selectionPayload ? { selection: selectionPayload } : {}),
    ...(cursorBlock
      ? { cursorBlock: { id: String(cursorBlock.id), text: cursorText } }
      : {}),
    ...(prevBlock ? { prevBlock: { id: String(prevBlock.id), text: blockText(prevBlock) } } : {}),
    ...(nextBlock ? { nextBlock: { id: String(nextBlock.id), text: blockText(nextBlock) } } : {}),
    section: sectionBlocks.length && sectionMarkdown.trim()
      ? { blockIds: sectionBlocks.map((b) => String(b.id)), markdown: sectionMarkdown }
      : null,
    headings: blocks
      .filter((b) => HEADING_TYPES.has(String(b.type ?? '')))
      .map((b) => blockText(b))
      .filter(Boolean),
    docMarkdown: truncateHeadTail(serializeBlocks(blocks), docMaxChars),
    blank,
  }
}

export type AiChatPlanMode = 'none' | 'replace' | 'after-chat'

export interface AiChatPlan {
  mode: AiChatPlanMode
  /** Blocks to remove/replace (modify only). */
  removeIds: string[]
  /** Where to insert when not replacing (after-chat). */
  insertAfterId: string | null
  /** Human note surfaced in the block when the plan deviated. */
  note?: string
}

export interface PlanOptions {
  /** Block ids currently present in the editor (live). */
  liveBlocks: { id: string }[]
  /** Live text of the captured cursor block — mismatch means the user edited it. */
  cursorLiveText?: string
}

function targetIds(target: AiChatTarget | undefined, ctx: AiChatContextPayload): string[] {
  switch (target) {
    case 'selection':
      return ctx.selection?.blockIds ?? []
    case 'section':
      return ctx.section?.blockIds ?? []
    case 'cursor':
    default: {
      const ids = ctx.cursorBlock ? [ctx.cursorBlock.id] : []
      // The slash split the paragraph: when the block after the cursor was
      // empty at capture, it is the split tail and belongs to the same target.
      if (ctx.nextBlock && !ctx.nextBlock.text) ids.push(ctx.nextBlock.id)
      return ids
    }
  }
}

/**
 * Turn the AI result into a concrete document edit plan against the captured
 * context. Never clobbers content the user changed while generating.
 */
export function resolveAiChatPlan(
  result: Pick<AiChatResponsePayload, 'kind' | 'target'>,
  ctx: AiChatContextPayload,
  chatBlockId: string,
  options: PlanOptions,
): AiChatPlan {
  if (result.kind !== 'modify') {
    if (result.kind === 'insert') return { mode: 'after-chat', removeIds: [], insertAfterId: chatBlockId }
    return { mode: 'none', removeIds: [], insertAfterId: null }
  }

  if (
    result.target === 'cursor' &&
    ctx.cursorBlock?.text &&
    options.cursorLiveText !== undefined &&
    options.cursorLiveText !== ctx.cursorBlock.text
  ) {
    return {
      mode: 'after-chat',
      removeIds: [],
      insertAfterId: chatBlockId,
      note: 'The paragraph changed while the AI was working — result inserted below instead.',
    }
  }

  const live = new Set(options.liveBlocks.map((b) => String(b.id)))
  const removeIds = targetIds(result.target, ctx).filter((id) => live.has(id))
  if (removeIds.length === 0) {
    return { mode: 'after-chat', removeIds: [], insertAfterId: chatBlockId }
  }
  return { mode: 'replace', removeIds, insertAfterId: null }
}