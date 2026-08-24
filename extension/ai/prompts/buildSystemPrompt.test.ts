import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { inferToolBudgetProfile } from '../agentBudget'
import { buildSystemPrompt } from './buildSystemPrompt'
import { loadProjectInstructions } from './instructions'
import { CANVAS_BLOCK_CATALOG } from '../blockCatalog'

const llmConfig = { provider: 'deepseek', model: null, apiKey: '' }

describe('buildSystemPrompt', () => {
  it('research mode has no BlockNote catalog and no mega TOOL_CATALOG dump', () => {
    const budget = inferToolBudgetProfile('Where is processChat defined?', 'home')
    expect(budget.promptMode).toBe('research')
    const prompt = buildSystemPrompt({
      phase: 'home',
      label: 'Home orchestrator',
      budget,
      llmConfig,
      workspaceRoot: '/tmp/ws',
    })
    expect(prompt).toContain('/tmp/ws')
    expect(prompt).toContain('<env>')
    expect(prompt).toContain('RESEARCH POLICY')
    expect(prompt).not.toContain(CANVAS_BLOCK_CATALOG.slice(0, 40))
    expect(prompt).not.toContain('AVAILABLE TOOLS (native tool calls')
    expect(prompt).not.toContain('chromadb | ChromaClient')
    expect(prompt).toContain('ANSWER THE USER')
    expect(prompt).toContain('document":null')
  })

  it('draft mode includes canvas block catalog', () => {
    const budget = inferToolBudgetProfile('Draft the architecture section with a diagram', 'architecture')
    expect(budget.promptMode).toBe('draft')
    const prompt = buildSystemPrompt({
      phase: 'architecture',
      label: 'Architecture',
      budget,
      llmConfig,
      workspaceRoot: '/proj',
    })
    expect(prompt).toContain('DRAFT POLICY')
    expect(prompt).toContain('kpiGrid')
    expect(prompt).toContain('validate_mermaid')
  })

  it('pipeline mode includes generate_pipeline rules without block catalog', () => {
    const budget = inferToolBudgetProfile('list the docs on the pipeline', 'home')
    expect(budget.promptMode).toBe('pipeline')
    const prompt = buildSystemPrompt({
      phase: 'home',
      label: 'Home orchestrator',
      budget,
      llmConfig,
      workspaceRoot: '/proj',
    })
    expect(prompt).toContain('PIPELINE POLICY')
    expect(prompt).toContain('generate_pipeline')
    expect(prompt).not.toContain('kpiGrid')
  })

  it('includes project instructions when provided', () => {
    const budget = inferToolBudgetProfile('hello', 'home')
    const prompt = buildSystemPrompt({
      phase: 'home',
      label: 'Home',
      budget,
      llmConfig,
      workspaceRoot: '/proj',
      instructionsText: 'Instructions from: /proj/AGENTS.md\nUse pnpm not npm.',
    })
    expect(prompt).toContain('Use pnpm not npm')
  })
})

describe('loadProjectInstructions', () => {
  const dirs: string[] = []

  afterEach(async () => {
    for (const d of dirs.splice(0)) {
      await fs.rm(d, { recursive: true, force: true })
    }
  })

  it('loads .charter-ai/AGENTS.md preferentially', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'charter-agents-'))
    dirs.push(root)
    await fs.mkdir(path.join(root, '.charter-ai'))
    await fs.writeFile(path.join(root, '.charter-ai', 'AGENTS.md'), 'Prefer charter agents.', 'utf8')
    await fs.writeFile(path.join(root, 'AGENTS.md'), 'Root agents.', 'utf8')
    const text = await loadProjectInstructions(root)
    expect(text).toContain('Prefer charter agents.')
    expect(text).not.toContain('Root agents.')
  })

  it('falls back to root AGENTS.md', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'charter-agents-'))
    dirs.push(root)
    await fs.writeFile(path.join(root, 'AGENTS.md'), 'Root only.', 'utf8')
    const text = await loadProjectInstructions(root)
    expect(text).toContain('Root only.')
  })

  it('returns undefined when missing', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'charter-agents-'))
    dirs.push(root)
    expect(await loadProjectInstructions(root)).toBeUndefined()
  })
})
