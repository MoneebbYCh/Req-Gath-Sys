import { z } from 'zod'
import path from 'node:path'
import type { RepositoryTool } from '../agent/contracts/RepositoryTool'
import { ToolError } from '../agent/contracts/RepositoryTool'
import type { LspBridge } from './LspBridge'
import type { CatalogInterface } from './Catalog'
import type { DependencyAdapter } from './DependencyAdapters'
import { relativize } from './tools'
import { isSensitivePath } from './SensitiveFilePolicy'
import { rootIdForAbsolutePath, rootIndexForId } from './WorkspaceDescriptor'

/**
 * Phase 6 LSP tools (plan §11): find_symbol, find_definition, find_references,
 * find_implementations, get_document_symbols, get_diagnostics, and
 * get_repository_capabilities. All execution goes through the injected
 * `LspBridge` (host-side vscode); a missing/crashed language provider degrades
 * to `{ available: false }` data instead of failing the task, so the model can
 * fall back to the lexical Phase 5 tools.
 */

export interface LspToolsDeps {
  roots: string[]
  repositoryVersion: string
  bridge: LspBridge
  catalog: CatalogInterface
  /** Used by capability reporting for the importGraph flag. */
  dependencyAdapters: DependencyAdapter[]
}

interface RawLocation {
  path: string
  startLine: number
  endLine: number
  name?: string
}

interface ToolLocation {
  path: string
  rootId: string
  startLine: number
  endLine: number
  name?: string
}

const DEFAULT_LOCATION_LIMIT = 100
const DEFAULT_REFERENCE_LIMIT = 200

/** Bridge errors degrade, never fail the task (plan §11 acceptance). */
async function degrade<T>(fn: () => Promise<T>): Promise<{ data: T | null; reason?: string }> {
  try {
    return { data: await fn() }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    return {
      data: null,
      reason: reason.includes('cancelled') ? reason : `Language provider unavailable: ${reason}`,
    }
  }
}

