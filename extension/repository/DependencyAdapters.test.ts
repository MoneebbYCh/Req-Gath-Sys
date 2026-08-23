import { describe, expect, it } from 'vitest'
import { getAdapter, goAdapter, pythonAdapter, typescriptAdapter } from './DependencyAdapters'

function extract(content: string) {
  return typescriptAdapter.extractImports({ path: 'src/main.ts', languageId: 'typescript', content })
}

describe('typescriptAdapter', () => {
  it('supports the TS/JS language family only', () => {
    for (const lang of ['typescript', 'typescriptreact', 'javascript', 'javascriptreact']) {
      expect(typescriptAdapter.supports(lang)).toBe(true)
    }
    expect(typescriptAdapter.supports('python')).toBe(false)
    expect(typescriptAdapter.supports('terraform')).toBe(false)
  })

  it('extracts static, re-export, require, and dynamic imports with line numbers', () => {
    const edges = extract(
      [
        "import React from 'react'",
        "import { x } from './util'",
        "export { y } from './other'",
        "const fs = require('node:fs')",
        "const lazy = await import('./lazy')",
        "import './styles.css'",
      ].join('\n'),
    )
    expect(edges).toEqual([
      { sourcePath: 'src/main.ts', target: 'react', kind: 'static', provenance: 'parser', line: 1 },
      { sourcePath: 'src/main.ts', target: './util', kind: 'static', provenance: 'parser', line: 2 },
      { sourcePath: 'src/main.ts', target: './other', kind: 'reexport', provenance: 'parser', line: 3 },
      { sourcePath: 'src/main.ts', target: 'node:fs', kind: 'require', provenance: 'parser', line: 4 },
      { sourcePath: 'src/main.ts', target: './lazy', kind: 'dynamic', provenance: 'parser', line: 5 },
      { sourcePath: 'src/main.ts', target: './styles.css', kind: 'side-effect', provenance: 'parser', line: 6 },
    ])
  })

  it('deduplicates identical specifier+kind pairs', () => {
    const edges = extract("import { a } from './x'\nimport { b } from './x'\nimport { b } from './x'\n")
    expect(edges).toHaveLength(1)
  })

  it('misses multi-line import statements (documented lexical limitation)', () => {
    const edges = extract("import {\n  a,\n  b,\n} from './multi'\n")
    expect(edges).toHaveLength(0)
  })

  it('does not confuse dynamic import() with static import', () => {
    const edges = extract("const m = await import('./mod')")
    expect(edges).toEqual([
      { sourcePath: 'src/main.ts', target: './mod', kind: 'dynamic', provenance: 'parser', line: 1 },
    ])
  })
})

describe('getAdapter', () => {
  it('returns adapters for TS/JS, Python, and Go; undefined otherwise', () => {
    expect(getAdapter('typescript')).toBe(typescriptAdapter)
    expect(getAdapter('javascriptreact')).toBe(typescriptAdapter)
    expect(getAdapter('python')).toBe(pythonAdapter)
    expect(getAdapter('go')).toBe(goAdapter)
    expect(getAdapter('rust')).toBeUndefined()
  })
})

describe('pythonAdapter / goAdapter (plan §11 lexical fallback)', () => {
  it('extracts python from/import statements', () => {
    const edges = pythonAdapter.extractImports({
      path: 'app/main.py',
      languageId: 'python',
      content: "from flask import Flask\nimport os\n\nprint('hi')\n",
    })
    expect(edges.map((e) => e.target)).toEqual(['flask', 'os'])
    expect(edges.every((e) => e.provenance === 'parser')).toBe(true)
  })

  it('extracts go single and parenthesized imports', () => {
    const edges = goAdapter.extractImports({
      path: 'main.go',
      languageId: 'go',
      content: 'package main\n\nimport "fmt"\n\nimport (\n\t"net/http"\n\t"os"\n)\n',
    })
    expect(edges.map((e) => e.target)).toEqual(['fmt', 'net/http', 'os'])
  })
})
