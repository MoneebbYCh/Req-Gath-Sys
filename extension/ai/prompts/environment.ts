import { resolveModel, type LlmConfig } from '../llmClient'

/** OpenCode-style live environment block. */
export function buildEnvironmentBlock(args: {
  workspaceRoot: string
  llmConfig: LlmConfig
  phase: string
  label: string
}): string {
  const model = resolveModel(args.llmConfig)
  const provider = args.llmConfig.provider || 'deepseek'
  return [
    `You are powered by the model named ${model}. The exact model ID is ${provider}/${model}`,
    'Here is some useful information about the environment you are running in:',
    '<env>',
    `  Working directory: ${args.workspaceRoot}`,
    `  Platform: ${process.platform}`,
    `  Today's date: ${new Date().toDateString()}`,
    `  Charter phase: ${args.phase}`,
    `  Document label: ${args.label}`,
    '</env>',
  ].join('\n')
}
