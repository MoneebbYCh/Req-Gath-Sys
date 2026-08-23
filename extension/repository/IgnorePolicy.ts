/**
 * Ignore / deprioritization policy (plan §10): build output, VCS internals,
 * and dependency folders are excluded from the default catalog; vendor and
 * generated content stays visible but flagged so tools can deprioritize it.
 */

/** Glob patterns excluded from catalog walks. */
export const EXCLUDED_GLOBS = [
  '**/.git/**',
  '**/node_modules/**',
  '**/.next/**',
  '**/dist/**',
  '**/build/**',
  '**/coverage/**',
  '**/target/**',
  '**/out/**',
]

export type FileFlag = 'vendor' | 'test' | 'config' | 'generated' | 'build' | 'binary'

const TEST_PATTERNS = [
  /(^|\/)(test|tests|spec|__tests__)(\/|$)/,
  /\.(test|spec)\.[^.]+$/,
  /[._-](test|spec)\.[^.]+$/,
]

const CONFIG_EXTENSIONS = new Set(['json', 'yaml', 'yml', 'toml', 'ini', 'conf', 'config'])

const GENERATED_PATTERNS = [
  /\.d\.ts$/,
  /\.min\.[^.]+$/,
  /\.generated\./,
  /\.pb\.(go|ts|js)$/,
  /\.g\.dart$/,
  /\.gen\./,
]

const BUILD_DIRS = [
  /(^|\/)(dist|build|out|coverage|target|\.next)(\/|$)/,
]

const BINARY_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'ico', 'webp', 'svg', 'bmp', 'tiff',
  'pdf', 'zip', 'gz', 'tar', '7z', 'rar',
  'woff', 'woff2', 'ttf', 'otf', 'eot',
  'mp3', 'mp4', 'wav', 'mov', 'avi', 'webm',
  'exe', 'dll', 'so', 'dylib', 'bin', 'class', 'jar', 'wasm',
  'lockb', 'pyc', 'pyo',
])

export function classifyFlags(relPath: string): FileFlag[] {
  const flags: FileFlag[] = []
  const normalized = relPath.replace(/\\/g, '/')
  const base = normalized.split('/').pop() ?? ''

  if (/(^|\/)(vendor|vendors|third_party|third-party)(\/|$)/.test(normalized)) {
    flags.push('vendor')
  }
  if (TEST_PATTERNS.some((re) => re.test(normalized))) flags.push('test')
  const ext = base.includes('.') ? base.split('.').pop()!.toLowerCase() : ''
  if (CONFIG_EXTENSIONS.has(ext) || base.startsWith('.')) flags.push('config')
  if (GENERATED_PATTERNS.some((re) => re.test(base))) flags.push('generated')
  if (BUILD_DIRS.some((re) => re.test(normalized))) flags.push('build')
  if (BINARY_EXTENSIONS.has(ext)) flags.push('binary')
  return flags
}

/** Extension → language id (heuristic; LSP-aware mapping lands Phase 6). */
const EXTENSION_LANGUAGE: Record<string, string> = {
  ts: 'typescript', tsx: 'typescriptreact', js: 'javascript', jsx: 'javascriptreact',
  py: 'python', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin', cs: 'csharp',
  rb: 'ruby', php: 'php', swift: 'swift', c: 'c', cpp: 'cpp', h: 'c', hpp: 'cpp',
  json: 'json', yaml: 'yaml', yml: 'yaml', toml: 'toml', md: 'markdown',
  html: 'html', css: 'css', scss: 'scss', sh: 'shell', sql: 'sql', tf: 'terraform',
  vue: 'vue', svelte: 'svelte', dart: 'dart', lua: 'lua', r: 'r', scala: 'scala',
  proto: 'proto', graphql: 'graphql', gql: 'graphql',
}

export function languageFor(relPath: string): string | undefined {
  const base = relPath.split('/').pop() ?? ''
  const ext = base.includes('.') ? base.split('.').pop()!.toLowerCase() : ''
  return EXTENSION_LANGUAGE[ext]
}
