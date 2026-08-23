/**
 * Batches provider text deltas into coalesced chunks (plan §6 / §23.4) so the
 * runtime posts roughly 10–20 UI updates per second instead of one per token.
 */
export interface StreamCoalescerOptions {
  /** Max time to hold a partial chunk before flushing. */
  maxWaitMs?: number
  /** Flush immediately once the buffer reaches this many characters. */
  maxChars?: number
}

export class StreamCoalescer {
  private buffer = ''
  private timer: ReturnType<typeof setTimeout> | null = null
  private readonly maxWaitMs: number
  private readonly maxChars: number
  private readonly onFlush: (chunk: string) => void

  constructor(onFlush: (chunk: string) => void, options: StreamCoalescerOptions = {}) {
    this.onFlush = onFlush
    this.maxWaitMs = options.maxWaitMs ?? 40
    this.maxChars = options.maxChars ?? 400
  }

  push(text: string): void {
    this.buffer += text
    if (this.buffer.length >= this.maxChars) {
      this.flushNow()
      return
    }
    if (this.timer === null) {
      this.timer = setTimeout(() => this.flushNow(), this.maxWaitMs)
    }
  }

  /** Flush any buffered text immediately (call at end of stream). */
  flushNow(): void {
    this.clearTimer()
    if (this.buffer.length === 0) return
    const chunk = this.buffer
    this.buffer = ''
    this.onFlush(chunk)
  }

  dispose(): void {
    this.clearTimer()
    this.buffer = ''
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }
}
