/**
 * Allow-list logger for operational diagnostics. The base fields are compact
 * metadata only; repository content, prompts, responses, tool arguments, and
 * absolute paths have no representable fields there. The `trace` fields below
 * (`systemPrompt`, `toolArgs`, `toolOutput`, …) ARE content-bearing and must be
 * emitted at `level: 'debug'` so the default `info` channel stays content-free.
 */
export interface OperationalDiagnostic {
  event: string
  level?: 'debug' | 'info' | 'warn' | 'error'
  taskId?: string
  nodeId?: string
  workerType?: 'repository' | 'analysis' | 'document' | 'validation'
  tool?: string
  model?: string
  durationMs?: number
  count?: number
  inputTokens?: number
  outputTokens?: number
  retryCount?: number
  concurrency?: number
  /** Trace (debug-level) LLM-approach detail. */
  systemPrompt?: string
  thinking?: 'enabled' | 'disabled'
  responseFormat?: 'json_object'
  route?: 'strong' | 'fast'
  toolNames?: string[]
  temperature?: number
  maxOutputTokens?: number
  maxIterations?: number
  maxToolCalls?: number
  parallelToolCalls?: number
  /** Trace (debug-level) tool detail: arguments passed and the result/error. */
  toolArgs?: unknown
  toolOutput?: unknown
  documentEvent?: 'section_parse_attempt' | 'section_fallback' | 'section_fallback_checkpointed' | 'mermaid_parse_attempt' | 'mermaid_fallback'
  documentOperation?: 'generate' | 'regenerate' | 'createDocument' | 'checkpointDocument' | 'loadDocumentIR'
  sectionIndex?: number
  attempt?: 1 | 2
  parseOutcome?: 'valid' | 'empty' | 'markdown' | 'malformed_json' | 'schema_mismatch'
  responseBytes?: number
  jsonExtracted?: boolean
  blockCount?: number
  schemaIssueCount?: number
  schemaIssueCodes?: string[]
  fallbackReason?: 'empty' | 'malformed_json' | 'schema_mismatch'
  checkpointPending?: boolean
  errorKind?: 'cancelled' | 'configuration' | 'provider' | 'rate_limited' | 'tool' | 'document' | 'validation' | 'worker' | 'timeout' | 'unknown'
  ok?: boolean
}

export class OperationalLogger {
  constructor(
    private readonly append: (line: string) => void,
    private readonly enabled = true,
    private readonly minimumLevel: NonNullable<OperationalDiagnostic['level']> = 'info',
  ) {}

  write(event: OperationalDiagnostic): void {
    const level: NonNullable<OperationalDiagnostic['level']> = event.level ?? 'info'
    if (!this.enabled || levelRank(level) < levelRank(this.minimumLevel)) return
    // Copy only declared metadata. This defensive allow-list means an unsafe
    // future caller cannot accidentally serialize a prompt, source body, tool
    // argument, absolute path, secret, or provider response.
    const line: OperationalDiagnostic & { timestamp: string; service: string; level: NonNullable<OperationalDiagnostic['level']> } = {
      timestamp: new Date().toISOString(),
      service: 'charter-ai-agent',
      event: event.event,
      level,
      ...(event.taskId === undefined ? {} : { taskId: event.taskId }),
      ...(event.nodeId === undefined ? {} : { nodeId: event.nodeId }),
      ...(event.workerType === undefined ? {} : { workerType: event.workerType }),
      ...(event.tool === undefined ? {} : { tool: event.tool }),
      ...(event.model === undefined ? {} : { model: event.model }),
      ...(event.durationMs === undefined ? {} : { durationMs: event.durationMs }),
      ...(event.count === undefined ? {} : { count: event.count }),
      ...(event.inputTokens === undefined ? {} : { inputTokens: event.inputTokens }),
      ...(event.outputTokens === undefined ? {} : { outputTokens: event.outputTokens }),
      ...(event.retryCount === undefined ? {} : { retryCount: event.retryCount }),
      ...(event.concurrency === undefined ? {} : { concurrency: event.concurrency }),
      ...(event.documentEvent === undefined ? {} : { documentEvent: event.documentEvent }),
      ...(event.documentOperation === undefined ? {} : { documentOperation: event.documentOperation }),
      ...(event.sectionIndex === undefined ? {} : { sectionIndex: event.sectionIndex }),
      ...(event.attempt === undefined ? {} : { attempt: event.attempt }),
      ...(event.parseOutcome === undefined ? {} : { parseOutcome: event.parseOutcome }),
      ...(event.responseBytes === undefined ? {} : { responseBytes: event.responseBytes }),
      ...(event.jsonExtracted === undefined ? {} : { jsonExtracted: event.jsonExtracted }),
      ...(event.blockCount === undefined ? {} : { blockCount: event.blockCount }),
      ...(event.schemaIssueCount === undefined ? {} : { schemaIssueCount: event.schemaIssueCount }),
      ...(event.schemaIssueCodes === undefined ? {} : { schemaIssueCodes: event.schemaIssueCodes.slice(0, 4) }),
      ...(event.fallbackReason === undefined ? {} : { fallbackReason: event.fallbackReason }),
      ...(event.checkpointPending === undefined ? {} : { checkpointPending: event.checkpointPending }),
      ...(event.errorKind === undefined ? {} : { errorKind: event.errorKind }),
      ...(event.ok === undefined ? {} : { ok: event.ok }),
      // Trace fields. These are the only content-bearing members of the
      // diagnostic and are emitted exclusively at `debug` level by callers.
      ...(event.systemPrompt === undefined ? {} : { systemPrompt: event.systemPrompt }),
      ...(event.thinking === undefined ? {} : { thinking: event.thinking }),
      ...(event.responseFormat === undefined ? {} : { responseFormat: event.responseFormat }),
      ...(event.route === undefined ? {} : { route: event.route }),
      ...(event.toolNames === undefined ? {} : { toolNames: event.toolNames }),
      ...(event.temperature === undefined ? {} : { temperature: event.temperature }),
      ...(event.maxOutputTokens === undefined ? {} : { maxOutputTokens: event.maxOutputTokens }),
      ...(event.maxIterations === undefined ? {} : { maxIterations: event.maxIterations }),
      ...(event.maxToolCalls === undefined ? {} : { maxToolCalls: event.maxToolCalls }),
      ...(event.parallelToolCalls === undefined ? {} : { parallelToolCalls: event.parallelToolCalls }),
      ...(event.toolArgs === undefined ? {} : { toolArgs: safeContent(event.toolArgs) }),
      ...(event.toolOutput === undefined ? {} : { toolOutput: safeContent(event.toolOutput) }),
    }
    this.append(JSON.stringify(line))
  }
}

/** Deep-copy so circular refs cannot crash the whole diagnostic write. */
function safeContent(value: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(value))
  } catch {
    return '[unserializable]'
  }
}

function levelRank(level: NonNullable<OperationalDiagnostic['level']>): number {
  return { debug: 10, info: 20, warn: 30, error: 40 }[level]
}
