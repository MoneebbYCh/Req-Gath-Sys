/**
 * Test-only stub for the `vscode` module (unresolvable outside the extension
 * host). Backs workspace.fs with real node fs so extension logic (e.g. the
 * pipeline tools) can run against temp directories in tests. Vitest aliases
 * 'vscode' to this module; the esbuild extension build is untouched.
 */
import * as nodeFs from 'node:fs'

const uri = (p: string) => ({ fsPath: p, scheme: 'file' })

export const Uri = { file: uri }

export const workspace = {
  fs: {
    async stat(u: { fsPath: string }) {
      return new Promise((resolve, reject) =>
        nodeFs.stat(u.fsPath, (err, stats) => (err ? reject(err) : resolve(stats))),
      )
    },
    async readFile(u: { fsPath: string }) {
      return nodeFs.readFileSync(u.fsPath)
    },
    async writeFile(u: { fsPath: string }, data: Uint8Array) {
      nodeFs.writeFileSync(u.fsPath, Buffer.from(data))
    },
    async createDirectory(u: { fsPath: string }) {
      nodeFs.mkdirSync(u.fsPath, { recursive: true })
    },
  },
}