import type { TaskNode } from '../contracts/TaskGraph'
import type { TaskBudget } from '../contracts/TaskBudget'
import type { WorkerSpec } from '../contracts/WorkerSpec'
import type { RegenerateSectionSignal } from '../contracts/Validation'
import { PLAYBOOKS, type Playbook } from './playbooks'
import { z } from 'zod'
import type { ModelProvider } from '../model/ModelProvider'
import { DOCUMENT_REQUEST } from './DocumentIntent'

export type { RegenerateSectionSignal, ReplanSignal } from '../contracts/Validation'

/**
 * Deterministic planner (plan §8/§9): turns a complex request into an initial
 * task graph using reusable playbooks — coverage guidance, not executable
 * agent classes (those are the Phase 9 worker runtime's business). The graph
 * is immutable until a worker reports missing coverage; the orchestrator
 * replans through TaskGraphStore with a bounded budget.
 */

const ANALYSIS_NODE_BUDGET: TaskBudget = {
  maxModelCalls: 6,
  maxToolCalls: 20,
  maxInputTokens: 60_000,
  maxOutputTokens: 8_000,
  maxParallelWorkers: 1,
  maxReplans: 2,
}

// A document uses one outline call, then one call per section (up to twelve),
// with bounded JSON recovery. Its resource contract must reflect that work.
const DOCUMENT_NODE_BUDGET: TaskBudget = {
  maxModelCalls: 25,
  maxToolCalls: 0,
  maxInputTokens: 120_000,
  maxOutputTokens: 32_000,
  maxParallelWorkers: 1,
  maxReplans: 2,
}

/** Playbook: domain keywords → coverage areas (one analysis node each). */
const GENERIC_AREAS = ['Repository structure and entry points', 'Core domains and responsibilities', 'Key dependencies and integration points']

/**
 * Explicit document work, including follow-ups such as "I need all three
 * docs". A bare request for the documents must not be downgraded to an
 * analysis-only chat answer merely because it omits "create" or "write".
 */
export const DOC_REQUEST = DOCUMENT_REQUEST

export const MULTI_DOC_COUNT =
  /\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:[\w-]+\s+){0,2}(documents?|docs)\b/i

const WORD_COUNTS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
}

/** Canonical document set for "generate N documents" without explicit titles. */
export const DEFAULT_DOCUMENTS = [
  'Product Requirements (PRD)',
  'System Architecture',
  'Security Architecture',
  'API Design',
  'Data Model',
  'Testing Strategy',
  'Deployment Guide',
  'User Guide',
  'Technical Debt Assessment',
  'Migration Plan',
]

/** Playbook domain → document title for single "create an X document" requests. */
const DOMAIN_DOCUMENTS: Record<string, string> = {
  security: 'Security Architecture',
  architecture: 'System Architecture',
  scalability: 'Scalability Strategy',
  'technical-debt': 'Technical Debt Assessment',
  migration: 'Migration Plan',
}

function workerSpecFor(title: string, objective: string, id: string): WorkerSpec {
  return {
    id: `ws-${id}`,
    workerType: 'analysis',
    role: title,
    objective,
    scope: { roots: ['*'] },
    questions: [objective],
    requiredCoverage: [],
    allowedTools: [
      'list_files',
      'search_files',
      'search_code',
      'read_file',
      'read_file_range',
      'get_project_structure',
      'get_package_info',
      'find_symbol',
      'find_definition',
      'find_references',
      'get_imports',
      'get_dependencies',
      'get_dependents',
    ],
    inputFindingIds: [],
    outputSchema: 'findings',
    budget: ANALYSIS_NODE_BUDGET,
  }
}

export interface PlannerOptions {
  maxNodes?: number
  /** First coverage area per matched playbook gets its own node; extras fold in. */
  maxAreasPerDomain?: number
  /** Playbook registry override (defaults to the built-in set). */
  playbooks?: Playbook[]
  /** Optional structured planning model. Deterministic planning remains the safe fallback. */
  modelProvider?: ModelProvider
  model?: string
}

const planningResultSchema = z.object({
  analysis: z.array(z.object({
    title: z.string().min(1).max(160),
    objective: z.string().min(1).max(800),
    domain: z.string().min(1).max(80).default('general'),
    questions: z.array(z.string().min(1).max(400)).max(8).default([]),
    requiredCoverage: z.array(z.string().min(1).max(200)).max(8).default([]),
  })).max(12).default([]),
  deliverables: z.array(z.object({
    title: z.string().min(1).max(160),
    objective: z.string().min(1).max(800),
    requiredCoverage: z.array(z.string().min(1).max(200)).max(8).default([]),
  })).max(10).default([]),
})

type PlanningResult = z.infer<typeof planningResultSchema>

