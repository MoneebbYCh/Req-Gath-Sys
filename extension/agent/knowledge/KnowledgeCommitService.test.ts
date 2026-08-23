import { describe, expect, it } from 'vitest'
import { FindingStore } from './FindingStore'
import { KnowledgeCommitService } from './KnowledgeCommitService'
import { ProjectFactBase } from './ProjectFactBase'

describe('KnowledgeCommitService', () => {
  it('normalizes findings and promotes only repository truth into canonical facts', () => {
    const findings = new FindingStore()
    const facts = new ProjectFactBase()
    const service = new KnowledgeCommitService(findings, facts)

    service.commit([
      {
        claim: 'JWT middleware authenticates requests.',
        type: 'observed',
        domain: 'security',
        factKey: 'security.authentication',
        evidenceIds: ['e-auth'],
        confidence: 'high',
        assumptions: [],
        contradictions: [],
        repositoryVersion: 'rv-1',
      },
      {
        claim: 'Refresh token rotation is not confirmed.',
        type: 'unknown',
        domain: 'security',
        evidenceIds: [],
        confidence: 'low',
        assumptions: [],
        contradictions: [],
        repositoryVersion: 'rv-1',
      },
    ])

    expect(findings.all()).toHaveLength(2)
    expect(facts.get('security.authentication')?.statement).toContain('JWT')
    expect(facts.all()).toHaveLength(1)
  })
})
