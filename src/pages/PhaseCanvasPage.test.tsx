import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { PhaseCanvasPage } from './PhaseCanvasPage'
import { createDocType } from '../data/documentTypes'
import type { ToolsTab } from '../components/canvas/CanvasToolsSidebar'
import type { CharterTemplate } from '../data/docTemplates'

const { postMessage } = vi.hoisted(() => ({ postMessage: vi.fn() }))

vi.mock('../utils/vscodeApi', () => ({
  getVscodeApi: () => ({ postMessage, getState: () => null, setState: () => {} }),
}))

vi.mock('../components/canvas/DocumentCanvas', () => ({
  DocumentCanvas: () => <div data-testid="mock-canvas" />,
}))
vi.mock('../components/canvas/CanvasErrorBoundary', () => ({
  CanvasErrorBoundary: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))
vi.mock('../components/canvas/CanvasToolsSidebar', () => ({
  CanvasToolsSidebar: ({
    onTabChange,
  }: {
    onTabChange: (tab: ToolsTab) => void
  }) => <button onClick={() => onTabChange('template')}>Templates</button>,
}))
vi.mock('../components/canvas/TemplateTutorial', () => ({
  TemplateTutorial: () => null,
}))
vi.mock('../components/layout/PipelineChrome', () => ({
  PipelineHeader: () => <div data-testid="mock-header" />,
}))
vi.mock('../components/canvas/TemplateGallery', () => ({
  TemplateGallery: ({
    onApply,
    template,
  }: {
    onApply: (template: CharterTemplate) => void
    template: CharterTemplate
  }) => <button onClick={() => onApply(template)}>Apply template</button>,
}))

function saveCanvasCalls() {
  return postMessage.mock.calls
    .map((c) => c[0])
    .filter((m) => m?.type === 'saveCanvas')
}

describe('PhaseCanvasPage template apply (V15)', () => {
  beforeEach(() => {
    localStorage.clear()
    postMessage.mockClear()
  })

  it('applies a template immediately on an empty document', () => {
    const created = createDocType('Template Doc')
    render(
      <PhaseCanvasPage phaseId={created.id} onNavigate={() => {}} goHome={() => {}} />,
    )
    postMessage.mockClear()

    fireEvent.click(screen.getByText('Templates'))
    fireEvent.click(screen.getByText('Apply template'))

    expect(screen.queryByRole('dialog')).toBeNull()
    expect(saveCanvasCalls()).toHaveLength(1)
  })

  it('confirms before replacing a document that has content (V15)', async () => {
    const created = createDocType('Confirm Doc')
    localStorage.setItem(
      created.storageKey,
      JSON.stringify({
        version: 1,
        kind: 'blocknote',
        blocks: [{ type: 'paragraph', content: 'existing work' }],
        anchors: {},
      }),
    )
    render(
      <PhaseCanvasPage phaseId={created.id} onNavigate={() => {}} goHome={() => {}} />,
    )
    postMessage.mockClear()

    // Apply is intercepted — nothing is written yet.
    fireEvent.click(screen.getByText('Templates'))
    fireEvent.click(screen.getByText('Apply template'))
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(saveCanvasCalls()).toHaveLength(0)

    // Cancel keeps the document untouched.
    fireEvent.click(screen.getByText('Cancel'))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(saveCanvasCalls()).toHaveLength(0)

    // Confirm replaces it.
    fireEvent.click(screen.getByText('Apply template'))
    fireEvent.click(screen.getByText('Apply'))
    await waitFor(() => expect(saveCanvasCalls()).toHaveLength(1))
  })
})
