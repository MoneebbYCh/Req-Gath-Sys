# Charter Ai — Product / UX / Feature Audit

**Date:** 2026-08-14 · **Scope:** entire VS Code extension codebase (`extension/`, `src/`, `reference/legacy-pipeline/`, docs, workflows) + `graphify-out/` relationship graph
**Method:** full read of all 60+ source files, extension host, webview, manifest, docs; cross-checked against the graphify report (752 nodes / 71 communities; "Chat & Document Processing", "Extension Host & IPC", "Canvas Editor & Insertions", "Agent Response Parsing" are the load-bearing communities)
**Basis for every claim:** specific file references. Where evidence was insufficient, it is flagged explicitly.

---

# 0. Executive Summary

Charter Ai is an **AI-assisted requirements-documentation pipeline inside VS Code**. Its actual, current implementation is:

- A **Home dashboard** (retro CRT / Mac OS 9 aesthetic) with an empty document pipeline that the AI agent populates on demand.
- A **BlockNote canvas editor** with structured requirement blocks (KPI grids, scope bounds, stakeholder tables, risk lists, callouts, Mermaid diagrams).
- A **single ReAct-style chat agent** (one loop, two personas: Home orchestrator vs. canvas drafter) with 8 tools (`list_dir`, `glob`, `grep`, `read_file`, `validate_mermaid`, `list_pipeline`, `generate_pipeline`, `remove_pipeline_docs`).
- **Local-first persistence**: workspace-scoped `localStorage` mirrored to `.charter-ai/*.json` in the repo (gitignored).
- 3 command-palette commands, no settings UI, no views, no keybindings, no tests, one placeholder Export button.

The engineering under the hood is unusually disciplined for an MVP (path-sandboxed tools, bounded observations, JSON recovery parsing, Mermaid validate-and-fix, workspace-scoped storage). The product layer is where the risk concentrates: **documentation claims features that no longer exist** (fixed 6-phase pipeline, forms, code indexer, embeddings, PDF export, Copilot LM API, gate reviews/signatures), the **Export button is a dead placeholder**, the agent can **replace an entire document with no undo**, and there is **no onboarding**.

This audit covers: current state (Section 1), UX issues (Section 2), feature gaps (Section 3), competitive landscape (Section 4), product opportunities (Section 5), a prioritized roadmap (Section 6), and a final assessment with a 30/60/90 plan (Section 7).

---

# 1. Understanding the Existing Extension

## 1.1 Purpose, target users, positioning

| | |
|---|---|
| **What it is** | AI-assisted requirements pipeline: ask the agent (in natural language), it reads the workspace, proposes a set of requirement docs, drafts them as structured canvas documents (charter, PRD, ADR, API contract…), and stores them in `.charter-ai/`. |
| **Intended purpose** (PITCH.md) | "Requirements that live where the code lives" — code-aware AI-assisted requirements gathering instead of documents rotting in Notion/Confluence. |
| **Target users** | PMs, tech leads, EM/architects working inside a repo; realistically the person who owns requirement docs in a dev team. |
| **Positioning reality** | Docs-as-code, AI-native requirements engineering inside VS Code. No fixed pipeline anymore — the pipeline is *dynamic* (Home starts empty; docs appear via Ask / New Document / `generate_pipeline`). |

**Critical finding — documentation drift.** The public-facing copy does not match the code:

- `package.json` description: *"AI-assisted requirements pipeline (Charter → PRD → System Design → Dev → QA → Post Dev)"* — that fixed 6-phase pipeline was **removed** (git log `6ba1863` "removed all previous static code…"; `reference/legacy-pipeline/README.md` archives it).
- `PITCH.md` claims 8-section forms, gate reviews, signatures, codebase indexer, PDF export, Copilot LM API — all removed or never existed in the current tree.
- `README.md` + `ARCHITECTURE.md` document `semantic_search`, embeddings sync, `code-index.json`, "Charter Ai: Configure Embeddings", and PDF export — **none of these exist** in code (git log `a83ecee` "removed sematic embedding code"). `TOOL_NAMES` in `extension/ai/tools.ts:115` contains no `semantic_search`; there is no `codeIndexer.ts` or `pdfExportHandler.ts` in `extension/`.
- The graphify report flagged the same mismatch as AMBIGUOUS edges (`llmClient.ts ↔ "MVP state (charter/PRD forms, indexer, chat, PDF, Mac OS 9 UI)"`).

This drift is not cosmetic: users who read the README (or the marketplace description) will look for features that error or do nothing, and the extension advertises a workflow (Charter → PRD → System Design → Dev → QA → Post Dev) that the UI no longer offers. **This is the highest-priority product fix because it destroys trust before first use.**

## 1.2 Architecture (what actually exists)

- **Webview** (`src/`): React 19 + Vite + Tailwind 4 + BlockNote (`@blocknote/*`) + Mantine + Mermaid. All UI lives in a single webview panel (`extension/extension.ts:137` `createWebviewPanel`), routed by `useViewState` (`src/hooks/useViewState.ts`) between `home`, `profile`, and document ids.
- **Extension host** (`extension/`): esbuild-bundled Node code. `extension.ts` is a thin message router; `formStateManager.ts` does JSON CRUD under `.charter-ai/`; `ai/agent.ts → ai/agentLoop.ts → ai/tools.ts → ai/llmClient.ts` is the agent pipeline.
- **IPC**: `postMessage` with a typed protocol (`extension/protocol.ts`): `loadCanvas/saveCanvas`, `loadDocTypes/saveDocTypes`, `loadWorkspaceInfo`, `chatMessage`, `chatResponse`, `chatStatus`, `workspaceInfo`, `navigateTo` (declared, unused by the router).
- **Persistence**: dual-write — workspace-scoped `localStorage` (FNV-1a hash of folder path, `src/utils/workspaceScope.ts`) + disk `.charter-ai/<id>.json` (gitignored). `usePhaseDocument` debounces saves 500 ms and mirrors to disk via `saveCanvas`; on mount it pulls from disk via `loadCanvas`.
- **LLM**: OpenAI-compatible SDK; providers `deepseek` (default, `deepseek-v4-flash`), `kimi`, `local` (Ollama) (`extension/ai/llmClient.ts:9`). Key resolution: SecretStorage → provider env var → generic env vars. Provider/model live in `.charter-ai/config.json` (hand-edited file; no settings contribution).
- **Agent**: single ReAct loop, up to 15 iterations, JSON-mode responses, tolerant parsing (fences, truncation recovery, field extraction — `agentLoop.ts:296` `parseStep`), budget warnings after 10 tool calls, Mermaid parse + up to 2 LLM fix retries with warn-callout fallback (`agent.ts:231` `validateAndFixDiagrams`).

## 1.3 Commands, menus, settings

| Surface | Reality |
|---|---|
| Commands | `charter-ai.openPipeline`, `charter-ai.initializeWorkspace`, `charter-ai.configureApiKey` (`package.json:17`) |
| Menus | commandPalette only (`package.json:32`) |
| Settings | **None.** No `contributes.configuration`, no keybindings, no views/activity bar, no status bar, no editor/explorer context menus, no icons in the Activity Bar |
| Activation | `activationEvents: []` — activates lazily on command. No `onStartupFinished`, no proactive surface. |

