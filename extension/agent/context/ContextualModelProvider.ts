import type { EvidenceRecord } from '../contracts/Evidence'
import type { Finding, ProjectFact } from '../contracts/Finding'
import type { ModelProvider } from '../model/ModelProvider'
import type { ModelEvent, ModelRequest } from '../model/ModelTypes'
import type { AgentSession } from '../session'
import { buildContext } from './ContextBuilder'

export interface ContextStateSource {
  session(): AgentSession | undefined
  findings(): Finding[]
  facts(): ProjectFact[]
  evidence(): EvidenceRecord[]
  /** Stable workspace/project instructions supplied by the host. */
  projectInstructions?(): string[]
}

/**
 * The single model boundary for runtime context. Wrapping the provider means
 * planner, tool loops and every worker receive the exact same bounded,
 * provenance-aware session context without each caller rebuilding prompts.
 */
export class ContextualModelProvider implements ModelProvider {
  constructor(
    private readonly delegate: ModelProvider,
    private readonly source: ContextStateSource,
    private readonly budget = 24_000,
  ) {}

  stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent> {
    return this.delegate.stream(this.withContext(request), signal)
  }

  private withContext(request: ModelRequest): ModelRequest {
    const session = this.source.session()
    const evidenceById = new Map(this.source.evidence().map((record) => [record.id, record]))
    const facts = this.source.facts().slice(-30)
    const findings = this.source.findings().slice(-40)
    const evidenceIds = new Set([...facts.flatMap((fact) => fact.evidenceIds), ...findings.flatMap((finding) => finding.evidenceIds)])
    const evidence = [...evidenceIds]
      .map((id) => evidenceById.get(id))
      .filter((record): record is EvidenceRecord => Boolean(record))
      .slice(-20)
      .map((record) => `[EVIDENCE:${record.id}] ${record.path}${record.range ? `:${record.range.startLine}-${record.range.endLine}` : ''}\n${record.excerpt ?? ''}`)
    const recentTurns = (session?.turns ?? []).slice(-6).map((turn) => `${turn.role.toUpperCase()}: ${turn.content}`)
    const objective = request.messages.filter((message) => message.role === 'user').at(-1)?.content ?? ''
    const task = request.context?.task
    const taskState = task
      ? [
          'Current task state:',
          task.taskId ? `- Task: ${task.taskId}` : '',
          task.nodeId ? `- Node: ${task.nodeId}${task.title ? ` (${task.title})` : ''}` : task.title ? `- Task title: ${task.title}` : '',
          task.status ? `- Status: ${task.status}` : '',
          task.objective ? `- Node objective: ${task.objective}` : '',
          task.dependencies?.length ? `- Dependencies: ${task.dependencies.join(', ')}` : '',
        ].filter(Boolean).join('\n')
      : ''
    const blocks = buildContext({
      system: request.system,
      objective: `Current objective:\n${objective}`,
      roleSpec: taskState,
      instructions: [...(this.source.projectInstructions?.() ?? []), ...(request.context?.instructions ?? [])],
      findings: [
        ...facts.map((fact) => `[FACT:${fact.id}] ${fact.statement} (evidence: ${fact.evidenceIds.join(', ') || 'none'})`),
        ...findings.map((finding) => `[FINDING:${finding.id}] ${finding.claim} (evidence: ${finding.evidenceIds.join(', ') || 'none'})`),
      ],
      evidenceExcerpts: evidence,
      conversation: [session?.conversationSummary ? `Prior session summary:\n${session.conversationSummary}` : '', ...recentTurns],
    }, this.budget)
    // `context` is runtime metadata only. Do not allow wrapped provider
    // implementations to accidentally serialize it to an external API.
    const { context: _context, ...providerRequest } = request
    return { ...providerRequest, system: blocks.join('\n\n') }
  }
}
