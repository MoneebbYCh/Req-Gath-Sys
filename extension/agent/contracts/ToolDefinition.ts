import { z } from 'zod'

/**
 * The deterministic read-only repository tool catalogue (plan §24). No write,
 * shell, patch, or delete tool exists — read-only is enforced by the absence of
 * those capabilities from this set.
 */
export type RepositoryToolName =
  | 'list_files'
  | 'search_files'
  | 'search_code'
  | 'read_file'
  | 'read_file_range'
  | 'get_project_structure'
  | 'get_package_info'
  | 'find_symbol'
  | 'find_definition'
  | 'find_references'
  | 'find_implementations'
  | 'get_imports'
  | 'get_dependencies'
  | 'get_dependents'
  | 'get_diagnostics'
  | 'get_call_hierarchy'
  | 'get_git_diff'
  | 'get_git_history'
  | 'get_repository_capabilities'
  | 'get_index_status'

export const repositoryToolNameSchema = z.enum([
  'list_files',
  'search_files',
  'search_code',
  'read_file',
  'read_file_range',
  'get_project_structure',
  'get_package_info',
  'find_symbol',
  'find_definition',
  'find_references',
  'find_implementations',
  'get_imports',
  'get_dependencies',
  'get_dependents',
  'get_diagnostics',
  'get_call_hierarchy',
  'get_git_diff',
  'get_git_history',
  'get_repository_capabilities',
  'get_index_status',
])

/**
 * A tool as exposed to the model: name, description, and a JSON-serializable
 * input schema. The runtime-side implementation (`RepositoryTool`) owns the zod
 * schema used for actual input validation.
 */
export interface ToolDefinition {
  name: string
  description: string
  inputJsonSchema: Record<string, unknown>
}

export const toolDefinitionSchema = z.object({
  name: z.string(),
  description: z.string(),
  inputJsonSchema: z.record(z.string(), z.unknown()),
})
