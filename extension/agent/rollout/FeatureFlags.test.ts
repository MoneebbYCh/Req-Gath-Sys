import { describe, expect, it } from 'vitest'
import { filterModelTools, resolveFeatureFlags } from './FeatureFlags'

describe('feature flags', () => {
  it('builds the staged rollout profile and closes invalid dependencies', () => {
    expect(resolveFeatureFlags('gate-a')).toMatchObject({ streaming: true, repositoryTools: false, taskGraph: false })
    expect(resolveFeatureFlags('full', { taskGraph: false })).toMatchObject({ taskGraph: false, subagents: false, documentGeneration: false, validation: false, parallelDocuments: false })
    expect(resolveFeatureFlags('full', { repositoryTools: false })).toMatchObject({ repositoryTools: false, lsp: false })
  })

  it('removes repository and LSP tools before the model sees them', () => {
    const tools = [{ name: 'search_code' }, { name: 'find_symbol' }, { name: 'get_dependents' }]
    expect(filterModelTools(tools, resolveFeatureFlags('gate-b'))).toEqual([{ name: 'search_code' }])
    expect(filterModelTools(tools, resolveFeatureFlags('gate-a'))).toEqual([])
  })
})