**Discoverability is the weakest product surface**: a first-time user must know the command name "Charter Ai: Open Pipeline". There is no icon in the Activity Bar, no welcome view, no "walkthrough" contribution.

## 1.4 Features — What / Where / How / Works well / Could improve

### F1. Chat agent (Home orchestrator + canvas drafter)
- **What**: natural-language agent that investigates the workspace and either manages the document pipeline or drafts documents.
- **Where**: `extension/ai/agentLoop.ts` (loop + two system prompts), `tools.ts` (8 tools), `extension.ts:72` (router), `useChat.ts` + `ChatPanel.tsx` (UI).
- **How**: user types in the slide-over chat (or Home Ask bar) → `chatMessage` → `processChat` → agent loop with tool calls → final JSON `{message, document, anchors, targetDoc}` → normalized + Mermaid-validated → saved to `.charter-ai/` → `loadCanvas` pushes the new blocks into the editor.
- **Works well**: tooling discipline is genuinely strong — path sandboxing (`tools.ts:180` `safeResolve`), grep caps + relevance ranking + gitignore-aware glob with explicit "excluded by gitignore" messaging, "zero hits ≠ absent" retry rules, citation requirement (`path:line`), bounded observations (12k chars), budget warnings, JSON soft-recovery, Mermaid validate-and-fix with a safe fallback instead of fake diagrams, `safeChatMessage` prevents protocol JSON leaking into chat (`agentLoop.ts:355`).
- **Could improve**: zero intermediate feedback (status is only "Thinking…" until done — `extension.ts:115` and `agent.ts:115`), no cancel, errors surface as raw text prefixed "Error:" inside chat bubbles, whole-document replacement with no undo, no confirmation for destructive pipeline operations, no streaming.

### F2. Canvas editor + custom blocks
- **What**: BlockNote document editor with 6 custom block types: `callout`, `kpiGrid`, `scopeBounds`, `stakeholderTable`, `riskList`, `diagram` (Mermaid).
- **Where**: `src/components/canvas/` — `DocumentCanvas.tsx`, `schema.ts`, `canvasInsert.ts` (slash menu + sidebar catalog), `blocks/*`.
- **How**: type `/` for the slash menu, or use the Insert tab in the tools sidebar. Blocks are edited via a `BlockEditDialog` (rows in/out, variant pickers) rather than inline. The Outline tab lists headings/shapes with jump-to and delete. The diagram block renders Mermaid with a fullscreen pan/zoom viewer.
- **Works well**: the custom blocks are exactly the right structured primitives for requirements docs (measurable KPIs, in/out scope, stakeholder interest/influence, likelihood×impact). Block sanitization is defensive (`sanitizeBlocks.ts` + `safeInitialContent` in `DocumentCanvas.tsx:48`) with an error boundary so bad content degrades instead of blanking the webview. `documentHasOwnHeading` correctly hides the chrome masthead when the doc has its own title.
- **Could improve**: block data is stored as JSON strings in props (`itemsJson`, `rowsJson`) — editing requires the modal; no inline editing of table rows; anchorIds are editable but **nothing uses them** (traceability is dead weight today); the outline delete button removes shapes with no confirm; duplicate sanitization logic in `sanitizeBlocks.ts` (webview) vs `normalizeDocumentBlocks.ts` (host) with "keep in sync" comments — drift risk.

### F3. Document pipeline (Home grid)
- **What**: a dynamic list of pipeline documents. Empty by default; created via Ask, "New Document", or `generate_pipeline`.
- **Where**: `src/pages/HomePage.tsx`, `src/data/documentTypes.ts` (registry), `tools.ts:910` (`generatePipelineTool`), disk `doc-types.json`.
- **How**: agent (or user) creates slots with id (`doc-<slug>`), name, icon. Tiles open the canvas page. Header strip (`PipelineChrome.tsx`) shows all pipeline docs as tabs; clicking the active tab's label renames it.
- **Works well**: empty-state design (suggestion chips, "No documents yet" + Ask bar) is a good activation surface; the ask-bar + auto-open chat flow is smooth; workspace scoping prevents cross-project leakage.
- **Could improve**: **ghost-document bug** — deleting a tile (`deleteDocType` / `remove_pipeline_docs`) never deletes `.charter-ai/<id>.json`, so re-creating a doc with the same name (same slug id) **resurrects the old content** from disk. No reorder UI (`moveDocType` exists at `documentTypes.ts:235` but is unused). `meta.next` is never set for custom docs → the "Proceed to next doc" button (`PhaseCanvasPage.tsx:238`) is dead UI. "Reset Documents" + "Active draft on disk" banner + "Resume/Open Documents" CTA are redundant on Home.

### F4. Templates
- **What**: per-document-type starting points; currently "Build from scratch" (blank) + user-saved templates.
- **Where**: `src/data/docTemplates.ts` / `docTemplateTypes.ts`, `TemplateGallery.tsx`, `TemplateTutorial.tsx`, Templates tab in `CanvasToolsSidebar.tsx`.
- **How**: Templates tab → pick from sidebar list → preview with section outline → apply (replaces content, with a warning when content exists). Save current doc as template via "+ Save current as template".
- **Works well**: preview-before-apply with a "what's inside" outline, "Applied" badge, replace-warning, and a 4-step tutorial is one of the best-designed flows in the product.
- **Could improve**: templates live **only in localStorage** (never synced to `.charter-ai/`) → lost on storage clear, not reviewable/shared; **no way to delete a saved template** (`deleteUserTemplate` at `docTemplates.ts:97` is exported but never called from UI); saving uses native `window.prompt`/`window.alert`; the curated charter templates (PMBOK/Lean/Agile/Six Sigma) were archived (`reference/legacy-pipeline/charterTemplates.ts`) — a brand-new user has no starting material except blank.

### F5. Home dashboard + profile
- **What**: CRT-styled desktop with workspace bar, Ask bar + suggestion chips, documents grid, profile card.
- **Where**: `HomePage.tsx`, `ProfilePage.tsx`, `CRTMonitor.tsx`, `BrandMark.tsx`.
- **How**: Home is the hub; profile is a "Profile Control Panel" with editable fields and preferences.
- **Works well**: strong visual identity, coherent skeuomorphic chrome, sane empty state, good use of `title`/`aria-label` on icon-only buttons.
- **Could improve**: the **profile page is fake** ("Dummy account · local only", "Session (fake)", "Plan: Classic Mac Demo", "Preferences (placeholder)", checkbox literally labeled "Email me when a gate is ready (not wired)" — `ProfilePage.tsx:69,96-100,185-201`). It ships unfinished scaffolding in a product UI, and the profile is never used by the AI or documents. Either finish it (wire profile into agent context — it already has fields like org/role the charter templates used) or cut it.

### F6. Settings / configuration
- **What**: API key (SecretStorage via command), provider/model via `.charter-ai/config.json`.
- **Where**: `apiKeyManager.ts`, `formStateManager.ts` (`loadConfig`/`saveConfig`).
- **How**: "Charter Ai: Configure API Key" command; provider/model hand-edited in the repo folder's config file.
- **Works well**: keys in SecretStorage (not in the repo), legacy key migration (`apiKeyManager.ts:10`), env fallbacks.
- **Could improve**: provider selection has **no UI**; the config file is inside the workspace (editing it is invisible to non-technical users and easy to get wrong — one bad JSON and `loadConfig` silently returns defaults); **no way to clear** the stored key; no provider test/connectivity check.

