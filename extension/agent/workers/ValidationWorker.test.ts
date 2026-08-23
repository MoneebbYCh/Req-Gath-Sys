import { describe, expect, it } from 'vitest'
import { ValidationWorker } from './ValidationWorker'
import { EvidenceLedger } from '../knowledge/EvidenceLedger'
import { FindingStore } from '../knowledge/FindingStore'
import { ProjectFactBase } from '../knowledge/ProjectFactBase'
import type { TaskNode } from '../contracts/TaskGraph'
import type { RepositoryToolName } from '../contracts/ToolDefinition'
import type { ModelProvider } from '../model/ModelProvider'
import type { ModelRequest } from '../model/ModelTypes'
import type { ToolExecutor } from '../model/toolLoopTaskRunner'
import type { NodeRunContext } from '../runtime/OrchestratorRunner'

/**
 * Phase 13 tests. The provider is scripted: claim-validation prompts answer
 * with a fixed JSON block; cross-document prompts answer with contradictions.
 * The executor is a fake host gateway — evidence re-reads return whatever
 * content hash the test wants.
 */

function node(kind: 'document' | 'cross-document' = 'document', allowedTools: RepositoryToolName[] = []): TaskNode {
  return {
    id: kind === 'document' ? 'n-val-1' : 'n-cross-1',
    title: kind === 'document' ? 'Validate PRD' : 'Check cross-document consistency',
    objective: `Validate.`,
    dependencies: [],
    roleSpec: {
      id: 'ws-val',
      workerType: 'validation',
      validationKind: kind,
      role: kind === 'document' ? 'Document Claim Validator' : 'Cross-Document Consistency Validator',
      objective: 'Validate.',
      scope: { roots: ['*'] },
      questions: [],
      requiredCoverage: [],
      allowedTools,
      inputFindingIds: [],
      outputSchema: 'validation',
      budget: {
        maxModelCalls: 4,
        maxToolCalls: 6,
        maxInputTokens: 30_000,
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
      maxModelCalls: 4,
      maxToolCalls: 6,
      maxInputTokens: 30_000,
      maxOutputTokens: 8_000,
      maxParallelWorkers: 1,
      maxReplans: 1,
    },
    outputs: [],
  }
}

function jsonProvider(record: { prompts: string[] }, jsonText: string): ModelProvider {
  return {
    async *stream(request: ModelRequest) {
      record.prompts.push(request.messages[0]?.content ?? '')
      yield { type: 'text_delta', text: '```json\n' + jsonText + '\n```' }
      yield { type: 'finish', reason: 'stop' }
    },
  }
}

/** Provider that answers each prompt from a queue — for repair-retry tests. */
function queueProvider(record: { prompts: string[] }, responses: string[]): ModelProvider {
  return {
    async *stream(request: ModelRequest) {
      record.prompts.push(request.messages[0]?.content ?? '')
      const next = responses.shift() ?? 'not valid json'
      yield { type: 'text_delta', text: '```json\n' + next + '\n```' }
      yield { type: 'finish', reason: 'stop' }
    },
  }
}

function executorWith(responses: Array<{ ok: boolean; result?: unknown; error?: string }>): {
  executor: ToolExecutor
  calls: Array<{ name: string; input: unknown }>
} {
  const calls: Array<{ name: string; input: unknown }> = []
  return {
    calls,
    executor: {
      execute: async (name, input) => {
        calls.push({ name, input })
        return responses.shift() ?? { ok: false, error: 'unexpected call' }
      },
    },
  }
}

function ctx(
  deps: string[],
  progress: string[] = [],
): NodeRunContext & { progress: string[]; statusEvents: Array<{ documentId?: string; finalStatus?: string }> } {
  const statusEvents: Array<{ documentId?: string; finalStatus?: string }> = []
  return {
    signal: new AbortController().signal,
    activity: () => {},
    delta: () => {},
    dependencyOutputs: deps,
    documentDeclared: () => {},
    documentProgress: () => {},
    documentCheckpoint: () => {},
    validationProgress: (i) => {
      progress.push(`${i.phase}:${i.message}${i.finalStatus ? ` (${i.finalStatus})` : ''}`)
      statusEvents.push({ documentId: i.documentId, finalStatus: i.finalStatus })
    },
    progress,
    statusEvents,
  }
}

const DOC_OUTPUT = JSON.stringify({
  documentId: 'doc-1',
  title: 'PRD',
  sectionTexts: [
    { heading: 'Overview', text: 'The service uses Node.js.' },
    { heading: 'Auth', text: 'Authentication is enforced by middleware in src/auth.' },
  ],
})

describe('ValidationWorker — document mode', () => {
  it('detects stale evidence deterministically (file changed since read)', async () => {
    const evidence = new EvidenceLedger()
    const findings = new FindingStore()
    const facts = new ProjectFactBase()
    const { id: evidenceId } = evidence.record(
      {
        path: 'src/main.ts',
        startLine: 1,
        endLine: 5,
        excerpt: 'const x = 1',
        kind: 'source',
        sourceTool: 'read_file_range',
        contentHash: 'old-hash',
      },
      'rv-1',
    )
    facts.upsert({
      id: 'f-1',
      claim: 'Node.js',
      type: 'observed',
      domain: 'runtime',
      evidenceIds: [evidenceId],
      confidence: 'high',
      assumptions: [],
      contradictions: [],
      repositoryVersion: 'rv-1',
    })

    // The re-read returns a DIFFERENT hash → stale.
    const { executor, calls } = executorWith([
      {
        ok: true,
        result: {
          repositoryVersion: 'rv-1',
          evidenceCandidates: [{ path: 'src/main.ts', startLine: 1, endLine: 5, contentHash: 'new-hash', excerpt: 'const x = 2' }],
        },
      },
    ])
    const prompts: string[] = []
    const worker = new ValidationWorker({
      provider: jsonProvider({ prompts }, '{"claims":[]}'),
      executor,
      baseConfig: { model: 'test' },
      findings,
      facts,
      evidence,
    })

    const runCtx = ctx([DOC_OUTPUT])
    const result = await worker.run(node('document'), runCtx)

    expect(calls[0]).toMatchObject({ name: 'read_file_range', input: { path: 'src/main.ts', startLine: 1, endLine: 5 } })
    const report = JSON.parse(result.outputs[0])
    expect(report.mode).toBe('document')
    expect(report.staleEvidenceIds).toContain(evidenceId)
    expect(report.issues.join(' ')).toMatch(/stale/)
    // Stale evidence is a caveat, not a document failure (acceptance §13).
    expect(report.status).toBe('issues')
    expect(result.followups).toHaveLength(0)
    // Dependent findings/facts are flagged for revalidation (plan §7).
    expect(facts.needsRevalidation(facts.all()[0])).toBe(true)
  })

  it('fails contradicted current-state claims and queues targeted regeneration', async () => {
    const evidence = new EvidenceLedger()
    const findings = new FindingStore()
    const facts = new ProjectFactBase()
    const prompts: string[] = []
    const worker = new ValidationWorker({
      provider: jsonProvider(
        { prompts },
        JSON.stringify({
          claims: [
            {
              claim: 'Authentication is enforced by middleware in src/auth.',
              kind: 'current',
              verdict: 'contradicted',
              evidenceIds: [],
              sectionHeading: 'Auth',
              note: 'src/auth does not contain middleware.',
            },
            {
              claim: 'The service will use gRPC next quarter.',
              kind: 'proposed',
              verdict: 'contradicted',
              evidenceIds: [],
              sectionHeading: 'Overview',
              note: 'Current transport is REST.',
            },
          ],
        }),
      ),
      executor: { execute: async () => ({ ok: false, error: 'unused' }) },
      baseConfig: { model: 'test' },
      findings,
      facts,
      evidence,
    })

    const progress: string[] = []
    const result = await worker.run(node('document'), ctx([DOC_OUTPUT], progress))

    const report = JSON.parse(result.outputs[0])
    expect(report.status).toBe('failed')
    expect(report.failedSections).toEqual(['Auth'])
    // Proposed claims are flagged but never trigger regeneration.
    expect(report.issues.some((i: string) => i.includes('Proposed claim'))).toBe(true)

    expect(result.followups).toHaveLength(1)
    expect(result.followups[0]).toMatchObject({
      kind: 'regenerate-section',
      documentId: 'doc-1',
      sectionHeading: 'Auth',
      dependencies: ['n-val-1'],
    })
    expect(progress.some((p) => p.includes('(failed)'))).toBe(true)
  })

  it('passes when claims are supported and evidence is current', async () => {
    const evidence = new EvidenceLedger()
    const findings = new FindingStore()
    const facts = new ProjectFactBase()
    const prompts: string[] = []
    const worker = new ValidationWorker({
      provider: jsonProvider(
        { prompts },
        JSON.stringify({
          claims: [
            {
              claim: 'The service uses Node.js.',
              kind: 'current',
              verdict: 'supported',
              evidenceIds: [],
              sectionHeading: 'Overview',
              note: '',
            },
          ],
        }),
      ),
      executor: { execute: async () => ({ ok: false, error: 'unused' }) },
      baseConfig: { model: 'test' },
      findings,
      facts,
      evidence,
    })

    const result = await worker.run(node('document'), ctx([DOC_OUTPUT]))
    const report = JSON.parse(result.outputs[0])
    expect(report.status).toBe('passed')
    expect(report.failedSections).toHaveLength(0)
    expect(result.followups).toHaveLength(0)
  })

  it('degrades to caveats when the document content is unavailable (conflict/cancel)', async () => {
    const worker = new ValidationWorker({
      provider: jsonProvider({ prompts: [] }, '{"claims":[]}'),
      executor: { execute: async () => ({ ok: false, error: 'unused' }) },
      baseConfig: { model: 'test' },
      findings: new FindingStore(),
      facts: new ProjectFactBase(),
      evidence: new EvidenceLedger(),
    })
    const result = await worker.run(node('document'), ctx([]))
    const report = JSON.parse(result.outputs[0])
    expect(report.status).toBe('issues')
    expect(report.issues.join(' ')).toMatch(/unavailable/)
    expect(result.followups).toHaveLength(0)
  })

  it('treats an unparseable validator response as a validation gap, not a regeneration', async () => {
    const worker = new ValidationWorker({
      provider: jsonProvider({ prompts: [] }, 'not valid json'),
      executor: { execute: async () => ({ ok: false, error: 'unused' }) },
      baseConfig: { model: 'test' },
      findings: new FindingStore(),
      facts: new ProjectFactBase(),
      evidence: new EvidenceLedger(),
    })
    const result = await worker.run(node('document'), ctx([DOC_OUTPUT]))
    const report = JSON.parse(result.outputs[0])
    expect(report.issues.join(' ')).toMatch(/validation gap/)
    expect(result.followups).toHaveLength(0)
  })

  it('repairs an unparseable claim response with one JSON-only retry (plan §14)', async () => {
    const prompts: string[] = []
    const worker = new ValidationWorker({
      provider: queueProvider(
        { prompts },
        [
          'not valid json',
          JSON.stringify({
            claims: [
              {
                claim: 'The service uses Node.js.',
                kind: 'current',
                verdict: 'supported',
                evidenceIds: [],
                sectionHeading: 'Overview',
                note: '',
              },
            ],
          }),
        ],
      ),
      executor: { execute: async () => ({ ok: false, error: 'unused' }) },
      baseConfig: { model: 'test' },
      findings: new FindingStore(),
      facts: new ProjectFactBase(),
      evidence: new EvidenceLedger(),
    })

    const result = await worker.run(node('document'), ctx([DOC_OUTPUT]))
    const report = JSON.parse(result.outputs[0])
    expect(prompts).toHaveLength(2)
    expect(prompts[1]).toMatch(/not valid JSON/)
    expect(report.claims).toHaveLength(1)
    expect(report.status).toBe('passed')
    expect(report.issues).toHaveLength(0)
  })

  it('keeps the validation gap when the repair pass fails too', async () => {
    const prompts: string[] = []
    const worker = new ValidationWorker({
      provider: queueProvider({ prompts }, ['not valid json', 'still not json']),
      executor: { execute: async () => ({ ok: false, error: 'unused' }) },
      baseConfig: { model: 'test' },
      findings: new FindingStore(),
      facts: new ProjectFactBase(),
      evidence: new EvidenceLedger(),
    })
    const result = await worker.run(node('document'), ctx([DOC_OUTPUT]))
    const report = JSON.parse(result.outputs[0])
    expect(prompts).toHaveLength(2)
    expect(report.issues.join(' ')).toMatch(/validation gap/)
    expect(report.status).toBe('issues')
    expect(result.followups).toHaveLength(0)
  })

  it('surfaces missing required coverage deterministically (plan §18)', async () => {
    const worker = new ValidationWorker({
      provider: jsonProvider(
        { prompts: [] },
        JSON.stringify({
          claims: [
            {
              claim: 'The service uses Node.js.',
              kind: 'current',
              verdict: 'supported',
              evidenceIds: [],
              sectionHeading: 'Overview',
              note: '',
            },
          ],
        }),
      ),
      executor: { execute: async () => ({ ok: false, error: 'unused' }) },
      baseConfig: { model: 'test' },
      findings: new FindingStore(),
      facts: new ProjectFactBase(),
      evidence: new EvidenceLedger(),
    })
    const coverageNode = node('document')
    coverageNode.roleSpec = { ...coverageNode.roleSpec, requiredCoverage: ['auth', 'storage'] }

    const result = await worker.run(coverageNode, ctx([DOC_OUTPUT]))
    const report = JSON.parse(result.outputs[0])
    // 'auth' is covered by the document's Auth section; 'storage' is not.
    expect(report.issues.join(' ')).toMatch(/Missing required coverage: "storage"/)
    expect(report.issues.join(' ')).not.toMatch(/"auth"/)
    expect(report.status).toBe('issues')
    expect(result.followups).toHaveLength(0)
  })

  it('accepts an explicit unknown finding as required coverage (plan §18)', async () => {
    const findings = new FindingStore()
    findings.add({
      claim: 'Storage technology is not yet determined.',
      type: 'unknown',
      domain: 'storage',
      evidenceIds: [],
      confidence: 'low',
      assumptions: [],
      contradictions: [],
      repositoryVersion: 'rv-1',
    })
    const worker = new ValidationWorker({
      provider: jsonProvider(
        { prompts: [] },
        JSON.stringify({
          claims: [
            {
              claim: 'The service uses Node.js.',
              kind: 'current',
              verdict: 'supported',
              evidenceIds: [],
              sectionHeading: 'Overview',
              note: '',
            },
          ],
        }),
      ),
      executor: { execute: async () => ({ ok: false, error: 'unused' }) },
      baseConfig: { model: 'test' },
      findings,
      facts: new ProjectFactBase(),
      evidence: new EvidenceLedger(),
    })
    const coverageNode = node('document')
    coverageNode.roleSpec = { ...coverageNode.roleSpec, requiredCoverage: ['storage'] }

    const result = await worker.run(coverageNode, ctx([DOC_OUTPUT]))
    const report = JSON.parse(result.outputs[0])
    expect(report.issues).toHaveLength(0)
    expect(report.status).toBe('passed')
  })

  it('caveats when a referenced symbol is not resolvable (plan §18)', async () => {
    const evidence = new EvidenceLedger()
    const findings = new FindingStore()
    const facts = new ProjectFactBase()
    const { id: evidenceId } = evidence.record(
      {
        path: 'src/main.ts',
        startLine: 1,
        endLine: 5,
        excerpt: 'export function login()',
        kind: 'source',
        sourceTool: 'read_file_range',
        contentHash: 'old-hash',
        symbol: 'login',
      },
      'rv-1',
    )
    facts.upsert({
      id: 'f-1',
      claim: 'Auth exists.',
      type: 'observed',
      domain: 'auth',
      evidenceIds: [evidenceId],
      confidence: 'high',
      assumptions: [],
      contradictions: [],
      repositoryVersion: 'rv-1',
    })

    const { executor, calls } = executorWith([
      {
        ok: true,
        result: {
          repositoryVersion: 'rv-1',
          evidenceCandidates: [{ path: 'src/main.ts', startLine: 1, endLine: 5, contentHash: 'old-hash', excerpt: 'export function login()' }],
        },
      },
      { ok: false, error: 'no language server' },
    ])
    const worker = new ValidationWorker({
      provider: jsonProvider({ prompts: [] }, '{"claims":[]}'),
      executor,
      baseConfig: { model: 'test' },
      findings,
      facts,
      evidence,
    })

    const result = await worker.run(node('document'), ctx([DOC_OUTPUT]))
    const report = JSON.parse(result.outputs[0])
    expect(calls[1]).toMatchObject({ name: 'find_definition', input: { path: 'src/main.ts', line: 1 } })
    expect(report.issues.join(' ')).toMatch(/symbol "login" is not resolvable/)
    expect(report.staleEvidenceIds).toHaveLength(0)
    expect(report.status).toBe('issues')
  })

  it('caveats when the repository version moved on (plan §18)', async () => {
    const evidence = new EvidenceLedger()
    const facts = new ProjectFactBase()
    const { id: evidenceId } = evidence.record(
      {
        path: 'src/main.ts',
        startLine: 1,
        endLine: 5,
        excerpt: 'const x = 1',
        kind: 'source',
        sourceTool: 'read_file_range',
        contentHash: 'old-hash',
      },
      'rv-1',
    )
    facts.upsert({
      id: 'f-1',
      claim: 'Node.js',
      type: 'observed',
      domain: 'runtime',
      evidenceIds: [evidenceId],
      confidence: 'high',
      assumptions: [],
      contradictions: [],
      repositoryVersion: 'rv-1',
    })
    const { executor } = executorWith([
      {
        ok: true,
        result: {
          repositoryVersion: 'rv-2',
          evidenceCandidates: [{ path: 'src/main.ts', startLine: 1, endLine: 5, contentHash: 'old-hash', excerpt: 'const x = 1' }],
        },
      },
    ])
    const worker = new ValidationWorker({
      provider: jsonProvider({ prompts: [] }, '{"claims":[]}'),
      executor,
      baseConfig: { model: 'test' },
      findings: new FindingStore(),
      facts,
      evidence,
    })

    const result = await worker.run(node('document'), ctx([DOC_OUTPUT]))
    const report = JSON.parse(result.outputs[0])
    expect(report.issues.join(' ')).toMatch(/repository version rv-1/)
    expect(report.issues.join(' ')).toMatch(/rv-2/)
    expect(report.staleEvidenceIds).toHaveLength(0)
  })

  it('refreshes stale symbol evidence via find_definition instead of dropping it (plan §12/§13)', async () => {
    const evidence = new EvidenceLedger()
    const findings = new FindingStore()
    const facts = new ProjectFactBase()
    const { id: evidenceId } = evidence.record(
      {
        path: 'src/main.ts',
        startLine: 1,
        endLine: 5,
        excerpt: 'export function login()',
        kind: 'source',
        sourceTool: 'read_file_range',
        contentHash: 'old-hash',
        symbol: 'login',
      },
      'rv-1',
    )
    facts.upsert({
      id: 'f-1',
      claim: 'Auth exists.',
      type: 'observed',
      domain: 'auth',
      evidenceIds: [evidenceId],
      confidence: 'high',
      assumptions: [],
      contradictions: [],
      repositoryVersion: 'rv-1',
    })

    // Hash changed → stale; the symbol re-resolves to a shifted range → refreshed.
    const { executor, calls } = executorWith([
      {
        ok: true,
        result: {
          repositoryVersion: 'rv-1',
          evidenceCandidates: [{ path: 'src/main.ts', startLine: 1, endLine: 5, contentHash: 'new-hash', excerpt: 'export function login()' }],
        },
      },
      { ok: true, result: { locations: [{ path: 'src/main.ts', startLine: 20, endLine: 24 }] } },
    ])
    const worker = new ValidationWorker({
      provider: jsonProvider({ prompts: [] }, '{"claims":[]}'),
      executor,
      baseConfig: { model: 'test' },
      findings,
      facts,
      evidence,
    })

    const result = await worker.run(node('document'), ctx([DOC_OUTPUT]))
    const report = JSON.parse(result.outputs[0])
    expect(calls[1]).toMatchObject({ name: 'find_definition', input: { path: 'src/main.ts', line: 1 } })
    // Refreshed evidence left the stale set — a caveat, not dropped evidence.
    expect(report.staleEvidenceIds).toHaveLength(0)
    expect(report.issues.join(' ')).toMatch(/refreshed by re-resolving/)
    expect(report.issues.join(' ')).not.toMatch(/is stale/)
    expect(evidence.get(evidenceId)?.range).toEqual({ startLine: 20, endLine: 24 })
    expect(facts.needsRevalidation(facts.all()[0])).toBe(false)
  })

  it('emits the validating transition with documentId and no finalStatus, then a final status (plan §17)', async () => {
    const worker = new ValidationWorker({
      provider: jsonProvider(
        { prompts: [] },
        JSON.stringify({
          claims: [
            {
              claim: 'The service uses Node.js.',
              kind: 'current',
              verdict: 'supported',
              evidenceIds: [],
              sectionHeading: 'Overview',
              note: '',
            },
          ],
        }),
      ),
      executor: { execute: async () => ({ ok: false, error: 'unused' }) },
      baseConfig: { model: 'test' },
      findings: new FindingStore(),
      facts: new ProjectFactBase(),
      evidence: new EvidenceLedger(),
    })

    const runCtx = ctx([DOC_OUTPUT])
    const result = await worker.run(node('document'), runCtx)
    const report = JSON.parse(result.outputs[0])
    expect(report.status).toBe('passed')

    // First emission flips the doc row to 'validating' (documentId, no finalStatus).
    expect(runCtx.statusEvents[0]).toEqual({ documentId: 'doc-1', finalStatus: undefined })
    expect(runCtx.statusEvents.at(-1)).toEqual({ documentId: 'doc-1', finalStatus: 'completed' })
  })
})

describe('ValidationWorker — cross-document mode', () => {
  const reportA = {
    mode: 'document',
    documentId: 'doc-1',
    title: 'PRD',
    status: 'passed',
    claims: [{ claim: 'The system uses PostgreSQL.', kind: 'current', verdict: 'supported', evidenceIds: [], note: '' }],
    staleEvidenceIds: [],
    failedSections: [],
    issues: [],
  }
  const reportB = {
    mode: 'document',
    documentId: 'doc-2',
    title: 'System Architecture',
    status: 'passed',
    claims: [{ claim: 'The system uses MongoDB.', kind: 'current', verdict: 'supported', evidenceIds: [], note: '' }],
    staleEvidenceIds: [],
    failedSections: [],
    issues: [],
  }

  it('reports unresolved contradictions when the fact base cannot settle them', async () => {
    const facts = new ProjectFactBase()
    const prompts: string[] = []
    const worker = new ValidationWorker({
      provider: jsonProvider(
        { prompts },
        JSON.stringify({
          contradictions: [
            { a: 'The system uses PostgreSQL.', b: 'The system uses MongoDB.', note: 'conflicting storage claims' },
          ],
        }),
      ),
      executor: { execute: async () => ({ ok: false, error: 'unused' }) },
      baseConfig: { model: 'test' },
      findings: new FindingStore(),
      facts,
      evidence: new EvidenceLedger(),
    })

    const progress: string[] = []
    const result = await worker.run(node('cross-document'), ctx([JSON.stringify(reportA), JSON.stringify(reportB)], progress))

    const report = JSON.parse(result.outputs[0])
    expect(report.mode).toBe('cross-document')
    expect(report.status).toBe('issues')
    expect(report.contradictions).toHaveLength(1)
    expect(report.contradictions[0].resolved).toBe(false)
    expect(report.issues.join(' ')).toMatch(/Unresolved contradiction/)
    expect(progress.some((p) => p.includes('unresolved contradiction'))).toBe(true)
  })

  it('resolves contradictions deterministically against the fact base', async () => {
    const facts = new ProjectFactBase()
    facts.upsert({
      id: 'f-1',
      claim: 'The system uses PostgreSQL.',
      type: 'observed',
      domain: 'storage',
      evidenceIds: ['e-1'],
      confidence: 'high',
      assumptions: [],
      contradictions: [],
      repositoryVersion: 'rv-1',
    })
    const prompts: string[] = []
    const worker = new ValidationWorker({
      provider: jsonProvider(
        { prompts },
        JSON.stringify({
          contradictions: [
            { a: 'The system uses PostgreSQL.', b: 'The system uses MongoDB.', note: 'conflicting storage claims' },
          ],
        }),
      ),
      executor: { execute: async () => ({ ok: false, error: 'unused' }) },
      baseConfig: { model: 'test' },
      findings: new FindingStore(),
      facts,
      evidence: new EvidenceLedger(),
    })

    const result = await worker.run(node('cross-document'), ctx([JSON.stringify(reportA), JSON.stringify(reportB)]))
    const report = JSON.parse(result.outputs[0])
    expect(report.status).toBe('passed')
    expect(report.contradictions[0].resolved).toBe(true)
    expect(report.contradictions[0].resolution).toContain('PostgreSQL')
  })

  it('passes when there are not enough claims to compare', async () => {
    const worker = new ValidationWorker({
      provider: jsonProvider({ prompts: [] }, '{}'),
      executor: { execute: async () => ({ ok: false, error: 'unused' }) },
      baseConfig: { model: 'test' },
      findings: new FindingStore(),
      facts: new ProjectFactBase(),
      evidence: new EvidenceLedger(),
    })
    const result = await worker.run(node('cross-document'), ctx([JSON.stringify(reportA)]))
    const report = JSON.parse(result.outputs[0])
    expect(report.status).toBe('passed')
    expect(report.contradictions).toHaveLength(0)
  })
})
