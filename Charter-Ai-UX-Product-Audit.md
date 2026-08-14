# Charter Ai — UX, Product & Feature Audit

**Scope of this audit:** the full source in `CharterAi-version-dynamic_and_react.zip` — `extension/` (host), `src/` (webview), `reference/legacy-pipeline/` (archived), and all top-level docs (`README.md`, `ARCHITECTURE.md`, `CONTRIBUTING.md`, `PITCH.md`). Every claim below traces to a specific file; where I didn't have enough evidence to conclude something, I've said so rather than guessed.

---

## 0. What Charter Ai actually is today (read from code, not docs)

**This matters up front: the project's own documentation describes an app that no longer exists.** `README.md`, `ARCHITECTURE.md`, `CONTRIBUTING.md`, and `PITCH.md` all describe an earlier version — fixed 8-section Charter/PRD forms (`ProjectCharterPage`, `PrdCreationPage`), a `codeIndexer.ts`, a `pdfExportHandler.ts`, `fieldGuides.ts`, `useFormState.ts`, and VS Code's built-in Copilot LM API. **None of these files exist in the current tree.** The real, running product is a different, more ambitious rewrite:

- **Home starts empty.** There is no fixed pipeline. A user either types a request into an "Ask" bar (`src/pages/HomePage.tsx`) or clicks "New Document," and an AI orchestrator (or the user) populates a grid of document tiles stored in `.charter-ai/doc-types.json`.
- **Each document is a BlockNote canvas** (`src/components/canvas/DocumentCanvas.tsx`) — a rich block editor with six custom, structured block types (`Callout`, `Diagram`/Mermaid, `KpiGrid`, `RiskList`, `ScopeBounds`, `StakeholderTable`) alongside standard text/heading blocks.
- **A single ReAct-style agent** (`extension/ai/agentLoop.ts`) drives everything, switching persona by phase: a "home orchestrator" (can create/list/remove pipeline documents) or a "canvas drafter" (drafts the open document). It has real, sandboxed tool access to the open workspace: `list_dir`, `glob`, `grep`, `read_file`, `validate_mermaid`, `list_pipeline`, `generate_pipeline`, `remove_pipeline_docs` (`extension/ai/tools.ts`).
- **LLM access is OpenAI-compatible**, not VS Code's Copilot API as `PITCH.md` still claims — DeepSeek by default, with Kimi and a local Ollama-compatible endpoint as alternatives (`extension/ai/llmClient.ts`).
- **The legacy fixed pipeline is intentionally archived** under `reference/legacy-pipeline/` for lookup only — this part of the docs is accurate.

I'm flagging this drift explicitly because it's a genuine, current risk, not a nitpick — see §5 and §7.

---

## 1. Understanding the existing extension

