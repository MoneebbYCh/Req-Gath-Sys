/** OpenCode-style agent step limits (LLM turns), not per-tool-call budgets. */

/** Runaway guard when `steps` is unset (OpenCode has no default cap). */
export const SAFETY_MAX_STEPS = 100

export const RESEARCH_TOOLS = new Set(['list_dir', 'glob', 'grep', 'read_file'])
export const ACTION_TOOLS = new Set([
  'validate_mermaid',
  'list_pipeline',
  'generate_pipeline',
  'remove_pipeline_docs',
])

export type ToolBudgetKind = 'drafting' | 'home-draft' | 'full-inventory' | 'inventory' | 'general'

/** Mode for layered system prompt assembly (OpenCode-style conditional add-ons). */
export type PromptMode = 'research' | 'draft' | 'pipeline'

export interface ToolBudgetProfile {
  kind: ToolBudgetKind
  /** Human-readable label for system prompt. */
  label: string
  /** Which mode add-on to attach to the system prompt. */
  promptMode: PromptMode
  /**
   * OpenCode `agent.steps`: max LLM turns with tools.
   * `undefined` = no cap (loop uses SAFETY_MAX_STEPS only as a circuit breaker).
   */
  steps?: number
}

const DRAFTING_RE =
  /\b(draft|write|populate|fill|update|canvas|document|mermaid|diagram|blocknote|pipeline|generate_pipeline|targetdoc)\b/i
/** Content drafting without bare "pipeline" so Home slot management can use pipeline mode. */
const CONTENT_DRAFT_RE =
  /\b(draft|write|populate|fill|mermaid|diagram|blocknote|targetdoc|rewrite|edit the (doc|document|canvas)|update the (doc|document|canvas))\b/i
const PIPELINE_MODE_RE =
  /\b(list_pipeline|generate_pipeline|remove_pipeline|pipeline|doc slots?|document slots?|add (a )?(new )?doc|create (a )?(new )?doc|remove .+ docs?|what docs|list (my |the )?docs)\b/i
const INVENTORY_RE =
  /\b(where|what|list|find|how does|how do|is there|cite|citation|inventory|exists|defined|implemented|support|handler|routes?|flow|architecture overview)\b/i
const FULL_INVENTORY_RE =
  /\b(endpoints?|apis?|api routes?|all routes?|every route|every endpoint|total|enumerate|complete inventory|mounted routers?|route files?|express routes?|rest (api|endpoints?)|openapi|swagger)\b/i

function systemReminder(body: string): string {
  return `<system-reminder>\n${body}\n</system-reminder>`
}

/** Optional OpenCode-style step cap via CHARTER_AGENT_STEPS (unset = unlimited). */
export function resolveAgentSteps(): number | undefined {
  const raw = process.env.CHARTER_AGENT_STEPS?.trim()
  if (!raw) return undefined
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 1) return undefined
  return Math.min(Math.floor(n), SAFETY_MAX_STEPS)
}

/**
 * Prefer draft when the user asked to write/update canvas content.
 * Home + pipeline slot management (without drafting) → pipeline.
 * Everything else → research.
 */
export function inferPromptMode(text: string, phase: string): PromptMode {
  if (CONTENT_DRAFT_RE.test(text)) return 'draft'
  if (phase !== 'home' && /\b(update|rewrite|change|edit|populate|fill)\b/i.test(text)) return 'draft'
  if (phase === 'home' && PIPELINE_MODE_RE.test(text)) return 'pipeline'
  return 'research'
}

export function inferToolBudgetProfile(text: string, phase: string): ToolBudgetProfile {
  const drafting = DRAFTING_RE.test(text)
  const inventory = INVENTORY_RE.test(text)
  const fullInventory = FULL_INVENTORY_RE.test(text)
  const steps = resolveAgentSteps()
  const promptMode = inferPromptMode(text, phase)

  if (fullInventory) {
    return { kind: 'full-inventory', label: 'full codebase inventory', promptMode, steps }
  }
  if (drafting && phase !== 'home') {
    return { kind: 'drafting', label: 'document drafting', promptMode, steps }
  }
  if (drafting && phase === 'home') {
    return { kind: 'home-draft', label: 'home draft + pipeline', promptMode, steps }
  }
  if (inventory) {
    return { kind: 'inventory', label: 'codebase lookup', promptMode, steps }
  }
  return { kind: 'general', label: 'general', promptMode, steps }
}

export function maxRoundTrips(profile: ToolBudgetProfile): number {
  return profile.steps ?? SAFETY_MAX_STEPS
}

/** Injected on the last step — tools disabled (OpenCode MAX_STEPS_PROMPT). */
export function maxStepsPrompt(phase: string): string {
  const json =
    phase === 'home'
      ? '{"message","document","targetDoc","anchors"} — use targetDoc+document if drafting, else document:null'
      : '{"message","document","anchors"}'
  return systemReminder(
    [
      'CRITICAL — MAXIMUM STEPS REACHED',
      'The maximum number of agent steps for this turn has been reached. Tools are disabled until the next user message.',
      'Do NOT make any tool calls. Respond with final JSON only: ' + json + '.',
      'Include: what you accomplished, anything still unread/unverified, and what to do next.',
      'If this was a count/map, split VERIFIED vs UNREAD. Never title a partial map as complete.',
    ].join(' '),
  )
}

export function budgetConstraintText(profile: ToolBudgetProfile): string {
  if (profile.steps) {
    return `Agent steps: at most ${profile.steps} LLM turns with tools (OpenCode-style). After that, tools are disabled and you must answer from evidence. There is no per-tool-call budget — batch many read_file calls in one turn when counting routes.`
  }
  return (
    'There is no per-tool-call budget (OpenCode-style). Keep using tools until you can answer the user. ' +
    'Compaction handles long transcripts. Stop when the question is answered — do not catalogue the whole repo unless asked. ' +
    'A runaway guard stops the loop after ' +
    String(SAFETY_MAX_STEPS) +
    ' LLM turns.'
  )
}

/** Inject once after grep if read_file has not confirmed hits yet. */
export function grepReadNudge(batchToolNames: string[], readFileSeenInSession: boolean): string | null {
  const hadGrep = batchToolNames.includes('grep')
  const hadRead = batchToolNames.includes('read_file')
  if (!hadGrep || hadRead || readFileSeenInSession) return null
  return systemReminder(
    'SEARCH: grep hits are leads only — call read_file on the top 1–2 matching files before stating facts or finishing.',
  )
}

/** After the first research batch on a full inventory, insist on reading every mounted module. */
export function inventoryMountNudge(profile: ToolBudgetProfile, alreadySent: boolean): string | null {
  if (alreadySent || profile.kind !== 'full-inventory') return null
  return systemReminder(
    'INVENTORY/COUNT: a mount table is NOT an endpoint list. ' +
      'Next turn: batch one grep per mounted route file (set path to that file; pattern for router.get/post/put/patch/delete). ' +
      'Sum the match counts from those observations; spot-check at most 1–2 files with read_file. ' +
      'Do not re-grep the whole api/ directory or re-read large files. ' +
      'When the sum is ready, finish with the number + definition (document:null). ' +
      'If incomplete, split VERIFIED vs UNREAD — never title a partial map as complete.',
  )
}
