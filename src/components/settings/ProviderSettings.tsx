import type { ProvidersState } from '../../../shared/providersProtocol'

export interface ProviderSettingsProps {
  state: ProvidersState | null
  onSetKey: () => void
  onValidate: () => void
  onClearKey: () => void
  onSetModel: (model: string) => void
}

/**
 * DeepSeek setup: add and validate an API key (typed into a native VS Code
 * prompt — never this webview), then choose one of its exposed models.
 */
export function ProviderSettings({
  state,
  onSetKey,
  onValidate,
  onClearKey,
  onSetModel,
}: ProviderSettingsProps) {
  if (!state) {
    return (
      <p className="text-sm text-on-surface-variant" style={{ fontFamily: 'var(--font-label)' }}>
        Loading providers…
      </p>
    )
  }

  const active = state.providers.find((p) => p.id === 'deepseek')

  return (
    <div className="border-2 border-on-background bg-surface-container-low inset-field p-3">
        <div
          className="text-[10px] font-bold uppercase tracking-widest text-on-surface-variant mb-2"
          style={{ fontFamily: 'var(--font-label)' }}
        >
          {active?.label ?? 'DeepSeek'} — settings
        </div>

        <div className="flex items-center gap-2 mb-3 flex-wrap">
          <span
            className={`text-xs font-bold px-2 py-0.5 border-2 border-on-background ${
              state.hasKey && state.keyValidated
                ? 'bg-primary text-on-primary'
                : state.hasKey
                  ? 'bg-secondary-container text-on-background'
                  : 'bg-white text-on-surface-variant'
            }`}
            style={{ fontFamily: 'var(--font-label)' }}
          >
            {active?.keyRequired
              ? state.hasKey
                ? state.keyValidated
                  ? 'Key configured ✓ validated'
                  : 'Key configured (not validated)'
                : 'No API key'
              : 'No API key required'}
          </span>
          {state.error ? (
            <span className="text-[11px] font-bold text-error" style={{ fontFamily: 'var(--font-label)' }}>
              {state.error}
            </span>
          ) : null}
        </div>

        {active?.keyRequired ? (
          <div className="flex flex-wrap gap-2 mb-3">
            <button
              type="button"
              onClick={onSetKey}
              className="border-2 border-on-background bg-primary text-on-primary font-bold px-4 py-1.5 text-xs outset-button"
              style={{ fontFamily: 'var(--font-label)' }}
            >
              {state.hasKey ? 'Update API key' : 'Add API key'}
            </button>
            {state.hasKey ? (
              <>
                <button
                  type="button"
                  onClick={onValidate}
                  className="border-2 border-on-background bg-secondary-container font-bold px-4 py-1.5 text-xs outset-button"
                  style={{ fontFamily: 'var(--font-label)' }}
                >
                  Validate &amp; refresh models
                </button>
                <button
                  type="button"
                  onClick={onClearKey}
                  className="border-2 border-on-background bg-white font-bold px-4 py-1.5 text-xs outset-button"
                  style={{ fontFamily: 'var(--font-label)' }}
                >
                  Clear key
                </button>
              </>
            ) : null}
          </div>
        ) : null}

        <label className="flex flex-col gap-1">
          <span
            className="text-[10px] font-bold uppercase tracking-wider text-on-surface-variant"
            style={{ fontFamily: 'var(--font-label)' }}
          >
            Model
          </span>
          {state.models.length > 0 ? (
            <select
              className="border-2 border-on-background bg-white px-2 py-1.5 text-xs inset-field"
              value={state.model}
              onChange={(e) => onSetModel(e.target.value)}
            >
              {!state.models.includes(state.model) && state.model ? (
                <option value={state.model}>{state.model}</option>
              ) : null}
              {state.models.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          ) : (
            <>
              <input
                className="border-2 border-on-background bg-white px-2 py-1.5 text-xs inset-field"
                value={state.model}
                placeholder={active?.defaultModel ?? 'Model name'}
                onChange={(e) => onSetModel(e.target.value)}
              />
              {active?.keyRequired && !state.keyValidated ? (
                <span
                  className="text-[10px] text-on-surface-variant mt-1"
                  style={{ fontFamily: 'var(--font-label)' }}
                >
                  Validate the API key to list the models this provider exposes.
                </span>
              ) : null}
            </>
          )}
        </label>
    </div>
  )
}
