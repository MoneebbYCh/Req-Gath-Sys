import { describe, expect, it } from 'vitest'
import {
  evidencePrecision,
  firstFeedbackLatency,
  firstTokenLatency,
  recallAtK,
  repeatedReadRate,
  taskCompletionRate,
  totalTaskLatency,
  unsupportedClaimRate,
} from './metrics'
import type { Finding } from '../contracts/Finding'

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: 'f-1',
    claim: 'Auth is JWT middleware.',
    type: 'observed',
    domain: 'auth',
    evidenceIds: ['ev-1'],
    confidence: 'high',
    assumptions: [],
    contradictions: [],
    repositoryVersion: 'rv-1',
    ...overrides,
  }
}

describe('eval metrics (plan §5 deterministic scoring)', () => {
  it('recallAtK: matches expected evidence in the top-K retrieved set', () => {
    expect(
      recallAtK({
        retrieved: ['src/auth/middleware.ts', 'src/app.ts'],
        expected: ['src/auth*', 'middleware*'],
        k: 10,
      }),
    ).toBe(1)
    expect(
      recallAtK({
        retrieved: ['src/app.ts', 'src/auth/middleware.ts'],
        expected: ['src/auth*'],
        k: 1,
      }),
    ).toBe(0) // relevant item is beyond K
    expect(recallAtK({ retrieved: [], expected: ['x'], k: 10 })).toBe(0)
  })

  it('unsupportedClaimRate counts observed claims without evidence', () => {
    expect(
      unsupportedClaimRate([
        finding(),
        finding({ id: 'f-2', type: 'observed', evidenceIds: [] }),
        finding({ id: 'f-3', type: 'inferred', evidenceIds: [] }),
      ]),
    ).toBeCloseTo(1 / 3)
  })

  it('evidencePrecision measures cited evidence that actually exists', () => {
    expect(
      evidencePrecision(
        [finding({ evidenceIds: ['ev-1', 'ev-ghost'] })],
        new Set(['ev-1']),
      ),
    ).toBe(0.5)
    expect(evidencePrecision([finding({ evidenceIds: [] })], new Set())).toBe(1)
  })

  it('repeatedReadRate counts duplicate read keys', () => {
    expect(repeatedReadRate([{ key: 'a' }, { key: 'a' }, { key: 'b' }, { key: 'a' }])).toBe(0.5)
  })

  it('taskCompletionRate', () => {
    expect(taskCompletionRate(['completed', 'completed', 'failed'])).toBeCloseTo(2 / 3)
  })

  it('latencies derive from timestamps', () => {
    const t = {
      taskStartedAt: 1000,
      firstActivityAt: 1050,
      firstTextTokenAt: 1200,
      taskCompletedAt: 5000,
    }
    expect(firstFeedbackLatency(t)).toBe(50)
    expect(firstTokenLatency(t)).toBe(200)
    expect(totalTaskLatency(t)).toBe(4000)
    expect(firstFeedbackLatency({ taskStartedAt: 1000 })).toBeUndefined()
  })
})
