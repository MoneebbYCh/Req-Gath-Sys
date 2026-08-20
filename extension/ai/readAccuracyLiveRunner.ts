import * as fs from 'fs'
import * as path from 'path'
import { runAgentLoop } from './agentLoop'
import type { LlmConfig } from './llmClient'
import {
  READ_ACCURACY_FIXTURES,
  scoreLiveEvalRun,
  transcriptFromMessages,
  type LiveEvalResult,
} from './readAccuracyEval'
import { extractGrepPatterns, extractToolSequence } from './researchCheckpoint'
import { STATE_DIR } from '../brand'

export interface LiveEvalReportEntry {
  fixtureId: string
  prompt: string
  description: string
  toolSequence: string[]
  grepPatterns: string[]
  citations: string[]
  message: string
  passed: boolean
  failures: string[]
  claimedNotFound: boolean
  truncationWithoutFollowUp: boolean
  durationMs: number
}

export interface LiveEvalReport {
  runner: 'charter-ai'
  timestamp: string
  workspaceRoot: string
  provider: string
  model: string | null
  fixtureFilter: string | null
  summary: {
    total: number
    passed: number
    failed: number
    passRate: number
  }
  entries: LiveEvalReportEntry[]
}

export interface RunLiveEvalOptions {
  workspaceRoot: string
  llmConfig: LlmConfig
  fixtureIds?: string[]
  confirmDestructive?: (what: string) => Promise<boolean>
  onFixtureStart?: (fixtureId: string) => void
}

function resolveApiKey(): string {
  return (
    process.env.DEEPSEEK_API_KEY ??
    process.env.MOONSHOT_API_KEY ??
    process.env.CHARTER_EVAL_API_KEY ??
    process.env.LLM_API_KEY ??
    ''
  )
}

export function resolveLiveLlmConfig(): LlmConfig {
  const provider = process.env.CHARTER_EVAL_PROVIDER ?? 'deepseek'
  return {
    provider,
    model: process.env.CHARTER_EVAL_MODEL ?? null,
    apiKey: resolveApiKey(),
    contextTokens: process.env.CHARTER_EVAL_CONTEXT
      ? Number(process.env.CHARTER_EVAL_CONTEXT)
      : undefined,
  }
}

export async function runLiveEvalSuite(options: RunLiveEvalOptions): Promise<LiveEvalReport> {
  const { workspaceRoot, llmConfig, fixtureIds, confirmDestructive, onFixtureStart } = options

  if (!llmConfig.apiKey && llmConfig.provider !== 'local') {
    throw new Error(
      'No API key found. Set DEEPSEEK_API_KEY, MOONSHOT_API_KEY, or CHARTER_EVAL_API_KEY, ' +
        'or use CHARTER_EVAL_PROVIDER=local with Ollama running.',
    )
  }

  const filter = fixtureIds?.length ? new Set(fixtureIds) : null
  const fixtures = filter
    ? READ_ACCURACY_FIXTURES.filter((f) => filter.has(f.id))
    : READ_ACCURACY_FIXTURES

  if (fixtures.length === 0) {
    throw new Error('No fixtures matched the filter.')
  }

  const entries: LiveEvalReportEntry[] = []

  for (const fixture of fixtures) {
    onFixtureStart?.(fixture.id)
    const started = Date.now()

    try {
      const result = await runAgentLoop({
        text: fixture.prompt,
        phase: 'home',
        fieldGuide: '',
        workspaceRoot,
        llmConfig,
        currentDocJson: 'null',
        confirmDestructive: confirmDestructive ?? (async () => true),
      })

      const toolSequence = extractToolSequence(result.messages)
      const transcript = transcriptFromMessages(result.messages) + '\n' + result.message
      const scored: LiveEvalResult = scoreLiveEvalRun({
        fixtureId: fixture.id,
        toolSequence,
        transcript,
        message: result.message,
      })

      entries.push({
        fixtureId: fixture.id,
        prompt: fixture.prompt,
        description: fixture.description,
        toolSequence,
        grepPatterns: extractGrepPatterns(result.messages),
        citations: scored.citationsFromReadFile,
        message: result.message,
        passed: scored.passed,
        failures: scored.failures,
        claimedNotFound: scored.claimedNotFound,
        truncationWithoutFollowUp: scored.truncationWithoutFollowUp,
        durationMs: Date.now() - started,
      })
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      entries.push({
        fixtureId: fixture.id,
        prompt: fixture.prompt,
        description: fixture.description,
        toolSequence: [],
        grepPatterns: [],
        citations: [],
        message: '',
        passed: false,
        failures: [`agent loop error: ${error}`],
        claimedNotFound: false,
        truncationWithoutFollowUp: false,
        durationMs: Date.now() - started,
      })
    }
  }

  const passed = entries.filter((e) => e.passed).length
  const failed = entries.length - passed

  return {
    runner: 'charter-ai',
    timestamp: new Date().toISOString(),
    workspaceRoot,
    provider: llmConfig.provider,
    model: llmConfig.model ?? null,
    fixtureFilter: fixtureIds?.join(',') ?? null,
    summary: {
      total: entries.length,
      passed,
      failed,
      passRate: entries.length ? passed / entries.length : 0,
    },
    entries,
  }
}

