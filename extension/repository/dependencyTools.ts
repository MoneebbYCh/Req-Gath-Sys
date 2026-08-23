import { z } from 'zod'
import path from 'node:path'
import type { RepositoryTool } from '../agent/contracts/RepositoryTool'
import { ToolError } from '../agent/contracts/RepositoryTool'
import type { CatalogInterface } from './Catalog'
import type { RipgrepSearch } from './RipgrepSearch'
import type { FileReader } from './FileReader'
import type { DependencyAdapter, ImportEdge } from './DependencyAdapters'
import { relativize } from './tools'
import { languageFor } from './IgnorePolicy'
import { inspectPackage } from './PackageInspector'
import { isSensitivePath } from './SensitiveFilePolicy'
import { rootIdForAbsolutePath, rootIndexForId } from './WorkspaceDescriptor'

/**
 * Phase 6 dependency tools (plan §11): get_imports, get_dependencies,
 * get_dependents. v1 is on-demand — no persistent graph index (that is
 * Phase 15). Reverse lookups are a lazy lexical ripgrep scan marked with
 * provenance `inference`, honestly flagging the limitation (US-6.2).
 */

export interface DependencyToolsDeps {
  catalog: CatalogInterface
  searcher: RipgrepSearch
  reader: FileReader
  roots: string[]
  repositoryVersion: string
  adapters: DependencyAdapter[]
}

const TS_EXTENSIONS = ['', '.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.tsx', '/index.js', '/index.jsx']
const PY_EXTENSIONS = ['', '.py', '/__init__.py']
const GO_EXTENSIONS = ['']
const MAX_DEPENDENTS = 100

function resolveExtensionsFor(languageId: string): string[] {
  if (languageId === 'python') return PY_EXTENSIONS
  if (languageId === 'go') return GO_EXTENSIONS
  return TS_EXTENSIONS
}

