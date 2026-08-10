import * as path from 'path'
import * as fs from 'fs'
import * as crypto from 'crypto'
import { LEGACY_STATE_DIR, STATE_DIR } from './brand'
import { chunkFile } from './ai/chunker'
import { embedTexts, type EmbeddingConfig } from './ai/embeddings'
import { VectorStore } from './ai/vectorStore'

export interface IndexProgress {
  phase: string
  percent: number
}

type ProgressCallback = (progress: IndexProgress) => void

const SUPPORTED_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.go', '.rs', '.java', '.rb', '.php',
  '.swift', '.kt', '.kts', '.scala',
  '.sh', '.bash', '.zsh', '.ps1',
  '.md', '.mdx', '.json', '.yaml', '.yml', '.toml',
  '.css', '.scss', '.html', '.htm',
  '.sql',
])

/**
 * Workspace file walker + incremental embedding sync.
 * Chat uses this for semantic_search; no structural AST / Madar index.
 */
export class CodeIndexer {
  constructor(private workspaceRoot: string) {}

  /**
   * Incrementally sync the semantic embedding index for this workspace.
   * Only re-chunks/re-embeds files whose content hash changed since last run,
   * removes vectors for deleted files, and persists the vector store.
   */
  async syncEmbeddings(
    embedCfg: EmbeddingConfig,
    onProgress?: ProgressCallback,
  ): Promise<{ changed: number; total: number; chunks: number }> {
    const store = new VectorStore(this.workspaceRoot)
    store.load()
    // A model change invalidates every existing vector.
    if (store.getModel() !== embedCfg.model) {
      store.resetModel(embedCfg.model, 0)
    }

    onProgress?.({ phase: 'embedding-scan', percent: 0 })
    const absFiles = this.collectSourceFiles()
    const relHashes = this.computeFileHashes(absFiles)
    const rels = Object.keys(relHashes)

    for (const known of store.knownFiles()) {
      if (!(known in relHashes)) store.removeFile(known)
    }

    const changed = rels.filter((r) => store.fileHash(r) !== relHashes[r])
    let done = 0
    try {
      for (const rel of changed) {
        const abs = path.join(this.workspaceRoot, rel)
        let content = ''
        try {
          content = fs.readFileSync(abs, 'utf-8')
        } catch {
          store.removeFile(rel)
          done++
          continue
        }

        const chunks = chunkFile(rel, content)
        if (chunks.length === 0) {
          // Record the hash so we don't re-attempt an unchunkable file every run.
          store.upsertFile(rel, relHashes[rel], [])
        } else {
          const vectors = await embedTexts(chunks.map((c) => c.text), embedCfg)
          const entries = chunks
            .map((c, i) => ({
              meta: {
                id: c.id,
                file: c.file,
                startLine: c.startLine,
                endLine: c.endLine,
                symbol: c.symbol,
                kind: c.kind,
              },
              vector: vectors[i] ?? [],
            }))
            .filter((e) => e.vector.length > 0)
          store.upsertFile(rel, relHashes[rel], entries)
        }

        done++
        onProgress?.({
          phase: 'embedding',
          percent: changed.length ? Math.round((done / changed.length) * 100) : 100,
        })
      }
    } catch (err) {
      // Persist partial progress so a later run resumes instead of restarting.
      store.save()
      throw err
    }

    store.save()
    onProgress?.({ phase: 'embedding-complete', percent: 100 })
    return { changed: changed.length, total: rels.length, chunks: store.chunkCount() }
  }

  private collectSourceFiles(): string[] {
    const ignoreDirs = new Set([
      'node_modules',
      'dist',
      'out',
      '.git',
      STATE_DIR,
      LEGACY_STATE_DIR,
      '.vscode',
    ])
    const results: string[] = []

    const walk = (dir: string) => {
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true })
        for (const entry of entries) {
          if (ignoreDirs.has(entry.name)) continue
          const fullPath = path.join(dir, entry.name)
          if (entry.isDirectory()) {
            walk(fullPath)
          } else if (entry.isFile() && SUPPORTED_EXTENSIONS.has(path.extname(entry.name))) {
            results.push(fullPath)
          }
        }
      } catch { /* skip unreadable */ }
    }

    walk(this.workspaceRoot)
    return results
  }

  private computeFileHashes(filePaths: string[]): Record<string, string> {
    const hashes: Record<string, string> = {}
    for (const fp of filePaths) {
      try {
        const content = fs.readFileSync(fp)
        hashes[path.relative(this.workspaceRoot, fp)] = crypto
          .createHash('sha256')
          .update(content)
          .digest('hex')
          .slice(0, 16)
      } catch { /* skip */ }
    }
    return hashes
  }
}
