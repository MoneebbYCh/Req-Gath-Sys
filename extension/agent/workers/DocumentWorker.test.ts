import { describe, expect, it, vi } from 'vitest'
import { DocumentWorker } from './DocumentWorker'
import type { DocumentGateway, CheckpointResult, CreatedDocType } from './DocumentGateway'
import { FindingStore } from '../knowledge/FindingStore'
import { ProjectFactBase } from '../knowledge/ProjectFactBase'
import type { TaskNode } from '../contracts/TaskGraph'
import type { ModelProvider } from '../model/ModelProvider'
import type { ModelRequest } from '../model/ModelTypes'
import type { DocumentIR } from '../../documents/DocumentIR'
import { TaskBudgetController, type TaskTelemetryEvent } from '../observability/TaskControls'

/**
 * Scripted provider: first call answers the outline prompt, subsequent calls
 * answer section prompts with a fixed section block. Captures prompts so the
 * test can assert the fact base is injected (US-12.4).
 */
function scriptedProvider(record: { prompts: string[] }): ModelProvider {
  return {
    async *stream(request: ModelRequest) {
      record.prompts.push(request.messages[0]?.content ?? '')
      const isOutline = request.messages[0]?.content.includes('Outline the')
      const text = isOutline
        ? '{"sections":[{"heading":"Overview"},{"heading":"Facts"}]}'
        : '{"blocks":[{"type":"paragraph","text":"grounded text"}]}'
      yield { type: 'text_delta', text }
      yield { type: 'finish', reason: 'stop' }
    },
  }
}

function node(): TaskNode {
  return {
    id: 'n1',
    title: 'Security Architecture',
    objective: 'Write the Security Architecture document.',
    dependencies: [],
    roleSpec: {
      id: 'ws-1',
      workerType: 'document',
      role: 'Security Architecture Author',
      objective: 'Write the document',
      scope: { roots: ['*'] },
      questions: [],
      requiredCoverage: [],
      allowedTools: [],
      inputFindingIds: [],
      outputSchema: 'document-section',
      budget: {
        maxModelCalls: 8,
        maxToolCalls: 0,
        maxInputTokens: 20_000,
        maxOutputTokens: 8_000,
        maxParallelWorkers: 1,
        maxReplans: 1,
      },
    },
    requiredCoverage: [],
    requiredEvidence: [],
    status: 'queued',
    attempts: 0,
    budget: {
      maxModelCalls: 8,
      maxToolCalls: 0,
      maxInputTokens: 20_000,
      maxOutputTokens: 8_000,
      maxParallelWorkers: 1,
      maxReplans: 1,
    },
    outputs: [],
  }
}

function gateway(checkpoints: DocumentIR[]): DocumentGateway {
  let revision = 0
  return {
    create: async (name) => ({ id: `doc-${name.toLowerCase().replace(/\s+/g, '-')}`, name, icon: 'article', created: true } satisfies CreatedDocType),
    loadIR: async () => null,
    checkpoint: async (_documentId, baseRevision, ir) => {
      const current = revision
      if (current !== baseRevision) {
        return { ok: true, revision: current, conflict: true, pendingDraftId: 'draft-1' } satisfies CheckpointResult
      }
      revision++
      checkpoints.push(ir)
      return { ok: true, revision, conflict: false } satisfies CheckpointResult
    },
  }
}

function ctx() {
  const events = {
    declared: [] as string[],
    progress: [] as Array<{ status: string; completed: number; total: number; error?: string }>,
    checkpoints: [] as Array<{ completed: number; total: number; conflict?: boolean }>,
  }
  return {
    events,
    ctx: {
      signal: new AbortController().signal,
      activity: () => {},
      documentDeclared: (d: { title: string }) => {
        events.declared.push(d.title)
      },
      documentProgress: (d: {
        status: string
        completedSections: number
        totalSections: number
        error?: string
      }) => {
        events.progress.push({ status: d.status, completed: d.completedSections, total: d.totalSections, error: d.error })
      },
      documentCheckpoint: (i: { completedSections: number; totalSections: number; conflict?: boolean }) => {
        events.checkpoints.push({ completed: i.completedSections, total: i.totalSections, conflict: i.conflict })
      },
    },
  }
}

