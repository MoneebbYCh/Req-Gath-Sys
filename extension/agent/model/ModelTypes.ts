import type { ToolDefinition } from '../contracts/ToolDefinition'

/**
 * Normalized model request/event contracts (plan §3). Provider SDKs never leak
 * past these types — orchestration sees one stream shape regardless of vendor.
 */
export type ModelRole = 'system' | 'user' | 'assistant' | 'tool'

/** A tool call the model emitted in an assistant turn. */
export interface ModelToolCall {
  id: string
  name: string
  arguments: string
}

export type ModelMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: ModelToolCall[]; reasoningContent?: string }
  | { role: 'tool'; content: string; toolCallId: string; name: string }

/** A tool as exposed to the model — the runtime ToolDefinition doubles as it. */
export type ModelToolDefinition = ToolDefinition

/**
 * Runtime-only context used to assemble the prompt at the single model
 * boundary. It is deliberately not part of a provider payload.
 */
export interface ModelTaskContext {
  taskId?: string
  nodeId?: string
  title?: string
  objective?: string
  status?: string
  dependencies?: string[]
}

export interface ModelInvocationContext {
  task?: ModelTaskContext
  /** Request-specific instructions, in addition to workspace instructions. */
  instructions?: string[]
}

export interface ModelRequest {
  model: string
  system: string
  messages: ModelMessage[]
  tools: ModelToolDefinition[]
  temperature?: number
  maxOutputTokens?: number
  /** Provider-native JSON-object mode for schema-constrained worker output. */
  responseFormat?: 'json_object'
  /** Provider reasoning policy; omitted when the caller accepts provider defaults. */
  thinking?: 'enabled' | 'disabled'
  /** Consumed by ContextualModelProvider and never sent to the provider SDK. */
  context?: ModelInvocationContext
}

export interface ModelUsage {
  inputTokens: number
  outputTokens: number
  /** Tokens read from provider cache (DeepSeek: prompt_cache_hit_tokens). */
  cacheReadTokens?: number
  /** Tokens written to provider cache (DeepSeek: prompt_cache_miss_tokens). */
  cacheWriteTokens?: number
  /** Tokens generated as reasoning output (DeepSeek: completion_tokens_details.reasoning_tokens). */
  reasoningTokens?: number
}

/** Normalized model events (plan §3). */
export type ModelEvent =
  | { type: 'text_delta'; text: string }
  /** Private model reasoning, retained only when a tool-call turn must be replayed. */
  | { type: 'reasoning_delta'; text: string }
  | { type: 'tool_call_started'; id: string; name: string }
  | { type: 'tool_call_delta'; id: string; argumentsDelta: string }
  | { type: 'tool_call_completed'; id: string; name: string; arguments: string }
  | { type: 'usage'; usage: ModelUsage }
  | { type: 'finish'; reason: 'stop' | 'tool_calls' | 'length' }
  | { type: 'provider_warning'; message: string }
