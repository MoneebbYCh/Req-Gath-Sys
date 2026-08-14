import { describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { runTool, needsDestructiveConfirm, type ToolContext } from './tools'

// 'vscode' resolves to src/test/stubs/vscode.ts in tests (vitest alias) — its
// workspace.fs is backed by real node fs, so the tools can run against a temp
// workspace.

const SEED_DOCS = [
  { id: 'doc-a', name: 'Doc A', icon: 'description', createdAt: 1, order: 0 },
  { id: 'doc-b', name: 'Doc B', icon: 'description', createdAt: 2, order: 1 },
]

function makeCtx(confirmDestructive?: (what: string) => Promise<boolean>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'charter-tools-'))
  fs.mkdirSync(path.join(dir, '.charter-ai'), { recursive: true })
  fs.writeFileSync(path.join(dir, '.charter-ai', 'doc-types.json'), JSON.stringify(SEED_DOCS))
  const confirmSpy = confirmDestructive ? vi.fn(confirmDestructive) : undefined
  const ctx: ToolContext = {
    workspaceRoot: dir,
    onDocTypesChanged: vi.fn(),
    ...(confirmSpy ? { confirmDestructive: confirmSpy } : {}),
  }
  return { dir, ctx, confirmSpy }
}

function storedDocs(dir: string): unknown[] {
  return JSON.parse(
    fs.readFileSync(path.join(dir, '.charter-ai', 'doc-types.json'), 'utf8'),
  )
}

describe('needsDestructiveConfirm', () => {
  it('requires confirmation for remove_pipeline_docs all:true', () => {
    expect(needsDestructiveConfirm('remove_pipeline_docs', { all: true })).toBe(true)
    expect(needsDestructiveConfirm('remove_pipeline_docs', { all: 'true' })).toBe(true)
  })

  it('does not require confirmation for targeted removals', () => {
    expect(needsDestructiveConfirm('remove_pipeline_docs', { ids: ['doc-a'] })).toBe(false)
    expect(needsDestructiveConfirm('remove_pipeline_docs', { names: ['doc a'] })).toBe(false)
  })

  it('requires confirmation for generate_pipeline replace mode', () => {
    expect(needsDestructiveConfirm('generate_pipeline', { mode: 'replace' })).toBe(true)
    expect(needsDestructiveConfirm('generate_pipeline', { mode: 'REPLACE' })).toBe(true)
  })

  it('does not require confirmation for append mode', () => {
    expect(needsDestructiveConfirm('generate_pipeline', {})).toBe(false)
    expect(needsDestructiveConfirm('generate_pipeline', { mode: 'append' })).toBe(false)
  })

  it('never requires confirmation for non-destructive tools', () => {
    expect(needsDestructiveConfirm('read_file', {})).toBe(false)
  })
})

describe('runTool destructive gate (N5)', () => {
  it('declines remove_pipeline_docs all:true when the user cancels', async () => {
    const { dir, ctx, confirmSpy } = makeCtx(() => Promise.resolve(false))

    const obs = await runTool('remove_pipeline_docs', { all: true }, ctx)

    expect(obs).toMatch(/declined/i)
    expect(confirmSpy).toHaveBeenCalledTimes(1)
    expect(storedDocs(dir)).toHaveLength(2) // nothing deleted
    expect(ctx.destructiveDeclined).toBe(true)
  })

  it('does not re-prompt after a decline in the same run', async () => {
    const { ctx, confirmSpy } = makeCtx(() => Promise.resolve(false))

    await runTool('remove_pipeline_docs', { all: true }, ctx)
    const second = await runTool('remove_pipeline_docs', { all: true }, ctx)

    expect(second).toMatch(/declined/i)
    expect(confirmSpy).toHaveBeenCalledTimes(1) // no modal spam
  })

  it('removes all docs when the user approves', async () => {
    const { dir, ctx, confirmSpy } = makeCtx(() => Promise.resolve(true))

    const obs = await runTool('remove_pipeline_docs', { all: true }, ctx)

    expect(obs).toMatch(/Removed 2 document/)
    expect(confirmSpy).toHaveBeenCalledTimes(1)
    expect(storedDocs(dir)).toHaveLength(0)
  })

  it('executes as before when no confirm hook is wired', async () => {
    const { dir, ctx } = makeCtx()

    const obs = await runTool('remove_pipeline_docs', { all: true }, ctx)

    expect(obs).toMatch(/Removed 2 document/)
    expect(storedDocs(dir)).toHaveLength(0)
  })

  it('leaves targeted removals ungated', async () => {
    const { dir, ctx, confirmSpy } = makeCtx(() => Promise.resolve(true))

    const obs = await runTool('remove_pipeline_docs', { ids: ['doc-a'] }, ctx)

    expect(obs).toMatch(/Removed 1 document/)
    expect(confirmSpy).not.toHaveBeenCalled()
    expect(storedDocs(dir)).toHaveLength(1)
  })
})