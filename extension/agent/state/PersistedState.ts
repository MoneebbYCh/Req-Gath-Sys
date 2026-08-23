import { z } from 'zod'
import * as fs from 'node:fs/promises'
import { lstatSync, readFileSync, readdirSync, type Dirent } from 'node:fs'
import { execFileSync } from 'node:child_process'
import * as path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { taskNodeSchema, type TaskNode } from '../contracts/TaskGraph'
import {
  evidenceRecordSchema,
  type EvidenceRecord,
} from '../contracts/Evidence'
import {
  findingSchema,
  projectFactSchema,
  type Finding,
  type ProjectFact,
} from '../contracts/Finding'
import { documentIrSchema, type DocumentIR } from '../../documents/DocumentIR'
import type { AgentSurfaceContext, DocumentProgressState, PlanView } from '../../../shared/agentProtocol'
import { agentSessionSchema, type AgentSession } from '../session'
import type { ModelMessage } from '../model/ModelTypes'

/**
 * Durable agent state (plan §14 + §25): what survives an extension-host
 * restart. Private runtime state lives under the workspace's extension
 * storage (`agent-state/`), never `.charter-ai/` (which stays for user-visible
 * artifacts). Writes are atomic (temp file + rename) so a crash can never
 * leave a half-written state file (acceptance §14).
 *
 * "running" is persisted as-is, but a task loaded after a restart is ALWAYS
 * reclassified `interrupted` by the runtime — a crash cannot leave a task
 * looking permanently running without an owner (acceptance §14).
 */

export type PersistedTaskStatus = 'running' | 'completed' | 'failed' | 'cancelled'

/**
 * Mid-loop conversation for single-loop tasks (plan §14): enough of the message
 * history + counters to resume the bounded ReAct loop after a restart without
 * repeating completed tool calls. Compacted (last few messages, truncated) so
 * it stays a bounded fraction of the durable state file.
 */
export interface LoopState {
  messages: ModelMessage[]
  toolCallsUsed: number
  modelCallsUsed: number
  evidenceIds: string[]
}

export interface PersistedTask {
  taskId: string
  requestId: string
  /** Original user text — needed to re-run the task on resume. */
  text: string
  surface: AgentSurfaceContext
  title: string
  status: PersistedTaskStatus
  assistantText: string
  activities: string[]
  plan?: PlanView
  documents: DocumentProgressState[]
  error?: string
  /** Next task event sequence, preserved so resumed events remain monotonic. */
  nextSeq?: number
  /** Full task graph for complex tasks — statuses/outputs included. */
  graph?: TaskNode[]
  /** Mid-loop state for single-loop tasks (plan §14 resume). */
  loopState?: LoopState
}

export interface PersistedAgentState {
  version: 1
  workspaceId: string
  /** Repo fingerprint at task start — resume is refused when it changes. */
  repoFingerprint: string
  updatedAt: number
  /** Bounded: most recent tasks only (oldest dropped first). */
  tasks: PersistedTask[]
  /** Latest agent IR per document — the regeneration base after a restart. */
  documentIRs: Record<string, DocumentIR>
  /** Shared knowledge layer (plan §14: no repeated analysis after restart). */
  findings: Finding[]
  facts: ProjectFact[]
  evidence: EvidenceRecord[]
  /** Durable conversation context, independent from webview chat bubbles. */
  session?: AgentSession
}

const documentProgressStateSchema = z.object({
  documentId: z.string(),
  title: z.string(),
  status: z.enum(['queued', 'outlining', 'generating', 'validating', 'completed', 'failed']),
  completedSections: z.number().int().nonnegative(),
  totalSections: z.number().int().nonnegative(),
  activeSection: z.string().optional(),
  error: z.string().optional(),
  nextSeq: z.number().int().nonnegative().optional(),
})

const planViewSchema = z.object({
  nodes: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      status: z.enum(['queued', 'running', 'completed', 'failed', 'blocked', 'cancelled']),
    }),
  ),
})

