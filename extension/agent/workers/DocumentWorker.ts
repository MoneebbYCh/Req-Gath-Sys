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
import { sanitizeBlockList, sanitizePartsList } from '../../documents/blockSanitize'
import { normalizeMarkdown } from '../../documents/markdownNormalize'
import { createMermaidValidator } from '../../documents/mermaidValidate'
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
  /** Injectable mermaid syntax validator (defaults to the Node mermaid parser). */
  mermaidValidator?: (source: string) => Promise<{ ok: boolean; diagramType?: string; error?: string }>
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

/** Repair pass: corrected mermaid sources, one per failing diagram, in order. */
const mermaidRepairSchema = z.object({ diagrams: z.array(z.string().max(10_000)) })

/** Section payload: interleaved Markdown prose + typed custom widgets. */
const BLOCK_SCHEMA_HINT =
  '\n\nRespond with ONLY JSON: {"parts":[...]}.\n' +
  'Each part is EXACTLY one of:\n' +
  '- Markdown prose: {"md":"<CommonMark/GFM string>"}\n' +
  '  Use real Markdown for paragraphs, lists (-/*/1.), GFM tables, `inline code`,\n' +
  '  fenced code, and **bold** / *italic* / [links](url).\n' +
  '  Do NOT invent {"type":"paragraph"} or {"type":"bullets"} or {"type":"table"}.\n' +
  '  Do not include a section title (the heading is already known). Use ### for subsections only.\n' +
  '- Custom widgets (typed JSON only — Markdown cannot express these):\n' +
  '  - callout: {"type":"callout","text":"...","variant":"info|warn|success|error","title":"..."}\n' +
  '  - mermaid: {"type":"mermaid","diagram":"flowchart TD\\n  A --> B","title":"..."}\n' +
  '  - risk: {"type":"risk","rows":[{"risk":"...","likelihood":"H|M|L","impact":"H|M|L","mitigation":"..."}]}\n' +
  '  - scope: {"type":"scope","inScope":["..."],"outOfScope":["..."]}\n' +
  '  - kpiGrid: {"type":"kpiGrid","items":[{"metric":"...","target":"...","method":"..."}]}\n' +
  '  - stakeholderTable: {"type":"stakeholderTable","rows":[{"nameRole":"...","interest":"H|M|L","influence":"H|M|L","concern":"..."}]}\n' +
  'Rules: a mermaid "diagram" must be a single-line string using \\n escapes (never raw newlines). ' +
  'Start it with a supported diagram type: flowchart (or graph TD/LR), sequenceDiagram, classDiagram, ' +
  'stateDiagram-v2, erDiagram, gantt, pie, journey, mindmap, timeline, quadrantChart, or gitGraph. ' +
  'Quote any node/edge label containing { } < > | # ; or /. ' +
  'Prefer Markdown for ordinary prose/lists/tables. Use widgets only when the structure fits: ' +
  'a callout for caveats, a risk block for risks, a kpiGrid for measurable goals, ' +
  'a stakeholderTable for roles, and a mermaid block for architecture or flow diagrams.'

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
    // Preferred: interleaved {"parts":[{"md":"..."}, widget, ...]}
    const fromParts = sanitizePartsList(raw)
    if (fromParts) {
      return {
        blocks: fromParts.blocks,
        outcome: 'valid',
        jsonExtracted: true,
        ...(fromParts.coerced > 0 ? { schemaIssueCount: fromParts.coerced, schemaIssueCodes: ['sanitized'] } : {}),
      }
    }
    // Legacy {"blocks":[...]} still accepted for salvage / older fixtures
    const sanitized = sanitizeBlockList(raw)
    if (sanitized) {
      return {
        blocks: sanitized.blocks,
        outcome: 'valid',
        jsonExtracted: true,
        ...(sanitized.coerced > 0 ? { schemaIssueCount: sanitized.coerced, schemaIssueCodes: ['sanitized'] } : {}),
      }
    }
    const parsed = sectionSchema.safeParse(raw)
    if (parsed.success) return { blocks: parsed.data.blocks, outcome: 'valid', jsonExtracted: true }
    const salvaged = salvageBlocks(raw)
    if (salvaged) {
      return {
        blocks: salvaged,
        outcome: 'valid',
        jsonExtracted: true,
        schemaIssueCount: parsed.error.issues.length,
        schemaIssueCodes: [...new Set(parsed.error.issues.map((issue) => issue.code))].slice(0, 4),
      }
    }
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
  // Provider returned raw Markdown — store as one IR markdown block for remark at render.
  const source = normalizeMarkdown(text)
  if (!source) return { blocks: null, outcome: 'empty', jsonExtracted: false }
  return {
    blocks: [{ type: 'markdown', source: source.slice(0, 12_000) }],
    outcome: 'markdown',
    jsonExtracted: false,
  }
}

