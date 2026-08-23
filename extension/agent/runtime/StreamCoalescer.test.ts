import { describe, expect, it, vi } from 'vitest'
import { StreamCoalescer } from './StreamCoalescer'

describe('StreamCoalescer', () => {
  it('flushes immediately once the character threshold is reached', () => {
    const flush = vi.fn()
    const c = new StreamCoalescer(flush, { maxChars: 3 })
    c.push('a')
    c.push('b')
    expect(flush).not.toHaveBeenCalled()
    c.push('c') // buffer "abc" reaches 3 chars
    expect(flush).toHaveBeenCalledWith('abc')
    c.dispose()
  })

  it('flushes pending text on flushNow even below the threshold', () => {
    const flush = vi.fn()
    const c = new StreamCoalescer(flush, { maxChars: 100 })
    c.push('hello ')
    c.push('world')
    expect(flush).not.toHaveBeenCalled()
    c.flushNow()
    expect(flush).toHaveBeenCalledWith('hello world')
    // second flushNow with empty buffer is a no-op
    c.flushNow()
    expect(flush).toHaveBeenCalledTimes(1)
  })

  it('flushes on a timer after maxWaitMs', () => {
    vi.useFakeTimers()
    try {
      const flush = vi.fn()
      const c = new StreamCoalescer(flush, { maxWaitMs: 40, maxChars: 1000 })
      c.push('partial')
      expect(flush).not.toHaveBeenCalled()
      vi.advanceTimersByTime(40)
      expect(flush).toHaveBeenCalledWith('partial')
      c.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('dispose drops buffered text without flushing', () => {
    vi.useFakeTimers()
    try {
      const flush = vi.fn()
      const c = new StreamCoalescer(flush, { maxWaitMs: 40 })
      c.push('do not flush')
      c.dispose()
      vi.advanceTimersByTime(100)
      expect(flush).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})
