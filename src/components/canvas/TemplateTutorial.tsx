import { useEffect, useState } from 'react'

interface TemplateTutorialProps {
  /** Context label, e.g. "Project Charter". */
  documentLabel: string
  onClose: () => void
}

interface TutorialStep {
  title: string
  body: string
}

const STEPS: TutorialStep[] = [
  {
    title: 'Two ways to begin',
    body: 'Every document can start from a saved template — or from a completely blank page. Pick whichever suits how you like to work.',
  },
  {
    title: 'Browse and preview',
    body: 'The Templates list on the left shows your options. Click any one to preview its sections right here, before you commit to anything.',
  },
  {
    title: 'Apply, then make it yours',
    body: 'Hit "Use this template" and its sections drop onto the canvas as editable placeholders. Fill them in, or add your own with the Insert tab and the "/" menu.',
  },
  {
    title: 'Switch whenever you like',
    body: 'Changed your mind? Reopen the Templates tab anytime to swap templates or start fresh — your document is always yours to reshape.',
  },
]

export function TemplateTutorial({ documentLabel, onClose }: TemplateTutorialProps) {
  const [step, setStep] = useState(0)
  const isFirst = step === 0
  const isLast = step === STEPS.length - 1
  const current = STEPS[step]

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      if (e.key === 'ArrowRight' && step < STEPS.length - 1) setStep((s) => s + 1)
      if (e.key === 'ArrowLeft' && step > 0) setStep((s) => s - 1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [step, onClose])

  return (
    <div
      className="tut-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={`How templates work in ${documentLabel}`}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="tmpl-window tut-window">
        <div className="tmpl-titlebar">
          <span className="tmpl-titlebar-lines" aria-hidden="true" />
          <span className="tmpl-titlebar-name">Getting Started</span>
          <span className="tmpl-titlebar-lines" aria-hidden="true" />
        </div>

        <div className="tut-body">
          <p className="tut-kicker">{documentLabel} · Templates</p>
          <div className="tut-step-num" aria-hidden="true">
            {step + 1}
            <span className="tut-step-of">/ {STEPS.length}</span>
          </div>
          <h2 className="tut-title">{current.title}</h2>
          <p className="tut-desc">{current.body}</p>
        </div>

        <div className="tut-foot">
          <div className="tut-dots" aria-hidden="true">
            {STEPS.map((_, i) => (
              <span key={i} className={`tut-dot${i === step ? ' is-active' : ''}`} />
            ))}
          </div>
          <div className="tut-actions">
            <button type="button" className="tmpl-btn" onClick={onClose}>
              {isLast ? 'Close' : 'Skip'}
            </button>
            {!isFirst ? (
              <button type="button" className="tmpl-btn" onClick={() => setStep((s) => s - 1)}>
                Back
              </button>
            ) : null}
            {isLast ? (
              <button type="button" className="tmpl-btn tmpl-btn--primary" onClick={onClose}>
                Got it
              </button>
            ) : (
              <button
                type="button"
                className="tmpl-btn tmpl-btn--primary"
                onClick={() => setStep((s) => s + 1)}
              >
                Next
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