### F7. Diagrams (Mermaid)
- **What**: LLM-drafted or user-authored Mermaid diagrams, validated before commit, rendered in-canvas with fullscreen pan/zoom.
- **Where**: `extension/ai/mermaidValidate.ts` (host validation), `MermaidRenderer.tsx` (render), `Diagram.tsx` / `DiagramFullscreen.tsx` (block + viewer).
- **How**: agent drafts Mermaid, calls `validate_mermaid`, and re-validates on save with 2 LLM fix retries; failures degrade to warn callouts. Users can edit source in a dialog or fullscreen view.
- **Works well**: the fail-safe philosophy ("never a canned fake diagram") is exemplary; structural checks compensate for Mermaid's DOM incompatibility in the Node host (`mermaidValidate.ts:4`); render errors show inline with the error text.
- **Could improve**: host-side validation is structural-only (header + bracket balance) — a diagram can pass "VALID Mermaid" in the tool and still fail to render in the webview; no PNG/SVG export from the fullscreen viewer; wheel-zoom with no zoom buttons on the keyboard path.

### F8. Persistence & workspace state
- **What**: `.charter-ai/` JSON on disk + workspace-scoped localStorage; legacy `.req-gath-sys/` read fallback.
- **Where**: `formStateManager.ts`, `usePhaseDocument.ts`, `workspaceScope.ts`.
- **How**: dual-write with 500 ms debounce; on open, disk wins via `loadCanvas`.
- **Works well**: cross-project leak fix (scoped keys), legacy dir fallback, `retainContextWhenHidden: true`.
- **Could improve**: **no folder guard** — with no workspace open, `workspaceRoot()` falls back to `context.extensionPath` (`extension.ts:109`) and state is written into the extension install directory; **silent write failures** (`saveCanvas` has no error response; `ensureWorkspaceFolder` swallows init errors at `extension.ts:121`) → a read-only workspace means silent data loss; dual sources of truth (localStorage + disk) can diverge; **no conflict detection** if two windows edit the same workspace; localStorage quota risk with large BlockNote docs and user templates; `PROFILE_KEY` is not workspace-scoped (minor).

### F9. Onboarding & first-run experience
- **Current state**: none beyond a welcome chat message that tells the user to configure an API key via the command palette (`useChat.ts:19`). The first failed chat attempt produces a raw error string in a chat bubble ("Error: No API key configured…", `llmClient.ts:119`, `extension.ts:102`).
- **Impact**: activation barrier. A new user opens Home (which looks like a retro OS desktop, not a VS Code tool), sees an empty grid, asks a question, gets an error bubble. No tour explains the pipeline concept, the agent, the canvas, or the blocks. The template tutorial only appears inside an already-created document.

### F10. Reliability / error handling
- **Good**: JSON recovery in the agent loop; Mermaid degradation; canvas error boundary; read tool truncation with explicit notices; retry with backoff in `callLlm`.
- **Weak**: chat errors as text; no toast/notification channel; no logging/telemetry (errors often swallowed, e.g. `extension.ts:120-122`); **no tests anywhere** (zero test files) — the riskiest parsers (`parseStep`, `sanitizeCanvasBlocks`, Mermaid normalization, `extractBalanced`) are untested; duplicated sanitization logic across layers.

### F11. Keyboard shortcuts & accessibility
- **Current state**: no contributed keybindings. Chat toggle is a floating button only. Dialogs close on Esc; tutorial supports arrows; `BlockEditDialog`/`ConfirmDialog`/`NewDocumentModal` have **no focus trap** (Tab can escape to the page behind), no focus restore. Chat has **no `aria-live`** region → screen readers never announce new messages. Many labels are 10–11 px (`HomePage.tsx:203,220,226`, etc.), below comfortable readability; CRT scanlines/glow overlays are always-on with no `prefers-reduced-motion` handling; Material Symbols load from Google Fonts CDN (`index.html`) — offline means missing icons.

---

# 2. UX Audit

Priorities: **P0** critical (data loss / broken core promise) · **P1** high · **P2** medium · **P3** low.

### U1 — Export button is a dead placeholder
- **Why**: a primary header action on every document does nothing except a native alert.
- **Current**: `PhaseCanvasPage.tsx:157` `handleExport` → `window.alert('PDF export for canvas documents is coming soon. Your draft is saved.')`. No export message exists in `protocol.ts`. Meanwhile `ARCHITECTURE.md` claims PDF export is done.
- **Recommended**: ship real export — Markdown (trivial: blocks → markdown) first, HTML/PDF next — or remove the button until it works. Do not ship alerts as features.
- **Priority**: P0 (broken promise at the top of every document view).

### U2 — Agent can destroy a document with no undo
- **Why**: whole-document replacement by AI is the core interaction; one bad draft (or a mis-parsed truncation) loses the user's content permanently.
- **Current**: final agent response → `saveForm` → `loadCanvas` replaces *all* blocks (`agent.ts:170-186`, `usePhaseDocument.ts:86` `applyExternalDocument`). No undo, no history, no diff. Reset button only.
- **Recommended**: (a) snapshot/version before any agent apply (e.g. `.charter-ai/<id>.history.jsonl` or numbered revisions); (b) show a before/after summary ("Added 12 blocks, removed 3, replaced diagram") with an Apply/Cancel gate before committing AI drafts; (c) keyboard undo for the editor (BlockNote already supports editor-level undo — wire it to `applyExternalDocument`).
- **Priority**: P0.

### U3 — Concurrent edit clobbering during agent runs
- **Why**: the agent takes 30–180 s; users will keep typing.
- **Current**: user edits during a run are saved locally+disk; when the agent finishes it writes its snapshot and pushes `loadCanvas`, silently overwriting the user's concurrent edits (`agent.ts:177-185`). No merge, no conflict message.
- **Recommended**: at minimum, warn + show diff before applying (see U2b); ideally compare `currentDocJson` (sent at request time) with the latest user edit and refuse/flag the apply.
- **Priority**: P0.

### U4 — Ghost documents: deleted docs resurrect old content
- **Why**: data can reappear that the user believes deleted — confusing and potentially embarrassing (stale requirements surfacing in a "new" doc).
- **Current**: delete removes the tile only (`documentTypes.ts:230`; `tools.ts:850` `removePipelineDocsTool`). `.charter-ai/<id>.json` remains. Re-creating a doc with the same name reuses the slug id (`makeUniqueId`) → old disk content returns on open.
- **Recommended**: on delete, also clear the doc file on disk (post a `saveCanvas` with the empty doc, or add a `deleteCanvas` message) and remove the localStorage key. Same for `remove_pipeline_docs`.
- **Priority**: P1 (data-integrity bug; P0 if any user hits it — flagging as P1 because it needs a reproduction to confirm the exact path).

### U5 — No folder-open guard
- **Why**: the extension's core promise is "reads your codebase"; without a folder it silently writes state into its own install directory.
- **Current**: `workspaceRoot()` → `context.extensionPath` fallback (`extension.ts:109-113`); Home shows "Detecting folder…" forever; state lands in the extension dir.
- **Recommended**: detect no-workspace state and show an in-UI prompt ("Open a folder to use Charter Ai") instead of proceeding; disable document creation.
- **Priority**: P1.