### 1.1 Purpose and target users
A VS Code extension for teams who want project documentation (charters, PRDs, ADRs, runbooks, whatever they ask for) generated and kept *inside* the repo, grounded in the actual code via an agent with live grep/glob/read access — not written in a separate tool and left to rot. Target users: developers/PMs working inside a real, already-cloned repo (it degrades to a "reason from chat only" mode with little value when there's no code to search).

### 1.2 Core user workflows
1. **Open Pipeline** (`charter-ai.openPipeline` command) → singleton webview panel opens, `.charter-ai/` is created in the workspace root if missing (`extension/formStateManager.ts: initWorkspace`).
2. **Populate Home**: type a request in the Ask bar, or click "New Document" and name/icon it manually (`NewDocumentModal.tsx`), or let the agent call `generate_pipeline` from a chat request.
3. **Open a document tile** → BlockNote canvas; first open with no content and a saved template available auto-opens the Templates tab (`PhaseCanvasPage.tsx: needsInitialTemplate`).
4. **Draft via chat**: ask the AI to write into the open canvas; it investigates the repo with tools, drafts BlockNote blocks (validating any Mermaid diagrams before commit), and saves to `.charter-ai/<id>.json`.
5. **Edit manually**: BlockNote slash menu (`/`) inserts custom blocks; each custom block has its own structured edit dialog (`BlockEditDialog.tsx`) rather than freeform text — this keeps AI- and human-authored content in the same predictable shape.
6. **Rename/delete/reorder** tiles from Home or the in-canvas tab strip (`PipelineChrome.tsx`).

### 1.3 Commands & command palette
Only three commands are registered (`package.json` → `contributes.commands`, confirmed against `extension/extension.ts`):
- `Charter Ai: Open Pipeline`
- `Charter Ai: Initialize Workspace`
- `Charter Ai: Configure API Key`

There is **no** "Configure Embeddings" command despite `README.md` instructing users to run one — I grepped the entire extension host and webview for it; it doesn't exist. There's also no "New Document" or "Ask Charter Ai" command, no Explorer/editor context-menu entry (e.g., "Generate a doc about this file"), and no VS Code `contributes.configuration` settings entries at all.

### 1.4 Views, panels, webviews
Single `WebviewPanel`, always `ViewColumn.One`, singleton (`extension.ts`: if `panel` already exists, `reveal()` it rather than opening a second one — sensible, avoids duplicate-panel confusion). Content Security Policy is explicitly constructed per-load with `webview.cspSource`, which is correctly scoped (good — no `unsafe-eval`, no wildcard origins beyond fonts).

### 1.5 Settings & configuration
There is **no in-product settings UI**. The only knob — which LLM provider/model to use — lives in a hand-edited `.charter-ai/config.json` on disk (`{ "llm": { "provider": "deepseek", "model": null } }`, documented in `README.md`). I confirmed `formStateManager.saveConfig()` exists but **is never called from anywhere** in the extension or webview (`grep -rn "saveConfig"` returns only its own definition) — the plumbing to persist a provider/model choice exists and is simply not wired to any UI. `loadConfig()` is read-only, consumed once by `agent.ts`.

### 1.6 Onboarding / first-time experience
- First document open with saved templates → auto-opens Templates tab.
- First time the Templates tab is opened at all → a one-time `TemplateTutorial` overlay, gated by a `localStorage` flag (`TEMPLATE_TUTORIAL_BASE_KEY`), workspace-scoped.
- The chat panel's welcome message (`useChat.ts: WELCOME`) explicitly tells the user to configure their API key first.
- There is **no onboarding at all for the API key itself** beyond that one chat message — no first-run prompt, no "you haven't configured a key yet" banner on Home, no visible state distinguishing "key missing" from "key configured." A user who ignores the chat welcome text will only discover the missing key when their first chat request throws `No API key configured...` back at them mid-conversation.

### 1.7 Error handling and feedback states
Mixed quality, and inconsistent across the app:
- **Well-handled:** the AI drafting pipeline. Diagram validation (`extension/ai/mermaidValidate.ts` + `agent.ts: validateAndFixDiagrams`) retries a failed Mermaid parse against the LLM up to twice, and on final failure replaces the block with a warning `callout` rather than either silently dropping it or faking one — a genuinely good design decision, explicitly called out in code comments ("never a canned fake diagram"). Canvas rendering has the same philosophy: `DocumentCanvas.safeInitialContent()` bisects a block array to find and stub out exactly the block(s) that would crash BlockNote, keeping the rest of the document intact, backstopped by `CanvasErrorBoundary.tsx` with a manual "Reset canvas" recovery action.
- **Not handled:** `extension.ts: handleMessage` only wraps the `chatMessage` case in try/catch. `loadDocTypes`, `saveDocTypes`, `loadCanvas`, and `saveCanvas` have none — an `fs` failure (read-only workspace, disk full, permissions) throws an unhandled rejection in the extension host with **no feedback path to the webview at all**; the UI just waits forever for a response message that will never arrive.

### 1.8 Loading / empty / success / failure states
- Home's empty state is deliberate and reasonably well-copywritten ("No documents yet. Use Ask Charter Ai above, or add one manually").
- Canvas loading state is a plain "Loading canvas…" string, no skeleton.
- Chat has a typing-dots state and a status-text state (`chatStatus` messages) — but see §2 for how underused the status channel actually is.
- Save state on canvas is a text label cycling through `Saving… / Saved {time} / Save Draft` — clear and low-friction.

### 1.9 Authentication / accounts
No real auth. `ProfilePage.tsx` is explicitly and honestly labeled "Dummy account · local only" / "Session (fake)," with a **hardcoded, never-updating** "Last login: Today · 9:41 AM." Name/Role/Org/Bio are editable and persisted (`src/utils/profile.ts`), purely to `localStorage` — not workspace-scoped, so it's genuinely a single local user profile, not per-project. See §2 for the fact that this data is never actually used.

### 1.10 Integrations with external services
Only the configured LLM provider (DeepSeek / Kimi / local Ollama-style endpoint), reached directly via the `openai` SDK — no other network calls exist anywhere in the extension host. `@vscode/ripgrep` is bundled for the `grep` tool with a documented fallback to system `rg` (`tools.ts: resolveRgPath`).

### 1.11 Keyboard shortcuts & accessibility
No custom keybindings are contributed. Within the webview: dialogs use `role="dialog"` / `aria-modal="true"` and Escape-to-close (`NewDocumentModal.tsx`, `ConfirmDialog.tsx`); the chat panel and inputs carry `aria-label`s; table blocks use `<th scope="col">`. I did not find `prefers-reduced-motion` handling, and BlockNote's own toolbar/slash-menu accessibility is inherited wholesale from the library and wasn't independently auditable from this codebase alone.

### 1.12 Performance-sensitive areas
- `grep`/`glob` results are hard-capped (`MAX_GREP_MATCHES=50`, `MAX_GLOB_RESULTS=50`, `MAX_READ_LINES=2000`, `MAX_OBS_CHARS=12,000` per tool observation in `tools.ts`) and every cap is explicitly surfaced back into the LLM's context as a warning to re-narrow — good practice for keeping the agent loop bounded and cheap.
- The agent loop itself is capped at `MAX_ITERS = 15` tool calls (`agentLoop.ts`), each backed by an LLM call with its own 180s timeout and up to 2 retries (`llmClient.ts`).
- No caching/memoization of repeated `grep`/`read_file` calls within a single agent run — if the model re-reads the same file twice in one loop (which the system prompt doesn't forbid), that's a second full round-trip.

### 1.13 Existing limitations (stated by the team) and technical constraints
`README.md`'s own "Priority order for hardening" section is candid and largely still accurate against the code: retrieval quality gates everything downstream; the orchestrator has no clarify-before-drafting or multi-doc decomposition logic yet; there's no "editor self-verification" pass on prose (only on Mermaid); and a web-access tool is explicitly not built yet. I did not find evidence contradicting any of these self-assessments — they're honest.

---

## 2. UX Audit

Format: **Issue → Why it matters → Current behavior → Recommendation → Priority**

---

**Issue: "Save as Template" and "Export" are effectively dead buttons in the real product.**
*Why it matters:* these are two advertised, visibly-present actions in the canvas header/sidebar. A broken advertised feature is worse than no feature — it erodes trust in everything else.
*Current behavior:* `PhaseCanvasPage.tsx` uses `window.alert(...)` (twice) and `window.prompt(...)` to implement the "content is empty" warning, the template-naming input, and the "PDF export coming soon" message. **VS Code webviews run in a sandboxed iframe without `allow-modals`**, and the panel is created in `extension.ts` with only `enableScripts` + `retainContextWhenHidden` + `localResourceRoots` — no modal allowance. In that environment, `alert()`/`prompt()`/`confirm()` are blocked and silently no-op (`prompt()` returns `null`). Concretely: clicking **Save Template** with an empty canvas shows nothing (the warning never appears); clicking it with content shows nothing (the naming prompt never appears, so `if (!name || !name.trim()) return` fires immediately and nothing saves); clicking **Export** shows nothing (the "coming soon" message never appears — the button just silently calls `saveNow()` and does nothing visible). Notably, the rest of the app avoids this exact trap: `ConfirmDialog.tsx` is a real, in-DOM, themed dialog component used for delete confirmations elsewhere — these two flows just didn't get the same treatment.
*Recommendation:* replace both `window.prompt` calls with a themed input dialog (reuse/extend `BlockEditDialog.tsx` or `ConfirmDialog.tsx`'s pattern) and both `window.alert` calls with inline banners or the same dialog component. Separately, either ship real PDF/Markdown export or remove the button until it exists — a visible, permanently-inert "Export" button actively trains users to distrust the UI.
*Priority: **P0*** (functionally broken advertised feature, not a polish issue).

---

**Issue: With no workspace folder open, the extension silently treats its own install directory as "the workspace."**
*Why it matters:* this can write files where they don't belong, fail silently on a read-only install path, and actively mislead the user about what project they're working in.
*Current behavior:* `extension.ts: workspaceRoot()` returns `context.extensionPath` when `vscode.workspace.workspaceFolders` is empty. `ensureWorkspaceFolder()` then calls `initWorkspace()` against that path and posts a `workspaceInfo` message using it, so `HomePage.tsx`'s workspace bar will show the extension's own folder name as if it were an open project — with no "no folder open" empty state anywhere in the UI.
*Recommendation:* detect the no-workspace-folder case explicitly, refuse to run `initWorkspace()` against `extensionPath`, and show a clear "Open a folder to use Charter Ai" state on Home instead of silently proceeding.
*Priority: **P0*** (data-safety and correctness, not cosmetic — could write into the extension's own install directory).

---

**Issue: Applying a template is a single, un-confirmed, destructive click.**
*Why it matters:* it overwrites the entire canvas with no undo, and it's the *only* destructive action in the app that isn't behind the reusable `ConfirmDialog`.
*Current behavior:* `TemplateGallery.tsx`'s "Replace with this template" / "Re-apply template" button calls `onApply(template)` directly on click; the only safeguard is a passive inline sentence ("Applying replaces the current document content"). Compare this to document deletion, which correctly uses `ConfirmDialog` with an explicit Cancel/Delete choice.
*Recommendation:* route template application through the existing `ConfirmDialog` component whenever `hasExistingContent` is true. This is a small, consistent fix using code that already exists in the app.
*Priority: **P1***.

---

**Issue: No per-step feedback during a multi-tool-call chat response.**
*Why it matters:* a single chat turn can legitimately run up to 15 tool calls (`MAX_ITERS`) plus a final draft plus up to 2 diagram-fix retries — each a separate LLM round trip. During all of that, the UI shows exactly one status string.
*Current behavior:* `agent.ts` calls `onStatus?.('Thinking…')` exactly once, at the very start of `processChat`. `agentLoop.ts` never calls it again as it works through tool calls. `ChatPanel.tsx` therefore shows either that one static "Thinking…" string or generic typing-dots for the entire duration of what can be a genuinely long-running request. The team's own `README.md` roadmap (item 5, "Pipeline sequencing and UX") already flags the *multi-document* version of this gap ("a multi-doc request doesn't look like a stalled spinner") — but the same problem exists for a single-document response too.
*Recommendation:* thread `onStatus` through `runAgentLoop` and call it with the tool name/args on each iteration (e.g., "Reading `src/App.tsx`…", "Searching for `useChat`…"). This is a small, high-leverage change — the plumbing (`onStatus`, `chatStatus` message type) already exists end-to-end; it's just not called from inside the loop.
*Priority: **P1***.

---

**Issue: The chat UI can show a stray timeout error immediately before the real answer arrives.**
*Why it matters:* users get a "No response received" message that reads as a genuine failure, followed shortly by the actual, successful reply — actively confusing, and undermines trust that the tool works at all.
*Current behavior:* `useChat.ts` sets a client-side `TIMEOUT_MS = 180_000` (3 minutes) per message. But the extension-side work behind a single `chatMessage` can involve several sequential `callLlm()` calls, each with its own independent 180s timeout and up to 2 retries (`llmClient.ts`), plus diagram-fix retries. A legitimately busy request (many tool calls, a slow provider, a retried/failed LLM call) can exceed 3 minutes in aggregate while still being on track to succeed. When the client timeout fires first, the user sees an error message ("No response received…"); there's no request ID or cancellation, so if/when the real `chatResponse` message arrives afterward, it's appended to the chat log with no indication it was late or that the prior "error" wasn't actually one.
*Recommendation:* either raise the client timeout to comfortably exceed the worst-case server-side bound (15 tool calls × up to 3 retries × 180s is a large number — at minimum reconcile the two independently-chosen constants), or add a request correlation ID so a late response can replace/annotate the earlier timeout message instead of appending after it.
*Priority: **P1***.

---

**Issue: Deleting a document orphans its file on disk forever.**
*Why it matters:* silent, permanent, invisible disk bloat inside the user's project folder — and it means "delete" doesn't actually mean delete.
*Current behavior:* `HomePage.tsx`'s delete flow (behind a correct `ConfirmDialog`) calls `deleteDocType(id)`, which only rewrites `doc-types.json` (`src/data/documentTypes.ts`). `extension/protocol.ts` has no delete/remove-canvas message type at all — nothing ever removes `.charter-ai/<id>.json`. The confirmation copy ("Its saved content will no longer be reachable") is technically accurate but reads like the data is gone; it isn't — it's just unreachable through the UI, forever, with no recovery or admin view either.
*Recommendation:* add a `deleteCanvas` protocol message and extension handler that actually removes the file (or moves it to a `.charter-ai/.trash/` for a cheap safety net), and update the confirmation copy to match whichever behavior you choose.
*Priority: **P2*** (not urgent, but compounds over the life of a project).

---

**Issue: No way to change LLM provider/model from the UI.**
*Why it matters:* three providers are fully implemented and switching is described in the README as easy — but "easy" currently means hand-editing JSON on disk.
*Current behavior:* `formStateManager.ts` defines `WorkspaceConfig`/`LlmSettings` and a working `saveConfig()` — but nothing in the extension or webview ever calls it. The only way to switch providers is manually editing `.charter-ai/config.json`.
*Recommendation:* a small settings surface (even a QuickPick command, "Charter Ai: Choose LLM Provider") that writes through the already-working `saveConfig()`. This is close to a pure UI task; the backend is done.
*Priority: **P2***.

---

**Issue: Pipeline scale isn't designed for.**
*Why it matters:* the product's own value prop ("Ask Charter Ai" to generate however many docs a project needs) actively encourages accumulating many tiles, but neither surface that shows them was built for that.
*Current behavior:* `generatePipelineTool` caps a *single* call at 12 documents (`MAX_PIPELINE_DOCS`) but nothing caps the cumulative total across multiple asks. Home renders tiles in a plain CSS grid with no search/filter/sort (`HomePage.tsx`). The in-canvas tab strip renders every document as a `min-w-[160px]` tab in a horizontally-scrolling `<nav>` with no scroll affordance (no fade, arrows, or count indicator) — `PipelineChrome.tsx`.
*Recommendation:* add a document count/search on Home once tile count passes a threshold, and either a dropdown/overflow menu or a visible "scroll for more →" affordance on the tab strip.
*Priority: **P2***.

---

**Issue: An AI-applied draft can land silently if the user navigates away mid-response.**
*Why it matters:* the user loses track of whether their request actually did anything.
*Current behavior:* `usePhaseDocument.ts`'s `loadCanvas` listener only applies an update when `msg.phase === phaseId` *and* the component is still mounted — correct behavior for avoiding cross-document clobbering (this part is well-built; see §2 credit below). But the corollary is that if the user leaves the canvas before the AI's response resolves, the drafted content is still saved to disk (`agent.ts` always calls `saveForm` regardless of what's currently open) but never visually applied, and the "(Saved to '{label}' — open that tile to view it)" pointer text is only appended when `targetDoc || phase === 'home'` (`agent.ts`) — i.e., **not** when the user was chatting on an already-open canvas and simply navigated off it before the reply came back. They get a plain assistant message with no indication their canvas changed.
*Recommendation:* always append the "saved to X" pointer when the save phase differs from the webview's currently-visible phase (the extension can track this, or the webview can compare on receipt), regardless of whether `targetDoc` was explicitly set.
*Priority: **P2***.

---

**Issue: Rename is discoverable only by hovering the already-active document tab.**
*Why it matters:* there's no visible affordance (no pencil icon, no menu item) — a user has to already know "click the current tab again" is the gesture.
*Current behavior:* `PipelineChrome.tsx`: clicking the *active* tab enters rename mode; the only hint is a `title="Click to rename"` tooltip, which doesn't render until hover and isn't available at all on touch/narrow layouts.
*Recommendation:* add a small edit-pencil icon next to the active tab's label, or expose rename from the "×" delete button's row as a peer action.
*Priority: **P3***.

---

**Issue: Two documents can share the exact same display name with no way to tell them apart.**
*Why it matters:* confusing on a Home grid that's icon + title only.
*Current behavior:* `createDocType()` (`documentTypes.ts`, used by the manual "New Document" flow) does not check for name collisions. (The AI's own `generatePipelineTool` *does* dedupe by case-insensitive name when appending — so the inconsistency is specifically in the manual-creation path.)
*Recommendation:* warn (not necessarily block) on duplicate names in `NewDocumentModal`, mirroring the check the agent tool already does.
*Priority: **P3***.

---

**Issue: Structured block editors silently discard out-of-vocabulary values.**
*Why it matters:* an AI-drafted risk/impact level that isn't exactly H/M/L (e.g. "Critical") is rendered as an em dash and, if the row is then opened for editing, silently replaced with a default (`M`/`H`) — the original AI-chosen value is gone with no visible signal that a substitution happened.
*Current behavior:* `RiskList.tsx: normalizeLevel()`, and the same pattern likely applies to `StakeholderTable.tsx`/`KpiGrid.tsx` (not fully re-verified line-by-line, flagging as probable given the shared pattern — worth a quick look before treating as confirmed everywhere).
*Recommendation:* preserve the original string as a fallback display value instead of coercing to `—`, and don't silently overwrite it the moment the row is opened for editing.
*Priority: **P3***.

---

**What's already well-designed (said explicitly, not invented as a problem):**
- **Diagram-validation-with-graceful-degradation** (`agent.ts: validateAndFixDiagrams`, `mermaidValidate.ts`) is genuinely good engineering: retry against the LLM, then degrade to a clearly-labeled warning callout rather than ever faking or blanking content.
- **Canvas crash resilience** (`DocumentCanvas.safeInitialContent`, block-by-block bisection, `CanvasErrorBoundary`) is well thought through — a malformed AI-drafted block degrades gracefully instead of taking down the whole editor.
- **Workspace-scoped `localStorage`** (`utils/workspaceScope.ts`) with an explicit code comment referencing a fixed "cross-project leak" bug, and `usePhaseDocument`'s phase-matched `loadCanvas` guard, correctly prevent one project's drafts from bleeding into another's — this is the kind of bug that's easy to ship and hard to notice, and it's handled correctly.
- **Tool-call context discipline** in `tools.ts` (hard caps on grep/glob/read results, explicit "zero hits ≠ absent" guidance fed back into the LLM's own context) is a mature approach to keeping an agentic loop both cheap and honest.

---

## 3. Feature Gap Analysis

**Feature → User problem → Proposed solution → Expected value → Complexity → Priority**

1. **Real document export (PDF/Markdown).** *Problem:* the Export button exists and is discoverable but does nothing (§2). *Solution:* render BlockNote blocks to Markdown (straightforward — the custom blocks already have clean structured props) and/or PDF. *Value:* closes a visible broken promise; export is table-stakes for "documents you'll share outside VS Code." *Complexity:* Medium. *Priority:* **Quick Win / P0** given it's currently a stub, not a from-scratch build.
2. **Chat progress streaming per tool call.** *Problem:* long chat turns look frozen (§2). *Solution:* call the existing `onStatus` hook from inside `agentLoop.ts`'s loop. *Value:* large perceived-responsiveness win for near-zero backend work — all the wiring already exists. *Complexity:* Quick Win. *Priority:* **P1**.
3. **Provider/model settings UI.** *Problem:* switching LLM providers requires hand-editing JSON (§2). *Solution:* a QuickPick command or small settings page writing through the already-working `saveConfig()`. *Complexity:* Quick Win. *Priority:* **P1**.
4. **Real delete (file + entry).** *Problem:* deleted docs orphan JSON forever (§2). *Solution:* add a `deleteCanvas` protocol message. *Complexity:* Quick Win. *Priority:* **P1**.
5. **Personalize AI output with Profile data.** *Problem:* `ProfilePage.tsx` collects Name/Role/Org/Bio but — confirmed by grep — this data is **never read by the extension host or the AI system prompt** (`agent.ts`/`agentLoop.ts` have zero references to `profile`). It's a fully decorative feature sitting one hop away from the product's actual value prop. *Solution:* thread the profile into the system prompt so drafted stakeholder tables, sign-off blocks, and "prepared by" text can self-populate. *Value:* turns an inert feature into a real personalization touch with almost no new UI. *Complexity:* Quick Win. *Priority:* **P1** — this is the single cheapest, most on-strategy improvement in the whole codebase.
6. **Search/filter on Home + overflow handling on the document tab strip.** *Problem:* neither scales past roughly 8–10 documents (§2). *Complexity:* Medium. *Priority:* **P2**.
7. **Version history / restore for canvas documents**, at minimum before a template replace or a large AI rewrite. *Problem:* every destructive action (template replace especially, see §2) is currently unrecoverable. *Solution:* keep the last N saved snapshots per document in `.charter-ai/`, exposed as a simple "Restore previous version" action. *Value:* directly removes the biggest data-loss risk in the product. *Complexity:* Medium. *Priority:* **P2**.
8. **Command Palette / context-menu entry points.** *Problem:* the *only* way into the extension is one command that opens Home; there's no "generate a doc about this file," no palette shortcut to jump straight to the Ask bar. *Solution:* add 2–3 more commands (`Charter Ai: New Document`, `Charter Ai: Ask About This File` from the editor context menu). *Complexity:* Quick Win–Medium. *Priority:* **P2**.
9. **Multi-document generation progress UI.** This is the team's own stated roadmap item (README §"Pipeline sequencing and UX") — I found no code evidence it's built yet (`onDocTypesChanged` fires once per `generate_pipeline`/`remove_pipeline_docs` call, with no finer-grained per-document progress channel). *Complexity:* Medium. *Priority:* **P2**, consistent with the team's own sequencing.
10. **Web-access tool for the agent.** Explicitly "not yet built" per `README.md`, and the team's own stated reasoning for building it *last* (context-budget risk, needs a domain allowlist) is sound and matches what I'd independently recommend. *Complexity:* Large. *Priority:* **Strategic** — agree with the team's existing prioritization, no change recommended here.
11. **MCP tool support.** Mentioned as "Future" in both `ARCHITECTURE.md`'s status table and `PITCH.md`'s roadmap; no code exists for it. Reasonable to defer behind the higher-leverage items above. *Complexity:* Large. *Priority:* **Strategic**.

---

## 4. Competitive / Industry Analysis

Charter Ai sits at the intersection of two categories: **AI coding/repo-assistant extensions** (Copilot Chat, Cursor, Continue, Cody) and **in-repo structured-document tooling** (ADR tools, Docusaurus/README generators). I don't have first-party access to those products' current source or UI from this task, so the comparison below is at the level of publicly-known product shape, not a code-level audit — flagged accordingly.

- **Core functionality:** most AI coding assistants answer questions and edit code; very few own the "produce a structured, presentable project document, grounded in the repo, and keep it living in a canvas" niche the way Charter Ai does. The custom BlockNote block catalog (KPI grids, risk tables, stakeholder tables, validated Mermaid) is a genuine differentiator versus a chat window that just prints Markdown.
- **Onboarding:** general-purpose coding assistants typically piggyback on VS Code's own Copilot sign-in, which is lower-friction than Charter Ai's "go get a DeepSeek/Kimi API key, then find the command palette entry to store it" flow (§1.6, §2). This is a real relative weakness worth being honest about — it's also explicitly why `PITCH.md`'s original "no API keys, no external services" pitch (built on the Copilot LM API) was more frictionless than what actually shipped.
- **Discoverability:** three commands and no settings-contribution point is thin compared to most mature extensions, which typically expose several palette commands, a status-bar item, and a `contributes.configuration` block.
- **Unique capability worth keeping and marketing harder:** the diagram-validation-with-graceful-degradation pipeline (§2) is a level of care most "just ask the LLM for a diagram" integrations don't bother with.
- **Capability gap versus category leaders:** no export/sharing story (until §2/§3 item 1 ships), no settings surface, no visible session/progress transparency during long agent runs.

---

## 5. Product Improvement Opportunities

- **Documentation is actively misleading contributors right now.** This is the single most concrete, verifiable finding in this audit: `README.md`, `ARCHITECTURE.md`, `CONTRIBUTING.md`, and `PITCH.md` describe files, commands, and even the AI provider (VS Code's built-in Copilot LM API) that do not exist in the running product. `CONTRIBUTING.md`'s own "where changes go" playbook tells a new contributor to edit `fieldGuides.ts` and `useFormState.ts` — files that don't exist. This isn't just a documentation-hygiene issue; it will actively cost engineering time (someone, or an AI coding agent, will try to follow these instructions and hit a wall) and it undermines the credibility of the pitch materials for anyone evaluating the project from the outside. **This should be fixed before most other work here**, precisely because it's cheap to fix and currently costs real time on every read.
- **Retention/activation:** the empty-Home-plus-Ask-bar design is a strong activation pattern *if* the first response is fast and visibly working — which is exactly what §2's "no progress feedback" and §2's "silent timeout race" gaps undermine. Fixing those two items is disproportionately high-leverage for first-session retention specifically.
- **Feature discoverability:** three commands, no settings UI, no context-menu entry, and a rename gesture that's only discoverable by accident (§2) all point to the same underlying pattern — real backend capability (multi-provider LLM support, per-document customization) sitting behind UI surfaces that were never built to expose it. §3's items 2/3/5 are, not coincidentally, all cases of "the hard part is already done; only the UI is missing."
- **Trust and transparency:** the diagram-validation pipeline and the block-sanitization fallback (§2, "well-designed" callout) are strong trust-building design decisions that are currently invisible to the user — nothing in the UI tells someone "a diagram failed validation and was replaced with a placeholder" beyond the callout block itself appearing inline. Surfacing this kind of self-correction more visibly (a small chat note: "I validated this diagram and had to simplify it after 2 attempts") would turn quiet reliability engineering into a visible trust signal.
- **Doing something unnecessarily complicated:** the dual-persistence model (webview `localStorage` cache + on-disk `.charter-ai/*.json` as source of truth, per `CONTRIBUTING.md`'s own stated convention) adds real state-reconciliation surface area — most of the bugs in §2 (stale draft on navigation, orphaned files on delete, cross-workspace scoping) live at exactly this seam. It's not clear the `localStorage` cache is pulling its weight versus just reading from disk through the extension host on every load; if it exists purely for perceived snappiness, that's a reasonable trade, but it's worth the team explicitly confirming that's still the reason, since it's the source of a disproportionate share of the current bug surface.

---

## 6. Prioritized Roadmap

| Priority | Improvement/Feature | User Impact | Eng Effort | Why |
|---|---|---|---|---|
| P0 | Fix `window.alert`/`window.prompt` in Save-Template/Export (§2) | High — two advertised features are silently broken | Low | Direct functional bug; fix reuses existing `ConfirmDialog`/`BlockEditDialog` patterns |
| P0 | Handle "no workspace folder open" explicitly instead of falling back to `extensionPath` (§2) | High — data-safety and correctness | Low | Prevents writing into the extension's own install dir; needs a clear empty state |
| P0 | Correct the project docs (README/ARCHITECTURE/CONTRIBUTING/PITCH) to match the current codebase (§5) | High — affects every future contributor | Low–Medium | Currently actively misleading; cheapest fix with outsized payoff |
| P1 | Stream per-tool-call chat progress via existing `onStatus` hook (§2, §3) | High — perceived responsiveness on every AI request | Low | Wiring already exists end-to-end |
| P1 | Reconcile client/server chat timeouts; add request correlation (§2) | Medium-High — removes a confusing false-failure message | Low–Medium | |
| P1 | Provider/model settings UI wired to existing `saveConfig()` (§3) | Medium | Low | Backend already done |
| P1 | Real delete: `deleteCanvas` message + file removal (§2, §3) | Medium | Low | |
| P1 | Feed Profile data into the AI system prompt (§3) | Medium — makes an existing feature real | Low | Cheapest "new" feature available |
| P1 | Confirm-before-replace on template application, via existing `ConfirmDialog` (§2) | Medium — prevents accidental full-document loss | Low | |
| P2 | Real PDF/Markdown export (§2, §3) | High | Medium | Currently a stub; visibly promised |
| P2 | Document search/filter on Home + tab-strip overflow handling (§2, §3) | Medium, grows with pipeline size | Medium | |
| P2 | "Saved elsewhere" notice when a draft lands on a document the user navigated away from (§2) | Medium | Low–Medium | |
| P2 | Version history / restore for canvas documents (§3) | High for the subset of users who hit it | Medium | |
| P2 | Command Palette / editor-context-menu entry points (§3) | Medium | Low–Medium | |
| P3 | Rename discoverability (visible pencil icon) (§2) | Low–Medium | Low | |
| P3 | Duplicate-name warning on manual document creation (§2) | Low | Low | |
| P3 | Preserve out-of-vocabulary values in structured block editors instead of silently coercing them (§2) | Low | Low | |
| Strategic | Multi-document generation progress UI (§3) | Medium, grows with usage | Medium | Team's own stated roadmap item |
| Strategic | Web-access tool for the agent (§3) | High once built | Large | Correctly sequenced last per the team's own reasoning |
| Strategic | MCP tool support (§3) | Unclear until scoped | Large | |

**Phase 1 — Quick Wins:** the four P0s, plus the P1 items that reuse existing components/plumbing (progress streaming, delete, profile personalization, template-replace confirmation).
**Phase 2 — Core Improvements:** timeout reconciliation, provider settings UI, and the P2 UX-at-scale items (search/filter, tab overflow, saved-elsewhere notice).
**Phase 3 — Major Features:** real export, version history, richer command surface.
**Phase 4 — Strategic Opportunities:** multi-doc progress UI, web-access tool, MCP support — in that order, matching the team's own stated sequencing, which this audit found no reason to second-guess.

---

## 7. Final Product Assessment

**Top 10 UX problems to fix**
1. `window.alert`/`window.prompt` silently no-op in the real webview — Save Template and Export are functionally dead (§2).
2. No-workspace-folder fallback silently uses the extension's own install directory (§2).
3. Template replacement is a single, unconfirmed, irreversible click (§2).
4. No progress feedback during long (up to 15-tool-call) chat turns (§2).
5. Client/server chat-timeout mismatch produces confusing false "no response" errors (§2).
6. Deleted documents orphan their files on disk forever, with misleading "no longer reachable" copy (§2).
7. AI-applied drafts can land with zero visible acknowledgment if the user navigated away mid-response (§2).
8. Rename is only discoverable by clicking an already-active tab, with no visible affordance (§2).
9. No document search/filter or tab-overflow handling once a pipeline grows past ~8–10 docs (§2).
10. Structured block editors silently coerce/discard AI-written values that don't match an exact enum (§2).

**Top 10 features to add**
1. Real PDF/Markdown export (currently a stub).
2. Per-tool-call chat progress (plumbing already exists).
3. Provider/model settings UI (backend already exists).
4. Real document deletion (file removal, not just list removal).
5. Profile data actually used to personalize AI-drafted documents.
6. Version history / restore for canvas documents.
7. Search/filter on Home; overflow handling on the document tab strip.
8. More Command Palette / context-menu entry points.
9. Multi-document generation progress UI (team's own roadmap item).
10. Confirm-before-replace on templates, reusing the existing `ConfirmDialog`.

**Top 5 technical/product risks affecting UX**
1. **Documentation drift**: every top-level doc describes a materially different, earlier product. This will misdirect contributors (and any AI coding agent working from these docs) until corrected.
2. **Silent failure paths** in the extension host (`loadDocTypes`/`saveDocTypes`/`loadCanvas`/`saveCanvas` have no error handling) mean disk/permission failures surface as the UI simply hanging, with no diagnostic trail for the user or the team.
3. **Dual persistence (localStorage cache + on-disk source of truth)** is the seam where a disproportionate share of the current bugs live (stale drafts, cross-workspace leaks that were already found and fixed once, orphaned files).
4. **No settings/config UI** despite a working, multi-provider backend — a maintenance trap where backend capability quietly outpaces the surface that exposes it (already true for LLM provider choice; will likely recur for future config).
5. **No CI beyond the tag-triggered publish workflow** (`.github/workflows/publish.yml`) — I found no PR-triggered lint/build/test workflow in the repo, meaning `npm run lint`/`npm run build` failures can reach `main` undetected until someone runs them locally or a release fails.

**Top 5 opportunities to differentiate**
1. The diagram-validation-with-graceful-degradation pipeline and block-level crash resilience are genuinely above-average engineering for this category — make this visible to users as a trust signal, not just an invisible safety net.
2. The structured, AI-authorable custom block catalog (KPI grids, risk/stakeholder tables, validated diagrams) is a real differentiator versus chat-window-prints-Markdown competitors.
3. Live, sandboxed, capped repo tool access (grep/glob/read with explicit "zero hits ≠ absent" discipline fed back into the model's own context) is a more careful retrieval design than most "chat with your repo" integrations bother with.
4. A working multi-provider LLM story (DeepSeek/Kimi/local) is a real cost/privacy differentiator versus Copilot-only tools — currently undersold because there's no UI to switch providers.
5. The empty-Home-plus-natural-language-Ask pattern is a distinctive, low-friction activation flow if (and only if) the responsiveness gaps in §2 are closed first.

**What should NOT be built**
- **A web-access tool right now.** The team's own stated reasoning (context-budget risk, needs a domain allowlist, should come after retrieval/prompt/editor hardening) is sound; nothing in this audit contradicts it.
- **MCP tool support right now**, for the same reason — it's a large surface with no current user-facing gap it uniquely closes, versus the cheaper Phase 1/2 items above.
- **A from-scratch account/auth system.** `ProfilePage.tsx` being an honestly-labeled local dummy profile is fine as-is once its data is actually wired into document drafting (§3 item 5) — building real multi-user accounts isn't justified by anything observed in this codebase.
- **A second persistence layer or sync backend.** The existing dual-persistence design is already the source of most current bugs (§5); adding more synchronization machinery before simplifying what exists would compound the problem, not solve it.

**The single most important improvement to make first**
Fix the two P0 UX bugs (`window.alert`/`window.prompt` no-ops, and the silent no-workspace-folder fallback) together with correcting the top-level documentation. All three are low-effort, and the first two are the difference between "Export/Save Template look broken" and "they work"; the documentation fix protects every hour of engineering time spent on everything else in this roadmap.

**Recommended 30/60/90-day roadmap**
- **Days 1–30:** the three P0 items above, plus the Quick-Win P1s that reuse existing components — progress streaming, real delete, profile personalization, template-replace confirmation. All are low-effort and each closes a concretely broken or half-built experience.
- **Days 31–60:** timeout reconciliation, provider/model settings UI, document search/filter + tab overflow handling, and the "saved elsewhere" notice.
- **Days 61–90:** real PDF/Markdown export, version history for canvas documents, and expanded Command Palette/context-menu entry points — the three Phase 3 items that most directly extend the product's core value proposition rather than just fixing what's already there.

---

*Methodology note: every finding above cites the specific file(s) it's drawn from. Where a claim required inference (e.g., that VS Code webviews block native dialogs) I've stated the reasoning rather than presenting it as directly observed in this repo; where I lacked evidence to assess something (e.g., BlockNote's own internal accessibility, or a code-level comparison against specific competitor products), I said so rather than filling the gap with assumption.*
