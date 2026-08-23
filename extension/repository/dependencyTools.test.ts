// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import path from 'node:path'
import { RepositoryService } from './RepositoryService'
import { ToolError } from '../agent/contracts/RepositoryTool'
import { workspaceRootId } from './WorkspaceDescriptor'

let root: string

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'dep-root-'))
  await fs.mkdir(path.join(root, 'src'), { recursive: true })
  await fs.writeFile(path.join(root, 'src', 'util.ts'), 'export const x = 1\n')
  await fs.writeFile(path.join(root, 'src', 'lazy.ts'), 'export const y = 2\n')
  await fs.writeFile(
    path.join(root, 'src', 'main.ts'),
    [
      "import React from 'react'",
      "import { x } from './util'",
      "export { x } from './util'",
      "const fs = require('node:fs')",
      "const lazy = await import('./lazy')",
    ].join('\n'),
  )
  await fs.writeFile(path.join(root, 'consumer.ts'), "import { x } from './src/util'\n")
  await fs.writeFile(path.join(root, 'src', 'dep.test.ts'), "import { x } from './util'\n")
  await fs.writeFile(path.join(root, 'notes.md'), 'just prose\n')
  await fs.writeFile(path.join(root, 'big.ts'), `import { z } from 'zod'\n${'// filler\n'.repeat(5000)}`)
  await fs.writeFile(path.join(root, '.env'), 'API_KEY=supersecret')
})

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

function service() {
  return new RepositoryService({ roots: [root], repositoryVersion: 'rv-dep' })
}

function signal(): AbortSignal {
  return new AbortController().signal
}

describe('dependency tools', () => {
  it('get_imports lists imports with per-edge provenance', async () => {
    const r = await service().executeTool('get_imports', { path: 'src/main.ts' }, signal())
    const data = r.data as {
      available: boolean
      imports: Array<{ target: string; kind: string; provenance: string; line: number }>
    }
    expect(data.available).toBe(true)
    expect(data.imports).toEqual([
      { target: 'react', kind: 'static', provenance: 'parser', line: 1 },
      { target: './util', kind: 'static', provenance: 'parser', line: 2 },
      { target: './util', kind: 'reexport', provenance: 'parser', line: 3 },
      { target: 'node:fs', kind: 'require', provenance: 'parser', line: 4 },
      { target: './lazy', kind: 'dynamic', provenance: 'parser', line: 5 },
    ])
    expect(r.evidenceCandidates?.[0]).toMatchObject({ path: 'src/main.ts', sourceTool: 'get_imports' })
  })

  it('get_imports degrades honestly for unsupported languages', async () => {
    const r = await service().executeTool('get_imports', { path: 'notes.md' }, signal())
    expect(r.data).toMatchObject({ available: false })
  })

  it('get_imports blocks sensitive files', async () => {
    await expect(service().executeTool('get_imports', { path: '.env' }, signal())).rejects.toBeInstanceOf(
      ToolError,
    )
  })

  it('get_imports on a large file warns about partial extraction', async () => {
    const r = await service().executeTool('get_imports', { path: 'big.ts' }, signal())
    const data = r.data as { warning?: string; imports: Array<{ target: string }> }
    expect(data.warning).toContain('first 400 lines')
    expect(data.imports[0].target).toBe('zod')
  })

  it('get_dependencies resolves local modules and lists external packages', async () => {
    const r = await service().executeTool('get_dependencies', { path: 'src/main.ts' }, signal())
    const data = r.data as {
      localDependencies: Array<{ path: string; resolved: boolean; via: string }>
      externalPackages: string[]
    }
    expect(data.localDependencies).toEqual([
      { path: 'src/util.ts', rootId: workspaceRootId(root), resolved: true, via: './util', line: 2 },
      { path: 'src/util.ts', rootId: workspaceRootId(root), resolved: true, via: './util', line: 3 },
      { path: 'src/lazy.ts', rootId: workspaceRootId(root), resolved: true, via: './lazy', line: 5 },
    ])
    expect(data.externalPackages).toEqual(['node:fs', 'react'])
  })

  it('get_dependencies reports unresolved local specifiers honestly', async () => {
    await fs.writeFile(
      path.join(root, 'src', 'broken.ts'),
      "import { missing } from './does-not-exist'\n",
    )
    const r = await service().executeTool('get_dependencies', { path: 'src/broken.ts' }, signal())
    const data = r.data as { localDependencies: Array<{ path: string; resolved: boolean }> }
    expect(data.localDependencies).toEqual([{ path: 'src/does-not-exist', rootId: workspaceRootId(root), resolved: false, via: './does-not-exist', line: 1 }])
  })

  it('resolves same relative imports inside their selected root without cross-root leakage', async () => {
    const secondRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dep-secondary-'))
    await fs.mkdir(path.join(secondRoot, 'src'))
    await fs.writeFile(path.join(secondRoot, 'src', 'util.ts'), 'export const source = "secondary"\n')
    await fs.writeFile(path.join(secondRoot, 'src', 'main.ts'), "import { source } from './util'\n")
    const svc = new RepositoryService({ roots: [root, secondRoot], repositoryVersion: 'rv-dep-two-root' })
    const r = await svc.executeTool('get_dependencies', {
      path: 'src/main.ts',
      rootId: workspaceRootId(secondRoot),
    }, signal())
    const local = (r.data as { localDependencies: Array<{ path: string; rootId: string; resolved: boolean }> }).localDependencies
    expect(local).toEqual([{ path: 'src/util.ts', rootId: workspaceRootId(secondRoot), resolved: true, via: './util', line: 1 }])
    await fs.rm(secondRoot, { recursive: true, force: true })
  })

  it('get_dependents finds importers via lexical reverse scan with inference provenance', async () => {
    const r = await service().executeTool('get_dependents', { path: 'src/util.ts' }, signal())
    const data = r.data as {
      provenance: string
      dependents: Array<{ path: string }>
      hint: string
    }
    expect(data.provenance).toBe('inference')
    expect(data.dependents.map((d) => d.path).sort()).toEqual([
      'consumer.ts',
      'src/dep.test.ts',
      'src/main.ts',
    ])
    expect(data.hint).toContain('Lexical scan')
  })

  it('get_dependents excludes the module itself and blocks sensitive files', async () => {
    const r = await service().executeTool('get_dependents', { path: 'src/main.ts' }, signal())
    const data = r.data as { dependents: Array<{ path: string }> }
    expect(data.dependents.map((d) => d.path)).not.toContain('src/main.ts')
    await expect(
      service().executeTool('get_dependents', { path: '.env' }, signal()),
    ).rejects.toBeInstanceOf(ToolError)
  })
})
