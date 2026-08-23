import { describe, expect, it, vi } from 'vitest'
import { AgentRuntime } from './AgentRuntime'
import type { AgentEvent } from '../../../shared/agentProtocol'

function collect(runtime: AgentRuntime, taskId?: string): AgentEvent[] {
  const events: AgentEvent[] = []
  runtime.onEvent((e) => {
    if (!taskId || e.taskId === taskId) events.push(e)
  })
  return events
}

function tick(ms = 0): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

describe('AgentRuntime', () => {
  it('acknowledges a task immediately before any work (seq 0 = agentTaskStarted)', () => {
    const runner = vi.fn(async () => {
      /* executor that does nothing */
    })
    const runtime = new AgentRuntime(runner)
    const events = collect(runtime)

    const { taskId, started } = runtime.start({
      requestId: 'r1',
      text: 'Where is auth handled?',
      surface: { page: 'home' },
    })

    expect(started).toBe(true)
    expect(taskId).toMatch(/^[0-9a-f-]{36}$/)
    expect(events[0]).toMatchObject({
      type: 'agentTaskStarted',
      taskId,
      seq: 0,
      title: 'Where is auth handled?',
    })
    expect(events.every((e) => e.taskId === taskId)).toBe(true)
  })

  it('emits monotonically increasing seq per task', async () => {
    const runtime = new AgentRuntime(async ({ emit }) => {
      emit.activity('Scanning repository')
      emit.activity('Searching auth entry points')
      emit.assistantStarted()
      emit.assistantDelta('a')
      emit.assistantDelta('b')
      emit.assistantCompleted()
    })
    const events = collect(runtime)
    const { taskId } = runtime.start({ requestId: 'r2', text: 'hi', surface: { page: 'home' } })
    await tick(5)

    const taskEvents = events.filter((e) => e.taskId === taskId)
    const seqs = taskEvents.map((e) => e.seq)
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b))
    expect(new Set(seqs).size).toBe(seqs.length)
    expect(taskEvents.at(-1)).toMatchObject({ type: 'agentTaskCompleted' })
  })

  it('streams assistant text and completes with partial state preserved', async () => {
    const runtime = new AgentRuntime(async ({ emit }) => {
      emit.assistantStarted()
      emit.assistantDelta('Hello ')
      emit.assistantDelta('world')
      emit.assistantCompleted()
    })
    const events = collect(runtime)
    runtime.start({ requestId: 'r3', text: 'hi', surface: { page: 'home' } })
    await tick(5)

    const deltas = events
      .filter((e): e is Extract<AgentEvent, { type: 'agentAssistantDelta' }> => e.type === 'agentAssistantDelta')
      .map((e) => e.text)
    expect(deltas.join('')).toBe('Hello world')

    const snapshot = events.find((e) => e.type === 'agentTaskCompleted')
    expect(snapshot).toBeTruthy()
  })

  it('duplicate requestId is idempotent — same task, executor not re-run', async () => {
    const runner = vi.fn(async ({ emit }) => {
      emit.assistantDelta('once')
    })
    const runtime = new AgentRuntime(runner)
    const events = collect(runtime)

    const first = runtime.start({ requestId: 'dup', text: 'hi', surface: { page: 'home' } })
    await tick(5)
    const second = runtime.start({ requestId: 'dup', text: 'hi', surface: { page: 'home' } })
    await tick(5)

    expect(second.taskId).toBe(first.taskId)
    expect(second.started).toBe(false)
    expect(runner).toHaveBeenCalledTimes(1)
    // started + delta + completed from the single run — nothing duplicated.
    expect(events.filter((e) => e.taskId === first.taskId)).toHaveLength(3)
  })

  it('cancel aborts the signal and emits agentTaskCancelled (no completion after)', async () => {
    const runtime = new AgentRuntime(async ({ handle, emit }) => {
      emit.activity('Working')
      while (!handle.signal.aborted) {
        await tick(10)
      }
      emit.activity('stopped') // must not reach the UI after cancel
    })
    const events = collect(runtime)
    const { taskId } = runtime.start({ requestId: 'c1', text: 'long task', surface: { page: 'home' } })
    await tick(20)

    expect(runtime.cancel(taskId)).toBe(true)
    await tick(30)

    const taskEvents = events.filter((e) => e.taskId === taskId)
    expect(taskEvents.some((e) => e.type === 'agentTaskCancelled')).toBe(true)
    expect(taskEvents.some((e) => e.type === 'agentTaskCompleted')).toBe(false)
    expect(taskEvents.some((e) => e.type === 'agentTaskFailed')).toBe(false)
    // Nothing streamed after the cancel event.
    const cancelIndex = taskEvents.findIndex((e) => e.type === 'agentTaskCancelled')
    expect(taskEvents.slice(cancelIndex + 1)).toEqual([])
  })

  it('keeps task event sequences increasing when cancellation uses a fresh emitter', async () => {
    const runtime = new AgentRuntime(async ({ handle, emit }) => {
      emit.activity('Working')
      while (!handle.signal.aborted) await tick(5)
    })
    const events = collect(runtime)
    const { taskId } = runtime.start({ requestId: 'seq-cancel', text: 'long task', surface: { page: 'home' } })
    await tick(10)
    runtime.cancel(taskId)

    const seqs = events.filter((event) => event.taskId === taskId).map((event) => event.seq)
    expect(seqs).toEqual([0, 1, 2])
  })

  it('cancel of an already-terminal task is a no-op', async () => {
    const runtime = new AgentRuntime(async () => {})
    const { taskId } = runtime.start({ requestId: 'c2', text: 'quick', surface: { page: 'home' } })
    await tick(5)
    expect(runtime.cancel(taskId)).toBe(false)
  })

  it('a second concurrent task fails visibly (one foreground task per session)', async () => {
    const runtime = new AgentRuntime(async ({ handle }) => {
      while (!handle.signal.aborted) await tick(10)
    })
    const events = collect(runtime)
    const first = runtime.start({ requestId: 'a', text: 'first', surface: { page: 'home' } })
    await tick(5)

    const second = runtime.start({ requestId: 'b', text: 'second', surface: { page: 'home' } })

    expect(second.started).toBe(true)
    const secondEvents = events.filter((e) => e.taskId === second.taskId)
    expect(secondEvents[0]).toMatchObject({ type: 'agentTaskStarted' })
    expect(secondEvents[1]).toMatchObject({ type: 'agentTaskFailed' })
    expect(String(secondEvents[1].type === 'agentTaskFailed' ? secondEvents[1].error : '')).toMatch(/still running/i)

    runtime.cancel(first.taskId)
  })

  it('executor rejection becomes agentTaskFailed with a normalized message', async () => {
    const runtime = new AgentRuntime(async () => {
      throw new Error('provider 500')
    })
    const events = collect(runtime)
    runtime.start({ requestId: 'e1', text: 'boom', surface: { page: 'home' } })
    await tick(5)

    const failed = events.find((e): e is Extract<AgentEvent, { type: 'agentTaskFailed' }> => e.type === 'agentTaskFailed')
    expect(failed).toBeTruthy()
    expect(failed!.error).toBe('provider 500')
  })

  it('sendSnapshot emits a snapshot reflecting partial stream state', async () => {
    const runtime = new AgentRuntime(async ({ handle, emit }) => {
      emit.activity('Searching 18 matching files')
      emit.assistantStarted()
      emit.assistantDelta('partial answer')
      while (!handle.signal.aborted) await tick(10)
    })
    const events = collect(runtime)
    const { taskId } = runtime.start({ requestId: 's1', text: 'snap', surface: { page: 'home' } })
    await tick(5)

    runtime.sendSnapshot()
    runtime.resume(taskId)

    const snapshots = events.filter(
      (e): e is Extract<AgentEvent, { type: 'agentSessionSnapshot' }> => e.type === 'agentSessionSnapshot',
    )
    expect(snapshots.length).toBeGreaterThanOrEqual(2)
    expect(snapshots[0].snapshot).toMatchObject({
      taskId,
      status: 'running',
      activities: ['Searching 18 matching files'],
      assistantText: 'partial answer',
    })

    runtime.cancel(taskId)
  })

  it('restores an interrupted task and resumes it with the durable payload (plan §14)', async () => {
    const resumePayloads: unknown[] = []
    const runtime = new AgentRuntime(async ({ handle, emit, resume }) => {
      resumePayloads.push(resume)
      emit.activity(`Resume payload present: ${Boolean(resume)}`)
      while (!handle.signal.aborted) await tick(10)
    })
    const events = collect(runtime)

    runtime.restoreTask({
      taskId: 'old-task',
      requestId: 'old-req',
      text: 'Generate ten documents',
      surface: { page: 'home' },
      title: 'Generate ten documents',
      status: 'running', // persisted mid-flight → interrupted
      assistantText: 'partial',
      activities: ['Planning analysis tasks'],
      documents: [],
    })

    // Interrupted tasks are not running until resumed.
    expect(runtime.interruptedTasks()).toEqual(['old-task'])
    expect(events.some((e) => e.type === 'agentTaskStarted')).toBe(false)
    // Plan §7 lifecycle: running → paused. The interruption surfaces the
    // agentTaskPaused event before any resume.
    const paused = events.find((e) => e.type === 'agentTaskPaused') as
      | Extract<AgentEvent, { type: 'agentTaskPaused' }>
      | undefined
    expect(paused).toBeTruthy()
    expect(paused!.reason).toContain('interrupted')

    runtime.resume('old-task', { graph: [], outputs: {} })
    await tick(10)

    expect(resumePayloads[0]).toEqual({ graph: [], outputs: {} })
    const activities = events
      .filter((e): e is Extract<AgentEvent, { type: 'agentActivity' }> => e.type === 'agentActivity')
      .map((e) => e.activity)
    expect(activities.some((a) => a.includes('Resuming task'))).toBe(true)
    expect(runtime.interruptedTasks()).toEqual([])

    runtime.cancel('old-task')
  })

  it('failInterrupted refuses a resume with a clear explanation', async () => {
    const runtime = new AgentRuntime(async () => {})
    const events = collect(runtime)
    runtime.restoreTask({
      taskId: 't-x',
      requestId: 'r-x',
      text: 'x',
      surface: { page: 'home' },
      title: 'x',
      status: 'running',
      assistantText: '',
      activities: [],
      documents: [],
    })
    runtime.failInterrupted('t-x', 'Repository changed — resume refused.')
    const failed = events.find((e) => e.type === 'agentTaskFailed') as
      | Extract<AgentEvent, { type: 'agentTaskFailed' }>
      | undefined
    expect(failed?.error).toContain('resume refused')
    expect(runtime.interruptedTasks()).toEqual([])
  })
})
