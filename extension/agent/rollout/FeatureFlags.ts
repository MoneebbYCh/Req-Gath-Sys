import { z } from 'zod'

/**
 * Independently switchable runtime capabilities (plan §22). These switches
 * are rollout controls, not user-facing product settings. A disabled feature
 * is removed at the host/runtime boundary; it is never merely hidden in a
 * prompt.
 */
export interface AgentFeatureFlags {
  streaming: boolean
  repositoryTools: boolean
  lsp: boolean
  taskGraph: boolean
  subagents: boolean
  documentGeneration: boolean
  validation: boolean
  parallelDocuments: boolean
  semanticRetrieval: boolean
}

export const agentFeatureFlagsSchema = z.object({
  streaming: z.boolean(),
  repositoryTools: z.boolean(),
  lsp: z.boolean(),
  taskGraph: z.boolean(),
  subagents: z.boolean(),
  documentGeneration: z.boolean(),
  validation: z.boolean(),
  parallelDocuments: z.boolean(),
  semanticRetrieval: z.boolean(),
})

export type RolloutStage = 'gate-a' | 'gate-b' | 'gate-c' | 'gate-d' | 'gate-e' | 'full'

export const rolloutStageSchema = z.enum(['gate-a', 'gate-b', 'gate-c', 'gate-d', 'gate-e', 'full'])

/** Complete-agent defaults. `semanticRetrieval` remains future work. */
export const FULL_FEATURE_FLAGS: AgentFeatureFlags = {
  streaming: true,
  repositoryTools: true,
  lsp: true,
  taskGraph: true,
  subagents: true,
  documentGeneration: true,
  validation: true,
  parallelDocuments: true,
  semanticRetrieval: false,
}

const STAGE_FLAGS: Record<RolloutStage, AgentFeatureFlags> = {
  'gate-a': { ...FULL_FEATURE_FLAGS, repositoryTools: false, lsp: false, taskGraph: false, subagents: false, documentGeneration: false, validation: false, parallelDocuments: false },
  'gate-b': { ...FULL_FEATURE_FLAGS, lsp: false, taskGraph: false, subagents: false, documentGeneration: false, validation: false, parallelDocuments: false },
  'gate-c': { ...FULL_FEATURE_FLAGS, parallelDocuments: false },
  'gate-d': { ...FULL_FEATURE_FLAGS },
  'gate-e': { ...FULL_FEATURE_FLAGS },
  full: { ...FULL_FEATURE_FLAGS },
}

/**
 * Merges a stage and optional settings override, then closes invalid dependency
 * combinations. This makes a malformed configuration conservative and keeps
 * each enabled capability executable on its required foundation.
 */
export function resolveFeatureFlags(
  stage: RolloutStage = 'full',
  override?: Partial<AgentFeatureFlags>,
): AgentFeatureFlags {
  const flags = { ...STAGE_FLAGS[stage], ...override }
  if (!flags.streaming) {
    return { ...flags, repositoryTools: false, lsp: false, taskGraph: false, subagents: false, documentGeneration: false, validation: false, parallelDocuments: false }
  }
  if (!flags.repositoryTools) flags.lsp = false
  if (!flags.taskGraph) {
    flags.subagents = false
    flags.documentGeneration = false
    flags.validation = false
    flags.parallelDocuments = false
  }
  if (!flags.subagents) {
    flags.documentGeneration = false
    flags.validation = false
    flags.parallelDocuments = false
  }
  if (!flags.documentGeneration) {
    flags.validation = false
    flags.parallelDocuments = false
  }
  if (!flags.validation) flags.parallelDocuments = false
  return flags
}

/** LSP definitions are a strict subset of deterministic repository tools. */
export function filterModelTools<T extends { name: string }>(
  tools: readonly T[],
  flags: AgentFeatureFlags,
): T[] {
  if (!flags.repositoryTools) return []
  const lspTools = new Set(['find_symbol', 'find_definition', 'find_references', 'get_imports', 'get_dependencies', 'get_dependents'])
  return tools.filter((tool) => flags.lsp || !lspTools.has(tool.name))
}
