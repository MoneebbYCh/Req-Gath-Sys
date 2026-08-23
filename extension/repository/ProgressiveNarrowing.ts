import * as path from 'node:path'
import type { CatalogEntry } from './Catalog'
import { buildStructure, type StructureNode } from './ProjectDiscovery'

/**
 * Progressive Narrowing (plan §15):
 * Helps the agent navigate large repositories by narrowing scope step by step:
 * Workspace roots → package topology → relevant packages → modules → symbols/files → bounded ranges
 *
 * This is a deterministic helper — the model decides WHAT to narrow to,
 * this module provides the HOW (filtering, grouping, ranking).
 */

export interface NarrowingStep {
  /** Human-readable description of this step. */
  description: string
  /** Number of items at this level. */
  count: number
  /** Sample items for the model to choose from. */
  samples: Array<{ label: string; detail?: string }>
  /** If > 0, the model should pick one or more to continue narrowing. */
  nextStepHint?: string
}

export interface NarrowingOptions {
  /** Max samples to return at each step. */
  maxSamples?: number
  /** Include vendor/generated/test files in samples (default: false). */
  includeFlagged?: boolean
}

const DEFAULT_MAX_SAMPLES = 20

/**
 * Step 1: Workspace roots overview.
 */
export function describeWorkspaceRoots(entries: CatalogEntry[]): NarrowingStep {
  const roots = [...new Set(entries.map(e => e.root))]
  return {
    description: `${roots.length} workspace root(s)`,
    count: roots.length,
    samples: roots.map(r => ({ label: path.basename(r), detail: r })),
    nextStepHint: 'Select a root to explore its package topology',
  }
}

/**
 * Step 2: Package topology (from ProjectDiscovery.buildStructure).
 * Returns top-level directories with file counts, extensions, package markers.
 */
export function describePackageTopology(entries: CatalogEntry[], options: NarrowingOptions = {}): NarrowingStep {
  const { roots, truncated } = buildStructure(entries)
  const filtered = roots.filter(r => options.includeFlagged || !isFlagged(r))
  const samples = filtered.slice(0, options.maxSamples ?? DEFAULT_MAX_SAMPLES).map(r => {
    const extList = r.extensions?.map(([ext, count]) => `${ext}(${count})`).join(', ') || 'no ext'
    const flags = r.flags?.join(', ') || 'none'
    return {
      label: r.name,
      detail: `${r.fileCount ?? 0} files · ${extList} · ${flags}`,
    }
  })
  return {
    description: `Package topology: ${filtered.length} top-level packages/dirs${truncated ? ' (truncated)' : ''}`,
    count: filtered.length,
    samples,
    nextStepHint: filtered.length > 1 ? 'Select a package to explore its modules' : 'Single package — explore modules directly',
  }
}

/**
 * Step 3: Modules within a package.
 * Groups files by their immediate parent directory under the package.
 */
export function describeModules(
  entries: CatalogEntry[],
  packagePath: string,
  options: NarrowingOptions = {}
): NarrowingStep {
  const packagePrefix = packagePath.replace(/\\/g, '/').replace(/\/+$/, '')
  const moduleFiles = entries.filter(e => {
    if (e.kind !== 'file') return false
    if (!e.path.startsWith(packagePrefix + '/')) return false
    if (!options.includeFlagged && e.flags.some(f => ['vendor', 'generated', 'test', 'build'].includes(f))) return false
    return true
  })

  // Group by first path segment after package
  const moduleGroups = new Map<string, CatalogEntry[]>()
  for (const e of moduleFiles) {
    const relative = e.path.slice(packagePrefix.length + 1)
    const firstSegment = relative.split('/')[0] ?? relative
    if (!moduleGroups.has(firstSegment)) moduleGroups.set(firstSegment, [])
    moduleGroups.get(firstSegment)!.push(e)
  }

  const sortedModules = [...moduleGroups.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, options.maxSamples ?? DEFAULT_MAX_SAMPLES)

  const samples = sortedModules.map(([name, files]) => ({
    label: name,
    detail: `${files.length} files · ${uniqueExtensions(files).join(', ')}`,
  }))

  return {
    description: `Modules in ${packagePath}: ${moduleGroups.size} module(s)`,
    count: moduleGroups.size,
    samples,
    nextStepHint: moduleGroups.size > 1 ? 'Select a module to list symbols/files' : 'Single module — list files or symbols',
  }
}

