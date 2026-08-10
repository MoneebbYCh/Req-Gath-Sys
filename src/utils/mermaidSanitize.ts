/**
 * Mermaid treats bare `{}` as diamond nodes. Labels like
 * `A[GET /universities/{slug}]` therefore fail to parse.
 * Quote labels that contain shape/punctuation specials.
 */

const LABEL_SPECIALS = /[{}<>|#;]/

function quoteIfNeeded(label: string): string {
  const trimmed = label.trim()
  if (!trimmed) return '""'
  // Already quoted
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed
  }
  if (!LABEL_SPECIALS.test(trimmed) && !/\//.test(trimmed)) {
    return trimmed
  }
  const escaped = trimmed.replace(/\\/g, '\\\\').replace(/"/g, "'")
  return `"${escaped}"`
}

/**
 * Quote flowchart/graph node labels and edge labels that would break Mermaid.
 * Safe to run repeatedly.
 */
export function sanitizeMermaidLabels(code: string): string {
  if (!code) return code

  // Node shapes: Id[label] / Id(label) / Id{label} — only fix square-bracket text
  // nodes where {} inside the label is the common LLM footgun.
  let out = code.replace(
    /(\b[A-Za-z][\w]*)\[\s*(?!")([^\]]*?)\]/g,
    (_m, id: string, label: string) => `${id}[${quoteIfNeeded(label)}]`,
  )

  // Edge labels: -->|text with {x}| or ---|text|
  out = out.replace(
    /(\|--?>?|--)\s*\|(?!\s*")([^|]*?)\|/g,
    (_m, arrow: string, label: string) => {
      if (!LABEL_SPECIALS.test(label) && !/\//.test(label)) return `${arrow}|${label}|`
      return `${arrow}|${quoteIfNeeded(label)}|`
    },
  )

  // Also: A -->|text| B  form already covered; A -- text --> B is rarer.

  return out
}
