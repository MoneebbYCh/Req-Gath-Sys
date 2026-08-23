import type { AgentEvent, AgentSurfaceContext } from '../../../shared/agentProtocol'
import type { ToolResult } from '../contracts/RepositoryTool'
import { agentEventSchema } from '../contracts/AgentEvent'
import { persistedAgentStateSchema, type PersistedAgentState } from '../state/PersistedState'
import { z } from 'zod'
import type { OperationalDiagnostic } from '../observability/OperationalLogger'

export type WorkerDiagnostic = OperationalDiagnostic

/** Extension host → agent worker (typed RPC). */
export type HostToWorkerMessage =
  | { type: 'start'; requestId: string; text: string; surface: AgentSurfaceContext }
  | { type: 'cancel'; taskId: string }
  | { type: 'resume'; taskId: string }
  | { type: 'snapshot' }
  | { type: 'toolResult'; callId: string; ok: boolean; result?: ToolResult<unknown>; error?: string }
  | { type: 'documentResult'; callId: string; ok: boolean; result?: unknown; error?: string }
  | { type: 'statePersistAck'; persistenceId: string; ok: boolean; error?: string }

/** Agent worker → extension host. */
export type WorkerToHostMessage =
  | { type: 'event'; event: AgentEvent }
  | { type: 'toolCall'; callId: string; name: string; input: unknown }
  | { type: 'toolCancel'; callId: string }
  | {
      type: 'documentCall'
      callId: string
      op: 'createDocument' | 'checkpointDocument' | 'loadDocumentIR'
      payload: unknown
    }
  | { type: 'statePersist'; persistenceId: string; state: PersistedAgentState }
  | { type: 'diagnostic'; diagnostic: WorkerDiagnostic }

/**
 * Runtime schemas for the isolated-worker RPC. Types alone cannot protect a
 * worker thread boundary: every message is untrusted until parsed here.
 * Payloads deliberately remain opaque where their owning service validates
 * them (tool/document inputs), while routing identifiers and operation names
 * are always checked before dispatch.
 */
const surfaceSchema = z.object({
  page: z.string().min(1),
  activeDocumentId: z.string().min(1).optional(),
}).strict()

export const hostToWorkerMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('start'), requestId: z.string().min(1), text: z.string(), surface: surfaceSchema }).strict(),
  z.object({ type: z.literal('cancel'), taskId: z.string().min(1) }).strict(),
  z.object({ type: z.literal('resume'), taskId: z.string().min(1) }).strict(),
  z.object({ type: z.literal('snapshot') }).strict(),
  z.object({ type: z.literal('toolResult'), callId: z.string().min(1), ok: z.boolean(), result: z.unknown().optional(), error: z.string().optional() }).strict(),
  z.object({ type: z.literal('documentResult'), callId: z.string().min(1), ok: z.boolean(), result: z.unknown().optional(), error: z.string().optional() }).strict(),
  z.object({ type: z.literal('statePersistAck'), persistenceId: z.string().min(1), ok: z.boolean(), error: z.string().optional() }).strict(),
])

export const workerToHostMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('event'), event: agentEventSchema }).strict(),
  z.object({ type: z.literal('toolCall'), callId: z.string().min(1), name: z.string().min(1), input: z.unknown() }).strict(),
  z.object({ type: z.literal('toolCancel'), callId: z.string().min(1) }).strict(),
  z.object({
    type: z.literal('documentCall'),
    callId: z.string().min(1),
    op: z.enum(['createDocument', 'checkpointDocument', 'loadDocumentIR']),
    payload: z.unknown(),
  }).strict(),
  z.object({ type: z.literal('statePersist'), persistenceId: z.string().min(1), state: persistedAgentStateSchema }).strict(),
  z.object({
    type: z.literal('diagnostic'),
    diagnostic: z.object({
      event: z.string().min(1).max(120), level: z.enum(['debug', 'info', 'warn', 'error']).optional(),
      taskId: z.string().min(1).optional(), nodeId: z.string().min(1).optional(),
      workerType: z.enum(['repository', 'analysis', 'document', 'validation']).optional(),
      tool: z.string().min(1).max(120).optional(), model: z.string().min(1).max(160).optional(),
      durationMs: z.number().nonnegative().optional(), count: z.number().nonnegative().optional(),
      inputTokens: z.number().nonnegative().optional(), outputTokens: z.number().nonnegative().optional(),
      retryCount: z.number().nonnegative().optional(), concurrency: z.number().nonnegative().optional(),
      errorKind: z.enum(['cancelled', 'configuration', 'provider', 'rate_limited', 'tool', 'validation', 'worker', 'unknown']).optional(),
      ok: z.boolean().optional(),
    }).strict(),
  }).strict(),
])

export function parseHostToWorkerMessage(input: unknown): HostToWorkerMessage | null {
  const result = hostToWorkerMessageSchema.safeParse(input)
  return result.success ? result.data as HostToWorkerMessage : null
}

export function parseWorkerToHostMessage(input: unknown): WorkerToHostMessage | null {
  const result = workerToHostMessageSchema.safeParse(input)
  return result.success ? result.data as WorkerToHostMessage : null
}
