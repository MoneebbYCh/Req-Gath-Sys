import { z } from 'zod'
import type { TaskNode } from '../contracts/TaskGraph'
import { FindingStore } from '../knowledge/FindingStore'
import { ProjectFactBase } from '../knowledge/ProjectFactBase'
import { runToolLoop, type ToolLoopConfig } from '../model/toolLoopTaskRunner'
import { extractJsonBlock } from '../model/jsonBlock'
import type { ModelProvider } from '../model/ModelProvider'
import type { ModelInvocationContext } from '../model/ModelTypes'
import type { TaskBudgetController, TaskTelemetryEvent } from '../observability/TaskControls'
import { irBlockSchema, documentIrSchema, type DocumentIR, type IRBlock } from '../../documents/DocumentIR'
import type { DocumentGateway } from './DocumentGateway'
import type { DocumentProgressState } from '../../../shared/agentProtocol'

/**
 * Document worker runtime (plan §12). One runtime, any document type — the
 * title/objective come from the node's WorkerSpec. Generates section-by-section:
 * outline → per-section model pass → validated IR → FULL rendered checkpoint
 * through the host DocumentService (revision-safe). Consumes the shared fact
 * base, never the repository directly — parallel documents stay consistent
 * (US-12.4). No tools are offered; repository truth arrives via findings.
 */

export interface DocumentWorkerDeps {
  provider: ModelProvider
  baseConfig: ToolLoopConfig
  findings: FindingStore
  facts: ProjectFactBase
  gateway: DocumentGateway
  /** Durable-state hook (plan §14): every checkpointed IR survives a restart. */
  onCheckpoint?: (documentId: string, ir: DocumentIR) => void
}

export interface DocumentRunContext {
  taskId?: string
  signal: AbortSignal
  activity: (activity: string) => void
  documentDeclared: (document: DocumentProgressState) => void
  documentProgress: (document: DocumentProgressState) => void
  documentCheckpoint: (info: {
    documentId: string
    title: string
    sectionTitle?: string
    completedSections: number
    totalSections: number
    conflict?: boolean
    pendingDraftId?: string
  }) => void
  /** Runtime task/node state, propagated to every document model pass. */
  modelContext?: ModelInvocationContext
  /** Task-scoped Phase 16 controls, propagated through every section pass. */
  loopConfig?: ToolLoopConfig
  budgetController?: TaskBudgetController
}

export interface DocumentRunResult {
  outputs: string[]
  documentId?: string
  completedSections: number
  totalSections: number
  conflict?: boolean
  pendingDraftId?: string
}

const outlineSchema = z.object({
  sections: z.array(z.object({ heading: z.string().min(1).max(300) })).min(1).max(12),
})

const sectionSchema = z.object({
  blocks: z.array(irBlockSchema).max(60),
})

const MAX_SECTIONS = 12

type SectionParseOutcome = 'valid' | 'empty' | 'markdown' | 'malformed_json' | 'schema_mismatch'

interface SectionParseResult {
  blocks: IRBlock[] | null
  outcome: SectionParseOutcome
  jsonExtracted: boolean
  schemaIssueCodes?: string[]
  schemaIssueCount?: number
}

