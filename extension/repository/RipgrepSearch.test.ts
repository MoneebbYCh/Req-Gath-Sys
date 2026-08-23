// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import path from 'node:path'
import { RipgrepSearch } from './RipgrepSearch'
import { ToolError } from '../agent/contracts/RepositoryTool'

let root: string

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'rg-root-'))
  await fs.mkdir(path.join(root, 'src'), { recursive: true })
  await fs.writeFile(path.join(root, 'src', 'auth.ts'), 'export function login() {\n  return authenticate(user)\n}\n')
  await fs.writeFile(path.join(root, 'notes.md'), 'auth handled in middleware')
  const lines = Array.from({ length: 300 }, (_, i) => `// hit ${i}`).join('\n')
  await fs.writeFile(path.join(root, 'many.ts'), lines)
})

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

describe('RipgrepSearch', () => {
  it('finds matches with paths and line numbers', async () => {
    const search = new RipgrepSearch()
    const { matches, truncated } = await search.search('auth', [root])
    expect(truncated).toBe(false)
    // rg reports absolute paths; tools relativize them later.
    expect(matches.some((m) => m.path.endsWith('src/auth.ts') && m.line === 2)).toBe(true)
    expect(matches.some((m) => m.path.endsWith('notes.md'))).toBe(true)
  })

  it('caps matches and reports truncation', async () => {
    const search = new RipgrepSearch()
    const { matches, truncated } = await search.search('hit', [root], { maxMatches: 5 })
    expect(truncated).toBe(true)
    expect(matches).toHaveLength(5)
  })

  it('rejects invalid regexes with a structured error', async () => {
    const search = new RipgrepSearch()
    await expect(search.search('([', [root])).rejects.toMatchObject({
      name: 'ToolError',
      message: expect.stringContaining('Invalid search pattern'),
    })
  })

  it('returns empty for missing patterns', async () => {
    const search = new RipgrepSearch()
    const { matches } = await search.search('zzz-no-such-token', [root])
    expect(matches).toHaveLength(0)
  })

  it('truncates very long lines', async () => {
    const search = new RipgrepSearch()
    const long = 'x'.repeat(500)
    await fs.writeFile(path.join(root, 'long.ts'), `// ${long}\n`)
    const { matches } = await search.search('x{20,}', [root], { maxLineLength: 100 })
    const hit = matches.find((m) => m.path.endsWith('long.ts'))
    expect(hit).toBeTruthy()
    expect(hit!.text.length).toBeLessThanOrEqual(101)
    expect(hit!.text.endsWith('…')).toBe(true)
  })

  it('never throws ToolError for empty roots', async () => {
    const search = new RipgrepSearch()
    const { matches } = await search.search('auth', [])
    expect(matches).toHaveLength(0)
  })

  it('is a ToolError subclass importable in tests', () => {
    expect(new ToolError('x', false).name).toBe('ToolError')
  })
})
