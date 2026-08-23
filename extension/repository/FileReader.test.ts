// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import path from 'node:path'
import { FileReader } from './FileReader'

let root: string

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'fr-root-'))
  await fs.writeFile(path.join(root, 'small.ts'), 'line one\nline two\nline three\n')
  await fs.writeFile(path.join(root, 'big.ts'), 'z'.repeat(40 * 1024))
  const binary = Buffer.from([0x89, 0x50, 0x00, 0x47, 0x00, 0x0d, 0x0a])
  await fs.writeFile(path.join(root, 'img.bin'), binary)
})

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

describe('FileReader', () => {
  it('reads a small file whole with a line count', async () => {
    const reader = new FileReader()
    const result = await reader.readWhole(path.join(root, 'small.ts'))
    expect(result.ok).toBe(true)
    expect(result.content).toContain('line two')
    expect(result.lineCount).toBe(3)
  })

  it('carries a content hash of the FULL source on whole and range reads (plan §7)', async () => {
    const reader = new FileReader()
    const whole = await reader.readWhole(path.join(root, 'small.ts'))
    const range = await reader.readRange(path.join(root, 'small.ts'), 1, 1)
    expect(whole.contentHash).toMatch(/^[0-9a-f]{64}$/)
    // Any range of the same file shares the file-level hash.
    expect(range.contentHash).toBe(whole.contentHash)
  })

  it('hashes dirty open buffers, so stale evidence is detectable against disk', async () => {
    const reader = new FileReader({
      readOpenBuffer: (p) => (p.endsWith('small.ts') ? 'unsaved line\n' : undefined),
    })
    const dirty = await reader.readWhole(path.join(root, 'small.ts'))
    const clean = new FileReader().readWhole(path.join(root, 'small.ts'))
    expect(dirty.contentHash).not.toBe((await clean).contentHash)
  })

  it('refuses whole reads of large files and suggests ranged reads', async () => {
    const reader = new FileReader()
    const result = await reader.readWhole(path.join(root, 'big.ts'))
    expect(result.ok).toBe(false)
    expect(result.tooLarge).toBe(true)
    expect(result.error).toContain('read_file_range')
  })

  it('detects binary files', async () => {
    const reader = new FileReader()
    const result = await reader.readWhole(path.join(root, 'img.bin'))
    expect(result.binary).toBe(true)
    expect(result.ok).toBe(false)
  })

  it('reads numbered, bounded ranges', async () => {
    const reader = new FileReader()
    const result = await reader.readRange(path.join(root, 'small.ts'), 2, 3)
    expect(result.ok).toBe(true)
    expect(result.lines).toEqual([
      { number: 2, text: 'line two' },
      { number: 3, text: 'line three' },
    ])
    expect(result.truncated).toBe(false)
  })

  it('does not mark ranges past the file end as truncated (nothing was cut)', async () => {
    const reader = new FileReader()
    const result = await reader.readRange(path.join(root, 'small.ts'), 2, 99)
    expect(result.lines?.map((l) => l.number)).toEqual([2, 3])
    expect(result.truncated).toBe(false)
  })

  it('rejects invalid ranges', async () => {
    const reader = new FileReader()
    const result = await reader.readRange(path.join(root, 'small.ts'), 5, 2)
    expect(result.ok).toBe(false)
  })

  it('prefers a dirty open buffer over disk content', async () => {
    const reader = new FileReader({
      readOpenBuffer: (p) => (p.endsWith('small.ts') ? 'unsaved line\n' : undefined),
    })
    const whole = await reader.readWhole(path.join(root, 'small.ts'))
    expect(whole.content).toBe('unsaved line\n')
    const range = await reader.readRange(path.join(root, 'small.ts'), 1, 1)
    expect(range.lines).toEqual([{ number: 1, text: 'unsaved line' }])
  })

  it('reports missing files', async () => {
    const reader = new FileReader()
    const result = await reader.readWhole(path.join(root, 'nope.ts'))
    expect(result.ok).toBe(false)
    expect(result.error).toContain('File not found')
  })

  it('range reads scan huge files in bounded chunks instead of loading them whole (plan §9)', async () => {
    const huge = path.join(root, 'huge.ts')
    // 30 MB file, 100-char lines — the reader must never load this whole.
    const line = 'a'.repeat(99)
    const content = Array.from({ length: 300_000 }, () => line).join('\n')
    await fs.writeFile(huge, content)

    const reader = new FileReader()
    const before = process.memoryUsage().heapUsed
    const result = await reader.readRange(huge, 1, 3)
    const after = process.memoryUsage().heapUsed
    expect(result.ok).toBe(true)
    expect(result.lines).toHaveLength(3)
    expect(result.lines![0].text).toHaveLength(99)
    // Loose assertion: reading 30 MB whole would add ~30 MB to the heap.
    expect(after - before).toBeLessThan(8 * 1024 * 1024)
  })

  it('rejects ranges that start beyond the bounded scan limit', async () => {
    const deep = path.join(root, 'deep.ts')
    const content = Array.from({ length: 200_000 }, (_, i) => `line ${i}`).join('\n')
    await fs.writeFile(deep, content)
    const reader = new FileReader({ maxScanBytes: 32 * 1024 }) // small cap → scan ends early
    const result = await reader.readRange(deep, 50_000, 50_002)
    expect(result.ok).toBe(false)
    expect(result.error).toContain('bounded scan limit')
  })

  it('detects a file changing during a read and retries (plan §9 TOCTOU)', async () => {
    const path2 = path.join(root, 'mutating.ts')
    await fs.writeFile(path2, 'version one\n')
    const original = await fs.readFile(path2)
    let calls = 0
    const reader = new FileReader({
      readFileFn: async (p) => {
        calls++
        // Mutate the file every time it is read: each read observes a new
        // mtime/size, so the before/after stat comparison must flag it.
        await fs.writeFile(p, `version ${calls}\n`)
        return original // the content we actually return
      },
    })
    const result = await reader.readWhole(path2)
    expect(result.ok).toBe(true)
    // The file kept changing across the retry → the read is flagged unstable.
    expect(result.changedDuringRead).toBe(true)
    expect(calls).toBeGreaterThan(1) // a retry actually happened
  })

  it('leaves changedDuringRead unset for stable files', async () => {
    const reader = new FileReader()
    const stable = await reader.readWhole(path.join(root, 'small.ts'))
    expect(stable.ok).toBe(true)
    expect(stable.changedDuringRead).toBeUndefined()
  })

  it('serves repeated identical whole and range reads from the cache (plan §9/§15)', async () => {
    const target = path.join(root, 'small.ts')
    const raw = await fs.readFile(target)
    let reads = 0
    const reader = new FileReader({
      readFileFn: async () => {
        reads++
        return raw
      },
    })

    const first = await reader.readWhole(target)
    const second = await reader.readWhole(target)
    expect(reads).toBe(1) // second whole read served from cache
    expect(second.content).toBe(first.content)
    expect(second.contentHash).toBe(first.contentHash)

    const r1 = await reader.readRange(target, 1, 2)
    const r2 = await reader.readRange(target, 1, 2)
    expect(reads).toBe(2) // one whole read + one range read, both cached after
    expect(r2.lines).toEqual(r1.lines)
    expect(r2.contentHash).toBe(r1.contentHash)
  })

  it('bypasses the cache when the file mtime changes', async () => {
    const target = path.join(root, 'cache-bust.ts')
    await fs.writeFile(target, 'version one\n')
    await new Promise((r) => setTimeout(r, 10)) // ensure a distinct mtime
    let reads = 0
    const reader = new FileReader({
      readFileFn: async (p) => {
        reads++
        return fs.readFile(p)
      },
    })

    const a = await reader.readWhole(target)
    expect(a.content).toContain('version one')

    await fs.writeFile(target, 'version two\n')
    await new Promise((r) => setTimeout(r, 10))
    const b = await reader.readWhole(target)
    expect(reads).toBe(2) // mtime in the key → cache miss → fresh read
    expect(b.content).toContain('version two')
  })
})
