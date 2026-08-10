import { callLlm, type ChatMessage, type LlmConfig } from './llmClient'
import { runAgentLoop } from './agentLoop'
import { normalizeDocumentBlocks } from './normalizeDocumentBlocks'
import type { EmbeddingConfig } from './embeddings'
import {
  extractDiagramCodes,
  normalizeMermaidSource,
  parseMermaid,
} from './mermaidValidate'
import {
  docLabelFor,
  loadConfig,
  loadDocTypes,
  loadForm,
  resolveEmbeddingSettings,
  saveForm,
} from '../formStateManager'
import { CodeIndexer } from '../codeIndexer'

// Document canvases — not home/profile orchestrator modes.
function isCanvasPhase(phase: string): boolean {
  const p = typeof phase === 'string' ? phase.trim() : ''
  if (!p || p === 'home' || p === 'profile') return false
  return true
}

function emptyCanvasDoc() {
  return {
    version: 1 as const,
    kind: 'blocknote' as const,
    blocks: [{ type: 'paragraph', content: '' }],
    anchors: {} as Record<string, string>,
  }
}

function normalizeCanvasDoc(data: unknown): {
  version: 1
  kind: 'blocknote'
  blocks: unknown[]
  anchors: Record<string, string>
} {
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const d = data as Record<string, unknown>
    if (d.kind === 'blocknote' && Array.isArray(d.blocks)) {
      const anchors =
        d.anchors && typeof d.anchors === 'object' && !Array.isArray(d.anchors)
          ? (d.anchors as Record<string, string>)
          : {}
      return {
        version: 1,
        kind: 'blocknote',
        blocks: d.blocks.length > 0 ? d.blocks : emptyCanvasDoc().blocks,
        anchors,
      }
    }
  }
  return emptyCanvasDoc()
}

async function loadPhaseDocument(
  workspaceRoot: string,
  phase: string,
): Promise<unknown | null> {
  if (!isCanvasPhase(phase)) return null
  return loadForm(workspaceRoot, phase)
}

export interface ChatReload {
  type: 'load_canvas'
  data: unknown
  phase?: string
}

export interface ChatResult {
  message: string
  form_updated: boolean
  reload: ChatReload | null
}

export interface ProcessChatArgs {
  text: string
  phase: string
  workspaceRoot: string
  apiKey: string
  provider?: string | null
  model?: string | null
  /** Interim UX status (e.g. "Updating code index…"). Pass null to clear. */
  onStatus?: (text: string | null) => void
  /** Fired when generate_pipeline updates doc-types.json. */
  onDocTypesChanged?: (data: unknown[], mode: 'merge' | 'replace') => void
}

/**
 * Lazy incremental embedding sync before chat.
 * Re-embeds only changed files (or builds the index on first use).
 * Returns false if Ollama / embeddings are unavailable (grep/read_file still work).
 */
async function ensureFreshEmbeddings(
  workspaceRoot: string,
  embedCfg: EmbeddingConfig,
  onStatus?: (text: string | null) => void,
): Promise<boolean> {
  try {
    onStatus?.('Checking for code changes…')
    const indexer = new CodeIndexer(workspaceRoot)
    const stats = await indexer.syncEmbeddings(embedCfg, (p) => {
      if (p.phase === 'embedding') {
        onStatus?.(`Updating code index… ${p.percent}%`)
      } else if (p.phase === 'embedding-scan') {
        onStatus?.('Checking for code changes…')
      }
    })
    if (stats.changed > 0) {
      onStatus?.(
        `Indexed ${stats.changed} changed file${stats.changed === 1 ? '' : 's'}`,
      )
    }
    return true
  } catch {
    onStatus?.('Semantic index unavailable — using file search tools…')
    return false
  }
}

