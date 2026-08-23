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
import type { WorkerRunResult, WorkerRunContext } from './AnalysisWorker'

/**
 * Repository explorer runtime (plan §9): the generic bounded tool loop dressed
 * with a survey role. Same deps shape as AnalysisWorker — one runtime, any
 * `workerType: 'repository'` WorkerSpec. Produces a structured JSON summary
 * {overview, structure_highlights, package_manifest, unknowns}; observed
 * structure facts are committed through the finding store with the evidence
 * ids explicitly cited from this run (invariant 4 — never direct shared-state mutation).
 */

export interface RepositoryExplorerWorkerDeps {
  provider: ModelProvider
  executor: ToolExecutor
  /** Shared loop config; the worker narrows tools per WorkerSpec.allowedTools. */
  baseConfig: ToolLoopConfig
  knowledge: KnowledgeCommitService
  evidence: EvidenceLedger
}

const citedObservationSchema = z.object({
  claim: z.string().min(1),
  evidenceIds: z.array(z.string().min(1)).max(12).default([]),
  fact_key: z.string().min(1).optional(),
})

const explorerOutputSchema = z.object({
  overview: z.string().default(''),
  structure_highlights: z.array(citedObservationSchema).default([]),
  package_manifest: z.array(citedObservationSchema).default([]),
  unknowns: z.array(z.string()).default([]),
})

type ParsedExplorerOutput = z.infer<typeof explorerOutputSchema>

function explorerSystemPrompt(node: TaskNode): string {
  const spec = node.roleSpec
  const questions =
    spec.questions.length > 0 ? spec.questions.map((q) => `- ${q}`).join('\n') : '- (no specific questions)'
  return (
    `You are a repository exploration specialist performing a read-only survey of the codebase.\n` +
    `Objective: ${spec.objective}\n\n` +
    `Investigate these questions:\n${questions}\n\n` +
    `Rules:\n` +
    `- Only claim structure facts you actually read from the repository.\n` +
    `- Tool results label evidence as [EVIDENCE:<id>]. Cite the exact evidence ids for every observation.\n` +
    `- Note anything you could not verify under "unknowns" instead of guessing.\n` +
    `- End your answer with ONE fenced JSON block:\n` +
    '```json\n' +
    '{"overview":"one paragraph summary","structure_highlights":[{"claim":"...","evidenceIds":["evidence-id"]}],' +
    '"package_manifest":[{"claim":"package-name@version","evidenceIds":["evidence-id"]}],"unknowns":["..."]}\n' +
    '```'
  )
}

export class RepositoryExplorerWorker {
  constructor(private readonly deps: RepositoryExplorerWorkerDeps) {}

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
        budgetController: ctx.budgetController,
        telemetryContext: { ...this.deps.baseConfig.telemetryContext, taskId: ctx.taskId, nodeId: node.id, workerType: 'repository' },
        system: explorerSystemPrompt(node),
        tools,
        maxModelCalls: node.budget.maxModelCalls,
        maxToolCalls: node.budget.maxToolCalls,
        maxInputTokens: node.budget.maxInputTokens,
        maxOutputTokens: node.budget.maxOutputTokens,
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
      overview: parsed.overview,
      structure_highlights: parsed.structure_highlights,
      package_manifest: parsed.package_manifest,
      unknowns: parsed.unknowns,
    })

    return {
      outputs: [summary],
      findings: committed,
      evidenceIds: loop.evidenceIds,
      unknowns: parsed.unknowns,
      contradictions: [],
      coverageAchieved: [],
      recommendedFollowups: [],
      newQuestions: [],
      missingCoverage: [],
    }
  }

  private parse(text: string): ParsedExplorerOutput {
    const raw = extractJsonBlock(text)
    const result = raw === undefined ? undefined : explorerOutputSchema.safeParse(raw)
    if (!result?.success) {
      return { overview: '', structure_highlights: [], package_manifest: [], unknowns: [] }
    }
    return result.data
  }

  /**
   * Invariant 4: workers hand raw observations to the shared commit service.
   * Citations are accepted only when this run actually recorded the evidence.
   */
  private commit(node: TaskNode, loop: ToolLoopRunResult, parsed: ParsedExplorerOutput): Finding[] {
    const repositoryVersion =
      loop.evidenceIds
        .map((id) => this.deps.evidence.get(id)?.repositoryVersion)
        .find((rv): rv is string => Boolean(rv)) ?? 'unknown'
    const domain = node.roleSpec.scope.domains?.[0] ?? node.title
    const observedIds = new Set(loop.evidenceIds)
    const observationInput = (observation: z.infer<typeof citedObservationSchema>, observationDomain: string) => {
      const evidenceIds = [...new Set(observation.evidenceIds.filter((id) => observedIds.has(id)))]
      const isObserved = evidenceIds.length > 0
      return {
        claim: observation.claim,
        type: isObserved ? ('observed' as const) : ('inferred' as const),
        domain: observationDomain,
        factKey: observation.fact_key,
        evidenceIds,
        confidence: isObserved ? ('high' as const) : ('medium' as const),
        assumptions: isObserved ? [] : ['Observation did not cite evidence read during this run.'],
        contradictions: [],
        repositoryVersion,
      }
    }

    const inputs: Array<Omit<Finding, 'id'>> = []
    for (const fact of parsed.structure_highlights) inputs.push(observationInput(fact, domain))
    for (const dependency of parsed.package_manifest) inputs.push(observationInput(dependency, 'dependencies'))
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
