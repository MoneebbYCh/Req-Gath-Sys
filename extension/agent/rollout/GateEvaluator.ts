import type { AgentFeatureFlags, RolloutStage } from './FeatureFlags'

export type RolloutGateId = 'A' | 'B' | 'C' | 'D' | 'E'

export interface MetricThreshold {
  metric: string
  /** `atLeast` is used for recall/precision/completion; `atMost` for error rates and latency. */
  atLeast?: number
  atMost?: number
}

export interface BenchmarkEvidence {
  fileCount: number
  passed: boolean
  label?: string
}

/** Content-free evidence collected from tests or a periodic evaluation run. */
export interface RolloutEvidence {
  checks: Readonly<Record<string, boolean | undefined>>
  metrics?: Readonly<Record<string, number | undefined>>
  benchmarks?: readonly BenchmarkEvidence[]
}

export interface RolloutGatePolicy {
  gate: RolloutGateId
  requiredFlags: readonly (keyof AgentFeatureFlags)[]
  requiredChecks: readonly string[]
  thresholds?: readonly MetricThreshold[]
  /** Gate E requires this scale in a recorded benchmark result. */
  minimumBenchmarkFiles?: number
}

export interface GateAssessment {
  gate: RolloutGateId
  passed: boolean
  missingFlags: string[]
  failedChecks: string[]
  failedThresholds: string[]
  benchmarkFailure?: string
}

/** The plan sets requirements, not numeric targets; callers supply metric targets explicitly. */
export const ROLLOUT_GATE_POLICIES: readonly RolloutGatePolicy[] = [
  { gate: 'A', requiredFlags: ['streaming'], requiredChecks: ['taskProtocol', 'cancellation', 'streamingUi'] },
  { gate: 'B', requiredFlags: ['streaming', 'repositoryTools'], requiredChecks: ['repositorySafety', 'evidenceLinks'] },
  { gate: 'C', requiredFlags: ['taskGraph', 'subagents', 'documentGeneration', 'validation'], requiredChecks: ['durableTaskGraph', 'evidenceLedger', 'restartRecovery', 'revisionSafeDocuments', 'documentValidation'] },
  { gate: 'D', requiredFlags: ['parallelDocuments'], requiredChecks: ['sharedFactBase', 'crossDocumentValidation', 'partialCompletion', 'documentProgress'] },
  { gate: 'E', requiredFlags: ['repositoryTools'], requiredChecks: [], minimumBenchmarkFiles: 100_000 },
]

export function assessGate(policy: RolloutGatePolicy, flags: AgentFeatureFlags, evidence: RolloutEvidence): GateAssessment {
  const missingFlags = policy.requiredFlags.filter((flag) => !flags[flag])
  const failedChecks = policy.requiredChecks.filter((check) => evidence.checks[check] !== true)
  const failedThresholds = (policy.thresholds ?? []).flatMap((threshold) => {
    const actual = evidence.metrics?.[threshold.metric]
    const tooLow = threshold.atLeast !== undefined && (actual === undefined || actual < threshold.atLeast)
    const tooHigh = threshold.atMost !== undefined && (actual === undefined || actual > threshold.atMost)
    return tooLow || tooHigh ? [threshold.metric] : []
  })
  const minimumBenchmarkFiles = policy.minimumBenchmarkFiles
  const benchmark = minimumBenchmarkFiles === undefined
    ? undefined
    : evidence.benchmarks?.find((item) => item.fileCount >= minimumBenchmarkFiles)
  const benchmarkFailure = minimumBenchmarkFiles !== undefined && (!benchmark || !benchmark.passed)
    ? `No passing benchmark at ${minimumBenchmarkFiles.toLocaleString()}+ files.`
    : undefined
  return {
    gate: policy.gate,
    passed: missingFlags.length === 0 && failedChecks.length === 0 && failedThresholds.length === 0 && benchmarkFailure === undefined,
    missingFlags,
    failedChecks,
    failedThresholds,
    benchmarkFailure,
  }
}

export interface RolloutAssessment {
  stage: RolloutStage
  generatedAt: string
  gates: GateAssessment[]
  eligibleThrough: RolloutGateId | null
}

export function assessRollout(
  stage: RolloutStage,
  flags: AgentFeatureFlags,
  evidence: RolloutEvidence,
  policies: readonly RolloutGatePolicy[] = ROLLOUT_GATE_POLICIES,
  now = new Date(),
): RolloutAssessment {
  const gates = policies.map((policy) => assessGate(policy, flags, evidence))
  let eligibleThrough: RolloutGateId | null = null
  for (const gate of gates) {
    if (!gate.passed) break
    eligibleThrough = gate.gate
  }
  return { stage, generatedAt: now.toISOString(), gates, eligibleThrough }
}

/** JSON-safe report; deliberately has no field for repository content or prompts. */
export function serializeRolloutAssessment(assessment: RolloutAssessment): string {
  return JSON.stringify(assessment, null, 2)
}
