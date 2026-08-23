import { getVscodeApi } from '../utils/vscodeApi'
import { workspaceScopedKey } from '../utils/workspaceScope'

/**
 * Registry of pipeline document types for the open workspace.
 * Starts empty — docs are created via Ask / New Document.
 */

export interface DocumentTypeMeta {
  id: string
  number: number
  title: string
  kicker: string
  subtitle: string
  icon: string
  /** localStorage base key (workspace-scoped at read/write time). */
  storageKey: string
  /** Filename under .charter-ai/. */
  fileName: string
  /** Sort order across the whole pipeline. */
  order: number
  /** Pre-workspace-scoping localStorage key, migrated on first read. */
  legacyStorageKey?: string
  next?: { page: string; label: string }
}

/** Persisted shape of a user-defined document type. */
export interface CustomDocType {
  id: string
  name: string
  icon: string
  createdAt: number
  order: number
}

const CUSTOM_KEY = 'charter-ai-doc-types-v1'

/** Material-symbol names offered when creating a custom document. */
export const CUSTOM_DOC_ICONS = [
  'article',
  'draft',
  'checklist',
  'lightbulb',
  'flag',
  'campaign',
  'science',
  'handshake',
  'insights',
  'menu_book',
  'schema',
  'inventory_2',
]

// --- storage ---------------------------------------------------------------

function customTypesKey(): string {
  return workspaceScopedKey(CUSTOM_KEY)
}

function readCustomTypes(): CustomDocType[] {
  try {
    const raw = localStorage.getItem(customTypesKey())
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter(
        (v): v is CustomDocType =>
          v && typeof v === 'object' && typeof v.id === 'string' && typeof v.name === 'string',
      )
      .map((v, i) => ({
        id: v.id,
        name: v.name,
        icon: typeof v.icon === 'string' && v.icon ? v.icon : 'article',
        createdAt: typeof v.createdAt === 'number' ? v.createdAt : Date.now(),
        order: typeof v.order === 'number' ? v.order : i,
      }))
      .sort((a, b) => a.order - b.order)
  } catch {
    return []
  }
}

function writeCustomTypes(list: CustomDocType[]): void {
  const normalized = list.map((v, i) => ({ ...v, order: i }))
  try {
    localStorage.setItem(customTypesKey(), JSON.stringify(normalized))
  } catch {
    /* ignore storage errors */
  }
  // ponytail: local write only — mutations are extension-authoritative
  // commands now (plan §16.1); the extension pushes the snapshot back.
}

/** Merge disk-sourced custom types into local storage (adds ones we don't have). */
export function hydrateCustomTypesFromDisk(data: unknown): boolean {
  return applyCustomTypesFromDisk(data, 'merge')
}

/**
 * Apply custom doc types from the extension host.
 * - merge: add missing ids (startup hydrate)
 * - replace: overwrite the custom list (full sync)
 */
export function applyCustomTypesFromDisk(
  data: unknown,
  mode: 'merge' | 'replace' = 'merge',
): boolean {
  if (!Array.isArray(data)) return false

  const incoming = data
    .filter(
      (v): v is CustomDocType =>
        v && typeof v === 'object' && typeof v.id === 'string' && typeof v.name === 'string',
    )
    .map((v, i) => ({
      id: v.id,
      name: v.name,
      icon: typeof v.icon === 'string' && v.icon ? v.icon : 'article',
      createdAt: typeof v.createdAt === 'number' ? v.createdAt : Date.now(),
      order: typeof v.order === 'number' ? v.order : i,
    }))
    .sort((a, b) => a.order - b.order)

  if (mode === 'replace') {
    try {
      localStorage.setItem(customTypesKey(), JSON.stringify(incoming.map((v, i) => ({ ...v, order: i }))))
    } catch {
      return false
    }
    return true
  }

  const local = readCustomTypes()
  const known = new Set(local.map((v) => v.id))
  const toAdd = incoming.filter((v) => !known.has(v.id))
  if (toAdd.length === 0) return false
  const merged = [...local, ...toAdd].map((v, i) => ({
    id: v.id,
    name: v.name,
    icon: v.icon,
    createdAt: v.createdAt,
    order: i,
  }))
  try {
    localStorage.setItem(customTypesKey(), JSON.stringify(merged))
  } catch {
    return false
  }
  return true
}

