import * as fs from 'fs'
import * as path from 'path'

export const MAX_READ_LINES = 2_000
export const MAX_READ_BYTES = 50 * 1024
const MAX_LINE_LENGTH = 2_000
const MAX_LINE_SUFFIX = `... (line truncated to ${MAX_LINE_LENGTH} chars)`
const CHUNK_SIZE = 64 * 1024

const BINARY_EXTENSIONS = new Set([
  '.zip', '.tar', '.gz', '.exe', '.dll', '.so', '.class', '.jar', '.war', '.7z',
  '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.odt', '.ods', '.odp',
  '.bin', '.dat', '.obj', '.o', '.a', '.lib', '.wasm', '.pyc', '.pyo', '.pdf',
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.woff', '.woff2',
])

export interface ReadPageMeta {
  offset: number
  truncated: boolean
  next?: number
  totalLines: number
}

export type ReadFileResult =
  | { ok: true; text: string; meta: ReadPageMeta }
  | { ok: false; error: string }

function safeResolve(workspaceRoot: string, rel: string): string | null {
  const root = path.resolve(workspaceRoot)
  const abs = path.resolve(root, rel || '.')
  if (abs !== root && !abs.startsWith(root + path.sep)) return null
  return abs
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(n)))
}

function isBinaryContent(resource: string, bytes: Uint8Array): boolean {
  if (BINARY_EXTENSIONS.has(path.extname(resource).toLowerCase())) return true
  if (bytes.length === 0) return false
  if (bytes.includes(0)) return true
  let nonPrintable = 0
  for (const byte of bytes) {
    if (byte < 9 || (byte > 13 && byte < 32)) nonPrintable++
  }
  return nonPrintable / bytes.length > 0.3
}

function isPdf(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 4 &&
    bytes[0] === 0x25 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x44 &&
    bytes[3] === 0x46
  )
}

function truncateLine(line: string): string {
  if (line.length <= MAX_LINE_LENGTH) return line
  return line.slice(0, MAX_LINE_LENGTH) + MAX_LINE_SUFFIX
}

function readChunk(fd: number, offset: number, length: number): Buffer {
  const buf = Buffer.alloc(length)
  fs.readSync(fd, buf, 0, length, offset)
  return buf
}

interface PageReaderState {
  offset: number
  limit: number
  lines: string[]
  pending: string
  discard: boolean
  line: number
  totalLines: number
  bytes: number
  next?: number
  done: boolean
  countOnly: boolean
}

function createPageReader(offset: number, limit: number): PageReaderState {
  return {
    offset,
    limit,
    lines: [],
    pending: '',
    discard: false,
    line: 1,
    totalLines: 0,
    bytes: 0,
    done: false,
    countOnly: false,
  }
}

function appendLine(state: PageReaderState, raw: string): boolean {
  if (state.countOnly) {
    state.totalLines++
    state.line++
    return true
  }

  state.totalLines++
  if (state.line < state.offset) {
    state.line++
    return true
  }
  if (state.lines.length >= state.limit || state.bytes >= MAX_READ_BYTES) {
    state.next = state.line
    state.countOnly = true
    state.line++
    return true
  }
  const text = truncateLine(raw)
  const size = Buffer.byteLength(text, 'utf-8') + (state.lines.length > 0 ? 1 : 0)
  if (state.bytes + size > MAX_READ_BYTES) {
    state.next = state.line
    state.countOnly = true
    state.line++
    return true
  }
  state.lines.push(text)
  state.bytes += size
  state.line++
  return true
}

function consumeText(state: PageReaderState, input: string): boolean {
  let text = input
  while (true) {
    const index = text.indexOf('\n')
    if (index === -1) {
      if (!state.discard) {
        state.pending += text
        if (state.pending.length > MAX_LINE_LENGTH) {
          state.pending = state.pending.slice(0, MAX_LINE_LENGTH + 1)
          state.discard = true
        }
      }
      break
    }
    const current = state.pending + (state.discard ? '' : text.slice(0, index))
    state.pending = ''
    state.discard = false
    text = text.slice(index + 1)
    const normalized = current.endsWith('\r') ? current.slice(0, -1) : current
    if (!appendLine(state, normalized)) return false
  }
  return true
}

function consumeChunk(
  state: PageReaderState,
  decoder: TextDecoder,
  resource: string,
  chunk: Buffer,
  stream: boolean,
): 'ok' | 'binary' | 'utf8' {
  if (chunk.includes(0)) return 'binary'
  try {
    const text = decoder.decode(chunk, { stream })
    if (!consumeText(state, text)) {
      state.done = true
    }
    return 'ok'
  } catch {
    return 'utf8'
  }
}

