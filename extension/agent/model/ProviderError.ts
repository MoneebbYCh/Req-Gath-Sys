/**
 * Provider error taxonomy (plan §3 acceptance): every provider failure is
 * normalized into a `ProviderError` with a kind and a retryability category.
 * Retry POLICY (backoff, budgets) lands with Phase 14 — this only categorizes.
 */
export type ProviderErrorKind =
  | 'auth'
  | 'rate_limited'
  | 'server'
  | 'network'
  | 'timeout'
  | 'cancelled'
  | 'invalid_response'
  | 'unknown'

const RETRYABLE = new Set<ProviderErrorKind>([
  'rate_limited',
  'server',
  'network',
  'timeout',
])

export class ProviderError extends Error {
  readonly kind: ProviderErrorKind
  readonly retryable: boolean
  /**
   * Server-suggested retry delay (plan §3 edge case: 429 with Retry-After
   * headers). Milliseconds; undefined when the provider did not send one.
   */
  readonly retryAfterMs?: number

  constructor(kind: ProviderErrorKind, message: string, retryAfterMs?: number) {
    super(message)
    this.name = 'ProviderError'
    this.kind = kind
    this.retryable = RETRYABLE.has(kind)
    if (retryAfterMs !== undefined) this.retryAfterMs = retryAfterMs
  }
}

export function isRetryableProviderError(err: unknown): boolean {
  return err instanceof ProviderError && err.retryable
}

const FRIENDLY: Record<ProviderErrorKind, string> = {
  auth: 'Authentication failed — set a valid key via "Charter Ai: Set Provider API Key".',
  rate_limited: 'Provider rate limit reached (429). Try again shortly.',
  server: 'Provider returned a server error (5xx). Try again shortly.',
  network: 'Network error while contacting the provider.',
  timeout: 'Provider request timed out.',
  cancelled: 'Request cancelled.',
  invalid_response: 'Provider returned an invalid response.',
  unknown: 'Unknown provider error.',
}

/** Human-facing message for a kind (safe for the UI). */
export function providerErrorMessage(kind: ProviderErrorKind, detail?: string): string {
  const base = FRIENDLY[kind]
  return detail ? `${base} ${detail}` : base
}

export function toErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
