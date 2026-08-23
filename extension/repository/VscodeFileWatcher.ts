import * as vscode from 'vscode'
import type { FileWatcher, FileChangeEvent } from './IncrementalFileCatalog'

/**
 * VS Code file system watcher wrapper for IncrementalFileCatalog.
 * Uses vscode.workspace.createFileSystemWatcher for efficient native watching.
 */
export class VscodeFileWatcher implements FileWatcher {
  private watchers: vscode.FileSystemWatcher[] = []
  private callback?: (event: FileChangeEvent) => void

  watch(roots: string[]): void {
    this.dispose()
    for (const root of roots) {
      const pattern = new vscode.RelativePattern(vscode.Uri.file(root), '**/*')
      const watcher = vscode.workspace.createFileSystemWatcher(pattern, false, false, false)
      
      watcher.onDidCreate((uri) => this.emit('create', uri))
      watcher.onDidChange((uri) => this.emit('change', uri))
      watcher.onDidDelete((uri) => this.emit('delete', uri))
      
      this.watchers.push(watcher)
    }
  }

  onChange(callback: (event: FileChangeEvent) => void): void {
    this.callback = callback
  }

  dispose(): void {
    for (const w of this.watchers) w.dispose()
    this.watchers = []
  }

  private emit(type: FileChangeEvent['type'], uri: vscode.Uri): void {
    if (!this.callback) return
    const absolutePath = uri.fsPath
    // Find which root this belongs to
    // Note: in practice, the watcher is created per-root, so we know the root
    // For simplicity, we find the root that contains this path
    this.callback({ type, absolutePath, root: '' })
  }
}

/**
 * Creates a VscodeFileWatcher bound to specific roots so we know the root per event.
 * This is the recommended way to use it with IncrementalFileCatalog.
 */
export function createVscodeFileWatcher(roots: string[]): FileWatcher {
  const watchers: vscode.FileSystemWatcher[] = []
  let callback: ((event: FileChangeEvent) => void) | undefined

  for (const root of roots) {
    const pattern = new vscode.RelativePattern(vscode.Uri.file(root), '**/*')
    const watcher = vscode.workspace.createFileSystemWatcher(pattern, false, false, false)

    watcher.onDidCreate((uri) => callback?.({ type: 'create', absolutePath: uri.fsPath, root }))
    watcher.onDidChange((uri) => callback?.({ type: 'change', absolutePath: uri.fsPath, root }))
    watcher.onDidDelete((uri) => callback?.({ type: 'delete', absolutePath: uri.fsPath, root }))

    watchers.push(watcher)
  }

  return {
    watch() {
      // Already watching in constructor
    },
    onChange(cb) {
      callback = cb
    },
    dispose() {
      for (const w of watchers) w.dispose()
    },
  }
}