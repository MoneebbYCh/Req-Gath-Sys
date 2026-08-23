import { describe, expect, it } from 'vitest'
import { AnalysisWorker } from './AnalysisWorker'
import { FindingStore } from '../knowledge/FindingStore'
import { KnowledgeCommitService } from '../knowledge/KnowledgeCommitService'
import { ProjectFactBase } from '../knowledge/ProjectFactBase'
import { EvidenceLedger } from '../knowledge/EvidenceLedger'
import type { TaskNode } from '../contracts/TaskGraph'
import type { EvidenceCandidate } from '../contracts/Evidence'
import type { ModelProvider } from '../model/ModelProvider'
import type { ModelRequest, ModelToolDefinition } from '../model/ModelTypes'
import type { ToolExecutor } from '../model/toolLoopTaskRunner'

function node(overrides: Partial<TaskNode> = {}): TaskNode {
  return {
    id: 'n1',
    title: 'Authentication entry points',
    objective: 'Locate authentication enforcement',
    dependencies: [],
    roleSpec: {
      id: 'ws-1',
      workerType: 'analysis',
      role: 'Security Analyst',
      objective: 'Locate authentication enforcement',
      scope: { roots: ['*'], domains: ['security'] },
      questions: ['Where is auth enforced?'],
      requiredCoverage: [],
      allowedTools: ['search_code', 'read_file'],
      inputFindingIds: [],
      outputSchema: 'findings',
      budget: {
        maxModelCalls: 4,
        maxToolCalls: 10,
        maxInputTokens: 10_000,
        maxOutputTokens: 4_000,
        maxParallelWorkers: 1,
        maxReplans: 1,
      },
    },
    requiredCoverage: [],
    requiredEvidence: [],
    status: 'queued',
    attempts: 0,
    budget: {
      maxModelCalls: 4,
      maxToolCalls: 10,
      maxInputTokens: 10_000,
      maxOutputTokens: 4_000,
      maxParallelWorkers: 1,
      maxReplans: 1,
    },
    outputs: [],
    ...overrides,
  }
}

/** Scripted provider: asks for search_code once, then answers with the given text. */
function provider(answers: { text: string | ((request: ModelRequest) => string); onTools?: (tools: ModelToolDefinition[]) => void }): ModelProvider {
  return {
    async *stream(request: ModelRequest) {
      const hasToolResult = request.messages.some((m) => m.role === 'tool')
      if (!hasToolResult) {
        answers.onTools?.(request.tools)
        yield { type: 'tool_call_started', id: 'c1', name: 'search_code' }
        yield { type: 'tool_call_completed', id: 'c1', name: 'search_code', arguments: '{"pattern":"auth"}' }
        yield { type: 'finish', reason: 'tool_calls' }
        return
      }
      yield { type: 'text_delta', text: typeof answers.text === 'function' ? answers.text(request) : answers.text }
      yield { type: 'finish', reason: 'stop' }
    },
  }
}

/** Provider that never calls tools — answers directly. */
function directAnswerProvider(text: string): ModelProvider {
  return {
    async *stream() {
      yield { type: 'text_delta', text }
      yield { type: 'finish', reason: 'stop' }
    },
  }
}

function setup(overrides: { provider: ModelProvider; tools?: ModelToolDefinition[]; executor?: ToolExecutor }) {
  const evidence = new EvidenceLedger()
  const findings = new FindingStore()
  const facts = new ProjectFactBase()
  const executor: ToolExecutor =
    overrides.executor ??
    ({
      execute: async () => ({
        ok: true,
        result: {
          matches: [],
          repositoryVersion: 'rv-test',
          evidenceCandidates: [
            {
              path: 'src/auth.ts',
              startLine: 1,
              endLine: 2,
              excerpt: 'export function login()',
              kind: 'source' as const,
              sourceTool: 'read_file',
              contentHash: 'hash-1',
            },
          ],
        },
      }),
    } satisfies ToolExecutor)
  const baseConfig = {
    model: 'test',
    tools: overrides.tools ?? [
      { name: 'search_code', description: 'regex search', inputJsonSchema: {} },
      { name: 'read_file', description: 'read a file', inputJsonSchema: {} },
    ],
    recordEvidence: (candidates: EvidenceCandidate[], rv: string) =>
      candidates.map((c) => evidence.record(c, rv).id),
  }
  const worker = new AnalysisWorker({
    provider: overrides.provider,
    executor,
    baseConfig,
    knowledge: new KnowledgeCommitService(findings, facts),
    evidence,
  })
  const ctx = {
    signal: new AbortController().signal,
    activity: () => {},
    delta: () => {},
    dependencyOutputs: [] as string[],
  }
  return { worker, findings, facts, evidence, ctx }
}

