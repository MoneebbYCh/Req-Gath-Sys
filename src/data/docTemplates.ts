import type { BlockNoteBlock } from '../types/document'
import {
  BLANK_TEMPLATE,
  type DocTemplate,
} from './docTemplateTypes'
import { workspaceScopedKey } from '../utils/workspaceScope'

/**
 * Template registry keyed by document type.
 * There are no hard-coded curated starters — every type gets the blank option
 * plus any templates the user saves (stored per type and workspace folder).
 *
 * Curated charter templates (PMBOK, Lean, Agile, Six Sigma) live under
 * reference/legacy-pipeline/ for lookup only.
 */

export type { DocTemplate, CharterTemplate } from './docTemplateTypes'
export { BLANK_TEMPLATE, CUSTOM_CHARTER_TEMPLATE, templateOutline } from './docTemplateTypes'

interface StoredUserTemplate {
  id: string
  name: string
  description?: string
  blocks: BlockNoteBlock[]
  createdAt: number
}

function userKey(typeId: string): string {
  return workspaceScopedKey(`charter-ai-user-templates-${typeId}-v1`)
}

function readUserStored(typeId: string): StoredUserTemplate[] {
  try {
    const raw = localStorage.getItem(userKey(typeId))
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (t): t is StoredUserTemplate =>
        t && typeof t === 'object' && typeof t.id === 'string' && Array.isArray(t.blocks),
    )
  } catch {
    return []
  }
}

function writeUserStored(typeId: string, list: StoredUserTemplate[]): void {
  try {
    localStorage.setItem(userKey(typeId), JSON.stringify(list))
  } catch {
    /* ignore storage errors */
  }
}

function toTemplate(stored: StoredUserTemplate): DocTemplate {
  return {
    id: stored.id,
    name: stored.name,
    category: 'Saved',
    tagline: 'A template you saved from an earlier draft.',
    description:
      stored.description ||
      'Your saved starting point. Applying it replaces the current document with this content.',
    // Deep-copy so applying never mutates the stored blocks.
    build: () => JSON.parse(JSON.stringify(stored.blocks)) as BlockNoteBlock[],
  }
}

/** User-saved templates for a document type (excludes the blank option). */
export function templatesForType(typeId: string): DocTemplate[] {
  return readUserStored(typeId).map(toTemplate)
}

/** All selectable options including the blank "Build from scratch" template. */
export function templateOptionsForType(typeId: string): DocTemplate[] {
  return [...templatesForType(typeId), BLANK_TEMPLATE]
}

export function resolveTemplate(typeId: string, id: string | undefined): DocTemplate | undefined {
  if (!id) return undefined
  return templateOptionsForType(typeId).find((t) => t.id === id)
}

/** Save the current document blocks as a reusable template for this type. */
export function saveUserTemplate(typeId: string, name: string, blocks: BlockNoteBlock[]): DocTemplate {
  const trimmed = name.trim() || 'Saved template'
  const stored: StoredUserTemplate = {
    id: `saved-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    name: trimmed,
    blocks: JSON.parse(JSON.stringify(blocks)) as BlockNoteBlock[],
    createdAt: Date.now(),
  }
  writeUserStored(typeId, [...readUserStored(typeId), stored])
  return toTemplate(stored)
}

export function deleteUserTemplate(typeId: string, id: string): void {
  writeUserStored(
    typeId,
    readUserStored(typeId).filter((t) => t.id !== id),
  )
}

export function isUserTemplate(typeId: string, id: string): boolean {
  return readUserStored(typeId).some((t) => t.id === id)
}