/**
 * Keep the blocks that validate; turn each invalid block into an editable warn
 * callout containing the raw model output (nothing is silently dropped). Returns
 * null when NO block was salvageable — the caller then retries.
 */
function salvageBlocks(raw: unknown): IRBlock[] | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const obj = raw as { blocks?: unknown; parts?: unknown }
  const entries = Array.isArray(obj.parts)
    ? obj.parts.map((part) => {
        if (part && typeof part === 'object' && !Array.isArray(part) && typeof (part as { md?: unknown }).md === 'string') {
          return { type: 'markdown', source: (part as { md: string }).md }
        }
        return part
      })
    : obj.blocks
  if (!Array.isArray(entries) || entries.length === 0) return null
  const salvaged: IRBlock[] = []
  let kept = 0
  for (const block of entries) {
    const parsed = irBlockSchema.safeParse(block)
    if (parsed.success) {
      salvaged.push(parsed.data)
      kept++
    } else {
      const text = typeof block === 'string' ? block : JSON.stringify(block)
      salvaged.push({
        type: 'callout',
        variant: 'warn',
        title: 'Unsupported content',
        text: (text ?? '').slice(0, 2_000) || 'Empty block.',
      })
    }
  }
  return kept > 0 ? salvaged : null
}

/** Deterministic block → plain-text serialization (for validation, plan §13). */
function blocksText(blocks: IRBlock[]): string {
  return blocks
    .map((b) => {
      switch (b.type) {
        case 'markdown':
          return b.source
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
        case 'kpiGrid':
          return b.items
            .map((i) => `KPI: ${i.metric}${i.target ? ` — target: ${i.target}` : ''}${i.method ? ` — method: ${i.method}` : ''}`)
            .join('\n')
        case 'stakeholderTable':
          return b.rows
            .map((r) => `${r.nameRole}${r.interest ? ` — interest: ${r.interest}` : ''}${r.influence ? ` — influence: ${r.influence}` : ''}${r.concern ? ` — concern: ${r.concern}` : ''}`)
            .join('\n')
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
        ? `${system}\nUse this exact JSON shape: {"parts":[{"md":"Example prose with a list:\\n\\n- Item one\\n- Item two"}]}. ` +
          `Prefer {"md":"..."} for prose; use typed widget objects only for callout/mermaid/risk/scope/kpiGrid/stakeholderTable.`
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
  private readonly mermaidValidator: (source: string) => Promise<{ ok: boolean; diagramType?: string; error?: string }>

  constructor(private readonly deps: DocumentWorkerDeps) {
    this.mermaidValidator = deps.mermaidValidator ?? createMermaidValidator()
  }

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
          `Respond with ONLY a JSON object: {"parts":[...]}.${BLOCK_SCHEMA_HINT}\n\n` +
          `Established facts (your section MUST agree with these):\n${factsSummary(this.deps.findings, this.deps.facts)}`,
        `You write technical documentation sections. Output ONLY valid JSON.`,
        ctx.signal,
        ctx.activity,
        ctx.modelContext,
      )

      const parsedSection = await this.parseSection(sectionText, ctx, 'generate', i)
      const usedFallback = !parsedSection.blocks
      const blocks = await this.ensureValidMermaid(
        ctx,
        parsedSection.blocks ?? this.invalidSectionFallback(ctx, parsedSection.outcome, 'generate', i),
        'generate',
        i,
      )

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
          `Respond with ONLY a JSON object: {"parts":[...]}.${BLOCK_SCHEMA_HINT}\n\n` +
          `Established facts (your section MUST agree with these):\n${factsSummary(this.deps.findings, this.deps.facts)}`,
        `You fix technical documentation sections. Output ONLY valid JSON.`,
        ctx.signal,
        ctx.activity,
        ctx.modelContext,
      )

      const parsedSection = await this.parseSection(sectionText, ctx, 'regenerate', i)
      const usedFallback = !parsedSection.blocks
      const blocks = await this.ensureValidMermaid(
        ctx,
        parsedSection.blocks ?? this.invalidSectionFallback(ctx, parsedSection.outcome, 'regenerate', i),
        'regenerate',
        i,
      )
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
      'The previous structured response was unusable. Return ONLY JSON in this shape: ' +
        '{"parts":[{"md":"<CommonMark/GFM for the section>"}]}. ' +
        'Use real Markdown lists and paragraphs inside md. Do not include a section title.',
      'You write technical documentation sections. Output ONLY valid JSON with a parts array.',
      ctx.signal,
      ctx.activity,
      ctx.modelContext,
      true,
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

  /**
   * Every model-emitted mermaid block is syntax-validated before checkpoint.
   * One bounded repair pass feeds the exact parse error back to the model;
   * diagrams that still fail are downgraded to an editable warn callout —
   * nothing is silently dropped (same philosophy as the section salvage).
   */
  private async ensureValidMermaid(
    ctx: DocumentRunContext,
    blocks: IRBlock[],
    documentOperation: 'generate' | 'regenerate',
    sectionIndex: number,
  ): Promise<IRBlock[]> {
    const failing: Array<{ index: number; diagram: string; error?: string }> = []
    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i]
      if (block.type !== 'mermaid') continue
      const result = await this.mermaidValidator(block.diagram)
      this.documentDiagnostic(ctx, {
        documentEvent: 'mermaid_parse_attempt',
        documentOperation,
        sectionIndex,
        ok: result.ok,
      })
      if (!result.ok) failing.push({ index: i, diagram: block.diagram, error: result.error })
    }
    if (failing.length === 0) return blocks

    ctx.activity('Fixing invalid Mermaid diagram syntax')
    const repairs = await this.repairMermaid(ctx, failing)
    const out = [...blocks]
    for (const entry of failing) {
      const candidate = repairs?.get(entry.index) ?? entry.diagram
      const check = await this.mermaidValidator(candidate)
      this.documentDiagnostic(ctx, {
        documentEvent: 'mermaid_parse_attempt',
        documentOperation,
        sectionIndex,
        ok: check.ok,
      })
      if (check.ok) {
        const block = out[entry.index]
        if (block.type === 'mermaid') out[entry.index] = { ...block, diagram: candidate }
      } else {
        this.documentDiagnostic(ctx, {
          documentEvent: 'mermaid_fallback',
          documentOperation,
          sectionIndex,
          ok: false,
        })
        out[entry.index] = {
          type: 'callout',
          variant: 'warn',
          title: 'Diagram needs review',
          text: entry.diagram.slice(0, 2_000),
        }
      }
    }
    return out
  }

  /** One model pass that returns corrected diagrams 1:1 with the failures. */
  private async repairMermaid(
    ctx: DocumentRunContext,
    failing: Array<{ index: number; diagram: string; error?: string }>,
  ): Promise<Map<number, string> | null> {
    try {
      const prompt =
        'Some Mermaid diagrams in the document are syntactically invalid. Return ONLY a JSON object ' +
        '{"diagrams":["...","..."]} with the corrected source for each diagram, in the same order. ' +
        'Use \\n escapes inside each diagram string. No fences, no other text.\n\n' +
        failing
          .map((f, i) => `Diagram ${i + 1} (error: ${f.error ?? 'invalid syntax'}):\n${f.diagram}`)
          .join('\n\n')
      const text = await modelJson(
        this.deps.provider,
        ctx.loopConfig ?? this.deps.baseConfig,
        prompt,
        'You fix Mermaid diagram syntax. Output ONLY valid JSON.',
        ctx.signal,
        ctx.activity,
        ctx.modelContext,
      )
      const raw = extractJsonBlock(text)
      const parsed = raw === undefined ? undefined : mermaidRepairSchema.safeParse(raw)
      if (!parsed?.success) return null
      const map = new Map<number, string>()
      failing.forEach((f, i) => {
        const fixed = parsed.data.diagrams[i]
        if (fixed) map.set(f.index, fixed)
      })
      return map.size > 0 ? map : null
    } catch {
      // Budget exhaustion or a provider failure must not kill the section —
      // the invalid diagrams fall back to editable callouts below.
      return null
    }
  }

  private documentDiagnostic(
    ctx: DocumentRunContext,
    event: Omit<TaskTelemetryEvent, 'kind' | 'taskId' | 'nodeId' | 'workerType'>,
  ): void {
    const config = ctx.loopConfig ?? this.deps.baseConfig
    config.telemetry?.({ kind: 'document', ...config.telemetryContext, workerType: 'document', ...event })
  }
}
