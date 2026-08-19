import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import * as fs from 'fs'
import * as path from 'path'
import fg from 'fast-glob'
import { LEGACY_STATE_DIR, STATE_DIR } from '../brand'
import { loadDocTypes, saveDocTypes, saveForm } from '../formStateManager'
import { normalizeMermaidSource, parseMermaid } from './mermaidValidate'

const execFileAsync = promisify(execFile)

export interface ToolContext {
  workspaceRoot: string
  /** Called after generate_pipeline writes doc-types.json so the webview can refresh. */
  onDocTypesChanged?: (data: unknown[], mode: 'merge' | 'replace') => void
}

const IGNORE_DIRS = new Set([
  'node_modules', 'dist', 'out', '.git', STATE_DIR, LEGACY_STATE_DIR, '.vscode',
])

const MAX_READ_LINES = 2000
const MAX_GREP_MATCHES = 50
const MAX_GLOB_RESULTS = 50
const MAX_OBS_CHARS = 12_000
const MAX_MERMAID_CHARS = 8000
const MAX_PIPELINE_DOCS = 12
const MAX_LIST_DIR_CHILDREN = 40
const GREP_CONTEXT_LINES = 1

/** Folder name patterns worth calling out during orientation. */
const RELEVANT_DIR_RE =
  /^(src|lib|libs|api|app|apps|server|servers|backend|frontend|extension|packages|services|service|controllers|routes|core|internal|agent|agents|ai|auth|db|data|models|handlers|middleware|utils|helpers|components|pages|views|hooks)$/i

const PIPELINE_ICONS = new Set([
  'article',
  'draft',
  'checklist',
  'lightbulb',
  'flag',
  'campaign',
  'science',
  'handshake',
  'insights',
  'menu_book',
  'schema',
  'inventory_2',
  'description',
  'account_tree',
  'terminal',
  'biotech',
  'rocket_launch',
  'bar_chart',
])

const GLOB_PRESETS: Record<string, string[]> = {
  config: [
    '**/package.json',
    '**/tsconfig*.json',
    '**/jsconfig*.json',
    '**/.env*',
    '**/vite.config.*',
    '**/webpack.config.*',
    '**/next.config.*',
    '**/nuxt.config.*',
    '**/pyproject.toml',
    '**/Cargo.toml',
    '**/go.mod',
    '**/requirements*.txt',
    '**/Dockerfile*',
    '**/docker-compose*.{yml,yaml}',
    '**/.github/workflows/*.{yml,yaml}',
  ],
  'entry points': [
    '**/index.{ts,tsx,js,jsx,mjs,cjs}',
    '**/main.{ts,tsx,js,jsx,mjs,cjs,py,go}',
    '**/app.{ts,tsx,js,jsx}',
    '**/server.{ts,tsx,js,jsx}',
    '**/extension.{ts,js}',
    '**/__init__.py',
    '**/cmd/**/main.go',
  ],
  entry_points: [
    '**/index.{ts,tsx,js,jsx,mjs,cjs}',
    '**/main.{ts,tsx,js,jsx,mjs,cjs,py,go}',
    '**/app.{ts,tsx,js,jsx}',
    '**/server.{ts,tsx,js,jsx}',
    '**/extension.{ts,js}',
    '**/__init__.py',
    '**/cmd/**/main.go',
  ],
  tests: [
    '**/*.{test,spec}.{ts,tsx,js,jsx}',
    '**/__tests__/**',
    '**/tests/**/*.{ts,tsx,js,jsx,py}',
    '**/test_*.py',
    '**/*_test.go',
  ],
}

interface PipelineDocSpec {
  name: string
  icon: string
  description: string
}

interface StoredCustomDocType {
  id: string
  name: string
  icon: string
  createdAt: number
  order: number
}

export const TOOL_NAMES = [
  'glob',
  'grep',
  'read_file',
  'list_dir',
  'validate_mermaid',
  'list_pipeline',
  'generate_pipeline',
  'remove_pipeline_docs',
] as const

