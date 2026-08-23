import { describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ChatPanel } from './ChatPanel'

function renderPanel(props: Partial<Parameters<typeof ChatPanel>[0]> = {}) {
  const handlers = {
    onClose: vi.fn(),
    onSend: vi.fn(),
    onCancel: vi.fn(),
    onClear: vi.fn(),
    onApplyPendingDraft: vi.fn(),
    onSelectModel: vi.fn(),
  }
  render(
    <ChatPanel
      isOpen
      messages={[]}
      activities={[]}
      taskStatus="idle"
      {...handlers}
      {...props}
    />,
  )
  return handlers
}

describe('ChatPanel model picker', () => {
  it('opens the menu, lists discovered models, and reports the selection', () => {
    const handlers = renderPanel({
      models: ['deepseek-chat', 'deepseek-v4-pro'],
      activeModel: 'deepseek-chat',
    })
    fireEvent.click(screen.getByRole('button', { name: /Model: deepseek-chat/ }))
    expect(screen.getByRole('listbox')).toBeTruthy()
    fireEvent.click(screen.getByRole('option', { name: /deepseek-v4-pro/ }))
    expect(handlers.onSelectModel).toHaveBeenCalledWith('deepseek-v4-pro')
    // The menu closes after picking.
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('keeps a selected model visible on the pill even when discovery has not listed it yet', () => {
    renderPanel({ models: [], activeModel: 'deepseek-v4-flash' })
    expect(screen.getByRole('button', { name: /Model: deepseek-v4-flash/ })).toBeTruthy()
  })

  it('renders no picker before provider state arrives', () => {
    renderPanel()
    expect(screen.queryByRole('button', { name: /^Model:/ })).toBeNull()
  })
})

describe('ChatPanel composer', () => {
  it('sends on Enter and clears the input', () => {
    const handlers = renderPanel()
    const box = screen.getByRole('textbox') as HTMLTextAreaElement
    fireEvent.change(box, { target: { value: 'hello' } })
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(handlers.onSend).toHaveBeenCalledWith('hello')
    expect(box.value).toBe('')
  })

  it('keeps the text on Shift+Enter (newline, no send)', () => {
    const handlers = renderPanel()
    const box = screen.getByRole('textbox') as HTMLTextAreaElement
    fireEvent.change(box, { target: { value: 'multi' } })
    fireEvent.keyDown(box, { key: 'Enter', shiftKey: true })
    expect(handlers.onSend).not.toHaveBeenCalled()
    expect(box.value).toBe('multi')
  })

  it('does not send whitespace-only input', () => {
    const handlers = renderPanel()
    const box = screen.getByRole('textbox')
    fireEvent.change(box, { target: { value: '   ' } })
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(handlers.onSend).not.toHaveBeenCalled()
  })
})
