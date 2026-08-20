import { describe, expect, it } from 'vitest'
import { previewObservation, summarizeToolArgs } from './devLog'

describe('devLog helpers', () => {
  it('summarizes grep and read args', () => {
    expect(summarizeToolArgs({ path: 'src/routes', pattern: 'router.get' })).toContain('src/routes')
    expect(summarizeToolArgs({ path: 'a.js', offset: 1, limit: 40 })).toMatch(/offset=1/)
  })

  it('previews observations without dumping the whole file', () => {
    const long = 'word '.repeat(80)
    const preview = previewObservation(long, 40)
    expect(preview.length).toBeLessThanOrEqual(45)
    expect(preview).toMatch(/…$/)
  })
})
