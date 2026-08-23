import { describe, expect, it, vi } from 'vitest'
import { createMermaidValidator } from './mermaidValidate'

describe('createMermaidValidator', () => {
  it('accepts a diagram the parser accepts', async () => {
    const parse = vi.fn(async () => ({ diagramType: 'flowchart-v2' }))
    const validate = createMermaidValidator({ parse })
    const result = await validate('flowchart TD\n  A --> B')
    expect(result).toEqual({ ok: true, diagramType: 'flowchart-v2' })
    expect(parse).toHaveBeenCalledWith('flowchart TD\n  A --> B')
  })

  it('returns a truncated parse error message on failure', async () => {
    const parse = vi.fn(async () => {
      throw new Error(`Parse error on line 1, column 5: ${'x'.repeat(600)}`)
    })
    const validate = createMermaidValidator({ parse })
    const result = await validate('flowchart TD\n A ->> B')
    expect(result.ok).toBe(false)
    expect(result.error).toContain('Parse error on line 1')
    expect(result.error!.length).toBeLessThanOrEqual(500)
  })

  it('rejects empty sources without calling the parser', async () => {
    const parse = vi.fn(async () => ({ diagramType: 'flowchart' }))
    const validate = createMermaidValidator({ parse })
    expect(await validate('   ')).toEqual({ ok: false, error: 'Empty diagram' })
    expect(parse).not.toHaveBeenCalled()
  })

  it('sanitizes labels before parsing (parity with the webview renderer)', async () => {
    const parse = vi.fn(async () => ({ diagramType: 'flowchart' }))
    const validate = createMermaidValidator({ parse })
    await validate('flowchart TD\n  A[GET /x/{id}] --> B')
    expect(parse).toHaveBeenCalledWith('flowchart TD\n  A["GET /x/{id}"] --> B')
  })

  it('treats non-Error throws as failures', async () => {
    const parse = vi.fn(async () => {
      throw 'boom'
    })
    const validate = createMermaidValidator({ parse })
    expect(await validate('flowchart TD\n A')).toEqual({ ok: false, error: 'boom' })
  })
})
