import { describe, expect, it } from 'vitest'
import { isSensitivePath, redactSecrets } from './SensitiveFilePolicy'

describe('isSensitivePath', () => {
  it('blocks plain .env and .env.production but allows examples/templates', () => {
    expect(isSensitivePath('.env')).toBe(true)
    expect(isSensitivePath('src/.env')).toBe(true)
    expect(isSensitivePath('.env.production')).toBe(true)
    expect(isSensitivePath('.env.example')).toBe(false)
    expect(isSensitivePath('.env.sample')).toBe(false)
    expect(isSensitivePath('.env.template')).toBe(false)
  })

  it('blocks private keys and keystores', () => {
    expect(isSensitivePath('~/.ssh/id_rsa')).toBe(true)
    expect(isSensitivePath('certs/server.pem')).toBe(true)
    expect(isSensitivePath('keystore.p12')).toBe(true)
    expect(isSensitivePath('client.pfx')).toBe(true)
  })

  it('blocks cloud credential directories', () => {
    expect(isSensitivePath('.aws/credentials')).toBe(true)
    expect(isSensitivePath('.kube/config')).toBe(true)
    expect(isSensitivePath('.gcloud/service-account.json')).toBe(true)
  })

  it('blocks credential-ish filenames', () => {
    expect(isSensitivePath('credentials.json')).toBe(true)
    expect(isSensitivePath('config/secrets.yml')).toBe(true)
    expect(isSensitivePath('src/secret.ts')).toBe(true)
  })

  it('allows ordinary source files', () => {
    expect(isSensitivePath('src/auth.ts')).toBe(false)
    expect(isSensitivePath('package.json')).toBe(false)
    expect(isSensitivePath('README.md')).toBe(false)
  })
})

describe('redactSecrets', () => {
  it('masks OpenAI-style keys, AWS keys, and GitHub tokens', () => {
    const text =
      'key=sk-abc123def456 token=AKIAIOSFODNN7EXAMPLE gh=ghp_012345678901234567890123456789'
    const out = redactSecrets(text)
    expect(out).not.toContain('sk-abc123def456')
    expect(out).not.toContain('AKIAIOSFODNN7EXAMPLE')
    expect(out).not.toContain('hp_012345678901234567890123456789')
    expect(out).toContain('***redacted***')
  })

  it('leaves ordinary text untouched', () => {
    const text = 'export function login() { return "ok" }'
    expect(redactSecrets(text)).toBe(text)
  })
})
