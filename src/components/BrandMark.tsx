import { BRAND_NAME } from '../brand'
import mascotUrl from '../assets/mascot.png'

interface BrandMarkProps {
  /** Large hero on home, compact in title bars */
  size?: 'lg' | 'sm'
  className?: string
  /** Hide the wordmark — mascot only (loading screens). */
  markOnly?: boolean
}

/**
 * Brand lockup: mascot + Charter Ai wordmark.
 */
export function BrandMark({ size = 'lg', className = '', markOnly = false }: BrandMarkProps) {
  const compact = size === 'sm'
  return (
    <div
      className={`brand-mark brand-mark--${size} ${markOnly ? 'brand-mark--solo' : ''} ${className}`.trim()}
      aria-label={BRAND_NAME}
      role="img"
    >
      <img
        className="brand-mark-mascot"
        src={mascotUrl}
        alt=""
        width={compact ? 48 : 120}
        height={compact ? 26 : 65}
        decoding="async"
      />
      {!markOnly ? (
        <span className="brand-mark-word">
          <span className="brand-mark-charter">
            {'CHARTER'.split('').map((ch, i) => (
              <span key={`${ch}-${i}`} className={`brand-mark-ch brand-mark-ch--${i % 3}`}>
                {ch}
              </span>
            ))}
          </span>
          <span className="brand-mark-ai">Ai</span>
          {!compact ? <span className="brand-mark-tag">v1.0 · SYSTEM 7½</span> : null}
        </span>
      ) : null}
    </div>
  )
}

/** Peeks from the top-right of a dialog panel (parent needs `.dialog-panel`). */
export function DialogMascot({ className = '' }: { className?: string }) {
  return (
    <img
      className={`dialog-mascot ${className}`.trim()}
      src={mascotUrl}
      alt=""
      width={160}
      height={87}
      decoding="async"
      aria-hidden
    />
  )
}

interface LoadingSplashProps {
  message: string
  className?: string
}

/** Full-area loading state with the mascot. */
export function LoadingSplash({ message, className = '' }: LoadingSplashProps) {
  return (
    <div className={`loading-splash ${className}`.trim()} role="status" aria-live="polite">
      <img
        className="loading-splash-mascot"
        src={mascotUrl}
        alt=""
        width={160}
        height={87}
        decoding="async"
      />
      <p className="loading-splash-msg">{message}</p>
    </div>
  )
}
