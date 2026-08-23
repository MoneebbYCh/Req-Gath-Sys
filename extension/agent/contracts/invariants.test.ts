import { describe, expect, it } from 'vitest'
import { agentTaskSchema, type AgentTask } from './AgentTask'
import { repositoryVersionSchema } from './RepositoryVersion'
import { taskBudgetSchema } from './TaskBudget'
import { toolDefinitionSchema } from './ToolDefinition'
import { workerSpecSchema, type WorkerSpec } from './WorkerSpec'
import {
  isAcyclic,
  readyNodes,
  taskNodeSchema,
  validateTaskGraph,
  type TaskNode,
} from './TaskGraph'
import {
  dedupeFindings,
  isGrounded,
  projectFactSchema,
  type Finding,
} from './Finding'
import { documentSpecSchema } from './DocumentSpec'

const budget = {
  maxModelCalls: 20,
  maxToolCalls: 100,
  maxInputTokens: 100_000,
  maxOutputTokens: 16_000,
  maxParallelWorkers: 2,
  maxReplans: 3,
}

function workerSpec(overrides: Partial<WorkerSpec> = {}): WorkerSpec {
  return {
    id: 'w1',
    workerType: 'analysis',
    role: 'Auth Analyst',
    objective: 'Locate authentication enforcement',
    scope: { roots: ['/repo'] },
    questions: ['Where is auth enforced?'],
    requiredCoverage: ['Entry points identified'],
    allowedTools: ['search_code', 'read_file_range'],
    inputFindingIds: [],
    outputSchema: 'findings',
    budget,
    ...overrides,
  }
}

function node(overrides: Partial<TaskNode> = {}): TaskNode {
  return {
    id: 'n1',
    title: 'Analyze auth',
    objective: 'Find auth enforcement',
    dependencies: [],
    roleSpec: workerSpec(),
    requiredCoverage: [],
    requiredEvidence: [],
    status: 'queued',
    attempts: 0,
    budget,
    outputs: [],
    ...overrides,
  }
}

describe('Phase 0 — contract invariants', () => {
  it('validates a well-formed agent task with a stable taskId', () => {
    const task: AgentTask = {
      taskId: 't-1',
      sessionId: 's-1',
      requestId: 'r-1',
      title: 'Where is auth handled?',
      status: 'running',
      createdAt: 1,
      updatedAt: 2,
      surface: { page: 'home' },
    }
    expect(agentTaskSchema.parse(task)).toEqual(task)
  })

  it('validates repository version, budget, tool definition, and worker spec schemas', () => {
    expect(repositoryVersionSchema.parse({ id: 'rv', workspaceId: 'ws', createdAt: 0 })).toBeTruthy()
    expect(taskBudgetSchema.parse(budget)).toEqual(budget)
    expect(
      toolDefinitionSchema.parse({
        name: 'search_code',
        description: 'regex search',
        inputJsonSchema: { type: 'object' },
      }),
    ).toBeTruthy()
    expect(workerSpecSchema.parse(workerSpec())).toBeTruthy()
  })

  it('validates document spec schema', () => {
    const doc = documentSpecSchema.parse({
      id: 'd1',
      title: 'PRD',
      documentTypeId: 'prd',
      objective: 'Describe the product',
      outline: ['Overview', 'Requirements'],
      requiredFindingDomains: ['auth'],
      generation: {
        documentId: 'd1',
        status: 'queued',
        completedSections: 0,
        totalSections: 2,
      },
    })
    expect(doc.title).toBe('PRD')
  })

  it('invariant 3 — observed findings must be grounded in evidence', () => {
    const observed: Finding = {
      id: 'f1',
      claim: 'Auth is enforced in middleware',
      type: 'observed',
      domain: 'auth',
      evidenceIds: [],
      confidence: 'high',
      assumptions: [],
      contradictions: [],
      repositoryVersion: 'rv',
    }
    expect(isGrounded(observed)).toBe(false)
    expect(isGrounded({ ...observed, evidenceIds: ['e1'] })).toBe(true)
    expect(isGrounded({ ...observed, type: 'inferred' })).toBe(true)
  })

  it('invariant 4 — equivalent findings normalize to one record (commit step)', () => {
    const base: Finding = {
      id: 'f1',
      claim: 'Primary database: PostgreSQL',
      type: 'observed',
      domain: 'storage',
      evidenceIds: ['e1'],
      confidence: 'high',
      assumptions: [],
      contradictions: [],
      repositoryVersion: 'rv',
    }
    const duplicate = { ...base, id: 'f2', evidenceIds: ['e1', 'e2'] }
    const deduped = dedupeFindings([base, duplicate])
    expect(deduped).toHaveLength(1)
    expect(deduped[0].id).toBe('f2') // more evidence wins
  })

  it('validates project fact schema', () => {
    expect(
      projectFactSchema.parse({
        id: 'p1',
        key: 'runtime',
        statement: 'Node.js',
        domain: 'platform',
        sourceFindingIds: ['f1'],
        evidenceIds: ['e1'],
        confidence: 'high',
        repositoryVersion: 'rv',
        updatedAt: 0,
      }),
    ).toBeTruthy()
  })

  it('invariant 9 — task graph must be acyclic and dependencies gated', () => {
    const a = node({ id: 'a' })
    const b = node({ id: 'b', dependencies: ['a'], status: 'queued' })
    expect(isAcyclic([a, b])).toBe(true)
    expect(() => validateTaskGraph([a, b])).not.toThrow()

    // a has no deps so it is ready; b is not ready until a is completed.
    expect(readyNodes([a, b])).toEqual(['a'])
    expect(readyNodes([{ ...a, status: 'completed' }, b])).toEqual(['b'])

    // cycle
    const cyc = [a, { ...b, dependencies: ['a'] }, node({ id: 'a', dependencies: ['b'] })]
    expect(isAcyclic(cyc)).toBe(false)
    expect(() => validateTaskGraph(cyc)).toThrow(/cycle/)

    // missing dependency
    expect(() => validateTaskGraph([b])).toThrow(/missing dependency/)
  })

  it('validates a well-formed task node schema', () => {
    expect(taskNodeSchema.parse(node())).toBeTruthy()
  })
})
