// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import path from 'node:path'
import { RepositoryService } from './RepositoryService'
import { ToolError } from '../agent/contracts/RepositoryTool'

let root: string

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'repo-root-'))
  await fs.mkdir(path.join(root, 'src'), { recursive: true })
  await fs.mkdir(path.join(root, 'test'), { recursive: true })
  await fs.writeFile(
    path.join(root, 'src', 'auth.ts'),
    'export function login() {\n  return authenticate(user)\n}\n',
  )
  await fs.writeFile(path.join(root, 'src', 'auth.test.ts'), 'import { login } from "./auth"\n')
  await fs.writeFile(path.join(root, 'notes.md'), 'auth handled in middleware')
  await fs.writeFile(path.join(root, 'package.json'), '{"name":"demo","dependencies":{"react":"^19"}}')
  await fs.writeFile(path.join(root, '.env'), 'API_KEY=supersecret')
  await fs.writeFile(path.join(root, '.env.example'), 'API_KEY=your-key-here')
  await fs.writeFile(path.join(root, 'big.ts'), 'z'.repeat(40 * 1024))
})

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

function service(overrides: Partial<ConstructorParameters<typeof RepositoryService>[0]> = {}) {
  return new RepositoryService({ roots: [root], repositoryVersion: 'rv-test', ...overrides })
}

function signal(): AbortSignal {
  return new AbortController().signal
}

