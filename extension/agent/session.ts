import { z } from 'zod'

/**
 * Session contract (plan §7). One active conversation session per workspace,
 * owned by the runtime — never reconstructed from webview chat bubbles.
 */
export interface AgentSession {
  id: string
  workspaceId: string
  createdAt: number
  updatedAt: number
  status: 'active' | 'archived'
  conversationSummary?: string
  /** Durable, bounded turn log. It is the source for multi-turn context. */
  turns: SessionTurn[]
  /** Structured compaction memory keeps critical references lossless. */
  memory: SessionMemory
}

export interface SessionTurn {
  id: string
  taskId?: string
  role: 'user' | 'assistant'
  content: string
  /** Explicit metadata survives compaction even when prose is shortened. */
  objectives: string[]
  decisions: string[]
  evidenceIds: string[]
  factIds: string[]
  createdAt: number
}

export interface SessionMemory {
  objectives: string[]
  decisions: string[]
  evidenceIds: string[]
  factIds: string[]
  notes: string[]
}

const sessionTurnSchema = z.object({
  id: z.string(),
  taskId: z.string().optional(),
  role: z.enum(['user', 'assistant']),
  content: z.string(),
  objectives: z.array(z.string()),
  decisions: z.array(z.string()),
  evidenceIds: z.array(z.string()),
  factIds: z.array(z.string()),
  createdAt: z.number(),
})
const sessionMemorySchema = z.object({
  objectives: z.array(z.string()).default([]),
  decisions: z.array(z.string()).default([]),
  evidenceIds: z.array(z.string()).default([]),
  factIds: z.array(z.string()).default([]),
  notes: z.array(z.string()).default([]),
})

export const agentSessionSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
  status: z.enum(['active', 'archived']),
  conversationSummary: z.string().optional(),
  turns: z.array(sessionTurnSchema).default([]),
  memory: sessionMemorySchema.default({ objectives: [], decisions: [], evidenceIds: [], factIds: [], notes: [] }),
})

const MAX_TURNS = 12
const MAX_RAW_TURN_CHARS = 12_000
const MAX_SUMMARY_CHARS = 6_000

/**
 * In-memory session store: at most one active session per workspace. A
 * workspace switch archives the previous session and creates a new one.
 * Durable persistence arrives with Phase 14 (restart recovery).
 */
export class SessionStore {
  private session: AgentSession | null = null

  getOrCreate(workspaceId: string): AgentSession {
    if (this.session && this.session.workspaceId === workspaceId && this.session.status === 'active') {
      return this.session
    }
    if (this.session) this.session.status = 'archived'
    const now = Date.now()
    this.session = {
      id: crypto.randomUUID(),
      workspaceId,
      createdAt: now,
      updatedAt: now,
      status: 'active',
      turns: [],
      memory: { objectives: [], decisions: [], evidenceIds: [], factIds: [], notes: [] },
    }
    return this.session
  }

  current(): AgentSession | null {
    return this.session
  }

  touch(): void {
    if (this.session) this.session.updatedAt = Date.now()
  }

  /** Plan §7/§15: store the compaction summary on the active session. */
  setSummary(summary: string): void {
    if (!this.session) return
    this.session.conversationSummary = summary
    this.touch()
  }

  summary(): string | undefined {
    return this.session?.conversationSummary
  }

  restore(session: AgentSession | undefined): void {
    if (!session) return
    this.session = agentSessionSchema.parse(session)
  }

  snapshot(): AgentSession | undefined {
    return this.session ? structuredClone(this.session) : undefined
  }

  recordUserTurn(taskId: string, content: string): void {
    this.record({
      taskId,
      role: 'user',
      content,
      objectives: [content],
      decisions: [],
      evidenceIds: [],
      factIds: [],
    })
  }

  /** Replace the request placeholder once AgentRuntime allocates the task id. */
  assignTaskId(placeholder: string, taskId: string): void {
    const turn = this.session?.turns.findLast((candidate) => candidate.taskId === placeholder)
    if (!turn) return
    turn.taskId = taskId
    this.touch()
  }

  recordAssistantTurn(input: {
    taskId: string
    content: string
    decisions?: string[]
    evidenceIds?: string[]
    factIds?: string[]
  }): void {
    this.record({
      ...input,
      role: 'assistant',
      objectives: [],
      decisions: input.decisions ?? [],
      evidenceIds: input.evidenceIds ?? [],
      factIds: input.factIds ?? [],
    })
  }

  private record(input: Omit<SessionTurn, 'id' | 'createdAt'>): void {
    if (!this.session || !input.content.trim()) return
    this.session.turns.push({ ...input, id: crypto.randomUUID(), createdAt: Date.now() })
    this.compactIfNeeded()
    this.touch()
  }

  /**
   * Compact only old turns. Objectives, decisions, evidence handles and fact
   * ids are promoted into labelled summary sections before their prose moves
   * out of the raw turn log, so later calls retain durable references.
   */
  private compactIfNeeded(): void {
    const session = this.session
    if (!session) return
    const rawChars = session.turns.reduce((total, turn) => total + turn.content.length, 0)
    if (session.turns.length <= MAX_TURNS && rawChars <= MAX_RAW_TURN_CHARS) return
    const keep = session.turns.slice(-6)
    const compacted = session.turns.slice(0, -6)
    const collect = (key: keyof Pick<SessionTurn, 'objectives' | 'decisions' | 'evidenceIds' | 'factIds'>) =>
      unique([...session.memory[key], ...compacted.flatMap((turn) => turn[key])])
    session.memory = {
      objectives: collect('objectives'),
      decisions: collect('decisions'),
      evidenceIds: collect('evidenceIds'),
      factIds: collect('factIds'),
      notes: [...session.memory.notes, ...compacted.map((turn) => `${turn.role}: ${turn.content.slice(0, 600)}`)].slice(-8),
    }
    const summary = [
      section('Objectives', session.memory.objectives.map((value) => value.slice(0, 500))),
      section('Decisions', session.memory.decisions),
      section('Evidence IDs', session.memory.evidenceIds),
      section('Fact IDs', session.memory.factIds),
      section('Earlier turn notes', session.memory.notes),
    ].filter(Boolean).join('\n\n')
    session.conversationSummary = summary.slice(0, MAX_SUMMARY_CHARS)
    session.turns = keep
  }
}

function section(label: string, values: string[]): string {
  return values.length > 0 ? `${label}:\n${values.map((value) => `- ${value}`).join('\n')}` : ''
}

function unique(values: string[]): string[] {
  return [...new Set(values)]
}