/** Human-readable tool catalog for the agent system prompt. */
export const TOOL_CATALOG = `AVAILABLE TOOLS (call one per step):
Codebase tools (user's open workspace folder):
- list_dir { "path"?: string, "depth"?: 1|2 }  -> list directory tree (default depth 2 with per-subfolder file counts; flags ★relevant folders like src/lib/api/agent*). Start with "." .
- glob { "pattern"?: string, "preset"?: "config"|"entry points"|"tests", "max_results"?: number }  -> find files by name/path. Prefer preset for common intents; use pattern for custom globs (e.g. "src/**/*.ts"). Does NOT search file contents. Reports how many hits .gitignore hid.
- grep { "pattern"?: string, "patterns"?: string[], "path"?: string, "case_sensitive"?: boolean }  -> regex search in file contents. Default is case-insensitive (set case_sensitive:true to tighten). Pass patterns:[...] to search several phrasings in one call (results grouped). Returns ±1 line of context. Cap ${MAX_GREP_MATCHES}/pattern — when hit, observation says so and suggests narrowing.
- read_file { "path": string, "line_start"?: number, "line_end"?: number }  -> read a known file (optional line range; max ${MAX_READ_LINES} lines). Truncation is explicit ("truncated at line X of N").

DEFAULT SEARCH ORDER (follow unless you already know the path):
1. list_dir — orient on folder structure
2. glob — candidate files by name/path/preset
3. grep — candidate lines by content (use patterns:[...] for synonyms in one call)
4. read_file — confirm with full context before claiming facts

ZERO HITS ≠ ABSENT:
- If grep/glob returns nothing, retry with a different phrasing (synonym, abbreviation, alternate casing, SDK import name) before concluding something is missing.
- Require at least 2 different query attempts before stating a feature/file/symbol is not in the codebase.

CITATIONS:
- Every factual claim in a draft or inventory answer must trace to a specific read_file observation (cite path:line). Do not assert from grep snippets alone.

When exploring:
- Prefer narrow searches over broad ones. If a search hits the match cap, narrow by directory or file type rather than reading everything.
- For a specific named symbol/file/function: stop once you have enough evidence (with at least one read_file).
- For category / inventory / "what does X do" / "where is AI" / "is that everything" questions: do NOT stop after 2–3 good concept matches. Finding solid examples ≠ finding everything.

SEARCH DISCIPLINE (category & enumeration questions):
- Concept words ("agent", "chatbot", "AI") are guesses and miss features that use different vocabulary.
- Always do a second, broader pass grepping for mechanical SDK/library anchors every LLM-touching file must contain, for example:
  openai | OpenAI | chat.completions | embeddings.create | text-embedding
  mistral | @mistralai | anthropic | @anthropic | langchain
  chromadb | ChromaClient | vectorStore
  Prefer one grep with patterns:[...] covering those anchors.
  Also glob for *Service* / *Controller* / *Routes* names that look AI-related if the first pass is thin.
- Before finalizing an enumeration-style chat answer, explicitly list the search patterns you tried (so gaps are visible). Never silently assume coverage.
- If the user asked for chat-only (no document), put the full inventory in "message" and set document:null.

Diagram tool (use when the document needs a Mermaid diagram):
- validate_mermaid { "code": string, "title"?: string }  -> parse-check your Mermaid; on success returns a ready diagram block JSON to put in "document". Reason about the codebase (or chat) first, then draft Mermaid yourself and validate here — do NOT invent from a fixed template.

Pipeline tools (document set on Home — starts empty; only what you create appears):
- list_pipeline {}  -> list current custom documents (id, name). Call this before claiming what exists, or when the user asks what docs were made.
- generate_pipeline { "documents": [ { "name": string, "icon"?: string, "description"?: string } ], "mode"?: "append"|"replace" }
  -> creates canvas document slots on Home. "append" (default) adds; "replace" rebuilds the whole list.
  Use this whenever the user wants a new doc on the pipeline. Prefer 1–8 focused docs. Do NOT put full canvas bodies in this tool — create the slot, then finish with document+targetDoc to draft it.
- remove_pipeline_docs { "ids"?: string[], "names"?: string[], "all"?: boolean }
  -> delete custom docs by id and/or name (case-insensitive), or all:true to clear the pipeline. Call list_pipeline first if unsure.`

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(n)))
}

function safeResolve(workspaceRoot: string, rel: string): string | null {
  const root = path.resolve(workspaceRoot)
  const abs = path.resolve(root, rel || '.')
  if (abs !== root && !abs.startsWith(root + path.sep)) return null
  return abs
}

function toWorkspaceRel(workspaceRoot: string, absOrRel: string): string {
  if (path.isAbsolute(absOrRel)) {
    return path.relative(workspaceRoot, absOrRel) || '.'
  }
  return absOrRel.replace(/\\/g, '/')
}

function normalizeRel(rel: string): string {
  return rel.replace(/\\/g, '/') || '.'
}

function isRelevantDirName(name: string): boolean {
  if (RELEVANT_DIR_RE.test(name)) return true
  return /^agent/i.test(name) || /^api/i.test(name)
}

/** Prefer non-test, non-vendor, shallower paths first. */
function grepRelevanceScore(file: string): number {
  const lower = file.toLowerCase().replace(/\\/g, '/')
  let score = 0
  if (
    /\.(test|spec)\.[^.]+$/.test(lower) ||
    /\/(__tests__|tests?|specs?)\//.test(lower) ||
    /\/test_/.test(lower)
  ) {
    score += 100
  }
  if (
    /(^|\/)(node_modules|vendor|third[-_]?party|dist|out|build|coverage)(\/|$)/.test(lower)
  ) {
    score += 200
  }
  score += lower.split('/').filter(Boolean).length
  return score
}

