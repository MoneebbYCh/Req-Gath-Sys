import { sanitizeMermaidLabels } from '../../shared/mermaidSanitize'

/**
 * Node-side Mermaid syntax validation for the agent worker. `mermaid.parse`
 * needs a DOM for flowchart sanitization (mermaid's own test harness runs it
 * under jsdom), so the default parser lazily installs jsdom globals — safe
 * because the agent worker is an isolated thread with no other DOM consumers —
 * and dynamically imports the same `mermaid` version the webview renders.
 * Validating what the renderer parses (label-sanitized source) is what makes
 * "validated" mean "will render".
 */

export interface MermaidValidationResult {
  ok: boolean
  diagramType?: string
  error?: string
}

export type MermaidParseFn = (source: string) => Promise<{ diagramType: string }>

let nodeParser: Promise<MermaidParseFn> | undefined

function loadNodeParser(): Promise<MermaidParseFn> {
  if (!nodeParser) {
    nodeParser = (async () => {
      const { JSDOM } = (await import('jsdom')) as { JSDOM: new (html: string) => { window: unknown; } }
      const dom = new JSDOM('<!doctype html><html><body></body></html>')
      const globals = globalThis as Record<string, unknown>
      globals.window = dom.window
      globals.document = (dom.window as { document: unknown }).document
      // Mirrors mermaid's own jsdom test harness: jsdom's MutationObserver
      // breaks cytoscape-based diagram modules during import.
      globals.MutationObserver = undefined
      const mod = (await import('mermaid')) as {
        default: {
          initialize: (config: Record<string, unknown>) => void
          parse: (text: string) => Promise<{ diagramType: string }>
        }
      }
      mod.default.initialize({ startOnLoad: false, securityLevel: 'strict' })
      return (source: string) => mod.default.parse(source)
    })().catch((err) => {
      nodeParser = undefined
      throw err
    })
  }
  return nodeParser
}

export interface MermaidValidatorOptions {
  /** Injectable parser for tests; defaults to jsdom + mermaid in Node. */
  parse?: MermaidParseFn
}

export function createMermaidValidator(options: MermaidValidatorOptions = {}): (source: string) => Promise<MermaidValidationResult> {
  const parse = options.parse ?? (async (source) => (await loadNodeParser())(source))
  return async (source: string): Promise<MermaidValidationResult> => {
    const trimmed = (source ?? '').trim()
    if (!trimmed) return { ok: false, error: 'Empty diagram' }
    const normalized = sanitizeMermaidLabels(trimmed)
    try {
      const result = await parse(normalized)
      return { ok: true, diagramType: result.diagramType }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { ok: false, error: message.slice(0, 500) }
    }
  }
}
