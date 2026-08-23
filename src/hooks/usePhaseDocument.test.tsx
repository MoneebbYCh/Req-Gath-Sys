import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { usePhaseDocument } from './usePhaseDocument'
import { createDocType } from '../data/documentTypes'
import type { CanvasDocument } from '../types/document'

const { postMessage } = vi.hoisted(() => ({ postMessage: vi.fn() }))

vi.mock('../utils/vscodeApi', () => ({
  getVscodeApi: () => ({ postMessage, getState: () => null, setState: () => {} }),
}))

function saveCanvasCalls() {
  return postMessage.mock.calls
    .map((c) => c[0])
    .filter((m) => m?.type === 'saveCanvas')
}

function dispatchLoadCanvas(phase: string, data: unknown, revision?: number) {
  dispatchHostMessage({ type: 'loadCanvas', phase, data, revision })
}

function dispatchHostMessage(data: unknown) {
  act(() => {
    window.dispatchEvent(
      new MessageEvent('message', {
        data,
      }),
    )
  })
}

const diskDoc = (content: string): CanvasDocument => ({
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

  it('does not duplicate a pending save when the debounce expires', () => {
    vi.useFakeTimers()
    try {
      const created = createDocType('Pending Save Doc')
      const { result } = renderHook(() => usePhaseDocument(created.id))
      postMessage.mockClear()

      act(() => {
        result.current.setBlocks([{ type: 'paragraph', content: 'save once' }])
      })
      act(() => {
        result.current.saveNow()
        vi.advanceTimersByTime(500)
      })

      expect(saveCanvasCalls()).toHaveLength(1)
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

  it('saves against the revision supplied by the host load', () => {
    vi.useFakeTimers()
    try {
      const created = createDocType('Revision Doc')
      const { result } = renderHook(() => usePhaseDocument(created.id))

      dispatchLoadCanvas(created.id, diskDoc('revision seven'), 7)
      postMessage.mockClear()

      act(() => {
        result.current.setBlocks([{ type: 'paragraph', content: 'local edit' }])
      })
      act(() => {
        vi.advanceTimersByTime(500)
      })

      expect(saveCanvasCalls()).toEqual([
        expect.objectContaining({ baseRevision: 7, seq: 1 }),
      ])
    } finally {
      vi.useRealTimers()
    }
  })

  it('marks an edit saved only after its matching host acknowledgement', () => {
    vi.useFakeTimers()
    try {
      const created = createDocType('Acknowledgement Doc')
      const { result } = renderHook(() => usePhaseDocument(created.id))
      postMessage.mockClear()

      act(() => {
        result.current.setBlocks([{ type: 'paragraph', content: 'awaiting ack' }])
      })
      act(() => {
        vi.advanceTimersByTime(500)
      })

      expect(result.current.isDirty).toBe(true)
      expect(result.current.lastSaved).toBeNull()

      dispatchHostMessage({
        type: 'saveCanvasAck',
        phase: created.id,
        revision: 1,
        seq: 99,
      })
      expect(result.current.isDirty).toBe(true)
      expect(result.current.lastSaved).toBeNull()

      dispatchHostMessage({
        type: 'saveCanvasAck',
        phase: created.id,
        revision: 1,
        seq: 1,
      })
      expect(result.current.isDirty).toBe(false)
      expect(result.current.lastSaved).toBeInstanceOf(Date)
    } finally {
      vi.useRealTimers()
    }
  })

  it('retains dirty state after a conflict and retries from the host revision', () => {
    vi.useFakeTimers()
    try {
      const created = createDocType('Conflict Doc')
      const { result } = renderHook(() => usePhaseDocument(created.id))
      dispatchLoadCanvas(created.id, diskDoc('revision four'), 4)
      postMessage.mockClear()

      act(() => {
        result.current.setBlocks([{ type: 'paragraph', content: 'conflicting edit' }])
      })
      act(() => {
        vi.advanceTimersByTime(500)
      })
      expect(saveCanvasCalls()[0]).toEqual(
        expect.objectContaining({ baseRevision: 4, seq: 1 }),
      )

      dispatchHostMessage({
        type: 'saveCanvasConflict',
        phase: created.id,
        currentRevision: 6,
        seq: 1,
      })
      expect(result.current.isDirty).toBe(true)

      act(() => {
        result.current.saveNow()
      })
      expect(saveCanvasCalls()[1]).toEqual(
        expect.objectContaining({ baseRevision: 6, seq: 2 }),
      )
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not let an older acknowledgement clear a newer edit', () => {
    vi.useFakeTimers()
    try {
      const created = createDocType('Stale Ack Doc')
      const { result } = renderHook(() => usePhaseDocument(created.id))
      postMessage.mockClear()

      act(() => {
        result.current.setBlocks([{ type: 'paragraph', content: 'first edit' }])
      })
      act(() => {
        vi.advanceTimersByTime(500)
      })
      act(() => {
        result.current.setBlocks([{ type: 'paragraph', content: 'newer edit' }])
      })

      dispatchHostMessage({
        type: 'saveCanvasAck',
        phase: created.id,
        revision: 1,
        seq: 1,
      })
      expect(result.current.isDirty).toBe(true)
      expect(result.current.lastSaved).toBeNull()
      expect(result.current.doc.blocks[0].content).toBe('newer edit')

      act(() => {
        vi.advanceTimersByTime(500)
      })
      expect(saveCanvasCalls()[1]).toEqual(
        expect.objectContaining({ baseRevision: 1, seq: 2 }),
      )

      dispatchHostMessage({
        type: 'saveCanvasAck',
        phase: created.id,
        revision: 2,
        seq: 2,
      })
      expect(result.current.isDirty).toBe(false)
      expect(result.current.lastSaved).toBeInstanceOf(Date)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps a persisted external replacement dirty until its versioned save is acknowledged', () => {
    const created = createDocType('Template Revision Doc')
    const { result } = renderHook(() => usePhaseDocument(created.id))
    dispatchLoadCanvas(created.id, diskDoc('loaded'), 8)
    postMessage.mockClear()

    act(() => {
      result.current.applyExternalDocument(diskDoc('template'), {
        persistToDisk: true,
      })
    })

    expect(saveCanvasCalls()).toEqual([
      expect.objectContaining({ baseRevision: 8, seq: 1 }),
    ])
    expect(result.current.isDirty).toBe(true)

    dispatchHostMessage({
      type: 'saveCanvasAck',
      phase: created.id,
      revision: 9,
      seq: 1,
    })
    expect(result.current.isDirty).toBe(false)
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

  it('keeps local edits when an external draft arrives and saves them on top of its revision (N7)', () => {
    vi.useFakeTimers()
    try {
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

    // User edits while a new revision arrives.
    act(() => {
      result.current.setBlocks([{ type: 'paragraph', content: 'typed during run' }])
    })

    dispatchLoadCanvas(created.id, diskDoc('draft result'), 2)

    // User edits stay local; overwriting the external revision requires an
    // explicit Save Draft action.
    act(() => vi.advanceTimersByTime(500))
    expect(saveCanvasCalls()).toHaveLength(0)
    expect(result.current.doc.blocks[0].content).toBe('typed during run')
    expect(result.current.isDirty).toBe(true)
    expect(onReplaced).toHaveBeenCalledWith(expect.stringContaining('edits were kept'))

    act(() => result.current.saveNow())
    expect(saveCanvasCalls()[0]).toEqual(
      expect.objectContaining({ baseRevision: 2, seq: 1 }),
    )
    } finally {
      vi.useRealTimers()
    }
  })

  it('retains local content and requires explicit saves across an external conflict', () => {
    vi.useFakeTimers()
    try {
    const created = createDocType('Replacement Conflict Doc')
    const { result } = renderHook(() => usePhaseDocument(created.id))
    dispatchLoadCanvas(created.id, diskDoc('loaded'), 1)
    postMessage.mockClear()

    act(() => {
      result.current.setBlocks([{ type: 'paragraph', content: 'unsaved local edit' }])
    })
    dispatchLoadCanvas(created.id, diskDoc('external replacement'), 2)

    expect(saveCanvasCalls()).toHaveLength(0)
    act(() => result.current.saveNow())
    expect(saveCanvasCalls()[0]).toEqual(
      expect.objectContaining({ baseRevision: 2, seq: 1 }),
    )
    expect(result.current.doc.blocks[0].content).toBe('unsaved local edit')
    expect(result.current.isDirty).toBe(true)

    dispatchHostMessage({
      type: 'saveCanvasConflict',
      phase: created.id,
      currentRevision: 3,
      seq: 1,
    })
    expect(result.current.doc.blocks[0].content).toBe('unsaved local edit')
    expect(result.current.isDirty).toBe(true)

    act(() => result.current.saveNow())
    expect(saveCanvasCalls()[1]).toEqual(
      expect.objectContaining({ baseRevision: 3, seq: 2 }),
    )
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not let a same-tick host load clobber a newly typed edit', () => {
    const created = createDocType('Same Tick Race Doc')
    const { result } = renderHook(() => usePhaseDocument(created.id))
    dispatchLoadCanvas(created.id, diskDoc('loaded'), 1)

    act(() => {
      result.current.setBlocks([{ type: 'paragraph', content: 'same tick edit' }])
      window.dispatchEvent(new MessageEvent('message', {
        data: { type: 'loadCanvas', phase: created.id, data: diskDoc('agent update'), revision: 2 },
      }))
    })

    expect(result.current.doc.blocks[0].content).toBe('same tick edit')
    expect(result.current.isDirty).toBe(true)
  })
})