export async function processChat(args: ProcessChatArgs): Promise<ChatResult> {
  const {
    text,
    phase,
    workspaceRoot,
    apiKey,
    provider,
    model,
    onStatus,
    onDocTypesChanged,
  } = args

  const config = await loadConfig(workspaceRoot)
  const llmSettings = config.llm ?? { provider: 'deepseek', model: null }

  const llmConfig: LlmConfig = {
    provider: provider || llmSettings.provider || 'deepseek',
    model: model ?? llmSettings.model ?? null,
    apiKey,
  }

  const embedCfg: EmbeddingConfig = resolveEmbeddingSettings(config)

  // Option B: keep the semantic index fresh when possible (Ollama).
  // Tools (grep/read_file/list_dir) always work even if embeddings fail.
  await ensureFreshEmbeddings(workspaceRoot, embedCfg, onStatus)
  onStatus?.('Thinking…')

  let replyText: string
  let document: unknown[] | null
  let anchors: Record<string, string> | null
  // Message transcript used as context for diagram-fix retries.
  let fixMessages: ChatMessage[]

  // Always use the agentic tool loop so the model can actually read the open workspace.
  const fieldGuide = ''
  const customLabel = phase === 'home' ? null : await docLabelFor(workspaceRoot, phase)
  const currentDocJson =
    phase === 'home'
      ? 'null'
      : JSON.stringify(
          normalizeCanvasDoc(await loadPhaseDocument(workspaceRoot, phase)),
          null,
          2,
        )
  const result = await runAgentLoop({
    text,
    phase,
    label: customLabel ?? undefined,
    fieldGuide,
    workspaceRoot,
    llmConfig,
    embedCfg,
    currentDocJson,
    onDocTypesChanged,
  })
  replyText = result.message
  document = result.document
  anchors = result.anchors
  fixMessages = result.messages
  const targetDoc = result.targetDoc

  let formUpdated = false
  let reload: ChatReload | null = null

  // Resolve where to save. Prefer explicit targetDoc (id or name) so the agent can
  // create a pipeline slot then draft into it from Home or from another open canvas.
  let savePhase: string | null = null
  if (document && targetDoc) {
    const resolved = await resolvePipelineDocTarget(workspaceRoot, targetDoc)
    if (resolved) {
      savePhase = resolved.id
    } else {
      replyText = `${replyText}\n\n(Could not save the draft — no pipeline doc matched "${targetDoc}". Call list_pipeline / generate_pipeline first, then use that exact id or name as targetDoc.)`
    }
  } else if (document && isCanvasPhase(phase)) {
    savePhase = phase
  } else if (document && !targetDoc) {
    replyText = `${replyText}\n\n(Draft was not saved — set "targetDoc" to the document id or name from list_pipeline, or open that document first.)`
  }

  if (savePhase && document) {
    const normalizedDoc = normalizeDocumentBlocks(document)
    const { blocks: validatedBlocks, notes } = await validateAndFixDiagrams(
      normalizedDoc,
      llmConfig,
      fixMessages,
    )
    const existing = normalizeCanvasDoc(await loadPhaseDocument(workspaceRoot, savePhase))
    const saved = {
      version: 1 as const,
      kind: 'blocknote' as const,
      blocks: validatedBlocks,
      anchors: anchors ?? existing.anchors ?? {},
    }
    await saveForm(workspaceRoot, savePhase, saved)
    reload = { type: 'load_canvas', phase: savePhase, data: saved }
    formUpdated = true
    if (targetDoc || phase === 'home') {
      const label = (await docLabelFor(workspaceRoot, savePhase)) || savePhase
      if (phase === 'home' || phase !== savePhase) {
        replyText = `${replyText}\n\n(Saved to “${label}” — open that tile on Home to view it.)`
      }
    }
    if (notes.length) {
      return {
        message: `${replyText}\n\n(${notes.join(' ')})`,
        form_updated: formUpdated,
        reload,
      }
    }
  }

  return {
    message: replyText,
    form_updated: formUpdated,
    reload,
  }
}

/** Match targetDoc to a custom (or built-in) pipeline id by id or display name. */
async function resolvePipelineDocTarget(
  workspaceRoot: string,
  target: string,
): Promise<{ id: string; name: string } | null> {
  const needle = target.trim().toLowerCase()
  if (!needle) return null

  const types = await loadDocTypes(workspaceRoot)
  for (const raw of types) {
    if (!raw || typeof raw !== 'object') continue
    const id = typeof (raw as { id?: unknown }).id === 'string' ? (raw as { id: string }).id : ''
    const name =
      typeof (raw as { name?: unknown }).name === 'string' ? (raw as { name: string }).name : ''
    if (!id) continue
    if (id.toLowerCase() === needle || name.toLowerCase() === needle) {
      return { id, name: name || id }
    }
  }
  return null
}

const DIAGRAM_FIX_RETRIES = 2

/**
 * Parse every diagram block before commit. On failure, ask the LLM to fix Mermaid
 * (1–2 retries), then drop still-invalid diagrams rather than blanking the canvas.
 */
