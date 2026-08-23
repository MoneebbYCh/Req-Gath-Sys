import * as fs from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { StringDecoder } from 'node:string_decoder'

/**
 * Bounded file reads (plan §10). Whole-file reads refuse files above a safe
 * size; ranged reads return numbered, truncated lines. Unsaved editor buffers
 * win over disk (US-5.3) via an injected `readOpenBuffer` callback.
 *
 * Every successful read carries a `contentHash` of the source (plan §7): the
 * evidence ledger uses it for staleness detection.
 *
 * Plan §9 edge cases:
 * - TOCTOU: a file changing between validation and read is detected by
 *   comparing stat before/after the read; the read retries once and then
 *   reports `changedDuringRead` so the caller can surface a warning.
 * - Minified 20 MB file: range reads never load the whole file — large files
 *   are scanned in bounded chunks up to MAX_SCAN_BYTES.
 */
export interface ReadWholeResult {
  ok: boolean
  content?: string
  lineCount?: number
  contentHash?: string
  size?: number
  tooLarge?: boolean
  binary?: boolean
  /** Plan §9 edge: the file changed while being read (value reflects a snapshot). */
  changedDuringRead?: boolean
  error?: string
}

export interface ReadRangeResult {
  ok: boolean
  lines?: Array<{ number: number; text: string }>
  contentHash?: string
  truncated?: boolean
  binary?: boolean
  changedDuringRead?: boolean
  error?: string
}

export interface FileReaderOptions {
  maxWholeBytes?: number
  maxRangeLines?: number
  maxRangeBytes?: number
  maxLineLength?: number
  /** Hard cap for range scans of large files (plan §9: minified 20 MB JS). */
  maxScanBytes?: number
  /**
   * Plan §9/§15 read cache: bounded in-memory LRU keyed by path + stat
   * identity + range. Repeated identical reads skip the filesystem entirely.
   */
  cacheMaxEntries?: number
  /** Host-provided: current in-memory text of a dirty open editor, or undefined. */
  readOpenBuffer?: (absolutePath: string) => string | undefined
  /** Injectable for tests (TOCTOU simulation). Defaults to fs.readFile. */
  readFileFn?: (absolutePath: string) => Promise<Buffer>
}

const DEFAULT_MAX_WHOLE_BYTES = 32 * 1024
const DEFAULT_MAX_RANGE_LINES = 400
const DEFAULT_MAX_RANGE_BYTES = 48 * 1024
const DEFAULT_MAX_LINE_LENGTH = 1_000
const DEFAULT_MAX_SCAN_BYTES = 2 * 1024 * 1024
const DEFAULT_CACHE_MAX_ENTRIES = 200

interface StatLike {
  size: number
  mtimeMs: number
  mode: number
}

export class FileReader {
  private readonly maxWholeBytes: number
  private readonly maxRangeLines: number
  private readonly maxRangeBytes: number
  private readonly maxLineLength: number
  private readonly maxScanBytes: number
  private readonly cacheMaxEntries: number
  private readonly cache = new Map<string, ReadWholeResult | ReadRangeResult>()
  private readonly readOpenBuffer: ((absolutePath: string) => string | undefined) | undefined
  private readonly readFileFn: (absolutePath: string) => Promise<Buffer>

  constructor(options: FileReaderOptions = {}) {
    this.maxWholeBytes = options.maxWholeBytes ?? DEFAULT_MAX_WHOLE_BYTES
    this.maxRangeLines = options.maxRangeLines ?? DEFAULT_MAX_RANGE_LINES
    this.maxRangeBytes = options.maxRangeBytes ?? DEFAULT_MAX_RANGE_BYTES
    this.maxLineLength = options.maxLineLength ?? DEFAULT_MAX_LINE_LENGTH
    this.maxScanBytes = options.maxScanBytes ?? DEFAULT_MAX_SCAN_BYTES
    this.cacheMaxEntries = options.cacheMaxEntries ?? DEFAULT_CACHE_MAX_ENTRIES
    this.readOpenBuffer = options.readOpenBuffer
    this.readFileFn = options.readFileFn ?? ((p) => fs.readFile(p))
  }

  /**
   * LRU read cache (plan §9/§15): the key embeds the stat identity, so a
   * changed mtime/size/mode can never be served stale content. Bounded by
   * cacheMaxEntries (0 disables). Only successful, stable reads are cached.
   */
  private cacheGet<T extends ReadWholeResult | ReadRangeResult>(key: string): T | undefined {
    const hit = this.cache.get(key)
    if (!hit) return undefined
    // Refresh recency — Map iteration order is insertion order, so the oldest
    // key is always first. ponytail: O(n) eviction fine for ~200 entries.
    this.cache.delete(key)
    this.cache.set(key, hit)
    return hit as T
  }