function parseSectionText(text: string): SectionParseResult {
  const raw = extractJsonBlock(text)
  if (raw !== undefined) {
    const parsed = sectionSchema.safeParse(raw)
    if (parsed.success) return { blocks: parsed.data.blocks, outcome: 'valid', jsonExtracted: true }
    const schemaIssueCodes = [...new Set(parsed.error.issues.map((issue) => issue.code))].slice(0, 4)
    return {
      blocks: null,
      outcome: 'schema_mismatch',
      jsonExtracted: true,
      schemaIssueCount: parsed.error.issues.length,
      schemaIssueCodes,
    }
  }
  if (!text.trim()) return { blocks: null, outcome: 'empty', jsonExtracted: false }
  if (/^(?:```(?:json)?\s*)?[{[]/.test(text.trim())) {
    return { blocks: null, outcome: 'malformed_json', jsonExtracted: false }
  }
  const blocks = markdownBlocks(text)
  return blocks
    ? { blocks, outcome: 'markdown', jsonExtracted: false }
    : { blocks: null, outcome: 'malformed_json', jsonExtracted: false }
}

/**
 * Converts ordinary model Markdown into the smallest useful subset of the
 * canvas IR. JSON remains preferred, but valid prose must never be discarded
 * merely because a provider ignored JSON mode.
 */
function markdownBlocks(text: string): IRBlock[] | null {
  const lines = text.replace(/\r\n/g, '\n').trim().split('\n')
  if (lines.length === 0 || lines.every((line) => line.trim().length === 0)) return null

  const blocks: IRBlock[] = []
  let paragraph: string[] = []
  let listKind: 'bullets' | 'numbered' | undefined
  let listItems: string[] = []
  const flushParagraph = () => {
    const value = paragraph.join(' ').trim()
    if (value) blocks.push({ type: 'paragraph', text: value })
    paragraph = []
  }
  const flushList = () => {
    if (listKind && listItems.length > 0) blocks.push({ type: listKind, items: listItems })
    listKind = undefined
    listItems = []
  }

  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line) {
      flushParagraph()
      flushList()
      continue
    }
    const bullet = line.match(/^[-*+]\s+(.+)$/)
    const numbered = line.match(/^\d+[.)]\s+(.+)$/)
    if (bullet || numbered) {
      flushParagraph()
      const nextKind = bullet ? 'bullets' : 'numbered'
      if (listKind && listKind !== nextKind) flushList()
      listKind = nextKind
      listItems.push((bullet ?? numbered)![1].trim())
      continue
    }
    flushList()
    paragraph.push(line.replace(/^#{1,6}\s+/, ''))
  }
  flushParagraph()
  flushList()

  const parsed = sectionSchema.safeParse({ blocks })
  return parsed.success && parsed.data.blocks.length > 0 ? parsed.data.blocks : null
}

/** Deterministic block → plain-text serialization (for validation, plan §13). */
function blocksText(blocks: IRBlock[]): string {
  return blocks
    .map((b) => {
      switch (b.type) {
        case 'paragraph':
          return b.text
        case 'bullets':
        case 'numbered':
          return b.items.map((i) => `- ${i}`).join('\n')
        case 'callout':
          return `${b.title ? `${b.title}: ` : ''}${b.text}`
        case 'table':
          return [b.header.join(' | '), ...b.rows.map((r) => r.join(' | '))].join('\n')
        case 'risk':
          return b.rows
            .map((r) => `Risk: ${r.risk}${r.mitigation ? ` — Mitigation: ${r.mitigation}` : ''}`)
            .join('\n')
        case 'scope':
          return `In scope: ${b.inScope.join(', ')}\nOut of scope: ${b.outOfScope.join(', ')}`
        case 'mermaid':
          return b.title ?? 'Diagram'
      }
    })
    .join('\n')
}

/** Validation-facing payload: section headings + bounded plain text. */
function sectionTextsPayload(documentId: string, title: string, sections: DocumentIR['sections']): string {
  return JSON.stringify({
    documentId,
    title,
    sectionTexts: sections.map((s) => ({ heading: s.heading, text: blocksText(s.blocks).slice(0, 2_000) })),
  })
}

function factsSummary(findings: FindingStore, facts: ProjectFactBase): string {
  const lines: string[] = []
  for (const f of facts.all().slice(0, 30)) {
    lines.push(`- FACT ${f.domain}: ${f.statement}`)
  }
  for (const f of findings.all().slice(0, 40)) {
    lines.push(`- FINDING [${f.type}] (${f.domain}): ${f.claim}`)
  }
  return lines.join('\n') || '- (no established facts yet)'
}

async function modelJson(
  provider: ModelProvider,
  config: ToolLoopConfig,
  text: string,
  system: string,
  signal: AbortSignal,
  activity: (a: string) => void,
  context?: ModelInvocationContext,
  jsonMode = true,
): Promise<string> {
  const result = await runToolLoop(
    provider,
    { execute: async () => ({ ok: false, error: 'No tools available.' }) },
    {
      ...config,
      system: jsonMode
        ? `${system}\nUse this exact JSON shape for a prose block: {"blocks":[{"type":"paragraph","text":"Example content."}]}. Never use a "content" field for paragraph text.`
        : system,
      tools: [],
      responseFormat: jsonMode ? 'json_object' : undefined,
      thinking: 'disabled',
    },
    {
      text,
      signal,
      activity,
      context,
    },
  )
  if (result.budgetExhausted) {
    throw new Error('Task budget exhausted before document generation could complete.')
  }
  return result.text
}

export class DocumentWorker {
  constructor(private readonly deps: DocumentWorkerDeps) {}

  async run(node: TaskNode, ctx: DocumentRunContext): Promise<DocumentRunResult> {
    const scopedContext: DocumentRunContext = {
      ...ctx,
      loopConfig: {
        ...this.deps.baseConfig,
        budgetController: ctx.budgetController,
        telemetryContext: { ...this.deps.baseConfig.telemetryContext, taskId: ctx.taskId, nodeId: node.id, workerType: 'document' },
      },
      modelContext: {
        ...ctx.modelContext,
        task: {
          nodeId: node.id,
          title: node.title,
          objective: node.objective,
          status: node.status,
          dependencies: node.dependencies,
        },
      },
    }
    // Plan §13: targeted section regeneration — only the sections a failed
    // validation identified, spliced into the existing IR and checkpointed
    // revision-safely (user edits still win).
    if (node.documentId && node.regenerateSections && node.regenerateSections.length > 0) {
      return this.regenerate(node, scopedContext)
    }
    return this.generate(node, scopedContext)
  }

  private async generate(node: TaskNode, ctx: DocumentRunContext): Promise<DocumentRunResult> {
    const title = node.title.trim() || 'Untitled Document'
    const config = ctx.loopConfig ?? this.deps.baseConfig

    // Plan §14 restart recovery: a resumed document node continues its
    // existing document instead of creating a duplicate.
    if (node.documentId) {
      const loaded = await this.deps.gateway.loadIR(node.documentId)
      if (loaded) {
        return this.finishExisting(node, ctx, loaded.ir, loaded.revision, title)
      }
    }

    ctx.activity(`Creating document: ${title}`)
    const created = await this.deps.gateway.create(title, 'article')

    const declared: DocumentProgressState = {
      documentId: created.id,
      title,
      status: 'queued',
      completedSections: 0,
      totalSections: 0,
    }
    ctx.documentDeclared(declared)

    // 1. Outline (plan §12 'outlining' state).
    ctx.documentProgress({ ...declared, status: 'outlining' })
    let headings: string[]
    try {
      headings = await this.outlineHeadings(
        config,
        `Outline the "${title}" document for this repository. Respond with ONLY a JSON block: ` +
          '{"sections":[{"heading":"..."}]}. Use 4-10 focused sections relevant to the repository.\n\n' +
          `Established facts your outline must respect:\n${factsSummary(this.deps.findings, this.deps.facts)}`,
        ctx,
      )
    } catch (error) {
      ctx.documentProgress({
        ...declared,
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
      })
      throw error
    }

    const ir: DocumentIR = { title, sections: [] }
    try {
      return await this.writeSections(ctx, created.id, title, headings, ir, 0, 0)
    } catch (error) {
      ctx.documentProgress({
        documentId: created.id,
        title,
        status: 'failed',
        completedSections: ir.sections.filter(Boolean).length,
        totalSections: headings.length,
        error: error instanceof Error ? error.message : String(error),
      })
      throw error
    }
  }

  /**
   * Plan §14: finish a document that was interrupted mid-generation. Existing
   * sections are kept (their checkpoints are already on disk); only the
   * remaining outline is requested and generated.
   */
  private async finishExisting(
    node: TaskNode,
    ctx: DocumentRunContext,
    existing: DocumentIR,
    revision: number,
    title: string,
  ): Promise<DocumentRunResult> {
    const documentId = node.documentId!
    const ir: DocumentIR = JSON.parse(JSON.stringify(existing)) as DocumentIR
    const existingCount = ir.sections.length

    if (existingCount >= MAX_SECTIONS) {
      // The document was already complete when the crash happened.
      ctx.documentProgress({
        documentId,
        title,
        status: 'completed',
        completedSections: existingCount,
        totalSections: existingCount,
      })
      return {
        outputs: [sectionTextsPayload(documentId, title, ir.sections)],
        documentId,
        completedSections: existingCount,
        totalSections: existingCount,
      }
    }

    ctx.activity(`Resuming document: ${title} (${existingCount} section(s) already checkpointed)`)
    ctx.documentProgress({
      documentId,
      title,
      status: 'outlining',
      completedSections: existingCount,
      totalSections: existingCount,
    })
    const existingHeadings = ir.sections.map((s) => s.heading)
    const seen = new Set(existingHeadings.map((h) => h.trim().toLowerCase()))
    const remaining = (await this.outlineHeadings(
      ctx.loopConfig ?? this.deps.baseConfig,
      `Outline the REMAINING sections to complete the "${title}" document. ` +
        `These sections already exist: ${existingHeadings.join(', ')}. ` +
        `Respond with ONLY a JSON block: {"sections":[{"heading":"..."}]} — ` +
        `give 2-6 NEW headings (no duplicates), max ${MAX_SECTIONS - existingCount}.\n\n` +
        `Established facts your outline must respect:\n${factsSummary(this.deps.findings, this.deps.facts)}`,
      ctx,
    )).filter((h) => !seen.has(h.trim().toLowerCase()))
    const headings = [...existingHeadings, ...remaining].slice(0, MAX_SECTIONS)
    return this.writeSections(ctx, documentId, title, headings, ir, existingCount, revision)
  }

  /** Outline model pass → validated headings (throws on invalid output). */
  private async outlineHeadings(
    config: ToolLoopConfig,
    prompt: string,
    ctx: DocumentRunContext,
  ): Promise<string[]> {
    const outlineText = await modelJson(
      this.deps.provider,
      config,
      prompt,
      `You outline technical documents. Output ONLY valid JSON.`,
      ctx.signal,
      ctx.activity,
      ctx.modelContext,
    )
    const outlineRaw = extractJsonBlock(outlineText)
    const outline = outlineRaw === undefined ? undefined : outlineSchema.safeParse(outlineRaw)
    if (!outline?.success) {
      throw new Error('Document outline was invalid — cannot generate without sections.')
    }
    return outline.data.sections.slice(0, MAX_SECTIONS).map((s) => s.heading)
  }

  /**
   * Section-by-section generation with full-document checkpoints. `startIndex`
   * > 0 means resuming an existing document (plan §14) — earlier sections are
   * never regenerated or re-checkpointed.
   */
  private async writeSections(
    ctx: DocumentRunContext,
    documentId: string,
    title: string,
    headings: string[],
    ir: DocumentIR,
    startIndex: number,
    initialRevision: number,
  ): Promise<DocumentRunResult> {
    const config = ctx.loopConfig ?? this.deps.baseConfig
    let revision = initialRevision
    const total = headings.length

    ctx.documentProgress({
      documentId,
      title,
      status: 'generating',
      completedSections: startIndex,
      totalSections: total,
    })

    for (let i = startIndex; i < headings.length; i++) {
      if (ctx.signal.aborted) break
      const heading = headings[i]
      ctx.documentProgress({
        documentId,
        title,
        status: 'generating',
        completedSections: i,
        totalSections: total,
        activeSection: heading,
      })

      const sectionText = await modelJson(
        this.deps.provider,
        config,
        `Write section "${heading}" (${i + 1}/${total}) of the "${title}" document. ` +
          `Ground every factual statement in the established facts; clearly flag anything proposed. ` +
          `Respond with ONLY a JSON block: {"blocks":[...]} using block types: ` +
          `paragraph, bullets, numbered, table, callout, mermaid, risk, scope.\n\n` +
          `Established facts (your section MUST agree with these):\n${factsSummary(this.deps.findings, this.deps.facts)}`,
        `You write technical documentation sections. Output ONLY valid JSON.`,
        ctx.signal,
        ctx.activity,
        ctx.modelContext,
      )

      const parsedSection = await this.parseSection(sectionText, ctx, 'generate', i)
      const usedFallback = !parsedSection.blocks
      const blocks = parsedSection.blocks ?? this.invalidSectionFallback(ctx, parsedSection.outcome, 'generate', i)

      ir.sections[i] = { heading, blocks }
      const validated = documentIrSchema.parse(ir)

      ctx.activity(`Checkpointing ${title}: section ${i + 1}/${total}`)
      const result = await this.deps.gateway.checkpoint(documentId, revision, validated)
      if (!result.ok) {
        throw new Error(result.error ?? 'Document checkpoint failed.')
      }
      if (result.conflict) {
        ctx.documentCheckpoint({
          documentId,
          title,
          sectionTitle: heading,
          completedSections: i,
          totalSections: total,
          conflict: true,
          pendingDraftId: result.pendingDraftId,
        })
        ctx.documentProgress({
          documentId,
          title,
          status: 'failed',
          completedSections: i,
          totalSections: total,
          error: 'You edited this document during generation — the agent draft was parked instead of overwriting.',
        })
        return {
          outputs: [],
          documentId,
          completedSections: i,
          totalSections: total,
          conflict: true,
          pendingDraftId: result.pendingDraftId,
        }
      }
      revision = result.revision
      this.deps.onCheckpoint?.(documentId, validated)
      if (usedFallback) this.documentDiagnostic(ctx, {
        documentEvent: 'section_fallback_checkpointed',
        documentOperation: 'generate',
        sectionIndex: i,
        attempt: 2,
        checkpointPending: false,
      })
      ctx.documentCheckpoint({
        documentId,
        title,
        sectionTitle: heading,
        completedSections: i + 1,
        totalSections: total,
      })
    }

    if (ctx.signal.aborted) {
      ctx.documentProgress({
        documentId,
        title,
        status: 'failed',
        completedSections: ir.sections.length,
        totalSections: total,
        error: 'Cancelled.',
      })
      return { outputs: [], documentId, completedSections: ir.sections.length, totalSections: total }
    }

    ctx.documentProgress({
      documentId,
      title,
      status: 'completed',
      completedSections: total,
      totalSections: total,
    })

    return {
      outputs: [sectionTextsPayload(documentId, title, ir.sections)],
      documentId,
      completedSections: total,
      totalSections: total,
    }
  }

  /**
   * Regenerate ONLY the sections a failed validation identified (plan §13):
   * load the stored IR, rewrite the affected sections, checkpoint the full
   * document revision-safely. Sections that passed validation are untouched.
   */
  private async regenerate(node: TaskNode, ctx: DocumentRunContext): Promise<DocumentRunResult> {
    const documentId = node.documentId!
    const targets = new Set((node.regenerateSections ?? []).map((s) => s.trim().toLowerCase()))
    const loaded = await this.deps.gateway.loadIR(documentId)
    if (!loaded) {
      throw new Error(`Cannot regenerate "${node.title}": no stored document IR to patch (${documentId}).`)
    }
    const ir = loaded.ir
    let revision = loaded.revision
    const title = ir.title || node.title
    const total = ir.sections.length

    ctx.activity(`Regenerating affected sections of ${title}`)
    ctx.documentProgress({
      documentId,
      title,
      status: 'generating',
      completedSections: 0,
      totalSections: total,
    })

    let fixed = 0
    for (let i = 0; i < ir.sections.length; i++) {
      if (ctx.signal.aborted) break
      const section = ir.sections[i]
      if (!targets.has(section.heading.trim().toLowerCase())) continue

      ctx.documentProgress({
        documentId,
        title,
        status: 'generating',
        completedSections: fixed,
        totalSections: total,
        activeSection: section.heading,
      })

      const sectionText = await modelJson(
        this.deps.provider,
        ctx.loopConfig ?? this.deps.baseConfig,
        `Rewrite ONLY the section "${section.heading}" of the "${title}" document. ` +
          `Validation feedback you must address: ${node.objective}\n` +
          `Ground every factual statement in the established facts; keep claims that were validated as supported. ` +
          `Respond with ONLY a JSON block: {"blocks":[...]} using block types: paragraph, bullets, numbered, table, callout, mermaid, risk, scope.\n\n` +
          `Established facts (your section MUST agree with these):\n${factsSummary(this.deps.findings, this.deps.facts)}`,
        `You fix technical documentation sections. Output ONLY valid JSON.`,
        ctx.signal,
        ctx.activity,
        ctx.modelContext,
      )

      const parsedSection = await this.parseSection(sectionText, ctx, 'regenerate', i)
      const usedFallback = !parsedSection.blocks
      const blocks = parsedSection.blocks ?? this.invalidSectionFallback(ctx, parsedSection.outcome, 'regenerate', i)
      ir.sections[i] = { heading: section.heading, blocks }
      const validated = documentIrSchema.parse(ir)

      ctx.activity(`Checkpointing ${title}: fixed section "${section.heading}"`)
      const result = await this.deps.gateway.checkpoint(documentId, revision, validated)
      if (!result.ok) {
        throw new Error(result.error ?? 'Document checkpoint failed.')
      }
      if (result.conflict) {
        ctx.documentCheckpoint({
          documentId,
          title,
          sectionTitle: section.heading,
          completedSections: fixed,
          totalSections: total,
          conflict: true,
          pendingDraftId: result.pendingDraftId,
        })
        ctx.documentProgress({
          documentId,
          title,
          status: 'failed',
          completedSections: fixed,
          totalSections: total,
          error: 'You edited this document during regeneration — the agent draft was parked instead of overwriting.',
        })
        return {
          outputs: [],
          documentId,
          completedSections: fixed,
          totalSections: total,
          conflict: true,
          pendingDraftId: result.pendingDraftId,
        }
      }
      revision = result.revision
      this.deps.onCheckpoint?.(documentId, validated)
      if (usedFallback) this.documentDiagnostic(ctx, {
        documentEvent: 'section_fallback_checkpointed',
        documentOperation: 'regenerate',
        sectionIndex: i,
        attempt: 2,
        checkpointPending: false,
      })
      fixed++
      ctx.documentCheckpoint({
        documentId,
        title,
        sectionTitle: section.heading,
        completedSections: fixed,
        totalSections: total,
      })
    }

    if (ctx.signal.aborted) {
      ctx.documentProgress({
        documentId,
        title,
        status: 'failed',
        completedSections: fixed,
        totalSections: total,
        error: 'Cancelled.',
      })
      return { outputs: [], documentId, completedSections: fixed, totalSections: total }
    }

    ctx.documentProgress({
      documentId,
      title,
      status: 'completed',
      completedSections: fixed,
      totalSections: total,
    })

    return {
      outputs: [sectionTextsPayload(documentId, title, ir.sections)],
      documentId,
      completedSections: fixed,
      totalSections: total,
    }
  }

  /** One retry on invalid JSON; null after the second failure. */
  private async parseSection(
    sectionText: string,
    ctx: DocumentRunContext,
    documentOperation: 'generate' | 'regenerate',
    sectionIndex: number,
  ): Promise<SectionParseResult> {
    const tryParse = (text: string, attempt: 1 | 2) => {
      const result = parseSectionText(text)
      this.documentDiagnostic(ctx, {
        documentEvent: 'section_parse_attempt',
        documentOperation,
        sectionIndex,
        attempt,
        parseOutcome: result.outcome,
        responseBytes: new TextEncoder().encode(text).length,
        jsonExtracted: result.jsonExtracted,
        blockCount: result.blocks?.length,
        schemaIssueCount: result.schemaIssueCount,
        schemaIssueCodes: result.schemaIssueCodes,
      })
      return result
    }
    const first = tryParse(sectionText, 1)
    if (first.blocks) return first

    ctx.activity('Retrying section — previous output was not valid JSON')
    const retryText = await modelJson(
      this.deps.provider,
      ctx.loopConfig ?? this.deps.baseConfig,
      'The previous structured response was unusable. Write the requested technical documentation section as concise Markdown now. Use plain paragraphs and Markdown lists; do not include a title or JSON.',
      'You write technical documentation sections. Output concise Markdown only.',
      ctx.signal,
      ctx.activity,
      ctx.modelContext,
      false,
    )
    return tryParse(retryText, 2)
  }

  /**
   * A bad section response must not discard an otherwise valid document.
   * This deliberately does not expose untrusted raw model output: it creates
   * a valid, editable Canvas callout that the user can complete in place.
   */
  private invalidSectionFallback(
    ctx: DocumentRunContext,
    fallbackReason: SectionParseOutcome,
    documentOperation: 'generate' | 'regenerate',
    sectionIndex: number,
  ): IRBlock[] {
    ctx.activity('Section structure could not be recovered; checkpointing an editable review notice')
    const diagnosticReason = fallbackReason === 'empty' || fallbackReason === 'malformed_json' || fallbackReason === 'schema_mismatch'
      ? fallbackReason
      : 'schema_mismatch'
    this.documentDiagnostic(ctx, {
      documentEvent: 'section_fallback',
      documentOperation,
      sectionIndex,
      attempt: 2,
      fallbackReason: diagnosticReason,
      checkpointPending: true,
    })
    return [
      {
        type: 'callout',
        variant: 'warn',
        title: 'Section needs review',
        text: 'The AI could not produce this section in the required editable document format after two attempts. Add or regenerate the section content here.',
      },
    ]
  }

  private documentDiagnostic(
    ctx: DocumentRunContext,
    event: Omit<TaskTelemetryEvent, 'kind' | 'taskId' | 'nodeId' | 'workerType'>,
  ): void {
    const config = ctx.loopConfig ?? this.deps.baseConfig
    config.telemetry?.({ kind: 'document', ...config.telemetryContext, workerType: 'document', ...event })
  }
}