export class Planner {
  private readonly maxNodes: number
  private readonly maxAreasPerDomain: number
  private readonly playbooks: Playbook[]
  private readonly modelProvider?: ModelProvider
  private readonly model: string

  constructor(options: PlannerOptions = {}) {
    this.maxNodes = options.maxNodes ?? 12
    this.maxAreasPerDomain = options.maxAreasPerDomain ?? 5
    this.playbooks = options.playbooks ?? PLAYBOOKS
    this.modelProvider = options.modelProvider
    this.model = options.model ?? 'default'
  }

  /**
   * Plans with a bounded structured model pass when available. The result is
   * schema-validated and converted through the same deterministic constructors
   * as fallback plans; any failure falls back without failing the user task.
   */
  async planAsync(text: string, signal = new AbortController().signal): Promise<TaskNode[]> {
    const structured = await this.requestStructuredPlan(text, signal)
    if (structured) {
      const plan = this.fromStructuredPlan(structured)
      // A model may return analysis only, or consume the graph budget with
      // analysis nodes. Either result would synthesize prose in chat but never
      // invoke DocumentWorker despite an explicit document request.
      if (!DOC_REQUEST.test(text) || plan.some((node) => node.roleSpec.workerType === 'document')) {
        return plan
      }
      return this.planDocuments(text)
    }
    return this.plan(text)
  }

  /** Initial graph for a complex request — validated acyclic by construction (no dependencies yet). */
  plan(text: string): TaskNode[] {
    if (DOC_REQUEST.test(text)) return this.planDocuments(text)

    const matched = this.playbooks.filter((p) => p.keywords.test(text)).map((p) => p.domain)

    const nodes: TaskNode[] = []
    const usedAreas = new Set<string>()

    for (const domain of matched) {
      const playbook = this.playbooks.find((p) => p.domain === domain)!
      for (const area of playbook.areas.slice(0, this.maxAreasPerDomain)) {
        const key = `${domain}:${area}`
        if (usedAreas.has(key) || nodes.length >= this.maxNodes) continue
        usedAreas.add(key)
        nodes.push(this.node(domain, area))
      }
    }

    // No playbook matched → generic multi-part analysis (e.g. "review everything").
    if (nodes.length === 0) {
      for (const area of GENERIC_AREAS.slice(0, this.maxAreasPerDomain)) {
        if (nodes.length >= this.maxNodes) break
        nodes.push(this.node('general', area))
      }
    }

    return nodes
  }

  private async requestStructuredPlan(text: string, signal: AbortSignal): Promise<PlanningResult | undefined> {
    if (!this.modelProvider) return undefined
    try {
      let content = ''
      for await (const event of this.modelProvider.stream({
        model: this.model,
        system: 'You design a bounded read-only repository-analysis plan. Return only one JSON object. Do not call tools.',
        messages: [{ role: 'user', content: plannerPrompt(text) }],
        tools: [],
        temperature: 0,
        maxOutputTokens: 1800,
        thinking: 'disabled',
      }, signal)) {
        if (event.type === 'text_delta') content += event.text
      }
      const parsed = safeJson(content)
      const result = parsed === undefined ? undefined : planningResultSchema.safeParse(parsed)
      return result?.success ? result.data : undefined
    } catch {
      return undefined
    }
  }

  private fromStructuredPlan(plan: PlanningResult): TaskNode[] {
    const analysis = plan.analysis.slice(0, this.maxNodes).map((item) =>
      this.dynamicNode(item.domain, item.title, item.objective, item.questions, item.requiredCoverage),
    )
    if (plan.deliverables.length === 0) return analysis.length > 0 ? analysis : this.plan('analyze repository')
    const room = this.maxNodes - analysis.length
    const maxDocuments = Math.max(0, Math.floor((room - (plan.deliverables.length > 1 ? 1 : 0)) / 2))
    const documents = plan.deliverables.slice(0, maxDocuments).map((item) => {
      const node = this.documentNode(item.title, analysis.map((a) => a.id))
      return { ...node, objective: item.objective, requiredCoverage: item.requiredCoverage, roleSpec: { ...node.roleSpec, objective: item.objective, requiredCoverage: item.requiredCoverage } }
    })
    const validations = documents.map((document) => this.validationNode(document.id, document.title))
    const cross = documents.length > 1 ? [this.crossDocumentNode(validations.map((node) => node.id))] : []
    return [...analysis, ...documents, ...validations, ...cross]
  }