function sortGrepMatches<T extends { file: string; line: number }>(matches: T[]): T[] {
  return [...matches].sort((a, b) => {
    const sa = grepRelevanceScore(a.file)
    const sb = grepRelevanceScore(b.file)
    if (sa !== sb) return sa - sb
    if (a.file !== b.file) return a.file.localeCompare(b.file)
    return a.line - b.line
  })
}

let cachedRgPath: string | null | undefined

async function resolveRgPath(): Promise<string | null> {
  if (cachedRgPath !== undefined) return cachedRgPath
  try {
    const mod = await import('@vscode/ripgrep')
    if (mod.rgPath && fs.existsSync(mod.rgPath)) {
      cachedRgPath = mod.rgPath
      return cachedRgPath
    }
  } catch {
    /* bundled binary unavailable */
  }
  cachedRgPath = 'rg'
  return cachedRgPath
}

interface RgMatch {
  file: string
  line: number
  text: string
  before: { line: number; text: string }[]
  after: { line: number; text: string }[]
}

/**
 * Parse ripgrep --json -C N into ranked matches with before/after snippets.
 */
function parseRipgrepJson(stdout: string, workspaceRoot: string, maxMatches: number): RgMatch[] {
  type LineEvt = { file: string; line: number; text: string; kind: 'match' | 'context' }
  const events: LineEvt[] = []

  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue
    try {
      const evt = JSON.parse(line) as {
        type?: string
        data?: {
          path?: { text?: string }
          line_number?: number
          lines?: { text?: string }
        }
      }
      if ((evt.type !== 'match' && evt.type !== 'context') || !evt.data) continue
      const fileAbs = evt.data.path?.text ?? ''
      const lineNo = evt.data.line_number ?? 0
      const text = (evt.data.lines?.text ?? '').replace(/\n$/, '')
      if (!fileAbs || !lineNo) continue
      events.push({
        file: toWorkspaceRel(workspaceRoot, fileAbs),
        line: lineNo,
        text: text.trimEnd().slice(0, 200),
        kind: evt.type === 'match' ? 'match' : 'context',
      })
    } catch {
      /* skip malformed */
    }
  }

  const matches: RgMatch[] = []
  for (let i = 0; i < events.length; i++) {
    const e = events[i]
    if (e.kind !== 'match') continue
    if (matches.length >= maxMatches) break

    const before: { line: number; text: string }[] = []
    for (let j = i - 1; j >= 0 && before.length < GREP_CONTEXT_LINES; j--) {
      const prev = events[j]
      if (prev.file !== e.file) break
      if (prev.line >= e.line) continue
      if (e.line - prev.line > GREP_CONTEXT_LINES + 1) break
      before.unshift({ line: prev.line, text: prev.text })
    }

    const after: { line: number; text: string }[] = []
    for (let j = i + 1; j < events.length && after.length < GREP_CONTEXT_LINES; j++) {
      const next = events[j]
      if (next.file !== e.file) break
      if (next.line <= e.line) continue
      if (next.line - e.line > GREP_CONTEXT_LINES + 1) break
      after.push({ line: next.line, text: next.text })
    }

    matches.push({ file: e.file, line: e.line, text: e.text, before, after })
  }

  return sortGrepMatches(matches)
}

function formatGrepMatch(m: RgMatch): string {
  const lines: string[] = []
  for (const b of m.before) lines.push(`${m.file}:${b.line}:  ${b.text}`)
  lines.push(`${m.file}:${m.line}:> ${m.text}`)
  for (const a of m.after) lines.push(`${m.file}:${a.line}:  ${a.text}`)
  return lines.join('\n')
}

function loadGitignoreIgnorePatterns(workspaceRoot: string): string[] {
  const giPath = path.join(workspaceRoot, '.gitignore')
  if (!fs.existsSync(giPath)) return []
  let text: string
  try {
    text = fs.readFileSync(giPath, 'utf-8')
  } catch {
    return []
  }
  const patterns: string[] = []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#') || line.startsWith('!')) continue
    let p = line.replace(/\\/g, '/')
    if (p.endsWith('/')) p = p.slice(0, -1)
    if (!p) continue
    if (p.startsWith('/')) {
      const rel = p.slice(1)
      patterns.push(rel, `${rel}/**`)
    } else if (p.includes('/')) {
      patterns.push(p, `${p}/**`)
    } else {
      patterns.push(`**/${p}`, `**/${p}/**`)
    }
  }
  return patterns
}

