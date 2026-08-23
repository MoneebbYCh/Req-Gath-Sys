import { describe, expect, it } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  computeRepoFingerprint,
  createFileStateStore,
  emptyState,
  loadStateSync,
  persistedAgentStateSchema,
} from './PersistedState'
import type { PersistedAgentState } from './PersistedState'

async function tmpdir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'charter-state-'))
}

function sampleState(): PersistedAgentState {
  const state = emptyState('ws-1', 'fp-1')
  state.tasks.push({
    taskId: 'task-1',
    requestId: 'req-1',
    text: 'Where is auth?',
    surface: { page: 'home' },
    title: 'Where is auth?',
    status: 'completed',
    assistantText: 'Auth is in src/auth.ts.',
    activities: ['Scanning repository'],
    documents: [],
  })
  state.findings = [
    {
      id: 'f-1',
      claim: 'Auth middleware exists',
      type: 'observed',
      domain: 'auth',
      evidenceIds: ['e-1'],
      confidence: 'high',
      assumptions: [],
      contradictions: [],
      repositoryVersion: 'rv-1',
    },
  ]
  return state
}

describe('persistedAgentState', () => {
  it('round-trips through the zod schema', () => {
    const state = sampleState()
    const parsed = persistedAgentStateSchema.parse(JSON.parse(JSON.stringify(state)))
    expect(parsed.tasks).toHaveLength(1)
    expect(parsed.tasks[0].title).toBe('Where is auth?')
    expect(parsed.findings[0].evidenceIds).toEqual(['e-1'])
  })

  it('rejects a corrupt version', () => {
    const state = sampleState()
    const raw = JSON.parse(JSON.stringify(state))
    raw.version = 99
    expect(persistedAgentStateSchema.safeParse(raw).success).toBe(false)
  })

  it('round-trips a single-loop checkpoint (plan §14 resume)', () => {
    const state = sampleState()
    state.tasks[0].loopState = {
      messages: [
        { role: 'user', content: 'original question' },
        { role: 'assistant', content: 'partial', toolCalls: [{ id: 'c1', name: 'search_code', arguments: '{}' }] },
        { role: 'tool', content: '{"matches":[]}', toolCallId: 'c1', name: 'search_code' },
      ],
      toolCallsUsed: 1,
      modelCallsUsed: 1,
      evidenceIds: ['e-1'],
    }
    const parsed = persistedAgentStateSchema.parse(JSON.parse(JSON.stringify(state)))
    expect(parsed.tasks[0].loopState?.messages).toHaveLength(3)
    expect(parsed.tasks[0].loopState?.toolCallsUsed).toBe(1)
    expect(parsed.tasks[0].loopState?.evidenceIds).toEqual(['e-1'])
  })

  it('writes atomically (temp file + rename, no tmp leftover) and loads back', async () => {
    const dir = await tmpdir()
    const file = path.join(dir, 'state.json')
    const store = createFileStateStore(file)

    await store.save(sampleState())

    const entries = await fs.readdir(dir)
    expect(entries).toEqual(['state.json']) // no .tmp files remain
    const loaded = await store.load()
    expect(loaded?.tasks[0].title).toBe('Where is auth?')
    expect(loaded?.findings[0].claim).toBe('Auth middleware exists')

    // Second save overwrites cleanly.
    const state2 = emptyState('ws-2', 'fp-2')
    await store.save(state2)
    const loaded2 = await store.load()
    expect(loaded2?.workspaceId).toBe('ws-2')
    expect(loaded2?.tasks).toHaveLength(0)
  })

  it('returns null for a missing or corrupt file (fresh start, never a crash)', async () => {
    const dir = await tmpdir()
    expect(loadStateSync(path.join(dir, 'missing.json'))).toBeNull()
    const corrupt = path.join(dir, 'state.json')
    await fs.writeFile(corrupt, '{not json', 'utf8')
    expect(loadStateSync(corrupt)).toBeNull()
    const store = createFileStateStore(corrupt)
    expect(await store.load()).toBeNull()
  })

  it('sync load matches async load', async () => {
    const dir = await tmpdir()
    const file = path.join(dir, 'state.json')
    const store = createFileStateStore(file)
    await store.save(sampleState())
    expect(loadStateSync(file)?.tasks).toHaveLength(1)
  })
})

describe('computeRepoFingerprint', () => {
  it('hashes catalog-visible files in a non-git root', async () => {
    const dir = await tmpdir()
    await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', version: '1.0.0' }), 'utf8')

    const fp1 = computeRepoFingerprint([dir])
    expect(fp1).toMatch(/^[0-9a-f]{32}$/)

    // Different content → different fingerprint (resume gating signal).
    await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', version: '2.0.0' }), 'utf8')
    const fp2 = computeRepoFingerprint([dir])
    expect(fp2).not.toBe(fp1)
  })

  it('detects a non-git source edit even when its timestamp and size are preserved', async () => {
    const dir = await tmpdir()
    const source = path.join(dir, 'src.ts')
    await fs.writeFile(source, 'export const value = 1', 'utf8')
    const before = computeRepoFingerprint([dir])
    const original = await fs.stat(source)

    // This is the failure mode of a metadata-only fallback: content changed,
    // but a restoring editor/tool can retain both the byte length and mtime.
    await fs.writeFile(source, 'export const value = 2', 'utf8')
    await fs.utimes(source, original.atime, original.mtime)

    expect(computeRepoFingerprint([dir])).not.toBe(before)
  })

  it('does not let generated/dependency output invalidate a non-git resume', async () => {
    const dir = await tmpdir()
    await fs.writeFile(path.join(dir, 'src.ts'), 'export const value = 1', 'utf8')
    await fs.mkdir(path.join(dir, 'node_modules', 'library'), { recursive: true })
    await fs.writeFile(path.join(dir, 'node_modules', 'library', 'index.js'), 'first', 'utf8')
    const before = computeRepoFingerprint([dir])

    await fs.writeFile(path.join(dir, 'node_modules', 'library', 'index.js'), 'other', 'utf8')
    expect(computeRepoFingerprint([dir])).toBe(before)
  })

  it('detects git-tracked source changes even when the manifest is unchanged', async () => {
    const dir = await tmpdir()
    const runGit = promisify(execFile)
    await runGit('git', ['-C', dir, 'init'])
    await runGit('git', ['-C', dir, 'config', 'user.email', 'test@example.com'])
    await runGit('git', ['-C', dir, 'config', 'user.name', 'Test'])
    await fs.writeFile(path.join(dir, 'package.json'), '{"name":"x"}', 'utf8')
    await fs.writeFile(path.join(dir, 'src.ts'), 'export const value = 1', 'utf8')
    await runGit('git', ['-C', dir, 'add', '.'])
    await runGit('git', ['-C', dir, 'commit', '-m', 'initial'])

    const before = computeRepoFingerprint([dir])
    await fs.writeFile(path.join(dir, 'src.ts'), 'export const value = 2', 'utf8')
    expect(computeRepoFingerprint([dir])).not.toBe(before)
  })
})
