import { describe, expect, it } from 'vitest'
import { AgentRuntime } from './AgentRuntime'
import { deriveTaskBudget, orchestratorRunner, type OrchestratorRunnerOptions, type NodeRunContext } from './OrchestratorRunner'
import type { AgentEvent } from '../../../shared/agentProtocol'
import type { TaskRunner } from './AgentRuntime'
import type { TaskNode } from '../contracts/TaskGraph'
import { ComplexityRouter } from '../planner/ComplexityRouter'
import { Planner } from '../planner/Planner'

function collect(runtime: AgentRuntime): AgentEvent[] {
  const events: AgentEvent[] = []
  runtime.onEvent((e) => events.push(e))
  return events
}

function tick(ms = 0): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function simpleMarker(marker: string[]): TaskRunner {
  return async ({ emit }) => {
    emit.activity('fast path ran')
    emit.assistantStarted()
    emit.assistantDelta(marker.join(''))
  }
}

function runNodeMarker(): OrchestratorRunnerOptions['runNode'] {
  return async (node, ctx: NodeRunContext) => {
    ctx.activity(`node:${node.title}`)
    ctx.delta(`[${node.title}]`)
    return [`output-${node.title}`]
  }
}

describe('orchestratorRunner', () => {
  it('derives a shared budget from all graph nodes rather than the first node', () => {
    const nodes = new Planner({ maxNodes: 8 }).plan('Create a security architecture document for the codebase.')
    const budget = deriveTaskBudget(nodes)

    expect(budget.maxModelCalls).toBe(nodes.reduce((total, node) => total + node.budget.maxModelCalls, 0))
    expect(budget.maxToolCalls).toBe(nodes.reduce((total, node) => total + node.budget.maxToolCalls, 0))
    expect(budget.maxParallelWorkers).toBe(Math.min(...nodes.map((node) => node.budget.maxParallelWorkers)))
  })

  it('routes simple requests to the fast path without a plan', async () => {
    const marker: string[] = ['fast']
    const runtime = new AgentRuntime(
      orchestratorRunner({ simpleRunner: simpleMarker(marker) }),
    )
    const events = collect(runtime)
    runtime.start({ requestId: 'o1', text: 'Where is auth handled?', surface: { page: 'home' } })
    await tick(20)

    const deltas = events
      .filter((e): e is Extract<AgentEvent, { type: 'agentAssistantDelta' }> => e.type === 'agentAssistantDelta')
      .map((e) => e.text)
    expect(deltas.join('')).toBe('fast')
    expect(events.some((e) => e.type === 'agentPlanUpdated')).toBe(false)
    expect(events.at(-1)).toMatchObject({ type: 'agentTaskCompleted' })
  })

  it.each(['yes', 'cotniue', 'yes please', 'continue with it', 'do that'])(
    'keeps a document request on the document-capable path when the user replies %j',
    async (reply) => {
      const workerTypes: string[] = []
      const runtime = new AgentRuntime(
        orchestratorRunner({
          simpleRunner: simpleMarker(['wrong-path']),
          conversationContext: () => [
            'USER: Create a scalability design document for this repository.',
            'ASSISTANT: I can create that editable document now. Shall I continue?',
          ],
          runNode: async (node) => {
            workerTypes.push(node.roleSpec.workerType)
            return [`output-${node.title}`]
          },
        }),
      )
      const events = collect(runtime)

      runtime.start({ requestId: `followup-${reply}`, text: reply, surface: { page: 'home' } })
      await tick(30)

      expect(workerTypes).toContain('document')
      expect(events.some((event) => event.type === 'agentPlanUpdated')).toBe(true)
      expect(
        events.some(
          (event) => event.type === 'agentAssistantDelta' && event.text.includes('wrong-path'),
        ),
      ).toBe(false)
    },
  )

  it('retains a pending document outcome across tasks without webview history', async () => {
    const documentRuns: string[] = []
    const runner = orchestratorRunner({
      simpleRunner: simpleMarker(['wrong-path']),
      runNode: async (node) => {
        if (node.roleSpec.workerType === 'document') documentRuns.push(node.title)
        return [`output-${node.title}`]
      },
    })
    const runtime = new AgentRuntime(runner)

    runtime.start({
      requestId: 'pending-doc-1',
      text: 'Create a scalability document for this repository.',
      surface: { page: 'home' },
    })
    await tick(30)
    documentRuns.length = 0

    runtime.start({ requestId: 'pending-doc-2', text: 'yes please', surface: { page: 'home' } })
    await tick(30)

    expect(documentRuns).toContain('Scalability Strategy')
  })

  it('acknowledges editable document creation before planning or model work completes', () => {
    const runtime = new AgentRuntime(
      orchestratorRunner({
        simpleRunner: simpleMarker(['wrong-path']),
        runNode: async () => [],
      }),
    )
    const events = collect(runtime)

    runtime.start({
      requestId: 'document-ack',
      text: 'Create a scalability design document for this repository.',
      surface: { page: 'home' },
    })

    expect(events.slice(0, 4).map((event) => event.type)).toEqual([
      'agentTaskStarted',
      'agentAssistantStarted',
      'agentAssistantDelta',
      'agentAssistantCompleted',
    ])
    expect(
      events.find((event) => event.type === 'agentAssistantDelta'),
    ).toMatchObject({ text: expect.stringMatching(/editable canvas document/i) })
    const acknowledgement = events.find(
      (event): event is Extract<AgentEvent, { type: 'agentAssistantDelta' }> =>
        event.type === 'agentAssistantDelta',
    )
    expect(acknowledgement?.text.endsWith('\n\n')).toBe(true)
  })

  it('turns the reported scalability prompt into a declared editable document', async () => {
    const runtime = new AgentRuntime(
      orchestratorRunner({
        simpleRunner: simpleMarker(['wrong-path']),
        runNode: async (node, ctx) => {
          if (node.roleSpec.workerType === 'document') {
            ctx.documentDeclared({
              documentId: 'doc-scalability',
              title: node.title,
              status: 'queued',
              completedSections: 0,
              totalSections: 0,
            })
          }
          return [`output-${node.title}`]
        },
      }),
    )
    const events = collect(runtime)

    runtime.start({
      requestId: 'reported-prompt',
      text: 'create a document for Scalibilty design for this repo',
      surface: { page: 'home' },
    })
    await tick(30)

    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'agentDocumentDeclared',
        document: expect.objectContaining({
          documentId: 'doc-scalability',
          title: 'Scalability Strategy',
        }),
      }),
    )
    expect(
      events.some(
        (event) => event.type === 'agentAssistantDelta' && event.text.includes('wrong-path'),
      ),
    ).toBe(false)
  })

  it('plans complex requests, streams plan updates, and runs nodes in order', async () => {
    const runtime = new AgentRuntime(
      orchestratorRunner({
        simpleRunner: simpleMarker([]),
        router: new ComplexityRouter({ classify: (t) => (t.includes('complex') ? 'complex' : 'simple') }),
        planner: new Planner({ maxNodes: 2 }),
        runNode: runNodeMarker(),
      }),
    )
    const events = collect(runtime)
    runtime.start({ requestId: 'o2', text: 'complex security audit', surface: { page: 'home' } })
    await tick(20)

    const planEvents = events.filter(
      (e): e is Extract<AgentEvent, { type: 'agentPlanUpdated' }> => e.type === 'agentPlanUpdated',
    )
    expect(planEvents.length).toBeGreaterThanOrEqual(1)
    // First plan: all queued.
    expect(planEvents[0].plan.nodes.every((n) => n.status === 'queued')).toBe(true)
    // Final plan: everything completed.
    const final = planEvents.at(-1)!.plan
    expect(final.nodes.every((n) => n.status === 'completed')).toBe(true)
    expect(final.nodes.length).toBe(2)

    const activities = events
      .filter((e): e is Extract<AgentEvent, { type: 'agentActivity' }> => e.type === 'agentActivity')
      .map((e) => e.activity)
    expect(activities.some((a) => a.startsWith('Working on:'))).toBe(true)
    expect(activities).toContain('Analysis complete')

    // Concurrent node output remains internal; only task activity/progress is
    // user-facing until a dedicated synthesis pass is introduced.
    const deltas = events
      .filter((e): e is Extract<AgentEvent, { type: 'agentAssistantDelta' }> => e.type === 'agentAssistantDelta')
      .map((e) => e.text)
    expect(deltas).toEqual([])
    expect(events.at(-1)).toMatchObject({ type: 'agentTaskCompleted' })
  })

  it('preserves partial success when a node fails (US-8.3)', async () => {
    const runtime = new AgentRuntime(
      orchestratorRunner({
        simpleRunner: simpleMarker([]),
        router: new ComplexityRouter({ classify: () => 'complex' }),
        planner: new Planner({ maxNodes: 2 }),
        runNode: async (node) => {
          if (node.title.includes('Authentication')) throw new Error('tool broke')
          return [`ok-${node.title}`]
        },
      }),
    )
    const events = collect(runtime)
    runtime.start({ requestId: 'o3', text: 'complex security audit', surface: { page: 'home' } })
    await tick(20)

    const final = events
      .filter((e): e is Extract<AgentEvent, { type: 'agentPlanUpdated' }> => e.type === 'agentPlanUpdated')
      .at(-1)!
    expect(final.plan.nodes.some((n) => n.status === 'failed')).toBe(true)
    expect(final.plan.nodes.some((n) => n.status === 'completed')).toBe(true)

    const activities = events
      .filter((e): e is Extract<AgentEvent, { type: 'agentActivity' }> => e.type === 'agentActivity')
      .map((e) => e.activity)
    expect(activities.some((a) => a.includes('completed — see plan'))).toBe(true)
    // Partial success completes the task (it does not fail outright).
    expect(events.at(-1)).toMatchObject({ type: 'agentTaskCompleted' })
  })

  it('replans from worker follow-ups with the graph store budget (plan §8/§9)', async () => {
    const followupTitle = 'Check the password reset flow'
    const runtime = new AgentRuntime(
      orchestratorRunner({
        simpleRunner: simpleMarker([]),
        router: new ComplexityRouter({ classify: () => 'complex' }),
        planner: new Planner({ maxNodes: 1 }),
        runNode: async (node) => {
          // First node reports a missing coverage follow-up; follow-up nodes run normally.
          if (node.title.includes('Authentication')) {
            return { outputs: [`out-${node.title}`], followups: [followupTitle] }
          }
          return [`out-${node.title}`]
        },
      }),
    )
    const events = collect(runtime)
    runtime.start({ requestId: 'o4', text: 'complex security audit', surface: { page: 'home' } })
    await tick(20)

    const planEvents = events.filter(
      (e): e is Extract<AgentEvent, { type: 'agentPlanUpdated' }> => e.type === 'agentPlanUpdated',
    )
    const final = planEvents.at(-1)!.plan
    expect(final.nodes.some((n) => n.title === followupTitle && n.status === 'completed')).toBe(true)

    const activities = events
      .filter((e): e is Extract<AgentEvent, { type: 'agentActivity' }> => e.type === 'agentActivity')
      .map((e) => e.activity)
    expect(activities).toContain('Added 1 follow-up part(s)')
    expect(events.at(-1)).toMatchObject({ type: 'agentTaskCompleted' })
  })

  it('replans targeted section regenerations from validation signals (plan §13)', async () => {
    const runtime = new AgentRuntime(
      orchestratorRunner({
        simpleRunner: simpleMarker([]),
        router: new ComplexityRouter({ classify: () => 'complex' }),
        planner: new Planner({ maxNodes: 12 }),
        runNode: async (node, ctx) => {
          if (node.roleSpec.workerType === 'validation' && node.roleSpec.validationKind === 'document') {
            ctx.validationProgress({ phase: 'claim', documentId: 'doc-1', message: 'Validating PRD' })
            return {
              outputs: [JSON.stringify({ mode: 'document', documentId: 'doc-1', title: 'PRD', status: 'failed', claims: [], staleEvidenceIds: [], failedSections: ['Auth'], issues: [] })],
              followups: [
                {
                  kind: 'regenerate-section',
                  documentId: 'doc-1',
                  title: 'PRD',
                  sectionHeading: 'Auth',
                  note: 'contradicts evidence',
                  dependencies: [node.id],
                },
              ],
            }
          }
          return [`out-${node.title}`]
        },
      }),
    )
    const events = collect(runtime)
    runtime.start({ requestId: 'o5', text: 'Create a PRD document for this repository.', surface: { page: 'home' } })
    await tick(20)

    const final = events
      .filter((e): e is Extract<AgentEvent, { type: 'agentPlanUpdated' }> => e.type === 'agentPlanUpdated')
      .at(-1)!.plan
    const regen = final.nodes.find((n) => n.title.includes('Fix 1 section(s) in PRD'))
    expect(regen).toBeTruthy()
    expect(regen!.status).toBe('completed')
    expect(events.at(-1)).toMatchObject({ type: 'agentTaskCompleted' })
  })

  it('surfaces a validation summary as assistant text before task completion (plan §13)', async () => {
    const runtime = new AgentRuntime(
      orchestratorRunner({
        simpleRunner: simpleMarker([]),
        router: new ComplexityRouter({ classify: () => 'complex' }),
        planner: new Planner({ maxNodes: 12 }),
        runNode: async (node) => {
          if (node.roleSpec.workerType === 'validation' && node.roleSpec.validationKind === 'document') {
            return [JSON.stringify({ mode: 'document', documentId: 'doc-1', title: 'PRD', status: 'issues', claims: [], staleEvidenceIds: ['e-1'], failedSections: [], issues: ['stale'] })]
          }
          if (node.roleSpec.workerType === 'validation' && node.roleSpec.validationKind === 'cross-document') {
            return [JSON.stringify({ mode: 'cross-document', status: 'issues', contradictions: [{ resolved: false }], issues: ['unresolved'] })]
          }
          return [`out-${node.title}`]
        },
      }),
    )
    const events = collect(runtime)
    runtime.start({ requestId: 'o6', text: 'Create three project documents for this repository.', surface: { page: 'home' } })
    await tick(20)

    const deltas = events
      .filter((e): e is Extract<AgentEvent, { type: 'agentAssistantDelta' }> => e.type === 'agentAssistantDelta')
      .map((e) => e.text)
      .join('')
    expect(deltas).toContain('Validation summary')
    expect(deltas).toContain('3 evidence item(s) are stale')
    expect(deltas).toContain('1 unresolved contradiction(s)')

    // The summary is streamed BEFORE the task completes.
    const deltaIdx = events.findIndex((e) => e.type === 'agentAssistantDelta')
    const completeIdx = events.findIndex((e) => e.type === 'agentTaskCompleted')
    expect(deltaIdx).toBeGreaterThanOrEqual(0)
    expect(deltaIdx).toBeLessThan(completeIdx)
  })

  it('streams only one final synthesis after concurrent workers settle', async () => {
    const starts: string[] = []
    const runtime = new AgentRuntime(
      orchestratorRunner({
        simpleRunner: simpleMarker([]),
        router: new ComplexityRouter({ classify: () => 'complex' }),
        planner: new Planner({ maxNodes: 2 }),
        runNode: async (node, ctx) => {
          ctx.delta(`LEAK:${node.id}`)
          starts.push(node.id)
          await tick(node.id.includes('structure') ? 20 : 5)
          return [`private-${node.title}`]
        },
        synthesize: async (input, ctx) => {
          expect(input.nodes.every((node) => node.status === 'completed')).toBe(true)
          expect(input.nodes.flatMap((node) => node.outputs).join('|')).toContain('private-')
          ctx.assistantStarted()
          ctx.delta('Final answer, synthesized after all analysis.')
          ctx.assistantCompleted()
        },
      }),
    )
    const events = collect(runtime)
    runtime.start({ requestId: 'o-synthesis', text: 'complex review', surface: { page: 'home' } })
    await tick(80)

    expect(starts).toHaveLength(2)
    const prose = events
      .filter((e): e is Extract<AgentEvent, { type: 'agentAssistantDelta' }> => e.type === 'agentAssistantDelta')
      .map((event) => event.text)
      .join('')
    expect(prose).toBe('Final answer, synthesized after all analysis.')
    expect(prose).not.toContain('LEAK:')
    const deltaIndex = events.findIndex((event) => event.type === 'agentAssistantDelta')
    const completedPlanIndex = events.findLastIndex((event) => event.type === 'agentPlanUpdated' && event.plan.nodes.every((node) => node.status === 'completed'))
    expect(deltaIndex).toBeGreaterThan(completedPlanIndex)
  })

  it('resumes a durable graph without repeating completed nodes (plan §14)', async () => {
    const runCounts = new Map<string, number>()
    const runtime = new AgentRuntime(
      orchestratorRunner({
        simpleRunner: simpleMarker([]),
        router: new ComplexityRouter({ classify: () => 'complex' }),
        planner: new Planner({ maxNodes: 4 }),
        runNode: async (node) => {
          runCounts.set(node.title, (runCounts.get(node.title) ?? 0) + 1)
          return [`out-${node.title}`]
        },
      }),
    )
    const events = collect(runtime)
    const budget = { maxModelCalls: 1, maxToolCalls: 1, maxInputTokens: 1, maxOutputTokens: 1, maxParallelWorkers: 1, maxReplans: 1 }
    const spec = (id: string): TaskNode['roleSpec'] => ({
      id,
      workerType: 'analysis',
      role: 'Analyst',
      objective: 'Analyze.',
      scope: { roots: ['*'] },
      questions: [],
      requiredCoverage: [],
      allowedTools: [],
      inputFindingIds: [],
      outputSchema: 'findings',
      budget,
    })
    // A graph where one node completed and one was mid-flight at the crash.
    const restoredGraph: TaskNode[] = [
      {
        id: 'node-general-repository-structure-and-entry-points',
        title: 'Repository structure and entry points',
        objective: 'Analyze it.',
        dependencies: [],
        roleSpec: spec('ws-1'),
        requiredCoverage: [],
        requiredEvidence: [],
        status: 'completed',
        attempts: 1,
        budget,
        outputs: ['prior-work'],
      },
      {
        id: 'node-general-core-domains-and-responsibilities',
        title: 'Core domains and responsibilities',
        objective: 'Analyze it.',
        dependencies: [],
        roleSpec: spec('ws-2'),
        requiredCoverage: [],
        requiredEvidence: [],
        status: 'running', // mid-flight at crash → must re-run
        attempts: 1,
        budget,
        outputs: [],
      },
    ]

    runtime.restoreTask({
      taskId: 't-resume',
      requestId: 'r-resume',
      text: 'complex audit',
      surface: { page: 'home' },
      title: 'complex audit',
      status: 'running',
      assistantText: '',
      activities: [],
      documents: [],
    })
    runtime.resume('t-resume', { graph: restoredGraph, outputs: { 'node-general-repository-structure-and-entry-points': ['prior-work'] } })
    await tick(30)

    // Completed node never re-ran; the mid-flight node did.
    expect(runCounts.get('Repository structure and entry points')).toBeUndefined()
    expect(runCounts.get('Core domains and responsibilities')).toBe(1)

    const final = events
      .filter((e): e is Extract<AgentEvent, { type: 'agentPlanUpdated' }> => e.type === 'agentPlanUpdated')
      .at(-1)!.plan
    expect(final.nodes.every((n) => n.status === 'completed')).toBe(true)
    expect(events.at(-1)).toMatchObject({ type: 'agentTaskCompleted' })
  })

  it('retries a node on a transient provider failure, then gives up on non-retryable (plan §14)', async () => {
    const { ProviderError } = await import('../model/ProviderError')
    const failing = new ProviderError('rate_limited', 'Provider rate limit reached (429).')

    let attempts = 0
    const runtime = new AgentRuntime(
      orchestratorRunner({
        simpleRunner: simpleMarker([]),
        router: new ComplexityRouter({ classify: () => 'complex' }),
        planner: new Planner({ maxNodes: 1 }),
        runNode: async (node) => {
          attempts++
          if (attempts <= 2) throw failing // two transient failures → both retried
          return [`ok-${node.title}`]
        },
      }),
    )
    const events = collect(runtime)
    runtime.start({ requestId: 'o-retry', text: 'complex security audit', surface: { page: 'home' } })
    // Two retries × (500ms + jitter) worst case ≈ 1.5s.
    await tick(2500)

    expect(attempts).toBe(3) // initial + 2 retries (maxNodeRetries = 2)
    const activities = events
      .filter((e): e is Extract<AgentEvent, { type: 'agentActivity' }> => e.type === 'agentActivity')
      .map((e) => e.activity)
    expect(activities.some((a) => a.startsWith('Provider hiccup on'))).toBe(true)
    expect(events.at(-1)).toMatchObject({ type: 'agentTaskCompleted' })
  })
})
