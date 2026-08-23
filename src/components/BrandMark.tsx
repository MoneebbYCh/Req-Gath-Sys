import { BRAND_NAME } from '../brand'

interface BrandMarkProps {
  /** Large hero on home, compact in title bars */
  size?: 'lg' | 'sm'
  className?: string
}

/**
 * Quirky retro wordmark: chunky Mac-era stamp + happy-scroll glyph.
 */
export function BrandMark({ size = 'lg', className = '' }: BrandMarkProps) {
  const compact = size === 'sm'
  return (
    <div
      className={`brand-mark brand-mark--${size} ${className}`.trim()}
      aria-label={BRAND_NAME}
      role="img"
    >
      <span className="brand-mark-glyph" aria-hidden>
        <span className="brand-mark-face">☺</span>
        <span className="brand-mark-scroll" />
      </span>
      <span className="brand-mark-word">
        <span className="brand-mark-charter">
          {'CHARTER'.split('').map((ch, i) => (
            <span key={`${ch}-${i}`} className={`brand-mark-ch brand-mark-ch--${i % 3}`}>
              {ch}
            </span>
          ))}
        </span>
        <span className="brand-mark-ai" aria-hidden={false}>
          Ai
        </span>
        {!compact ? <span className="brand-mark-tag">v1.0 · SYSTEM 7½</span> : null}
      </span>
    </div>
  )
}
