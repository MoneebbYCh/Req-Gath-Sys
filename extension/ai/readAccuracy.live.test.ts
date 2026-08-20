/**
 * @vitest-environment node
 */
import { describe, expect, it, vi } from 'vitest'
import * as path from 'path'
import { resolveWorkspaceRoot } from './readAccuracyEval'
import {
  printLiveEvalSummary,
  resolveLiveLlmConfig,
  runLiveEvalSuite,
  writeLiveEvalReport,
  writeOpenCodeComparisonTemplate,
} from './readAccuracyLiveRunner'

vi.mock('vscode', () => ({
  window: {
    showWarningMessage: vi.fn(async () => 'Continue'),
  },
}))

const LIVE = process.env.CHARTER_LIVE_EVAL === '1'
const REPO_ROOT = path.resolve(import.meta.dirname, '../..')
/** Agent tools see this root (sandbox excludes opencode/ when CHARTER_EVAL_ROOT is set). */
const EVAL_WORKSPACE = resolveWorkspaceRoot(REPO_ROOT)
const FIXTURE_FILTER = process.env.CHARTER_EVAL_FIXTURE?.trim()

describe('readAccuracyLiveRunner helpers', () => {
  it('writes OpenCode comparison template', () => {
    const file = writeOpenCodeComparisonTemplate(REPO_ROOT)
    expect(file).toContain('OPENCODE-COMPARISON.md')
  })
})

describe.skipIf(!LIVE)('read accuracy live agent eval', () => {
  it(
    'runs fixtures through the agent loop and writes a JSON report',
    async () => {
      writeOpenCodeComparisonTemplate(REPO_ROOT)

      if (EVAL_WORKSPACE !== REPO_ROOT) {
        console.log(`Eval workspace: ${EVAL_WORKSPACE}`)
      }

      const fixtureIds = FIXTURE_FILTER
        ? FIXTURE_FILTER.split(',').map((s) => s.trim()).filter(Boolean)
        : undefined

      const llmConfig = resolveLiveLlmConfig()
      const report = await runLiveEvalSuite({
        workspaceRoot: EVAL_WORKSPACE,
        llmConfig,
        fixtureIds,
        onFixtureStart: (id) => console.log(`→ ${id}`),
      })

      const reportPath = writeLiveEvalReport(REPO_ROOT, report)
      printLiveEvalSummary(report)
      console.log(`Report: ${reportPath}`)

      expect(report.summary.failed).toBe(0)
    },
    600_000,
  )
})
