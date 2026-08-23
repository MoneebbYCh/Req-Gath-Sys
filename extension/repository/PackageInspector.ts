import * as fs from 'node:fs/promises'
import path from 'node:path'

/**
 * Deterministic manifest parsing (plan §10): package.json in full (without
 * lockfiles), go.mod module line, and a bounded pyproject.toml project block.
 */
export interface PackageInfo {
  manifestPath?: string
  kind?: 'npm' | 'go' | 'python'
  data: Record<string, unknown>
}

const MAX_JSON_BYTES = 128 * 1024
const MAX_PYPROJECT_BYTES = 16 * 1024

/** Find the nearest manifest in `dir` or its ancestors (up to `stopAt`). */
export async function findManifest(
  dir: string,
  stopAt: string,
): Promise<{ kind: 'npm' | 'go' | 'python'; path: string } | undefined> {
  let current = path.resolve(dir)
  const stop = path.resolve(stopAt)
  for (;;) {
    for (const [file, kind] of [
      ['package.json', 'npm'],
      ['go.mod', 'go'],
      ['pyproject.toml', 'python'],
    ] as const) {
      const candidate = path.join(current, file)
      try {
        const stat = await fs.stat(candidate)
        if (stat.isFile()) return { kind, path: candidate }
      } catch {
        /* keep looking */
      }
    }
    if (current === stop || current === path.dirname(current)) return undefined
    current = path.dirname(current)
  }
}

export async function inspectPackage(dir: string, stopAt: string): Promise<PackageInfo | undefined> {
  const manifest = await findManifest(dir, stopAt)
  if (!manifest) return undefined

  if (manifest.kind === 'npm') {
    let raw: string
    try {
      const stat = await fs.stat(manifest.path)
      if (stat.size > MAX_JSON_BYTES) {
        return { manifestPath: manifest.path, kind: 'npm', data: { name: null, _truncated: true } }
      }
      raw = await fs.readFile(manifest.path, 'utf8')
    } catch {
      return undefined
    }
    try {
      const json = JSON.parse(raw) as Record<string, unknown>
      const data: Record<string, unknown> = {
        name: json.name ?? null,
        version: json.version ?? null,
        private: json.private ?? false,
        scripts: json.scripts ?? {},
        dependencies: json.dependencies ?? {},
        devDependencies: json.devDependencies ?? {},
        workspaces: json.workspaces ?? null,
      }
      return { manifestPath: manifest.path, kind: 'npm', data }
    } catch {
      return { manifestPath: manifest.path, kind: 'npm', data: { error: 'Unparseable package.json' } }
    }
  }

  if (manifest.kind === 'go') {
    let raw: string
    try {
      raw = await fs.readFile(manifest.path, 'utf8')
    } catch {
      return undefined
    }
    const lines = raw.split('\n').slice(0, 200)
    const moduleLine = lines.find((l) => l.startsWith('module '))?.trim()
    const goLine = lines.find((l) => l.startsWith('go '))?.trim()
    const requireCount = lines.filter((l) => /^\s*require\s/.test(l)).length
    return {
      manifestPath: manifest.path,
      kind: 'go',
      data: { module: moduleLine ?? null, goVersion: goLine ?? null, requireCount },
    }
  }

  // python — bounded read of the [project] block only.
  try {
    const raw = await fs.readFile(manifest.path, 'utf8')
    const bounded = raw.slice(0, MAX_PYPROJECT_BYTES)
    const match = bounded.match(/\[project\]\s*([\s\S]*?)(?=\n\[[a-z])/i)
    const projectBlock = match ? match[1].trim() : undefined
    return {
      manifestPath: manifest.path,
      kind: 'python',
      data: { project: projectBlock ? { _block: projectBlock.slice(0, 2_000) } : null },
    }
  } catch {
    return undefined
  }
}
