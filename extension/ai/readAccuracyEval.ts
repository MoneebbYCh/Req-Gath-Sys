import * as path from 'path'
import { READ_ACCURACY_FIXTURES, analyzeReadAccuracyRun, type ReadAccuracyRunLog } from './readAccuracy.fixtures'
import { grepSearch } from './ripgrepAdapter'
import { readFilePage } from './readTool'
import { extractToolSequence } from './researchCheckpoint'

export interface FixtureGroundTruth {
  id: string
  grepPatterns: string[]
  /** At least one pattern should produce matches (empty for negative lookups). */
  expectGrepHits: boolean
  /** Limit grep to this relative path (default "."). */
  grepPath?: string
  readPaths?: string[]
  readOffset?: number
  readLimit?: number
  /** Substrings expected in read output (path → needles). */
  readNeedles?: Record<string, string[]>
}

export const FIXTURE_GROUND_TRUTH: FixtureGroundTruth[] = [
  {
    id: 'where-defined',
    grepPatterns: ['processChat', 'export async function processChat'],
    expectGrepHits: true,
    readPaths: ['extension/ai/agent.ts'],
    readNeedles: { 'extension/ai/agent.ts': ['processChat', 'export async function processChat'] },
  },
  {
    id: 'list-api-routes',
    grepPatterns: ['chatMessage', 'onDidReceiveMessage'],
    expectGrepHits: true,
    readPaths: ['extension/extension.ts'],
    readOffset: 118,
    readLimit: 40,
    readNeedles: { 'extension/extension.ts': ["case 'chatMessage'", 'processChat'] },
  },
  {
    id: 'llm-providers',
    grepPatterns: ['PROVIDERS', 'deepseek', 'provider'],
    expectGrepHits: true,
    readPaths: ['extension/ai/llmClient.ts'],
    readNeedles: { 'extension/ai/llmClient.ts': ['PROVIDERS', 'provider'] },
  },
  {
    id: 'agent-tests',
    grepPatterns: ['tools\\.test\\.ts', 'readTool\\.test\\.ts'],
    expectGrepHits: true,
    readPaths: ['extension/ai/tools.test.ts'],
    readNeedles: { 'extension/ai/tools.test.ts': ['describe', 'it'] },
  },
  {
    id: 'grep-flow',
    grepPatterns: ['callLlmAgentStep', 'inferToolBudgetProfile'],
    expectGrepHits: true,
    readPaths: ['extension/ai/agentLoop.ts'],
    readOffset: 1,
    readLimit: 25,
    readNeedles: { 'extension/ai/agentLoop.ts': ['inferToolBudgetProfile', 'callLlmAgentStep'] },
  },
  {
    id: 'missing-symbol',
    grepPatterns: ["from 'redis'", 'from "redis"', 'ioredis', 'new Redis'],
    expectGrepHits: false,
    grepPath: 'extension',
  },
  {
    id: 'pipeline-tools',
    grepPatterns: ['generate_pipeline', 'list_pipeline', 'remove_pipeline_docs'],
    expectGrepHits: true,
    readPaths: ['extension/ai/tools.ts'],
    readOffset: 130,
    readLimit: 80,
    readNeedles: { 'extension/ai/tools.ts': ['list_pipeline', 'read_file'] },
  },
  {
    id: 'read-truncation',
    grepPatterns: ['readFileTool', 'readFilePage'],
    expectGrepHits: true,
    readPaths: ['extension/ai/tools.ts'],
    readOffset: 370,
    readLimit: 30,
    readNeedles: { 'extension/ai/tools.ts': ['readFilePageTool', 'read_file'] },
  },
]

export interface OfflineFixtureResult {
  fixtureId: string
  grepOk: boolean
  readOk: boolean
  errors: string[]
}

function isProductionMatch(file: string): boolean {
  const lower = file.replace(/\\/g, '/').toLowerCase()
  if (/\.(test|spec)\./.test(lower)) return false
  if (lower.includes('readaccuracy') || lower.includes('fixtures')) return false
  return true
}

