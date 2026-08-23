import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { ToolError } from '../agent/contracts/RepositoryTool'

/**
 * Workspace containment (plan §9): every repository path a tool touches is
 * resolved through here. Lexical traversal AND symlink escapes are rejected.
 * Comparison always happens on real paths, so platform quirks like macOS
 * `/var` → `/private/var` can't cause false rejections.
 */
function isContained(target: string, roots: string[]): boolean {
  for (const root of roots) {
    const rel = path.relative(root, target)
    if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) return true
  }
  return false
}

/** Real path of the deepest existing ancestor, so symlinked directories are caught even for files that don't exist yet. */
async function realPathOfExistingPrefix(target: string): Promise<string> {
  let dir = path.dirname(target)
  const tail: string[] = []
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const real = await fs.realpath(dir)
      return path.join(real, ...tail.reverse(), path.basename(target))
    } catch {
      const parent = path.dirname(dir)
      if (parent === dir) return target // reached the filesystem root
      tail.push(path.basename(dir))
      dir = parent
    }
  }
}

/**
 * Resolves `input` to a path inside one of `roots` (multi-root aware).
 * Relative inputs resolve against each root in order. Throws `ToolError` when
 * the path escapes the workspace or points through a symlink whose real
 * target is outside.
 */
export async function resolveWithinRoots(input: string, roots: string[]): Promise<string> {
  if (roots.length === 0) {
    throw new ToolError('No workspace roots configured.', false)
  }
  const resolvedRoots = await Promise.all(roots.map((r) => fs.realpath(path.resolve(r))))

  const candidates = path.isAbsolute(input)
    ? [path.resolve(input)]
    : roots.map((r) => path.resolve(r, input))

  for (const candidate of candidates) {
    const real = await realPathOfExistingPrefix(candidate)
    if (isContained(real, resolvedRoots)) return real
  }
  throw new ToolError(`Path is outside the workspace: ${input}`, false)
}