const loopMessageSchema = z.discriminatedUnion('role', [
  z.object({ role: z.literal('system'), content: z.string().max(4_000) }),
  z.object({ role: z.literal('user'), content: z.string().max(4_000) }),
  z.object({
    role: z.literal('assistant'),
    content: z.string().max(4_000),
    reasoningContent: z.string().max(4_000).optional(),
    toolCalls: z.array(
      z.object({ id: z.string(), name: z.string(), arguments: z.string().max(4_000) }),
    ).optional(),
  }),
  z.object({
    role: z.literal('tool'),
    content: z.string().max(4_000),
    toolCallId: z.string(),
    name: z.string(),
  }),
])

const loopStateSchema = z.object({
  messages: z.array(loopMessageSchema).max(6),
  toolCallsUsed: z.number().int().nonnegative(),
  modelCallsUsed: z.number().int().nonnegative(),
  evidenceIds: z.array(z.string()),
})

const persistedTaskSchema = z.object({
  taskId: z.string(),
  requestId: z.string(),
  text: z.string(),
  surface: z.object({ page: z.string(), activeDocumentId: z.string().optional() }),
  title: z.string(),
  status: z.enum(['running', 'completed', 'failed', 'cancelled']),
  assistantText: z.string(),
  activities: z.array(z.string()),
  plan: planViewSchema.optional(),
  documents: z.array(documentProgressStateSchema),
  error: z.string().optional(),
  graph: z.array(taskNodeSchema).optional(),
  loopState: loopStateSchema.optional(),
})

export const persistedAgentStateSchema = z.object({
  version: z.literal(1),
  workspaceId: z.string(),
  repoFingerprint: z.string(),
  updatedAt: z.number(),
  tasks: z.array(persistedTaskSchema),
  documentIRs: z.record(z.string(), documentIrSchema),
  findings: z.array(findingSchema),
  facts: z.array(projectFactSchema),
  evidence: z.array(evidenceRecordSchema),
  session: agentSessionSchema.optional(),
})

/** How many evidence records survive a restart (bounded — plan §14). */
export const MAX_PERSISTED_EVIDENCE = 300

/** How many recent tasks survive a restart (bounded — plan §14). */
export const MAX_PERSISTED_TASKS = 8

/** Atomic state persistence: temp file + rename (plan §14 acceptance). */
export interface StateStore {
  load(): Promise<PersistedAgentState | null>
  save(state: PersistedAgentState): Promise<void>
}

export function createFileStateStore(storagePath: string): StateStore {
  const dir = path.dirname(storagePath)
  return {
    async load() {
      try {
        const raw = await fs.readFile(storagePath, 'utf8')
        const parsed = persistedAgentStateSchema.safeParse(JSON.parse(raw))
        if (!parsed.success) {
          // Corrupt state file: start fresh rather than crashing the host.
          return null
        }
        return parsed.data
      } catch {
        return null
      }
    },
    async save(state) {
      const data = persistedAgentStateSchema.parse(state)
      // Unique temp name: concurrent node flushes (parallel workers) must not
      // collide on a shared temp file — a fixed name races on rename (ENOENT)
      // and one flush fails, which fails the node and blocks its dependents.
      const tmp = `${storagePath}.${process.pid}.${randomUUID()}.tmp`
      await fs.mkdir(dir, { recursive: true })
      await fs.writeFile(tmp, JSON.stringify(data), 'utf8')
      await fs.rename(tmp, storagePath)
    },
  }
}

/**
 * Synchronous load used at host startup: the initial state must be in the
 * worker's hands BEFORE its first task can start (no restore race).
 */
