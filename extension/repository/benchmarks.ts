import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { IncrementalFileCatalog, type FileWatcher, type FileChangeEvent } from './IncrementalFileCatalog'
import { RepositoryIndex } from './RepositoryIndex'
import { SummaryService, NoOpSummaryProvider } from './SummaryService'
import { createWorkspaceDescriptor } from './WorkspaceDescriptor'

/**
 * Phase 15 Benchmark Fixtures (plan §15 acceptance criteria):
 * - Generates synthetic repositories at 1k, 10k, 100k file scales
 * - Measures: initial scan time, incremental update time, memory usage
 * - Validates: catalog accuracy, summary generation, progressive narrowing
 */

export interface BenchmarkRepoConfig {
  name: string
  fileCount: number
  depth: number
  languages: string[]
  includeVendor: boolean
  includeTests: boolean
  includeGenerated: boolean
}

export const BENCHMARK_CONFIGS: BenchmarkRepoConfig[] = [
  { name: '1k-files', fileCount: 1_000, depth: 3, languages: ['ts', 'js', 'json', 'md'], includeVendor: false, includeTests: true, includeGenerated: false },
  { name: '10k-files', fileCount: 10_000, depth: 4, languages: ['ts', 'js', 'json', 'md', 'py', 'go'], includeVendor: true, includeTests: true, includeGenerated: true },
  { name: '100k-files', fileCount: 100_000, depth: 5, languages: ['ts', 'js', 'json', 'md', 'py', 'go', 'rs', 'java'], includeVendor: true, includeTests: true, includeGenerated: true },
]

const LANGUAGE_EXTENSIONS: Record<string, string[]> = {
  ts: ['.ts', '.tsx'],
  js: ['.js', '.jsx'],
  json: ['.json'],
  md: ['.md'],
  py: ['.py'],
  go: ['.go'],
  rs: ['.rs'],
  java: ['.java'],
}

const MANIFEST_FILES: Record<string, string> = {
  ts: 'package.json',
  py: 'pyproject.toml',
  go: 'go.mod',
  rs: 'Cargo.toml',
  java: 'pom.xml',
}

const TEMPLATE_FILES: Record<string, string> = {
  'package.json': `{\n  "name": "{{name}}",\n  "version": "1.0.0",\n  "main": "index.js",\n  "scripts": { "test": "jest" },\n  "dependencies": {}\n}\n`,
  'pyproject.toml': `[project]\nname = "{{name}}"\nversion = "1.0.0"\ndependencies = []\n`,
  'go.mod': `module {{name}}\n\ngo 1.21\n\nrequire (\n)\n`,
  'Cargo.toml': `[package]\nname = "{{name}}"\nversion = "1.0.0"\nedition = "2021"\n\n[dependencies]\n`,
  'pom.xml': `<?xml version="1.0" encoding="UTF-8"?>\n<project xmlns="http://maven.apache.org/POM/4.0.0">\n  <modelVersion>4.0.0</modelVersion>\n  <groupId>com.example</groupId>\n  <artifactId>{{name}}</artifactId>\n  <version>1.0.0</version>\n</project>\n`,
}

const SOURCE_TEMPLATES: Record<string, string> = {
  ts: `// {{path}}\nexport function {{name}}() {\n  return '{{name}}';\n}\n\nexport class {{className}} {\n  method() { return '{{name}}'; }\n}\n`,
  js: `// {{path}}\nfunction {{name}}() {\n  return '{{name}}';\n}\n\nexport class {{className}} {\n  method() { return '{{name}}'; }\n}\n`,
  py: `# {{path}}\ndef {{name}}():\n    return '{{name}}'\n\nclass {{className}}:\n    def method(self):\n        return '{{name}}'\n`,
  go: `// {{path}}\npackage {{pkg}}\n\nfunc {{name}}() string {\n    return "{{name}}"\n}\n\ntype {{className}} struct {}\n\nfunc (c *{{className}}) Method() string {\n    return "{{name}}"\n}\n`,
  rs: `// {{path}}\npub fn {{name}}() -> String {\n    "{{name}}".to_string()\n}\n\npub struct {{className}};\n\nimpl {{className}} {\n    pub fn method(&self) -> String {\n        "{{name}}".to_string()\n    }\n}\n`,
  java: `// {{path}}\npackage {{pkg}};\n\npublic class {{className}} {\n    public String {{name}}() {\n        return "{{name}}";\n    }\n}\n`,
}