  /**
   * Document-mode plan (plan §12 + §13): shared analysis nodes first, then
   * document nodes that DEPEND on all of them — parallelize document
   * production, never repository truth. Each document node is followed by a
   * validation node (plan §13); multi-document sets get one cross-document
   * consistency node depending on all validations.
   */
  private planDocuments(text: string): TaskNode[] {
    const countMatch = text.match(MULTI_DOC_COUNT)
    const rawCount = countMatch ? countMatch[1].toLowerCase() : ''
    const count = countMatch
      ? Math.max(1, Math.min(10, WORD_COUNTS[rawCount] ?? (Number(rawCount) || 1)))
      : 1

    // Reserve graph capacity before planning analysis. Otherwise a request
    // that matches several domains can consume the node cap and silently
    // eliminate the document and validation nodes it explicitly requested.
    const reservedDeliverableNodes = count * 2 + (count > 1 ? 1 : 0)
    const analysis = this
      .plan(text.replace(DOC_REQUEST, 'analyze the repository'))
      .slice(0, Math.max(0, this.maxNodes - reservedDeliverableNodes))

    const titles: string[] = []
    if (countMatch) {
      titles.push(...DEFAULT_DOCUMENTS.slice(0, count))
    } else {
      const matched = this.playbooks.filter((playbook) => playbook.keywords.test(text))
      const domain = matched.find((playbook) => playbook.domain !== 'architecture')?.domain
        ?? matched[0]?.domain
      titles.push(DOMAIN_DOCUMENTS[domain ?? ''] ?? 'Project Overview')
    }

    const analysisIds = analysis.map((n) => n.id)
    // Each document costs a doc node + a validation node; multi-doc adds one
    // cross-document node. Never exceed the planner's own node cap.
    const room = this.maxNodes - analysis.length
    const crossDocumentCost = titles.length > 1 ? 1 : 0
    const maxDocs = Math.max(0, Math.floor((room - crossDocumentCost) / 2))
    const documentNodes = titles.slice(0, Math.max(0, maxDocs)).map((title) =>
      this.documentNode(title, analysisIds),
    )

    const validationNodes = documentNodes.map((d) => this.validationNode(d.id, d.title))
    const crossNode = documentNodes.length > 1
      ? [this.crossDocumentNode(validationNodes.map((v) => v.id))]
      : []

    return [...analysis, ...documentNodes, ...validationNodes, ...crossNode]
  }

  /** One validation node per document — grounded in evidence, not prose. */
  private validationNode(documentNodeId: string, title: string): TaskNode {
    const id = `node-validate-${slug(title)}`
    return {
      id,
      title: `Validate ${title}`,
      objective: `Validate the repository claims in "${title}" against evidence and the shared fact base.`,
      dependencies: [documentNodeId],
      roleSpec: {
        id: `ws-${id}`,
        workerType: 'validation',
        validationKind: 'document',
        role: 'Document Claim Validator',
        objective: `Validate "${title}".`,
        scope: { roots: ['*'] },
        questions: [],
        requiredCoverage: [],
        // Validation may re-read evidence (plan §13: bounded retrieval only).
        allowedTools: ['search_code', 'read_file', 'read_file_range', 'list_files'],
        inputFindingIds: [],
        outputSchema: 'validation',
        budget: ANALYSIS_NODE_BUDGET,
      },
      requiredCoverage: [],
      requiredEvidence: [],
      status: 'queued',
      attempts: 0,
      budget: ANALYSIS_NODE_BUDGET,
      outputs: [],
    }
  }

  /** Cross-document consistency node — depends on every document validation. */
  private crossDocumentNode(dependencies: string[]): TaskNode {
    const id = 'node-cross-doc-consistency'
    return {
      id,
      title: 'Check cross-document consistency',
      objective: 'Compare claims across the generated document set and resolve contradictions against the shared fact base.',
      dependencies,
      roleSpec: {
        id: `ws-${id}`,
        workerType: 'validation',
        validationKind: 'cross-document',
        role: 'Cross-Document Consistency Validator',
        objective: 'Compare the generated documents for contradictory claims.',
        scope: { roots: ['*'] },
        questions: [],
        requiredCoverage: [],
        allowedTools: [],
        inputFindingIds: [],
        outputSchema: 'validation',
        budget: ANALYSIS_NODE_BUDGET,
      },
      requiredCoverage: [],
      requiredEvidence: [],
      status: 'queued',
      attempts: 0,
      budget: ANALYSIS_NODE_BUDGET,
      outputs: [],
    }
  }

