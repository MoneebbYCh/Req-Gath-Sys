import * as vscode from 'vscode'

const PREFIX = '[CharterAi]'

let channel: vscode.OutputChannel | undefined

/** Output panel + Debug Console. Does not write into the workspace. */
export function initDevLog(context: vscode.ExtensionContext): void {
  if (channel) return
  const create = vscode.window.createOutputChannel
  if (typeof create !== 'function') return
  channel = create('Charter Ai')
  context.subscriptions.push(channel)
}

export function showDevLog(preserveFocus = true): void {
  channel?.show(preserveFocus)
}

export function devLog(message: string): void {
  const line = `${PREFIX} ${message}`
  console.log(line)
  channel?.appendLine(`${new Date().toISOString()}  ${message}`)
}

/** Short one-line preview of tool args for logs (no huge dumps). */
export function summarizeToolArgs(args: Record<string, unknown> | undefined): string {
  if (!args || Object.keys(args).length === 0) return ''
  const parts: string[] = []
  const path = args.path ?? args.glob
  if (typeof path === 'string' && path.trim()) parts.push(path.trim())
  if (typeof args.pattern === 'string' && args.pattern.trim()) {
    parts.push(`pattern=${JSON.stringify(args.pattern.trim())}`)
  }
  if (Array.isArray(args.patterns)) {
    const pats = args.patterns.filter((p) => typeof p === 'string' && p.trim()) as string[]
    if (pats.length) parts.push(`patterns=${JSON.stringify(pats)}`)
  }
  if (typeof args.offset === 'number') parts.push(`offset=${args.offset}`)
  if (typeof args.limit === 'number') parts.push(`limit=${args.limit}`)
  if (typeof args.preset === 'string') parts.push(`preset=${args.preset}`)
  if (parts.length) return parts.join(' ')
  try {
    const raw = JSON.stringify(args)
    return raw.length > 160 ? `${raw.slice(0, 160)}…` : raw
  } catch {
    return ''
  }
}

export function previewObservation(text: string, max = 140): string {
  const compact = text.replace(/\s+/g, ' ').trim()
  if (compact.length <= max) return compact
  return `${compact.slice(0, max)}…`
}
