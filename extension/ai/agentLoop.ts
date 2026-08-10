import { CANVAS_BLOCK_CATALOG } from './blockCatalog'
import { buildGroundedContext } from './codeContext'
import { callLlm, type ChatMessage, type LlmConfig } from './llmClient'
import type { EmbeddingConfig } from './embeddings'
import { runTool, TOOL_CATALOG } from './tools'

const MAX_ITERS = 8

export interface AgentLoopArgs {
  text: string
  phase: string
  label?: string
  fieldGuide: string
  workspaceRoot: string
  llmConfig: LlmConfig
  embedCfg: EmbeddingConfig
  currentDocJson: string
  onDocTypesChanged?: (data: unknown[], mode: 'merge' | 'replace') => void
}

export interface AgentLoopResult {
  message: string
  document: unknown[] | null
  anchors: Record<string, string> | null
  /** When set (e.g. from Home), save `document` into this pipeline doc id or name. */
  targetDoc: string | null
  /** Final message transcript, for downstream diagram-fix retries. */
  messages: ChatMessage[]
}

function systemPrompt(phase: string, label: string): string {
  if (phase === 'home') {
    return `You are the Charter Ai home orchestrator. The Home Documents grid starts empty and only shows docs you create (or the user adds).

You HAVE LIVE ACCESS to the user's open workspace via tools.

CRITICAL — never claim you cannot read the codebase. If they ask what docs they need, investigate the repo first.
CRITICAL — never invent what is on the pipeline. Call list_pipeline when asked what exists, or before remove/replace.
CRITICAL — never claim you populated/wrote a document unless you returned it in "document" with "targetDoc" set to that doc's id or exact name. Home chat does not magically fill tiles.

WORKFLOW:
1. Investigate with tools: list_dir → grep / semantic_search → read_file (or reason from chat if there is little/no code).
2. If the user asks what docs exist → list_pipeline, then answer from the observation.
3. If creating doc slots → generate_pipeline (append, or replace when they want a full rebuild).
4. If removing/changing slots → list_pipeline if needed, then remove_pipeline_docs and/or generate_pipeline with mode "replace".
5. If the user asks you to draft/populate a specific document (with or without diagrams):
   a) Call list_pipeline to get the exact id/name.
   b) Research the codebase as needed; use validate_mermaid for any diagrams.
   c) Finish with document=[BlockNote blocks] AND targetDoc="<id or exact name>".
6. Otherwise finish with document:null and no targetDoc.

${TOOL_CATALOG}

RESPONSE PROTOCOL — every message MUST be a single JSON object with no markdown fences:
- To call a tool: {"thought": "why", "tool": "<name>", "args": { ... }}
- To finish (pipeline only): {"message":"…","document":null,"anchors":null}
- To finish (draft a doc from Home): {"message":"…","targetDoc":"<id or name>","document":[ /* BlockNote blocks */ ],"anchors":null}
Exactly one JSON object per message. Never include both "tool" and "document".
Keep "message" short (2–5 sentences). Put the full draft only in "document".

HARD CONSTRAINTS:
- Pipeline mutations ONLY via generate_pipeline / remove_pipeline_docs.
- Canvas content ONLY via final "document"+"targetDoc" (or when the user has that doc open).
- You may make at most ${MAX_ITERS} tool calls before you must finish.`
  }

  return `You are drafting the ${label} as a BlockNote canvas document for Charter Ai.
You HAVE LIVE ACCESS to the user's open workspace via tools. You can list directories, grep, and read real files.

CRITICAL — never claim you cannot read the codebase. Never tell the user to paste code or run external commands instead of using your tools. If the user asks you to read/analyze the code, your FIRST response must be a tool call (usually list_dir or grep).

WORKFLOW:
1. Investigate with tools when a codebase is available: list_dir → grep / semantic_search → read_file.
2. Ground claims in real code and cite file:line. If there is little/no code, reason from the chat and requirements instead.
3. When the document needs a diagram: draft Mermaid yourself from that understanding, then call validate_mermaid. Fix and re-validate if it fails. Do not skip validation for diagrams you include.
4. When you have enough evidence, output the final document JSON (include validated diagram blocks).

${TOOL_CATALOG}

RESPONSE PROTOCOL — every message MUST be a single JSON object with no markdown fences:
- To call a tool: {"thought": "why", "tool": "<name>", "args": { ... }}
- To finish:      {"message": "short human summary of what you changed + 1-3 follow-ups", "document": [ /* BlockNote blocks */ ] | null, "anchors": { /* optional */ } | null}
Exactly one JSON object per message. Never include both "tool" and "document".
Set "document": null if the user only asked a question and no document change is needed.
Keep "message" short (2–5 sentences). Put the full draft only in "document", never paste the document JSON into "message".
Ensure the JSON is complete and valid — do not truncate mid-object.

HARD CONSTRAINTS:
- Prefer custom blocks over long prose; keep it decision-dense.
- Diagrams must be LLM-reasoned (codebase and/or chat) — never a canned template.
- You may make at most ${MAX_ITERS} tool calls before you must finish.

${CANVAS_BLOCK_CATALOG}`
}

