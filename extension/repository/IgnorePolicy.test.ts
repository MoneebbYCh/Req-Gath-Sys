import { describe, expect, it } from 'vitest'
import { classifyFlags, languageFor } from './IgnorePolicy'

describe('IgnorePolicy flags', () => {
  it('flags vendor, test, config, generated, build, and binary files', () => {
    expect(classifyFlags('vendor/lib.c')).toContain('vendor')
    expect(classifyFlags('src/auth.test.ts')).toContain('test')
    expect(classifyFlags('__tests__/helpers.ts')).toContain('test')
    expect(classifyFlags('config/app.yaml')).toContain('config')
    expect(classifyFlags('src/types.d.ts')).toContain('generated')
    expect(classifyFlags('dist/bundle.min.js')).toEqual(expect.arrayContaining(['build', 'generated']))
    expect(classifyFlags('assets/logo.png')).toContain('binary')
  })

  it('leaves ordinary source unflagged', () => {
    expect(classifyFlags('src/auth.ts')).toEqual([])
  })

  it('maps extensions to language ids', () => {
    expect(languageFor('src/auth.ts')).toBe('typescript')
    expect(languageFor('main.py')).toBe('python')
    expect(languageFor('config/deploy.tf')).toBe('terraform')
    expect(languageFor('README.md')).toBe('markdown')
    expect(languageFor('noextension')).toBeUndefined()
  })
})
