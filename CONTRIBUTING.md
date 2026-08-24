# Contributing to Charter Ai

Charter Ai is a VS Code extension with two layers. Before contributing, read
[`ARCHITECTURE.md`](ARCHITECTURE.md) for the full picture. This guide covers setup,
build commands, and where each kind of change belongs.

## Layers at a glance

| Layer | Location | You touch this when… |
|-------|----------|----------------------|
| **Webview UI** (React + Vite) | [`src/`](src/) | Pages, canvas blocks, chat panel, profile |
| **TS extension host** | [`extension/`](extension/) | IPC routing, VS Code APIs, persistence, agent loop, LLM, tools |
| **Build output** | `out/`, `dist/` | Never edit — always rebuild |

**Golden rule:** Keep [`extension/extension.ts`](extension/extension.ts) a thin router.
Business logic lives in dedicated modules (`extension/ai/`, `formStateManager.ts`). UI lives
in `src/`.

## Prerequisites

- Node.js 18+ and npm
- VS Code

No Python is required — the extension host runs everything on Node.

## One-time setup

```bash
npm install
```

## Configuring the AI (LLM key)

The chat/AI features call an OpenAI-compatible provider (DeepSeek by default).
Provide an API key one of two ways:

**Option A — environment variable (simplest for dev):**

```bash
export DEEPSEEK_API_KEY="sk-..."   # or MOONSHOT_API_KEY for Kimi
code .                              # launch VS Code from the same terminal
```

The extension host inherits environment variables from the process that launched
VS Code, so export the key before launching.

**Option B — VS Code SecretStorage (better UX):**

Run the command palette action **"Charter Ai: Configure API Key"**.

Keys resolve in this order: SecretStorage (passed by the extension) →
provider env var → generic `REQ_GATH_SYS_API_KEY` / `LLM_API_KEY`. The `local`
provider (Ollama) needs no key.

Active provider/model lives in `.charter-ai/config.json`:

```json
{ "llm": { "provider": "deepseek", "model": null } }
```

## Build & run

| Command | What it does |
|---------|--------------|
| `npm run build` | Build extension bundle + webview (production) |
| `npm run build:extension` | esbuild → `out/extension.cjs` |
| `npm run build:webview` | vite → `dist/` |
| `npm run dev` | Vite dev server (webview only; extension still needs a rebuild) |
| `npm run lint` | ESLint over the project |

To run the extension: open this folder in VS Code and press `F5` (Extension
Development Host), then run **"Charter Ai: Open Pipeline"** from the command palette.

## Where changes go (playbook)

### Add a new block type to the canvas

1. **Catalog text** — add the block shape to [`extension/ai/blockCatalog.ts`](extension/ai/blockCatalog.ts)
   (`CANVAS_BLOCK_CATALOG`) so the agent can emit it. Keep it in sync with the renderer.
2. **Renderer** — new component under `src/components/canvas/blocks/`.
3. **Schema + sanitize** — register the block in `src/components/canvas/schema.ts` and
   `src/components/canvas/sanitizeBlocks.ts` so AI output is validated and safe.
4. **Insert UI (optional)** — `src/components/canvas/canvasInsert.ts` / `BlockActions.tsx`.

### Add a new agent tool

1. Add the name to `TOOL_NAMES` and a native schema entry in
   [`extension/ai/agentToolSchemas.ts`](extension/ai/agentToolSchemas.ts) — schemas are what the LLM reads.
   Optionally note it in the short `TOOL_CATALOG` comment string in `tools.ts`.
2. Implement the handler and wire it into the `runTool` switch in the same file.
3. Respect the existing caps pattern (results, chars, timeout) — observations stay bounded.

### Add a new message action

1. Add the message type to [`extension/protocol.ts`](extension/protocol.ts)
2. Route it in `handleMessage` in [`extension/extension.ts`](extension/extension.ts),
   calling a function in the appropriate module
3. Consume it in a webview hook (`vscode.postMessage` + `window.addEventListener('message')`)

Never put business logic in `extension.ts` — only route.

### Add a new LLM provider

Only edit the `PROVIDERS` registry in [`extension/ai/llmClient.ts`](extension/ai/llmClient.ts).
No webview changes needed; users select it in `.charter-ai/config.json`.

### Add a new pipeline document type

Document types are dynamic — there is no phase registry to edit. A doc is a name + icon +
id stored in `.charter-ai/doc-types.json` (mirrored to workspace-scoped localStorage in the
webview). Creating one via the UI (`New Document` in `src/components/NewDocumentModal.tsx`)
or via the agent's `generate_pipeline` tool is sufficient; canvases are plain BlockNote
JSON under `.charter-ai/<id>.json`.

## Conventions

- **Agent protocol:** every model step is a single JSON object — tool call
  `{"tool", "args"}` or final `{"message", "document", "anchors", "targetDoc"}`.
  Never both `tool` and `document` in one step. Parsing lives in `agentLoop.ts` and is
  deliberately tolerant (fences, junk, truncated finals).
- **Tool budget:** the loop runs at most 15 iterations (`MAX_ITERS` in `agentLoop.ts`);
  keep tool observations compact so the context stays usable.
- **Document ids:** slugified, `doc-` prefixed (e.g. `doc-api-contract`); the same string
  is the filename under `.charter-ai/` and the webview route.
- **IPC naming:** camelCase message types (`loadCanvas`).
- **Workspace root** is always resolved by the extension and passed to the
  persistence/AI functions.
- **Dual persistence:** the webview writes to workspace-scoped `localStorage` (cache) and
  the extension writes `.charter-ai/*.json` (source of truth on disk).
- **Don't edit** `out/extension.cjs` or `dist/` — always rebuild.

## Before you open a PR

```bash
npm run lint
npm run build
```