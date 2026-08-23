/**
 * Output limiting (plan §9): every tool output is bounded before it can reach
 * a model. Tools apply their own line/byte limits (Phase 5); the gateway uses
 * this as a hard safety net that truncates the largest strings until the whole
 * result fits the byte budget.
 */

const MAX_WALK_DEPTH = 24
const MAX_TRUNCATION_ROUNDS = 8

interface StringLeaf {
  parent: Record<string | number, unknown> | unknown[]
  key: string | number
  text: string
}

function collectStringLeaves(value: unknown): StringLeaf[] {
  const leaves: StringLeaf[] = []
  const seen = new Set<object>()

  const walk = (node: unknown, depth: number): void => {
    if (depth > MAX_WALK_DEPTH || node === null || typeof node !== 'object') return
    if (seen.has(node)) return
    seen.add(node)
    if (Array.isArray(node)) {
      node.forEach((child, i) => {
        if (typeof child === 'string') leaves.push({ parent: node, key: i, text: child })
        else walk(child, depth + 1)
      })
    } else {
      for (const [k, child] of Object.entries(node)) {
        if (typeof child === 'string') {
          leaves.push({ parent: node as Record<string, unknown>, key: k, text: child })
        } else walk(child, depth + 1)
      }
    }
  }

  walk(value, 0)
  return leaves
}

/**
 * Returns `value` unchanged when it fits `maxBytes`; otherwise truncates the
 * largest string leaves (halving them each round) and reports `truncated`.
 */
export function truncateStringsToBudget(
  value: unknown,
  maxBytes: number,
): { value: unknown; truncated: boolean } {
  if (JSON.stringify(value).length <= maxBytes) return { value, truncated: false }

  const leaves = collectStringLeaves(value)
  if (leaves.length === 0) {
    // Pure non-string data already over budget — nothing safe to truncate.
    return { value, truncated: true }
  }

  for (let round = 0; round < MAX_TRUNCATION_ROUNDS; round++) {
    if (JSON.stringify(value).length <= maxBytes) break
    let biggest = leaves[0]
    for (const leaf of leaves) {
      if (leaf.text.length > biggest.text.length) biggest = leaf
    }
    if (biggest.text.length <= 1) break
    biggest.text = `${biggest.text.slice(0, Math.max(1, Math.floor(biggest.text.length / 2)))}…`
    ;(biggest.parent as Record<string | number, unknown>)[biggest.key] = biggest.text
  }

  return { value, truncated: true }
}