function stripFences(text: string): string {
  const trimmed = text.trim()
  // Prefer fenced body when present; otherwise use the whole string.
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/)
  return fence ? fence[1].trim() : trimmed
}

/** Extract a balanced {...} or [...] from openIdx, respecting JSON strings. */
function extractBalanced(
  text: string,
  openIdx: number,
  openChar: '{' | '[',
  closeChar: '}' | ']',
): string | null {
  if (text[openIdx] !== openChar) return null
  let depth = 0
  let inString = false
  let escape = false
  for (let i = openIdx; i < text.length; i++) {
    const c = text[i]
    if (inString) {
      if (escape) {
        escape = false
        continue
      }
      if (c === '\\') {
        escape = true
        continue
      }
      if (c === '"') inString = false
      continue
    }
    if (c === '"') {
      inString = true
      continue
    }
    if (c === openChar) depth++
    else if (c === closeChar) {
      depth--
      if (depth === 0) return text.slice(openIdx, i + 1)
    }
  }
  return null
}

/** First top-level JSON object in the text, even with leading/trailing junk. */
function extractJsonObject(text: string): string | null {
  const start = text.indexOf('{')
  if (start < 0) return null
  return extractBalanced(text, start, '{', '}')
}

function unescapeJsonString(raw: string): string {
  try {
    return JSON.parse(`"${raw}"`) as string
  } catch {
    return raw
      .replace(/\\n/g, '\n')
      .replace(/\\t/g, '\t')
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\')
  }
}

/** Pull a JSON string field when full parse fails (e.g. truncated document). */
function extractStringField(text: string, field: string): string | null {
  const re = new RegExp(`"${field}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`)
  const m = text.match(re)
  return m ? unescapeJsonString(m[1]) : null
}

function extractDocumentArray(text: string): unknown[] | null {
  const marker = text.match(/"document"\s*:\s*/)
  if (!marker || marker.index === undefined) return null
  const start = marker.index + marker[0].length
  // null document
  if (text.slice(start, start + 4) === 'null') return null
  const arr = extractBalanced(text, start, '[', ']')
  if (!arr) return null
  try {
    const parsed = JSON.parse(arr)
    return Array.isArray(parsed) && parsed.length > 0 ? parsed : null
  } catch {
    return null
  }
}

function extractAnchorsObject(text: string): Record<string, string> | null {
  const marker = text.match(/"anchors"\s*:\s*/)
  if (!marker || marker.index === undefined) return null
  const start = marker.index + marker[0].length
  if (text.slice(start, start + 4) === 'null') return null
  const obj = extractBalanced(text, start, '{', '}')
  if (!obj) return null
  try {
    return sanitizeAnchors(JSON.parse(obj))
  } catch {
    return null
  }
}

interface ParsedStep {
  tool?: string
  args?: Record<string, unknown>
  final?: {
    message: string
    document: unknown[] | null
    anchors: Record<string, string> | null
    targetDoc: string | null
  }
}

function sanitizeTargetDoc(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const t = raw.trim()
  return t || null
}

function sanitizeAnchors(raw: unknown): Record<string, string> | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'string' && v.trim()) out[k] = v.trim()
  }
  return Object.keys(out).length ? out : null
}

