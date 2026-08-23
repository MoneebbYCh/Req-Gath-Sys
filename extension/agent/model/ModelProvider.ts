import type { ModelEvent, ModelRequest } from './ModelTypes'

/**
 * One clean streaming/tool-capable model interface (plan §3). Orchestration
 * depends on this, never on a provider SDK. `AbortSignal` interrupts streaming.
 */
export interface ModelProvider {
  stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent>
}
