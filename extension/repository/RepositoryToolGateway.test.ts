// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { RepositoryToolGateway } from './RepositoryToolGateway'
import { ToolError, type RepositoryTool } from '../agent/contracts/RepositoryTool'

let root: string

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'gw-root-'))
  await fs.mkdir(path.join(root, 'src'), { recursive: true })
})

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

const echoTool: RepositoryTool<{ text?: string }, { text?: string; resolved?: string }> = {
  name: 'echo',
  description: 'echoes input back',
  inputSchema: z.object({ text: z.string().optional() }),
  execute: async (input, ctx) => ({
    data: { text: input.text ?? '', resolved: undefined },
    truncated: false,
    repositoryVersion: ctx.repositoryVersion,
  }),
}

const pathTool: RepositoryTool<{ p: string }, { resolved: string }> = {
  name: 'path',
  description: 'resolves a path through the guard',
  inputSchema: z.object({ p: z.string() }),
  execute: async (input, ctx) => ({
    data: { resolved: await ctx.resolvePath(input.p) },
    truncated: false,
    repositoryVersion: ctx.repositoryVersion,
  }),
}

const boomTool: RepositoryTool<object, unknown> = {
  name: 'boom',
  description: 'throws a generic error',
  inputSchema: z.object({}),
  execute: async () => {
    throw new Error('disk exploded')
  },
}

const hangTool: RepositoryTool<object, unknown> = {
  name: 'hang',
  description: 'waits for the signal',
  inputSchema: z.object({}),
  execute: (_input, ctx) =>
    new Promise((_resolve, reject) => {
      ctx.signal.addEventListener('abort', () => reject(new Error('aborted')))
    }),
}

function gateway(overrides: ConstructorParameters<typeof RepositoryToolGateway>[0] = {}) {
  const g = new RepositoryToolGateway(overrides)
  g.register(echoTool)
  g.register(pathTool)
  g.register(boomTool)
  g.register(hangTool)
  return g
}

function opts(signal?: AbortSignal) {
  return {
    workspaceRoots: [root],
    repositoryVersion: 'rv-1',
    signal: signal ?? new AbortController().signal,
  }
}

describe('RepositoryToolGateway', () => {
  it('executes a registered tool and injects the repository version', async () => {
    const result = await gateway().execute('echo', { text: 'hi' }, opts())
    expect(result.repositoryVersion).toBe('rv-1')
    expect(result.data).toEqual({ text: 'hi', resolved: undefined })
  })

  it('rejects unknown tools with a structured error', async () => {
    await expect(gateway().execute('delete_file', {}, opts())).rejects.toMatchObject({
      name: 'ToolError',
      retryable: false,
    })
  })

  it('rejects invalid input with a structured error', async () => {
    await expect(gateway().execute('echo', { text: 42 }, opts())).rejects.toThrow(/Invalid input/)
  })

  it('normalizes generic tool exceptions into ToolError', async () => {
    await expect(gateway().execute('boom', {}, opts())).rejects.toMatchObject({
      name: 'ToolError',
      message: expect.stringContaining('disk exploded'),
      retryable: false,
    })
  })

  it('passes ToolError through untouched', async () => {
    const custom: RepositoryTool<object, unknown> = {
      name: 'custom',
      description: 'throws a ToolError',
      inputSchema: z.object({}),
      execute: async () => {
        throw new ToolError('sensitive file blocked', false)
      },
    }
    const g = gateway()
    g.register(custom)
    await expect(g.execute('custom', {}, opts())).rejects.toMatchObject({
      name: 'ToolError',
      message: 'sensitive file blocked',
    })
  })

  it('times out hung tools with a retryable error', async () => {
    await expect(gateway({ toolTimeoutMs: 30 }).execute('hang', {}, opts())).rejects.toMatchObject({
      retryable: true,
      message: expect.stringContaining('timed out'),
    })
  })

  it('maps user cancellation to a structured non-retryable error', async () => {
    const controller = new AbortController()
    const promise = gateway().execute('hang', {}, opts(controller.signal))
    controller.abort()
    await expect(promise).rejects.toMatchObject({ message: 'Tool call cancelled.', retryable: false })
  })

  it('provides workspace guard + sensitive policy through the context', async () => {
    const result = await gateway().execute('path', { p: 'src' }, opts())
    expect((result.data as { resolved: string }).resolved).toContain('src')

    await expect(gateway().execute('path', { p: '../outside' }, opts())).rejects.toBeInstanceOf(
      ToolError,
    )

    const sensitiveTool: RepositoryTool<object, { sensitive: boolean }> = {
      name: 'sensitive',
      description: 'checks the policy',
      inputSchema: z.object({}),
      execute: async (_input, ctx) => ({
        data: { sensitive: ctx.isSensitivePath('.env') },
        truncated: false,
        repositoryVersion: ctx.repositoryVersion,
      }),
    }
    const g = gateway()
    g.register(sensitiveTool)
    const r = await g.execute('sensitive', {}, opts())
    expect((r.data as { sensitive: boolean }).sensitive).toBe(true)
  })

  it('redacts secret literals from results before they reach the caller', async () => {
    const secretTool: RepositoryTool<object, { text: string }> = {
      name: 'secret',
      description: 'returns a secret-looking string',
      inputSchema: z.object({}),
      execute: async (_input, ctx) => ({
        data: { text: 'key=sk-abc123def456ghi789' },
        truncated: false,
        repositoryVersion: ctx.repositoryVersion,
      }),
    }
    const g = gateway()
    g.register(secretTool)
    const r = await g.execute('secret', {}, opts())
    const text = (r.data as { text: string }).text
    expect(text).not.toContain('sk-abc123def456ghi789')
    expect(text).toContain('***redacted***')
  })

  it('truncates oversized results and adds a warning', async () => {
    const bigTool: RepositoryTool<object, { blob: string }> = {
      name: 'big',
      description: 'returns a huge blob',
      inputSchema: z.object({}),
      execute: async (_input, ctx) => ({
        data: { blob: 'z'.repeat(10_000) },
        truncated: false,
        repositoryVersion: ctx.repositoryVersion,
      }),
    }
    const g = gateway({ maxResultBytes: 300 })
    g.register(bigTool)
    const r = await g.execute('big', {}, opts())
    expect(r.truncated).toBe(true)
    expect(JSON.stringify(r.data).length).toBeLessThanOrEqual(300)
    expect(r.warnings?.[0]).toContain('truncated')
  })
})
