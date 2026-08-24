import { budgetConstraintText, type PromptMode, type ToolBudgetProfile } from '../agentBudget'
import type { LlmConfig } from '../llmClient'
import { buildCorePrompt } from './core'
import { buildEnvironmentBlock } from './environment'
import { modePolicy } from './modes'

export interface BuildSystemPromptArgs {
  phase: string
  label: string
  budget: ToolBudgetProfile
  llmConfig: LlmConfig
  workspaceRoot: string
  /** Pre-loaded AGENTS.md text (from loadProjectInstructions). */
  instructionsText?: string
  /** Override mode; defaults to budget.promptMode. */
  promptMode?: PromptMode
}

/** OpenCode-style layered system prompt for Charter. */
export function buildSystemPrompt(args: BuildSystemPromptArgs): string {
  const mode = args.promptMode ?? args.budget.promptMode
  const layers = [
    buildEnvironmentBlock({
      workspaceRoot: args.workspaceRoot,
      llmConfig: args.llmConfig,
      phase: args.phase,
      label: args.label,
    }),
    buildCorePrompt(args.phase, args.label, budgetConstraintText(args.budget)),
    modePolicy(mode, args.budget.kind),
  ]
  if (args.instructionsText?.trim()) {
    layers.splice(1, 0, args.instructionsText.trim())
  }
  return layers.join('\n\n')
}
