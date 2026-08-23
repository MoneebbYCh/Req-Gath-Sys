import { describe, expect, it } from 'vitest'
import { assessGate, assessRollout, ROLLOUT_GATE_POLICIES, serializeRolloutAssessment, type RolloutGatePolicy } from './GateEvaluator'
import { resolveFeatureFlags } from './FeatureFlags'

const allChecks = {
  taskProtocol: true, cancellation: true, streamingUi: true, repositorySafety: true, evidenceLinks: true,
  durableTaskGraph: true, evidenceLedger: true, restartRecovery: true, revisionSafeDocuments: true,
  documentValidation: true, sharedFactBase: true, crossDocumentValidation: true, partialCompletion: true, documentProgress: true,
}

describe('rollout gate evaluator', () => {
  it('fails closed when a required check, metric, or feature is missing', () => {
    const policy: RolloutGatePolicy = { gate: 'B', requiredFlags: ['repositoryTools'], requiredChecks: ['repositorySafety'], thresholds: [{ metric: 'recallAtK', atLeast: 0.9 }] }
    expect(assessGate(policy, resolveFeatureFlags('gate-a'), { checks: {} })).toMatchObject({ passed: false, missingFlags: ['repositoryTools'], failedChecks: ['repositorySafety'], failedThresholds: ['recallAtK'] })
  })

  it('requires a recorded passing large-repository benchmark for gate E', () => {
    const gateE = ROLLOUT_GATE_POLICIES.find((policy) => policy.gate === 'E')!
    expect(assessGate(gateE, resolveFeatureFlags(), { checks: allChecks, benchmarks: [{ fileCount: 10_000, passed: true }] }).passed).toBe(false)
    expect(assessGate(gateE, resolveFeatureFlags(), { checks: allChecks, benchmarks: [{ fileCount: 100_000, passed: true }] }).passed).toBe(true)
  })

  it('reports the highest consecutive eligible gate without repository content', () => {
    const report = assessRollout('full', resolveFeatureFlags(), { checks: allChecks, benchmarks: [{ fileCount: 100_000, passed: true }] }, undefined, new Date('2026-08-23T00:00:00.000Z'))
    expect(report.eligibleThrough).toBe('E')
    expect(serializeRolloutAssessment(report)).not.toContain('prompt')
  })
})