function resolveGlobPatterns(args: Record<string, unknown>): { patterns: string[]; label: string } | string {
  const presetRaw = typeof args.preset === 'string' ? args.preset.trim().toLowerCase() : ''
  const pattern = typeof args.pattern === 'string' ? args.pattern.trim() : ''

  if (presetRaw) {
    const key =
      presetRaw === 'entry points' || presetRaw === 'entrypoints' || presetRaw === 'entry-points'
        ? 'entry_points'
        : presetRaw === 'configs'
          ? 'config'
          : presetRaw === 'test'
            ? 'tests'
            : presetRaw
    const preset = GLOB_PRESETS[key]
    if (!preset) {
      return `error: unknown preset "${args.preset}". Use "config", "entry points", or "tests".`
    }
    return { patterns: preset, label: `preset:${key === 'entry_points' ? 'entry points' : key}` }
  }

  if (!pattern) {
    return 'error: provide "pattern" or "preset" ("config" | "entry points" | "tests")'
  }
  return { patterns: [pattern], label: `pattern:${pattern}` }
}

async function globTool(ctx: ToolContext, args: Record<string, unknown>): Promise<string> {
  const resolved = resolveGlobPatterns(args)
  if (typeof resolved === 'string') return resolved
  const maxResults = clampInt(args.max_results, MAX_GLOB_RESULTS, 1, 200)
  const hardIgnore = [...IGNORE_DIRS].map((d) => `**/${d}/**`)
  const gitignorePatterns = loadGitignoreIgnorePatterns(ctx.workspaceRoot)

  const runFg = (extraIgnore: string[]) =>
    fg(resolved.patterns, {
      cwd: ctx.workspaceRoot,
      dot: false,
      onlyFiles: true,
      absolute: false,
      suppressErrors: true,
      unique: true,
      ignore: [...hardIgnore, ...extraIgnore],
    })

  const [withGitignore, withoutGitignore] = await Promise.all([
    runFg(gitignorePatterns),
    runFg([]),
  ])

  const excludedByGitignore = Math.max(0, withoutGitignore.length - withGitignore.length)
  const files = withGitignore
  const truncated = files.length > maxResults
  const slice = files.slice(0, maxResults)

  if (slice.length === 0) {
    const bits = [`No files matched (${resolved.label}).`]
    if (excludedByGitignore > 0) {
      bits.push(
        `${excludedByGitignore} file(s) matched the pattern but were excluded by .gitignore — try a more specific path or check ignored folders.`,
      )
    }
    bits.push('Zero hits ≠ absent: retry with another preset/pattern before concluding nothing exists.')
    return bits.join('\n')
  }

  const lines = [
    `${slice.length} file(s) (${resolved.label})${
      truncated ? ` — truncated; ${files.length} total matched, showing first ${maxResults}. Narrow the pattern.` : ''
    }${excludedByGitignore > 0 ? ` — ${excludedByGitignore} file(s) excluded by .gitignore.` : ''}:`,
    ...slice.map((f) => `- ${f}`),
  ]
  return lines.join('\n')
}

function collectGrepPatterns(args: Record<string, unknown>): string[] | string {
  const patterns: string[] = []
  if (Array.isArray(args.patterns)) {
    for (const p of args.patterns) {
      if (typeof p === 'string' && p.trim()) patterns.push(p.trim())
    }
  }
  const single = typeof args.pattern === 'string' ? args.pattern.trim() : ''
  if (single) patterns.push(single)
  // Deduplicate while preserving order
  const seen = new Set<string>()
  const unique = patterns.filter((p) => {
    if (seen.has(p)) return false
    seen.add(p)
    return true
  })
  if (unique.length === 0) return 'error: "pattern" or "patterns" is required'
  if (unique.length > 8) return 'error: at most 8 patterns per grep call'
  return unique
}

function wantsCaseInsensitive(args: Record<string, unknown>): boolean {
  // Default: case-insensitive. Opt into case-sensitive explicitly.
  if (args.case_sensitive === true || args.case_sensitive === 'true' || args.caseSensitive === true) {
    return false
  }
  if (args.case_insensitive === false || args.case_insensitive === 'false' || args.caseInsensitive === false) {
    return false
  }
  return true
}