// --- meta derivation -------------------------------------------------------

function customMeta(c: CustomDocType, index: number): DocumentTypeMeta {
  return {
    id: c.id,
    number: index + 1,
    title: c.name,
    kicker: 'Pipeline document',
    subtitle: 'Draft it in the canvas or with the AI chat.',
    icon: c.icon || 'article',
    storageKey: `charter-ai-${c.id}-v1`,
    fileName: `${c.id}.json`,
    order: index,
  }
}

/** All document types in the workspace pipeline (sorted). */
export function listDocumentTypes(): DocumentTypeMeta[] {
  return readCustomTypes().map(customMeta)
}

/** Alias for Home / header strip — same as listDocumentTypes. */
export function listPipelineDocumentTypes(): DocumentTypeMeta[] {
  return listDocumentTypes()
}

export function listCustomDocTypes(): CustomDocType[] {
  return readCustomTypes()
}

export function getDocumentType(id: string): DocumentTypeMeta | undefined {
  return listDocumentTypes().find((t) => t.id === id)
}

export function isDocumentTypeId(id: string): boolean {
  return listDocumentTypes().some((t) => t.id === id)
}

// --- mutations -------------------------------------------------------------

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
}

/** Build a collision-free, `doc-` prefixed id for a new document. */
function makeUniqueId(name: string, existing: CustomDocType[]): string {
  const base = `doc-${slugify(name) || 'document'}`
  const taken = new Set(existing.map((v) => v.id))
  if (!taken.has(base)) return base
  let n = 2
  while (taken.has(`${base}-${n}`)) n += 1
  return `${base}-${n}`
}

/**
 * Plan §16.1: the EXTENSION owns the canonical registry now. These functions
 * keep their signatures, apply an optimistic local update for snappiness, and
 * post a command; the extension's authoritative `loadDocTypes` snapshot wins
 * when it arrives.
 */
export function createDocType(name: string, icon = 'article'): DocumentTypeMeta {
  const trimmed = name.trim() || 'Untitled Document'
  const existing = readCustomTypes()
  const now = Date.now()
  const created: CustomDocType = {
    id: makeUniqueId(trimmed, existing),
    name: trimmed,
    icon,
    createdAt: now,
    order: existing.length,
  }
  writeCustomTypes([...existing, created])
  getVscodeApi()?.postMessage({ type: 'documentCreate', name: trimmed, icon })
  return customMeta(created, existing.length)
}

export function renameDocType(id: string, name: string): void {
  const trimmed = name.trim()
  if (!trimmed) return
  writeCustomTypes(readCustomTypes().map((v) => (v.id === id ? { ...v, name: trimmed } : v)))
  getVscodeApi()?.postMessage({ type: 'documentRename', id, name: trimmed })
}

export function deleteDocType(id: string): void {
  writeCustomTypes(readCustomTypes().filter((v) => v.id !== id))
  getVscodeApi()?.postMessage({ type: 'documentDelete', id })
}

/** Move a document up/down in the ordering. */
export function moveDocType(id: string, direction: -1 | 1): void {
  const list = readCustomTypes()
  const i = list.findIndex((v) => v.id === id)
  if (i === -1) return
  const j = i + direction
  if (j < 0 || j >= list.length) return
  const next = [...list]
  ;[next[i], next[j]] = [next[j], next[i]]
  writeCustomTypes(next)
  getVscodeApi()?.postMessage({ type: 'documentMove', id, from: i, to: j })
}
