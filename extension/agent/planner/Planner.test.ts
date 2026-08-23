import { describe, expect, it } from 'vitest'
import { Planner } from './Planner'
import type { ModelProvider } from '../model/ModelProvider'

describe('Planner', () => {
  it('produces coverage-area nodes for a security request', () => {
    const nodes = new Planner().plan('Audit the security of this repository.')
    expect(nodes.length).toBeGreaterThanOrEqual(3)
    expect(nodes.every((n) => n.status === 'queued')).toBe(true)
    expect(nodes.map((n) => n.title)).toContain('Authentication entry points')
    expect(nodes.map((n) => n.title)).toContain('Secrets and credential handling')
    // Distinct ids, no dependencies in the initial graph (acyclic by construction).
    expect(new Set(nodes.map((n) => n.id)).size).toBe(nodes.length)
    expect(nodes.every((n) => n.dependencies.length === 0)).toBe(true)
  })

  it('uses the architecture playbook for architecture requests', () => {
    const nodes = new Planner().plan('Analyze the complete architecture of this codebase.')
    expect(nodes.map((n) => n.title)).toContain('System boundaries and modules')
    expect(nodes.map((n) => n.title)).toContain('Data flow and persistence')
  })

  it('falls back to generic coverage areas when no playbook matches', () => {
    const nodes = new Planner().plan('Review the entire repository in depth.')
    expect(nodes.length).toBeGreaterThan(0)
    expect(nodes.every((n) => n.roleSpec.workerType === 'analysis')).toBe(true)
  })

  it('respects the max node cap', () => {
    const nodes = new Planner({ maxNodes: 2 }).plan('Audit security and scalability of the codebase.')
    expect(nodes.length).toBeLessThanOrEqual(2)
  })

  it('gives every node a budget and read-only tool access', () => {
    const [node] = new Planner({ maxNodes: 1 }).plan('Audit the codebase security.')
    expect(node.budget.maxModelCalls).toBeGreaterThan(0)
    expect(node.roleSpec.allowedTools).not.toContain('write_file')
    expect(node.requiredCoverage).toContain(node.title)
  })

  it('plans document requests: analysis first, document nodes depend on them (plan §12)', () => {
    const nodes = new Planner({ maxNodes: 40 }).plan('Generate ten project documents for this repository.')
    const documents = nodes.filter((n) => n.roleSpec.workerType === 'document')
    const analysis = nodes.filter((n) => n.roleSpec.workerType === 'analysis')

    expect(documents).toHaveLength(10)
    expect(analysis.length).toBeGreaterThan(0)
    // Document production is parallelized; repository truth is analyzed once.
    expect(documents.every((d) => analysis.every((a) => d.dependencies.includes(a.id)))).toBe(true)
    // Document workers consume the fact base — no repository tools.
    expect(documents.every((d) => d.roleSpec.allowedTools.length === 0)).toBe(true)
    // A document needs an outline plus bounded per-section generation calls.
    expect(documents.every((d) => d.budget.maxModelCalls >= 25)).toBe(true)
    // Distinct ids (acyclic by construction).
    expect(new Set(nodes.map((n) => n.id)).size).toBe(nodes.length)
  })

  it('plans validation nodes per document plus a cross-document consistency node (plan §13)', () => {
    const nodes = new Planner({ maxNodes: 40 }).plan('Generate ten project documents for this repository.')
    const documents = nodes.filter((n) => n.roleSpec.workerType === 'document' && !n.regenerateSections)
    const validations = nodes.filter(
      (n) => n.roleSpec.workerType === 'validation' && n.roleSpec.validationKind === 'document',
    )
    const cross = nodes.filter(
      (n) => n.roleSpec.workerType === 'validation' && n.roleSpec.validationKind === 'cross-document',
    )

    expect(validations).toHaveLength(documents.length)
    // Every document node has a validation node depending on it.
    expect(documents.every((d) => validations.some((v) => v.dependencies.includes(d.id)))).toBe(true)
    // One cross-document node depending on every validation.
    expect(cross).toHaveLength(1)
    expect(cross[0].dependencies).toEqual(validations.map((v) => v.id))
    // Validation may re-read evidence; it never gets non-read-only tools.
    expect(validations.every((v) => v.roleSpec.allowedTools.includes('read_file_range'))).toBe(true)
    expect(validations.every((v) => !v.roleSpec.allowedTools.includes('get_git_diff'))).toBe(true)
  })

  it('omits the cross-document node for a single document', () => {
    const nodes = new Planner({ maxNodes: 8 }).plan('Create a security architecture document for the codebase.')
    expect(nodes.filter((n) => n.roleSpec.workerType === 'validation')).toHaveLength(1)
    expect(nodes.filter((n) => n.roleSpec.validationKind === 'cross-document')).toHaveLength(0)
  })

  it('plans targeted section regeneration nodes with dependencies (plan §13)', () => {
    const planner = new Planner({ maxNodes: 40 })
    const nodes = planner.planRegenerations([
      {
        kind: 'regenerate-section',
        documentId: 'doc-1',
        title: 'PRD',
        sectionHeading: 'Auth',
        note: 'contradicts evidence',
        dependencies: ['n-val-1'],
      },
    ])
    expect(nodes).toHaveLength(1)
    const regen = nodes[0]
    expect(regen.documentId).toBe('doc-1')
    expect(regen.regenerateSections).toEqual(['Auth'])
    expect(regen.dependencies).toEqual(['n-val-1'])
    expect(regen.roleSpec.workerType).toBe('document')
    expect(regen.objective).toContain('ONLY these sections')
    expect(regen.objective).toContain('contradicts evidence')
  })

  it('groups multiple failed sections of one document into a single regeneration node', () => {
    const planner = new Planner({ maxNodes: 40 })
    const nodes = planner.planRegenerations([
      { kind: 'regenerate-section', documentId: 'doc-1', title: 'PRD', sectionHeading: 'Auth', note: 'n1', dependencies: ['n-val-1'] },
      { kind: 'regenerate-section', documentId: 'doc-1', title: 'PRD', sectionHeading: 'Storage', note: 'n2', dependencies: ['n-val-1'] },
    ])
    expect(nodes).toHaveLength(1)
    expect(nodes[0].regenerateSections).toEqual(['Auth', 'Storage'])
  })

  it('maps a single document request to one domain-matched document', () => {
    const nodes = new Planner({ maxNodes: 8 }).plan('Create a security architecture document for the codebase.')
    const documents = nodes.filter((n) => n.roleSpec.workerType === 'document')
    expect(documents).toHaveLength(1)
    expect(documents[0].title).toBe('Security Architecture')
  })

  it('preserves the requested scalability deliverable when the prompt contains a common typo', () => {
    const nodes = new Planner({ maxNodes: 8 }).plan(
      'create a document for Scalibilty design for this repo',
    )
    const document = nodes.find((node) => node.roleSpec.workerType === 'document')

    expect(document?.title).toBe('Scalability Strategy')
  })

  it.each([
    'Create documentation for the public API',
    'Write a technical spec for authentication',
    'Prepare a scalability document',
    'I need all three docs',
  ])('plans an editable document for shared intent %j', (request) => {
    const nodes = new Planner({ maxNodes: 12 }).plan(request)
    expect(nodes.some((node) => node.roleSpec.workerType === 'document')).toBe(true)
  })

  it('honors the requested document count', () => {
    const nodes = new Planner().plan('Create 3 documents.')
    expect(nodes.filter((n) => n.roleSpec.workerType === 'document')).toHaveLength(3)
  })

  it('reserves enough graph capacity for every requested document at a tight node limit', () => {
    const nodes = new Planner({ maxNodes: 8 }).plan('Create 3 documents.')

    expect(nodes.filter((node) => node.roleSpec.workerType === 'document')).toHaveLength(3)
    expect(nodes).toHaveLength(8)
  })

  it('treats a request for existing documents as document work', () => {
    const nodes = new Planner().plan('I need all three docs.')
    expect(nodes.filter((n) => n.roleSpec.workerType === 'document')).toHaveLength(3)
  })

  it('creates a document when a structured planner incorrectly returns analysis only', async () => {
    const provider: ModelProvider = {
      async *stream() {
        yield {
          type: 'text_delta',
          text: JSON.stringify({
            analysis: [{
              title: 'Review user experience',
              objective: 'Inspect the user-facing flows.',
              domain: 'ux',
              questions: [],
              requiredCoverage: [],
            }],
            deliverables: [],
          }),
        }
        yield { type: 'finish', reason: 'stop' }
      },
    }

    const nodes = await new Planner({ maxNodes: 8, modelProvider: provider }).planAsync(
      'Create a UX improvement document for this repository.',
    )

    expect(nodes.some((node) => node.roleSpec.workerType === 'document')).toBe(true)
  })

  it('creates a document when structured analysis consumes the document-node budget', async () => {
    const provider: ModelProvider = {
      async *stream() {
        yield {
          type: 'text_delta',
          text: JSON.stringify({
            analysis: Array.from({ length: 8 }, (_, index) => ({
              title: `Analysis ${index + 1}`,
              objective: 'Inspect the repository.',
              domain: 'ux',
              questions: [],
              requiredCoverage: [],
            })),
            deliverables: [{ title: 'UX Improvement Document', objective: 'Write the UX document.', requiredCoverage: [] }],
          }),
        }
        yield { type: 'finish', reason: 'stop' }
      },
    }

    const nodes = await new Planner({ maxNodes: 8, modelProvider: provider }).planAsync(
      'Create a UX improvement document for this repository.',
    )

    expect(nodes.some((node) => node.roleSpec.workerType === 'document')).toBe(true)
  })

  it('uses a schema-validated structured plan for requests outside playbooks', async () => {
    const provider: ModelProvider = {
      async *stream() {
        yield {
          type: 'text_delta',
          text: JSON.stringify({
            analysis: [{
              title: 'Trace feature-flag propagation',
              objective: 'Trace how feature flags flow between frontend and backend.',
              domain: 'feature-flags',
              questions: ['Where are flags evaluated?'],
              requiredCoverage: ['Frontend evaluation', 'Backend evaluation'],
            }],
            deliverables: [{
              title: 'Feature Flag Propagation Guide',
              objective: 'Document the observed end-to-end feature flag flow.',
              requiredCoverage: ['Frontend evaluation', 'Backend evaluation'],
            }],
          }),
        }
        yield { type: 'finish', reason: 'stop' }
      },
    }
    const nodes = await new Planner({ maxNodes: 8, modelProvider: provider }).planAsync(
      'Document how feature flags propagate across backend and frontend.',
    )
    expect(nodes.map((node) => node.title)).toContain('Trace feature-flag propagation')
    expect(nodes.map((node) => node.title)).toContain('Feature Flag Propagation Guide')
    expect(nodes.find((node) => node.title === 'Feature Flag Propagation Guide')?.dependencies).toContain(
      nodes.find((node) => node.title === 'Trace feature-flag propagation')?.id,
    )
  })

  it.each([
    ['GDPR data-retention assessment', 'GDPR Data Retention Assessment', 'personal-data'],
    ['SOC 2 readiness evidence map', 'SOC 2 Readiness Evidence Map', 'compliance'],
    ['acquisition technical due diligence', 'Acquisition Technical Due Diligence', 'due-diligence'],
    ['feature-flag rollout documentation', 'Feature Flag Rollout Guide', 'feature-flags'],
    ['AI governance documentation', 'AI Governance Controls', 'ai-governance'],
    ['an arbitrary domain glossary', 'Domain Glossary', 'arbitrary-domain'],
  ])('supports novel planning scenario: %s', async (_request, title, domain) => {
    const provider: ModelProvider = {
      async *stream() {
        yield {
          type: 'text_delta',
          text: JSON.stringify({
            analysis: [{
              title: `Investigate ${title}`,
              objective: `Collect repository evidence for ${title}.`,
              domain,
              questions: ['What implementation evidence exists?'],
              requiredCoverage: ['Repository evidence'],
            }],
            deliverables: [{
              title,
              objective: `Write ${title} from verified facts.`,
              requiredCoverage: ['Repository evidence'],
            }],
          }),
        }
        yield { type: 'finish', reason: 'stop' }
      },
    }

    const nodes = await new Planner({ maxNodes: 8, modelProvider: provider }).planAsync(_request)
    const analysis = nodes.find((node) => node.title === `Investigate ${title}`)
    const document = nodes.find((node) => node.title === title)

    expect(analysis?.roleSpec.workerType).toBe('analysis')
    expect(document?.roleSpec.workerType).toBe('document')
    expect(document?.dependencies).toContain(analysis?.id)
    expect(nodes.some((node) => node.roleSpec.workerType === 'validation')).toBe(true)
  })
})
