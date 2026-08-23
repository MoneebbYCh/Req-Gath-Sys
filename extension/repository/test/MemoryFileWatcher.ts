/**
 * In-memory file watcher for testing IncrementalFileCatalog.
 * Simulates file system events without actual file watching.
 */

export interface FileChangeEvent {
  type: 'create' | 'change' | 'delete'
  absolutePath: string
  root: string
}

export interface FileWatcher {
  watch(roots: string[]): void
  onChange(callback: (event: FileChangeEvent) => void): void
  dispose(): void
}

export class MemoryFileWatcher implements FileWatcher {
  private callback?: (event: FileChangeEvent) => void

  watch() {}
  
  onChange(cb: (event: FileChangeEvent) => void) {
    this.callback = cb
  }
  
  dispose() {}
  
  /** Simulate a file system event for testing. */
  simulateChange(event: FileChangeEvent) {
    this.callback?.(event)
  }
}

/**
 * Creates a MemoryFileWatcher that automatically tracks changes to a Map-based filesystem.
 * Useful for integration tests.
 */
export function createTrackingWatcher(
  fs: Map<string, { content: string; isDir: boolean }>
): MemoryFileWatcher {
  const watcher = new MemoryFileWatcher()
  
  const originalSet = fs.set.bind(fs)
  const originalDelete = fs.delete.bind(fs)
  
  fs.set = function(key: string, value: { content: string; isDir: boolean }) {
    const existed = fs.has(key)
    originalSet(key, value)
    if (!existed) {
      watcher.simulateChange({ type: 'create', absolutePath: key, root: '' })
    } else {
      watcher.simulateChange({ type: 'change', absolutePath: key, root: '' })
    }
    return this
  }
  
  fs.delete = function(key: string) {
    const existed = fs.has(key)
    const result = originalDelete(key)
    if (existed) {
      watcher.simulateChange({ type: 'delete', absolutePath: key, root: '' })
    }
    return result
  }
  
  return watcher
}