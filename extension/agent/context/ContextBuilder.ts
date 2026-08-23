/**
 * Context assembly + token estimation (plan §10/§15). The builder allocates
 * quotas across layers in the recommended priority order instead of appending
 * until overflow — higher-priority layers (safety, objective, role) always win
 * and later layers are truncated with a marker.
 */

/** Plan §15 context layers, highest priority first. */
export interface ContextLayers {
  /** 1. System and safety rules. */
  system?: string
  /** 2. Task objective and constraints. */
  objective?: string
  /** 3. Worker role specification. */
  roleSpec?: string
  /** 4. Project/user instructions. */
  instructions?: string[]
  /** 5. Required canonical findings. */
  findings?: string[]
  /** 6. Required evidence excerpts. */
  evidenceExcerpts?: string[]
  /** 7. Recent conversation. */
  conversation?: string[]
  /** 8. Recent tool results. */
  toolResults?: string[]
}

export const TRUNCATED_MARKER = '[truncated]'

/**
 * ponytail: chars/4 — cheap, deterministic estimate; a real tokenizer would be
 * slightly more accurate but this stays stable across providers and versions.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0
  return Math.max(1, Math.ceil(text.length / 4))
}

/**
 * Assemble layers into ordered context blocks under a token budget. Layers are
 * visited in priority order; the first layer that cannot fit whole is cut to
 * fit and marked `[truncated]` — everything after it is dropped (quota
 * allocation, not append-until-overflow).
 */
export function buildContext(layers: ContextLayers, budget: number): string[] {
  const out: string[] = []
  let remaining = Math.max(0, Math.floor(budget))

  const pushSingle = (text: string): void => {
    if (!text || remaining <= 0) return
    if (estimateTokens(text) <= remaining) {
      remaining -= estimateTokens(text)
      out.push(text)
      return
    }
    const markerTokens = estimateTokens(TRUNCATED_MARKER)
    const chars = Math.max(0, remaining - markerTokens) * 4
    if (chars <= 0) return
    out.push(text.slice(0, chars) + TRUNCATED_MARKER)
    remaining = 0
  }

  const pushMany = (items: string[] | undefined): void => {
    for (const item of items ?? []) {
      if (remaining <= 0) return
      pushSingle(item)
    }
  }

  pushSingle(layers.system ?? '')
  pushSingle(layers.objective ?? '')
  pushSingle(layers.roleSpec ?? '')
  pushMany(layers.instructions)
  pushMany(layers.findings)
  pushMany(layers.evidenceExcerpts)
  pushMany(layers.conversation)
  pushMany(layers.toolResults)

  return out
}
