import * as fs from 'fs'
import * as path from 'path'
import { LEGACY_STATE_DIR, STATE_DIR } from '../brand'
import { loadDocTypes, saveDocTypes, saveForm } from '../formStateManager'
import { normalizeMermaidSource, parseMermaid } from './mermaidValidate'
import { readFileTool as readFilePageTool, MAX_READ_LINES } from './readTool'
import {
  formatGrepMatch,
  globFiles,
  grepSearch,
} from './ripgrepAdapter'
import { boundToolOutput } from './toolOutputStore'

export interface ToolContext {
  workspaceRoot: string
  /** Called after generate_pipeline writes doc-types.json so the webview can refresh. */
  onDocTypesChanged?: (data: unknown[], mode: 'merge' | 'replace') => void
  /** N5: ask the user before destructive pipeline mutations. Resolves true = approved. */
  confirmDestructive?: (what: string) => Promise<boolean>
  /** Set after the user declines once, so the agent cannot re-prompt/spam the modal. */
  destructiveDeclined?: boolean
}

/**
 * N5: which agent tool calls can wipe the user's pipeline and therefore need a
 * human confirmation before executing. Targeted removals stay ungated.
 */
export function needsDestructiveConfirm(
  tool: string,
  args: Record<string, unknown>,
): boolean {
  if (tool === 'remove_pipeline_docs') {
    return args.all === true || args.all === 'true'
  }
  if (tool === 'generate_pipeline') {
    const mode = typeof args.mode === 'string' ? args.mode.trim().toLowerCase() : 'append'
    return mode === 'replace'
  }
  return false
}

const IGNORE_DIRS = new Set([
  'node_modules', 'dist', 'out', '.git', STATE_DIR, LEGACY_STATE_DIR, '.vscode',
])

const MAX_GREP_MATCHES = 50
const MAX_GLOB_RESULTS = 50
const MAX_MERMAID_CHARS = 8000
const MAX_PIPELINE_DOCS = 12
const MAX_LIST_DIR_CHILDREN = 40

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

/**
 * Short developer reference for tools. The LLM reads native tool schemas
 * (`agentToolSchemas.ts`) plus mode policies in `prompts/` — not this string.
 */
export const TOOL_CATALOG = `Tools (native schemas): list_dir, glob, grep, read_file, validate_mermaid, list_pipeline, generate_pipeline, remove_pipeline_docs.
Batch independent tools in one turn. Prefer list_dir → glob → grep → read_file. Cite path:line from read_file.`

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

function normalizeRel(rel: string): string {
  return rel.replace(/\\/g, '/') || '.'
}

function isRelevantDirName(name: string): boolean {
  if (RELEVANT_DIR_RE.test(name)) return true
  return /^agent/i.test(name) || /^api/i.test(name)
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

  const files = await globFiles({
    cwd: ctx.workspaceRoot,
    patterns: resolved.patterns,
    limit: maxResults + 1,
  })

  const truncated = files.length > maxResults
  const slice = files.slice(0, maxResults)

  if (slice.length === 0) {
    return [
      `No files matched (${resolved.label}).`,
      'Ripgrep respects .gitignore — try a more specific path if files might be ignored.',
      'Zero hits ≠ absent: retry with another preset/pattern before concluding nothing exists.',
    ].join('\n')
  }

  const lines = [
    `${slice.length} file(s) (${resolved.label})${
      truncated
        ? ` — truncated; ${files.length} total matched, showing first ${maxResults}. Narrow the pattern.`
        : ''
    }:`,
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
  if (args.case_sensitive === true || args.case_sensitive === 'true' || args.caseSensitive === true) {
    return false
  }
  if (args.case_insensitive === false || args.case_insensitive === 'false' || args.caseInsensitive === false) {
    return false
  }
  return true
}

async function grepTool(ctx: ToolContext, args: Record<string, unknown>): Promise<string> {
  const patterns = collectGrepPatterns(args)
  if (typeof patterns === 'string') return patterns

  const searchPathRaw = String(args.path ?? args.glob ?? '.').trim() || '.'
  const searchAbs = safeResolve(ctx.workspaceRoot, searchPathRaw)
  if (!searchAbs) return 'error: path is outside the workspace'

  const caseInsensitive = wantsCaseInsensitive(args)
  const include = typeof args.include === 'string' ? args.include : undefined
  const sections: string[] = []
  let anyHits = false
  let anyCap = false

  for (const pattern of patterns) {
    const { matches, error, hitCap } = await grepSearch({
      workspaceRoot: ctx.workspaceRoot,
      pattern,
      searchPath: searchAbs,
      include,
      caseInsensitive,
      limit: MAX_GREP_MATCHES,
    })
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
          ? `\n⚠️ Hit the ${MAX_GREP_MATCHES}-match cap — results are incomplete. Narrow by path (subdirectory) or file type, then grep again.`
          : ''),
    ]
    sections.push([...header, body].join('\n'))
  }

  let result: string
  if (!anyHits) {
    result = [
      `No matches for ${patterns.length} pattern(s) under ${normalizeRel(searchPathRaw)}` +
        (caseInsensitive ? ' (case-insensitive).' : '.'),
      `Tried: ${patterns.map((p) => JSON.stringify(p)).join(', ')}`,
      'Zero hits ≠ absent: you MUST try at least one more differently-phrased grep (or glob) before claiming this is not in the codebase.',
    ].join('\n')
  } else {
    const footer: string[] = []
    if (anyCap) {
      footer.push(
        `Note: at least one pattern hit the ${MAX_GREP_MATCHES}-match cap. Do not assume you saw everything — narrow scope and search again if completeness matters.`,
      )
    }
    if (patterns.length > 1) {
      footer.push(`Searched ${patterns.length} patterns in one call; results grouped above.`)
    }
    footer.push(
      'Reminder: grep hits are leads only. Call read_file on the top 1–2 files before stating facts.',
    )
    result = `${sections.join('\n\n')}\n\n${footer.join('\n')}`
  }

  return result
}

function readFileTool(ctx: ToolContext, args: Record<string, unknown>): string {
  return readFilePageTool(ctx.workspaceRoot, args)
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
  // N5: wiping the whole pipeline needs the user's OK first.
  if (needsDestructiveConfirm('remove_pipeline_docs', args)) {
    if (ctx.destructiveDeclined) {
      return 'The user declined the destructive pipeline removal earlier in this run — do NOT retry it. Report that the removal was cancelled.'
    }
    if (ctx.confirmDestructive) {
      const ok = await ctx.confirmDestructive('remove all pipeline documents')
      if (!ok) {
        ctx.destructiveDeclined = true
        return 'The user declined to remove all pipeline documents. Do NOT call remove_pipeline_docs again in this run — tell the user the removal was cancelled.'
      }
    }
  }

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

  // N5: a full pipeline rebuild replaces the user's docs — needs their OK first.
  if (needsDestructiveConfirm('generate_pipeline', args)) {
    if (ctx.destructiveDeclined) {
      return 'The user declined the destructive pipeline replacement earlier in this run — do NOT retry it. Report that the replacement was cancelled.'
    }
    if (ctx.confirmDestructive) {
      const ok = await ctx.confirmDestructive('replace the entire pipeline')
      if (!ok) {
        ctx.destructiveDeclined = true
        return 'The user declined to replace the entire pipeline. Do NOT call generate_pipeline again in this run — tell the user the replacement was cancelled.'
      }
    }
  }

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
  return boundToolOutput(ctx.workspaceRoot, out)
}
