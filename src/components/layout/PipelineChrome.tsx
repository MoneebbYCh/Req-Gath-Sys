import type { View } from '../../hooks/useViewState'
import { listPipelineDocumentTypes } from '../../data/documentTypes'
import { BrandMark } from '../BrandMark'

interface PipelineHeaderProps {
  onHome: () => void
  onExport: () => void
  onSave: () => void
  saveLabel?: string
  /** Current phase — highlights the active tab. */
  currentPhaseId?: string
  /** Jump between phases from the header strip. */
  onNavigate?: (view: View) => void
}

export function PipelineHeader({
  onHome,
  onExport,
  onSave,
  saveLabel = 'Save Draft',
  currentPhaseId,
  onNavigate,
}: PipelineHeaderProps) {
  return (
    <header className="sticky top-0 w-full z-50 flex flex-col border-b-2 border-on-background bg-secondary-container">
      <div className="flex justify-between items-center px-6 py-2">
        <button
          type="button"
          onClick={onHome}
          className="hover:opacity-80 transition-opacity"
          aria-label="Home"
        >
          <BrandMark size="sm" />
        </button>
        <div className="flex gap-4">
          <button
            type="button"
            onClick={onExport}
            className="outset-button border-2 border-on-background bg-white text-primary font-bold px-4 py-1 text-xs"
            style={{ fontFamily: 'var(--font-label)' }}
          >
            Export
          </button>
          <button
            type="button"
            onClick={onSave}
            className="outset-button border-2 border-on-background bg-secondary-container text-on-background px-4 py-1 text-xs font-bold"
            style={{ fontFamily: 'var(--font-label)' }}
          >
            {saveLabel}
          </button>
        </div>
      </div>
      <nav className="flex w-full overflow-x-auto">
        {listPipelineDocumentTypes().map((phase) => {
          const active = phase.id === currentPhaseId
          const canNavigate = Boolean(onNavigate)
          const className = [
            'flex-1 min-w-[140px] px-4 py-2 flex items-center justify-between border-r border-on-background transition-colors text-left',
            active
              ? 'bg-white text-on-background'
              : 'bg-secondary-container text-on-background hover:bg-surface-container-low',
            canNavigate ? 'cursor-pointer' : 'cursor-default',
          ].join(' ')

          const inner = (
            <>
              <span className="text-xs font-bold truncate" style={{ fontFamily: 'var(--font-label)' }}>
                {phase.title}
              </span>
              <span className="material-symbols-outlined text-[16px]">
                {active ? 'radio_button_checked' : 'radio_button_unchecked'}
              </span>
            </>
          )

          if (canNavigate) {
            return (
              <button
                key={phase.id}
                type="button"
                className={className}
                onClick={() => onNavigate?.({ page: phase.id })}
              >
                {inner}
              </button>
            )
          }

          return (
            <span key={phase.id} className={className}>
              {inner}
            </span>
          )
        })}
      </nav>
    </header>
  )
}
