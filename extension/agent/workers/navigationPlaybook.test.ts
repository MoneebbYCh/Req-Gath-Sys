import { describe, expect, it } from 'vitest'
import { NAVIGATION_PLAYBOOK } from './navigationPlaybook'
import { AnalysisWorker } from './AnalysisWorker'
import { RepositoryExplorerWorker } from './RepositoryExplorerWorker'
import { repositoryToolNameSchema } from '../contracts/ToolDefinition'
import { FindingStore } from '../knowledge/FindingStore'
import { KnowledgeCommitService } from '../knowledge/KnowledgeCommitService'
import { ProjectFactBase } from '../knowledge/ProjectFactBase'
import { EvidenceLedger } from '../knowledge/EvidenceLedger'
import type { TaskNode } from '../contracts/TaskGraph'
import type { ModelProvider } from '../model/ModelProvider'
import type { ModelRequest } from '../model/ModelTypes'

describe('NAVIGATION_PLAYBOOK', () => {
  it('references only real repository tools (drift guard)', () => {
    const valid = new Set<string>(repositoryToolNameSchema.options)
    const tokens = [...NAVIGATION_PLAYBOOK.matchAll(/`?([a-z][a-z0-9_]+)`?/g)].map((m) => m[1])
    const snakeCaseTokens = tokens.filter((t) => t.includes('_'))
    expect(snakeCaseTokens.length).toBeGreaterThan(5)
    for (const token of snakeCaseTokens) {
      expect(valid, `playbook references unknown tool "${token}"`).toContain(token)
    }
  })

  it('teaches recovery and stopping, not just happy path', () => {
    expect(NAVIGATION_PLAYBOOK).toContain('refineHint')
    expect(NAVIGATION_PLAYBOOK).toContain('tooLarge')
    expect(NAVIGATION_PLAYBOOK).toContain('available:false')
    expect(NAVIGATION_PLAYBOOK).toContain('Stop condition')
  })
})

function node(workerType: 'analysis' | 'repository'): TaskNode {
  return {
    id: 'n1',
    title: 'Auth survey',
    objective: 'Locate authentication enforcement',
    dependencies: [],
    roleSpec: {
      id: 'ws-1',
      workerType,
      role: 'Explorer',
      objective: 'Locate authentication enforcement',
      scope: { roots: ['*'] },
      questions: ['Where is auth enforced?'],
      requiredCoverage: [],
      allowedTools: ['search_code', 'read_file'],
      inputFindingIds: [],
      outputSchema: 'findings',
      budget: {
        maxModelCalls: 2,
        maxToolCalls: 4,
        maxInputTokens: 20_000,
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
      maxModelCalls: 2,
      maxToolCalls: 4,
      maxInputTokens: 20_000,
      maxOutputTokens: 4_000,
      maxParallelWorkers: 1,
      maxReplans: 1,
    },
    outputs: [],
  }
}

/** Provider that captures the system prompt, then answers directly with valid JSON. */
function systemCapturingProvider(text: string): { provider: ModelProvider; systems: string[] } {
  const systems: string[] = []
  const provider: ModelProvider = {
    async *stream(request: ModelRequest) {
      systems.push(request.system ?? '')
      yield { type: 'text_delta', text }
      yield { type: 'finish', reason: 'stop' as const }
    },
  }
  return { provider, systems }
}

const ctx = () => ({
  signal: new AbortController().signal,
  activity: () => {},
  delta: () => {},
  dependencyOutputs: [] as string[],
  taskId: 't1',
  budgetController: undefined,
})

function deps(provider: ModelProvider) {
  return {
    provider,
    executor: { execute: async () => ({ ok: true as const, result: {} }) },
    baseConfig: {
      model: 'test',
      tools: [{ name: 'search_code', description: 'x', inputJsonSchema: {} }],
      recordEvidence: () => [],
    },
    knowledge: new KnowledgeCommitService(new FindingStore(), new ProjectFactBase()),
    evidence: new EvidenceLedger(),
  }
}

describe('worker prompts embed the playbook', () => {
  it.each([
    ['analysis', AnalysisWorker],
    ['repository', RepositoryExplorerWorker],
  ] as const)('%s worker system prompt contains the navigation playbook', async (workerType, Worker) => {
    const answer =
      workerType === 'repository'
        ? '```json\n{"overview":"o","structure_highlights":[],"package_manifest":[],"unknowns":[]}\n```'
        : '```json\n{"findings":[],"unknowns":[],"contradictions":[],"coverage_achieved":[],"recommended_followups":[],"new_questions":[],"missing_coverage":[]}\n```'
    const { provider, systems } = systemCapturingProvider(answer)
    const worker = new Worker(deps(provider))
    await worker.run(node(workerType), ctx())
    expect(systems[0]).toContain('Navigation strategy')
    expect(systems[0]).toContain('get_project_structure')
  })
})