export function loadStateSync(storagePath: string): PersistedAgentState | null {
  try {
    const raw = readFileSync(storagePath, 'utf8')
    const parsed = persistedAgentStateSchema.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

/** In-memory store for tests. */
export function memoryStateStore(): StateStore & { current: PersistedAgentState | null } {
  const store = {
    current: null as PersistedAgentState | null,
    async load() {
      return store.current
    },
    async save(state: PersistedAgentState) {
      store.current = state
    },
  }
  return store
}

export function emptyState(workspaceId: string, repoFingerprint: string): PersistedAgentState {
  return {
    version: 1,
    workspaceId,
    repoFingerprint,
    updatedAt: Date.now(),
    tasks: [],
    documentIRs: {},
    findings: [],
    facts: [],
    evidence: [],
  }
}

/**
 * Deterministic repository fingerprint for resume gating. Git workspaces use
 * HEAD plus the complete staged/unstaged diff and untracked file content; this
 * detects source changes even when manifests are untouched. A non-git root has
 * no commit graph to use as that boundary, so it receives a deterministic
 * metadata signature of every catalog-visible regular file. It includes both
 * modification and change time: editor restores and tools that preserve mtimes
 * still update ctime, so a resumed task does not trust stale evidence.
 *
 * The signature excludes the same generated/dependency/VCS directories as the
 * repository catalog. It is computed only at host startup/resume gating, not
 * for normal repository tool calls; the Phase 15 index remains metadata-first.
 */
export function computeRepoFingerprint(roots: string[]): string {
  const hash = createHash('sha256')
  let found = false
  for (const root of roots) {
    const gitFingerprint = fingerprintGitRoot(root)
    if (gitFingerprint) {
      hash.update(root)
      hash.update(gitFingerprint)
      found = true
      continue
    }
    const signature = fingerprintNonGitRoot(root)
    if (signature) {
      hash.update(root)
      hash.update(signature)
      found = true
    }
  }
  return found ? hash.digest('hex').slice(0, 32) : ''
}

/** Kept aligned with `repository/IgnorePolicy.ts` without importing VS Code-side code into the worker bundle. */
const NON_GIT_FINGERPRINT_EXCLUDED_DIRECTORIES = new Set([
  '.git', 'node_modules', '.next', 'dist', 'build', 'coverage', 'target', 'out',
])

/**
 * A stable metadata signature for a root that is not managed by Git. Paths are
 * sorted before hashing, symlinks are never followed, and unreadable files
 * contribute a stable marker so an accessibility change invalidates a prior
 * fingerprint rather than silently disappearing from it. This intentionally
 * avoids eagerly reading file bodies so Phase 15 indexing stays metadata-first
 * at 100k-file scale.
 */
function fingerprintNonGitRoot(root: string): string | null {
  const hash = createHash('sha256')
  let fileCount = 0

  const visit = (absoluteDirectory: string, relativeDirectory: string): void => {
    let entries: Dirent[]
    try {
      entries = readdirSync(absoluteDirectory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
    } catch {
      hash.update(`unreadable-directory\0${relativeDirectory}\0`)
      return
    }

    for (const entry of entries) {
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name
      const absolutePath = path.join(absoluteDirectory, entry.name)
      if (entry.isSymbolicLink()) {
        hash.update(`symlink\0${relativePath}\0`)
      } else if (entry.isDirectory()) {
        if (!NON_GIT_FINGERPRINT_EXCLUDED_DIRECTORIES.has(entry.name)) visit(absolutePath, relativePath)
      } else if (entry.isFile()) {
        fileCount++
        hash.update(`file\0${relativePath}\0`)
        try {
          const metadata = lstatSync(absolutePath, { bigint: true })
          hash.update(`${metadata.size}\0${metadata.mtimeNs}\0${metadata.ctimeNs}\0${metadata.mode}\0`)
        } catch {
          hash.update('unreadable-file')
        }
      }
    }
  }

  try {
    if (!lstatSync(root).isDirectory()) return null
    visit(root, '')
    return fileCount > 0 ? hash.digest('hex') : null
  } catch {
    return null
  }
}

function fingerprintGitRoot(root: string): string | null {
  try {
    const run = (args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    const head = run(['rev-parse', 'HEAD']).trim()
    const diff = run(['diff', '--no-ext-diff', '--binary', 'HEAD'])
    const untracked = run(['ls-files', '--others', '--exclude-standard', '-z'])
    const hash = createHash('sha256').update(head).update(diff)
    for (const relativePath of untracked.split('\0').filter(Boolean).sort()) {
      hash.update(relativePath)
      try {
        hash.update(readFileSync(path.join(root, relativePath)))
      } catch {
        hash.update('unreadable')
      }
    }
    return hash.digest('hex')
  } catch {
    return null
  }
}