function lookLikeProtocolJson(text: string): boolean {
  const t = text.trim()
  return (
    t.includes('"message"') ||
    t.includes('"document"') ||
    t.includes('"tool"') ||
    (t.startsWith('{') && t.includes('":'))
  )
}

function finalFromObject(parsed: Record<string, unknown>): ParsedStep | null {
  if (typeof parsed.tool === 'string' && parsed.tool) {
    const args =
      parsed.args && typeof parsed.args === 'object' && !Array.isArray(parsed.args)
        ? (parsed.args as Record<string, unknown>)
        : {}
    return { tool: parsed.tool, args }
  }
  if (typeof parsed.message === 'string') {
    const document = Array.isArray(parsed.document) && parsed.document.length > 0 ? parsed.document : null
    return {
      final: {
        message: parsed.message,
        document,
        anchors: sanitizeAnchors(parsed.anchors),
        targetDoc: sanitizeTargetDoc(parsed.targetDoc),
      },
    }
  }
  // Document-only recovery (missing message string)
  if (Array.isArray(parsed.document) && parsed.document.length > 0) {
    return {
      final: {
        message: 'Document updated on the canvas.',
        document: parsed.document,
        anchors: sanitizeAnchors(parsed.anchors),
        targetDoc: sanitizeTargetDoc(parsed.targetDoc),
      },
    }
  }
  return null
}

/**
 * Parse a model step. Tolerates fences, leading/trailing junk, and partially
 * truncated finals by recovering message/document/anchors with field extractors.
 */
export function parseStep(raw: string): ParsedStep | null {
  const body = stripFences(raw)
  const candidates = [body]
  const extracted = extractJsonObject(body)
  if (extracted && extracted !== body) candidates.unshift(extracted)

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as Record<string, unknown>
      const step = finalFromObject(parsed)
      if (step) return step
    } catch {
      /* try next / recover */
    }
  }

  // Soft repair: recover fields from broken/truncated JSON.
  const message = extractStringField(body, 'message')
  const document = extractDocumentArray(body)
  const anchors = extractAnchorsObject(body)
  const targetDoc = extractStringField(body, 'targetDoc')
  const tool = extractStringField(body, 'tool')

  if (tool && !document) {
    // Best-effort tool call with empty args if object is truncated.
    let args: Record<string, unknown> = {}
    const argsMarker = body.match(/"args"\s*:\s*/)
    if (argsMarker && argsMarker.index !== undefined) {
      const argsJson = extractBalanced(body, argsMarker.index + argsMarker[0].length, '{', '}')
      if (argsJson) {
        try {
          args = JSON.parse(argsJson) as Record<string, unknown>
        } catch {
          /* keep empty */
        }
      }
    }
    return { tool, args }
  }

  if (message || document) {
    return {
      final: {
        message:
          message ||
          (document
            ? 'Document drafted and applied to the canvas.'
            : 'Done.'),
        document,
        anchors,
        targetDoc,
      },
    }
  }

  return null
}

/** Never dump protocol JSON into the chat UI. */
function safeChatMessage(raw: string, recovered?: ParsedStep | null): string {
  if (recovered?.final?.message) return recovered.final.message
  const body = stripFences(raw)
  if (lookLikeProtocolJson(body) || body.includes('"document"') || body.trim().startsWith('{')) {
    if (body.includes('"document"')) {
      return 'I drafted the document, but the response was incomplete or invalid JSON so it could not be applied to the canvas. Please ask me to try again (e.g. “apply the charter again”).'
    }
    return 'I hit a formatting error preparing the reply. Please try again.'
  }
  // Plain prose fallback
  return body.slice(0, 2000) || 'Could not complete the request.'
}

