import { z } from 'zod'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import type { RepositoryTool } from '../agent/contracts/RepositoryTool'
import { ToolError } from '../agent/contracts/RepositoryTool'
import type { CatalogInterface } from './Catalog'
import type { RipgrepSearch } from './RipgrepSearch'
import type { FileReader } from './FileReader'
import { buildStructure } from './ProjectDiscovery'
import { inspectPackage } from './PackageInspector'
import { isSensitivePath } from './SensitiveFilePolicy'
import { rootIdAt, rootIdForAbsolutePath, rootIndexForId } from './WorkspaceDescriptor'

/**
 * The Phase 5 deterministic tool set (plan §24): list_files, search_files,
 * search_code, read_file, read_file_range, get_project_structure,
 * get_package_info. All read-only; every path goes through `ctx.resolvePath`.
 */
export interface RepositoryToolDeps {
  catalog: CatalogInterface
  searcher: RipgrepSearch
  reader: FileReader
  roots: string[]
  repositoryVersion: string
}

function sensitiveBlock(path: string): ToolError {
  return new ToolError(`Sensitive file blocked by policy: ${path}`, false)
}

function rootIndex(root: string, roots: string[]): number {
  return roots.indexOf(root)
}

function rootForAbsolute(absolutePath: string, roots: string[]): number {
  return roots.findIndex((root) => {
    const relative = path.relative(root, absolutePath)
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
  })
}

function rootIdForAbsolute(absolutePath: string, roots: string[]): string | undefined {
  return rootIdForAbsolutePath(absolutePath, roots)
}

function selectedRootIndex(
  root: number | undefined,
  rootId: string | undefined,
  roots: string[],
): number | undefined {
  const byId = rootId === undefined ? undefined : rootIndexForId(roots, rootId)
  if (rootId !== undefined && (byId === undefined || byId < 0)) throw new ToolError(`Unknown workspace root id: ${rootId}`, false)
  if (root !== undefined && byId !== undefined && root !== byId) {
    throw new ToolError('Conflicting workspace root and rootId locators.', false)
  }
  return byId ?? root
}

async function resolveScopedPath(
  inputPath: string,
  rootIndexValue: number | undefined,
  rootId: string | undefined,
  deps: RepositoryToolDeps,
  ctx: { resolvePath(input: string): Promise<string> },
): Promise<string> {
  const selected = selectedRootIndex(rootIndexValue, rootId, deps.roots)
  if (selected === undefined) return ctx.resolvePath(inputPath)
  const root = deps.roots[selected]
  if (!root) throw new ToolError(`Unknown workspace root index: ${rootIndexValue}`, false)
  // Resolve through the gateway even for a selected root, preserving path
  // containment and symlink checks while removing first-root ambiguity.
  return ctx.resolvePath(path.join(root, inputPath))
}

/** Minimal glob: '*' matches any run of characters (plan §10 list_files pattern). */
function globRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
  return new RegExp(`^${escaped}$`, 'i')
}

/** Absolute → workspace-root-relative (compares against raw + real roots). Shared by Phase 6 tools. */
export async function relativize(p: string, roots: string[]): Promise<string> {
  const realRoots = await Promise.all(
    roots.map(async (r) => {
      try {
        return await fs.realpath(r)
      } catch {
        return path.resolve(r)
      }
    }),
  )
  for (const root of [...roots, ...realRoots]) {
    const rel = path.relative(root, p)
    if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
      return rel.replace(/\\/g, '/')
    }
  }
  return p
}