export async function runOfflineFixtureCheck(
  workspaceRoot: string,
  truth: FixtureGroundTruth,
): Promise<OfflineFixtureResult> {
  const errors: string[] = []
  let anyGrepHit = false

  for (const pattern of truth.grepPatterns) {
    const { matches, error } = await grepSearch({
      workspaceRoot,
      pattern,
      searchPath: truth.grepPath ?? '.',
      caseInsensitive: true,
      limit: 20,
    })
    if (error) errors.push(`grep(${JSON.stringify(pattern)}): ${error}`)
    const relevant =
      truth.expectGrepHits
        ? matches.length > 0
        : matches.some((m) => isProductionMatch(m.file))
    if (relevant) anyGrepHit = true
  }

  const grepOk = truth.expectGrepHits ? anyGrepHit : !anyGrepHit
  if (!grepOk) {
    errors.push(
      truth.expectGrepHits
        ? 'expected grep hits but found none'
        : 'expected no grep hits but found matches',
    )
  }

  let readOk = true
  for (const rel of truth.readPaths ?? []) {
    const result = readFilePage(workspaceRoot, {
      path: rel,
      offset: truth.readOffset ?? 1,
      limit: truth.readLimit ?? 100,
    })
    if (!result.ok) {
      readOk = false
      errors.push(`read_file(${rel}): ${result.error}`)
      continue
    }
    const needles = truth.readNeedles?.[rel] ?? []
    for (const needle of needles) {
      if (!result.text.includes(needle)) {
        readOk = false
        errors.push(`read_file(${rel}): missing expected substring ${JSON.stringify(needle)}`)
      }
    }
  }

  return { fixtureId: truth.id, grepOk, readOk, errors }
}

export async function runAllOfflineChecks(workspaceRoot: string): Promise<OfflineFixtureResult[]> {
  return Promise.all(FIXTURE_GROUND_TRUTH.map((t) => runOfflineFixtureCheck(workspaceRoot, t)))
}

export interface LiveEvalResult extends ReadAccuracyRunLog {
  fixtureId: string
  message: string
  passed: boolean
  failures: string[]
}

export function scoreLiveEvalRun(input: {
  fixtureId: string
  toolSequence: string[]
  transcript: string
  message: string
}): LiveEvalResult {
  const log = analyzeReadAccuracyRun({ ...input, finalMessage: input.message })
  const failures: string[] = []
  const readTools = input.toolSequence.filter((t) => t === 'read_file').length
  const grepTools = input.toolSequence.filter((t) => t === 'grep').length
  const citations = log.citationsFromReadFile

  if (readTools === 0 && grepTools === 0 && input.fixtureId !== 'missing-symbol') {
    failures.push('no grep or read_file tools used')
  }
  if (grepTools > 0 && readTools === 0 && input.fixtureId !== 'missing-symbol') {
    failures.push('grep used but read_file never called to confirm')
  }
  if (citations.length === 0 && input.fixtureId !== 'missing-symbol') {
    failures.push('no path:line citations in transcript')
  }
  if (log.claimedNotFound && input.fixtureId !== 'missing-symbol') {
    failures.push('claimed not found')
  }
  if (log.truncationWithoutFollowUp) {
    failures.push('truncation without follow-up read')
  }

  return {
    ...log,
    fixtureId: input.fixtureId,
    message: input.message,
    passed: failures.length === 0,
    failures,
  }
}

/** Build transcript string from agent messages for scoring. */
export function transcriptFromMessages(messages: { role: string; content: string; name?: string }[]): string {
  return messages.map((m) => m.content).join('\n')
}

export function resolveWorkspaceRoot(cwd: string = process.cwd()): string {
  // When run from repo root, use cwd; allow CHARTER_EVAL_ROOT override.
  const override = process.env.CHARTER_EVAL_ROOT
  return override ? path.resolve(override) : cwd
}

export { READ_ACCURACY_FIXTURES, extractToolSequence }