describe('DocumentWorker', () => {
  it('outlines, generates section-by-section, and checkpoints each section', async () => {
    const checkpoints: DocumentIR[] = []
    const facts = new ProjectFactBase()
    const findings = new FindingStore()
    const prompts: string[] = []

    const worker = new DocumentWorker({
      provider: scriptedProvider({ prompts }),
      baseConfig: { model: 'test' },
      findings,
      facts,
      gateway: gateway(checkpoints),
    })

    const { events, ctx: runCtx } = ctx()
    const result = await worker.run(node(), runCtx)

    // Outline + 2 section prompts = 3 model calls.
    expect(prompts).toHaveLength(3)
    expect(events.declared).toEqual(['Security Architecture'])
    // One checkpoint per section, each carrying the FULL document so far.
    expect(checkpoints).toHaveLength(2)
    expect(checkpoints[0].sections).toHaveLength(1)
    expect(checkpoints[1].sections).toHaveLength(2)
    expect(events.checkpoints).toEqual([
      { completed: 1, total: 2 },
      { completed: 2, total: 2 },
    ])
    expect(events.progress.at(-1)).toEqual({ status: 'completed', completed: 2, total: 2 })
    expect(result.completedSections).toBe(2)
  })

  it('injects the shared fact base into every prompt (US-12.4)', async () => {
    const checkpoints: DocumentIR[] = []
    const facts = new ProjectFactBase()
    const findings = new FindingStore()
    facts.upsert({
      id: 'f-1',
      claim: 'Node.js',
      type: 'observed',
      domain: 'runtime',
      evidenceIds: ['e-1'],
      confidence: 'high',
      assumptions: [],
      contradictions: [],
      repositoryVersion: 'rv',
    })
    const prompts: string[] = []

    const worker = new DocumentWorker({
      provider: scriptedProvider({ prompts }),
      baseConfig: { model: 'test' },
      findings,
      facts,
      gateway: gateway(checkpoints),
    })

    await worker.run(node(), ctx().ctx)
    expect(prompts.every((p) => p.includes('FACT runtime: Node.js'))).toBe(true)
  })

  it('uses provider JSON mode for outlines and document sections', async () => {
    const formats: Array<string | undefined> = []
    const provider: ModelProvider = {
      async *stream(request) {
        formats.push(request.responseFormat)
        const isOutline = request.messages[0]?.content.includes('Outline the')
        yield {
          type: 'text_delta',
          text: isOutline
            ? '{"sections":[{"heading":"Overview"}]}'
            : '{"blocks":[{"type":"paragraph","text":"grounded text"}]}',
        }
        yield { type: 'finish', reason: 'stop' }
      },
    }
    const worker = new DocumentWorker({
      provider,
      baseConfig: { model: 'test' },
      findings: new FindingStore(),
      facts: new ProjectFactBase(),
      gateway: gateway([]),
    })

    await worker.run(node(), ctx().ctx)

    expect(formats).toEqual(['json_object', 'json_object'])
  })

  it('checkpoints an editable warning and continues when a section stays structurally invalid', async () => {
    const checkpoints: DocumentIR[] = []
    let call = 0
    const provider: ModelProvider = {
      async *stream() {
        call++
        const text =
          call === 1
            ? '{"sections":[{"heading":"Project Setup"},{"heading":"Runtime"}]}'
            : call === 4
              ? '{"blocks":[{"type":"paragraph","text":"valid runtime guidance"}]}'
              : ''
        yield { type: 'text_delta', text }
        yield { type: 'finish', reason: 'stop' }
      },
    }
    const activities: string[] = []
    const worker = new DocumentWorker({
      provider,
      baseConfig: { model: 'test' },
      findings: new FindingStore(),
      facts: new ProjectFactBase(),
      gateway: gateway(checkpoints),
    })
    const { ctx: runCtx, events } = ctx()

    const result = await worker.run(node(), { ...runCtx, activity: (activity) => activities.push(activity) })

    expect(call).toBe(4)
    expect(checkpoints).toHaveLength(2)
    expect(checkpoints[0].sections[0].blocks).toEqual([
      expect.objectContaining({ type: 'callout', variant: 'warn', title: 'Section needs review' }),
    ])
    expect(checkpoints[1].sections[1].blocks).toEqual([
      { type: 'paragraph', text: 'valid runtime guidance' },
    ])
    expect(activities).toContain('Section structure could not be recovered; checkpointing an editable review notice')
    expect(events.progress.at(-1)).toEqual({ status: 'completed', completed: 2, total: 2 })
    expect(result.completedSections).toBe(2)
  })

  it('turns Markdown section output into editable paragraphs and lists without a retry', async () => {
    const checkpoints: DocumentIR[] = []
    const telemetry: TaskTelemetryEvent[] = []
    let call = 0
    const provider: ModelProvider = {
      async *stream() {
        call++
        const text =
          call === 1
            ? '{"sections":[{"heading":"Project Setup"}]}'
            : 'Configure the runtime before starting the service.\n\n- Copy `.env.example` to `.env`\n- Set the database connection string'
        yield { type: 'text_delta', text }
        yield { type: 'finish', reason: 'stop' }
      },
    }
    const worker = new DocumentWorker({
      provider,
      baseConfig: { model: 'test', telemetry: (event) => telemetry.push(event) },
      findings: new FindingStore(),
      facts: new ProjectFactBase(),
      gateway: gateway(checkpoints),
    })

    await worker.run(node(), ctx().ctx)

    expect(call).toBe(2)
    expect(checkpoints[0].sections[0].blocks).toEqual([
      { type: 'paragraph', text: 'Configure the runtime before starting the service.' },
      { type: 'bullets', items: ['Copy `.env.example` to `.env`', 'Set the database connection string'] },
    ])
    expect(telemetry).toContainEqual(expect.objectContaining({
      kind: 'document',
      documentEvent: 'section_parse_attempt',
      parseOutcome: 'markdown',
      responseBytes: expect.any(Number),
      blockCount: 2,
    }))
  })

  it('retries an empty JSON-mode section as Markdown and keeps it editable', async () => {
    const checkpoints: DocumentIR[] = []
    const formats: Array<string | undefined> = []
    let call = 0
    const provider: ModelProvider = {
      async *stream(request) {
        call++
        formats.push(request.responseFormat)
        const text =
          call === 1
            ? '{"sections":[{"heading":"Project Setup"}]}'
            : call === 2
              ? ''
              : 'Create a `.env` file and configure the application settings.'
        yield { type: 'text_delta', text }
        yield { type: 'finish', reason: 'stop' }
      },
    }
    const worker = new DocumentWorker({
      provider,
      baseConfig: { model: 'test' },
      findings: new FindingStore(),
      facts: new ProjectFactBase(),
      gateway: gateway(checkpoints),
    })

    await worker.run(node(), ctx().ctx)

    expect(formats).toEqual(['json_object', 'json_object', undefined])
    expect(checkpoints[0].sections[0].blocks).toEqual([
      { type: 'paragraph', text: 'Create a `.env` file and configure the application settings.' },
    ])
  })

  it('accepts valid kpiGrid and stakeholderTable blocks (rich shapes)', async () => {
    const checkpoints: DocumentIR[] = []
    const provider: ModelProvider = {
      async *stream(request) {
        const isOutline = request.messages[0]?.content.includes('Outline the')
        yield {
          type: 'text_delta',
          text: isOutline
            ? '{"sections":[{"heading":"Plan"}]}'
            : '{"blocks":[{"type":"kpiGrid","items":[{"metric":"Uptime","target":"99.9%","method":"SLA dashboards"}]},{"type":"stakeholderTable","rows":[{"nameRole":"Eng lead","interest":"H","influence":"M","concern":"scope creep"}]}]}',
        }
        yield { type: 'finish', reason: 'stop' }
      },
    }
    const worker = new DocumentWorker({
      provider,
      baseConfig: { model: 'test' },
      findings: new FindingStore(),
      facts: new ProjectFactBase(),
      gateway: gateway(checkpoints),
    })
    await worker.run(node(), ctx().ctx)
    expect(checkpoints).toHaveLength(1)
    expect(checkpoints[0].sections[0].blocks).toEqual([
      { type: 'kpiGrid', items: [{ metric: 'Uptime', target: '99.9%', method: 'SLA dashboards' }] },
      { type: 'stakeholderTable', rows: [{ nameRole: 'Eng lead', interest: 'H', influence: 'M', concern: 'scope creep' }] },
    ])
  })

  it('salvages a section when one block is invalid (keeps valid, coerces bad to callout)', async () => {
    const checkpoints: DocumentIR[] = []
    const provider: ModelProvider = {
      async *stream(request) {
        const isOutline = request.messages[0]?.content.includes('Outline the')
        yield {
          type: 'text_delta',
          text: isOutline
            ? '{"sections":[{"heading":"Components"}]}'
            : '{"blocks":[{"type":"paragraph","text":"valid frontend note"},{"type":"kpiGrid","items":[{"kpi":"wrong-field"}]}]}',
        }
        yield { type: 'finish', reason: 'stop' }
      },
    }
    const worker = new DocumentWorker({
      provider,
      baseConfig: { model: 'test' },
      findings: new FindingStore(),
      facts: new ProjectFactBase(),
      gateway: gateway(checkpoints),
    })
    await worker.run(node(), ctx().ctx)
    expect(checkpoints).toHaveLength(1)
    const blocks = checkpoints[0].sections[0].blocks
    expect(blocks).toHaveLength(2)
    expect(blocks[0]).toEqual({ type: 'paragraph', text: 'valid frontend note' })
    expect(blocks[1]).toMatchObject({ type: 'callout', variant: 'warn', title: 'Unsupported content' })
  })

  it('spells out the exact block shapes in section prompts', async () => {
    const prompts: string[] = []
    const worker = new DocumentWorker({
      provider: scriptedProvider({ prompts }),
      baseConfig: { model: 'test' },
      findings: new FindingStore(),
      facts: new ProjectFactBase(),
      gateway: gateway([]),
    })
    await worker.run(node(), ctx().ctx)
    const sectionPrompt = prompts.find((p) => !p.includes('Outline the'))!
    expect(sectionPrompt).toContain('kpiGrid')
    expect(sectionPrompt).toContain('stakeholderTable')
    expect(sectionPrompt).toContain('"metric"')
    expect(sectionPrompt).toContain('"nameRole"')
  })

  it('parks the draft and stops when the user edited the document mid-generation', async () => {
    const prompts: string[] = []
    const conflictGateway: DocumentGateway = {
      create: async (name) => ({ id: 'doc-x', name, icon: 'article', created: true }),
      loadIR: async () => null,
      checkpoint: async () => ({ ok: true, revision: 5, conflict: true, pendingDraftId: 'draft-9' }),
    }
    const worker = new DocumentWorker({
      provider: scriptedProvider({ prompts }),
      baseConfig: { model: 'test' },
      findings: new FindingStore(),
      facts: new ProjectFactBase(),
      gateway: conflictGateway,
    })

    const { events, ctx: runCtx } = ctx()
    const result = await worker.run(node(), runCtx)

    expect(result.conflict).toBe(true)
    expect(result.pendingDraftId).toBe('draft-9')
    expect(events.checkpoints.some((c) => c.conflict)).toBe(true)
    const failed = events.progress.find((p) => p.status === 'failed')
    expect(failed?.error).toContain('edited')
  })

  it('fails the node when the outline is invalid', async () => {
    const badProvider: ModelProvider = {
      async *stream() {
        yield { type: 'text_delta', text: 'no json here' }
        yield { type: 'finish', reason: 'stop' }
      },
    }
    const worker = new DocumentWorker({
      provider: badProvider,
      baseConfig: { model: 'test' },
      findings: new FindingStore(),
      facts: new ProjectFactBase(),
      gateway: gateway([]),
    })
    await expect(worker.run(node(), ctx().ctx)).rejects.toThrow(/outline/i)
  })

  it('marks the document failed when the shared task budget prevents generation', async () => {
    const worker = new DocumentWorker({
      provider: scriptedProvider({ prompts: [] }),
      baseConfig: { model: 'test' },
      findings: new FindingStore(),
      facts: new ProjectFactBase(),
      gateway: gateway([]),
    })
    const { events, ctx: runCtx } = ctx()
    const budgetController = new TaskBudgetController({
      maxModelCalls: 0,
      maxToolCalls: 0,
      maxInputTokens: 0,
      maxOutputTokens: 0,
      maxParallelWorkers: 1,
      maxReplans: 0,
    })

    await expect(worker.run(node(), { ...runCtx, budgetController })).rejects.toThrow(/budget/i)
    expect(events.progress.at(-1)).toMatchObject({ status: 'failed' })
    expect(events.progress.at(-1)?.error).toMatch(/budget/i)
  })

  it('regenerates ONLY the failed sections, keeping validated ones untouched (plan §13)', async () => {
    const storedIR: DocumentIR = {
      title: 'Security Architecture',
      sections: [
        { heading: 'Overview', blocks: [{ type: 'paragraph', text: 'keep me' }] },
        { heading: 'Auth', blocks: [{ type: 'paragraph', text: 'wrong claim' }] },
      ],
    }
    const prompts: string[] = []
    const checkpoints: DocumentIR[] = []
    let lastBaseRevision = -1

    const regenGateway: DocumentGateway = {
      create: async (name) => ({ id: 'doc-x', name, icon: 'article', created: true }),
      loadIR: async (documentId) => (documentId === 'doc-x' ? { ir: storedIR, revision: 7 } : null),
      checkpoint: async (documentId, baseRevision, ir) => {
        if (!documentId) return { ok: false, revision: 0, conflict: false, error: 'missing doc' }
        lastBaseRevision = baseRevision
        checkpoints.push(ir)
        return { ok: true, revision: baseRevision + 1, conflict: false } satisfies CheckpointResult
      },
    }

    const worker = new DocumentWorker({
      provider: scriptedProvider({ prompts }),
      baseConfig: { model: 'test' },
      findings: new FindingStore(),
      facts: new ProjectFactBase(),
      gateway: regenGateway,
    })

    const regenNode: TaskNode = {
      ...node(),
      id: 'n-regen',
      documentId: 'doc-x',
      regenerateSections: ['Auth'],
      objective: 'Validation feedback: Auth contradicts evidence.',
    }

    const { events, ctx: runCtx } = ctx()
    const result = await worker.run(regenNode, runCtx)

    // Only the failed section gets a model pass (no outline pass, no Overview pass).
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toContain('Auth')
    expect(prompts[0]).toContain('Validation feedback')
    // Checkpointed against the host's current revision (7).
    expect(lastBaseRevision).toBe(7)
    expect(checkpoints).toHaveLength(1)
    expect(checkpoints[0].sections).toHaveLength(2)
    expect(checkpoints[0].sections[0].blocks).toEqual([{ type: 'paragraph', text: 'keep me' }])
    expect(checkpoints[0].sections[1].blocks).toEqual([{ type: 'paragraph', text: 'grounded text' }])
    expect(result.completedSections).toBe(1)
    expect(events.progress.at(-1)).toMatchObject({ status: 'completed' })
    // Validation-facing payload carries the FULL updated document text.
    const payload = JSON.parse(result.outputs[0])
    expect(payload.documentId).toBe('doc-x')
    expect(payload.sectionTexts).toHaveLength(2)
    expect(payload.sectionTexts[0].text).toBe('keep me')
  })

  it('checkpoints an editable warning when targeted regeneration stays invalid', async () => {
    const storedIR: DocumentIR = {
      title: 'Security Architecture',
      sections: [
        { heading: 'Overview', blocks: [{ type: 'paragraph', text: 'keep me' }] },
        { heading: 'Auth', blocks: [{ type: 'paragraph', text: 'replace me' }] },
      ],
    }
    const checkpoints: DocumentIR[] = []
    const worker = new DocumentWorker({
      provider: {
        async *stream() {
          yield { type: 'text_delta', text: '' }
          yield { type: 'finish', reason: 'stop' }
        },
      },
      baseConfig: { model: 'test' },
      findings: new FindingStore(),
      facts: new ProjectFactBase(),
      gateway: {
        create: async (name) => ({ id: 'doc-x', name, icon: 'article', created: true }),
        loadIR: async () => ({ ir: storedIR, revision: 7 }),
        checkpoint: async (_documentId, baseRevision, ir) => {
          checkpoints.push(ir)
          return { ok: true, revision: baseRevision + 1, conflict: false }
        },
      },
    })
    const { ctx: runCtx, events } = ctx()

    const result = await worker.run(
      { ...node(), documentId: 'doc-x', regenerateSections: ['Auth'] },
      runCtx,
    )

    expect(checkpoints).toHaveLength(1)
    expect(checkpoints[0].sections[0].blocks).toEqual([{ type: 'paragraph', text: 'keep me' }])
    expect(checkpoints[0].sections[1].blocks).toEqual([
      expect.objectContaining({ type: 'callout', variant: 'warn', title: 'Section needs review' }),
    ])
    expect(events.progress.at(-1)).toMatchObject({ status: 'completed', completed: 1, total: 2 })
    expect(result.completedSections).toBe(1)
  })

  it('regeneration throws when no stored IR exists for the document', async () => {
    const worker = new DocumentWorker({
      provider: scriptedProvider({ prompts: [] }),
      baseConfig: { model: 'test' },
      findings: new FindingStore(),
      facts: new ProjectFactBase(),
      gateway: {
        create: async (name) => ({ id: 'doc-x', name, icon: 'article', created: true }),
        loadIR: async () => null,
        checkpoint: async () => ({ ok: true, revision: 0, conflict: false }),
      },
    })
    const regenNode: TaskNode = { ...node(), documentId: 'doc-x', regenerateSections: ['Auth'] }
    await expect(worker.run(regenNode, ctx().ctx)).rejects.toThrow(/no stored document IR/i)
  })

  it('resumes an interrupted document instead of creating a duplicate (plan §14)', async () => {
    const storedIR: DocumentIR = {
      title: 'Security Architecture',
      sections: [
        { heading: 'Overview', blocks: [{ type: 'paragraph', text: 'keep me' }] },
      ],
    }
    let created = 0
    const prompts: string[] = []
    const checkpoints: DocumentIR[] = []
    const resumeGateway: DocumentGateway = {
      create: async (name) => {
        created++
        return { id: 'doc-dup', name, icon: 'article', created: true }
      },
      loadIR: async () => ({ ir: storedIR, revision: 4 }),
      checkpoint: async (_documentId, baseRevision, ir) => {
        checkpoints.push(ir)
        return { ok: true, revision: baseRevision + 1, conflict: false } satisfies CheckpointResult
      },
    }

    const worker = new DocumentWorker({
      provider: scriptedProvider({ prompts }),
      baseConfig: { model: 'test' },
      findings: new FindingStore(),
      facts: new ProjectFactBase(),
      gateway: resumeGateway,
    })

    const resumeNode: TaskNode = {
      ...node(),
      id: 'n-resume-doc',
      documentId: 'doc-original',
    }

    const { events, ctx: runCtx } = ctx()
    const result = await worker.run(resumeNode, runCtx)

    // No duplicate document was created; the existing one was continued.
    expect(created).toBe(0)
    // Outline pass asks only for REMAINING sections + one new section pass.
    expect(prompts).toHaveLength(2)
    expect(prompts[0]).toContain('REMAINING')
    expect(prompts[0]).toContain('Overview')
    // Existing section preserved, new section appended, checkpointed at rev 4.
    expect(checkpoints).toHaveLength(1)
    expect(checkpoints[0].sections).toHaveLength(2)
    expect(checkpoints[0].sections[0].blocks).toEqual([{ type: 'paragraph', text: 'keep me' }])
    expect(result.documentId).toBe('doc-original')
    expect(events.progress.at(-1)).toMatchObject({ status: 'completed', total: 2 })
  })

  it('reports completed immediately when the resumed document was already finished', async () => {
    const fullIR: DocumentIR = {
      title: 'Security Architecture',
      sections: Array.from({ length: 12 }, (_, i) => ({
        heading: `S${i}`,
        blocks: [{ type: 'paragraph' as const, text: 'x' }],
      })),
    }
    let created = 0
    const worker = new DocumentWorker({
      provider: scriptedProvider({ prompts: [] }),
      baseConfig: { model: 'test' },
      findings: new FindingStore(),
      facts: new ProjectFactBase(),
      gateway: {
        create: async (name) => {
          created++
          return { id: 'doc-dup', name, icon: 'article', created: true }
        },
        loadIR: async () => ({ ir: fullIR, revision: 12 }),
        checkpoint: async () => ({ ok: true, revision: 0, conflict: false }),
      },
    })
    const resumeNode: TaskNode = { ...node(), documentId: 'doc-done' }
    const { events, ctx: runCtx } = ctx()
    const result = await worker.run(resumeNode, runCtx)
    expect(created).toBe(0)
    expect(result.completedSections).toBe(12)
    expect(events.progress.at(-1)).toMatchObject({ status: 'completed' })
  })

  it('repairs an invalid Mermaid diagram with one model pass before checkpointing', async () => {
    const checkpoints: DocumentIR[] = []
    const telemetry: TaskTelemetryEvent[] = []
    let sectionCalls = 0
    const provider: ModelProvider = {
      async *stream(request) {
        const content = request.messages[0]?.content ?? ''
        if (content.includes('Outline the')) {
          yield { type: 'text_delta', text: '{"sections":[{"heading":"Overview"},{"heading":"Facts"}]}' }
        } else if (content.includes('syntactically invalid')) {
          yield { type: 'text_delta', text: '{"diagrams":["flowchart TD\\n  A --> B"]}' }
        } else {
          sectionCalls++
          const text = sectionCalls === 1
            ? '{"blocks":[{"type":"mermaid","diagram":"flowchart INVALID"},{"type":"paragraph","text":"intro"}]}'
            : '{"blocks":[{"type":"paragraph","text":"facts"}]}'
          yield { type: 'text_delta', text }
        }
        yield { type: 'finish', reason: 'stop' }
      },
    }
    const mermaidValidator = vi.fn(async (source: string) =>
      source.includes('INVALID')
        ? { ok: false, error: 'Parse error on line 1: unexpected token' }
        : { ok: true, diagramType: 'flowchart' },
    )
    const worker = new DocumentWorker({
      provider,
      baseConfig: { model: 'test', telemetry: (event) => telemetry.push(event) },
      findings: new FindingStore(),
      facts: new ProjectFactBase(),
      gateway: gateway(checkpoints),
      mermaidValidator,
    })

    await worker.run(node(), ctx().ctx)

    // One parse failure + one successful re-validation for the repaired source.
    expect(telemetry).toContainEqual(expect.objectContaining({
      kind: 'document',
      documentEvent: 'mermaid_parse_attempt',
      ok: false,
    }))
    expect(telemetry).toContainEqual(expect.objectContaining({
      kind: 'document',
      documentEvent: 'mermaid_parse_attempt',
      ok: true,
    }))
    expect(checkpoints[0].sections[0].blocks).toEqual([
      { type: 'mermaid', diagram: 'flowchart TD\n  A --> B' },
      { type: 'paragraph', text: 'intro' },
    ])
  })

  it('downgrades a diagram that stays invalid after repair to an editable callout', async () => {
    const checkpoints: DocumentIR[] = []
    const telemetry: TaskTelemetryEvent[] = []
    let sectionCalls = 0
    const provider: ModelProvider = {
      async *stream(request) {
        const content = request.messages[0]?.content ?? ''
        if (content.includes('Outline the')) {
          yield { type: 'text_delta', text: '{"sections":[{"heading":"Overview"}]}' }
        } else if (content.includes('syntactically invalid')) {
          yield { type: 'text_delta', text: '{"diagrams":["flowchart STILL INVALID"]}' }
        } else {
          sectionCalls++
          if (sectionCalls === 1) {
            yield { type: 'text_delta', text: '{"blocks":[{"type":"mermaid","diagram":"flowchart INVALID"}]}' }
          }
        }
        yield { type: 'finish', reason: 'stop' }
      },
    }
    const mermaidValidator = vi.fn(async (source: string) =>
      source.includes('INVALID')
        ? { ok: false, error: 'Parse error on line 1: unexpected token' }
        : { ok: true, diagramType: 'flowchart' },
    )
    const worker = new DocumentWorker({
      provider,
      baseConfig: { model: 'test', telemetry: (event) => telemetry.push(event) },
      findings: new FindingStore(),
      facts: new ProjectFactBase(),
      gateway: gateway(checkpoints),
      mermaidValidator,
    })

    await worker.run(node(), ctx().ctx)

    expect(telemetry).toContainEqual(expect.objectContaining({
      kind: 'document',
      documentEvent: 'mermaid_fallback',
      ok: false,
    }))
    expect(checkpoints[0].sections[0].blocks).toEqual([
      {
        type: 'callout',
        variant: 'warn',
        title: 'Diagram needs review',
        text: 'flowchart INVALID',
      },
    ])
  })
})
