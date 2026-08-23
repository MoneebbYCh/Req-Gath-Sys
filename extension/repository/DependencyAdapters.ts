/**
 * Phase 6 dependency intelligence (plan §11): a language-adapter interface for
 * deterministic import extraction. v1 covers TypeScript/JavaScript only, with
 * a line-scoped lexical parser — no heavy AST dependency. Multi-line import
 * statements are missed (documented limitation); a real parser can replace
 * the adapter later without touching the tools.
 */

export type ImportProvenance = 'parser' | 'lsp' | 'manifest' | 'inference'

export interface ImportEdge {
  /** Workspace-relative path of the importing file. */
  sourcePath: string
  /** Raw module specifier as written in the source. */
  target: string
  kind: 'static' | 'require' | 'dynamic' | 'reexport' | 'side-effect'
  /** How the edge was produced — survives into evidence (plan §11 acceptance). */
  provenance: ImportProvenance
  line: number
}

/** What an adapter parses. */
export interface SourceDocument {
  /** Workspace-relative path. */
  path: string
  languageId: string
  content: string
}

export interface DependencyAdapter {
  supports(languageId: string): boolean
  extractImports(document: SourceDocument): ImportEdge[]
}

const STATIC_IMPORT_RE = /^\s*(?:import|export)\b.*?\bfrom\s*["']([^"']+)["']/
const SIDE_EFFECT_IMPORT_RE = /^\s*import\s*["']([^"']+)["']/
const REQUIRE_RE = /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g
const DYNAMIC_IMPORT_RE = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g

export const TYPESCRIPT_LANGUAGE_IDS = new Set([
  'typescript',
  'typescriptreact',
  'javascript',
  'javascriptreact',
])

/**
 * Lexical TypeScript/JavaScript import extractor. Line-scoped; multi-line
 * import statements are missed (ponytail: a real TS parser replaces this if
 * accuracy demands it — Phase 15 indexing can swap in the compiler API).
 */
export const typescriptAdapter: DependencyAdapter = {
  supports: (languageId) => TYPESCRIPT_LANGUAGE_IDS.has(languageId),
  extractImports: (document) => {
    const edges: ImportEdge[] = []
    const seen = new Set<string>()
    const lines = document.content.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      const matches: Array<{ spec: string; kind: ImportEdge['kind'] }> = []

      const staticMatch = line.match(STATIC_IMPORT_RE)
      if (staticMatch) {
        const isReexport = /^\s*export\b/.test(line)
        matches.push({ spec: staticMatch[1], kind: isReexport ? 'reexport' : 'static' })
      } else {
        const sideEffect = line.match(SIDE_EFFECT_IMPORT_RE)
        if (sideEffect) matches.push({ spec: sideEffect[1], kind: 'side-effect' })
      }
      for (const m of line.matchAll(REQUIRE_RE)) {
        matches.push({ spec: m[1], kind: 'require' })
      }
      for (const m of line.matchAll(DYNAMIC_IMPORT_RE)) {
        matches.push({ spec: m[1], kind: 'dynamic' })
      }

      for (const { spec, kind } of matches) {
        const key = `${kind}:${spec}`
        if (seen.has(key)) continue
        seen.add(key)
        edges.push({ sourcePath: document.path, target: spec, kind, provenance: 'parser', line: i + 1 })
      }
    }
    return edges
  },
}

/** Registry: languageId → adapter. Extend here for new languages. */
export function getAdapter(languageId: string): DependencyAdapter | undefined {
  if (typescriptAdapter.supports(languageId)) return typescriptAdapter
  if (pythonAdapter.supports(languageId)) return pythonAdapter
  if (goAdapter.supports(languageId)) return goAdapter
  return undefined
}

export const PYTHON_LANGUAGE_IDS = new Set(['python'])

const PY_FROM_IMPORT_RE = /^\s*from\s+([A-Za-z0-9_.]+)\s+import\b/
const PY_IMPORT_RE = /^\s*import\s+([A-Za-z0-9_.]+)/

/**
 * Lexical Python import extractor (plan §11: fall back to lexical evidence for
 * languages without a richer adapter; limitations marked honestly).
 */
export const pythonAdapter: DependencyAdapter = {
  supports: (languageId) => PYTHON_LANGUAGE_IDS.has(languageId),
  extractImports: (document) => {
    const edges: ImportEdge[] = []
    const seen = new Set<string>()
    const lines = document.content.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      const fromMatch = line.match(PY_FROM_IMPORT_RE)
      const importMatch = fromMatch ? null : line.match(PY_IMPORT_RE)
      const spec = fromMatch?.[1] ?? importMatch?.[1]
      if (!spec) continue
      const key = `static:${spec}`
      if (seen.has(key)) continue
      seen.add(key)
      edges.push({ sourcePath: document.path, target: spec, kind: 'static', provenance: 'parser', line: i + 1 })
    }
    return edges
  },
}

export const GO_LANGUAGE_IDS = new Set(['go'])

/**
 * Lexical Go import extractor: `import "x"` plus parenthesized import blocks.
 */
export const goAdapter: DependencyAdapter = {
  supports: (languageId) => GO_LANGUAGE_IDS.has(languageId),
  extractImports: (document) => {
    const edges: ImportEdge[] = []
    const seen = new Set<string>()
    const lines = document.content.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim()
      const single = line.match(/^import\s+([A-Za-z0-9_.]+)?\s*"([^"]+)"/)
      if (single) {
        const key = `static:${single[2]}`
        if (!seen.has(key)) {
          seen.add(key)
          edges.push({ sourcePath: document.path, target: single[2], kind: 'static', provenance: 'parser', line: i + 1 })
        }
        continue
      }
      if (line === 'import (' || line === 'import(') {
        // Scan the block until its closing paren.
        for (let j = i + 1; j < lines.length && j < i + 60; j++) {
          const blockLine = lines[j].trim()
          if (blockLine === ')') break
          const m = blockLine.match(/(?:[A-Za-z0-9_.]+\s+)?"([^"]+)"/)
          if (m) {
            const key = `static:${m[1]}`
            if (!seen.has(key)) {
              seen.add(key)
              edges.push({ sourcePath: document.path, target: m[1], kind: 'static', provenance: 'parser', line: i + 1 })
            }
          }
        }
      }
    }
    return edges
  },
}