async function runSingleGrep(
  ctx: ToolContext,
  pattern: string,
  searchAbs: string,
  caseInsensitive: boolean,
  maxMatches: number,
): Promise<{ matches: RgMatch[]; error?: string; hitCap: boolean }> {
  const rg = await resolveRgPath()
  if (!rg) return { matches: [], error: 'error: ripgrep is unavailable', hitCap: false }

  const rgArgs = [
    '--json',
    '-C',
    String(GREP_CONTEXT_LINES),
    '--max-count',
    String(maxMatches),
    '--glob',
    '!**/node_modules/**',
    '--glob',
    '!**/dist/**',
    '--glob',
    '!**/out/**',
    '--glob',
    `!**/${STATE_DIR}/**`,
    '--glob',
    `!**/${LEGACY_STATE_DIR}/**`,
  ]
  if (caseInsensitive) rgArgs.push('-i')
  rgArgs.push('--', pattern, searchAbs)

  try {
    const { stdout } = await execFileAsync(rg, rgArgs, {
      maxBuffer: 2 * 1024 * 1024,
      cwd: ctx.workspaceRoot,
    })
    const matches = parseRipgrepJson(stdout, ctx.workspaceRoot, maxMatches)
    return { matches, hitCap: matches.length >= maxMatches }
  } catch (err: unknown) {
    const e = err as { code?: number | string; stdout?: string; message?: string }
    if (e.code === 1) return { matches: [], hitCap: false }
    if (e.stdout) {
      const matches = parseRipgrepJson(e.stdout, ctx.workspaceRoot, maxMatches)
      return { matches, hitCap: matches.length >= maxMatches }
    }
    if (e.code === 'ENOENT') return { matches: [], error: 'error: ripgrep binary not found', hitCap: false }
    return { matches: [], error: `error: grep failed: ${e.message ?? String(err)}`, hitCap: false }
  }
}

async function grepTool(ctx: ToolContext, args: Record<string, unknown>): Promise<string> {
  const patterns = collectGrepPatterns(args)
  if (typeof patterns === 'string') return patterns

  const searchPathRaw = String(args.path ?? args.glob ?? '.').trim() || '.'
  const searchAbs = safeResolve(ctx.workspaceRoot, searchPathRaw)
  if (!searchAbs) return 'error: path is outside the workspace'

  const caseInsensitive = wantsCaseInsensitive(args)
  const sections: string[] = []
  let anyHits = false
  let anyCap = false

  for (const pattern of patterns) {
    const { matches, error, hitCap } = await runSingleGrep(
      ctx,
      pattern,
      searchAbs,
      caseInsensitive,
      MAX_GREP_MATCHES,
    )
    if (error) return error

    if (matches.length === 0) {
      sections.push(
        [
          `### pattern: ${JSON.stringify(pattern)} — No matches.`,
          'Zero hits ≠ absent: retry with a synonym, abbreviation, or alternate spelling before concluding this is missing.',
        ].join('\n'),
      )
      continue
    }

    anyHits = true
    if (hitCap) anyCap = true
    const body = matches.map(formatGrepMatch).join('\n---\n')
    const header = [
      `### pattern: ${JSON.stringify(pattern)} — ${matches.length} match(es)` +
        (caseInsensitive ? ' (case-insensitive)' : ' (case-sensitive)') +
        (hitCap
          ? `\n⚠️ Hit the ${MAX_GREP_MATCHES}-match cap — results are incomplete. Narrow by path (subdirectory) or file type (e.g. path:"src" or a tighter regex), then grep again.`
          : ''),
    ]
    sections.push([...header, body].join('\n'))
  }

  if (!anyHits) {
    return [
      `No matches for ${patterns.length} pattern(s) under ${normalizeRel(searchPathRaw)}` +
        (caseInsensitive ? ' (case-insensitive).' : '.'),
      `Tried: ${patterns.map((p) => JSON.stringify(p)).join(', ')}`,
      'Zero hits ≠ absent: you MUST try at least one more differently-phrased grep (or glob) before claiming this is not in the codebase.',
    ].join('\n')
  }

  const footer: string[] = []
  if (anyCap) {
    footer.push(
      `Note: at least one pattern hit the ${MAX_GREP_MATCHES}-match cap. Do not assume you saw everything — narrow scope and search again if completeness matters.`,
    )
  }
  if (patterns.length > 1) {
    footer.push(`Searched ${patterns.length} patterns in one call; results grouped above.`)
  }

  return footer.length ? `${sections.join('\n\n')}\n\n${footer.join('\n')}` : sections.join('\n\n')
}