const JSON_OUTPUT = {
  findings: [
    { claim: 'Authentication is enforced by JWT middleware', type: 'observed', domain: 'security', confidence: 'high' },
  ],
  unknowns: ['Where refresh tokens are rotated'],
  contradictions: [],
  coverage_achieved: ['Entry points identified'],
  recommended_followups: ['Check the password reset flow'],
}

describe('AnalysisWorker', () => {
  it('commits structured findings with evidence ids attached (plan §9)', async () => {
    const { worker, findings, ctx } = setup({
      provider: provider({
        text: (request) => {
          const toolContent = request.messages.find((message) => message.role === 'tool')?.content ?? ''
          const evidenceId = toolContent.match(/\[EVIDENCE:([^\]]+)\]/)?.[1]
          return `Analysis.\n\`\`\`json\n${JSON.stringify({
            ...JSON_OUTPUT,
            findings: [{ ...JSON_OUTPUT.findings[0], evidenceIds: [evidenceId] }],
          })}\n\`\`\``
        },
      }),
    })
    const result = await worker.run(node(), ctx)

    const observed = result.findings.find((f) => f.type === 'observed')!
    expect(observed.claim).toContain('JWT')
    expect(observed.evidenceIds).toHaveLength(1)
    expect(observed.domain).toBe('security')
    expect(findings.byDomain('security').some((f) => f.id === observed.id)).toBe(true)
    expect(result.unknowns).toEqual(JSON_OUTPUT.unknowns)
    expect(result.coverageAchieved).toEqual(JSON_OUTPUT.coverage_achieved)
    expect(result.recommendedFollowups).toEqual(JSON_OUTPUT.recommended_followups)
    // Dependent nodes receive structured summaries, not prose.
    expect(JSON.parse(result.outputs[0])).toMatchObject({ role: 'Security Analyst' })
  })

  it('downgrades an observed claim to inferred when no evidence was read (invariant 3)', async () => {
    const { worker, findings, ctx } = setup({
      provider: directAnswerProvider(
        `\`\`\`json\n${JSON.stringify({ ...JSON_OUTPUT, findings: [{ ...JSON_OUTPUT.findings[0], type: 'observed' }] })}\n\`\`\``,
      ),
    })
    const result = await worker.run(node(), ctx)
    expect(result.findings[0].type).toBe('inferred')
    expect(result.findings[0].assumptions).toContain('Observed claim did not cite evidence read during this run.')
    expect(findings.all().some((f) => f.type === 'inferred')).toBe(true)
  })

  it('rejects invented evidence ids instead of attaching all evidence from the run', async () => {
    const { worker, ctx } = setup({
      provider: provider({
        text: `\`\`\`json\n${JSON.stringify({
          ...JSON_OUTPUT,
          findings: [{ ...JSON_OUTPUT.findings[0], evidenceIds: ['not-observed'] }],
        })}\n\`\`\``,
      }),
    })
    const result = await worker.run(node(), ctx)
    expect(result.findings[0]).toMatchObject({ type: 'inferred', evidenceIds: [] })
  })

  it('records unknowns as unknown-type findings', async () => {
    const { worker, findings, ctx } = setup({
      provider: directAnswerProvider(`\`\`\`json\n${JSON.stringify({ ...JSON_OUTPUT, findings: [] })}\n\`\`\``),
    })
    const result = await worker.run(node(), ctx)
    expect(findings.byType('unknown')).toHaveLength(1)
    expect(result.findings.some((f) => f.type === 'unknown')).toBe(true)
  })

  it('survives malformed model output without throwing', async () => {
    const { worker, ctx } = setup({ provider: directAnswerProvider('just some prose, no json at all') })
    const result = await worker.run(node(), ctx)
    expect(result.findings).toHaveLength(0)
    expect(result.outputs[0]).toContain('findings')
  })

  it('narrows tools to the WorkerSpec.allowedTools list', async () => {
    let seenTools: string[] = []
    const { worker, ctx } = setup({
      provider: provider({
        text: 'ok',
        onTools: (tools) => {
          seenTools = tools.map((t) => t.name)
        },
      }),
      tools: [
        { name: 'search_code', description: 'regex search', inputJsonSchema: {} },
        { name: 'read_file', description: 'read a file', inputJsonSchema: {} },
        { name: 'get_dependents', description: 'reverse deps', inputJsonSchema: {} },
      ],
    })
    await worker.run(node({ roleSpec: { ...node().roleSpec, allowedTools: ['search_code', 'read_file'] } }), ctx)
    expect(seenTools).toEqual(['search_code', 'read_file'])
  })
})
