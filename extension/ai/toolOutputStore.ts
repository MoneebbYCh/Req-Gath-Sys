import * as fs from 'fs'
import * as path from 'path'
import { randomBytes } from 'node:crypto'
import { STATE_DIR } from '../brand'

export const MAX_OUTPUT_LINES = 2_000
export const MAX_OUTPUT_BYTES = 50 * 1024
/** Spilled tool-output files older than this are deleted (OpenCode default: 7 days). */
export const TOOL_OUTPUT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000

const TOOL_OUTPUT_DIR = 'tool-output'

function lineCount(text: string): number {
  if (!text) return 0
  let count = 1
  for (const c of text) if (c === '\n') count++
  return count
}

function takePrefix(input: string, maximumBytes: number): string {
  let bytes = 0
  let content = ''
  for (const char of input) {
    const size = Buffer.byteLength(char, 'utf-8')
    if (bytes + size > maximumBytes) break
    content += char
    bytes += size
  }
  return content
}

function takeSuffix(input: string, maximumBytes: number): string {
  let bytes = 0
  const content: string[] = []
  for (const char of Array.from(input).reverse()) {
    const size = Buffer.byteLength(char, 'utf-8')
    if (bytes + size > maximumBytes) break
    content.unshift(char)
    bytes += size
  }
  return content.join('')
}

function preview(text: string, maxLines: number, maxBytes: number): { head: string; tail: string } {
  const lines = text.split('\n')
  const headLines = Math.ceil(maxLines / 2)
  const tailLines = Math.floor(maxLines / 2)
  if (lines.length <= maxLines) {
    const sampled = text
    if (Buffer.byteLength(sampled, 'utf-8') <= maxBytes) {
      return { head: sampled, tail: '' }
    }
  }
  const head = lines.slice(0, headLines).join('\n')
  const tail = tailLines > 0 ? lines.slice(lines.length - tailLines).join('\n') : ''
  const combined = tail ? `${head}\n\n...\n\n${tail}` : head
  if (Buffer.byteLength(combined, 'utf-8') <= maxBytes) {
    return { head, tail }
  }
  const headBytes = Math.ceil(maxBytes / 2)
  const tailBytes = Math.floor(maxBytes / 2)
  return { head: takePrefix(head, headBytes), tail: takeSuffix(tail, tailBytes) }
}

function toolOutputDir(workspaceRoot: string): string {
  return path.join(workspaceRoot, STATE_DIR, TOOL_OUTPUT_DIR)
}

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
}

function spillMarker(relPath: string): string {
  return [
    `... output truncated; full content saved to ${relPath} ...`,
    `Call read_file on {"path":"${relPath}","offset":1,"limit":${MAX_OUTPUT_LINES}} to continue reading.`,
  ].join('\n')
}

/** Delete tool-output spill files older than retention period. */
export function cleanupToolOutputStore(workspaceRoot: string, now = Date.now()): number {
  const dir = toolOutputDir(workspaceRoot)
  if (!fs.existsSync(dir)) return 0

  let removed = 0
  const cutoff = now - TOOL_OUTPUT_RETENTION_MS
  for (const entry of fs.readdirSync(dir)) {
    if (!entry.startsWith('tool_')) continue
    const abs = path.join(dir, entry)
    try {
      const stat = fs.statSync(abs)
      if (stat.mtimeMs < cutoff) {
        fs.unlinkSync(abs)
        removed++
      }
    } catch {
      /* ignore missing/unreadable files */
    }
  }
  return removed
}

/** Bound tool output: preview in context, spill full text to disk when over limits. */
export async function boundToolOutput(workspaceRoot: string, text: string): Promise<string> {
  cleanupToolOutputStore(workspaceRoot)

  const lines = lineCount(text)
  const bytes = Buffer.byteLength(text, 'utf-8')
  if (lines <= MAX_OUTPUT_LINES && bytes <= MAX_OUTPUT_BYTES) return text

  const dir = toolOutputDir(workspaceRoot)
  ensureDir(dir)
  const id = randomBytes(6).toString('hex')
  const relPath = `${STATE_DIR}/${TOOL_OUTPUT_DIR}/tool_${id}.txt`
  const absPath = path.join(workspaceRoot, relPath)
  fs.writeFileSync(absPath, text, 'utf-8')

  const marker = spillMarker(relPath)
  const { head, tail } = preview(
    text,
    MAX_OUTPUT_LINES - 6,
    MAX_OUTPUT_BYTES - Buffer.byteLength(marker, 'utf-8') - 16,
  )
  if (tail) {
    return `${head}\n\n${marker}\n\n${tail}`
  }
  return `${head}\n\n${marker}`
}