/**
 * In-memory file watcher for benchmark testing.
 */
export class MemoryFileWatcher implements FileWatcher {
  private callback?: (event: FileChangeEvent) => void

  watch() {}
  onChange(cb: (event: FileChangeEvent) => void) {
    this.callback = cb
  }
  dispose() {}

  simulateChange(event: FileChangeEvent) {
    this.callback?.(event)
  }
}

/**
 * Generate a synthetic repository structure for benchmarking.
 * Returns { roots, files } where files is the list of all generated file paths.
 */
export async function generateBenchmarkRepo(
  baseDir: string,
  config: BenchmarkRepoConfig
): Promise<{ roots: string[]; files: string[] }> {
  const root = path.join(baseDir, config.name)
  const files: string[] = []

  await fs.mkdir(root, { recursive: true })

  // Create manifest files at root
  for (const lang of config.languages) {
    const manifestName = MANIFEST_FILES[lang]
    if (manifestName) {
      const template = TEMPLATE_FILES[manifestName]
      if (template) {
        const content = template.replace('{{name}}', `${config.name}-${lang}`)
        await fs.writeFile(path.join(root, manifestName), content)
        files.push(path.join(root, manifestName))
      }
    }
  }

  // Generate directory structure
  const dirs = generateDirStructure(config.fileCount, config.depth)

  for (const dir of dirs) {
    const fullDir = path.join(root, dir)
    await fs.mkdir(fullDir, { recursive: true })

    if (config.includeVendor && dir.includes('vendor')) {
      await fs.mkdir(path.join(fullDir, 'vendor'), { recursive: true })
    }
    if (config.includeGenerated && dir.includes('generated')) {
      await fs.mkdir(path.join(fullDir, 'generated'), { recursive: true })
    }
    if (config.includeTests && dir.includes('test')) {
      await fs.mkdir(path.join(fullDir, '__tests__'), { recursive: true })
    }
  }

  // Generate files across directories
  let filesCreated = 0
  for (const dir of dirs) {
    if (filesCreated >= config.fileCount) break

    const filesInDir = Math.min(5, config.fileCount - filesCreated)
    for (let i = 0; i < filesInDir; i++) {
      const lang = config.languages[Math.floor(Math.random() * config.languages.length)]
      const ext = LANGUAGE_EXTENSIONS[lang]?.[0] || '.txt'
      const fileName = `${dir.replace(/\//g, '-')}-${i}${ext}`
      const fullPath = path.join(root, dir, fileName)

      const template = SOURCE_TEMPLATES[lang] || SOURCE_TEMPLATES.ts
      const content = template
        .replace(/{{path}}/g, path.join(dir, fileName))
        .replace(/{{name}}/g, `${dir.replace(/\//g, '-')}-${i}`)
        .replace(/{{className}}/g, `${dir.replace(/\//g, '-')}-${i}`.replace(/-/g, '').replace(/\b\w/g, c => c.toUpperCase()))
        .replace(/{{pkg}}/g, dir.replace(/\//g, '.'))

      await fs.writeFile(fullPath, content)
      files.push(fullPath)
      filesCreated++
    }
  }

  return { roots: [root], files }
}

function generateDirStructure(fileCount: number, maxDepth: number): string[] {
  const dirs = new Set<string>([''])
  const targetDirs = Math.min(Math.max(10, fileCount / 20), 500)

  while (dirs.size < targetDirs) {
    const depth = Math.floor(Math.random() * maxDepth) + 1
    let current = ''
    for (let d = 0; d < depth; d++) {
      const segment = randomDirName()
      current = current ? path.join(current, segment) : segment
      dirs.add(current)
    }
  }

  if (fileCount > 1000) {
    dirs.add('vendor')
    dirs.add('vendor/library1')
    dirs.add('vendor/library2')
    dirs.add('generated')
    dirs.add('generated/api')
    dirs.add('__tests__')
    dirs.add('test')
    dirs.add('tests')
  }

  return [...dirs].filter(d => d !== '').sort()
}

function randomDirName(): string {
  const prefixes = ['src', 'lib', 'pkg', 'app', 'internal', 'api', 'core', 'utils', 'services', 'components', 'modules', 'handlers', 'models', 'views', 'controllers', 'middleware', 'config', 'scripts', 'tools', 'cli', 'cmd']
  return prefixes[Math.floor(Math.random() * prefixes.length)]
}

/**
 * Run benchmark for a single configuration.
 */
export async function runBenchmark(config: BenchmarkRepoConfig, baseDir: string): Promise<BenchmarkResult> {
  const { roots, files } = await generateBenchmarkRepo(baseDir, config)

  const storageDir = path.join(baseDir, '.benchmark-storage', config.name)
  await fs.mkdir(storageDir, { recursive: true })

  const watcher = new MemoryFileWatcher()
  const indexPath = path.join(storageDir, 'index.json')

  const catalog = new IncrementalFileCatalog(roots, {
    indexPath,
    watcher,
    maxEntries: config.fileCount * 2,
    log: (msg) => console.log(`[${config.name}] ${msg}`),
  })

  const summariesDir = path.join(storageDir, 'summaries')
  const summaryService = new SummaryService({
    storageDir: summariesDir,
    modelProvider: new NoOpSummaryProvider(),
    log: (msg) => console.log(`[${config.name}] ${msg}`),
  })

  const index = new RepositoryIndex({
    roots,
    workspace: createWorkspaceDescriptor(config.name, roots),
    storageUri: { fsPath: storageDir } as any,
    repositoryVersion: `bench:${config.name}:${Date.now()}`,
    summaryModelProvider: new NoOpSummaryProvider(),
    log: (msg) => console.log(`[${config.name}] ${msg}`),
  })

  // Replace internals for direct benchmark control
  ;(index as any).catalog = catalog
  ;(index as any).summaryService = summaryService

  const startTime = Date.now()
  await index.initialize()
  const initTime = Date.now() - startTime

  const stats = index.stats()

  // Test incremental updates (simulate 100 file changes)
  const updateStart = Date.now()
  for (let i = 0; i < 100; i++) {
    const file = files[Math.floor(Math.random() * files.length)]
    watcher.simulateChange({ type: 'change', absolutePath: file, root: roots[0] })
  }
  await new Promise(r => setTimeout(r, 500)) // wait for debounced saves
  const updateTime = Date.now() - updateStart

  // Test progressive narrowing
  const narrowingStart = Date.now()
  await index.getWorkspaceRootsOverview()
  await index.getPackageTopology()
  const modules = await index.getModules('src')
  if (modules.samples.length > 0) {
    await index.getFiles(modules.samples[0].label)
  }
  const narrowingTime = Date.now() - narrowingStart

  catalog.dispose()

  return {
    config,
    initTimeMs: initTime,
    updateTimeMs: updateTime,
    narrowingTimeMs: narrowingTime,
    totalEntries: stats.totalEntries,
    truncated: stats.truncated,
    fileSummaries: stats.fileSummaries,
    moduleSummaries: stats.moduleSummaries,
  }
}

export interface BenchmarkResult {
  config: BenchmarkRepoConfig
  initTimeMs: number
  updateTimeMs: number
  narrowingTimeMs: number
  totalEntries: number
  truncated: boolean
  fileSummaries: number
  moduleSummaries: number
}

export async function runAllBenchmarks(baseDir: string = '/tmp/charter-ai-benchmarks'): Promise<BenchmarkResult[]> {
  const results: BenchmarkResult[] = []

  for (const config of BENCHMARK_CONFIGS) {
    console.log(`\n=== Benchmark: ${config.name} ===`)
    try {
      const result = await runBenchmark(config, baseDir)
      results.push(result)
      console.log(`  Init: ${result.initTimeMs}ms`)
      console.log(`  Update (100 files): ${result.updateTimeMs}ms`)
      console.log(`  Narrowing: ${result.narrowingTimeMs}ms`)
      console.log(`  Entries: ${result.totalEntries} (truncated: ${result.truncated})`)
    } catch (err) {
      console.error(`  FAILED: ${err}`)
    }
  }

  return results
}