  private cacheSet(key: string, value: ReadWholeResult | ReadRangeResult): void {
    if (this.cacheMaxEntries <= 0) return
    this.cache.set(key, value)
    if (this.cache.size > this.cacheMaxEntries) {
      const oldest = this.cache.keys().next().value
      if (oldest !== undefined) this.cache.delete(oldest)
    }
  }

  private static wholeKey(absolutePath: string, stat: StatLike): string {
    return `${absolutePath}\u0000${stat.size}\u0000${stat.mtimeMs}\u0000${stat.mode}\u0000whole`
  }

  private static rangeKey(absolutePath: string, stat: StatLike, startLine: number, endLine: number): string {
    return `${absolutePath}\u0000${stat.size}\u0000${stat.mtimeMs}\u0000${stat.mode}\u0000${startLine}-${endLine}`
  }

  async readWhole(absolutePath: string): Promise<ReadWholeResult> {
    const dirty = this.readOpenBuffer?.(absolutePath)
    if (dirty !== undefined) {
      return { ok: true, content: dirty, lineCount: countLines(dirty), contentHash: hashContent(dirty) }
    }

    const before = await this.stat(absolutePath)
    if (!before.ok) return { ok: false, error: before.error }

    const attempt = await this.readWholeOnce(absolutePath)
    if (!attempt.ok) return attempt

    // Plan §9 TOCTOU: the file changed while we read it — retry once, then
    // report the instability instead of pretending the content is stable.
    const after = await this.stat(absolutePath)
    if (after.ok && !sameStat(before, after)) {
      const retry = await this.readWholeOnce(absolutePath)
      const finalStat = await this.stat(absolutePath)
      if (retry.ok && finalStat.ok && !sameStat(after, finalStat)) {
        return { ...retry, changedDuringRead: true }
      }
      return retry.ok ? { ...retry, changedDuringRead: true } : retry
    }
    return attempt
  }

  async readRange(absolutePath: string, startLine: number, endLine: number): Promise<ReadRangeResult> {
    if (startLine < 1 || endLine < startLine) {
      return { ok: false, error: `Invalid range ${startLine}..${endLine}` }
    }
    const dirty = this.readOpenBuffer?.(absolutePath)
    if (dirty !== undefined) {
      return { ...slice(dirty, startLine, endLine, this.maxRangeLines, this.maxRangeBytes, this.maxLineLength), contentHash: hashContent(dirty) }
    }

    const before = await this.stat(absolutePath)
    if (!before.ok) return { ok: false, error: before.error }

    const result = before.size > this.maxScanBytes
      ? await this.readRangeBounded(absolutePath, startLine, endLine)
      : await this.readRangeSmall(absolutePath, startLine, endLine, before)
    if (!result.ok) return result

    const after = await this.stat(absolutePath)
    if (after.ok && !sameStat(before, after)) {
      return { ...result, changedDuringRead: true }
    }
    return result
  }

  /** Files within the scan cap: one full read (hash covers the whole file). */
  private async readRangeSmall(
    absolutePath: string,
    startLine: number,
    endLine: number,
    before: StatLike,
  ): Promise<ReadRangeResult> {
    const key = FileReader.rangeKey(absolutePath, before, startLine, endLine)
    const hit = this.cacheGet<ReadRangeResult>(key)
    if (hit) return { ...hit, lines: hit.lines ? [...hit.lines] : undefined }
    let buffer: Buffer
    try {
      buffer = await this.readFileFn(absolutePath)
    } catch {
      return { ok: false, error: `File not found: ${absolutePath}` }
    }
    if (isBinary(buffer)) return { ok: false, binary: true, error: 'Binary file.' }
    const content = buffer.toString('utf8')
    const result = { ...slice(content, startLine, endLine, this.maxRangeLines, this.maxRangeBytes, this.maxLineLength), contentHash: hashContent(content) }
    this.cacheSet(key, result)
    return result
  }