describe('RepositoryService tools', () => {
  it('exposes model tool definitions with JSON schemas', () => {
    const defs = service().modelToolDefinitions()
    // Phase 5 tools + Phase 6 dependency tools; LSP tools register only when a bridge is provided.
    expect(defs.map((d) => d.name)).toEqual([
      'list_files',
      'search_files',
      'search_code',
      'read_file',
      'read_file_range',
      'get_project_structure',
      'get_package_info',
      'get_imports',
      'get_dependencies',
      'get_dependents',
    ])
    for (const def of defs) {
      expect(typeof def.inputJsonSchema).toBe('object')
    }
  })

  it('list_files browses with metadata and pagination', async () => {
    const svc = service()
    const all = await svc.executeTool('list_files', {}, signal())
    const allEntries = (all.data as { entries: Array<{ path: string }> }).entries
    expect(allEntries.some((e) => e.path === 'src')).toBe(true)

    const first = await svc.executeTool('list_files', { limit: 3 }, signal())
    const data = first.data as { entries: Array<{ path: string; kind: string }>; nextCursor: number }
    expect(data.entries).toHaveLength(3)
    expect(data.nextCursor).toBe(3)

    const scoped = await svc.executeTool('list_files', { path: 'src' }, signal())
    const scopedData = scoped.data as { entries: Array<{ path: string; flags: string[] }> }
    expect(scopedData.entries.map((e) => e.path).sort()).toEqual(['src/auth.test.ts', 'src/auth.ts'])
    expect(scopedData.entries.find((e) => e.path.endsWith('auth.test.ts'))?.flags).toContain('test')
  })

  it('search_files finds by name tokens', async () => {
    const r = await service().executeTool('search_files', { query: 'auth src' }, signal())
    const paths = (r.data as { matches: Array<{ path: string }> }).matches.map((m) => m.path)
    expect(paths).toContain('src/auth.ts')
  })

  it('search_code returns bounded, root-relative matches', async () => {
    const r = await service().executeTool('search_code', { pattern: 'auth' }, signal())
    const matches = (r.data as { matches: Array<{ path: string; line: number; text: string }> }).matches
    expect(matches.some((m) => m.path === 'src/auth.ts' && m.line === 2)).toBe(true)
    expect(matches.some((m) => m.path === 'notes.md')).toBe(true)
  })

  it('search_code never exposes sensitive hidden files', async () => {
    const sensitive = ['.env', '.env.production', 'server.pem', 'id_rsa', 'credentials.json']
    for (const file of sensitive) await fs.writeFile(path.join(root, file), 'secret-search-marker')

    const r = await service().executeTool('search_code', { pattern: 'secret-search-marker' }, signal())
    expect((r.data as { matches: unknown[] }).matches).toEqual([])
  })

  it('search_code rejects invalid patterns', async () => {
    await expect(service().executeTool('search_code', { pattern: '([' }, signal())).rejects.toBeInstanceOf(
      ToolError,
    )
  })

  it('read_file reads small files and prefers dirty open buffers', async () => {
    const r = await service().executeTool('read_file', { path: 'notes.md' }, signal())
    expect((r.data as { content: string }).content).toContain('middleware')
    expect(r.evidenceCandidates?.[0]).toMatchObject({ path: 'notes.md', sourceTool: 'read_file' })

    const dirty = service({
      readOpenBuffer: (p) => (p.endsWith('notes.md') ? 'unsaved content' : undefined),
    })
    const r2 = await dirty.executeTool('read_file', { path: 'notes.md' }, signal())
    expect((r2.data as { content: string }).content).toBe('unsaved content')
  })

  it('read_file refuses large files with guidance', async () => {
    const r = await service().executeTool('read_file', { path: 'big.ts' }, signal())
    expect(r.data).toMatchObject({ tooLarge: true })
    expect((r.data as { error: string }).error).toContain('read_file_range')
  })

  it('read_file blocks sensitive files but allows .env.example', async () => {
    await expect(service().executeTool('read_file', { path: '.env' }, signal())).rejects.toMatchObject({
      message: expect.stringContaining('Sensitive file'),
    })
    const r = await service().executeTool('read_file', { path: '.env.example' }, signal())
    expect((r.data as { content: string }).content).toContain('your-key-here')
  })

  it('read_file_range returns numbered bounded lines with evidence', async () => {
    const r = await service().executeTool(
      'read_file_range',
      { path: 'src/auth.ts', startLine: 1, endLine: 2 },
      signal(),
    )
    const lines = (r.data as { lines: Array<{ number: number; text: string }> }).lines
    expect(lines.map((l) => l.number)).toEqual([1, 2])
    expect(r.evidenceCandidates?.[0]).toMatchObject({ path: 'src/auth.ts', startLine: 1, endLine: 2 })
  })

  it('get_project_structure summarizes topology with package markers', async () => {
    const r = await service().executeTool('get_project_structure', {}, signal())
    const roots = (r.data as { roots: Array<{ name: string; fileCount: number; children?: Array<{ name: string }> }> }).roots
    const src = roots.find((x) => x.name === 'src')
    expect(src?.fileCount).toBe(2)
  })

  it('get_package_info parses the manifest', async () => {
    const r = await service().executeTool('get_package_info', { path: 'src' }, signal())
    expect(r.data).toMatchObject({ found: true, kind: 'npm' })
    expect((r.data as { data: { name: string } }).data.name).toBe('demo')
  })

  it('rejects path traversal through the gateway', async () => {
    await expect(
      service().executeTool('read_file', { path: '../outside.ts' }, signal()),
    ).rejects.toMatchObject({ message: expect.stringContaining('outside the workspace') })
  })

  it('list_files hides sensitive paths with an honest warning (plan §9)', async () => {
    const r = await service().executeTool('list_files', {}, signal())
    const entries = (r.data as { entries: Array<{ path: string }> }).entries
    expect(entries.some((e) => e.path === '.env')).toBe(false) // never reaches the model
    expect(entries.some((e) => e.path === '.env.example')).toBe(true) // safe example stays
    expect(r.warnings?.some((w) => w.includes('hidden'))).toBe(true)
  })

  it('list_files supports the pattern and root params (plan §10)', async () => {
    const svc = service()
    const r = await svc.executeTool('list_files', { path: 'src', pattern: '*test*' }, signal())
    const paths = (r.data as { entries: Array<{ path: string }> }).entries.map((e) => e.path)
    expect(paths).toEqual(['src/auth.test.ts'])

    await expect(
      svc.executeTool('list_files', { root: 99 }, signal()),
    ).rejects.toMatchObject({ message: expect.stringContaining('root index') })
  })

  it('search_code paginates with offset/nextCursor (plan §10)', async () => {
    const svc = service()
    const first = await svc.executeTool('search_code', { pattern: 'auth', limit: 2 }, signal())
    const firstData = first.data as { matches: unknown[]; nextCursor: number }
    expect(firstData.matches).toHaveLength(2)
    expect(firstData.nextCursor).toBe(2)

    const second = await svc.executeTool(
      'search_code',
      { pattern: 'auth', limit: 2, offset: firstData.nextCursor },
      signal(),
    )
    const secondData = second.data as { matches: Array<{ path: string }> }
    expect(secondData.matches.length).toBeGreaterThan(0)
    // No overlap with the first page.
    const firstPaths = (firstData.matches as Array<{ path: string; line: number }>).map(
      (m) => `${m.path}:${m.line}`,
    )
    const secondPaths = (secondData.matches as Array<{ path: string; line: number }>).map(
      (m) => `${m.path}:${m.line}`,
    )
    expect(secondPaths.some((p) => firstPaths.includes(p))).toBe(false)
  })

  it('includes a root locator when duplicate relative paths exist across workspace folders', async () => {
    const secondRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'repo-root-secondary-'))
    await fs.mkdir(path.join(secondRoot, 'src'))
    await fs.writeFile(path.join(secondRoot, 'src', 'auth.ts'), 'export const auth = "secondary"')
    const svc = new RepositoryService({ roots: [root, secondRoot], repositoryVersion: 'rv-test' })

    const code = await svc.executeTool('search_code', { pattern: 'auth' }, signal())
    const matches = (code.data as { matches: Array<{ path: string; root: number }> }).matches
    expect(new Set(matches.filter((m) => m.path === 'src/auth.ts').map((m) => m.root))).toEqual(new Set([0, 1]))

    const selected = await svc.executeTool('read_file', { path: 'src/auth.ts', root: 1 }, signal())
    expect((selected.data as { content: string }).content).toContain('secondary')

    await fs.rm(secondRoot, { recursive: true, force: true })
  })

  it('exposes gateway metrics counters (plan §9 responsibilities)', async () => {
    const svc = service()
    await svc.executeTool('get_project_structure', {}, signal())
    await expect(svc.executeTool('read_file', { path: 42 as never }, signal())).rejects.toBeInstanceOf(
      ToolError,
    )
    expect(svc.gateway.calls).toBe(2)
    expect(svc.gateway.validationErrors).toBe(1)
    expect(svc.gateway.errors).toBe(1)
    expect(svc.gateway.totalDurationMs).toBeGreaterThanOrEqual(0)
  })
})