function readFileTool(ctx: ToolContext, args: Record<string, unknown>): string {
  const rel = String(args.path ?? '')
  if (!rel) return 'error: "path" is required'
  const abs = safeResolve(ctx.workspaceRoot, rel)
  if (!abs) return 'error: path is outside the workspace'
  let content: string
  try {
    content = fs.readFileSync(abs, 'utf-8')
  } catch {
    return `error: cannot read ${rel}`
  }
  const lines = content.split('\n')
  const hasRange =
    args.line_start != null ||
    args.line_end != null ||
    args.start != null ||
    args.end != null

  if (!hasRange) {
    if (lines.length > MAX_READ_LINES) {
      const numbered = lines
        .slice(0, MAX_READ_LINES)
        .map((l, i) => `${i + 1}\t${l}`)
        .join('\n')
      return `${rel}:1-${MAX_READ_LINES}\n${numbered}\n\n[truncated at line ${MAX_READ_LINES} of ${lines.length} — re-read with line_start/line_end for the rest; do not assume completeness]`
    }
    const numbered = lines.map((l, i) => `${i + 1}\t${l}`).join('\n')
    return `${rel}:1-${lines.length}\n${numbered}`
  }

  const start = clampInt(
    args.line_start ?? args.start,
    1,
    1,
    Math.max(1, lines.length),
  )
  let end = clampInt(
    args.line_end ?? args.end,
    Math.min(lines.length, start + MAX_READ_LINES - 1),
    start,
    lines.length,
  )
  if (end - start + 1 > MAX_READ_LINES) end = start + MAX_READ_LINES - 1
  const numbered = lines.slice(start - 1, end).map((l, i) => `${start + i}\t${l}`).join('\n')
  const truncatedRange = end < lines.length && end - start + 1 >= MAX_READ_LINES
  const suffix = truncatedRange
    ? `\n\n[truncated at line ${end} of ${lines.length} — request another range for the rest]`
    : end < lines.length
      ? `\n\n[${end - start + 1} lines shown; file continues to line ${lines.length}]`
      : ''
  return `${rel}:${start}-${end}\n${numbered}${suffix}`
}

function countDirFiles(abs: string): { files: number; dirs: number } {
  let files = 0
  let dirs = 0
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(abs, { withFileTypes: true })
  } catch {
    return { files: 0, dirs: 0 }
  }
  for (const e of entries) {
    if (IGNORE_DIRS.has(e.name) || e.name.startsWith('.')) continue
    if (e.isDirectory()) dirs += 1
    else files += 1
  }
  return { files, dirs }
}

function listDirTool(ctx: ToolContext, args: Record<string, unknown>): string {
  const rel = String(args.path ?? '.')
  const abs = safeResolve(ctx.workspaceRoot, rel)
  if (!abs) return 'error: path is outside the workspace'

  const depth = clampInt(args.depth, 2, 1, 2)

  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(abs, { withFileTypes: true })
  } catch {
    return `error: cannot list ${rel}`
  }

  const rows = entries
    .filter((e) => !IGNORE_DIRS.has(e.name) && !e.name.startsWith('.'))
    .map((e) => ({ name: e.name, type: e.isDirectory() ? ('dir' as const) : ('file' as const) }))
    .sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1
      return a.name.localeCompare(b.name)
    })

  if (rows.length === 0) return '(empty)'

  const lines: string[] = [`${normalizeRel(rel)}/ (depth ${depth}):`]
  let childBudget = MAX_LIST_DIR_CHILDREN

  for (const r of rows) {
    if (r.type === 'file') {
      lines.push(`file  ${r.name}`)
      continue
    }

    const childAbs = path.join(abs, r.name)
    const counts = countDirFiles(childAbs)
    const relevant = isRelevantDirName(r.name)
    const flag = relevant ? ' ★relevant' : ''
    lines.push(
      `dir   ${r.name}/${flag}  (${counts.files} files, ${counts.dirs} subdirs)`,
    )

    if (depth < 2) continue

    let children: fs.Dirent[]
    try {
      children = fs.readdirSync(childAbs, { withFileTypes: true })
    } catch {
      continue
    }

    const childRows = children
      .filter((e) => !IGNORE_DIRS.has(e.name) && !e.name.startsWith('.'))
      .map((e) => ({ name: e.name, type: e.isDirectory() ? ('dir' as const) : ('file' as const) }))
      .sort((a, b) => {
        if (a.type !== b.type) return a.type === 'dir' ? -1 : 1
        return a.name.localeCompare(b.name)
      })

    const show = childRows.slice(0, Math.min(childRows.length, Math.max(0, childBudget)))
    childBudget -= show.length
    for (const c of show) {
      if (c.type === 'dir') {
        const nested = countDirFiles(path.join(childAbs, c.name))
        const nestedRelevant = isRelevantDirName(c.name)
        lines.push(
          `        dir   ${c.name}/${nestedRelevant ? ' ★relevant' : ''}  (${nested.files} files)`,
        )
      } else {
        lines.push(`        file  ${c.name}`)
      }
    }
    if (childRows.length > show.length) {
      lines.push(`        … +${childRows.length - show.length} more in ${r.name}/`)
    }
    if (childBudget <= 0 && rows.indexOf(r) < rows.length - 1) {
      lines.push('… (child listing budget reached — list_dir a specific subfolder for more)')
      break
    }
  }

  if (rows.some((r) => r.type === 'dir' && isRelevantDirName(r.name))) {
    lines.push('Tip: ★relevant folders are strong next targets for glob/grep.')
  }

  return lines.join('\n')
}

/**
 * Validate LLM-authored Mermaid and return a ready diagram block on success.
 * The model must reason from codebase tools / chat, then call this before finishing.
 */
