import * as fs from 'fs'
import * as path from 'path'
import { LEGACY_STATE_DIR, STATE_DIR } from '../brand'
import { loadDocTypes, saveDocTypes, saveForm } from '../formStateManager'
import { retrieve } from './retrieval'
import type { EmbeddingConfig } from './embeddings'
import { normalizeMermaidSource, parseMermaid } from './mermaidValidate'

export interface ToolContext {
  workspaceRoot: string
  embedCfg: EmbeddingConfig
  /** Called after generate_pipeline writes doc-types.json so the webview can refresh. */
  onDocTypesChanged?: (data: unknown[], mode: 'merge' | 'replace') => void
}

const IGNORE_DIRS = new Set([
  'node_modules', 'dist', 'out', '.git', STATE_DIR, LEGACY_STATE_DIR, '.vscode',
])
const SUPPORTED =
  /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|rb|php|swift|kt|kts|scala|sh|bash|zsh|ps1|md|mdx|json|yaml|yml|toml|css|scss|html|htm|sql)$/i

const MAX_READ_LINES = 200
const MAX_GREP_MATCHES = 40
const MAX_GREP_FILES = 4000
const MAX_OBS_CHARS = 6000
const MAX_MERMAID_CHARS = 8000
const MAX_PIPELINE_DOCS = 12
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
  'semantic_search',
  'read_file',
  'grep',
  'list_dir',
  'validate_mermaid',
  'list_pipeline',
  'generate_pipeline',
  'remove_pipeline_docs',
] as const

/** Human-readable tool catalog for the agent system prompt. */
export const TOOL_CATALOG = `AVAILABLE TOOLS (call one per step):
Codebase tools (user's open workspace folder):
- list_dir { "path": string }  -> explore folders (start with "." or "src")
- grep { "pattern": string, "glob"?: string }  -> regex matches across the codebase
- read_file { "path": string, "start"?: number, "end"?: number }  -> file contents (max ${MAX_READ_LINES} lines)
- semantic_search { "query": string, "k"?: number }  -> ranked code by meaning (may be empty if embeddings are offline; then use grep/list_dir/read_file instead)

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

function globToRegExp(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\u0000/g, '.*')
    .replace(/\?/g, '.')
  return new RegExp(escaped)
}

function walkFiles(workspaceRoot: string, onFile: (abs: string, rel: string) => boolean): void {
  const walk = (dir: string): boolean => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return true
    }
    for (const entry of entries) {
      if (IGNORE_DIRS.has(entry.name)) continue
      const abs = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (!walk(abs)) return false
      } else if (entry.isFile() && SUPPORTED.test(entry.name)) {
        const rel = path.relative(workspaceRoot, abs)
        if (!onFile(abs, rel)) return false
      }
    }
    return true
  }
  walk(workspaceRoot)
}

async function semanticSearch(ctx: ToolContext, args: Record<string, unknown>): Promise<string> {
  const query = String(args.query ?? '').trim()
  if (!query) return 'error: "query" is required'
  const k = clampInt(args.k, 8, 1, 15)
  const hits = await retrieve(ctx.workspaceRoot, query, k, ctx.embedCfg)
  if (hits.length === 0) return 'No results (index empty or embeddings unavailable).'
  return hits
    .map(
      (h) =>
        `- ${h.file}:${h.startLine}-${h.endLine}` +
        `${h.symbol && h.symbol !== 'block' ? ' ' + h.symbol : ''} (score ${h.score.toFixed(3)})`,
    )
    .join('\n')
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
  const start = clampInt(args.start, 1, 1, Math.max(1, lines.length))
  let end = clampInt(args.end, Math.min(lines.length, start + MAX_READ_LINES - 1), start, lines.length)
  if (end - start + 1 > MAX_READ_LINES) end = start + MAX_READ_LINES - 1
  const numbered = lines.slice(start - 1, end).map((l, i) => `${start + i}\t${l}`).join('\n')
  return `${rel}:${start}-${end}\n${numbered}`
}

function grepTool(ctx: ToolContext, args: Record<string, unknown>): string {
  const pattern = String(args.pattern ?? '')
  if (!pattern) return 'error: "pattern" is required'
  let re: RegExp
  try {
    re = new RegExp(pattern, 'i')
  } catch {
    return 'error: invalid regular expression'
  }
  const globRe = args.glob ? globToRegExp(String(args.glob)) : null
  const matches: string[] = []
  let scanned = 0

  walkFiles(ctx.workspaceRoot, (abs, rel) => {
    if (scanned >= MAX_GREP_FILES) return false
    scanned++
    if (globRe && !globRe.test(rel)) return true
    let text: string
    try {
      text = fs.readFileSync(abs, 'utf-8')
    } catch {
      return true
    }
    const lines = text.split('\n')
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i])) {
        matches.push(`${rel}:${i + 1}: ${lines[i].trim().slice(0, 200)}`)
        if (matches.length >= MAX_GREP_MATCHES) return false
      }
    }
    return true
  })

  if (matches.length === 0) return 'No matches.'
  return matches.join('\n')
}

function listDirTool(ctx: ToolContext, args: Record<string, unknown>): string {
  const rel = String(args.path ?? '.')
  const abs = safeResolve(ctx.workspaceRoot, rel)
  if (!abs) return 'error: path is outside the workspace'
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(abs, { withFileTypes: true })
  } catch {
    return `error: cannot list ${rel}`
  }
  return entries
    .filter((e) => !IGNORE_DIRS.has(e.name))
    .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
    .sort()
    .join('\n')
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
      case 'semantic_search':
        out = await semanticSearch(ctx, args)
        break
      case 'read_file':
        out = readFileTool(ctx, args)
        break
      case 'grep':
        out = grepTool(ctx, args)
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
