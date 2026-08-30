import { describe, expect, it, vi } from 'vitest'
import { StateRecorder } from './StateRecorder'
import { emptyState, type PersistedAgentState } from './PersistedState'
import type { AgentEvent } from '../../../shared/agentProtocol'
import type { TaskNode } from '../contracts/TaskGraph'
import { SessionStore } from '../session'

function event(partial: Partial<AgentEvent> & { type: AgentEvent['type']; taskId: string }): AgentEvent {
  return { seq: 0, timestamp: 1, ...partial } as AgentEvent
}

function node(id: string, title: string, status: TaskNode['status'] = 'queued', deps: string[] = []): TaskNode {
  return {
    id,
    title,
    objective: `Objective ${title}`,
    dependencies: deps,
    roleSpec: {
      id: `ws-${id}`,
      workerType: 'analysis',
      role: title,
      objective: `Objective ${title}`,
      scope: { roots: ['*'] },
      questions: [],
      requiredCoverage: [],
      allowedTools: [],
      inputFindingIds: [],
      outputSchema: 'findings',
      budget: {
        maxModelCalls: 4,
        maxToolCalls: 8,
        maxInputTokens: 20_000,
        maxOutputTokens: 4_000,
        maxParallelWorkers: 1,
        maxReplans: 1,
      },
    },
    requiredCoverage: [],
    requiredEvidence: [],
    status,
    attempts: 0,
    budget: {
      maxModelCalls: 4,
      maxToolCalls: 8,
      maxInputTokens: 20_000,
      maxOutputTokens: 4_000,
      maxParallelWorkers: 1,
      maxReplans: 1,
    },
    outputs: [],
  }
}

function sink(records: PersistedAgentState[]): (s: PersistedAgentState) => void {
  return (s) => records.push(JSON.parse(JSON.stringify(s)))
}

