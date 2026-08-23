// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { IncrementalFileCatalog } from './IncrementalFileCatalog'

const temporaryDirectories: string[] = []

async function temporaryDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'charter-index-'))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })))
})

describe('IncrementalFileCatalog restart reconciliation', () => {
  it('persists metadata only and reconciles source changes made while the host was stopped', async () => {
    const root = await temporaryDirectory()
    const storage = await temporaryDirectory()
    const indexPath = path.join(storage, 'index.json')
    const source = path.join(root, 'src.ts')
    await fs.writeFile(source, 'export const version = 1', 'utf8')
    await fs.mkdir(path.join(root, 'node_modules', 'package'), { recursive: true })
    await fs.writeFile(path.join(root, 'node_modules', 'package', 'index.js'), 'ignored', 'utf8')

    const first = new IncrementalFileCatalog([root], { indexPath })
    await first.initialize()
    const firstEntry = await first.getEntry(source)
    expect(firstEntry).toMatchObject({ path: 'src.ts', contentHash: undefined })
    expect(first.allEntries().some((entry) => entry.path.includes('node_modules'))).toBe(false)
    first.dispose()

    // No watcher event occurs while the extension is stopped. The next startup
    // must reconcile persisted metadata rather than trust the old catalog.
    await fs.writeFile(source, 'export const version = 22', 'utf8')
    const restored = new IncrementalFileCatalog([root], { indexPath })
    await restored.initialize()
    const restoredEntry = await restored.getEntry(source)

    expect(restoredEntry?.size).toBe(Buffer.byteLength('export const version = 22'))
    expect(restoredEntry?.contentHash).toBeUndefined()
    expect(await restored.getContentHash(source)).toMatch(/^[0-9a-f]{64}$/)
    restored.dispose()
  })
})
