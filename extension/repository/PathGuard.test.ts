// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { resolveWithinRoots } from './PathGuard'
import { ToolError } from '../agent/contracts/RepositoryTool'

let root: string
let root2: string
let outside: string

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'pg-root-'))
  root2 = await fs.mkdtemp(path.join(os.tmpdir(), 'pg-root2-'))
  outside = await fs.mkdtemp(path.join(os.tmpdir(), 'pg-out-'))
  await fs.mkdir(path.join(root, 'src'), { recursive: true })
  await fs.writeFile(path.join(root, 'src', 'a.ts'), 'x')
  await fs.writeFile(path.join(root2, 'b.ts'), 'y')
  await fs.writeFile(path.join(outside, 'secret.txt'), 's')
  await fs.symlink(outside, path.join(root, 'link-out'))
  await fs.symlink(path.join(root, 'src'), path.join(root, 'link-in'))
})

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true })
  await fs.rm(root2, { recursive: true, force: true })
  await fs.rm(outside, { recursive: true, force: true })
})

describe('resolveWithinRoots', () => {
  it('resolves a path inside the workspace root', async () => {
    const resolved = await resolveWithinRoots(path.join(root, 'src', 'a.ts'), [root])
    expect(resolved.endsWith(path.join('src', 'a.ts'))).toBe(true)
  })

  it('resolves relative paths against the workspace root', async () => {
    const resolved = await resolveWithinRoots('src/a.ts', [root])
    // Returns the REAL path (macOS /var → /private/var), so compare tails.
    expect(resolved.endsWith(path.join('src', 'a.ts'))).toBe(true)
  })

  it('rejects .. traversal outside the root', async () => {
    await expect(
      resolveWithinRoots(path.join(root, '..', 'escape.ts'), [root]),
    ).rejects.toBeInstanceOf(ToolError)
  })

  it('rejects absolute paths outside the root', async () => {
    await expect(resolveWithinRoots(path.join(outside, 'secret.txt'), [root])).rejects.toBeInstanceOf(
      ToolError,
    )
  })

  it('rejects symlinks that escape the workspace', async () => {
    await expect(
      resolveWithinRoots(path.join(root, 'link-out', 'secret.txt'), [root]),
    ).rejects.toBeInstanceOf(ToolError)
  })

  it('allows symlinks that stay inside the workspace', async () => {
    const resolved = await resolveWithinRoots(path.join(root, 'link-in', 'a.ts'), [root])
    expect(resolved.endsWith(path.join('src', 'a.ts'))).toBe(true)
  })

  it('supports multiple workspace roots', async () => {
    const resolved = await resolveWithinRoots(path.join(root2, 'b.ts'), [root, root2])
    expect(resolved.endsWith('b.ts')).toBe(true)
  })

  it('rejects everything when no roots are configured', async () => {
    await expect(resolveWithinRoots('x.ts', [])).rejects.toBeInstanceOf(ToolError)
  })
})