async function validateMermaidTool(args: Record<string, unknown>): Promise<string> {
  const raw = String(args.code ?? '')
  const code = normalizeMermaidSource(raw)
  if (!code) return 'error: "code" is required (Mermaid source string)'
  if (code.length > MAX_MERMAID_CHARS) {
    return `error: Mermaid source too long (${code.length} chars; max ${MAX_MERMAID_CHARS}). Simplify to ≤ ~15–20 nodes.`
  }

  const titleRaw = typeof args.title === 'string' ? args.title.trim() : ''
  const title = titleRaw || 'Diagram'
  const result = await parseMermaid(code)
  if (!result.ok) {
    return [
      'INVALID Mermaid — fix the syntax and call validate_mermaid again.',
      `error: ${result.error}`,
      'Tips: start with flowchart TD / graph TD / sequenceDiagram; simple ids (no spaces); labels in [brackets]; quote special text A["GET /path/{id}"]; never put bare {} in unquoted labels; use real newlines in the code string.',
    ].join('\n')
  }

  const block = {
    type: 'diagram',
    props: { code: result.code, title, source: 'llm' },
  }
  return [
    'VALID Mermaid. Include this exact block (or equivalent props) in your final document array:',
    JSON.stringify(block),
  ].join('\n')
}

function slugifyDocName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
}

function makeUniqueDocId(name: string, taken: Set<string>): string {
  const base = `doc-${slugifyDocName(name) || 'document'}`
  if (!taken.has(base)) return base
  let n = 2
  while (taken.has(`${base}-${n}`)) n += 1
  return `${base}-${n}`
}

function parsePipelineDocs(raw: unknown): PipelineDocSpec[] | string {
  if (!Array.isArray(raw) || raw.length === 0) {
    return 'error: "documents" must be a non-empty array of { name, icon?, description? }'
  }
  if (raw.length > MAX_PIPELINE_DOCS) {
    return `error: at most ${MAX_PIPELINE_DOCS} documents per generate_pipeline call`
  }
  const out: PipelineDocSpec[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const rec = item as Record<string, unknown>
    const name = typeof rec.name === 'string' ? rec.name.trim() : ''
    if (!name) continue
    const iconRaw = typeof rec.icon === 'string' ? rec.icon.trim() : 'article'
    const icon = PIPELINE_ICONS.has(iconRaw) ? iconRaw : 'article'
    const description =
      typeof rec.description === 'string' ? rec.description.trim().slice(0, 280) : ''
    out.push({ name, icon, description })
  }
  if (out.length === 0) return 'error: no valid documents (each needs a non-empty "name")'
  return out
}

function emptyCanvasDoc() {
  return {
    version: 1 as const,
    kind: 'blocknote' as const,
    blocks: [{ type: 'paragraph', content: '' }],
    anchors: {} as Record<string, string>,
  }
}

async function loadStoredCustomDocs(workspaceRoot: string): Promise<StoredCustomDocType[]> {
  const existingRaw = await loadDocTypes(workspaceRoot)
  return existingRaw
    .filter(
      (v): v is StoredCustomDocType =>
        Boolean(v) &&
        typeof v === 'object' &&
        typeof (v as { id?: unknown }).id === 'string' &&
        typeof (v as { name?: unknown }).name === 'string',
    )
    .map((v, i) => ({
      id: v.id,
      name: v.name,
      icon: typeof v.icon === 'string' && v.icon ? v.icon : 'article',
      createdAt: typeof v.createdAt === 'number' ? v.createdAt : Date.now(),
      order: typeof v.order === 'number' ? v.order : i,
    }))
    .sort((a, b) => a.order - b.order)
}

async function listPipelineTool(ctx: ToolContext): Promise<string> {
  const docs = await loadStoredCustomDocs(ctx.workspaceRoot)
  if (docs.length === 0) {
    return 'Pipeline is empty — no custom documents yet. Use generate_pipeline to create some.'
  }
  return [
    `${docs.length} document(s) on the Home pipeline:`,
    ...docs.map((d, i) => `${i + 1}. ${d.name} (id: ${d.id}, icon: ${d.icon})`),
  ].join('\n')
}

