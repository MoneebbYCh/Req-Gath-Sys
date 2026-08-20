import { describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { formatGrepMatch, globFiles, grepSearch, parseRipgrepJson } from './ripgrepAdapter'

describe('ripgrepAdapter', () => {
  it('parseRipgrepJson extracts matches with context', () => {
    const stdout = [
      '{"type":"match","data":{"path":{"text":"/proj/src/a.ts"},"line_number":10,"lines":{"text":"export fn main\\n"}}}',
      '{"type":"context","data":{"path":{"text":"/proj/src/a.ts"},"line_number":11,"lines":{"text":"  return 1\\n"}}}',
    ].join('\n')
    const matches = parseRipgrepJson(stdout, '/proj', 10)
    expect(matches).toHaveLength(1)
    expect(matches[0]?.file).toBe('src/a.ts')
    expect(matches[0]?.line).toBe(10)
  })

  it('formatGrepMatch uses path header and line numbers', () => {
    const text = formatGrepMatch({
      file: 'src/foo.ts',
      line: 3,
      text: 'hello',
      before: [{ line: 2, text: 'prev' }],
      after: [],
    })
    expect(text).toContain('src/foo.ts:')
    expect(text).toContain('Line 3: hello')
  })

  it('globFiles finds tracked files', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'charter-rg-'))
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'src', 'visible.ts'), 'export const x = 1\n')

    const files = await globFiles({ cwd: dir, patterns: ['**/*.ts'], limit: 20 })
    expect(files.some((f) => f.includes('visible.ts'))).toBe(true)
  })

  it('grepSearch finds content in workspace files', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'charter-rg-grep-'))
    fs.writeFileSync(path.join(dir, 'needle.ts'), 'const UNIQUE_NEEDLE_TOKEN = 42\n')
    const { matches, error } = await grepSearch({
      workspaceRoot: dir,
      pattern: 'UNIQUE_NEEDLE_TOKEN',
      searchPath: dir,
      limit: 5,
    })
    expect(error).toBeUndefined()
    expect(matches.length).toBeGreaterThan(0)
  })
})