### U6 — Zero feedback during agent runs
- **Why**: the agent's value is code investigation; users watch "Thinking…" for minutes with no signal, and multi-doc requests look stalled (the README's own hardening list #5 admits this).
- **Current**: status is set once to "Thinking…" (`agent.ts:115`) and cleared at the end; tool observations never reach the webview; no progress, no tool names, no streaming; `ChatPanel` typing dots only.
- **Recommended**: surface tool steps as chat status lines ("Reading src/services/api.ts…", "grep 3 patterns → 12 hits", "Validating Mermaid…") via a `chatStatus` stream from `runAgentLoop`; stream `message` deltas; show an iteration counter ("Researching… step 4/15"). See F-series features below.
- **Priority**: P1.

### U7 — No cancel/stop for in-flight requests
- **Why**: a wrong question = a 3-minute wait; users will close the panel/webview and lose the ability to react.
- **Current**: `useChat.ts:127` sets a 180 s timeout; input disabled while typing; no abort path (extension has no cancellation token).
- **Recommended**: a Stop button that posts `chatCancel`; `AbortController`-style cancellation threaded into `callLlm` (the OpenAI SDK supports `signal`); on cancel, clear status and allow a new message.
- **Priority**: P1.

### U8 — Raw error text in chat bubbles
- **Why**: technical strings ("Error: 401 Invalid API key…", timeout messages) destroy perceived quality and give no recovery path.
- **Current**: `extension.ts:99-103` catches and posts `Error: ${err.message}` as a chat message; timeout produces its own text.
- **Recommended**: structured error messages (typed `chatError` message): friendly copy + specific remedy ("API key missing → open Configure API Key", "Provider unreachable → check network/endpoint", "Model timed out → retry or shorten the request") + inline Retry button.
- **Priority**: P1.

### U9 — First-run onboarding gap
- **Why**: empty grid + retro desktop + no key = the highest churn point.
- **Current**: nothing proactive; welcome chat text tells users to run a palette command they don't know exists.
- **Recommended**: first-run (a) API-key/provider setup card on Home before any chat; (b) 3-step walkthrough (pipeline → ask agent → canvas blocks); (c) a one-click "Generate starter docs" that runs the agent once, demonstrating the value loop. Also add `onStartupFinished` activation + activity-bar icon + `walkthroughs` contribution.
- **Priority**: P1.

### U10 — Provider/model configuration is a manual file edit
- **Why**: `.charter-ai/config.json` is invisible to users, easy to corrupt, and silently ignored on parse failure.
- **Current**: no `contributes.configuration`; `loadConfig` returns defaults on any error.
- **Recommended**: settings contribution (`charterAi.llm.provider`, `charterAi.llm.model`) + a provider picker command; keep the file for agent reads but make the UI canonical.
- **Priority**: P1.

### U11 — Fake/dummy UI in Profile page
- **Why**: "Dummy account", fake session data, and a "not wired" checkbox tell users the product is unfinished; it's also a dead end for a feature (profile) that could power the AI (org, role, name for signatures).
- **Current**: `ProfilePage.tsx:69,96-100,185-201`; profile never used in prompts (`agentLoop.ts` system prompts contain no profile data).
- **Recommended**: either wire profile fields into the agent context (cheap: `loadProfile` → pass into `processChat`) and the charter callout/signature blocks, or cut the page to a minimal settings page.
- **Priority**: P1 (trust), P2 (feature).

### U12 — Stale docs / marketplace copy
- **Why**: every doc (README, ARCHITECTURE, PITCH, package.json description) describes removed features; marketplace listing will promise a fixed 6-phase pipeline that no longer exists.
- **Current**: see 1.1.
- **Recommended**: rewrite README + package.json description to the current dynamic-pipeline product; delete or clearly mark ARCHITECTURE.md sections as historical; align PITCH with the shipped MVP.
- **Priority**: P1 (trust), trivial effort.

### U13 — Discoverability: only 3 palette commands, no views
- **Why**: the product is invisible until someone knows the command; nothing surfaces in the Activity Bar or status bar.
- **Current**: no `viewsContainers`, no activity bar icon, no status bar item, no walkthrough contribution; extension activates only on command.
- **Recommended**: activity-bar icon opening the pipeline; status bar item showing provider/model/key state ("Charter Ai: deepseek ✓"); `onStartupFinished` activation with a gentle welcome notification (respecting a "don't show again").
- **Priority**: P2.

### U14 — Rename affordance is hidden
- **Why**: click-to-rename on the active tab (with a `title` tooltip only) is non-standard; users may try to rename via an icon that doesn't exist.
- **Current**: `PipelineChrome.tsx:152-158` — clicking the active tab label enters rename mode.
- **Recommended**: add a small pencil affordance on hover (or use `explorer`-style inline rename on F2); keep the click-to-rename as a shortcut, but make it discoverable.
- **Priority**: P2.

