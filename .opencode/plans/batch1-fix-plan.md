# Batch 1 Fix Plan — V13 + V14 + N1 (audit v2)

Fixes the three silent-failure P0/P1 issues from `charter-ai-ux-product-audit-v2.md`.
V1 (doc drift) is already done — the four markdown files were rewritten in the prior session.

## Understanding

1. **V13 (P0)** — `window.alert`/`window.prompt` no-op in the webview panel (no `allowModals`),
   so **Save Template** and **Export** are dead buttons. Decision: enable `allowModals`
   (keep the existing prompt) and implement a real **Markdown export**.
2. **V14 (P0)** — with no folder open, `workspaceRoot()` returns `context.extensionPath`
   (`extension.ts:109-113`), so persistence/chat writes into the install directory.
   Decision: return `null` when no folder, guard handlers, show a webview notice.
3. **N1 (P1, data loss)** — the 500 ms debounced save in `usePhaseDocument.ts:68-74` is
   cleared on unmount; edits typed <500 ms before navigating away are silently dropped.

## Scope (files that change)

| File | Change |
|---|---|
| `extension/extension.ts` | `allowModals: true` in panel options; `workspaceRoot()` → `string \| null`; guard `handleMessage` persistence/chat when `null`; add `exportMarkdown` case (save dialog + write); `workspaceInfo` gains `available: boolean` |
| `extension/protocol.ts` | Add `exportMarkdown` to `WebviewToExtensionMessage`; add `available` to `workspaceInfo` |
| `src/utils/exportMarkdown.ts` | **New** — pure `canvasToMarkdown(doc)` serializer for all block types |
| `src/hooks/usePhaseDocument.ts` | N1: flush pending dirty doc on debounce-cleanup (unmount/navigate) |
| `src/pages/PhaseCanvasPage.tsx` | `handleExport`: serialize current blocks → post `exportMarkdown` |
| `src/App.tsx` | Handle `available:false` → render Home with notice (no localStorage scope) |
| `src/pages/HomePage.tsx` | `noWorkspace` prop → notice empty state; disable New Document/Ask |

## Approach

### 1. Markdown export
- Serializer (pure, testable): headings → `#/##/###`; paragraph → text; bullets/numbered →
  `-`/`1.`; checkList → `- [ ]`; callout → blockquote with bold title; kpiGrid →
  `Metric \| Target \| Method` table; scopeBounds → "In scope"/"Out of scope" lists;
  stakeholderTable → `Name/Role \| Interest \| Influence \| Concern` table; riskList →
  `Risk \| Likelihood \| Impact \| Mitigation` table; diagram → ` ```mermaid ` fence with
  `props.code`. Inline content: extract `.text` from items; unknown blocks skipped.
- Extension handler: `showSaveDialog` (default `suggestedName.md` in workspace) →
  `workspace.fs.writeFile`; native `showErrorMessage` on failure, `showInformationMessage`
  on success.
- `handleExport` mirrors `handleSaveTemplate`'s source selection
  (`editor?.document` when present, else `blocks`), calls `saveNow()` first, and alerts
  (now functional) if the doc is empty — reuse `documentHasContent`.

### 2. No-workspace state
- `workspaceRoot()` returns `null`; `handleMessage` cases `loadDocTypes`/`saveDocTypes`/
  `loadCanvas`/`saveCanvas`/`chatMessage` early-return with a `chatStatus` notice when null.
- `loadWorkspaceInfo`: no folder → `postMessage({ type:'workspaceInfo', path:'', name:'',
  available:false })`; else existing payload + `available:true`.
- `App.tsx`: on `available:false`, `setScopeReady(true)` and pass `noWorkspace` to
  `HomePage` (no localStorage scope set → keys stay bare; extension writes nothing anyway).
- `HomePage`: when `noWorkspace`, render notice ("Open a folder to use Charter Ai") and
  hide New Document / Ask actions.
- `charter-ai.initializeWorkspace` already errors on `!ws` — keep.

### 3. N1 flush-on-navigate
- In `usePhaseDocument.ts`, replace the debounce cleanup `return () => clearTimeout(timer)`
  with: clear timer, then `if (isDirty) persist(docRef.current)`.
- `persist`'s setState calls after unmount are harmless no-ops in React 18+; the
  `saveCanvas` postMessage + localStorage write still land. Panel stays alive
  (`retainContextWhenHidden`), so the extension receives it.

## Steps (ordered)

1. `extension/protocol.ts` — add `exportMarkdown` + `available` field.
2. `src/utils/exportMarkdown.ts` — serializer (`canvasToMarkdown`).
3. `extension/extension.ts` — `allowModals`; `workspaceRoot(): string | null`; guards;
   `exportMarkdown` case; `workspaceInfo.available`.
4. `src/pages/PhaseCanvasPage.tsx` — `handleExport` → serialize + post message.
5. `src/hooks/usePhaseDocument.ts` — N1 flush.
6. `src/App.tsx` + `src/pages/HomePage.tsx` — no-workspace notice.
7. Verify: `npm run lint`, `npm run build`, manual F5 pass (no-folder notice; Save Template
   prompt works; Export writes `.md`; fast tab-switch preserves edits).

## Dependencies

3 before 4 (message type must exist before the webview posts it). 1–5 are otherwise
independent; 6 depends only on 1.

## Risks & edge cases

- **Serializer block-shape mismatch** → props accessed defensively, unknown blocks skipped,
  never throws (export degrades gracefully).
- **Export of empty doc** → alert via functional `window.alert` (documentHasContent guard).
- **`allowModals`** only affects this panel instance — no other surface changes.
- **N1 double-write** → `persist` clears `isDirty`, so the unmount flush fires at most once.
- **No-folder chat** → chat sends are dropped with a clear status line, not an error crash.

## Out of scope (next batches)

N2 loadCanvas clobber guard · N4/N5 injection guardrail + destructive-tool confirmation ·
N8 saveDocTypes ack channel · N7 AI-draft overwrite guard · V15 template-replace confirm ·
test infrastructure (manual verification only).
