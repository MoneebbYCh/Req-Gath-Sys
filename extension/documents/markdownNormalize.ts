/**
 * Cheap deterministic pre-pass before remark: fix common LLM list glyphs and
 * ensure a blank line before a list that follows a paragraph (CommonMark).
 */
export function normalizeMarkdown(source: string): string {
  let s = source.replace(/\r\n/g, '\n')
  // Stray bullet glyphs → standard hyphen markers
  s = s.replace(/^(\s*)[•‣▪◦]\s+/gm, '$1- ')
  s = s.replace(/^(\s*)[–—]\s+/gm, '$1- ')

  const lines = s.split('\n')
  const out: string[] = []
  const isList = (line: string) => /^\s*([-*+]|\d+[.)])\s+/.test(line)
  const isBlank = (line: string) => line.trim().length === 0

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const prev = out.length > 0 ? out[out.length - 1]! : undefined
    // Blank line before a list that immediately follows non-list prose
    if (
      isList(line) &&
      prev !== undefined &&
      !isBlank(prev) &&
      !isList(prev)
    ) {
      out.push('')
    }
    out.push(line)
  }

  return out.join('\n').trim()
}
