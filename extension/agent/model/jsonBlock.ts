/**
 * Lenient JSON extraction from model output (plan §9/§12): prefers a fenced
 * ```json block, falls back to the first {...} object in the answer. Returns
 * undefined rather than throwing — callers validate the result.
 */
export function extractJsonBlock(text: string): unknown | undefined {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  const candidate = fence ? fence[1].trim() : text.trim()
  try {
    return JSON.parse(candidate)
  } catch {
    const object = candidate.match(/\{[\s\S]*\}/)
    if (!object) return undefined
    try {
      return JSON.parse(object[0])
    } catch {
      return undefined
    }
  }
}
