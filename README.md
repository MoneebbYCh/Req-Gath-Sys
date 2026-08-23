# Charter Ai

A VS Code extension for designing and drafting project documents. Home starts empty —
New Document (or the Ask bar) builds the doc set; each document is a BlockNote canvas
with custom blocks (KPIs, scope bounds, stakeholders, risks, Mermaid diagrams) and
templates.

> **Agent status:** CharterAI is a read-only, evidence-grounded repository analysis
> agent. It streams task activity and answers, supports cancellation and recovery, and
> can generate revision-safe documents through the extension host.

## Architecture (runtime)

Two layers, one runtime (Node — the VS Code extension host). There is no separate backend
process to install or bundle.

1. **Webview (React + Vite)** — `src/`: Home, canvas editor, chat panel, profile.
2. **TS extension host** — `extension/`: VS Code capability broker, read-only repository
   tools, revision-safe documents, and IPC routing to the webview.
3. **Isolated agent worker** — `extension/agent-worker/`: task orchestration, evidence,
   dynamic workers, validation, and model-provider access. Provider keys remain in VS Code
   SecretStorage and never enter the webview.

The webview talks to the host over `postMessage`.

## Documents and blocks

Each pipeline document is a BlockNote canvas persisted as JSON under
`.charter-ai/<id>.json` (legacy `.req-gath-sys/` is still read as a fallback). Custom
blocks: `callout`, `kpiGrid`, `scopeBounds`, `stakeholderTable`, `riskList`, `diagram`
(Mermaid), plus standard headings, paragraphs, and lists.

Every block the agent emits is deterministically sanitized before checkpointing
(variant aliases, ragged table rows, fence-wrapped diagrams, empty items, and
enum casing are coerced; hopeless shapes become editable warn callouts). Mermaid
diagrams additionally pass the same `mermaid.parse` grammar the webview renders
(validated in the isolated worker under jsdom), get one model repair pass fed with
the exact parse error, and degrade to an editable "Diagram needs review" callout if
they still fail. The webview remains the final backstop: any diagram that slips
through renders an inline error instead of a broken canvas.

## Getting started

```bash
npm install
npm run build
```

Then open this folder in VS Code, press `F5` to launch the Extension Development Host, and run
**"Charter Ai: Open Pipeline"** from the command palette.

## Scripts

| Command | What it does |
|---------|--------------|
| `npm run build` | Build extension bundle + webview |
| `npm run build:extension` | esbuild → `out/extension.cjs` |
| `npm run build:webview` | vite → `dist/` |
| `npm run dev` | Vite dev server (webview only) |
| `npm run preview` | Vite preview (webview only) |
| `npm run lint` | ESLint over the project |
| `npm run evaluate` | Run deterministic evaluation metrics and Phase 17 rollout-gate tests |

## Rollout controls

`charterAi.rolloutStage` controls progressive rollout (`gate-a` through `gate-e`, or
`full`, the default). `charterAi.featureFlags` can disable individual capabilities for
development/rollout testing. Dependencies are fail-closed: for example, disabling the
task graph also disables dynamic workers, document generation, validation, and parallel
documents. Tool definitions are filtered before they reach the model.

Phase 17’s evaluator accepts recorded safety checks, metric thresholds, and benchmark
results to assess Gates A–E. It intentionally does not treat unit tests or mock-model runs
as proof of live-provider retrieval quality; those periodic results must be supplied as
evaluation evidence before a rollout gate is approved.

## Agent diagnostics

Run **Charter Ai: Show Agent Diagnostics** from the Command Palette to open the live
`CharterAI Agent Diagnostics` Output channel. Each line is structured JSON that can be
filtered by `taskId`, `nodeId`, `event`, `tool`, `model`, `durationMs`, token counts,
concurrency, and normalized error category. Use `charterAi.diagnosticsLevel` to select
`debug`, `info` (default), `warn`, or `error` detail.

At `info` and above, diagnostics stay content-free: repository source, prompts, model
responses, tool arguments/results, absolute paths, and provider credentials are excluded.
At `debug`, two extra content-bearing events are added for full agent tracing:

- `llm.approach` — the model, system prompt, thinking mode, response format, route,
  available tools, and loop budgets for each tool-loop invocation.
- `tool.executed` — each tool call's name, the arguments passed, and its full output
  (or error), plus duration and success.

Provider credentials are never written at any level.

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the layer playbook and conventions.