/**
 * Step 4: Files within a module (or package if no modules).
 * Returns files with metadata, optionally filtered by language/extension.
 */
export function describeFiles(
  entries: CatalogEntry[],
  scopePath: string,
  options: NarrowingOptions & { language?: string; extension?: string } = {}
): NarrowingStep {
  const prefix = scopePath.replace(/\\/g, '/').replace(/\/+$/, '')
  const files = entries.filter(e => {
    if (e.kind !== 'file') return false
    if (!e.path.startsWith(prefix + '/') && e.path !== prefix) return false
    if (!options.includeFlagged && e.flags.some(f => ['vendor', 'generated', 'test', 'build'].includes(f))) return false
    if (options.language && e.language !== options.language) return false
    if (options.extension && e.extension !== options.extension) return false
    return true
  })

  // Sort by size descending (larger files often more important)
  const sorted = files
    .sort((a, b) => b.size - a.size)
    .slice(0, options.maxSamples ?? DEFAULT_MAX_SAMPLES)

  const samples = sorted.map(f => ({
    label: f.path.split('/').pop() ?? f.path,
    detail: `${f.path} · ${f.size} bytes · ${f.language ?? 'unknown'} · ${f.flags.join(', ') || 'plain'}`,
  }))

  return {
    description: `Files in ${scopePath}: ${files.length} file(s)`,
    count: files.length,
    samples,
    nextStepHint: files.length > 1 ? 'Select a file to read a range or search symbols' : 'Single file — read range or get symbols',
  }
}

/**
 * Step 5: Symbols in a file (from LSP or lexical fallback).
 * This would be called with LSP tool results — here we just format them.
 */
export function describeSymbols(symbols: Array<{ name: string; kind: string; line: number }>): NarrowingStep {
  return {
    description: `Symbols: ${symbols.length} symbol(s)`,
    count: symbols.length,
    samples: symbols.slice(0, 30).map(s => ({
      label: s.name,
      detail: `${s.kind} at line ${s.line}`,
    })),
    nextStepHint: 'Select a symbol to find definition/references',
  }
}

/**
 * Rank packages by relevance to a query (for "find relevant packages" step).
 * Uses simple token overlap between query and package names/extensions/flags.
 */
export function rankPackagesByQuery(
  entries: CatalogEntry[],
  query: string
): Array<{ name: string; score: number; fileCount: number }> {
  const { roots } = buildStructure(entries)
  const queryTokens = query.toLowerCase().split(/\s+/).filter(Boolean)

  const scored = roots.map(r => {
    let score = 0
    const extText = r.extensions?.map(([ext]) => ext).join(' ') || ''
    const flagsText = r.flags?.join(' ') || ''
    const searchText = `${r.name} ${extText} ${flagsText}`.toLowerCase()
    for (const token of queryTokens) {
      if (searchText.includes(token)) score += 2
      if (r.name.toLowerCase().includes(token)) score += 5
      if (extText.toLowerCase().includes(token)) score += 3
      if (flagsText.toLowerCase().includes(token)) score += 3
    }
    return { name: r.name, score, fileCount: r.fileCount ?? 0 }
  })

  return scored
    .filter(r => r.score > 0)
    .sort((a, b) => b.score - a.score)
}

function uniqueExtensions(files: CatalogEntry[]): string[] {
  const exts = new Set<string>()
  for (const f of files) if (f.extension) exts.add(f.extension)
  return [...exts].sort()
}

function isFlagged(node: StructureNode): boolean {
  return node.flags?.some(f => ['vendor', 'generated', 'test', 'build'].includes(f)) ?? false
}