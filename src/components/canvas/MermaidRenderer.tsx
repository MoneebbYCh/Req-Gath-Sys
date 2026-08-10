import { useEffect, useId, useState } from 'react'
import mermaid from 'mermaid'
import { sanitizeMermaidLabels } from '../../utils/mermaidSanitize'

let mermaidReady = false

function ensureMermaid() {
  if (mermaidReady) return
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    theme: 'neutral',
    fontFamily: 'var(--font-body, system-ui, sans-serif)',
  })
  mermaidReady = true
}

interface MermaidRendererProps {
  code: string
  className?: string
}

/** Renders Mermaid source to SVG. Shows parse/render errors inline. */
export function MermaidRenderer({ code, className }: MermaidRendererProps) {
  const reactId = useId().replace(/:/g, '')
  const [svg, setSvg] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const run = async () => {
      const source = sanitizeMermaidLabels((code || '').trim())
      if (!source) {
        setSvg(null)
        setError('Empty diagram')
        return
      }
      try {
        ensureMermaid()
        await mermaid.parse(source)
        const id = `rg-mermaid-${reactId}-${Date.now()}`
        const { svg: rendered } = await mermaid.render(id, source)
        if (!cancelled) {
          setSvg(rendered)
          setError(null)
        }
      } catch (err) {
        if (!cancelled) {
          setSvg(null)
          setError(err instanceof Error ? err.message : String(err))
        }
      }
    }
    void run()
    return () => {
      cancelled = true
    }
  }, [code, reactId])

  if (error) {
    return (
      <div className={`rg-diagram-error ${className ?? ''}`} role="alert">
        <span className="rg-diagram-error-label">Diagram error</span>
        <pre className="rg-diagram-error-body">{error}</pre>
      </div>
    )
  }

  if (!svg) {
    return <div className={`rg-diagram-loading ${className ?? ''}`}>Rendering diagram…</div>
  }

  return (
    <div
      className={`rg-diagram-svg ${className ?? ''}`}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  )
}
