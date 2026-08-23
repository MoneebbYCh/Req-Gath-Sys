// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import path from 'node:path'
import { FileCatalog } from './FileCatalog'

let root: string

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'cat-root-'))
  await fs.mkdir(path.join(root, 'src'), { recursive: true })
  await fs.mkdir(path.join(root, 'node_modules', 'dep'), { recursive: true })
  await fs.mkdir(path.join(root, '.git'), { recursive: true })
  await fs.mkdir(path.join(root, 'vendor'), { recursive: true })
  await fs.mkdir(path.join(root, 'dist'), { recursive: true })
  await fs.writeFile(path.join(root, 'src', 'auth.ts'), 'export function login() {}')
  await fs.writeFile(path.join(root, 'src', 'auth.test.ts'), 'test')
  await fs.writeFile(path.join(root, 'package.json'), '{"name":"demo"}')
  await fs.writeFile(path.join(root, 'node_modules', 'dep', 'index.js'), 'x')
  await fs.writeFile(path.join(root, '.git', 'config'), 'x')
  await fs.writeFile(path.join(root, 'vendor', 'lib.c'), 'x')
  await fs.writeFile(path.join(root, 'dist', 'bundle.js'), 'x')
})

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

describe('FileCatalog', () => {
  it('scans once, excludes .git/node_modules/dist, and flags vendor/test', async () => {
    const catalog = new FileCatalog([root])
    const { entries, truncated } = await catalog.scan()
    const paths = entries.map((e) => e.path)
    expect(truncated).toBe(false)
    expect(paths).toContain('src/auth.ts')
    expect(paths).toContain('vendor/lib.c')
    expect(paths.some((p) => p.includes('node_modules'))).toBe(false)
    expect(paths.some((p) => p.includes('.git'))).toBe(false)
    expect(paths.some((p) => p.includes('dist'))).toBe(false)

    const auth = entries.find((e) => e.path === 'src/auth.ts')!
    expect(auth.language).toBe('typescript')
    expect(auth.extension).toBe('ts')
    const vendor = entries.find((e) => e.path === 'vendor/lib.c')!
    expect(vendor.flags).toContain('vendor')
    const test = entries.find((e) => e.path === 'src/auth.test.ts')!
    expect(test.flags).toContain('test')
  })

  it('lists a directory with pagination', async () => {
    const catalog = new FileCatalog([root], { maxEntries: 1000 })
    await catalog.scan()
    const first = await catalog.list('src', 1, 0)
    expect(first.entries).toHaveLength(1)
    expect(first.nextCursor).toBe(1)
    const second = await catalog.list('src', 1, 1)
    expect(second.entries).toHaveLength(1)
    expect(second.nextCursor).toBeUndefined()
  })

  it('searches by name tokens', async () => {
    const catalog = new FileCatalog([root])
    await catalog.scan()
    const matches = await catalog.searchByName('auth src')
    expect(matches.map((e) => e.path)).toContain('src/auth.ts')
    expect(matches.map((e) => e.path)).toContain('src/auth.test.ts')
  })
})
