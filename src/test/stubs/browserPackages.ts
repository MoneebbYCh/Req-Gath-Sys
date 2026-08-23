/**
 * Test-only stubs for browser-targeted packages that cannot be imported in Node
 * (mermaid, @blocknote/*). Vitest aliases these specifiers to this module so the
 * test pipeline never transforms the real packages. None of these stubs are
 * exercised by current tests (canvas UI is never rendered) — they only need to
 * satisfy imports at module load.
 */

export const BlockNoteView = () => null
export const useCreateBlockNote = () => ({})
export const SuggestionMenuController = () => null
export const getDefaultReactSlashMenuItems = () => []
export const createReactBlockSpec = () => () => ({ config: {}, implementation: {} })

export const BlockNoteEditor = class {}
export const BlockNoteSchema = { create: () => ({}) }
export const defaultBlockSpecs = {}
export const filterSuggestionItems = (items: unknown) => items
export const insertOrUpdateBlockForSlashMenu = () => {}

const mermaidStub = {
  initialize: () => {},
  parse: async () => undefined,
  render: async () => ({ svg: '' }),
}

export default mermaidStub
