import * as vscode from 'vscode'
import * as path from 'path'
import { LEGACY_STATE_DIR, STATE_DIR } from './brand'

const CONFIG_FILE = 'config.json'
const DOC_TYPES_FILE = 'doc-types.json'

/** Resolve the on-disk filename for any document id. */
function fileNameForPhase(phase: string): string | null {
  const safe = phase.replace(/[^a-zA-Z0-9._-]/g, '-').replace(/^-+|-+$/g, '')
  return safe ? `${safe}.json` : null
}

export interface LlmSettings {
  provider: string
  model: string | null
}

export interface WorkspaceConfig {
  llm: LlmSettings
}

function defaultConfig(): WorkspaceConfig {
  return {
    llm: { provider: 'deepseek', model: null },
  }
}

function primaryStateDir(workspaceRoot: string): string {
  return path.join(workspaceRoot, STATE_DIR)
}

function legacyStateDir(workspaceRoot: string): string {
  return path.join(workspaceRoot, LEGACY_STATE_DIR)
}

async function ensureDir(dir: string): Promise<void> {
  try {
    await vscode.workspace.fs.stat(vscode.Uri.file(dir))
  } catch {
    await vscode.workspace.fs.createDirectory(vscode.Uri.file(dir))
  }
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(vscode.Uri.file(target))
    return true
  } catch {
    return false
  }
}

async function readJson<T>(filePath: string): Promise<T | null> {
  try {
    const uri = vscode.Uri.file(filePath)
    const bytes = await vscode.workspace.fs.readFile(uri)
    return JSON.parse(new TextDecoder().decode(bytes)) as T
  } catch {
    return null
  }
}

async function writeJson(filePath: string, data: unknown): Promise<void> {
  await ensureDir(path.dirname(filePath))
  const uri = vscode.Uri.file(filePath)
  const bytes = new TextEncoder().encode(JSON.stringify(data, null, 2))
  await vscode.workspace.fs.writeFile(uri, bytes)
}

/** Prefer `.charter-ai/`; fall back to legacy `.req-gath-sys/` for reads. */
async function readStateJson<T>(workspaceRoot: string, filename: string): Promise<T | null> {
  const primary = await readJson<T>(path.join(primaryStateDir(workspaceRoot), filename))
  if (primary !== null) return primary
  return readJson<T>(path.join(legacyStateDir(workspaceRoot), filename))
}

export async function initWorkspace(workspaceRoot: string): Promise<boolean> {
  const dir = primaryStateDir(workspaceRoot)
  if (await pathExists(dir)) return false
  // Already initialized under the legacy folder counts as initialized.
  if (await pathExists(legacyStateDir(workspaceRoot))) return false
  await ensureDir(dir)
  const configPath = path.join(dir, CONFIG_FILE)
  if (!(await pathExists(configPath))) {
    await writeJson(configPath, defaultConfig())
  }
  return true
}

export async function loadConfig(workspaceRoot: string): Promise<WorkspaceConfig> {
  const data = await readStateJson<WorkspaceConfig>(workspaceRoot, CONFIG_FILE)
  if (data && typeof data === 'object') return data
  return defaultConfig()
}

export async function saveConfig(workspaceRoot: string, config: WorkspaceConfig): Promise<void> {
  await writeJson(path.join(primaryStateDir(workspaceRoot), CONFIG_FILE), config)
}

export async function loadForm(
  workspaceRoot: string,
  phase: string,
): Promise<unknown | null> {
  const filename = fileNameForPhase(phase)
  if (!filename) return null
  return readStateJson(workspaceRoot, filename)
}

export async function saveForm(
  workspaceRoot: string,
  phase: string,
  data: unknown,
): Promise<void> {
  const filename = fileNameForPhase(phase)
  if (!filename) throw new Error(`Unknown phase: ${phase}`)
  await writeJson(path.join(primaryStateDir(workspaceRoot), filename), data)
}

/** Document-type definitions for the workspace. */
export async function loadDocTypes(workspaceRoot: string): Promise<unknown[]> {
  const data = await readStateJson<unknown>(workspaceRoot, DOC_TYPES_FILE)
  return Array.isArray(data) ? data : []
}

export async function saveDocTypes(workspaceRoot: string, data: unknown): Promise<void> {
  await writeJson(path.join(primaryStateDir(workspaceRoot), DOC_TYPES_FILE), data)
}

/** Human-readable label for a document id from doc-types.json. */
export async function docLabelFor(workspaceRoot: string, phase: string): Promise<string | null> {
  const types = await loadDocTypes(workspaceRoot)
  const match = types.find(
    (t): t is { id: string; name: string } =>
      Boolean(t) && typeof t === 'object' && (t as { id?: unknown }).id === phase,
  )
  return match && typeof match.name === 'string' ? match.name : null
}
