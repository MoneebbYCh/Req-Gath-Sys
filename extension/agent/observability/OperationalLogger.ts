/**
 * Allow-list logger for operational diagnostics. It deliberately accepts only
 * compact metadata; repository content, prompts, responses, tool arguments,
 * and absolute paths have no representable fields.
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
  documentEvent?: 'section_parse_attempt' | 'section_fallback' | 'section_fallback_checkpointed'
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
    }
    this.append(JSON.stringify(line))
  }
}

function levelRank(level: NonNullable<OperationalDiagnostic['level']>): number {
  return { debug: 10, info: 20, warn: 30, error: 40 }[level]
}