async function toToolLocations(locations: RawLocation[], roots: string[]): Promise<ToolLocation[]> {
  const out: ToolLocation[] = []
  const seen = new Set<string>()
  for (const loc of locations) {
    const rel = await relativize(loc.path, roots)
    // Providers can return locations outside the workspace — drop them.
    // relativize falls back to the raw path, which is absolute for outsiders.
    if (path.posix.isAbsolute(rel) || rel.startsWith('..') || rel.includes(':\\')) continue
    const rootId = rootIdForAbsolutePath(loc.path, roots)
    if (!rootId) continue
    const key = `${rootId}:${rel}:${loc.startLine}:${loc.endLine}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(
      loc.name !== undefined
        ? { path: rel, rootId, startLine: loc.startLine, endLine: loc.endLine, name: loc.name }
        : { path: rel, rootId, startLine: loc.startLine, endLine: loc.endLine },
    )
  }
  return out
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

function sensitiveBlock(path: string): ToolError {
  return new ToolError(`Sensitive file blocked by policy: ${path}`, false)
}

function unavailable(reason: string | undefined, repositoryVersion: string) {
  return { data: { available: false, reason: reason ?? 'No language provider.' }, truncated: false, repositoryVersion }
}

export function createLspTools(deps: LspToolsDeps): Array<RepositoryTool<any, any>> {
  const tools: Array<RepositoryTool<any, any>> = []

  tools.push({
    name: 'find_symbol',
    description:
      'Locate where a named class/function/type lives anywhere in the workspace (LSP workspace symbols) — call before reading when you know a symbol name but not its file. ' +
      'Returns name, kind, container, and location. When it returns {available:false} there is no language server: fall back to search_code with the symbol name.',
    inputSchema: z.object({
      query: z.string().min(1).describe('Symbol name or prefix, e.g. "UserService".'),
      limit: z.number().int().min(1).max(200).optional(),
    }),
    execute: async (input, ctx) => {
      const { data, reason } = await degrade(() => deps.bridge.workspaceSymbols(input.query, ctx.signal))
      if (!data) return unavailable(reason, ctx.repositoryVersion)
      const limit = input.limit ?? DEFAULT_LOCATION_LIMIT
      const capped = data.slice(0, limit)
      const locations = await toToolLocations(capped, deps.roots)
      const truncated = data.length > limit
      return {
        data: {
          available: true,
          symbols: locations,
          truncated,
          ...(truncated ? { refineHint: 'Too many symbols — narrow the query.' } : {}),
        },
        truncated,
        repositoryVersion: ctx.repositoryVersion,
        evidenceCandidates: locations.slice(0, 10).map((l) => ({
          path: l.path,
          rootId: l.rootId,
          startLine: l.startLine,
          endLine: l.endLine,
          excerpt: `symbol: ${l.name ?? input.query}`,
          kind: 'lsp',
          sourceTool: 'find_symbol',
        })),
      }
    },
  })

  /** Shared shape for definition/reference/implementation tools. */
  function locationTool(
    name: string,
    description: string,
    call: (path: string, line: number, column: number, signal: AbortSignal) => Promise<RawLocation[]>,
    defaultLimit: number,
  ): RepositoryTool<any, any> {
    return {
      name,
      description,
      inputSchema: z.object({
        path: z.string().min(1).describe('File containing the symbol, workspace-root-relative.'),
        rootId: z.string().min(1).optional().describe('Workspace folder id for multi-root workspaces.'),
        line: z.number().int().min(1).describe('1-based line of the symbol.'),
        column: z.number().int().min(1).optional().describe('1-based column on that line; defaults to 1. Point AT the symbol, not beside it.'),
        limit: z.number().int().min(1).max(500).optional(),
      }),
      execute: async (input, ctx) => {
        const resolved = await resolveLocationInput(input, ctx, deps.roots)
        if (isSensitivePath(resolved) || isSensitivePath(input.path)) throw sensitiveBlock(input.path)
        const { data, reason } = await degrade(() => call(resolved, input.line, input.column ?? 1, ctx.signal))
        if (!data) return unavailable(reason, ctx.repositoryVersion)
        const limit = input.limit ?? defaultLimit
        const capped = data.slice(0, limit)
        const locations = await toToolLocations(capped, deps.roots)
        const truncated = data.length > limit
        return {
          data: {
            available: true,
            locations,
            truncated,
            ...(truncated ? { refineHint: 'Too many results — narrow the location.' } : {}),
          },
          truncated,
          repositoryVersion: ctx.repositoryVersion,
          evidenceCandidates: locations.slice(0, 10).map((l) => ({
            path: l.path,
            rootId: l.rootId,
            startLine: l.startLine,
            endLine: l.endLine,
            excerpt: `${name} hit`,
            kind: 'lsp',
            sourceTool: name,
          })),
        }
      },
    }
  }

  tools.push(
    locationTool(
      'find_definition',
      'Jump to where the symbol at path:line:column is defined — use after find_symbol or a search hit to reach the implementation. ' +
        'Returns definition location(s). When it returns {available:false}, fall back to search_code for the symbol name.',
      (p, l, c, s) => deps.bridge.definition(p, l, c, s),
      DEFAULT_LOCATION_LIMIT,
    ),
    locationTool(
      'find_references',
      'Find every place the symbol at path:line:column is used across the workspace — use to answer "who calls/uses this" and to assess blast radius. ' +
        'Bounded; pass limit for more. When it returns {available:false}, fall back to get_dependents or search_code.',
      (p, l, c, s) => deps.bridge.references(p, l, c, s),
      DEFAULT_REFERENCE_LIMIT,
    ),
    locationTool(
      'find_implementations',
      'Find concrete implementations of the interface/method at path:line:column. When it returns {available:false}, fall back to search_code.',
      (p, l, c, s) => deps.bridge.implementations(p, l, c, s),
      DEFAULT_LOCATION_LIMIT,
    ),
  )

  tools.push({
    name: 'get_document_symbols',
    description:
      'Get the symbol outline of one file (functions, classes, exports with line numbers) WITHOUT reading its content — ' +
      'use to decide which line range of a large file is worth reading via read_file_range. ' +
      'When it returns {available:false}, fall back to search_code scoped to the file.',
    inputSchema: z.object({
      path: z.string().min(1).describe('File path, workspace-root-relative.'),
      rootId: z.string().min(1).optional().describe('Workspace folder id for multi-root workspaces.'),
    }),
    execute: async (input, ctx) => {
      const resolved = await resolveLocationInput(input, ctx, deps.roots)
      if (isSensitivePath(resolved) || isSensitivePath(input.path)) throw sensitiveBlock(input.path)
      const { data, reason } = await degrade(() => deps.bridge.documentSymbols(resolved, ctx.signal))
      if (!data) return unavailable(reason, ctx.repositoryVersion)
      const rel = await relativize(resolved, deps.roots)
      return {
        data: { available: true, symbols: data.slice(0, 500) },
        truncated: data.length > 500,
        repositoryVersion: ctx.repositoryVersion,
        evidenceCandidates: [{ path: rel, rootId: rootIdForAbsolutePath(resolved, deps.roots)!, startLine: 1, endLine: 1, excerpt: 'document symbol outline', kind: 'lsp', sourceTool: 'get_document_symbols' }],
      }
    },
  })

  tools.push({
    name: 'get_diagnostics',
    description:
      'Return current editor diagnostics for a file (errors/warnings with line + message), bounded to 200. Useful for "what is broken here" questions.',
    inputSchema: z.object({
      path: z.string().min(1).describe('File path, workspace-root-relative.'),
      rootId: z.string().min(1).optional().describe('Workspace folder id for multi-root workspaces.'),
    }),
    execute: async (input, ctx) => {
      const resolved = await resolveLocationInput(input, ctx, deps.roots)
      if (isSensitivePath(resolved) || isSensitivePath(input.path)) throw sensitiveBlock(input.path)
      const { data, reason } = await degrade(() => deps.bridge.diagnostics(resolved, ctx.signal))
      if (!data) return unavailable(reason, ctx.repositoryVersion)
      const capped = data.slice(0, 200)
      return {
        data: { available: true, diagnostics: capped, truncated: data.length > 200 },
        truncated: data.length > 200,
        repositoryVersion: ctx.repositoryVersion,
      }
    },
  })

  tools.push({
    name: 'get_call_hierarchy',
    description:
      'Callers AND callees of the symbol at path:line:column (1-based) in one call — use to map a call chain quickly instead of running find_references and get_imports separately. ' +
      'Returns empty/unavailable where the language provider lacks call hierarchy support — use find_references as fallback.',
    inputSchema: z.object({
      path: z.string().min(1).describe('File containing the symbol, workspace-root-relative.'),
      rootId: z.string().min(1).optional().describe('Workspace folder id for multi-root workspaces.'),
      line: z.number().int().min(1).describe('1-based line of the symbol.'),
      column: z.number().int().min(1).optional(),
      limit: z.number().int().min(1).max(500).optional(),
    }),
    execute: async (input, ctx) => {
      const resolved = await resolveLocationInput(input, ctx, deps.roots)
      if (isSensitivePath(resolved) || isSensitivePath(input.path)) throw sensitiveBlock(input.path)
      const { data, reason } = await degrade(() =>
        deps.bridge.callHierarchy(resolved, input.line, input.column ?? 1, ctx.signal),
      )
      if (!data) return unavailable(reason, ctx.repositoryVersion)
      const limit = input.limit ?? DEFAULT_REFERENCE_LIMIT
      const mapEntry = async (e: { name: string; location: RawLocation; fromRanges: RawLocation[] }) => ({
        name: e.name,
        at: (await toToolLocations([e.location], deps.roots))[0],
        callSites: await toToolLocations(e.fromRanges, deps.roots),
      })
      const incoming = await Promise.all(data.incoming.slice(0, limit).map(mapEntry))
      const outgoing = await Promise.all(data.outgoing.slice(0, limit).map(mapEntry))
      const truncated = data.incoming.length > limit || data.outgoing.length > limit
      return {
        data: { available: true, incoming, outgoing, truncated },
        truncated,
        repositoryVersion: ctx.repositoryVersion,
        evidenceCandidates: [...incoming, ...outgoing]
          .slice(0, 10)
          .map((e) => ({
            path: e.at?.path ?? input.path,
            rootId: e.at?.rootId ?? rootIdForAbsolutePath(resolved, deps.roots)!,
            startLine: e.at?.startLine ?? input.line,
            endLine: e.at?.endLine ?? input.line,
            excerpt: `call hierarchy: ${e.name}`,
            kind: 'lsp',
            sourceTool: 'get_call_hierarchy',
          })),
      }
    },
  })

  tools.push({
    name: 'get_repository_capabilities',
    description:
      'Report which intelligence is available per language (lsp, definitions, references, call hierarchy, import graph, lexical search). ' +
      'Call once at survey start: if lsp=false for a language, plan on search_code fallbacks instead of find_* tools for files in that language.',
    inputSchema: z.object({}),
    execute: async (_input, ctx) => {
      const { entries } = await deps.catalog.scan()
      const languages = new Set<string>()
      for (const e of entries) if (e.language) languages.add(e.language)
      const probe = await degrade(() => deps.bridge.probeWorkspaceSymbols(ctx.signal))
      const lspAvailable = probe.data?.available ?? false

      const languagesOut: Record<string, Record<string, boolean>> = {}
      let truncated = false
      let i = 0
      for (const lang of [...languages].sort()) {
        if (i++ >= 40) {
          truncated = true
          break
        }
        // Honest limitation: VS Code has no public per-language provider
        // probe — lsp/definitions/references/callHierarchy reflect the global
        // workspace-symbol probe filtered by known-bundled language ids.
        const lsp = lspAvailable && LSP_LANGUAGES.has(lang)
        languagesOut[lang] = {
          lsp,
          definitions: lsp,
          references: lsp,
          callHierarchy: lsp,
          importGraph: deps.dependencyAdapters.some((a) => a.supports(lang)),
          lexicalSearch: true,
        }
      }
      return {
        data: { languages: languagesOut, truncated, note: 'lsp-family flags are workspace-level probes, not per-language provider checks.' },
        truncated,
        repositoryVersion: ctx.repositoryVersion,
      }
    },
  })

  return tools
}

/** Languages VS Code ships language features for (bundled TS/JS, web languages). */
const LSP_LANGUAGES = new Set([
  'typescript',
  'typescriptreact',
  'javascript',
  'javascriptreact',
  'json',
  'css',
  'scss',
  'html',
  'markdown',
])
