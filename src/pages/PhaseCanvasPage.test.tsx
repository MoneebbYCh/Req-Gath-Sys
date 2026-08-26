import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, waitFor } from '@testing-library/react'
import { PhaseCanvasPage } from './PhaseCanvasPage'
import { createDocType } from '../data/documentTypes'

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
  CanvasToolsSidebar: () => <aside data-testid="mock-tools" />,
}))
vi.mock('../components/canvas/CanvasNavRail', () => ({
  CanvasNavRail: () => null,
}))
vi.mock('../components/layout/PipelineChrome', () => ({
  PipelineHeader: () => <div data-testid="mock-header" />,
}))

function dispatchHostMessage(data: unknown) {
  window.dispatchEvent(new MessageEvent('message', { data }))
}

function saveCanvasCalls() {
  return postMessage.mock.calls
    .map((c) => c[0])
    .filter((m) => m?.type === 'saveCanvas')
}

describe('PhaseCanvasPage marketplace seed', () => {
  beforeEach(() => {
    localStorage.clear()
    postMessage.mockClear()
  })

  it('applies a marketplace template once when seedFromMarketplaceId is set', async () => {
    const created = createDocType('Seeded Doc')
    const navigate = vi.fn()

    render(
      <PhaseCanvasPage
        phaseId={created.id}
        onNavigate={navigate}
        goHome={() => {}}
        seedFromMarketplaceId="mp-readme"
      />,
    )

    // Host responds to loadCanvas so the page becomes ready.
    dispatchHostMessage({ type: 'loadCanvas', phase: created.id, data: null, revision: 1 })

    await waitFor(() => expect(saveCanvasCalls().length).toBeGreaterThanOrEqual(1))
    const last = saveCanvasCalls().at(-1)
    expect(last.data.anchors.templateId).toBe('mp-readme')
    expect(last.data.blocks.some((b: { type?: string }) => b.type === 'heading')).toBe(true)
    expect(navigate).toHaveBeenCalledWith({ page: created.id })
  })
})