  /**
   * Plan §9 (minified 20 MB file): bounded chunked scan — never loads the
   * whole file. Scans at most `maxScanBytes`; the content hash covers the
   * scanned prefix (the only content the caller can claim).
   */
  private async readRangeBounded(absolutePath: string, startLine: number, endLine: number): Promise<ReadRangeResult> {
    const requested = Math.min(endLine, startLine + this.maxRangeLines - 1)
    const lines: Array<{ number: number; text: string }> = []
    const decoder = new StringDecoder('utf8')
    let fh: fs.FileHandle
    try {
      fh = await fs.open(absolutePath, 'r')
    } catch {
      return { ok: false, error: `File not found: ${absolutePath}` }
    }
    try {
      const chunkSize = 64 * 1024
      const buf = Buffer.alloc(chunkSize)
      let scanned = 0
      let lineNo = 0
      let bytes = 0
      let truncated = false
      let hashInput = ''
      let carry = ''
      let reachedStart = false

      while (scanned < this.maxScanBytes) {
        const { bytesRead } = await fh.read(buf, 0, chunkSize, scanned)
        if (bytesRead === 0) break
        scanned += bytesRead
        const text = carry + decoder.write(buf.subarray(0, bytesRead))
        hashInput += text
        const parts = text.split('\n')
        // The last part is a partial line — carry it into the next chunk.
        carry = parts.pop() ?? ''
        for (const raw of parts) {
          lineNo++
          if (lineNo < startLine) continue
          reachedStart = true
          if (lineNo > requested) break
          const t = raw.length > this.maxLineLength ? `${raw.slice(0, this.maxLineLength)}…` : raw
          bytes += t.length + 6
          if (bytes > this.maxRangeBytes) {
            truncated = true
            break
          }
          lines.push({ number: lineNo, text: t })
        }
        if (truncated || lineNo >= requested) break
      }
      hashInput += carry + decoder.end()

      if (!reachedStart) {
        return {
          ok: false,
          error: `Range starts beyond the bounded scan limit (${this.maxScanBytes} bytes) — narrow the range or search first.`,
        }
      }
      return {
        ok: true,
        lines,
        truncated: truncated || requested < endLine,
        contentHash: hashContent(hashInput),
      }
    } finally {
      await fh.close()
    }
  }

  private async readWholeOnce(absolutePath: string): Promise<ReadWholeResult> {
    let stat
    try {
      stat = await fs.stat(absolutePath)
    } catch {
      return { ok: false, error: `File not found: ${absolutePath}` }
    }
    if (!stat.isFile()) return { ok: false, error: `Not a file: ${absolutePath}` }

    if (stat.size > this.maxWholeBytes) {
      return { ok: false, tooLarge: true, size: stat.size, error: 'File too large for read_file — use read_file_range.' }
    }

    const key = FileReader.wholeKey(absolutePath, stat)
    const hit = this.cacheGet<ReadWholeResult>(key)
    if (hit) return { ...hit }

    let buffer: Buffer
    try {
      buffer = await this.readFileFn(absolutePath)
    } catch (err) {
      return { ok: false, error: `Read failed: ${err instanceof Error ? err.message : String(err)}` }
    }
    if (isBinary(buffer)) return { ok: false, binary: true, error: 'Binary file.' }

    const content = buffer.toString('utf8')
    const result: ReadWholeResult = { ok: true, content, lineCount: countLines(content), contentHash: hashContent(content) }
    this.cacheSet(key, result)
    return result
  }

  private async stat(absolutePath: string): Promise<{ ok: true } & StatLike | { ok: false; error: string }> {
    try {
      const s = await fs.stat(absolutePath)
      if (!s.isFile()) return { ok: false, error: `Not a file: ${absolutePath}` }
      return { ok: true, size: s.size, mtimeMs: s.mtimeMs, mode: s.mode }
    } catch {
      return { ok: false, error: `File not found: ${absolutePath}` }
    }
  }
}

function sameStat(a: StatLike, b: StatLike): boolean {
  return a.size === b.size && a.mtimeMs === b.mtimeMs
}

function hashContent(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

function countLines(text: string): number {
  if (text.length === 0) return 0
  const parts = text.split('\n')
  // A single trailing newline is a line terminator, not an extra empty line.
  if (parts.length > 1 && parts[parts.length - 1] === '') parts.pop()
  return parts.length
}

function slice(
  text: string,
  startLine: number,
  endLine: number,
  maxLines: number,
  maxBytes: number,
  maxLineLength: number,
): ReadRangeResult {
  const all = text.split('\n')
  // Drop the synthetic empty line produced by a trailing newline.
  if (all.length > 1 && all[all.length - 1] === '') all.pop()

  const lines: Array<{ number: number; text: string }> = []
  let bytes = 0
  let truncated = false
  const requested = Math.min(endLine, startLine + maxLines - 1)

  for (let i = startLine - 1; i <= requested - 1 && i < all.length; i++) {
    const raw = all[i]
    const t = raw.length > maxLineLength ? `${raw.slice(0, maxLineLength)}…` : raw
    bytes += t.length + 6
    if (bytes > maxBytes) {
      truncated = true
      break
    }
    lines.push({ number: i + 1, text: t })
  }
  // Truncated when the request covers lines that were cut by limits or the file.
  if (requested < endLine) truncated = true

  return { ok: true, lines, truncated }
}

function isBinary(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, 8_000)
  for (const byte of sample) {
    if (byte === 0) return true
  }
  return false
}
