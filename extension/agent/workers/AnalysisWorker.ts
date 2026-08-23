import { z } from 'zod'
import type { TaskNode } from '../contracts/TaskGraph'
import type { Finding } from '../contracts/Finding'
import { EvidenceLedger } from '../knowledge/EvidenceLedger'
import { KnowledgeCommitService } from '../knowledge/KnowledgeCommitService'
import {
  runToolLoop,
  type ToolLoopConfig,
  type ToolLoopRunResult,
  type ToolExecutor,
} from '../model/toolLoopTaskRunner'
import { extractJsonBlock } from '../model/jsonBlock'
import type { ModelProvider } from '../model/ModelProvider'
import type { TaskBudgetController } from '../observability/TaskControls'

/**
 * Generic analysis worker runtime (plan §9). The role/objective/questions are
 * DYNAMIC — supplied by the node's WorkerSpec, never by a hard-coded
 * `SecurityAgent.ts` or `CloudMigrationAgent.ts`. One runtime, any expertise.
 *
 * Workers produce STRUCTURED output (findings, unknowns, contradictions,
 * coverage, follow-ups) committed through the shared knowledge service — they never
 * exchange free-form chat. Findings attach the evidence ids collected during
 * this run; an `observed` claim without a cited evidence id is downgraded to `inferred`
 * (invariant 3).
 */

export interface WorkerRunResult {
  /** Compact structured summaries handed to dependent nodes (not prose chat). */
  outputs: string[]
  /** Findings committed to the shared store this run. */
  findings: Finding[]
  /** Evidence ids collected during this run. */
  evidenceIds: string[]
  unknowns: string[]
  contradictions: string[]
  coverageAchieved: string[]
  /** Replan signals for the orchestrator (bounded by the graph store). */
  recommendedFollowups: string[]
  /** Open questions the worker could not answer (plan §13 replan signals). */
  newQuestions: string[]
  /** Coverage items the worker knows it did NOT achieve (plan §13). */
  missingCoverage: string[]
}

export interface WorkerRunContext {
  taskId?: string
  signal: AbortSignal
  activity: (activity: string) => void
  delta: (text: string) => void
  /** Structured outputs of completed dependency nodes (oldest first). */
  dependencyOutputs: string[]
  budgetController?: TaskBudgetController
}

export interface AnalysisWorkerDeps {
  provider: ModelProvider
  executor: ToolExecutor
  /** Shared loop config; the worker narrows tools per WorkerSpec.allowedTools. */
  baseConfig: ToolLoopConfig
  knowledge: KnowledgeCommitService
  evidence: EvidenceLedger
}

const modelFindingSchema = z.object({
  claim: z.string().min(1),
  type: z.enum(['observed', 'inferred', 'proposed', 'unknown']).default('inferred'),
  domain: z.string().optional(),
  confidence: z.enum(['high', 'medium', 'low']).default('medium'),
  fact_key: z.string().min(1).optional(),
  evidenceIds: z.array(z.string().min(1)).max(12).default([]),
})

const workerOutputSchema = z.object({
  findings: z.array(modelFindingSchema).default([]),
  unknowns: z.array(z.string()).default([]),
  contradictions: z.array(z.string()).default([]),
  coverage_achieved: z.array(z.string()).default([]),
  recommended_followups: z.array(z.string()).default([]),
  new_questions: z.array(z.string()).default([]),
  missing_coverage: z.array(z.string()).default([]),
})

type ParsedWorkerOutput = z.infer<typeof workerOutputSchema>

function roleSystemPrompt(node: TaskNode): string {
  const spec = node.roleSpec
  const questions =
    spec.questions.length > 0 ? spec.questions.map((q) => `- ${q}`).join('\n') : '- (no specific questions)'
  return (
    `You are ${spec.role} performing a read-only repository analysis.\n` +
    `Objective: ${spec.objective}\n\n` +
    `Answer these questions:\n${questions}\n\n` +
    `Rules:\n` +
    `- Every claim about current implementation behavior must be grounded in repository content you actually read.\n` +
    `- Distinguish observed facts from inference; use type "inferred"/"proposed" when you cannot prove a claim.\n` +
    `- Tool results label evidence as [EVIDENCE:<id>]. Every observed finding MUST cite only the exact evidence ids that support it.\n` +
    `- End your answer with ONE fenced JSON block:\n` +
    '```json\n' +
    '{"findings":[{"claim":"...","type":"observed|inferred|proposed|unknown","domain":"...","confidence":"high|medium|low","fact_key":"optional.semantic.key","evidenceIds":["evidence-id"]}],' +
    '"unknowns":["..."],"contradictions":["..."],"coverage_achieved":["..."],"recommended_followups":["..."],"new_questions":["..."],"missing_coverage":["..."]}\n' +
    '```'
  )
}