function flushPending(state: PageReaderState, decoder: TextDecoder): 'ok' | 'utf8' {
  try {
    const tail = decoder.decode()
    if (!state.discard) state.pending += tail
    if (state.pending) {
      const normalized = state.pending.endsWith('\r')
        ? state.pending.slice(0, -1)
        : state.pending
      if (!appendLine(state, normalized)) state.done = true
    } else if (state.pending === '' && state.totalLines === 0 && state.line === 1) {
      // empty file
    }
    return 'ok'
  } catch {
    return 'utf8'
  }
}

/** Stream a UTF-8 file in 64KB chunks and return one page of numbered lines. */
function readFilePageStream(abs: string, rel: string, fileSize: number, offset: number, limit: number): ReadFileResult {
  const fd = fs.openSync(abs, 'r')
  try {
    const firstSize = Math.min(CHUNK_SIZE, fileSize || 4096)
    const first = firstSize > 0 ? readChunk(fd, 0, firstSize) : Buffer.alloc(0)

    if (isBinaryContent(rel, first) || isPdf(first)) {
      return { ok: false, error: `error: Cannot read binary file: ${rel}` }
    }

    const state = createPageReader(offset, limit)
    const decoder = new TextDecoder('utf-8', { fatal: true })
    let filePos = firstSize

    if (firstSize > 0) {
      const result = consumeChunk(state, decoder, rel, first, filePos < fileSize)
      if (result === 'binary') return { ok: false, error: `error: Cannot read binary file: ${rel}` }
      if (result === 'utf8') return { ok: false, error: `error: File is not valid UTF-8: ${rel}` }
    }

    while (filePos < fileSize) {
      const toRead = Math.min(CHUNK_SIZE, fileSize - filePos)
      const chunk = readChunk(fd, filePos, toRead)
      filePos += toRead
      const result = consumeChunk(state, decoder, rel, chunk, filePos < fileSize)
      if (result === 'binary') return { ok: false, error: `error: Cannot read binary file: ${rel}` }
      if (result === 'utf8') return { ok: false, error: `error: File is not valid UTF-8: ${rel}` }
    }

    if (!state.done) {
      const flush = flushPending(state, decoder)
      if (flush === 'utf8') return { ok: false, error: `error: File is not valid UTF-8: ${rel}` }
    }

    if (state.lines.length === 0 && offset !== 1) {
      return { ok: false, error: `error: Offset ${offset} is out of range` }
    }

    const endLine = state.lines.length > 0 ? offset + state.lines.length - 1 : offset
    const numbered = state.lines.map((l, i) => `${offset + i}\t${l}`).join('\n')
    const truncated = state.next !== undefined
    const next = state.next

    let suffix = ''
    if (truncated && next !== undefined) {
      suffix = `\n\n[truncated at line ${endLine} of ${state.totalLines} — re-read with offset:${next} limit:${Math.min(limit, MAX_READ_LINES)}]`
    }

    return {
      ok: true,
      text: `${rel}:${offset}-${endLine}\n${numbered}${suffix}`,
      meta: {
        offset,
        truncated,
        ...(next !== undefined ? { next } : {}),
        totalLines: state.totalLines,
      },
    }
  } finally {
    fs.closeSync(fd)
  }
}

export function readFilePage(
  workspaceRoot: string,
  args: Record<string, unknown>,
): ReadFileResult {
  const rel = String(args.path ?? '')
  if (!rel) return { ok: false, error: 'error: "path" is required' }
  const abs = safeResolve(workspaceRoot, rel)
  if (!abs) return { ok: false, error: 'error: path is outside the workspace' }

  let stat: fs.Stats
  try {
    stat = fs.statSync(abs)
  } catch {
    return { ok: false, error: `error: cannot read ${rel}` }
  }
  if (!stat.isFile()) return { ok: false, error: `error: ${rel} is not a file` }

  const hasLegacyRange =
    args.line_start != null ||
    args.line_end != null ||
    args.start != null ||
    args.end != null

  const defaultOffset = 1
  const defaultLimit = MAX_READ_LINES
  let offset = hasLegacyRange
    ? clampInt(args.line_start ?? args.start, defaultOffset, 1, Number.MAX_SAFE_INTEGER)
    : clampInt(args.offset, defaultOffset, 1, Number.MAX_SAFE_INTEGER)
  let limit = hasLegacyRange
    ? clampInt(
        args.line_end ?? args.end,
        defaultOffset + defaultLimit - 1,
        offset,
        Number.MAX_SAFE_INTEGER,
      ) - offset + 1
    : clampInt(args.limit, defaultLimit, 1, MAX_READ_LINES)

  if (hasLegacyRange && (args.line_end != null || args.end != null)) {
    const end = clampInt(args.line_end ?? args.end, offset, offset, Number.MAX_SAFE_INTEGER)
    limit = Math.min(end - offset + 1, MAX_READ_LINES)
  }

  return readFilePageStream(abs, rel, stat.size, offset, limit)
}

/** String observation for the agent loop. */
export function readFileTool(workspaceRoot: string, args: Record<string, unknown>): string {
  const result = readFilePage(workspaceRoot, args)
  return result.ok ? result.text : result.error
}
