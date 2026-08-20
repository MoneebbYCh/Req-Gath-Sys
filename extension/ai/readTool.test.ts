import { describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { readFilePage, MAX_READ_BYTES, MAX_READ_LINES } from './readTool'

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'charter-read-'))
  return dir
}

describe('readFilePage', () => {
  it('rejects binary files by extension', () => {
    const dir = tempDir()
    const file = path.join(dir, 'image.png')
    fs.writeFileSync(file, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]))
    const result = readFilePage(dir, { path: 'image.png' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/binary/i)
  })

  it('returns line numbers and supports offset/limit with next hint', () => {
    const dir = tempDir()
    const lines = Array.from({ length: 100 }, (_, i) => `line-${i + 1}`)
    fs.writeFileSync(path.join(dir, 'sample.txt'), lines.join('\n'))
    const result = readFilePage(dir, { path: 'sample.txt', offset: 1, limit: 40 })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.text).toContain('1\tline-1')
      expect(result.meta.truncated).toBe(true)
      expect(result.meta.next).toBe(41)
      expect(result.text).toMatch(/re-read with offset:41/)
    }
  })

  it('truncates very long lines', () => {
    const dir = tempDir()
    fs.writeFileSync(path.join(dir, 'long.txt'), 'x'.repeat(3000))
    const result = readFilePage(dir, { path: 'long.txt' })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.text).toContain('line truncated')
  })

  it('respects byte budget on wide files', () => {
    const dir = tempDir()
    const line = 'a'.repeat(500)
    const count = Math.ceil(MAX_READ_BYTES / 500) + 5
    fs.writeFileSync(path.join(dir, 'wide.txt'), Array.from({ length: count }, () => line).join('\n'))
    const result = readFilePage(dir, { path: 'wide.txt', limit: MAX_READ_LINES })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.meta.truncated).toBe(true)
      expect(Buffer.byteLength(result.text, 'utf-8')).toBeLessThan(MAX_READ_BYTES + 500)
    }
  })
})
