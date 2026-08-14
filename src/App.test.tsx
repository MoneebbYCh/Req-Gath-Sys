import { describe, expect, it, vi } from 'vitest'
import { render, screen, act, waitFor } from '@testing-library/react'
import App from './App'

const { postMessage } = vi.hoisted(() => ({ postMessage: vi.fn() }))

vi.mock('./utils/vscodeApi', () => ({
  getVscodeApi: () => ({ postMessage, getState: () => null, setState: () => {} }),
}))

function sendWorkspaceInfo(payload: unknown) {
  act(() => {
    window.dispatchEvent(new MessageEvent('message', { data: payload }))
  })
}

describe('App workspace state', () => {
  it('shows the no-workspace notice when no folder is open', async () => {
    render(<App />)
    sendWorkspaceInfo({ type: 'workspaceInfo', path: '', name: '', available: false })
    expect(await screen.findByText(/Open a folder to use Charter Ai/i)).toBeTruthy()
  })

  it('leaves the connecting screen and renders the pipeline when a folder is open', async () => {
    render(<App />)
    sendWorkspaceInfo({ type: 'workspaceInfo', path: '/tmp/demo', name: 'demo', available: true })
    await waitFor(() => {
      expect(screen.queryByText('Connecting to workspace…')).toBeNull()
      expect(screen.queryByText(/Open a folder to use Charter Ai/i)).toBeNull()
    })
  })
})