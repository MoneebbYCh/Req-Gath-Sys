/** Baseline prompts for measuring codebase-read accuracy. */

export interface ReadAccuracyFixture {
  id: string
  prompt: string
  description: string
}

export const READ_ACCURACY_FIXTURES: ReadAccuracyFixture[] = [
  {
    id: 'where-defined',
    prompt: 'Where is processChat defined? Cite the file and line.',
    description: 'Single-symbol lookup — should grep then read_file.',
  },
  {
    id: 'list-api-routes',
    prompt: 'List the main extension message handlers and where they are handled.',
    description: 'Enumeration — should explore extension/ and read handler switch.',
  },
  {
    id: 'llm-providers',
    prompt: 'What LLM providers does this project support and where are they configured?',
    description: 'Config inventory — should glob/read llmClient and config files.',
  },
  {
    id: 'agent-tests',
    prompt: 'Find tests for the agent tools and summarize what they cover.',
    description: 'Test discovery — should glob *test* under extension/ai/.',
  },
  {
    id: 'grep-flow',
    prompt: 'How does the agent loop decide between calling a tool vs returning a final answer?',
    description: 'Flow question — should read agentLoop.ts with citations.',
  },
  {
    id: 'missing-symbol',
    prompt: 'Is there a Redis client in this codebase?',
    description: 'Negative lookup — should retry grep before claiming absent.',
  },
  {
    id: 'pipeline-tools',
    prompt: 'What pipeline management tools exist and what do they do?',
    description: 'Tool inventory — should grep/list tools.ts.',
  },
  {
    id: 'read-truncation',
    prompt: 'What is in extension/ai/tools.ts? Summarize the read_file implementation.',
    description: 'Large file read — may hit truncation; should follow up if truncated.',
  },
]

export interface ReadAccuracyRunLog {
  fixtureId: string
  toolSequence: string[]
  citationsFromReadFile: string[]
  claimedNotFound: boolean
  truncationWithoutFollowUp: boolean
}

const CITATION_RE = /\b[\w./-]+\.(?:ts|tsx|js|jsx|py|go|rs|md|json):\d+\b/g
const NOT_FOUND_RE = /\b(not found|not in the codebase|doesn't exist|no redis|nothing matched)\b/i
const TRUNCATION_RE = /truncated at line|output truncated; full content saved/i

/** Extract path:line citations from assistant text and observations. */
export function extractCitations(text: string): string[] {
  const found = text.match(CITATION_RE) ?? []
  return [...new Set(found)]
}

/** Build a run log from an agent transcript for baseline comparison. */
export function analyzeReadAccuracyRun(input: {
  fixtureId: string
  toolSequence: string[]
  transcript: string
  /** When set, "not found" is judged on the final answer only (ignores grep hint text in tool output). */
  finalMessage?: string
}): ReadAccuracyRunLog {
  const citationsFromReadFile = extractCitations(input.transcript)
  const claimedNotFound = NOT_FOUND_RE.test(input.finalMessage ?? input.transcript)
  const hadTruncation = TRUNCATION_RE.test(input.transcript)
  const readAfterTruncation =
    hadTruncation &&
    (() => {
      const idx = input.transcript.search(TRUNCATION_RE)
      const after = input.transcript.slice(idx)
      return /read_file/.test(after) || /offset:\d+/.test(after)
    })()
  return {
    fixtureId: input.fixtureId,
    toolSequence: input.toolSequence,
    citationsFromReadFile,
    claimedNotFound,
    truncationWithoutFollowUp: hadTruncation && !readAfterTruncation,
  }
}
