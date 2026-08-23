/**
 * Sensitive-file policy (plan §9): default-block obvious credential material
 * before it can reach a model. `.env.example`/templates stay readable.
 */

const BLOCKED_NAMES = new Set(['id_rsa', 'id_ed25519', 'id_ecdsa', 'id_dsa'])

const BLOCKED_EXTENSIONS = ['.pem', '.key', '.p12', '.pfx', '.keystore', '.jks', '.ovpn']

/** `.env.example`, `.env.sample`, `.env.template`, `.env.dist`, `.env.schema` stay readable. */
const SAFE_ENV_SUFFIXES = ['.example', '.sample', '.template', '.dist', '.schema']

const CREDENTIAL_DIRS = new Set(['.ssh', '.aws', '.gcloud', '.gnupg', '.kube', '.azure'])

export function isSensitivePath(p: string): boolean {
  const normalized = p.replace(/\\/g, '/')
  const lower = normalized.toLowerCase()
  const segments = normalized.split('/')
  const base = (segments[segments.length - 1] ?? '').toLowerCase()

  for (const seg of segments) {
    if (CREDENTIAL_DIRS.has(seg.toLowerCase())) return true
  }

  // .env files — plain `.env` blocked; examples/templates allowed.
  if (base === '.env') return true
  if (/^\.env\./.test(base)) {
    const suffix = base.slice(4)
    if (!SAFE_ENV_SUFFIXES.some((s) => suffix.endsWith(s))) return true
  }

  if (BLOCKED_NAMES.has(base)) return true
  if (BLOCKED_EXTENSIONS.some((ext) => lower.endsWith(ext))) return true

  // Credential-ish filenames: credentials.json, service-account keys, secrets.yml, …
  if (/(^|[/_.-])(credentials|serviceaccount|secret)[a-z0-9_-]*(\.|$)/.test(lower)) return true

  return false
}

/**
 * Redact obvious secret literals from content before it is handed to a model.
 * Pattern-specific (low false-positive): OpenAI-style keys, AWS access keys,
 * GitHub tokens.
 */
export function redactSecrets(text: string): string {
  return text
    .replace(/(sk-[A-Za-z0-9_-]{8,})/g, '***redacted***')
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, '***redacted***')
    .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, '***redacted***')
}