function sensitiveBlock(path: string): ToolError {
  return new ToolError(`Sensitive file blocked by policy: ${path}`, false)
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Reads import text: whole file when small, else the top of the file with a warning. */
async function readForImports(reader: FileReader, absolutePath: string): Promise<{ content: string; warning?: string }> {
  const whole = await reader.readWhole(absolutePath)
  if (whole.ok && whole.content !== undefined) return { content: whole.content }
  const range = await reader.readRange(absolutePath, 1, 400)
  if (range.ok && range.lines) {
    return {
      content: range.lines.map((l) => l.text).join('\n'),
      warning: 'File too large — imports extracted from the first 400 lines only.',
    }
  }
  throw new ToolError(whole.error ?? range.error ?? `Could not read ${absolutePath}`, false)
}

async function extractImportsForPath(
  adapters: DependencyAdapter[],
  reader: FileReader,
  roots: string[],
  absolutePath: string,
): Promise<{ edges: ImportEdge[]; warning?: string } | { unavailable: true; reason: string }> {
  const rel = await relativize(absolutePath, roots)
  const languageId = languageFor(rel)
  const adapter = languageId ? adapters.find((a) => a.supports(languageId)) : undefined
  if (!adapter) {
    return { unavailable: true, reason: `No dependency adapter for ${languageId ?? 'this file type'}.` }
  }
  const { content, warning } = await readForImports(reader, absolutePath)
  return { edges: adapter.extractImports({ path: rel, languageId: languageId!, content }), warning }
}

/** Resolves a relative specifier against existing catalog paths. */
async function resolveLocal(
  sourceDirRel: string,
  sourceRoot: string,
  specifier: string,
  catalog: CatalogInterface,
  exts: string[],
): Promise<{ path: string; resolved: boolean }> {
  const { entries } = await catalog.scan()
  const known = new Set(entries.filter((e) => e.kind === 'file' && e.root === sourceRoot).map((e) => e.path))
  const base = path.posix.normalize(path.posix.join(sourceDirRel, specifier))
  for (const ext of exts) {
    const candidate = path.posix.normalize(`${base}${ext}`)
    if (known.has(candidate)) return { path: candidate, resolved: true }
  }
  return { path: base, resolved: false }
}

async function resolveLocationInput(
  input: { path: string; rootId?: string },
  ctx: { resolvePath(input: string): Promise<string> },
  roots: string[],
): Promise<string> {
  if (!input.rootId) return ctx.resolvePath(input.path)
  const index = rootIndexForId(roots, input.rootId)
  if (index < 0) throw new ToolError(`Unknown workspace root id: ${input.rootId}`, false)
  return ctx.resolvePath(path.join(roots[index], input.path))
}

export function createDependencyTools(deps: DependencyToolsDeps): Array<RepositoryTool<any, any>> {
  const tools: Array<RepositoryTool<any, any>> = []

  tools.push({
    name: 'get_imports',
    description:
      'List every import of one source file (TypeScript/JS, Python, Go): static, re-export, require, and dynamic imports, each with kind and provenance. ' +
      'Works without a language server. Use to see what a module pulls in; use get_dependencies when you also want specifiers resolved to actual workspace files and external package names.',
    inputSchema: z.object({
      path: z.string().min(1).describe('Source file path, workspace-root-relative.'),
      rootId: z.string().min(1).optional().describe('Workspace folder id for multi-root workspaces.'),
    }),
    execute: async (input, ctx) => {
      const resolved = await resolveLocationInput(input, ctx, deps.roots)
      if (isSensitivePath(resolved) || isSensitivePath(input.path)) throw sensitiveBlock(input.path)
      const result = await extractImportsForPath(deps.adapters, deps.reader, deps.roots, resolved)
      if ('unavailable' in result) {
        return { data: { available: false, reason: result.reason }, truncated: false, repositoryVersion: ctx.repositoryVersion }
      }
      const { edges, warning } = result
      return {
        data: {
          available: true,
          imports: edges.map((e) => ({
            target: e.target,
            kind: e.kind,
            provenance: e.provenance,
            line: e.line,
          })),
          ...(warning ? { warning } : {}),
        },
        truncated: false,
        repositoryVersion: ctx.repositoryVersion,
        evidenceCandidates: [
          {
            path: await relativize(resolved, deps.roots),
            rootId: rootIdForAbsolutePath(resolved, deps.roots)!,
            startLine: 1,
            endLine: edges.length > 0 ? Math.max(...edges.map((e) => e.line)) : 1,
            excerpt: edges.map((e) => `${e.kind} ${e.target}`).join('; ').slice(0, 500),
            kind: 'source',
            sourceTool: 'get_imports',
          },
        ],
      }
    },
  })

  tools.push({
    name: 'get_dependencies',
    description:
      'Direct dependencies of one source file, in three buckets: localDependencies (resolved to actual workspace files), ' +
      'externalPackages (imported package names), and manifestPackages (declared in the nearest package.json but not imported here). ' +
      'Unresolved specifiers are returned with resolved:false rather than guessed. Returns {available:false} for unsupported languages.',
    inputSchema: z.object({
      path: z.string().min(1).describe('Source file path, workspace-root-relative.'),
      rootId: z.string().min(1).optional().describe('Workspace folder id for multi-root workspaces.'),
    }),
    execute: async (input, ctx) => {
      const resolved = await resolveLocationInput(input, ctx, deps.roots)
      if (isSensitivePath(resolved) || isSensitivePath(input.path)) throw sensitiveBlock(input.path)
      const result = await extractImportsForPath(deps.adapters, deps.reader, deps.roots, resolved)
      if ('unavailable' in result) {
        return { data: { available: false, reason: result.reason }, truncated: false, repositoryVersion: ctx.repositoryVersion }
      }
      const { edges, warning } = result
      const rel = await relativize(resolved, deps.roots)
      const sourceRootId = rootIdForAbsolutePath(resolved, deps.roots)
      const sourceRootIndex = sourceRootId === undefined ? -1 : rootIndexForId(deps.roots, sourceRootId)
      const sourceRoot = sourceRootIndex < 0 ? undefined : deps.roots[sourceRootIndex]
      if (sourceRoot === undefined || sourceRootId === undefined) {
        throw new ToolError(`Path is outside workspace roots: ${input.path}`, false)
      }
      const sourceDir = path.posix.dirname(rel)

      const local: Array<{ path: string; rootId: string; via: string; line: number; resolved: boolean }> = []
      const external = new Set<string>()
      const exts = resolveExtensionsFor(languageFor(rel) ?? '')
      for (const edge of edges) {
        if (edge.target.startsWith('.')) {
          const r = await resolveLocal(sourceDir, sourceRoot, edge.target, deps.catalog, exts)
          local.push({ path: r.path, rootId: sourceRootId, via: edge.target, line: edge.line, resolved: r.resolved })
        } else {
          external.add(edge.target.split('/').slice(0, 2).join('/'))
        }
      }
      const externalList = [...external].sort().slice(0, 100)

      // Plan §11 acceptance: manifest-provenance edges. Dependencies declared
      // in the nearest package.json are real manifest evidence, distinct from
      // parser-derived imports.
      const manifestPackages: string[] = []
      const manifest = await inspectPackage(path.dirname(resolved), deps.roots[0] ?? path.dirname(resolved))
      if (manifest?.kind === 'npm') {
        const deps = manifest.data.dependencies as Record<string, string> | undefined
        for (const name of Object.keys(deps ?? {}).sort()) {
          if (!external.has(name)) manifestPackages.push(name)
        }
      }
      return {
        data: {
          available: true,
          localDependencies: local,
          externalPackages: externalList,
          manifestPackages: manifestPackages.slice(0, 100),
          truncated: external.size > 100,
          ...(warning ? { warning } : {}),
        },
        truncated: external.size > 100,
        repositoryVersion: ctx.repositoryVersion,
        evidenceCandidates:
          manifestPackages.length > 0 && manifest?.manifestPath
            ? [
                {
                  path: await relativize(manifest.manifestPath, deps.roots),
                  rootId: rootIdForAbsolutePath(manifest.manifestPath, deps.roots)!,
                  startLine: 1,
                  endLine: 1,
                  excerpt: manifestPackages.slice(0, 10).join(', '),
                  kind: 'manifest',
                  sourceTool: 'get_dependencies',
                },
              ]
            : undefined,
      }
    },
  })

  tools.push({
    name: 'get_dependents',
    description:
      'Reverse lookup: which workspace files import the given module? Use to assess the blast radius of a change or to find all consumers of a module. ' +
      'Lexical scan (provenance "inference"): aliased/path-mapped imports may be missed; cap 100 results. ' +
      'For exact symbol-level usage prefer find_references when a language server is available.',
    inputSchema: z.object({
      path: z.string().min(1).describe('Module file path, workspace-root-relative.'),
      rootId: z.string().min(1).optional().describe('Workspace folder id for multi-root workspaces.'),
      limit: z.number().int().min(1).max(500).optional(),
    }),
    execute: async (input, ctx) => {
      const resolved = await resolveLocationInput(input, ctx, deps.roots)
      if (isSensitivePath(resolved) || isSensitivePath(input.path)) throw sensitiveBlock(input.path)
      const rel = await relativize(resolved, deps.roots)
      const base = path.posix.basename(rel).replace(/\.(ts|tsx|js|jsx|mjs|cjs)$/, '')
      const pattern = `["'][^"']*\\b${escapeRegex(base)}\\b(?:[.](?:ts|tsx|js|jsx))?["']`

      const limit = input.limit ?? MAX_DEPENDENTS
      const { matches, truncated } = await deps.searcher.search(pattern, deps.roots, {
        maxMatches: limit,
      })
      const dependents: Array<{ path: string; rootId: string; line: number; text: string }> = []
      for (const m of matches) {
        const p = await relativize(m.path, deps.roots)
        const rootId = rootIdForAbsolutePath(m.path, deps.roots)
        const sourceRootId = rootIdForAbsolutePath(resolved, deps.roots)
        if (p === rel && rootId === sourceRootId) continue // the module itself
        if (rootId && !dependents.some((d) => d.path === p && d.rootId === rootId)) dependents.push({ path: p, rootId, line: m.line, text: m.text })
      }
      return {
        data: {
          available: true,
          provenance: 'inference',
          dependents,
          truncated,
          hint: 'Lexical scan: alias/path-mapped imports may be missed. Use find_references for exact symbol-level results.',
        },
        truncated,
        repositoryVersion: ctx.repositoryVersion,
      }
    },
  })

  return tools
}
