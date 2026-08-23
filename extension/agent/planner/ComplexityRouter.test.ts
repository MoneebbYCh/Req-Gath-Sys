import { describe, expect, it } from 'vitest'
import { ComplexityRouter } from './ComplexityRouter'

describe('ComplexityRouter', () => {
  const router = new ComplexityRouter()

  it('routes pointed repository questions to the fast path', () => {
    expect(router.route('Where is authentication handled?')).toBe('simple')
    expect(router.route('What database are we using?')).toBe('simple')
    expect(router.route('Explain this service.')).toBe('simple')
  })

  it('routes domain keywords and long requests to the task graph', () => {
    expect(router.route('Analyze the complete architecture.')).toBe('complex')
    expect(router.route('Create a security architecture document.')).toBe('complex')
    expect(router.route('Perform technical due diligence.')).toBe('complex')
    expect(router.route('Audit the codebase for scalability issues.')).toBe('complex')
    expect(router.route('x'.repeat(300))).toBe('complex')
  })

  it('routes multi-document requests to the task graph', () => {
    expect(router.route('Generate ten project documents.')).toBe('complex')
    expect(router.route('Create three docs: PRD, architecture, security.')).toBe('complex')
  })

  it.each([
    'create a document for Scalibilty design for this repo',
    'Create a PRD document',
    'Build a docs pipeline for this codebase',
    'Draft a release-notes document for this repository',
    'Create documentation for the public API',
    'Write a technical spec for authentication',
    'Prepare a scalability document',
    'I need all three docs',
  ])('routes a singular document request to the task graph: %s', (request) => {
    expect(router.route(request)).toBe('complex')
  })

  it('routes multi-part asks to the task graph', () => {
    expect(
      router.route('Map the auth flow and also document the data model.'),
    ).toBe('complex')
  })

  it('defers to a classifier hook when provided', () => {
    const classified = new ComplexityRouter({ classify: (text) => (text.includes('force') ? 'complex' : 'simple') })
    expect(classified.route('force me')).toBe('complex')
    expect(classified.route('Analyze everything')).toBe('simple') // hook overrides heuristics
  })
})
