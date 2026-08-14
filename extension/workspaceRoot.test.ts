import { describe, expect, it } from 'vitest'
import { resolveWorkspaceRoot } from './workspaceRoot'

describe('resolveWorkspaceRoot', () => {
  it('returns the open folder path', () => {
    expect(resolveWorkspaceRoot('/Users/me/proj')).toBe('/Users/me/proj')
  })

  it('returns null when no folder is open — never falls back to the extension install dir', () => {
    expect(resolveWorkspaceRoot(undefined)).toBeNull()
  })

  it('returns null for an empty folder path', () => {
    expect(resolveWorkspaceRoot('')).toBeNull()
  })
})