async function removePipelineDocsTool(
  ctx: ToolContext,
  args: Record<string, unknown>,
): Promise<string> {
  const existing = await loadStoredCustomDocs(ctx.workspaceRoot)
  if (existing.length === 0) {
    return 'Pipeline is already empty — nothing to remove.'
  }

  const removeAll = args.all === true || args.all === 'true'
  const ids = Array.isArray(args.ids)
    ? args.ids.filter((v): v is string => typeof v === 'string').map((v) => v.trim()).filter(Boolean)
    : []
  const names = Array.isArray(args.names)
    ? args.names
        .filter((v): v is string => typeof v === 'string')
        .map((v) => v.trim().toLowerCase())
        .filter(Boolean)
    : []

  if (!removeAll && ids.length === 0 && names.length === 0) {
    return 'error: pass all:true, or ids:[...], or names:[...] to remove documents'
  }

  const idSet = new Set(ids)
  const nameSet = new Set(names)
  const removed: StoredCustomDocType[] = []
  const kept: StoredCustomDocType[] = []

  for (const doc of existing) {
    const match =
      removeAll || idSet.has(doc.id) || nameSet.has(doc.name.toLowerCase())
    if (match) removed.push(doc)
    else kept.push(doc)
  }

  if (removed.length === 0) {
    return [
      'No matching documents found to remove.',
      'Current pipeline:',
      ...existing.map((d) => `- ${d.name} (${d.id})`),
    ].join('\n')
  }

  const nextList = kept.map((c, i) => ({ ...c, order: i }))
  await saveDocTypes(ctx.workspaceRoot, nextList)
  // Full replace so the webview drops deleted tiles.
  ctx.onDocTypesChanged?.(nextList, 'replace')

  return [
    `Removed ${removed.length} document(s): ${removed.map((d) => d.name).join(', ')}.`,
    nextList.length
      ? `Remaining (${nextList.length}): ${nextList.map((d) => d.name).join(', ')}`
      : 'Pipeline is now empty.',
  ].join('\n')
}

/**
 * Create / refresh the project's custom document pipeline from orchestrator judgment.
 */
async function generatePipelineTool(
  ctx: ToolContext,
  args: Record<string, unknown>,
): Promise<string> {
  const parsed = parsePipelineDocs(args.documents)
  if (typeof parsed === 'string') return parsed

  const modeRaw = typeof args.mode === 'string' ? args.mode.trim().toLowerCase() : 'append'
  const mode: 'append' | 'replace' = modeRaw === 'replace' ? 'replace' : 'append'

  const existing = await loadStoredCustomDocs(ctx.workspaceRoot)

  const taken = new Set<string>(existing.map((e) => e.id))
  const now = Date.now()
  const created: StoredCustomDocType[] = []
  const notes: string[] = []

  for (const spec of parsed) {
    // Reuse an existing custom doc with the same name (case-insensitive) when appending.
    if (mode === 'append') {
      const hit = existing.find((e) => e.name.toLowerCase() === spec.name.toLowerCase())
      if (hit) {
        notes.push(`kept existing "${hit.name}" (${hit.id})`)
        continue
      }
    }
    const id = makeUniqueDocId(spec.name, taken)
    taken.add(id)
    created.push({
      id,
      name: spec.name,
      icon: spec.icon,
      createdAt: now,
      order: 0,
    })
    if (spec.description) notes.push(`${spec.name}: ${spec.description}`)
  }

  const nextList: StoredCustomDocType[] =
    mode === 'replace'
      ? created.map((c, i) => ({ ...c, order: i }))
      : [...existing, ...created].map((c, i) => ({ ...c, order: i }))

  await saveDocTypes(ctx.workspaceRoot, nextList)

  // Seed empty canvases for newly created ids so tiles open cleanly.
  for (const c of created) {
    try {
      await saveForm(ctx.workspaceRoot, c.id, emptyCanvasDoc())
    } catch {
      /* non-fatal */
    }
  }

  ctx.onDocTypesChanged?.(nextList, 'replace')

  const lines = [
    `Pipeline ${mode === 'replace' ? 'replaced' : 'updated'}: ${nextList.length} document(s) on Home.`,
    created.length
      ? `Created: ${created.map((c) => `${c.name} (${c.id})`).join(', ')}`
      : 'No new documents created (names already existed).',
    'To draft into a new slot next, finish with document=[…] and targetDoc set to that id or exact name.',
  ]
  if (notes.length) lines.push('Notes:', ...notes.map((n) => `- ${n}`))
  return lines.join('\n')
}

/** Execute a tool by name; always returns a bounded string observation. */
export async function runTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<string> {
  let out: string
  try {
    switch (name) {
      case 'glob':
        out = await globTool(ctx, args)
        break
      case 'read_file':
        out = readFileTool(ctx, args)
        break
      case 'grep':
        out = await grepTool(ctx, args)
        break
      case 'list_dir':
        out = listDirTool(ctx, args)
        break
      case 'validate_mermaid':
        out = await validateMermaidTool(args)
        break
      case 'list_pipeline':
        out = await listPipelineTool(ctx)
        break
      case 'generate_pipeline':
        out = await generatePipelineTool(ctx, args)
        break
      case 'remove_pipeline_docs':
        out = await removePipelineDocsTool(ctx, args)
        break
      default:
        return `error: unknown tool "${name}"`
    }
  } catch (err) {
    return `error: ${err instanceof Error ? err.message : String(err)}`
  }
  return out.length > MAX_OBS_CHARS ? out.slice(0, MAX_OBS_CHARS) + '\n…(truncated)' : out
}
