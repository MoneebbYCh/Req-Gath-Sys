import type { FileEntry } from './FileCatalog'
import { workspaceRootId } from './WorkspaceDescriptor'

/** Bounded package/module topology instead of a full path dump. */
export interface StructureNode {
  name: string
  /** Present on top-level nodes; disambiguates equal relative paths across roots. */
  rootId?: string
  kind: 'dir' | 'package' | 'file'
  fileCount?: number
  extensions?: Array<[string, number]>
  children?: StructureNode[]
  flags?: string[]
}

export interface StructureOptions {
  maxDepth?: number
  maxNodes?: number
  maxChildrenPerDir?: number
}

const MANIFESTS = new Set(['package.json', 'go.mod', 'pyproject.toml', 'Cargo.toml', 'pom.xml', 'build.gradle', 'build.sbt'])
const DEFAULT_MAX_DEPTH = 2
const DEFAULT_MAX_NODES = 80
const DEFAULT_MAX_CHILDREN = 15

export function buildStructure(entries: FileEntry[], options: StructureOptions = {}): { roots: StructureNode[]; truncated: boolean } {
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH
  const maxNodes = options.maxNodes ?? DEFAULT_MAX_NODES
  const maxChildren = options.maxChildrenPerDir ?? DEFAULT_MAX_CHILDREN
  let used = 0

  const buildDirectory = (rootEntries: FileEntry[], name: string, prefix: string, depth: number): StructureNode => {
    used++
    const directFiles: FileEntry[] = []
    const childEntries = new Map<string, FileEntry[]>()
    for (const entry of rootEntries) {
      if (!entry.path.startsWith(prefix)) continue
      const rest = entry.path.slice(prefix.length)
      const slash = rest.indexOf('/')
      if (slash < 0) {
        if (entry.kind === 'file') directFiles.push(entry)
      } else {
        const child = rest.slice(0, slash)
        childEntries.set(child, [...(childEntries.get(child) ?? []), entry])
      }
    }
    const extensionCounts = directFiles.reduce((counts, file) => {
      const extension = file.extension ?? 'none'
      counts.set(extension, (counts.get(extension) ?? 0) + 1)
      return counts
    }, new Map<string, number>())
    const children: StructureNode[] = []
    if (depth < maxDepth) {
      for (const childName of [...childEntries.keys()].sort().slice(0, maxChildren)) {
        if (used >= maxNodes) break
        const descendants = childEntries.get(childName)!
        const manifest = descendants.some((entry) => MANIFESTS.has(entry.path.slice(prefix.length + childName.length + 1)))
        if (manifest) {
          used++
          children.push({ name: childName, kind: 'package', fileCount: descendants.filter((entry) => entry.kind === 'file').length })
        } else {
          children.push(buildDirectory(rootEntries, childName, `${prefix}${childName}/`, depth + 1))
        }
      }
    }
    return {
      name,
      kind: 'dir',
      fileCount: directFiles.length,
      extensions: [...extensionCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5),
      children: children.length ? children : undefined,
    }
  }

  const roots: StructureNode[] = []
  for (const root of [...new Set(entries.map((entry) => entry.root))].sort()) {
    const rootEntries = entries.filter((entry) => entry.root === root)
    const names = [...new Set(rootEntries.filter((entry) => entry.kind === 'dir' && !entry.path.includes('/')).map((entry) => entry.path))].sort()
    for (const name of names) {
      if (used >= maxNodes) break
      roots.push({ ...buildDirectory(rootEntries, name, `${name}/`, 1), rootId: workspaceRootId(root) })
    }
  }
  return { roots, truncated: used >= maxNodes }
}