export function evalReportDir(workspaceRoot: string): string {
  return path.join(workspaceRoot, STATE_DIR, 'eval')
}

export function writeLiveEvalReport(workspaceRoot: string, report: LiveEvalReport): string {
  const dir = evalReportDir(workspaceRoot)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  const stamp = report.timestamp.replace(/[:.]/g, '-')
  const file = path.join(dir, `charter-live-${stamp}.json`)
  fs.writeFileSync(file, JSON.stringify(report, null, 2), 'utf-8')
  return file
}

export function writeOpenCodeComparisonTemplate(workspaceRoot: string): string {
  const dir = evalReportDir(workspaceRoot)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })

  const lines = [
    '# Read Accuracy — OpenCode comparison',
    '',
    'Run each prompt below in **OpenCode** on the same workspace, then save results as',
    '`opencode-live-<date>.json` in this folder using the same schema as Charter reports.',
    '',
    '## Scoring checklist (both runners)',
    '',
    '- Tool sequence includes grep/read_file for lookup questions',
    '- grep followed by read_file before claiming facts',
    '- Final answer includes `path:line` citations from read_file',
    '- Negative lookup (`missing-symbol`) tries multiple searches before "not found"',
    '- Truncated output followed by another read_file',
    '',
    '## Prompts',
    '',
  ]

  for (const f of READ_ACCURACY_FIXTURES) {
    lines.push(`### ${f.id}`, '', f.description, '', '```', f.prompt, '```', '')
  }

  lines.push(
    '## OpenCode result template',
    '',
    '```json',
    JSON.stringify(
      {
        runner: 'opencode',
        timestamp: new Date().toISOString(),
        entries: READ_ACCURACY_FIXTURES.map((f) => ({
          fixtureId: f.id,
          toolSequence: ['grep', 'read'],
          citations: ['extension/ai/agent.ts:93'],
          message: '…',
          passed: true,
          failures: [],
        })),
      },
      null,
      2,
    ),
    '```',
    '',
  )

  const file = path.join(dir, 'OPENCODE-COMPARISON.md')
  fs.writeFileSync(file, lines.join('\n'), 'utf-8')
  return file
}

/** Print a concise terminal summary. */
export function printLiveEvalSummary(report: LiveEvalReport): void {
  const { summary } = report
  console.log(`\nCharter live eval: ${summary.passed}/${summary.total} passed (${Math.round(summary.passRate * 100)}%)`)
  for (const e of report.entries) {
    const mark = e.passed ? 'PASS' : 'FAIL'
    console.log(`  [${mark}] ${e.fixtureId} — tools: ${e.toolSequence.join(' → ') || '(none)'}`)
    if (!e.passed) console.log(`         failures: ${e.failures.join('; ')}`)
    if (e.citations.length) console.log(`         citations: ${e.citations.slice(0, 3).join(', ')}`)
  }
}
