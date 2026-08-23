import type {
  RepositoryTool,
  ToolContext,
  ToolResult,
} from '../agent/contracts/RepositoryTool'
import { ToolError } from '../agent/contracts/RepositoryTool'
import { resolveWithinRoots } from './PathGuard'
import { isSensitivePath, redactSecrets } from './SensitiveFilePolicy'
import { truncateStringsToBudget } from './OutputLimiter'

/**
 * Read-Only Repository Tool Gateway (plan §9): the single deterministic API
 * through which every agent/worker accesses repository information.
 *
 * One place for: schema validation, workspace containment, sensitive-file
 * policy, secret redaction, output limits, timeouts, error normalization, and
 * tool execution. Read-only is enforced by construction — no write/shell tool
 * can exist here.
 */
export interface GatewayOptions {
  /** Hard byte budget for a serialized tool result. */
  maxResultBytes?: number
  /** Per-call timeout. */
  toolTimeoutMs?: number
  /** Secret redaction on every result. */
  redact?: boolean
}

export interface GatewayExecuteOptions {
  workspaceRoots: string[]
  repositoryVersion: string
  signal: AbortSignal
  log?: (msg: string) => void
}

const DEFAULT_MAX_RESULT_BYTES = 64 * 1024
const DEFAULT_TOOL_TIMEOUT_MS = 30_000

export class RepositoryToolGateway {
  private readonly tools = new Map<string, RepositoryTool<unknown, unknown>>()
  private readonly maxResultBytes: number
  private readonly toolTimeoutMs: number
  private readonly redact: boolean

  /** Plan §9 responsibilities: cheap counters (real observability lands Phase 16). */
  calls = 0
  errors = 0
  validationErrors = 0
  timeouts = 0
  totalDurationMs = 0

  constructor(options: GatewayOptions = {}) {
    this.maxResultBytes = options.maxResultBytes ?? DEFAULT_MAX_RESULT_BYTES
    this.toolTimeoutMs = options.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS
    this.redact = options.redact ?? true
  }

  register<I, O>(tool: RepositoryTool<I, O>): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool already registered: ${tool.name}`)
    }
    this.tools.set(tool.name, tool as RepositoryTool<unknown, unknown>)
  }

  list(): Array<{ name: string; description: string }> {
    return [...this.tools.values()].map((t) => ({ name: t.name, description: t.description }))
  }

  async execute(
    name: string,
    rawInput: unknown,
    opts: GatewayExecuteOptions,
  ): Promise<ToolResult<unknown>> {
    const startedAt = Date.now()
    const log = opts.log ?? (() => {})
    this.calls++

    const tool = this.tools.get(name)
    if (!tool) {
      this.errors++
      throw new ToolError(`Unknown repository tool: ${name}`, false)
    }

    // Schema validation — invalid model/tool input becomes a structured error.
    const parsed = tool.inputSchema.safeParse(rawInput)
    if (!parsed.success) {
      this.validationErrors++
      this.errors++
      const issues = parsed.error.issues
        .map((i) => `${i.path.join('.') || 'input'}: ${i.message}`)
        .join('; ')
      throw new ToolError(`Invalid input for ${name}: ${issues}`, false)
    }

    // Task cancellation + a hard per-call timeout.
    const timeoutSignal = AbortSignal.timeout(this.toolTimeoutMs)
    const combined = AbortSignal.any([opts.signal, timeoutSignal])

    const context: ToolContext = {
      workspaceRoots: opts.workspaceRoots,
      repositoryVersion: opts.repositoryVersion,
      signal: combined,
      log,
      resolvePath: (input) => resolveWithinRoots(input, opts.workspaceRoots),
      isSensitivePath,
    }

    let result: ToolResult<unknown>
    try {
      result = await tool.execute(parsed.data, context)
    } catch (err) {
      this.errors++
      if (err instanceof ToolError) throw err
      if (opts.signal.aborted) throw new ToolError('Tool call cancelled.', false)
      if (timeoutSignal.aborted) {
        this.timeouts++
        throw new ToolError(`Tool ${name} timed out after ${this.toolTimeoutMs}ms.`, true)
      }
      throw new ToolError(
        `Tool ${name} failed: ${err instanceof Error ? err.message : String(err)}`,
        false,
      )
    }

    // Envelope: every result carries the repository version it was produced against.
    result.repositoryVersion = opts.repositoryVersion

    // Safety net before anything reaches a model: redaction + hard byte budget.
    if (this.redact) {
      result.data = redactStrings(result.data)
    }
    const { value, truncated } = truncateStringsToBudget(result.data, this.maxResultBytes)
    result.data = value
    if (truncated) {
      result.truncated = true
      result.warnings = [
        ...(result.warnings ?? []),
        'Output exceeded the gateway size budget and was truncated.',
      ]
    }

    const elapsed = Date.now() - startedAt
    this.totalDurationMs += elapsed
    log(`tool ${name} ok in ${elapsed}ms truncated=${result.truncated}`)
    return result
  }
}

function redactStrings(value: unknown): unknown {
  if (typeof value === 'string') return redactSecrets(value)
  if (Array.isArray(value)) return value.map(redactStrings)
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) out[k] = redactStrings(v)
    return out
  }
  return value
}
