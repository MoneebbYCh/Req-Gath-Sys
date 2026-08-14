# Charter Ai — UX, Product & Feature Audit (v2)

**Scope:** full source of `CharterAi` — `extension/` (host), `src/` (webview), `reference/legacy-pipeline/` (archived), top-level docs, `.github/workflows/`. Every claim traces to a specific file/line. This v2 document **verifies the prior audit** (`Charter-Ai-UX-Product-Audit.md`), **corrects its inaccuracies**, and adds **new findings** the prior audit missed.

**Verdict legend:** ✅ CONFIRMED · ⚠️ PARTIALLY CONFIRMED (corrected below) · ❌ NOT CONFIRMED / WRONG

---

## Part 1 — Verification of the prior audit

### 1.1 Claims verified ✅

| # | Prior audit claim | Verdict | Evidence |
|---|---|---|---|
| V1 | Docs (README/ARCHITECTURE/CONTRIBUTING/PITCH) describe an app that no longer exists | ✅ CONFIRMED | `ARCHITECTURE.md` diagrams `ProjectCharterPage`, `PrdCreationPage`, `useFormState.ts`, `codeIndexer.ts`, `pdfExportHandler.ts`, `fieldGuides.ts`, `codeContext.ts` — none exist in `src/` or `extension/`. `CONTRIBUTING.md:80` tells contributors to edit `extension/ai/fieldGuides.ts`; `CONTRIBUTING.md:17` references `codeIndexer.ts`. `PITCH.md:21` claims "calls VS Code's built-in LM API (Copilot)" and "PDF export — one-click" — neither is true (`llmClient.ts` uses the `openai` SDK; no PDF code exists anywhere). |
| V2 | Home starts empty; Ask bar + New Document; `doc-types.json` | ✅ | `HomePage.tsx`, `NewDocumentModal.tsx`, `formStateManager.ts` (`DOC_TYPES_FILE`). |
| V3 | BlockNote canvas with 6 custom blocks | ✅ | `schema.ts`, `blocks/` (Callout, Diagram, KpiGrid, RiskList, ScopeBounds, StakeholderTable). |
| V4 | ReAct agent, 8 tools | ✅ | `tools.ts` `TOOL_NAMES`. |
| V5 | OpenAI-compatible providers (DeepSeek default, Kimi, local) | ✅ | `llmClient.ts` `PROVIDERS`. |
| V6 | Only 3 commands; no "Configure Embeddings"; no `contributes.configuration` | ✅ | `package.json` `contributes.commands` (3 entries), no `configuration` block. |
| V7 | Singleton webview panel, ViewColumn.One, scoped CSP | ✅ | `extension.ts:130-156`, CSP built per-load. |
| V8 | `saveConfig()` exists, never called | ✅ | `formStateManager.ts:97`; grep shows zero callers. |
| V9 | Onboarding: auto-open Templates tab, one-time tutorial (localStorage flag), chat welcome mentions API key | ✅ | `PhaseCanvasPage.tsx:68-82` (`needsInitialTemplate`), `:96-105` (`TEMPLATE_TUTORIAL_BASE_KEY`), `useChat.ts:19-24` (WELCOME). |
| V10 | Only `chatMessage` wrapped in try/catch; fs failures → UI hangs silently | ✅ | `extension.ts:46-107`: `loadDocTypes`/`saveDocTypes`/`loadCanvas`/`saveCanvas` have no try/catch and no error message type exists in `protocol.ts` (no `error` variant at all). |
| V11 | Diagram validation retries 2×, degrades to warn callout | ✅ | `agent.ts:231-346` (`DIAGRAM_FIX_RETRIES = 2`, callout replacement with "never a canned fake diagram"). Nuance: see new finding N23 — the host-side "parse" is structural-first, so the gate is softer than it reads. |
| V12 | `safeInitialContent` block filtering + `CanvasErrorBoundary` reset | ✅ | `DocumentCanvas.tsx:33-69`, `CanvasErrorBoundary.tsx`. (It's a linear filter, not a true bisect — outcome equivalent.) |
| V13 | `window.alert`/`window.prompt` in Save-Template/Export silently no-op (**P0**) | ✅ | `PhaseCanvasPage.tsx:143,146,159`; panel created without `allowModals` (`extension.ts:137-146`). `prompt()` returns `null` → `if (!name || !name.trim()) return` fires → Save Template never saves; Export shows nothing. |
| V14 | No-workspace fallback to `extensionPath` (**P0**) | ✅ | `extension.ts:109-113` `workspaceRoot()`; `ensureWorkspaceFolder()` then `initWorkspace()` against it and posts `workspaceInfo` with that path. |
| V15 | Template apply = unconfirmed destructive click | ✅ | `PhaseCanvasPage.tsx:122-136` (`applyTemplate` direct), `TemplateGallery.tsx:91`; only passive inline warning (`TemplateGallery.tsx:83`). |
| V16 | No per-tool progress; `onStatus('Thinking…')` once | ✅ | `agent.ts:115`; `agentLoop.ts` never calls `onStatus` (it isn't even threaded into `AgentLoopArgs`). |
| V17 | Client timeout 180s, no correlation, late response appends after fake error | ✅ | `useChat.ts:32` (`TIMEOUT_MS`), `:127-137` timeout message, no request id in `protocol.ts`; server-side work can exceed 180s (15 iters × 180s each + 2 retries + diagram-fix calls, `agentLoop.ts:6`, `llmClient.ts:113`). |
| V18 | Deleting a doc orphans `.charter-ai/<id>.json` forever | ✅ | `HomePage.tsx:114-119` → `deleteDocType` (`documentTypes.ts:230-232`) only rewrites the list; no `deleteCanvas` in `protocol.ts`. **Worse than stated:** the agent's own `remove_pipeline_docs` has the same hole (`tools.ts:850-905`), and see N3 (resurrection). |
| V19 | No provider/model UI despite working `saveConfig()` | ✅ | Confirmed (V8) + `processChat` accepts `provider`/`model` args (`agent.ts:109-113`) but no caller ever passes them. |
| V20 | Pipeline scale not designed for (12-doc cap per call, no cumulative cap; Home grid no search; tab strip overflow) | ✅ | `tools.ts:27,791-793`; `HomePage.tsx:338-409`; `PipelineChrome.tsx:104-169` (`min-w-[160px]`, `overflow-x-auto`, no fade/arrows). |
| V21 | AI draft landing after navigating away is silent (no "saved to X" pointer) | ✅ | `usePhaseDocument.ts:120` phase guard + unmount removes listener; `agent.ts:187-192` appends pointer only when `targetDoc || phase === 'home'`. |
| V22 | Rename only via clicking the active tab, tooltip-only affordance | ✅ | `PipelineChrome.tsx:152-159`. |
| V23 | Duplicate display names possible; agent path dedupes, manual path doesn't | ✅ | `documentTypes.ts:209-222` (`createDocType` no name check); `tools.ts:929-934` (append dedupe). |
| V24 | Structured blocks render out-of-vocab values as "—" and silently replace on edit | ❌ **CORRECTED** — see Part 2. |
| V25 | Profile: dummy account, hardcoded "Today · 9:41 AM", data never used by AI | ✅ | `ProfilePage.tsx:98`; `agent.ts`/`agentLoop.ts`/`tools.ts` have zero `profile` references; `profile.ts` key not workspace-scoped. |
| V26 | No `prefers-reduced-motion` handling; dialogs have role/aria-modal/Escape | ✅ | Grep: zero matches for reduced-motion. Dialogs (`ConfirmDialog`, `BlockEditDialog`, `NewDocumentModal`) have role/aria/Escape. (Focus trap/restore absent — N18.) |
| V27 | Tool caps (50/50/2000/12000) surfaced into context | ✅ | `tools.ts:22-29`, cap warnings in observations. |
| V28 | `MAX_ITERS = 15` | ✅ | `agentLoop.ts:6`. |
| V29 | 180s LLM timeout, 2 retries | ✅ | `llmClient.ts:113`. |
| V30 | No caching of repeated grep/read within a run | ✅ | `tools.ts` — every call re-executes; system prompt doesn't forbid re-reads. |
| V31 | CI = only tag-triggered publish; no PR workflow | ✅ | `.github/workflows/publish.yml` (tags `v*` + `workflow_dispatch`; no PR-triggered lint/build/test). Also: **zero test files in the repo** (no `*.test.*`/`*.spec.*` anywhere). |
| V32 | localStorage workspace-scoped (FNV-1a prefix), legacy-key leak fixed | ✅ | `workspaceScope.ts`, `usePhaseDocument.ts:33-35` comment. |
| V33 | "Configure Embeddings" command missing despite README | ✅ | README:109-110 instructs it; no such command in `package.json` or `extension.ts`. |
| V34 | Delete confirmation copy "no longer reachable" but data remains | ✅ | `HomePage.tsx:432`; `deleteDocType` (see V18). |
| V35 | Mermaid "hard gate" praised | ⚠️ Nuanced | See N23: `parseMermaid` accepts anything that passes structural checks even when `mermaid.parse` fails (`mermaidValidate.ts:175-187`). The *intent* is right; the gate is softer than "hard." |

### 1.2 Prior-audit inaccuracies (corrections)

1. **V24 (structured-block coercion) — mechanism is wrong, conclusion is half-right.** `RiskList.tsx:13-19` / `StakeholderTable.tsx:13-19`: `normalizeLevel('Critical')` returns `'Critical'` (only *empty* values become `'—'`), and the view renders it as-is via `levelLabel`. In the edit dialog the `<select>` gets a value that matches no `<option>` (`RiskList.tsx:144-153`) — so the dropdown shows **blank** (not silently replaced), and the draft array still holds the raw string, which **is** preserved on Save. The real warts: (a) blank/ambiguous dropdown display for out-of-vocab values, (b) unknown levels get no severity color (`rg-level--critical` class exists but has no styling), (c) no signal to the user that the value is non-standard. `KpiGrid`/`ScopeBounds`/`Callout` were not line-by-line re-verified (same caveat the prior audit itself stated).
2. **"Rename/delete/**reorder**" tiles (§1.2 of prior audit) — reorder does not exist.** `moveDocType` (`documentTypes.ts:235-243`) has **zero callers**; no UI exposes it. Only rename + delete exist.
3. **V11 "hard-gated" phrasing** — see N23.
4. Minor: prior audit's §1.12 "each backed by an LLM call with its own 180s timeout" is accurate; the *client-side* 180s total (`useChat.ts`) is the mismatched one — prior audit's framing of the race is correct.

---

## Part 2 — NEW findings (not in the prior audit)

### N1 — P1 · Data loss: edits made within 500 ms of navigating away are silently dropped
- **Why:** typing → `setBlocks` → debounced `persist` (500 ms, `usePhaseDocument.ts:68-74`). Navigating (tab click in `PipelineChrome.tsx:157`, Home, Profile) either unmounts the page (timer cleanup clears the pending save) or re-mounts state from storage before the timer fires.
- **Current:** silent loss; the "Saving…" label never even appears because `isDirty` state is discarded with the component.
- **Fix:** `flush()` pending changes on unmount (persist in a cleanup effect), or move the debounce to the extension side; also call `saveNow()` on tab switch. Priority: **P1** (data loss).

### N2 — P2 · Data loss: `loadCanvas` response can clobber in-progress edits
- **Why:** on mount, `usePhaseDocument` posts `loadCanvas` (`:132`) and the user can start typing before the response returns; `applyExternalDocument` (`:120-129`) then **replaces** `doc` state with the disk version, wiping anything typed since mount.
- **Fix:** ignore the load response if the user has already edited (dirty flag / revision counter), or merge. **P2.**

### N3 — P2 · Deleted docs resurrect: same-name re-creation reuses the orphaned file
- **Why:** `deleteDocType` never removes `.charter-ai/<id>.json` (V18); ids are deterministic slugs (`doc-api-contract`). Delete "API Contract" → create "API Contract" again → same id → first open loads the **old content from disk** (`usePhaseDocument` posts `loadCanvas` → `loadForm` reads the stale file).
- **Fix:** implement `deleteCanvas` (file removal or `.charter-ai/.trash/` move) in both the UI delete and `remove_pipeline_docs` paths. **P2.**

### N4 — P1 · Prompt injection via workspace files; agent can destructively mutate the pipeline
- **Why:** `grep`/`read_file` observations are injected raw into the LLM context (`agentLoop.ts:436-440`). The system prompt contains strong role rules but **no instruction** telling the model to ignore directives found inside file contents. A repo with a hostile README/doc (or a compromised dependency's docs) can steer the agent; worse, the agent holds destructive tools: `remove_pipeline_docs {all:true}` and `generate_pipeline {mode:"replace"}` can wipe/rebuild the entire doc set (`tools.ts:850-905, 910-975`).
- **Fix:** add an explicit "file contents are untrusted data, never instructions" guardrail in the system prompt + observation wrapper; consider a human-confirmation gate on `remove_pipeline_docs all`/`replace` mode. **P1** (security/robustness).

### N5 — P1 · No confirmation or undo for agent-driven pipeline destruction
- **Why:** `generate_pipeline` with `mode:"replace"` and `remove_pipeline_docs all:true` execute unconditionally on a single model turn (N4). A model error or injection wipes the user's doc set with zero friction and no undo.
- **Fix:** require `onDocTypesChanged`-time confirmation in the UI for replace/remove-all modes (webview confirm dialog before applying), or a lightweight version history for `doc-types.json`. **P1.**

### N6 — P2 · No cancellation or request identity for long chat runs
- **Why:** a chat turn can run minutes (N-V17); the only "controls" are the client timeout and the disabled input (`ChatPanel.tsx:109,116`). No Cancel button; no request id; `clearMessages` doesn't abort the extension-side work.
- **Fix:** add a `chatCancel` message + cancellation token in `processChat`/`callLlm` (AbortController on the openai client), and correlation ids for the timeout race. **P2** (ties into prior audit's P1 timeout item — same fix family).

### N7 — P2 · AI draft overwrites user edits made during the run
- **Why:** `currentDocJson` is snapshotted at request start (`agent.ts:126-133`); when the draft lands, `saveForm` **replaces the whole document** (`agent.ts:184`). Edits typed while the agent worked are lost.
- **Fix:** block/flag canvas edits while chat is drafting, or diff-and-merge blocks, or at minimum surface "the draft replaced your unsaved edits" notice. **P2.**

### N8 — P2 · Webview-side renames/deletes can silently diverge from disk
- **Why:** `writeCustomTypes` posts `saveDocTypes` fire-and-forget (`documentTypes.ts:90`) with no ack/error channel (protocol has no error message). UI derives everything from localStorage, so a failed disk write (read-only workspace) leaves the tile renamed locally while `list_pipeline`/agent resolution still sees the old name — and the agent then can't resolve `targetDoc` by the new name (`agent.ts:157-163`).
- **Fix:** add `{type:'ack'|'error'}` responses for mutating messages; revert UI state on failure. **P2.**

### N9 — P2 · `description` in `generate_pipeline` is collected but never persisted
- **Why:** `parsePipelineDocs` keeps `description` (`tools.ts:802-804`), then `created.push({id, name, icon, createdAt, order})` **drops it** (`tools.ts:938-946`); `StoredCustomDocType` has no description field and the webview never shows one. User intent ("add a migration runbook and API contract") is partially wasted.
- **Fix:** persist `description` and show it on Home tiles (subtitle). **P3** effort / **P2** value.

### N10 — P3 · Dead code: `moveDocType` and `deleteUserTemplate` have no UI
- `moveDocType` (`documentTypes.ts:235`) — no reorder UI exists (correction to prior audit §1.2).
- `deleteUserTemplate` (`docTemplates.ts:97`) — saved templates can be created but **never deleted** from the Templates tab.
- **Fix:** expose reorder (up/down on tile menu or drag) and a per-template delete; or delete the dead exports. **P3.**

### N11 — P3 · Profile page ships fake, non-wired controls
- `ProfilePage.tsx:185-201`: "Show CRT scanlines" and "Auto-save canvas drafts" checkboxes look functional but do nothing (defaultChecked, no state wiring); "Email me when a gate is ready" is at least labeled "(not wired)". The hardcoded "Last login: Today · 9:41 AM" (`:98`) degrades trust in a page that otherwise says "Dummy account."
- **Fix:** wire the two real toggles (scanlines is trivial CSS; auto-save already exists as the default behavior) or replace the section with honest placeholder copy. **P3.**

### N12 — P3 · API-key management UX gaps
- `promptForApiKey` (`apiKeyManager.ts:34`) pre-fills `'••••••••'` — the user cannot see/edit their key (typing replaces it, but the masked value is misleading); `clearApiKey` exists but **no command** exposes it; there's no key-status indicator anywhere in the UI (Home could show "API key not configured" inline).
- **Fix:** placeholder-only input + "Clear key" command + Home status chip. **P3.**

### N13 — P3 · Chat history leaks across documents
- `useChat` is app-global (AppShell-level) and `buildHistoryPayload` includes turns from other phases (`useChat.ts:34-43`). Chatting on doc A then doc B sends A's context into B's drafting, with no indication. Possibly intended as "short-term memory" — if so, document it; otherwise scope history per phase. **P3.**

### N14 — P3 · Raw SDK errors surface as chat bubbles
- `extension.ts:99-103` posts `Error: ${errorMsg}` with the raw message (e.g. 400 from a mistyped `config.json` model, API timeout internals). No friendly mapping, no "check your config/API key" hints beyond the missing-key case (`llmClient.ts:116-123`).
- **Fix:** error-class mapping in `llmClient`/`extension.ts` → user-readable messages. **P3.**

### N15 — P3 · Editor remount wipes BlockNote undo history after every external apply
- `editorKey={`${phaseId}-${externalRevision}`}` (`PhaseCanvasPage.tsx:232`, `DocumentCanvas.tsx:151-153`) remounts the whole editor on each AI draft/template apply → Ctrl+Z history lost, selection lost.
- **Fix:** only remount on phase change; use `replaceBlocks` (which already exists) for external updates. **P3.**

### N16 — P3 · Accessibility gaps beyond the prior audit
- Tools sidebar tabs use `role="tab"` without `aria-controls`/arrow-key navigation (`CanvasToolsSidebar.tsx:102-132`); dialogs have no focus trap or focus restore; no `prefers-reduced-motion` (prior audit noted). Mermaid render errors use `role="alert"` (good). **P3.**

### N17 — P3 · No keyboard shortcut / status-bar entry point
- Chat panel, Home ask bar, and New Document have no keybindings and no status-bar item; the only entry is the command palette. **P3.**

### N18 — P3 · `.charter-ai/` is not gitignored automatically
- The extension creates `.charter-ai/` in the workspace root (`initWorkspace`); nothing suggests adding it to `.gitignore`, so generated docs (and possibly API-free config) can be committed accidentally. **P3.**

### N19 — P3 · Corrupt `doc-types.json` silently diverges
- `readJson` returns `null` on parse failure (`formStateManager.ts:54-62`) → `loadDocTypes` returns `[]`; webview keeps its localStorage copy (merge adds nothing), so the AI's `list_pipeline`/append dedupe sees an empty disk list and **re-creates duplicate docs with new ids** (`tools.ts:920-935`). **P3.**

### N20 — P3 · Non-atomic JSON writes
- `writeJson` (`formStateManager.ts:64-69`) writes directly; a crash mid-write corrupts the file → next `loadForm` returns `null` → canvas appears empty. Temp-file + rename is a one-line change with `vscode.workspace.fs`. **P3.**

### N21 — P3 · Home "Active draft on disk" indicator is stale after Home-chat drafts
- `hasDraft` derives from localStorage (`HomePage.tsx:77-80` + `loadSavedDoc`), but AI drafts from Home chat save to disk and only reach localStorage via a `loadCanvas` the Home page never receives → banner doesn't appear though drafts exist on disk. **P3** (ties to prior audit's dual-persistence finding).

### N22 — P3 · ripgrep `maxBuffer` overflow silently truncates
- `execFileAsync` maxBuffer 2 MB (`tools.ts:496`); on overflow the error carries partial stdout, which the catch parses as if complete (`tools.ts:501-510`) — no truncation warning to the model. Edge case on huge repos. **P3.**

### N23 — ⚠️ Nuance to prior audit's praise: the Mermaid "hard gate" is structural-first
- `parseMermaid` (`mermaidValidate.ts:148-194`): when `mermaid.parse` throws in the host (missing DOM), the **structural check alone passes the diagram**. Real syntax errors can therefore reach the canvas, where `MermaidRenderer.tsx:47-57` shows an inline error box (good fallback) — but the "validated before commit" claim is weaker than advertised. Recommend: keep host validation as-is, but surface the renderer error state more visibly (callout) and/or run a second validation pass in the webview before render. **P3.**

---

## Part 3 — What's already well-designed (confirmed, do not "fix")

- **Diagram degradation pipeline** (`agent.ts:231-346`): retry → warn callout, never a fake diagram.
- **Canvas crash resilience** (`DocumentCanvas.safeInitialContent`, `CanvasErrorBoundary` reset).
- **Workspace-scoped storage** (`workspaceScope.ts`) + phase-matched `loadCanvas` guard.
- **Tool-context discipline** (`tools.ts`): caps, "zero hits ≠ absent", citation rules, budget warnings (`agentLoop.ts:428-435`).
- **Robust JSON recovery** (`agentLoop.ts` `parseStep`/soft repair, `safeChatMessage` never dumps protocol JSON into chat).
- **ChatPanel basics**: input disabled while typing, typing dots + status text, auto-scroll, aria-labels.
- **ConfirmDialog discipline** on Reset/Delete flows (the one gap — template replace — is already listed).
- **Activation UX**: Ask bar + hint chips, empty-state copy, "Resume Documents"/"Active draft on disk" (modulo N21 staleness), save-label feedback ("Saving…/Saved HH:MM").

---

## Part 4 — Updated prioritized roadmap

| Phase | Item | User impact | Effort | Why |
|---|---|---|---|---|
| **P0 (do first)** | Fix `window.alert`/`window.prompt` (Save Template + Export) with real dialogs; ship Markdown export or remove the button | High | Low | Two advertised features are silently dead (V13) |
| **P0** | No-workspace-folder state: stop writing into `extensionPath`; show "Open a folder" empty state | High | Low | Data-safety (V14) |
| **P0** | Correct README/ARCHITECTURE/CONTRIBUTING/PITCH to the shipped product | High | Low-Med | Misleads every contributor (V1) |
| **P1** | N1: flush pending edits on navigation (data loss) | High | Low | Silent edit loss |
| **P1** | N4/N5: prompt-injection guardrail + confirmation gate on pipeline replace/remove-all | High | Med | Agent can wipe doc set on one bad turn |
| **P1** | Per-tool chat progress via existing `onStatus` (V16) | High | Low | Wiring exists |
| **P1** | Timeout reconciliation + request ids + Cancel (V17, N6) | Med-High | Med | False failures confuse |
| **P1** | N2: don't clobber in-progress edits on `loadCanvas` | High | Low | Data loss |
| **P1** | Confirm-before-replace on template apply (V15) | Med | Low | Reuses `ConfirmDialog` |
| **P2** | N3/N9: real delete (`deleteCanvas` + trash) on UI **and** agent paths | Med | Low | Orphans + resurrection |
| **P2** | N8: error/ack channel for `saveDocTypes`/`saveCanvas`; revert UI on failure | Med | Low-Med | UI/disk drift |
| **P2** | N7: guard against AI draft overwriting concurrent edits | Med | Med | Data loss |
| **P2** | Provider/model settings UI via existing `saveConfig()` (V19) | Med | Low | Backend done |
| **P2** | Feed profile into the AI system prompt (V25) | Med | Low | Cheapest on-strategy feature |
| **P2** | Home search/filter + tab-strip overflow affordance (V20) | Med | Med | Scale |
| **P2** | "Saved elsewhere" notice (V21) | Med | Low | Navigation confusion |
| **P2** | Version history/restore for canvas docs + `doc-types.json` (feeds N5) | Med-High | Med | Removes biggest loss risk |
| **P3** | N10–N22 cleanup batch (dead code, profile checkboxes, key UX, a11y, gitignore, atomic writes, error mapping, remount undo loss, corrupt-file handling, rg buffer) | Low-Med | Low each | Listed above with fixes |
| **Strategic** | Multi-doc generation progress UI · web-access tool (last, per team's own reasoning — agree) · MCP | Med-High | Large | Team sequencing is sound |

---

## Part 5 — Final assessment

**Top 10 UX problems (updated)**
1. `window.alert`/`window.prompt` no-ops → Save Template + Export dead (V13, P0).
2. No-workspace fallback writes into the extension's own install dir (V14, P0).
3. **N1: edits lost when navigating within 500 ms** (new, P1).
4. Template replace is one unconfirmed click, no undo (V15, P1).
5. No per-tool progress; long turns look frozen (V16, P1).
6. Client/server timeout mismatch → false "No response" errors, then the real answer arrives (V17, P1).
7. **N4/N5: agent can wipe/rebuild the pipeline with no confirmation, and repo files can steer it** (new, P1).
8. Deleted docs orphan files; same-name re-create resurrects old content (V18 + N3, P2).
9. No search/filter/overflow handling as the pipeline grows (V20, P2).
10. No provider/model UI, no key-status indicator, raw SDK errors in chat (V19, N12, N14, P2/P3).

**Top 10 features to add**
1. Real Markdown/PDF export (or remove the stub button).
2. Per-tool chat progress + cancel.
3. Provider/model settings UI (backend done).
4. Real delete with trash + version restore.
5. Profile-aware drafting (backend one hop away).
6. Pipeline-mutation confirmation gate (N5).
7. Home search/filter + tab overflow.
8. Command-palette/context-menu entry points ("Ask Charter Ai about this file").
9. Multi-doc generation progress (team's own roadmap item).
10. Saved-template management UI (delete exists in code, unreachable — N10).

**Top 5 technical/product risks affecting UX**
1. Documentation drift (V1) — costs every contributor and AI agent real time.
2. Silent failure paths in the host: no error channel for fs ops (V10) — UI hangs instead of reporting.
3. Dual persistence (localStorage cache + disk) — N1/N2/N3/N8/N19/N21 all live at this seam.
4. Unconfirmed destructive agent tools + prompt injection surface (N4/N5).
5. No tests and no PR CI — only tag-triggered publish (V31); regressions in this agentic surface will ship.

**Top 5 differentiation opportunities** (unchanged from prior audit, all verified): validated-diagram pipeline made visible; structured block catalog; capped/sandboxed retrieval discipline; multi-provider LLM story (needs the settings UI to be real); empty-Home + Ask activation pattern (needs progress + timeout fixes first).

**What should NOT be built:** web-access tool now (team's reasoning is sound); MCP now; account/auth; a second sync/persistence layer — the existing one is already the bug seam and should be *simplified*, not extended.

**The single most important improvement:** the three P0s (modal fixes, no-workspace state, docs) plus **N1's flush-on-navigate** — the only silent data-loss bug in the app and a two-line fix.

**30/60/90:** Days 1–30: P0s + N1 + N4/N5 guardrails + progress streaming + template confirmation. Days 31–60: timeout/cancel, settings UI, real delete + trash, error channel, profile wiring, N2 clobber guard. Days 61–90: export, version history, search/overflow, command-surface expansion, P3 cleanup batch.