/** Agentic ReAct loop: investigate the code with tools, then draft the document. */
export async function runAgentLoop(args: AgentLoopArgs): Promise<AgentLoopResult> {
  const { text, phase, fieldGuide, workspaceRoot, llmConfig, embedCfg, currentDocJson } = args
  const label =
    phase === 'home'
      ? 'Home orchestrator'
      : args.label || phase

  const seed = await buildGroundedContext(workspaceRoot, text, embedCfg, 8)
  const userParts = [`USER: ${text}`, '']
  if (phase === 'home') {
    userParts.push(
      'CONTEXT: User is on the Home screen. Use generate_pipeline / list_pipeline / remove_pipeline_docs for slots. To draft a specific doc from Home, finish with both "document" (BlockNote blocks) and "targetDoc" (id or exact name from list_pipeline). Never claim a canvas was filled without that.',
      '',
    )
  } else if (fieldGuide) {
    userParts.push('Document guidance:', fieldGuide, '')
  }
  if (phase !== 'home') {
    userParts.push('CURRENT DOCUMENT (BlockNote JSON):', '```json', currentDocJson, '```')
  }
  if (seed) userParts.push('', seed)

  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt(phase, label) },
    { role: 'user', content: userParts.join('\n') },
  ]

  const ctx = {
    workspaceRoot,
    embedCfg,
    onDocTypesChanged: args.onDocTypesChanged,
  }
  let lastRaw = ''

  for (let iter = 0; iter < MAX_ITERS; iter++) {
    const raw = await callLlm(messages, llmConfig, { jsonMode: true })
    lastRaw = raw
    const step = parseStep(raw)

    if (step?.final) {
      return { ...step.final, messages }
    }

    if (step?.tool) {
      const observation = await runTool(step.tool, step.args ?? {}, ctx)
      messages.push({ role: 'assistant', content: raw })
      messages.push({
        role: 'user',
        content: `OBSERVATION (${step.tool}):\n${observation}`,
      })
      continue
    }

    // Unparseable — if it looks like a truncated final with a document, try once more with a repair ask.
    if (lookLikeProtocolJson(stripFences(raw)) && stripFences(raw).includes('"document"')) {
      messages.push({ role: 'assistant', content: raw })
      messages.push({
        role: 'user',
        content:
          phase === 'home'
            ? 'Your previous final JSON was invalid or truncated. Re-send ONE complete valid JSON object. If drafting a doc include targetDoc and document; otherwise document:null. Example: {"message":"…","targetDoc":"Architecture Overview","document":[…],"anchors":null}. No tool calls. No markdown fences.'
            : 'Your previous final JSON was invalid or truncated. Re-send ONE complete valid JSON object: {"message":"<short summary>","document":[...],"anchors":{...}}. Keep the document decision-dense so it fits. No tool calls. No markdown fences.',
      })
      const repaired = await callLlm(messages, llmConfig, { jsonMode: true })
      lastRaw = repaired
      const repairedStep = parseStep(repaired)
      if (repairedStep?.final) return { ...repairedStep.final, messages }
      // Fall through to nudge / continue with soft recovery from either raw
      const soft = parseStep(raw) || parseStep(repaired)
      if (soft?.final) return { ...soft.final, messages }
    }

    messages.push({ role: 'assistant', content: raw })
    messages.push({
      role: 'user',
      content:
        phase === 'home'
          ? 'That was not valid. Respond with a single JSON object: either a tool call {"tool","args"} or the final {"message","document","targetDoc","anchors"}.'
          : 'That was not valid. Respond with a single JSON object: either a tool call {"tool","args"} or the final {"message","document","anchors"}.',
    })
  }

  // Budget exhausted — force a final answer using whatever evidence was gathered.
  messages.push({
    role: 'user',
    content:
      phase === 'home'
        ? 'Tool budget reached. Respond NOW with final JSON only: {"message","document","targetDoc","anchors"}. Use targetDoc+document if drafting; else document:null. No tool calls.'
        : 'Tool budget reached. Respond NOW with the final JSON only: {"message","document","anchors"}. Keep document complete and valid. No tool calls.',
  })
  const raw = await callLlm(messages, llmConfig, { jsonMode: true })
  lastRaw = raw
  const step = parseStep(raw)
  if (step?.final) return { ...step.final, messages }

  // Last resort soft recovery from the last raw payloads
  const soft = parseStep(lastRaw)
  if (soft?.final) return { ...soft.final, messages }

  return {
    message: safeChatMessage(raw, soft),
    document: null,
    anchors: null,
    targetDoc: null,
    messages,
  }
}