export class AnalysisWorker {
  constructor(private readonly deps: AnalysisWorkerDeps) {}

  /** Execute one graph node under its WorkerSpec. Never throws on parse failures. */
  async run(node: TaskNode, ctx: WorkerRunContext): Promise<WorkerRunResult> {
    const spec = node.roleSpec
    const allowed = new Set<string>(spec.allowedTools)
    const tools = (this.deps.baseConfig.tools ?? []).filter((t) => allowed.has(t.name))

    const dependencyContext =
      ctx.dependencyOutputs.length > 0
        ? `\n\nPrior analysis results (use these, do not re-derive them):\n${ctx.dependencyOutputs
            .map((o, i) => `--- ${i + 1} ---\n${o}`)
            .join('\n')}`
        : ''

    const loop = await runToolLoop(
      this.deps.provider,
      this.deps.executor,
      {
        ...this.deps.baseConfig,
        system: roleSystemPrompt(node),
        tools,
        maxModelCalls: node.budget.maxModelCalls,
        maxToolCalls: node.budget.maxToolCalls,
        maxInputTokens: node.budget.maxInputTokens,
        maxOutputTokens: node.budget.maxOutputTokens,
        budgetController: ctx.budgetController,
        telemetryContext: { ...this.deps.baseConfig.telemetryContext, taskId: ctx.taskId, nodeId: node.id, workerType: 'analysis' },
      },
      {
        text: `${spec.objective}${dependencyContext}`,
        signal: ctx.signal,
        activity: ctx.activity,
        delta: ctx.delta,
        context: {
          task: {
            nodeId: node.id,
            title: node.title,
            objective: spec.objective,
            status: node.status,
            dependencies: node.dependencies,
          },
        },
      },
    )

    const parsed = this.parse(loop.text)
    const committed = this.commit(node, loop, parsed)
    const summary = JSON.stringify({
      role: spec.role,
      findings: committed.map((f) => ({ claim: f.claim, type: f.type, confidence: f.confidence })),
      unknowns: parsed.unknowns,
      coverage: parsed.coverage_achieved,
    })

    return {
      outputs: [summary],
      findings: committed,
      evidenceIds: loop.evidenceIds,
      unknowns: parsed.unknowns,
      contradictions: parsed.contradictions,
      coverageAchieved: parsed.coverage_achieved,
      recommendedFollowups: parsed.recommended_followups,
      newQuestions: parsed.new_questions,
      missingCoverage: parsed.missing_coverage,
    }
  }

  private parse(text: string): ParsedWorkerOutput {
    const raw = extractJsonBlock(text)
    const result = raw === undefined ? undefined : workerOutputSchema.safeParse(raw)
    if (!result?.success) {
      return {
        findings: [],
        unknowns: [],
        contradictions: [],
        coverage_achieved: [],
        recommended_followups: [],
        new_questions: [],
        missing_coverage: [],
      }
    }
    return result.data
  }

  /**
   * Invariant 4: workers never mutate shared fact state directly — raw model
   * output is handed to the shared commit service, which normalizes findings,
   * enforces grounding, and promotes accepted facts consistently.
   */
  private commit(node: TaskNode, loop: ToolLoopRunResult, parsed: ParsedWorkerOutput): Finding[] {
    const repositoryVersion =
      loop.evidenceIds
        .map((id) => this.deps.evidence.get(id)?.repositoryVersion)
        .find((rv): rv is string => Boolean(rv)) ?? 'unknown'
    const domain = node.roleSpec.scope.domains?.[0] ?? node.title

    const observedIds = new Set(loop.evidenceIds)
    const inputs: Array<Omit<Finding, 'id'>> = parsed.findings.map((f) => {
      const citedEvidenceIds = [...new Set(f.evidenceIds.filter((id) => observedIds.has(id)))]
      const invalidEvidenceIds = f.evidenceIds.filter((id) => !observedIds.has(id))
      const type = f.type === 'observed' && citedEvidenceIds.length === 0 ? 'inferred' : f.type
      return {
        claim: f.claim,
        type,
        domain: f.domain ?? domain,
        factKey: f.fact_key,
        evidenceIds: type === 'observed' ? citedEvidenceIds : [],
        confidence: f.confidence,
        assumptions:
          type === 'inferred' && f.type === 'observed'
            ? [
                'Observed claim did not cite evidence read during this run.',
                ...invalidEvidenceIds.map((id) => `Ignored uncaptured evidence id: ${id}.`),
              ]
            : [],
        contradictions: [],
        repositoryVersion,
      }
    })

    for (const unknown of parsed.unknowns) {
      inputs.push({
        claim: unknown,
        type: 'unknown',
        domain,
        evidenceIds: [],
        confidence: 'low',
        assumptions: [],
        contradictions: [],
        repositoryVersion,
      })
    }

    return this.deps.knowledge.commit(inputs)
  }
}
