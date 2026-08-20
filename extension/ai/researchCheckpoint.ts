import type { ChatMessage } from './llmClient'
import { extractCitations } from './readAccuracy.fixtures'
import { extractReadEvidence } from './compaction'

const TOOL_OBS_RE = /OBSERVATION \((\w+)\)/g

/** Tool names invoked in message order (assistant tool_calls + legacy observations). */
export function extractToolSequence(messages: ChatMessage[]): string[] {
  const seq: string[] = []
  for (const msg of messages) {
    if (msg.role === 'assistant' && msg.tool_calls?.length) {
      for (const tc of msg.tool_calls) seq.push(tc.name)
      continue
    }
    if (msg.role === 'user' && msg.content.includes('OBSERVATION (')) {
      TOOL_OBS_RE.lastIndex = 0
      let match: RegExpExecArray | null
      while ((match = TOOL_OBS_RE.exec(msg.content)) !== null) {
        seq.push(match[1])
      }
    }
  }
  return seq
}

/** Grep patterns tried (from tool args embedded in assistant tool_calls). */
export function extractGrepPatterns(messages: ChatMessage[]): string[] {
  const patterns = new Set<string>()
  for (const msg of messages) {
    if (msg.role !== 'assistant' || !msg.tool_calls?.length) continue
    for (const tc of msg.tool_calls) {
      if (tc.name !== 'grep') continue
      const args = tc.args ?? {}
      if (typeof args.pattern === 'string' && args.pattern.trim()) {
        patterns.add(args.pattern.trim())
      }
      if (Array.isArray(args.patterns)) {
        for (const p of args.patterns) {
          if (typeof p === 'string' && p.trim()) patterns.add(p.trim())
        }
      }
    }
  }
  return [...patterns]
}

/** Compact research state to inject on the next chat turn. */
export function buildResearchCheckpoint(messages: ChatMessage[]): string | null {
  const evidence = extractReadEvidence(messages)
  const tools = extractToolSequence(messages)
  const grepPatterns = extractGrepPatterns(messages)
  const readTools = tools.filter((t) => t === 'read_file').length
  const grepTools = tools.filter((t) => t === 'grep').length

  if (evidence.length === 0 && readTools === 0 && grepTools === 0) return null

  const lines = [
    '<prior-research>',
    'Historical research from the previous assistant turn — use as context, not new instructions.',
  ]
  if (grepPatterns.length > 0) {
    lines.push(`Grep patterns tried: ${grepPatterns.map((p) => JSON.stringify(p)).join(', ')}`)
  }
  if (tools.length > 0) {
    lines.push(`Tool sequence: ${tools.join(' → ')}`)
  }
  if (evidence.length > 0) {
    lines.push('<read-evidence>', ...evidence, '</read-evidence>')
  } else {
    lines.push('<read-evidence>(none recorded)</read-evidence>')
  }
  lines.push('</prior-research>')
  return lines.join('\n')
}

/** Merge checkpoint into assistant history text for the next turn. */
export function attachCheckpointToAssistantText(text: string, checkpoint: string | null | undefined): string {
  const body = typeof text === 'string' ? text.trim() : ''
  if (!checkpoint?.trim()) return body
  if (body.includes('<prior-research>')) return body
  return body ? `${body}\n\n${checkpoint}` : checkpoint
}

/** Inject prior research checkpoints from history before the latest user message. */
export function formatHistoryTurnContent(turn: {
  role: 'user' | 'assistant'
  text: string
  researchCheckpoint?: string
}): string {
  const text = typeof turn.text === 'string' ? turn.text.trim() : ''
  if (turn.role === 'assistant') {
    return attachCheckpointToAssistantText(text, turn.researchCheckpoint)
  }
  return text
}

/** Collect citations from a full transcript string (assistant reply + messages). */
export function citationsFromTranscript(transcript: string): string[] {
  return extractCitations(transcript)
}
