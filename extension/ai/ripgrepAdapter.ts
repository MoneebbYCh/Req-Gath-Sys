import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import * as fs from 'fs'
import * as path from 'path'
import { LEGACY_STATE_DIR, STATE_DIR } from '../brand'

const execFileAsync = promisify(execFile)
const GREP_CONTEXT_LINES = 1

export interface RgMatch {
  file: string
  line: number
  text: string
  before: { line: number; text: string }[]
  after: { line: number; text: string }[]
}

let cachedRgPath: string | null | undefined

export async function resolveRgPath(): Promise<string | null> {
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

function toWorkspaceRel(workspaceRoot: string, absOrRel: string): string {
  if (path.isAbsolute(absOrRel)) {
    return path.relative(workspaceRoot, absOrRel) || '.'
  }
  return absOrRel.replace(/\\/g, '/')
}

/** Prefer non-test, non-vendor, shallower paths first. */
export function grepRelevanceScore(file: string): number {
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

export function sortGrepMatches<T extends { file: string; line: number }>(matches: T[]): T[] {
  return [...matches].sort((a, b) => {
    const sa = grepRelevanceScore(a.file)
    const sb = grepRelevanceScore(b.file)
    if (sa !== sb) return sa - sb
    if (a.file !== b.file) return a.file.localeCompare(b.file)
    return a.line - b.line
  })
}

/** Parse ripgrep --json -C N into ranked matches with before/after snippets. */
export function parseRipgrepJson(stdout: string, workspaceRoot: string, maxMatches: number): RgMatch[] {
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

export function formatGrepMatch(m: RgMatch): string {
  const lines: string[] = [`${m.file}:`]
  for (const b of m.before) lines.push(`  Line ${b.line}: ${b.text}`)
  lines.push(`  Line ${m.line}: ${m.text}`)
  for (const a of m.after) lines.push(`  Line ${a.line}: ${a.text}`)
  return lines.join('\n')
}

const DEFAULT_IGNORE_GLOBS = [
  '--glob', '!**/node_modules/**',
  '--glob', '!**/dist/**',
  '--glob', '!**/out/**',
  '--glob', `!**/${STATE_DIR}/**`,
  '--glob', `!**/${LEGACY_STATE_DIR}/**`,
]

export interface GrepSearchInput {
  workspaceRoot: string
  pattern: string
  searchPath: string
  include?: string
  caseInsensitive?: boolean
  limit: number
}

function resolveSearchTarget(searchPath: string): { cwd: string; target: string } {
  const stat = fs.statSync(searchPath)
  if (stat.isDirectory()) return { cwd: searchPath, target: '.' }
  return { cwd: path.dirname(searchPath), target: path.basename(searchPath) }
}

export async function grepSearch(
  input: GrepSearchInput,
): Promise<{ matches: RgMatch[]; error?: string; hitCap: boolean }> {
  const rg = await resolveRgPath()
  if (!rg) return { matches: [], error: 'error: ripgrep is unavailable', hitCap: false }

  let cwd: string
  let target: string
  try {
    ;({ cwd, target } = resolveSearchTarget(input.searchPath))
  } catch {
    return { matches: [], error: `error: invalid search path ${input.searchPath}`, hitCap: false }
  }

  const rgArgs = [
    '--json',
    '-C',
    String(GREP_CONTEXT_LINES),
    '--max-count',
    String(input.limit),
    ...DEFAULT_IGNORE_GLOBS,
  ]
  if (input.include) {
    rgArgs.push('--glob', input.include)
  }
  if (input.caseInsensitive !== false) rgArgs.push('-i')
  rgArgs.push('--', input.pattern, target)

  try {
    const { stdout } = await execFileAsync(rg, rgArgs, {
      maxBuffer: 2 * 1024 * 1024,
      cwd,
    })
    const matches = parseRipgrepJson(stdout, input.workspaceRoot, input.limit)
    return { matches, hitCap: matches.length >= input.limit }
  } catch (err: unknown) {
    const e = err as { code?: number | string; stdout?: string; message?: string }
    if (e.code === 1) return { matches: [], hitCap: false }
    if (e.stdout) {
      const matches = parseRipgrepJson(e.stdout, input.workspaceRoot, input.limit)
      return { matches, hitCap: matches.length >= input.limit }
    }
    if (e.code === 'ENOENT') return { matches: [], error: 'error: ripgrep binary not found', hitCap: false }
    return { matches: [], error: `error: grep failed: ${e.message ?? String(err)}`, hitCap: false }
  }
}

export interface GlobSearchInput {
  cwd: string
  patterns: string[]
  limit: number
}

/** Find files by glob via ripgrep --files (respects .gitignore). */
export async function globFiles(input: GlobSearchInput): Promise<string[]> {
  const rg = await resolveRgPath()
  if (!rg) return []

  const seen = new Set<string>()
  const results: string[] = []

  for (const pattern of input.patterns) {
    const rgArgs = ['--files', ...DEFAULT_IGNORE_GLOBS, '--glob', pattern, '.']
    try {
      const { stdout } = await execFileAsync(rg, rgArgs, {
        maxBuffer: 2 * 1024 * 1024,
        cwd: input.cwd,
      })
      for (const line of stdout.split('\n')) {
        const rel = line.trim().replace(/\\/g, '/')
        if (!rel || seen.has(rel)) continue
        seen.add(rel)
        results.push(rel)
        if (results.length >= input.limit) return results
      }
    } catch (err: unknown) {
      const e = err as { code?: number | string; stdout?: string }
      if (e.code === 1) continue
      if (e.stdout) {
        for (const line of e.stdout.split('\n')) {
          const rel = line.trim().replace(/\\/g, '/')
          if (!rel || seen.has(rel)) continue
          seen.add(rel)
          results.push(rel)
          if (results.length >= input.limit) return results
        }
      }
    }
  }

  return results.sort((a, b) => a.localeCompare(b))
}
