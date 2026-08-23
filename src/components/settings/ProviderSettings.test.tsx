import { describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ProviderSettings } from './ProviderSettings'
import type { ProvidersState } from '../../../shared/providersProtocol'

const state: ProvidersState = {
  providers: [
    {
      id: 'deepseek',
      label: 'DeepSeek',
      baseUrl: 'https://api.deepseek.com/v1',
      keyRequired: true,
      defaultModel: 'deepseek-v4-pro',
    },
  ],
  activeProviderId: 'deepseek',
  hasKey: false,
  keyValidated: false,
  model: '',
  baseUrl: '',
  models: [],
}

function renderWith(overrides: Partial<ProvidersState> = {}) {
  const handlers = {
    onSetKey: vi.fn(),
    onValidate: vi.fn(),
    onClearKey: vi.fn(),
    onSetModel: vi.fn(),
  }
  render(<ProviderSettings state={{ ...state, ...overrides }} {...handlers} />)
  return handlers
}

describe('ProviderSettings', () => {
  it('shows DeepSeek as the only configured provider', () => {
    renderWith()
    expect(screen.getByText(/DeepSeek — settings/)).toBeTruthy()
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('offers Add API key for a keyed provider without a key', () => {
    const handlers = renderWith({ activeProviderId: 'deepseek' })
    expect(screen.getByText('No API key')).toBeTruthy()
    fireEvent.click(screen.getByText('Add API key'))
    expect(handlers.onSetKey).toHaveBeenCalledOnce()
  })

  it('renders the validated badge and a model dropdown from discovered models', () => {
    const handlers = renderWith({
      activeProviderId: 'deepseek',
      hasKey: true,
      keyValidated: true,
      model: 'deepseek-v4-pro',
      models: ['deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-v4-flash-vision-exp'],
    })
    expect(screen.getByText('Key configured ✓ validated')).toBeTruthy()
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'deepseek-v4-flash' } })
    expect(handlers.onSetModel).toHaveBeenCalledWith('deepseek-v4-flash')
  })

  it('shows a validation error when present', () => {
    renderWith({ activeProviderId: 'deepseek', error: 'Invalid API key — the provider rejected it.' })
    expect(screen.getByText(/Invalid API key/)).toBeTruthy()
  })
})
