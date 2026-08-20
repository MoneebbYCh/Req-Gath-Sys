import { describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  boundToolOutput,
  cleanupToolOutputStore,
  MAX_OUTPUT_BYTES,
  MAX_OUTPUT_LINES,
  TOOL_OUTPUT_RETENTION_MS,
} from './toolOutputStore'

describe('boundToolOutput', () => {
  it('returns small output unchanged', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'charter-bound-'))
    const text = 'hello world'
    const out = await boundToolOutput(dir, text)
    expect(out).toBe(text)
  })

  it('spills large output to disk with marker and read_file hint', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'charter-bound-'))
    const lines = Array.from({ length: MAX_OUTPUT_LINES + 10 }, (_, i) => `${'x'.repeat(80)} line ${i}`)
    const text = lines.join('\n')
    expect(Buffer.byteLength(text, 'utf-8')).toBeGreaterThan(MAX_OUTPUT_BYTES)

    const out = await boundToolOutput(dir, text)
    expect(out).toMatch(/output truncated; full content saved to/)
    expect(out).toMatch(/Call read_file on/)
    expect(out.length).toBeLessThan(text.length)

    const spillDir = path.join(dir, '.charter-ai', 'tool-output')
    const files = fs.readdirSync(spillDir)
    expect(files.some((f) => f.startsWith('tool_'))).toBe(true)
  })
})

describe('cleanupToolOutputStore', () => {
  it('removes spill files older than retention', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'charter-clean-'))
    const spillDir = path.join(dir, '.charter-ai', 'tool-output')
    fs.mkdirSync(spillDir, { recursive: true })
    const oldFile = path.join(spillDir, 'tool_old.txt')
    fs.writeFileSync(oldFile, 'stale')
    const oldTime = Date.now() - TOOL_OUTPUT_RETENTION_MS - 60_000
    fs.utimesSync(oldFile, oldTime / 1000, oldTime / 1000)

    const removed = cleanupToolOutputStore(dir)
    expect(removed).toBe(1)
    expect(fs.existsSync(oldFile)).toBe(false)
  })
})
