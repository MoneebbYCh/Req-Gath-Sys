import { describe, expect, it } from 'vitest'
import { buildStructure } from './ProjectDiscovery'
import type { FileEntry } from './FileCatalog'
import { workspaceRootId } from './WorkspaceDescriptor'

function entry(path: string, kind: 'file' | 'dir' = 'file', extension?: string): FileEntry {
  return { path, kind, size: 0, extension, flags: [], root: '' }
}

const entries: FileEntry[] = [
  entry('src', 'dir'),
  entry('src/auth.ts', 'file', 'ts'),
  entry('src/index.ts', 'file', 'ts'),
  entry('src/components', 'dir'),
  entry('src/components/Button.tsx', 'file', 'tsx'),
  entry('package.json', 'file', 'json'),
  entry('README.md', 'file', 'md'),
  entry('apps', 'dir'),
  entry('apps/api', 'dir'),
  entry('apps/api/package.json', 'file', 'json'),
  entry('apps/api/main.ts', 'file', 'ts'),
]

describe('buildStructure', () => {
  it('summarizes top-level dirs with file counts and extensions', () => {
    const { roots, truncated } = buildStructure(entries)
    expect(truncated).toBe(false)
    const byName = Object.fromEntries(roots.map((r) => [r.name, r]))

    const src = byName['src']
    expect(src.fileCount).toBe(2)
    expect(src.extensions).toEqual([['ts', 2]])
    expect(src.children?.map((c) => c.name)).toContain('components')

    // manifest-bearing dirs are marked as packages
    const apps = byName['apps']
    expect(apps.children?.[0]).toMatchObject({ name: 'api', kind: 'package', fileCount: 2 })
  })

  it('respects the node budget', () => {
    const many: FileEntry[] = []
    for (let i = 0; i < 50; i++) {
      many.push(entry(`d${i}`, 'dir'))
      many.push(entry(`d${i}/f.ts`, 'file', 'ts'))
    }
    const { roots, truncated } = buildStructure(many, { maxNodes: 5 })
    expect(roots.length).toBeLessThanOrEqual(5)
    expect(truncated).toBe(true)
  })

  it('ignores root-level files (only directories become roots)', () => {
    const { roots } = buildStructure([entry('a.ts', 'file', 'ts'), entry('b.md', 'file', 'md')])
    expect(roots).toHaveLength(0)
  })

  it('does not merge identical directory names from different workspace roots', () => {
    const leftRoot = '/workspace/left'
    const rightRoot = '/workspace/right'
    const { roots } = buildStructure([
      { ...entry('src', 'dir'), root: leftRoot },
      { ...entry('src/left.ts', 'file', 'ts'), root: leftRoot },
      { ...entry('src', 'dir'), root: rightRoot },
      { ...entry('src/right.ts', 'file', 'ts'), root: rightRoot },
    ])
    expect(roots.filter((node) => node.name === 'src')).toHaveLength(2)
    expect(new Set(roots.map((node) => node.rootId))).toEqual(
      new Set([workspaceRootId(leftRoot), workspaceRootId(rightRoot)]),
    )
  })
})
