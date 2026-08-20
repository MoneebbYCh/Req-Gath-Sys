import { describe, expect, it } from 'vitest'
import * as path from 'path'
import {
  FIXTURE_GROUND_TRUTH,
  runAllOfflineChecks,
  scoreLiveEvalRun,
} from './readAccuracyEval'

const WORKSPACE = path.resolve(import.meta.dirname, '../..')

describe('readAccuracyEval offline ground truth', () => {
  it('every fixture has ground truth defined', () => {
    expect(FIXTURE_GROUND_TRUTH.length).toBe(8)
    for (const t of FIXTURE_GROUND_TRUTH) {
      expect(t.grepPatterns.length).toBeGreaterThan(0)
    }
  })

  it('grep/read layer can answer all fixtures on this repo', async () => {
    const results = await runAllOfflineChecks(WORKSPACE)
    const failed = results.filter((r) => !r.grepOk || !r.readOk)
    if (failed.length > 0) {
      const detail = failed
        .map((r) => `${r.fixtureId}: ${r.errors.join('; ')}`)
        .join('\n')
      expect.fail(`Offline fixture checks failed:\n${detail}`)
    }
    expect(failed).toHaveLength(0)
  })
})

describe('scoreLiveEvalRun', () => {
  it('passes a well-formed research run', () => {
    const result = scoreLiveEvalRun({
      fixtureId: 'where-defined',
      toolSequence: ['grep', 'read_file'],
      transcript:
        'OBSERVATION (read_file)\nextension/ai/agent.ts:93\n93\texport async function processChat',
      message: 'processChat is in extension/ai/agent.ts:93',
    })
    expect(result.passed).toBe(true)
    expect(result.failures).toHaveLength(0)
  })

  it('fails grep-only without read_file', () => {
    const result = scoreLiveEvalRun({
      fixtureId: 'where-defined',
      toolSequence: ['grep'],
      transcript: 'Found matches in agent.ts',
      message: 'It is in agent.ts',
    })
    expect(result.passed).toBe(false)
    expect(result.failures.some((f) => f.includes('read_file'))).toBe(true)
  })

  it('ignores grep zero-hit hints in tool transcript when final answer finds the symbol', () => {
    const result = scoreLiveEvalRun({
      fixtureId: 'where-defined',
      toolSequence: ['grep', 'read_file'],
      transcript:
        'No matches for 2 pattern(s).\nZero hits ≠ absent: try again before claiming this is not in the codebase.\n' +
        'OBSERVATION (read_file)\nextension/ai/agent.ts:95',
      message: 'processChat is defined in extension/ai/agent.ts:95',
    })
    expect(result.passed).toBe(true)
    expect(result.claimedNotFound).toBe(false)
  })
})
