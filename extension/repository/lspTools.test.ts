// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import path from 'node:path'
import { RepositoryService } from './RepositoryService'
import type { LspBridge, LspDiagnostic } from './LspBridge'
import { ToolError } from '../agent/contracts/RepositoryTool'
import { workspaceRootId } from './WorkspaceDescriptor'

let root: string

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'lsp-root-'))
  await fs.mkdir(path.join(root, 'src'), { recursive: true })
  await fs.writeFile(path.join(root, 'src', 'auth.ts'), 'export function login() {}\n')
  await fs.writeFile(path.join(root, 'main.tf'), 'resource "aws_s3_bucket" "b" {}\n')
  await fs.writeFile(path.join(root, '.env'), 'API_KEY=supersecret')
})

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

function loc(file: string, startLine: number, endLine: number, name?: string) {
  return {
    path: path.join(root, file),
    startLine,
    startColumn: 1,
    endLine,
    endColumn: 5,
    name,
  }
}

function fakeBridge(overrides: Partial<LspBridge> = {}): LspBridge {
  return {
    workspaceSymbols: vi.fn(async () => [loc('src/auth.ts', 1, 1, 'login')]),
    documentSymbols: vi.fn(async () => [
      { name: 'login', kind: 'Function', startLine: 1, endLine: 1 },
    ]),
    definition: vi.fn(async () => [loc('src/auth.ts', 1, 1)]),
    references: vi.fn(async () => [loc('src/auth.ts', 1, 1), loc('src/auth.ts', 2, 2)]),
    implementations: vi.fn(async () => []),
    diagnostics: vi.fn(async (): Promise<LspDiagnostic[]> => [
      { severity: 'error', line: 2, message: 'TS2304: cannot find name user', source: 'ts', code: '2304' },
    ]),
    callHierarchy: vi.fn(async () => ({
      incoming: [{ name: 'app', location: loc('src/auth.ts', 5, 5), fromRanges: [loc('src/auth.ts', 6, 6)] }],
      outgoing: [],
    })),
    probeWorkspaceSymbols: vi.fn(async () => ({ available: true })),
    ...overrides,
  }
}

function service(bridge: LspBridge) {
  return new RepositoryService({ roots: [root], repositoryVersion: 'rv-lsp', lspBridge: bridge })
}

function signal(): AbortSignal {
  return new AbortController().signal
}