async function validateAndFixDiagrams(
  blocks: unknown[],
  llmConfig: LlmConfig,
  priorMessages: ChatMessage[],
): Promise<{ blocks: unknown[]; notes: string[] }> {
  const notes: string[] = []
  let next = blocks.map((b) =>
    b && typeof b === 'object' ? { ...(b as Record<string, unknown>) } : b,
  )

  for (let attempt = 0; attempt <= DIAGRAM_FIX_RETRIES; attempt++) {
    const diagrams = extractDiagramCodes(next)
    const failures: { index: number; code: string; error: string }[] = []

    for (const d of diagrams) {
      const result = await parseMermaid(d.code)
      if (!result.ok) {
        failures.push({ ...d, error: result.error })
        continue
      }
      // Persist normalized source (unescaped \\n, stripped fences).
      const block = next[d.index]
      if (block && typeof block === 'object') {
        const b = { ...(block as Record<string, unknown>) }
        const props =
          b.props && typeof b.props === 'object' && !Array.isArray(b.props)
            ? { ...(b.props as Record<string, unknown>) }
            : {}
        props.code = result.code
        b.props = props
        next[d.index] = b
      }
    }

    if (failures.length === 0) return { blocks: next, notes }

    if (attempt === DIAGRAM_FIX_RETRIES) {
      // Last resort: replace with a warn callout — never a canned fake diagram.
      for (const f of failures) {
        const block = next[f.index]
        if (!block || typeof block !== 'object') continue
        const props =
          (block as Record<string, unknown>).props &&
          typeof (block as Record<string, unknown>).props === 'object' &&
          !Array.isArray((block as Record<string, unknown>).props)
            ? ((block as Record<string, unknown>).props as Record<string, unknown>)
            : {}
        const title =
          typeof props.title === 'string' && props.title.trim()
            ? props.title.trim()
            : 'Diagram'
        next[f.index] = {
          type: 'callout',
          props: {
            variant: 'warn',
            title: `${title} — Mermaid could not be validated`,
          },
          content:
            'Ask me to regenerate this diagram from the codebase or our chat so I can validate Mermaid again.',
        }
      }
      notes.push(
        `Replaced ${failures.length} invalid Mermaid diagram(s) with a warning callout after failed parse retries.`,
      )
      return { blocks: next, notes }
    }

    const fixPrompt = [
      'The document you returned has Mermaid diagram block(s) that failed to parse.',
      'Return a JSON object: { "message": "fixed", "fixes": [ { "index": <blockIndex>, "code": "<valid mermaid>" } ] }',
      'Only include diagram fixes. Do not rewrite the whole document.',
      '',
      'Failures:',
      ...failures.map(
        (f) =>
          `- index ${f.index}: error=${JSON.stringify(f.error)}\n  code=\n\`\`\`\n${f.code}\n\`\`\``,
      ),
    ].join('\n')

    try {
      const rawFix = await callLlm(
        [...priorMessages, { role: 'user', content: fixPrompt }],
        llmConfig,
        { jsonMode: true },
      )
      const fixes = parseDiagramFixes(rawFix)
      for (const fix of fixes) {
        const block = next[fix.index]
        if (!block || typeof block !== 'object') continue
        const b = { ...(block as Record<string, unknown>) }
        const props =
          b.props && typeof b.props === 'object' && !Array.isArray(b.props)
            ? { ...(b.props as Record<string, unknown>) }
            : {}
        props.code = normalizeMermaidSource(fix.code) || fix.code
        if (props.source !== 'code-index') props.source = 'llm'
        b.type = 'diagram'
        b.props = props
        next[fix.index] = b
      }
      notes.push(`Re-validated Mermaid after fix attempt ${attempt + 1}.`)
    } catch (err) {
      notes.push(
        `Diagram fix attempt failed: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  return { blocks: next, notes }
}

function parseDiagramFixes(text: string): { index: number; code: string }[] {
  let trimmed = text.trim()
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/)
  if (fence) trimmed = fence[1].trim()
  try {
    const parsed = JSON.parse(trimmed)
    const fixes = parsed?.fixes
    if (!Array.isArray(fixes)) return []
    return fixes
      .map((f: unknown) => {
        if (!f || typeof f !== 'object') return null
        const row = f as Record<string, unknown>
        const index = Number(row.index)
        const code = typeof row.code === 'string' ? row.code : ''
        if (!Number.isFinite(index) || !code.trim()) return null
        return { index: Math.trunc(index), code }
      })
      .filter((x): x is { index: number; code: string } => x !== null)
  } catch {
    return []
  }
}