  /**
   * Targeted section-regeneration nodes (plan §13 acceptance): a failed
   * validation regenerates ONLY the affected sections of a document, never the
   * whole document. Depends on the validating node that reported the failure.
   */
  planRegenerations(signals: RegenerateSectionSignal[]): TaskNode[] {
    const byDoc = new Map<string, { title: string; sections: string[]; notes: string[]; dependencies: string[] }>()
    for (const s of signals) {
      const group = byDoc.get(s.documentId) ?? { title: s.title, sections: [], notes: [], dependencies: s.dependencies }
      group.title = group.title || s.title
      if (!group.sections.some((h) => h.toLowerCase() === s.sectionHeading.toLowerCase())) {
        group.sections.push(s.sectionHeading)
      }
      if (s.note && !group.notes.includes(s.note)) group.notes.push(s.note)
      byDoc.set(s.documentId, group)
    }

    const nodes: TaskNode[] = []
    for (const [documentId, g] of byDoc) {
      const title = g.title || 'Document'
      const id = `node-regen-${slug(title)}`
      const fixList = g.sections.join(', ')
      const objective =
        `Regenerate ONLY these sections of "${title}" — ${fixList}. ` +
        `Validation feedback: ${g.notes.join(' | ')}`
      nodes.push({
        id,
        title: `Fix ${g.sections.length} section(s) in ${title}`,
        objective,
        dependencies: g.dependencies,
        documentId,
        regenerateSections: g.sections,
        roleSpec: {
          id: `ws-${id}`,
          workerType: 'document',
          role: `${title} Author`,
          objective,
          scope: { roots: ['*'] },
          questions: [],
          requiredCoverage: [],
          // Regeneration consumes the fact base, not the repository.
          allowedTools: [],
          inputFindingIds: [],
          outputSchema: 'document-section',
          budget: DOCUMENT_NODE_BUDGET,
        },
        requiredCoverage: [],
        requiredEvidence: [],
        status: 'queued',
        attempts: 0,
        budget: DOCUMENT_NODE_BUDGET,
        outputs: [],
      })
    }
    return nodes
  }

  private documentNode(title: string, dependencies: string[]): TaskNode {
    const id = `node-doc-${slug(title)}`
    return {
      id,
      title,
      objective: `Write the ${title} document for this repository, grounded in the shared project facts.`,
      dependencies,
      roleSpec: {
        id: `ws-${id}`,
        workerType: 'document',
        role: `${title} Author`,
        objective: `Write the ${title} document.`,
        scope: { roots: ['*'] },
        questions: [],
        requiredCoverage: [],
        // Document workers consume the fact base — no repository tools.
        allowedTools: [],
        inputFindingIds: [],
        outputSchema: 'document-section',
        budget: DOCUMENT_NODE_BUDGET,
      },
      requiredCoverage: [],
      requiredEvidence: [],
      status: 'queued',
      attempts: 0,
      budget: DOCUMENT_NODE_BUDGET,
      outputs: [],
    }
  }

  /**
   * Follow-up nodes from a worker's structured replan signals (plan §8/§9:
   * `recommended_followups` / `missing_coverage`). The graph store bounds the
   * replan budget and dedupes against existing objectives.
   */
  planFollowups(followups: string[], domain: string): TaskNode[] {
    const nodes: TaskNode[] = []
    for (const title of followups.slice(0, this.maxNodes)) {
      nodes.push(this.node(domain || 'followup', title.trim()))
    }
    return nodes
  }

  private node(domain: string, area: string): TaskNode {
    const id = `node-${domain}-${slug(area)}`
    return {
      id,
      title: area,
      objective: `Analyze ${area.toLowerCase()} of the repository and report evidence-backed findings.`,
      dependencies: [],
      roleSpec: workerSpecFor(area, `Analyze ${area.toLowerCase()}.`, id),
      requiredCoverage: [area],
      requiredEvidence: [],
      status: 'queued',
      attempts: 0,
      budget: ANALYSIS_NODE_BUDGET,
      outputs: [],
    }
  }

  private dynamicNode(domain: string, title: string, objective: string, questions: string[], coverage: string[]): TaskNode {
    const id = `node-${slug(domain)}-${slug(title)}`
    const roleSpec = workerSpecFor(title, objective, id)
    return {
      id,
      title,
      objective,
      dependencies: [],
      roleSpec: { ...roleSpec, questions: questions.length > 0 ? questions : [objective], requiredCoverage: coverage },
      requiredCoverage: coverage,
      requiredEvidence: [],
      status: 'queued',
      attempts: 0,
      budget: ANALYSIS_NODE_BUDGET,
      outputs: [],
    }
  }
}

function plannerPrompt(text: string): string {
  return `Request: ${text}\n\nReturn JSON only: {"analysis":[{"title":"...","objective":"...","domain":"...","questions":["..."],"requiredCoverage":["..."]}],"deliverables":[{"title":"...","objective":"...","requiredCoverage":["..."]}]}. Create only analysis for analysis requests. For document requests, define shared analysis plus the requested deliverables. Do not invent domain-specific agent types.`
}

function safeJson(text: string): unknown | undefined {
  const fenced = text.match(/```json\s*([\s\S]*?)```/i)?.[1] ?? text
  try { return JSON.parse(fenced.trim()) } catch { return undefined }
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40)
}
