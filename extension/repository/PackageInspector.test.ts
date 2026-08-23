// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import path from 'node:path'
import { inspectPackage } from './PackageInspector'

let root: string

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'pkg-root-'))
  await fs.mkdir(path.join(root, 'apps', 'web', 'src'), { recursive: true })
  await fs.mkdir(path.join(root, 'gopkg'), { recursive: true })
  await fs.mkdir(path.join(root, 'pyproj'), { recursive: true })
  await fs.writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({
      name: 'demo',
      version: '1.2.3',
      scripts: { build: 'vite build' },
      dependencies: { react: '^19.0.0' },
      devDependencies: { vite: '^8.0.0' },
      lockfileIgnored: true,
    }),
  )
  await fs.writeFile(
    path.join(root, 'apps', 'web', 'package.json'),
    JSON.stringify({ name: 'web', dependencies: {} }),
  )
  await fs.writeFile(
    path.join(root, 'gopkg', 'go.mod'),
    'module example.com/gopkg\n\ngo 1.24\n\nrequire (\n\tgithub.com/foo/bar v1.0.0\n)\n',
  )
  await fs.writeFile(
    path.join(root, 'pyproj', 'pyproject.toml'),
    '[project]\nname = "pyproj"\ndependencies = ["fastapi"]\n\n[tool.ruff]\nline-length = 100\n',
  )
})

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

describe('PackageInspector', () => {
  it('parses package.json with scripts and dependencies', async () => {
    const info = await inspectPackage(root, root)
    expect(info?.kind).toBe('npm')
    expect(info?.data).toMatchObject({
      name: 'demo',
      version: '1.2.3',
      scripts: { build: 'vite build' },
      dependencies: { react: '^19.0.0' },
    })
  })

  it('finds the nearest manifest for a nested directory', async () => {
    const info = await inspectPackage(path.join(root, 'apps', 'web', 'src'), root)
    expect(info?.kind).toBe('npm')
    expect(info?.data).toMatchObject({ name: 'web' })
  })

  it('parses go.mod to module + require count', async () => {
    const info = await inspectPackage(path.join(root, 'gopkg'), root)
    expect(info?.kind).toBe('go')
    expect(info?.data).toMatchObject({ module: 'module example.com/gopkg', goVersion: 'go 1.24', requireCount: 1 })
  })

  it('extracts a bounded [project] block from pyproject.toml', async () => {
    const info = await inspectPackage(path.join(root, 'pyproj'), root)
    expect(info?.kind).toBe('python')
    expect(String((info?.data as { project?: { _block?: string } }).project?._block)).toContain('fastapi')
    expect(String((info?.data as { project?: { _block?: string } }).project?._block)).not.toContain('tool.ruff')
  })

  it('returns undefined when no manifest exists', async () => {
    const empty = await fs.mkdtemp(path.join(os.tmpdir(), 'pkg-empty-'))
    const info = await inspectPackage(empty, empty)
    expect(info).toBeUndefined()
    await fs.rm(empty, { recursive: true, force: true })
  })
})
