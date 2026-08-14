import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { usePhaseDocument } from './usePhaseDocument'
import { createDocType } from '../data/documentTypes'

const { postMessage } = vi.hoisted(() => ({ postMessage: vi.fn() }))

vi.mock('../utils/vscodeApi', () => ({
  getVscodeApi: () => ({ postMessage, getState: () => null, setState: () => {} }),
}))

function saveCanvasCalls() {
  return postMessage.mock.calls
    .map((c) => c[0])
    .filter((m) => m?.type === 'saveCanvas')
}

function dispatchLoadCanvas(phase: string, data: unknown) {
  act(() => {
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: 'loadCanvas', phase, data },
      }),
    )
  })
}

const diskDoc = (content: string) => ({
  version: 1,
  kind: 'blocknote',
  blocks: [{ type: 'paragraph', content }],
  anchors: {},
})

describe('usePhaseDocument', () => {
  beforeEach(() => {
    localStorage.clear()
    postMessage.mockClear()
  })

  it('debounces saves after 500 ms', () => {
    vi.useFakeTimers()
    try {
      const created = createDocType('Debounce Doc')
      const { result } = renderHook(() => usePhaseDocument(created.id))
      postMessage.mockClear() // drop the mount-time loadCanvas

      act(() => {
        result.current.setBlocks([{ type: 'paragraph', content: 'slow typing' }])
      })
      expect(saveCanvasCalls()).toHaveLength(0)

      act(() => {
        vi.advanceTimersByTime(500)
      })
      const saves = saveCanvasCalls()
      expect(saves).toHaveLength(1)
      expect(saves[0].phase).toBe(created.id)
      expect(saves[0].data.blocks[0].content).toBe('slow typing')
    } finally {
      vi.useRealTimers()
    }
  })

  it('flushes pending edits on unmount before the debounce fires (navigate-away within 500 ms)', () => {
    const created = createDocType('Flush Doc')
    const { result, unmount } = renderHook(() => usePhaseDocument(created.id))
    postMessage.mockClear() // drop the mount-time loadCanvas

    act(() => {
      result.current.setBlocks([{ type: 'paragraph', content: 'typed quickly' }])
    })
    expect(saveCanvasCalls()).toHaveLength(0)

    unmount() // no 500 ms wait — simulate clicking another tab immediately

    const saves = saveCanvasCalls()
    expect(saves).toHaveLength(1)
    expect(saves[0].phase).toBe(created.id)
    expect(saves[0].data.blocks[0].content).toBe('typed quickly')
    expect(localStorage.getItem(created.storageKey)).toContain('typed quickly')
  })

  it('does not re-request the disk load when the user types (regression: remount loop)', () => {
    const created = createDocType('No Loop Doc')
    const { result } = renderHook(() => usePhaseDocument(created.id))
    postMessage.mockClear()

    act(() => {
      result.current.setBlocks([{ type: 'paragraph', content: 'keystroke' }])
    })

    const loads = postMessage.mock.calls
      .map((c) => c[0])
      .filter((m) => m?.type === 'loadCanvas')
    expect(loads).toHaveLength(0)
  })

  it('does not post spurious saves on unmount when clean', () => {
    const created = createDocType('Clean Doc')
    const { unmount } = renderHook(() => usePhaseDocument(created.id))
    postMessage.mockClear()

    unmount()

    expect(saveCanvasCalls()).toHaveLength(0)
  })

  it('applies the disk load when the user has not edited yet (N2)', () => {
    const created = createDocType('Load Doc')
    const { result } = renderHook(() => usePhaseDocument(created.id))
    postMessage.mockClear()

    dispatchLoadCanvas(created.id, diskDoc('disk version'))

    expect(result.current.ready).toBe(true)
    expect(result.current.doc.blocks[0].content).toBe('disk version')
  })

  it('ignores the disk load response when the user typed before it returned (N2)', () => {
    const created = createDocType('Race Doc')
    const { result } = renderHook(() => usePhaseDocument(created.id))
    postMessage.mockClear()

    act(() => {
      result.current.setBlocks([{ type: 'paragraph', content: 'typed during load' }])
    })

    dispatchLoadCanvas(created.id, diskDoc('disk version'))

    expect(result.current.ready).toBe(true)
    expect(result.current.doc.blocks[0].content).toBe('typed during load')
    expect(saveCanvasCalls()).toHaveLength(0)
  })

  it('flushes local edits before a draft replacement and flags the notice (N7)', () => {
    const created = createDocType('Draft Doc')
    const onReplaced = vi.fn()
    const { result } = renderHook(() =>
      usePhaseDocument(created.id, { onReplaced }),
    )
    postMessage.mockClear()

    // Mount-time load completes first.
    dispatchLoadCanvas(created.id, diskDoc('loaded'))
    expect(result.current.doc.blocks[0].content).toBe('loaded')
    postMessage.mockClear()

    // User edits while the agent runs.
    act(() => {
      result.current.setBlocks([{ type: 'paragraph', content: 'typed during run' }])
    })

    dispatchLoadCanvas(created.id, diskDoc('draft result'))

    // User edits were flushed to storage first — nothing lost.
    const saves = saveCanvasCalls()
    expect(saves).toHaveLength(1)
    expect(saves[0].data.blocks[0].content).toBe('typed during run')
    // The canvas now shows the draft, and the page is told about the replacement.
    expect(result.current.doc.blocks[0].content).toBe('draft result')
    expect(onReplaced).toHaveBeenCalledWith(expect.stringContaining('replaced'))
  })
})