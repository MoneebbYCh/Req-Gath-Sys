import * as vscode from 'vscode'
import * as path from 'path'
import { LEGACY_STATE_DIR, STATE_DIR } from './brand'

const DOC_TYPES_FILE = 'doc-types.json'

/** Resolve the on-disk filename for any document id. */
function fileNameForPhase(phase: string): string | null {
  const safe = phase.replace(/[^a-zA-Z0-9._-]/g, '-').replace(/^-+|-+$/g, '')
  return safe ? `${safe}.json` : null
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
  const alreadyPrimary = await pathExists(dir)
  const alreadyLegacy = await pathExists(legacyStateDir(workspaceRoot))
  if (!alreadyPrimary && !alreadyLegacy) await ensureDir(dir)
  await ensureCharterGitignore(dir)
  return !alreadyPrimary && !alreadyLegacy
}

/** Keep chat/session files local to the machine — docs stay commitable. */
async function ensureCharterGitignore(stateDir: string): Promise<void> {
  const gitignore = path.join(stateDir, '.gitignore')
  if (await pathExists(gitignore)) return
  await vscode.workspace.fs.writeFile(
    vscode.Uri.file(gitignore),
    new TextEncoder().encode('agent-session.json\n'),
  )
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

/** Remove a canvas file from `.charter-ai/` (and the legacy state dir if present). */
export async function deleteForm(workspaceRoot: string, phase: string): Promise<void> {
  const filename = fileNameForPhase(phase)
  if (!filename) return
  for (const dir of [primaryStateDir(workspaceRoot), legacyStateDir(workspaceRoot)]) {
    const target = path.join(dir, filename)
    if (await pathExists(target)) {
      await vscode.workspace.fs.delete(vscode.Uri.file(target))
    }
  }
}

/** Document-type definitions for the workspace. */
export async function loadDocTypes(workspaceRoot: string): Promise<unknown[]> {
  const data = await readStateJson<unknown>(workspaceRoot, DOC_TYPES_FILE)
  return Array.isArray(data) ? data : []
}

export async function saveDocTypes(workspaceRoot: string, data: unknown): Promise<void> {
  await writeJson(path.join(primaryStateDir(workspaceRoot), DOC_TYPES_FILE), data)
}