export function createRepositoryTools(deps: RepositoryToolDeps): Array<RepositoryTool<any, any>> {
  const tools: Array<RepositoryTool<any, any>> = []

  tools.push({
    name: 'list_files',
    description:
      'Browse a directory of the workspace without returning source content. ' +
      'Returns path metadata (kind, size, language, flags like test/vendor/generated/config) with pagination. ' +
      'Use an empty path for the workspace top level. `root` selects a workspace folder (multi-root); ' +
      '`pattern` filters entries by a glob-ish name pattern.',
    inputSchema: z.object({
      path: z.string().optional(),
      /** @deprecated root indexes are accepted for legacy clients; use rootId. */
      root: z.number().int().min(0).optional(),
      rootId: z.string().min(1).optional(),
      pattern: z.string().optional(),
      limit: z.number().int().min(1).max(500).optional(),
      cursor: z.number().int().nonnegative().optional(),
    }),
    execute: async (input, ctx) => {
      // Multi-root scope (plan §10): `root` picks which workspace folder.
      const selected = selectedRootIndex(input.root, input.rootId, deps.roots)
      const root: string | undefined = selected === undefined ? undefined : deps.roots[selected]
      if (selected !== undefined && !root) throw new ToolError(`Unknown workspace root index: ${selected}`, false)
      const scope = input.path?.trim()
        ? await resolveScopedPath(input.path, input.root, input.rootId, deps, ctx)
        : undefined
      const scopeRel = scope ? await relativize(scope, deps.roots) : undefined
      const pattern = input.pattern?.trim() ? globRegex(input.pattern) : undefined
      // Plan §9: sensitive paths never reach the model — not even as listings.
      // Pagination operates on the FILTERED set so cursors stay consistent.
      let hidden = 0
      const { entries: visible, nextCursor } = await deps.catalog.list(
        scopeRel,
        input.limit ?? 100,
        input.cursor ?? 0,
        (e) => {
          if (isSensitivePath(e.path)) {
            hidden++
            return false
          }
          if (root && e.root !== root) {
            hidden++
            return false
          }
          if (pattern && !pattern.test(e.path)) {
            hidden++
            return false
          }
          return true
        },
      )
      return {
        data: {
          entries: visible.map((e) => ({
            path: e.path,
            rootId: rootIdAt(deps.roots, rootIndex(e.root, deps.roots)),
            root: rootIndex(e.root, deps.roots),
            kind: e.kind,
            size: e.size,
            extension: e.extension,
            language: e.language,
            flags: e.flags,
          })),
          nextCursor,
        },
        truncated: false,
        warnings: hidden > 0 ? [`${hidden} sensitive or non-matching entr${hidden === 1 ? 'y' : 'ies'} hidden by policy/filter.`] : undefined,
        repositoryVersion: ctx.repositoryVersion,
      }
    },
  })

  tools.push({
    name: 'search_files',
    description:
      'Locate files by path/name terms. Every whitespace-separated token must appear in the file path. ' +
      'Returns up to 50 matches; use it before reading or content-searching.',
    inputSchema: z.object({
      query: z.string().min(1),
      limit: z.number().int().min(1).max(100).optional(),
    }),
    execute: async (input, ctx) => {
      const matches = await deps.catalog.searchByName(input.query, input.limit ?? 50)
      // Plan §9: sensitive paths are filtered before provider context.
      const visible = matches.filter((e) => !isSensitivePath(e.path))
      const hidden = matches.length - visible.length
      return {
        data: {
          matches: visible.map((e) => ({
            path: e.path,
            rootId: rootIdAt(deps.roots, rootIndex(e.root, deps.roots)),
            root: rootIndex(e.root, deps.roots),
            kind: e.kind,
            language: e.language,
            flags: e.flags,
          })),
        },
        truncated: false,
        warnings: hidden > 0 ? [`${hidden} match${hidden === 1 ? '' : 'es'} hidden by the sensitive-file policy.`] : undefined,
        repositoryVersion: ctx.repositoryVersion,
      }
    },
  })

  tools.push({
    name: 'search_code',
    description:
      'Regex search over workspace source (ripgrep). Returns file, line number, and the matching line ' +
      '(truncated). Results are bounded and paginated: when truncated, pass `offset` (nextCursor) to continue.',
    inputSchema: z.object({
      pattern: z.string().min(1),
      path: z.string().optional(),
      root: z.number().int().min(0).optional(),
      rootId: z.string().min(1).optional(),
      limit: z.number().int().min(1).max(500).optional(),
      offset: z.number().int().min(0).optional(),
    }),
    execute: async (input, ctx) => {
      let scope: string[] = deps.roots
      if (input.path?.trim()) {
        scope = [await resolveScopedPath(input.path, input.root, input.rootId, deps, ctx)]
      } else if (input.root !== undefined || input.rootId !== undefined) {
        const selected = selectedRootIndex(input.root, input.rootId, deps.roots)
        const root = selected === undefined ? undefined : deps.roots[selected]
        if (!root) throw new ToolError(`Unknown workspace root locator`, false)
        scope = [root]
      }
      const { matches, truncated, nextCursor } = await deps.searcher.search(input.pattern, scope, {
        maxMatches: input.limit ?? 200,
        offset: input.offset ?? 0,
      })
      const visibleMatches = matches.filter((m) => !isSensitivePath(m.path))
      const hidden = matches.length - visibleMatches.length
      const data = {
        matches: await Promise.all(
          visibleMatches.map(async (m) => ({
            path: await relativize(m.path, deps.roots),
            rootId: rootIdForAbsolute(m.path, deps.roots),
            root: rootForAbsolute(m.path, deps.roots),
            line: m.line,
            text: m.text,
          })),
        ),
        truncated,
        nextCursor,
        ...(truncated
          ? { refineHint: 'Too many results — narrow the pattern or scope, or continue with offset=nextCursor.' }
          : {}),
      }
      return {
        data,
        truncated,
        warnings: hidden > 0 ? [`${hidden} match${hidden === 1 ? '' : 'es'} hidden by the sensitive-file policy.`] : undefined,
        repositoryVersion: ctx.repositoryVersion,
      }
    },
  })

  tools.push({
    name: 'read_file',
    description:
      'Read a whole source file when it is below the safe size limit (32 KB). ' +
      'Larger files return metadata instead — use read_file_range for those. Sensitive files (.env, keys) are blocked.',
    inputSchema: z.object({ path: z.string().min(1), root: z.number().int().min(0).optional(), rootId: z.string().min(1).optional() }),
    execute: async (input, ctx) => {
      const resolved = await resolveScopedPath(input.path, input.root, input.rootId, deps, ctx)
      if (isSensitivePath(resolved) || isSensitivePath(input.path)) throw sensitiveBlock(input.path)
      const rel = await relativize(resolved, deps.roots)
      const result = await deps.reader.readWhole(resolved)
      if (result.ok) {
        return {
          data: { content: result.content, lineCount: result.lineCount },
          truncated: false,
          warnings: result.changedDuringRead
            ? ['File changed while being read — content may not match the current disk state.']
            : undefined,
          repositoryVersion: ctx.repositoryVersion,
          evidenceCandidates: [
            {
              path: rel,
              rootId: rootIdForAbsolute(resolved, deps.roots),
              root: rootForAbsolute(resolved, deps.roots),
              startLine: 1,
              endLine: result.lineCount ?? 1,
              excerpt: (result.content ?? '').slice(0, 500),
              kind: 'source',
              sourceTool: 'read_file',
              contentHash: result.contentHash ?? '',
            },
          ],
        }
      }
      return {
        data: {
          tooLarge: result.tooLarge,
          binary: result.binary,
          size: result.size,
          error: result.error,
        },
        truncated: false,
        repositoryVersion: ctx.repositoryVersion,
      }
    },
  })

  tools.push({
    name: 'read_file_range',
    description:
      'Read a numbered, bounded range of lines from a file (1-based, inclusive). ' +
      'Capped at 400 lines / 48 KB; lines are truncated to 1000 chars. Sensitive files are blocked.',
    inputSchema: z.object({
      path: z.string().min(1),
      root: z.number().int().min(0).optional(),
      rootId: z.string().min(1).optional(),
      startLine: z.number().int().min(1),
      endLine: z.number().int().min(1),
    }),
    execute: async (input, ctx) => {
      const resolved = await resolveScopedPath(input.path, input.root, input.rootId, deps, ctx)
      if (isSensitivePath(resolved) || isSensitivePath(input.path)) throw sensitiveBlock(input.path)
      const rel = await relativize(resolved, deps.roots)
      const result = await deps.reader.readRange(resolved, input.startLine, input.endLine)
      if (!result.ok) {
        throw new ToolError(result.error ?? `Could not read ${input.path}`, false)
      }
      const lines = result.lines ?? []
      return {
        data: { lines, truncated: result.truncated ?? false },
        truncated: result.truncated ?? false,
        warnings: result.changedDuringRead
          ? ['File changed while being read — content may not match the current disk state.']
          : undefined,
        repositoryVersion: ctx.repositoryVersion,
        evidenceCandidates:
          lines.length > 0
            ? [
                {
                  path: rel,
                  rootId: rootIdForAbsolute(resolved, deps.roots),
                  root: rootForAbsolute(resolved, deps.roots),
                  startLine: lines[0].number,
                  endLine: lines[lines.length - 1].number,
                  excerpt: lines.map((l) => l.text).join('\n').slice(0, 500),
                  kind: 'source',
                  sourceTool: 'read_file_range',
                  contentHash: result.contentHash ?? '',
                },
              ]
            : undefined,
      }
    },
  })

  tools.push({
    name: 'get_project_structure',
    description:
      'Return the package/module topology of the workspace — top-level directories with file counts, ' +
      'dominant extensions, and package markers — instead of dumping every path.',
    inputSchema: z.object({}),
    execute: async (_input, ctx) => {
      const { entries, truncated: scanTruncated } = await deps.catalog.scan()
      const { roots, truncated } = buildStructure(entries)
      return {
        data: { roots, truncated: truncated || scanTruncated },
        truncated: truncated || scanTruncated,
        repositoryVersion: ctx.repositoryVersion,
      }
    },
  })

  tools.push({
    name: 'get_package_info',
    description:
      'Parse the nearest package manifest deterministically (package.json, go.mod, or pyproject.toml). ' +
      'Never dumps lockfiles.',
    inputSchema: z.object({ path: z.string().optional(), root: z.number().int().min(0).optional(), rootId: z.string().min(1).optional() }),
    execute: async (input, ctx) => {
      const selected = selectedRootIndex(input.root, input.rootId, deps.roots) ?? 0
      const selectedRoot = deps.roots[selected]
      if (!selectedRoot) throw new ToolError(`Unknown workspace root locator`, false)
      const resolved = input.path?.trim()
        ? await resolveScopedPath(input.path, input.root, input.rootId, deps, ctx)
        : selectedRoot
      const info = await inspectPackage(resolved, selectedRoot)
      if (!info) {
        return {
          data: { found: false },
          truncated: false,
          repositoryVersion: ctx.repositoryVersion,
        }
      }
      // Phase 7: content hash of the manifest for evidence staleness detection.
      const manifestHash = info.manifestPath
        ? (await deps.reader.readWhole(info.manifestPath)).contentHash ?? ''
        : ''
      return {
        data: {
          found: true,
          kind: info.kind,
          manifestPath: await relativize(info.manifestPath ?? '', deps.roots),
          rootId: rootIdForAbsolute(info.manifestPath ?? selectedRoot, deps.roots),
          data: info.data,
        },
        truncated: false,
        repositoryVersion: ctx.repositoryVersion,
        evidenceCandidates: [
          {
            path: await relativize(info.manifestPath ?? '', deps.roots),
            rootId: rootIdForAbsolute(info.manifestPath ?? selectedRoot, deps.roots),
            root: rootForAbsolute(info.manifestPath ?? '', deps.roots),
            startLine: 1,
            endLine: 1,
            excerpt: JSON.stringify(info.data).slice(0, 500),
            kind: 'manifest',
            sourceTool: 'get_package_info',
            contentHash: manifestHash,
          },
        ],
      }
    },
  })

  return tools
}
