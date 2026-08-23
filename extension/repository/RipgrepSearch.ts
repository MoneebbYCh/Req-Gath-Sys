import { spawn } from 'node:child_process'
import readline from 'node:readline'
import { rgPath } from '@vscode/ripgrep'
import { ToolError } from '../agent/contracts/RepositoryTool'
import { isSensitivePath } from './SensitiveFilePolicy'

/**
 * Deterministic regex/content search via `@vscode/ripgrep` (plan §10).
 * Uses rg's `--json` output for reliable parsing; enforces a match cap,
 * per-line truncation, and an overall byte cap with a truncation signal.
 */
export interface SearchMatch {
  path: string
  line: number
  text: string
}

export interface SearchOptions {
  maxMatches?: number
  maxLineLength?: number
  maxBytes?: number
  /** Plan §10 pagination: skip this many matches before collecting. */
  offset?: number
}

const DEFAULT_MAX_MATCHES = 200
const DEFAULT_MAX_LINE_LENGTH = 200
const DEFAULT_MAX_BYTES = 48 * 1024

interface RgJsonMatch {
  type?: string
  data?: {
    path?: { text?: string }
    line_number?: number
    lines?: { text?: string }
  }
}

export class RipgrepSearch {
  async search(
    pattern: string,
    roots: string[],
    options: SearchOptions = {},
  ): Promise<{ matches: SearchMatch[]; truncated: boolean; nextCursor?: number }> {
    const maxMatches = options.maxMatches ?? DEFAULT_MAX_MATCHES
    const maxLineLength = options.maxLineLength ?? DEFAULT_MAX_LINE_LENGTH
    const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
    const offset = options.offset ?? 0

    if (!pattern || roots.length === 0) return { matches: [], truncated: false }

    const args = [
      '--json',
      '--color', 'never',
      '--no-config',
      '--hidden',
      '-g', '!**/.git/**',
      '-g', '!**/node_modules/**',
      // Defense in depth: keep credential material out of ripgrep's output
      // before it can be parsed or reach a tool result. The policy check below
      // remains authoritative for names not expressible as a glob.
      '-g', '!**/.env',
      '-g', '!**/*.pem',
      '-g', '!**/*.key',
      '-g', '!**/*.p12',
      '-g', '!**/*.pfx',
      '-g', '!**/id_rsa',
      '-g', '!**/id_ed25519',
      '-g', '!**/credentials.json',
      '-e', pattern,
      ...roots,
    ]

    return new Promise((resolve, reject) => {
      let child
      try {
        child = spawn(rgPath, args, { stdio: ['ignore', 'pipe', 'pipe'] })
      } catch (err) {
        reject(new ToolError(`Failed to launch ripgrep: ${err instanceof Error ? err.message : String(err)}`, false))
        return
      }

      const matches: SearchMatch[] = []
      let bytes = 0
      let truncated = false
      let stderr = ''
      let settled = false
      let seen = 0

      const done = (fn: () => void) => {
        if (settled) return
        settled = true
        fn()
      }

      const rl = readline.createInterface({ input: child.stdout })
      rl.on('line', (line) => {
        if (truncated) return
        let parsed: RgJsonMatch
        try {
          parsed = JSON.parse(line) as RgJsonMatch
        } catch {
          return
        }
        if (parsed.type !== 'match') return
        // Plan §10 pagination: skip the first `offset` matches entirely.
        if (seen < offset) {
          seen++
          return
        }
        if (matches.length >= maxMatches) {
          truncated = true
          child.kill()
          return
        }
        const p = parsed.data?.path?.text ?? ''
        // `--hidden` includes files that direct read tools intentionally deny.
        // Filter parsed absolute paths as well, covering nested credentials and
        // future sensitive-path policy additions.
        if (isSensitivePath(p)) return
        const lineNo = parsed.data?.line_number ?? 0
        const raw = (parsed.data?.lines?.text ?? '').replace(/\r?\n$/, '')
        const text = raw.length > maxLineLength ? `${raw.slice(0, maxLineLength)}…` : raw
        bytes += p.length + text.length + 8
        if (bytes > maxBytes) {
          truncated = true
          child.kill()
          return
        }
        matches.push({ path: p, line: lineNo, text })
      })

      child.stderr.on('data', (d) => {
        stderr += String(d)
      })

      child.on('error', (err) => {
        done(() => reject(new ToolError(`ripgrep error: ${err.message}`, false)))
      })

      child.on('close', (code) => {
        if (code === 2) {
          // rg exits 2 on an invalid regex.
          done(() => reject(new ToolError(`Invalid search pattern: ${pattern}`, false)))
          return
        }
        if (code !== 0 && code !== 1 && code !== null && !truncated) {
          const reason = stderr.trim() || `ripgrep exited with code ${code}`
          done(() => reject(new ToolError(reason, false)))
          return
        }
        // Exit 0 = matches, exit 1 = no matches — both valid. When truncated,
        // the next cursor continues where this page ended.
        done(() =>
          resolve({
            matches,
            truncated,
            nextCursor: truncated ? offset + matches.length : undefined,
          }),
        )
      })
    })
  }
}