describe('StateRecorder', () => {
  it('mirrors events into task records and flushes immediately on terminal events', () => {
    const records: PersistedAgentState[] = []
    const recorder = new StateRecorder(emptyState('ws-1', 'fp-1'), sink(records))

    recorder.onEvent(event({ type: 'agentTaskStarted', taskId: 't1', title: 'Task One' }))
    recorder.onEvent(event({ type: 'agentActivity', taskId: 't1', activity: 'Scanning' }))
    recorder.onEvent(event({ type: 'agentAssistantDelta', taskId: 't1', text: 'Hello' }))
    expect(records).toHaveLength(0) // debounced — not per-token writes

    recorder.onEvent(event({ type: 'agentTaskCompleted', taskId: 't1' }))
    expect(records).toHaveLength(1) // terminal → immediate durable flush
    const task = records[0].tasks[0]
    expect(task).toMatchObject({
      taskId: 't1',
      title: 'Task One',
      status: 'completed',
      assistantText: 'Hello',
      activities: ['Scanning'],
    })
  })

  it('captures the live graph and attaches declared documentIds to running document nodes', () => {
    const records: PersistedAgentState[] = []
    const recorder = new StateRecorder(emptyState('ws-1', 'fp-1'), sink(records))
    recorder.onEvent(event({ type: 'agentTaskStarted', taskId: 't1', title: 'Docs' }))

    const docNode: TaskNode = {
      ...node('n-doc', 'PRD', 'running'),
      roleSpec: { ...node('n-doc', 'PRD').roleSpec, workerType: 'document', allowedTools: [] },
    }
    const analysisNode = { ...node('n-a', 'Analysis', 'completed') }
    analysisNode.outputs = ['summary']
    recorder.onGraphChange([analysisNode, docNode])

    recorder.onEvent(
      event({
        type: 'agentDocumentDeclared',
        taskId: 't1',
        document: { documentId: 'doc-1', title: 'PRD', status: 'queued', completedSections: 0, totalSections: 0 },
      }),
    )
    recorder.onEvent(event({ type: 'agentTaskCompleted', taskId: 't1' }))

    const graph = records[0].tasks[0].graph!
    const persistedDoc = graph.find((n) => n.id === 'n-doc')!
    expect(persistedDoc.documentId).toBe('doc-1') // crash-safe doc→node link
    expect(persistedDoc.status).toBe('running')
    const persistedAnalysis = graph.find((n) => n.id === 'n-a')!
    expect(persistedAnalysis.outputs).toEqual(['summary'])
  })

  it('records request identity for the allocated task instead of relying on active task timing', () => {
    const records: PersistedAgentState[] = []
    const recorder = new StateRecorder(emptyState('ws-1', 'fp-1'), sink(records))
    recorder.onEvent(event({ type: 'agentTaskStarted', taskId: 't1', title: 'Task One', seq: 4 }))
    recorder.setRequestIdentityForTask('t1', 'request-1', 'Original prompt', { page: 'home' })
    recorder.flush()

    expect(records[0].tasks[0]).toMatchObject({
      requestId: 'request-1',
      text: 'Original prompt',
      surface: { page: 'home' },
      nextSeq: 5,
    })
  })

  it('stores checkpointed IRs and knowledge snapshots for restart rehydration', () => {
    const records: PersistedAgentState[] = []
    const recorder = new StateRecorder(emptyState('ws-1', 'fp-1'), sink(records))
    recorder.onDocumentCheckpoint('doc-1', { title: 'PRD', sections: [{ heading: 'A', blocks: [{ type: 'paragraph', text: 'x' }] }] })
    recorder.onKnowledgeSnapshot({
      findings: [
        {
          id: 'f-1',
          claim: 'Node runtime',
          type: 'observed',
          domain: 'runtime',
          evidenceIds: ['e-1'],
          confidence: 'high',
          assumptions: [],
          contradictions: [],
          repositoryVersion: 'rv-1',
        },
      ],
      facts: [],
      evidence: [],
    })
    recorder.flush()

    expect(records[0].documentIRs['doc-1'].sections[0].heading).toBe('A')
    expect(recorder.restoredKnowledge().findings[0].claim).toBe('Node runtime')
  })

  it('drops a document IR when the user deletes the dashboard card', () => {
    const records: PersistedAgentState[] = []
    const recorder = new StateRecorder(emptyState('ws-1', 'fp-1'), sink(records))
    recorder.onDocumentCheckpoint('doc-1', { title: 'PRD', sections: [{ heading: 'A', blocks: [{ type: 'paragraph', text: 'x' }] }] })
    recorder.dropDocumentIR('doc-1')
    recorder.flush()
    expect(records.at(-1)?.documentIRs['doc-1']).toBeUndefined()
  })

  it('persists and restores the runtime-owned session rather than webview bubbles', () => {
    const records: PersistedAgentState[] = []
    const sessions = new SessionStore()
    sessions.getOrCreate('ws-1')
    sessions.recordUserTurn('t-1', 'Review authentication')
    const recorder = new StateRecorder(emptyState('ws-1', 'fp-1'), sink(records))
    recorder.onSessionSnapshot(sessions.snapshot())
    recorder.flush()

    expect(records[0].session?.turns[0].content).toBe('Review authentication')
    expect(recorder.restoredSession()?.id).toBe(sessions.current()!.id)
  })

  it('rehydrates persisted running tasks as interrupted (never zombie running)', () => {
    const state = emptyState('ws-1', 'fp-1')
    state.tasks.push({
      taskId: 't-run',
      requestId: 'r1',
      text: 'Generate docs',
      surface: { page: 'home' },
      title: 'Generate docs',
      status: 'running',
      assistantText: '',
      activities: [],
      documents: [],
      graph: [node('n-a', 'Analysis', 'completed'), node('n-b', 'More', 'running')],
    })
    const recorder = new StateRecorder(state, sink([]))

    const restored = recorder.restoredTasks()
    expect(restored).toHaveLength(1)
    expect(restored[0].interrupted).toBe(true)
    const payload = recorder.resumeGraph('t-run')!
    expect(payload.graph).toHaveLength(2)
    expect(payload.outputs['n-a']).toEqual([]) // completed node outputs restored
  })

  it('mirrors single-loop checkpoints and returns a resume payload with loopState', () => {
    const records: PersistedAgentState[] = []
    const recorder = new StateRecorder(emptyState('ws-1', 'fp-1'), sink(records))
    recorder.onEvent(event({ type: 'agentTaskStarted', taskId: 't-loop', title: 'Loop task' }))
    recorder.onLoopCheckpoint('t-loop', {
      messages: [
        { role: 'user', content: 'question' },
        { role: 'assistant', content: 'working' },
      ],
      toolCallsUsed: 2,
      modelCallsUsed: 2,
      evidenceIds: ['e-1'],
    })
    recorder.flush()

    expect(records[0].tasks[0].loopState).toMatchObject({ toolCallsUsed: 2, modelCallsUsed: 2 })
    const payload = recorder.resumePayload('t-loop')
    expect(payload.graph).toBeUndefined()
    expect(payload.loopState?.messages).toHaveLength(2)
    expect(payload.loopState?.evidenceIds).toEqual(['e-1'])
  })

  it('wipes tasks when the workspace changes (no cross-contamination)', () => {
    const state = emptyState('ws-old', 'fp-old')
    state.tasks.push({
      taskId: 't1',
      requestId: 'r1',
      text: 'x',
      surface: { page: 'home' },
      title: 'x',
      status: 'completed',
      assistantText: '',
      activities: [],
      documents: [],
    })
    const records: PersistedAgentState[] = []
    const recorder = new StateRecorder(state, sink(records))
    recorder.setWorkspace('ws-new', 'fp-new')
    recorder.flush()

    expect(records[0].workspaceId).toBe('ws-new')
    expect(records[0].tasks).toHaveLength(0)
  })

  it('keeps tasks but refreshes the fingerprint when only the fingerprint changes', () => {
    const state = emptyState('ws-1', 'fp-old')
    state.tasks.push({
      taskId: 't1',
      requestId: 'r1',
      text: 'x',
      surface: { page: 'home' },
      title: 'x',
      status: 'running',
      assistantText: '',
      activities: [],
      documents: [],
    })
    const records: PersistedAgentState[] = []
    const recorder = new StateRecorder(state, sink(records))
    recorder.setWorkspace('ws-1', 'fp-new')
    recorder.flush()

    expect(records[0].repoFingerprint).toBe('fp-new')
    expect(records[0].tasks).toHaveLength(1)
  })

  it('prunes tasks beyond the bound (oldest dropped)', () => {
    const state = emptyState('ws-1', 'fp-1')
    for (let i = 0; i < 12; i++) {
      state.tasks.push({
        taskId: `t-${i}`,
        requestId: `r-${i}`,
        text: 'x',
        surface: { page: 'home' },
        title: `Task ${i}`,
        status: 'completed',
        assistantText: '',
        activities: [],
        documents: [],
      })
    }
    const records: PersistedAgentState[] = []
    const recorder = new StateRecorder(state, sink(records))
    recorder.flush()
    expect(records[0].tasks).toHaveLength(8)
    expect(records[0].tasks[0].taskId).toBe('t-4')
  })

  it('debounced persistence coalesces bursts into few writes', async () => {
    vi.useFakeTimers()
    const records: PersistedAgentState[] = []
    const recorder = new StateRecorder(emptyState('ws-1', 'fp-1'), sink(records), { debounceMs: 100 })
    recorder.onEvent(event({ type: 'agentTaskStarted', taskId: 't1', title: 'x' }))
    recorder.onEvent(event({ type: 'agentActivity', taskId: 't1', activity: 'a1' }))
    recorder.onEvent(event({ type: 'agentActivity', taskId: 't1', activity: 'a2' }))
    expect(records).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(150)
    expect(records).toHaveLength(1)
    expect(records[0].tasks[0].activities).toEqual(['a1', 'a2'])
    vi.useRealTimers()
  })

  it('flushAsync persists pending dirty state immediately and cancels the debounce', async () => {
    vi.useFakeTimers()
    const records: PersistedAgentState[] = []
    const recorder = new StateRecorder(emptyState('ws-1', 'fp-1'), sink(records), { debounceMs: 100 })
    recorder.onEvent(event({ type: 'agentTaskStarted', taskId: 't1', title: 'x' }))
    recorder.onEvent(event({ type: 'agentActivity', taskId: 't1', activity: 'a1' }))
    expect(records).toHaveLength(0)

    await recorder.flushAsync()
    expect(records).toHaveLength(1)
    expect(records[0].tasks[0].activities).toEqual(['a1'])

    // The debounce timer was cancelled — no second write fires later.
    await vi.advanceTimersByTimeAsync(200)
    expect(records).toHaveLength(1)
    vi.useRealTimers()
  })

  it('never drops evidence referenced by findings, even past the persisted cap (invariant 10)', () => {
    const records: PersistedAgentState[] = []
    const recorder = new StateRecorder(emptyState('ws-1', 'fp-1'), sink(records))

    // More evidence than MAX_PERSISTED_EVIDENCE; only e-last is referenced.
    const evidence = Array.from({ length: 350 }, (_, i) => ({
      id: i === 349 ? 'e-referenced' : `e-${i}`,
      repositoryVersion: 'rv-1',
      path: `/src/f${i}.ts`,
      contentHash: `h${i}`,
      kind: 'source' as const,
      sourceTool: 'read_file_range',
      createdAt: i,
    }))
    recorder.onKnowledgeSnapshot({
      findings: [
        {
          id: 'f-1',
          claim: 'X',
          type: 'observed',
          domain: 'd',
          evidenceIds: ['e-referenced'],
          confidence: 'high',
          assumptions: [],
          contradictions: [],
          repositoryVersion: 'rv-1',
        },
      ],
      facts: [],
      evidence,
    })
    recorder.flush()

    const persisted = recorder.restoredKnowledge()
    // The referenced record survives even though it would have been trimmed.
    expect(persisted.evidence.some((e) => e.id === 'e-referenced')).toBe(true)
    // The cap still bounds the unreferenced tail.
    expect(persisted.evidence.length).toBeLessThan(350)
  })
})