describe('LSP tools', () => {
  it('find_symbol returns relativized, evidence-backed symbols', async () => {
    const r = await service(fakeBridge()).executeTool('find_symbol', { query: 'login' }, signal())
    expect(r.data).toMatchObject({ available: true })
    const symbols = (r.data as { symbols: Array<{ path: string; name?: string }> }).symbols
    expect(symbols).toMatchObject([{ path: 'src/auth.ts', startLine: 1, endLine: 1, name: 'login', rootId: expect.any(String) }])
    expect(r.evidenceCandidates?.[0]).toMatchObject({ path: 'src/auth.ts', rootId: expect.any(String), kind: 'lsp', sourceTool: 'find_symbol' })
  })

  it('find_symbol degrades to available:false when the provider is missing', async () => {
    const bridge = fakeBridge({
      workspaceSymbols: vi.fn(async () => {
        throw new Error('provider not found')
      }),
    })
    const r = await service(bridge).executeTool('find_symbol', { query: 'login' }, signal())
    expect(r.data).toMatchObject({ available: false })
    expect((r.data as { reason: string }).reason).toContain('provider not found')
  })

  it('retains root identity for colliding relative LSP locations and accepts it as an input locator', async () => {
    const secondRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'lsp-secondary-'))
    await fs.mkdir(path.join(secondRoot, 'src'))
    await fs.writeFile(path.join(secondRoot, 'src', 'auth.ts'), 'export const secondary = true\n')
    const secondFile = path.join(secondRoot, 'src', 'auth.ts')
    const bridge = fakeBridge({
      workspaceSymbols: vi.fn(async () => [loc('src/auth.ts', 1, 1, 'primary'), { ...loc('src/auth.ts', 1, 1, 'secondary'), path: secondFile }]),
      definition: vi.fn(async () => [{ ...loc('src/auth.ts', 1, 1), path: secondFile }]),
    })
    const svc = new RepositoryService({ roots: [root, secondRoot], repositoryVersion: 'rv-two-root', lspBridge: bridge })
    const symbols = ((await svc.executeTool('find_symbol', { query: 'auth' }, signal())).data as { symbols: Array<{ path: string; rootId: string }> }).symbols
    expect(new Set(symbols.filter((symbol) => symbol.path === 'src/auth.ts').map((symbol) => symbol.rootId))).toEqual(
      new Set([workspaceRootId(root), workspaceRootId(secondRoot)]),
    )
    const definition = await svc.executeTool('find_definition', { path: 'src/auth.ts', rootId: workspaceRootId(secondRoot), line: 1 }, signal())
    expect((definition.data as { locations: Array<{ rootId: string }> }).locations[0]?.rootId).toBe(workspaceRootId(secondRoot))
    await fs.rm(secondRoot, { recursive: true, force: true })
  })

  it('find_definition converts 1-based input, drops out-of-workspace locations, and dedupes', async () => {
    const definition = vi.fn(async () => [
      loc('src/auth.ts', 1, 1),
      loc('src/auth.ts', 1, 1), // duplicate
      { ...loc('src/auth.ts', 1, 1), path: path.join(os.tmpdir(), 'outside.ts') }, // out of workspace
    ])
    const bridge = fakeBridge({ definition })
    const r = await service(bridge).executeTool(
      'find_definition',
      { path: 'src/auth.ts', line: 2, column: 3 },
      signal(),
    )
    // macOS: tmpdir resolves through /var → /private/var, so compare realpaths.
    const args = (definition.mock.calls as unknown[][])[0]
    expect(args?.[0]).toBe(await fs.realpath(path.join(root, 'src', 'auth.ts')))
    expect(args?.[1]).toBe(2)
    expect(args?.[2]).toBe(3)
    const locations = (r.data as { locations: Array<{ path: string }> }).locations
    expect(locations).toMatchObject([{ path: 'src/auth.ts', startLine: 1, endLine: 1, rootId: expect.any(String) }])
    expect(r.evidenceCandidates?.[0]).toMatchObject({ kind: 'lsp', sourceTool: 'find_definition' })
  })

  it('find_references caps results and signals truncation', async () => {
    const bridge = fakeBridge({
      references: vi.fn(async () => Array.from({ length: 5 }, (_, i) => loc('src/auth.ts', i + 1, i + 1))),
    })
    const r = await service(bridge).executeTool(
      'find_references',
      { path: 'src/auth.ts', line: 1, limit: 2 },
      signal(),
    )
    const data = r.data as { locations: unknown[]; truncated: boolean; refineHint?: string }
    expect(data.locations).toHaveLength(2)
    expect(data.truncated).toBe(true)
    expect(data.refineHint).toBeDefined()
  })

  it('find_implementations degrades when the provider throws', async () => {
    const bridge = fakeBridge({
      implementations: vi.fn(async () => {
        throw new Error('no implementations provider')
      }),
    })
    const r = await service(bridge).executeTool(
      'find_implementations',
      { path: 'src/auth.ts', line: 1 },
      signal(),
    )
    expect(r.data).toMatchObject({ available: false })
  })

  it('get_document_symbols returns the symbol outline', async () => {
    const r = await service(fakeBridge()).executeTool('get_document_symbols', { path: 'src/auth.ts' }, signal())
    const symbols = (r.data as { symbols: Array<{ name: string; kind: string }> }).symbols
    expect(symbols).toEqual([{ name: 'login', kind: 'Function', startLine: 1, endLine: 1 }])
  })

  it('get_diagnostics returns severity + line + message', async () => {
    const r = await service(fakeBridge()).executeTool('get_diagnostics', { path: 'src/auth.ts' }, signal())
    const diagnostics = (r.data as { diagnostics: Array<{ severity: string; line: number }> }).diagnostics
    expect(diagnostics[0]).toMatchObject({ severity: 'error', line: 2 })
  })

  it('get_call_hierarchy returns incoming/outgoing call sites (plan §11 where supported)', async () => {
    const r = await service(fakeBridge()).executeTool(
      'get_call_hierarchy',
      { path: 'src/auth.ts', line: 2, column: 3 },
      signal(),
    )
    expect(r.data).toMatchObject({ available: true })
    const data = r.data as {
      incoming: Array<{ name: string; at?: { path: string }; callSites: Array<{ path: string }> }>
    }
    expect(data.incoming[0].name).toBe('app')
    expect(data.incoming[0].at?.path).toBe('src/auth.ts')
    expect(r.evidenceCandidates?.[0]).toMatchObject({ kind: 'lsp', sourceTool: 'get_call_hierarchy' })
  })

  it('get_call_hierarchy degrades when the provider lacks support', async () => {
    const bridge = fakeBridge({
      callHierarchy: vi.fn(async () => {
        throw new Error('call hierarchy not supported')
      }),
    })
    const r = await service(bridge).executeTool('get_call_hierarchy', { path: 'src/auth.ts', line: 1 }, signal())
    expect(r.data).toMatchObject({ available: false })
  })

  it('LSP tools block sensitive files', async () => {
    await expect(
      service(fakeBridge()).executeTool('find_definition', { path: '.env', line: 1 }, signal()),
    ).rejects.toBeInstanceOf(ToolError)
  })

  it('get_repository_capabilities reports per-language intelligence', async () => {
    const r = await service(fakeBridge()).executeTool('get_repository_capabilities', {}, signal())
    const languages = (r.data as { languages: Record<string, Record<string, boolean>> }).languages
    expect(languages.typescript).toMatchObject({
      lsp: true,
      definitions: true,
      references: true,
      callHierarchy: true,
      importGraph: true,
      lexicalSearch: true,
    })
    expect(languages.terraform).toMatchObject({ lsp: false, importGraph: false, lexicalSearch: true })
  })

  it('get_repository_capabilities reports lsp:false when no workspace-symbol provider exists', async () => {
    const bridge = fakeBridge({ probeWorkspaceSymbols: vi.fn(async () => ({ available: false })) })
    const r = await service(bridge).executeTool('get_repository_capabilities', {}, signal())
    const languages = (r.data as { languages: Record<string, Record<string, boolean>> }).languages
    expect(languages.typescript.lsp).toBe(false)
  })

  it('registers no LSP tools when no bridge is provided', async () => {
    const noBridge = new RepositoryService({ roots: [root], repositoryVersion: 'rv-nobridge' })
    expect(noBridge.modelToolDefinitions().map((d) => d.name)).not.toContain('find_symbol')
    await expect(
      noBridge.executeTool('find_symbol', { query: 'login' }, signal()),
    ).rejects.toMatchObject({ message: expect.stringContaining('Unknown repository tool') })
  })
})