### U15 — Dead UI / dead code paths
- **Why**: dead affordances confuse (Proceed button that never appears, reorder that can't be done) and unused code accumulates (maintenance cost).
- **Current**: `meta.next` never set → "Proceed to next doc" never renders (`PhaseCanvasPage.tsx:238`); `moveDocType` unused (`documentTypes.ts:235`); `hydrateCustomTypesFromDisk` unused (`documentTypes.ts:94`); `deleteUserTemplate` never called from UI; `navigateTo` message unused; `exportPdfAs` in ARCHITECTURE but absent from protocol.
- **Recommended**: either implement (reorder via drag = moveDocType exists; template delete = small dialog) or delete.
- **Priority**: P2.

### U16 — Redundant Home actions
- **Why**: "Active draft on disk" banner + "Resume/Open Documents" + "Open/Resume Documents" hero button say the same thing three ways.
- **Current**: `HomePage.tsx:161-190,304-318`.
- **Recommended**: keep one primary CTA; make the banner an *actionable status* (last-saved time, dirty count) or drop it.
- **Priority**: P3.

### U17 — Chat history is ephemeral and cross-context
- **Why**: users expect conversation continuity; currently a reload wipes it, and the same thread follows you from Home into a canvas (orchestrator prompts reused for drafting).
- **Current**: messages in React state only (`useChat.ts`); `chatPhase` changes on navigation without a new thread; welcome message re-injected on `clearMessages`.
- **Recommended**: persist threads per phase (localStorage, workspace-scoped); show a thread label; consider separating Home and per-doc threads.
- **Priority**: P2.

### U18 — Templates: localStorage-only, no delete, no curated starters
- **Why**: saved templates silently vanish if storage clears; a mis-saved template is permanent; new users have no starting structure.
- **Current**: `docTemplates.ts` — user templates in localStorage; `deleteUserTemplate` unused; curated templates archived.
- **Recommended**: sync templates to `.charter-ai/templates/` (docs-as-code); add delete UI in the Templates tab; ship a small curated starter pack (Charter, PRD, ADR, API Contract) defined as JSON data, not TS code.
- **Priority**: P2.

### U19 — Accessibility gaps
- **Why**: VS Code is used by everyone; the current gaps exclude keyboard and screen-reader users.
- **Current**: no focus traps in any modal; no focus restore; chat has no `aria-live`; 10–11 px labels; CRT overlays always on; Material Symbols from CDN (offline → no icons); `BlockEditDialog` overlay `role="presentation"` with inner dialog (acceptable but inconsistent with others).
- **Recommended**: focus trap + restore in `BlockEditDialog`/`ConfirmDialog`/`NewDocumentModal`; `aria-live="polite"` on the chat message list; bump minimum label size to 12 px; gate CRT effects on `prefers-reduced-motion`; bundle Material Symbols locally (or fall back to codicons).
- **Priority**: P2 (P1 for the focus trap on data-entry dialogs).

### U20 — No workspace-trust handling / prompt-injection surface
- **Why**: the agent reads untrusted repo content; in an untrusted workspace VS Code's trust model is bypassed entirely, and repo text can steer the model.
- **Current**: no `isWorkspaceTrusted` check anywhere; tools read via node `fs` (not `vscode.workspace.fs`); prompt injection from repo files has no mitigation beyond tool sandboxing.
- **Recommended**: gate on workspace trust ("Charter Ai requires a trusted workspace" banner), keep tool sandboxing, add a system-prompt note that file contents are untrusted data, never instructions; disable or confirm `generate_pipeline`/`remove_pipeline_docs` when they originate from file-derived content.
- **Priority**: P2 (P1 if targeting enterprise).

### U21 — No testing
- **Why**: the riskiest code (JSON recovery, block sanitization, Mermaid normalization, pipeline tools) has zero regression protection; a single parsing regression can blank the canvas (the error boundary exists, but reset = content loss).
- **Current**: zero test files; duplicated sanitization logic across layers.
- **Recommended**: start with a small vitest suite covering `parseStep`, `sanitizeCanvasBlocks`/`normalizeDocumentBlocks`, `parseMermaid`, and `generate_pipeline`/`remove_pipeline_docs` idempotency; add a CI gate.
- **Priority**: P1 (engineering risk, invisible to users until it bites).

---

# 3. Feature Gap Analysis

Format: **Feature → User problem → Proposed solution → Expected value → Complexity → Priority** (Quick Win / Medium / Large / Strategic).

### G1. Tool-progress + streaming in chat
- **Problem**: U6 — minutes of "Thinking…" with no signal.
- **Solution**: `runAgentLoop` reports each tool call via `onStatus` (tool name + summary + step count); extension streams `chatStatus` (already in the protocol) and, later, `chatDelta` partial text.
- **Value**: perceived speed + trust in the agent; users can see the agent actually reading their repo.
- **Complexity**: Medium (protocol + loop callback + panel UI; streaming needs a non-JSON wrapper for final responses).
- **Priority**: Medium (P1 urgency).

### G2. Cancel / stop button
- **Problem**: U7.
- **Solution**: `chatCancel` message + `AbortController` threaded into `callLlm`; Stop button replaces the send button while typing.
- **Value**: control; users stop bad runs and retry.
- **Complexity**: Quick Win–Medium (OpenAI SDK supports `signal`).
- **Priority**: Quick Win.

### G3. Document snapshots / undo / version history
- **Problem**: U2/U3 — AI replaces documents wholesale.
- **Solution**: before any agent apply, snapshot current doc to `.charter-ai/.history/<id>/<ts>.json` (keep last N); "Undo last AI change" button; optional simple diff view (block-count + heading-level summary).
- **Value**: data safety; unlocks bolder AI interactions.
- **Complexity**: Medium.
- **Priority**: P0 → Phase 2.

### G4. Real export (Markdown first, then HTML/PDF)
- **Problem**: U1 — dead Export button; "docs as code" needs shareable output.
- **Solution**: Markdown export (blocks → markdown with Mermaid fenced blocks, YAML front-matter) written to a chosen path or opened in the editor; later HTML/PDF via the existing mermaid rendering.
- **Value**: unblocks the core loop (write → share → commit).
- **Complexity**: Quick Win (Markdown), Medium (PDF).
- **Priority**: Quick Win.

### G5. Settings UI + provider picker + key status
- **Problem**: U10 — config is a manual file edit.
- **Solution**: `contributes.configuration` (`charterAi.llm.provider/model`), a "Charter Ai: Select Provider" command with a picker, key status in the settings page, "Test connection" button.
- **Value**: non-technical users can configure; fewer support issues.
- **Complexity**: Medium (packaging a settings schema is easy; provider picker needs a small command).
- **Priority**: Medium.

### G6. First-run onboarding + starter pipeline
- **Problem**: U9.
- **Solution**: first-run flow — (1) key/provider setup card, (2) 3-step walkthrough (pipeline → agent → blocks), (3) "Generate starter docs" one-shot agent run; plus activity-bar icon + `walkthroughs` contribution.
- **Value**: activation; the single biggest conversion lever.
- **Complexity**: Medium.
- **Priority**: Medium.

### G7. Curated starter templates (JSON-defined)
- **Problem**: U18 — blank-only start; archived curated templates.
- **Solution**: restore a starter pack (Charter, PRD, ADR, API Contract, Runbook) as JSON data consumed by `docTemplates.ts`; ship as bundled assets (works offline); keep user templates on disk.
- **Value**: users see structure immediately; templates are a cheap lever for doc quality (README hardening #2).
- **Complexity**: Quick Win–Medium.
- **Priority**: Medium.

### G8. Pipeline mutation review & confirmations
- **Problem**: the agent can silently `generate_pipeline` (replace mode) or `remove_pipeline_docs` (all:true) — destructive, invisible.
- **Solution**: before destructive pipeline ops, surface a confirm card in chat ("Agent wants to remove 4 documents: X, Y… — Allow/Deny"); non-destructive ops stream as status lines.
- **Value**: trust + safety without blocking the happy path.
- **Complexity**: Medium (HITL interrupt in the loop).
- **Priority**: Medium.

### G9. Scoped drafting ("expand section 3", "rewrite risks block")
- **Problem**: every AI edit replaces the whole document; users hesitate to use AI on finished docs.
- **Solution**: allow `document` responses to include `targetIds`/anchors — merge only specified block ids into the canvas; prompt guidance + UI ("Apply to section").
- **Value**: AI becomes a section editor, not a document overwriter; enables iterative use.
- **Complexity**: Large.
- **Priority**: Large.

### G10. Multi-doc runs with per-document progress
- **Problem**: README hardening #5 — a multi-doc request looks like a stalled spinner; one failure aborts visibly with no partial results.
- **Solution**: orchestrator finishes per-doc sequentially, posting `loadDocTypes`/`loadCanvas` per completed doc with status ("Drafting ADR… done (1/3)"), collecting partial failures into the final message.
- **Value**: the flagship "generate my docs pipeline" moment stops feeling broken.
- **Complexity**: Medium (loop + UI).
- **Priority**: Medium.

### G11. AI self-verification pass
- **Problem**: README hardening #4 — hallucinated claims in drafts.
- **Solution**: after drafting, a second loop step re-checks cited `path:line` claims against the files; drops/flag unverifiable claims into the reply ("Removed 2 claims I couldn't verify").
- **Value**: doc quality; the differentiator of "code-aware" becomes real.
- **Complexity**: Large.
- **Priority**: Large.

### G12. Code → requirement traceability (use the anchors)
- **Problem**: `anchorId`s exist everywhere but nothing consumes them; the original vision (requirements linked to code) is unrealized.
- **Solution**: minimal v1 — agent emits `path:line` citations as block-level metadata; canvas renders a "Sources" badge per block; click → opens the file. Later: traceability report (which requirement ↔ which files).
- **Value**: unique differentiator; converts citations (already collected) into a product feature.
- **Complexity**: Medium (metadata + badges) → Large (report).
- **Priority**: Strategic (v1 slice is Medium).

### G13. Conversation persistence + per-doc threads
- **Problem**: U17.
- **Solution**: workspace-scoped localStorage threads per phase; thread switcher in the chat header; keep bounded history rules.
- **Value**: continuity; multi-session work on a doc.
- **Complexity**: Medium.
- **Priority**: Medium.

### G14. Reorder documents + template delete (finish existing stubs)
- **Problem**: U15/U18 — `moveDocType` and `deleteUserTemplate` exist but are unreachable.
- **Solution**: drag/reorder (or up/down buttons) in Home grid or header strip; delete button on saved templates.
- **Value**: small but real; removes dead code.
- **Complexity**: Quick Win.
- **Priority**: Quick Win.

### G15. Keyboard shortcuts & command surface
- **Problem**: U13/U19 — no keybindings, chat only reachable by mouse.
- **Solution**: `charter-ai.toggleChat` (default `Cmd/Ctrl+Shift+C`), `charter-ai.openPipeline`, `charter-ai.exportDocument`; contribute `keybindings`.
- **Value**: power users; VS Code conventions.
- **Complexity**: Quick Win.
- **Priority**: Quick Win.

### G16. Activity bar view + tree of documents
- **Problem**: pipeline lives only inside the webview.
- **Solution**: `viewsContainers` activity-bar icon → TreeDataProvider listing pipeline docs (open on click, rename, delete); mirrors doc-types.json.
- **Value**: native VS Code navigation; discoverability.
- **Complexity**: Medium.
- **Priority**: Medium.

### G17. Explorer context menu: "Ask Charter Ai about this file/folder"
- **Problem**: the agent can read anything, but telling it where to look requires typing paths.
- **Solution**: context menu item on files/folders → sends "Investigate <path> and draft the relevant docs" to the agent.
- **Value**: reduces friction; surfaces the agent where users work.
- **Complexity**: Quick Win.
- **Priority**: Quick Win.

### G18. Mermaid export (SVG/PNG) from the viewer
- **Problem**: fullscreen viewer has no save; diagrams are trapped in the canvas.
- **Solution**: download SVG (mermaid already renders SVG) / PNG via canvas, or "Copy Mermaid source".
- **Value**: docs usable outside the extension.
- **Complexity**: Quick Win.
- **Priority**: Quick Win.

### G19. AI requirements interview mode
- **Problem**: users don't know what a charter/PRD needs; blank-first drafting produces shallow docs.
- **Solution**: guided Q&A (a small modal or chat script): "Who is the sponsor? What's out of scope? What's the measurable success?" → structured block output. The block catalog already encodes the questions (KPI targets must be measurable, out-of-scope must be specific).
- **Value**: the "AI-native requirements gathering" promise, executed simply.
- **Complexity**: Medium–Large (script + state machine).
- **Priority**: Strategic.

### G20. MCP server + external integrations
- **Problem**: roadmap Phase 3 (per PITCH/README); docs live in VS Code but teams work in issue trackers, wikis.
- **Solution**: expose pipeline + doc read/write as MCP tools; later GitHub issue ↔ requirement linking.
- **Value**: ecosystem reach; the "requirements as infrastructure" angle.
- **Complexity**: Large.
- **Priority**: Strategic.

### G21. Cost/token transparency
- **Problem**: agents burn tokens silently; enterprise users budget.
- **Solution**: per-run token estimate (from usage in chat.completions response — the SDK returns usage) + last-N-runs summary in settings.
- **Value**: trust and budgeting.
- **Complexity**: Quick Win (capture `usage`) → Medium (UI).
- **Priority**: Quick Win.

---

# 4. Competitive / Industry Analysis

## 4.1 Category
Charter Ai sits at the intersection of three categories: **AI coding agents** (Cline, Roo Code, Continue, GitHub Copilot Chat/Workspace), **docs-as-code** tooling (Foam, Dendron, Markdown All in One, GitBook CLI), and **requirements/PRD tooling** (GitHub Spec Kit, Breadcrumb AI, Sprints.ai, Notion templates). **No direct competitor** does "AI-native, code-aware requirements pipeline inside VS Code" — the pipeline + structured requirement blocks + local-first repo storage is genuinely unoccupied.

## 4.2 Comparison

| Dimension | Charter Ai | Cline / Roo Code | Copilot Chat / Workspace | GitHub Spec Kit | Foam / Dendron | Notion / Confluence |
|---|---|---|---|---|---|---|
| Core | AI doc pipeline + canvas | Code agent (plan/act) | Chat + web task-to-code | PRD-first repo workflow | Notes/knowledge graphs | Docs/team spaces |
| Code awareness | Yes (8 tools) | Yes (extensive) | Yes (Copilot) | Partial | No | No |
| Structured requirements | **Yes** (KPI/scope/stakeholder/risk blocks) | No (free markdown) | No | Templates only | No | Templates only |
| Doc pipeline concept | **Yes** (generate_pipeline) | No | No | Implicit | No | Folders |
| Local-first / git reviewable | **Yes** (`.charter-ai/` JSON) | Yes (files) | Yes | Yes (markdown) | Yes | No |
| Mermaid diagrams | **Yes** (validated) | No (markdown only) | No | No | Yes (render, not authored) | No |
| Onboarding | Weak (no walkthrough) | Strong (plan/ask loops) | Native | Template + guide | Community docs | Strong |
| Discoverability | Weak (3 commands, no views) | Strong (chat everywhere) | Native | Repo-native | Editor-adjacent | Web-native |
| Undo/history | **None** | Git/file-based | Session-based | Git | Git | Versioning |
| Export | **Dead button** | Files on disk | Files | Markdown | Markdown | Native |

## 4.3 Meaningful opportunities (not copying)

1. **Cline/Copilot have chat; nobody has the pipeline.** Double down on `generate_pipeline` + document sets as the product's spine — a user should be able to say "set up requirements for this repo" and get a coherent doc set, not a wall of text.
2. **Spec Kit proves PRD-first works; Charter Ai can be PRD-first + code-grounded + in-editor canvas** — three things Spec Kit lacks.
3. **The structured blocks are the differentiator competitors can't copy easily** — make KPI/scope/stakeholder/risk blocks feel like the *reason* to use the extension (e.g., traceability and gate-quality checks per block).
4. **Docs-as-code trust**: export, git-friendly diff formats, and PR reviews of `.charter-ai/` JSON would beat Notion-style lock-in.
5. **Mermaid in requirements docs** is rare and valuable (architecture diagrams inside charters) — the validate/fix pipeline should be marketed.

## 4.4 Threats
- **Cline/Roo absorb the category** with generic "write me a PRD" prompts once they add structured output. The defense is the pipeline + blocks + traceability, not the chat.
- **The retro CRT aesthetic is polarizing** — it reads playful/demo, not enterprise. It's a brand asset (memorable) and a liability (trust). Consider a "professional theme" toggle.
- **No tests + packaging risk** (see R2) mean a bad release could break activation for everyone.

---

# 5. Product Improvement Opportunities

### Positioning
- Rewrite the marketplace copy to the *current* product: "AI-assisted requirements pipeline inside VS Code — ask, it reads your repo, drafts a linked set of requirement docs (charter, PRD, ADR…), stored locally in your repo."
- Category change from "Other" → a meaningful category ("Other" is a discoverability penalty).
- Pick one hero moment for marketing: **"Set up requirements for this repo"** → pipeline appears → docs drafted → open canvas. Make that flow flawless (G10).

### Activation / onboarding
- First-run key/provider card + starter-docs CTA (G6). The current flow's first contact is an error bubble.

### Retention
- Undo/history (G3) and scoped drafting (G9) convert one-shot experiments into iterative use.
- Persist chat threads (G13); users return to a doc with context.

### Feature discoverability
- Activity bar icon + tree view (G16), context-menu ask (G17), keybindings (G15), status bar indicator (U13).

### Trust & transparency
- Kill the dummy profile UI (U11) or wire it into the agent.
- Fix the docs (U12), the Export button (U1), and error surfacing (U8).
- Pipeline-op confirmations (G8) and agent progress (G1) build the "this is my tool" feeling.

### Doing too much / too little
- **Too much**: the fake profile chrome, dead "Proceed" path, redundant Home CTAs, legacy dir/key migrations that remain in code after rebrand (fine to keep, but document them).
- **Too little**: no settings UI, no export, no undo, no progress, no onboarding — the core loop is *almost* complete; the gap is polish, not scope.
- **Unnecessarily complicated**: provider config via repo file; templates only in localStorage; dual sanitization logic; the `home`/`profile`/canvas distinction in chat phases (fine internally, invisible to users — make the phase visible as a thread label).

---

# 6. Prioritized Roadmap

| Priority | Improvement/Feature | User Impact | Engineering Effort | Why |
| --- | --- | --- | --- | --- |
| **Phase 1 — Quick Wins** | | | | |
| P0 | Real Markdown export (replace dead Export button) | High | Small | Fixes the most visible broken promise; unlocks docs-as-code |
| P0 | Undo/snapshot before every AI canvas apply | High | Small–Med | Protects all user content from the core interaction |
| P0 | Ghost-doc cleanup on delete (tile + disk + storage) | High | Small | Prevents stale-content resurrection |
| P0 | Cancel/Stop for in-flight chat | High | Small | Restores control during long agent runs |
| P1 | Structured chat errors + Retry | Med | Small | Kills raw error strings; gives recovery paths |
| P1 | No-folder guard + in-UI prompt | Med | Small | Prevents state writes to the extension dir |
| P1 | Home API-key setup card (first-run) | High | Small | Removes the error-bubble first contact |
| P1 | Keybindings (`toggleChat`, `openPipeline`, `export`) | Med | Small | VS Code convention; power users |
| P1 | Status bar provider/key indicator | Med | Small | Configuration visibility |
| P1 | Delete saved templates + reorder docs (finish stubs) | Med | Small | Removes dead code; completes existing features |
| P1 | Rewrite README + package.json description to current product | Med | Small | Trust; marketplace accuracy |
| P1 | Starter vitest suite (parseStep, sanitize, mermaid, pipeline tools) | High (risk) | Small–Med | Protects the riskiest parsers |
| | **Phase 2 — Core Improvements** | | | |
| P1 | Tool-progress + streaming chat status | High | Medium | Kills the "stalled spinner"; builds trust |
| P1 | Settings UI + provider picker + test connection | Med | Medium | Config becomes a UI, not a file edit |
| P1 | First-run onboarding walkthrough + "Generate starter docs" | High | Medium | Activation |
| P1 | Curated starter templates (JSON pack) | High | Medium | Quality + structure from minute one |
| P1 | Conversation persistence + per-doc threads | Med | Medium | Continuity |
| P1 | Pipeline mutation confirmations (HITL) | Med | Medium | Safety for destructive agent ops |
| P1 | Multi-doc progress streaming | High | Medium | Flagship flow stops looking broken |
| P2 | Activity bar icon + documents tree view | Med | Medium | Native discoverability |
| P2 | Explorer context menu "Ask Charter Ai about…" | Med | Small–Med | Low-friction entry points |
| P2 | Accessibility pass (focus traps, aria-live, 12px labels, reduced-motion, local icons) | Med | Medium | Inclusion; VS Code quality bar |
| P2 | Mermaid SVG/PNG export from viewer | Med | Small | Diagrams escape the canvas |
| P2 | Token/cost capture + summary | Med | Small–Med | Transparency; budgeting |
| | **Phase 3 — Major Features** | | | |
| P2 | Scoped drafting (section-level AI edits) | High | Large | Turns AI into a section editor |
| P2 | AI self-verification pass (claims vs files) | High | Large | The code-aware promise, enforced |
| P2 | Traceability v1 (source badges on blocks → open file) | Med | Medium | Realizes anchors; unique value |
| P2 | Workspace-trust gating + prompt-injection hardening | High | Medium | Enterprise readiness |
| P2 | Doc export suite (HTML/PDF) | Med | Medium | Shareable deliverables |
| | **Phase 4 — Strategic** | | | |
| Strategic | AI requirements interview mode | High | Medium–Large | The "AI-native requirements gathering" promise |
| Strategic | MCP server (pipeline + docs tools) | Med | Large | Ecosystem reach; roadmap item |
| Strategic | GitHub issues ↔ requirements linking | Med | Large | Team collaboration |
| Strategic | Traceability report (requirements ↔ files matrix) | Med | Large | Differentiator at enterprise level |
| Strategic | Template marketplace / sharing | Med | Large | Community flywheel |

---

# 7. Final Product Assessment

## 7.1 Top 10 UX problems to fix
1. **Export button is a dead placeholder** (U1)
2. **AI canvas replacement has no undo** (U2)
3. **Concurrent edits clobbered during agent runs** (U3)
4. **Ghost documents resurrect deleted content** (U4)
5. **No feedback during agent runs — "Thinking…" for minutes** (U6)
6. **No cancel; 180 s lockout** (U7)
7. **Raw error strings in chat; no recovery guidance** (U8)
8. **No first-run onboarding; error-bubble first contact** (U9)
9. **Provider/model requires hand-editing a repo file** (U10)
10. **Dummy profile UI + dead "Proceed" path + redundant Home CTAs** (U11/U15/U16)

## 7.2 Top 10 features to add
1. Undo/version history for canvases (G3)
2. Real export — Markdown first, HTML/PDF later (G4)
3. Tool-progress + streaming chat (G1)
4. Settings UI + provider picker (G5)
5. First-run onboarding + starter docs (G6)
6. Curated starter template pack (G7)
7. Pipeline mutation confirmations (G8)
8. Scoped section drafting (G9)
9. Multi-doc per-document progress (G10)
10. Traceability v1 — source badges on blocks (G12)

## 7.3 Top 5 technical/product risks affecting UX
1. **Packaging**: esbuild externals `mermaid` + `@vscode/ripgrep` while `.vscodeignore` drops `node_modules` — a published `.vsix` likely lacks both (mermaid is imported at top level of `mermaidValidate.ts` → activation failure; ripgrep silently falls back to PATH `rg`, which Windows users may lack). **Verify with `vsce package` + install test before publishing.** (Not verifiable in this read-only audit.)
2. **No tests** on the parsing/sanitization layer; a regression blanks canvases (U21).
3. **Docs/marketing drift** — README, PITCH, ARCHITECTURE, and marketplace description promise removed features (U12).
4. **Data-loss window** during agent runs (U2/U3) with no recovery path.
5. **Untrusted-workspace + prompt-injection surface** with no trust gating (U20).

## 7.4 Top 5 opportunities to differentiate
1. **The pipeline as a product** — "set up requirements for this repo" as a one-shot, staged flow (nobody else has it).
2. **Structured requirement blocks** (KPI/scope/stakeholder/risk) with measurable-target enforcement in the agent prompt — competitors produce prose, not checkable requirements.
3. **Code→requirement traceability** using the existing anchor/citation machinery.
4. **Docs-as-code trust**: repo-local JSON, git-reviewable, Markdown export, Mermaid everywhere.
5. **The distinctive identity** — the CRT aesthetic is memorable; package it as a professional theme option rather than abandoning it.

## 7.5 What should NOT be built (and why)
- **Gate reviews, signatures, approval workflows** — form-era scaffolding with no auth/identity infra; the profile page already fakes them. Cut the fake, defer the real.
- **Email notifications** ("Email me when a gate is ready (not wired)") — wrong channel, zero infra; kill the checkbox.
- **Resurrecting the fixed 6-phase pipeline** — the dynamic pipeline is strictly better; only the *copy* needs to change.
- **Restoring the code indexer/embeddings blindly** — it was removed for a reason; the README's own hardening order puts retriever grounding first *and it's not built*. Invest in tool-call quality, not a second retrieval stack.
- **Web-access tool** — README hardening #6 says build last; an unscoped fetch is a context-budget and quality hazard.
- **Multi-user realtime collaboration** — out of scope for a VS Code extension; git-based flows (export, PR review) deliver 80% of the value.
- **A template marketplace** before curated JSON starters exist — build the pack first, marketplaces later.

## 7.6 The single most important improvement to make first
**Document snapshots + undo before every AI canvas apply (G3).** Every other improvement — scoped drafting, multi-doc runs, richer agent behaviors — builds on users being able to let the AI touch their documents without risking their work. It is cheap (one versioned writer in `formStateManager.ts` + one undo affordance), directly fixes the P0 data-loss window, and unblocks trust for everything else. Ship it in the same release as the dead-Export fix and the ghost-doc fix (both tiny) so the first release is "safe + honest".

## 7.7 Recommended 30/60/90-day roadmap

**Days 0–30 (Phase 1 — Quick Wins):**
1. Snapshots/undo for AI applies; ghost-doc cleanup on delete; no-folder guard.
2. Real Markdown export replacing the dead Export button.
3. Cancel/Stop for chat; structured chat errors with Retry.
4. Home API-key setup card; keybindings; status bar indicator.
5. Delete saved templates + doc reorder; remove dead UI (Proceed, dummy session panel).
6. README + package.json description rewritten to the shipped product.
7. Starter vitest suite for `parseStep`, sanitize, Mermaid, pipeline tools.
8. **Package + install a `.vsix` and verify the external-deps risk (mermaid/@vscode/ripgrep) — fix externals before any release.**

**Days 31–60 (Phase 2 — Core Improvements):**
9. Tool-progress + chat status streaming; multi-doc per-doc progress.
10. Settings UI (provider/model) + provider picker + connection test.
11. First-run onboarding walkthrough + "Generate starter docs".
12. Curated starter template pack (JSON).
13. Conversation persistence + per-doc threads; pipeline mutation confirmations.
14. Accessibility pass (focus traps, aria-live, typography, reduced-motion, local icons).

**Days 61–90 (Phase 3 — Major Features):**
15. Scoped section drafting (anchor/block-targeted merges).
16. AI self-verification pass (claims vs cited files).
17. Traceability v1 (source badges → open file); workspace-trust gating.
18. Activity bar tree view + explorer context menu; Mermaid SVG export; HTML/PDF export.

**Ongoing (Phase 4 — Strategic, after 90 days):** requirements interview mode, MCP server, issue linking, traceability reports.

---

## Appendix A — Evidence index (key files)
| Claim | File |
|---|---|
| Dead Export | `src/pages/PhaseCanvasPage.tsx:157-160` |
| Agent whole-doc replace | `extension/ai/agent.ts:170-186`; `src/hooks/usePhaseDocument.ts:86-102` |
| Ghost-doc path | `src/data/documentTypes.ts:230-232`; `extension/ai/tools.ts:850-905`; `extension/formStateManager.ts:110-118` |
| No-folder fallback | `extension/extension.ts:109-113` |
| Status only "Thinking…" | `extension/ai/agent.ts:115`; `extension/extension.ts:84,97` |
| No cancel / 180s timeout | `src/hooks/useChat.ts:32,127-137` |
| Raw error strings | `extension/extension.ts:99-103`; `extension/ai/llmClient.ts:119-123` |
| No settings contribution | `package.json:17-45` (commands/menus only) |
| Config file editing | `extension/formStateManager.ts:91-99`; `extension/ai/llmClient.ts:9-25` |
| Dummy profile | `src/pages/ProfilePage.tsx:69,96-100,185-201` |
| Templates localStorage-only, no delete | `src/data/docTemplates.ts:47-53,97-102`; `src/components/canvas/CanvasToolsSidebar.tsx:224-258` |
| Dead code | `src/data/documentTypes.ts:94,235`; `src/pages/PhaseCanvasPage.tsx:238-251` |
| Packaging risk | `package.json:49` (esbuild externals) + `.vscodeignore:5` (node_modules) |
| Sanitization duplication | `src/components/canvas/sanitizeBlocks.ts` vs `extension/ai/normalizeDocumentBlocks.ts` |
| A11y gaps | `src/components/canvas/BlockEditDialog.tsx:35-48`; `src/components/chat/ChatPanel.tsx:69-98`; `src/index.css` (10–11px labels throughout) |
| Docs drift | `README.md:38-60` (semantic_search/embeddings), `ARCHITECTURE.md:48-57,208-225` (codeIndexer/PDF/forms), `PITCH.md:19-23`, `package.json:4` |
| Strong spots (credit) | `extension/ai/tools.ts:180-186` (sandbox), `agentLoop.ts:296-352` (recovery), `agent.ts:231-346` (Mermaid fix), `workspaceScope.ts` (scoping), `DocumentCanvas.tsx:48-69` + `CanvasErrorBoundary.tsx` (resilience) |

## Appendix B — Open questions (need product answers)
1. **Is the marketplace listing live?** `private: true`, no `icon`/`license`/`repository` fields, publisher `charter-ai` — release readiness unclear.
2. **Who is the buyer?** Solo devs vs. team leads changes priorities (e.g., team → export/collaboration first).
3. **Is the CRT aesthetic a brand bet or a placeholder?** It affects enterprise adoption; a professional theme toggle is a cheap hedge.
4. **What should "docs" mean to teams** — JSON in `.charter-ai/` (agent-native) vs. Markdown files in the repo (git-reviewable)? The answer shapes G4/G7 and the export suite.
5. **Profile page**: wire into AI context (org/role for signatures) or cut?
