# Charter Ai

A VS Code extension that helps teams design and draft project documents from the open
codebase. Home starts empty — Ask Charter Ai (or New Document) builds the doc set; each
document is a BlockNote canvas with AI chat, templates, and Mermaid diagrams.

## Architecture (runtime)

Two layers, one runtime (Node — the VS Code extension host). There is no separate backend
process to install or bundle.

1. **Webview (React + Vite)** — `src/`: Home, canvas editor, chat panel, profile.
2. **TS extension host** — `extension/`: disk persistence under `.charter-ai/`, ReAct agent
   loop, LLM calls, pipeline + codebase tools.

The webview talks to the host over `postMessage`. All AI work uses an OpenAI-compatible
provider (DeepSeek by default; Kimi or a local Ollama-style endpoint optional) via the
`openai` npm SDK. There is no code indexer and no embeddings — the agent reads the open
workspace live with `list_dir` / `glob` / `grep` / `read_file`.

Legacy fixed-pipeline content (old 6-phase defs, field guides, curated charter templates)
is archived under [`reference/legacy-pipeline/`](reference/legacy-pipeline/) for lookup only
— it is not imported by the app.

## Agent architecture

Charter Ai runs on **one ReAct-style agent**, not a multi-agent swarm — the same JSON-mode
loop is reused with two personas:

- **Home orchestrator** (Home / Profile chat) — investigates the codebase, manages the
  document pipeline (`list_pipeline` / `generate_pipeline` / `remove_pipeline_docs`), and
  can draft any pipeline document by finishing with `targetDoc` + `document`.
- **Canvas drafter** (document pages) — drafts and edits the open document's BlockNote
  blocks, grounded in codebase reads; may also create new pipeline documents.

The loop is bounded: at most 15 tool iterations per request, then the agent must finish.
Every model response is a single JSON object — either a tool call `{tool, args}` or a final
`{message, document, anchors, targetDoc}` — parsed tolerantly (fences, trailing junk, and
truncated finals are repaired).

### Agent tools

| Tool | Purpose |
|------|---------|
| `list_dir` | Orient on the workspace folder tree (flags relevant folders) |
| `glob` | Find files by name/path, or preset (`config`, `entry points`, `tests`) |
| `grep` | Regex search in file contents (±1 line context, ranked, capped) |
| `read_file` | Read a known file (line ranges, explicit truncation) |
| `validate_mermaid` | Parse-check Mermaid and return a ready diagram block |
| `list_pipeline` | List the current document set on Home |
| `generate_pipeline` | Create document slots (`append` default, or `replace`) |
| `remove_pipeline_docs` | Remove document slots (by id/name, or `all: true`) |

Search discipline is enforced in the system prompt: default order
`list_dir → glob → grep → read_file`, "zero hits ≠ absent" (retry with different phrasing
before concluding), and every factual claim in a draft must trace to a `read_file`
citation (path:line).

### Documents and blocks

Each pipeline document is a BlockNote canvas persisted as JSON under
`.charter-ai/<id>.json` (legacy `.req-gath-sys/` is still read as a fallback). Drafts land
as validated block arrays: custom blocks `callout`, `kpiGrid`, `scopeBounds`,
`stakeholderTable`, `riskList`, `diagram` (Mermaid), plus standard headings,
paragraphs, and lists. Mermaid diagrams are parse-validated before commit — up to 2 LLM
fix retries, then the invalid diagram is replaced with a warning callout.

### Hardening priorities

1. **Search/retrieval quality** — everything downstream is bounded by how reliably
   `list_dir → glob → grep → read_file` surfaces the right files. If retrieval is weak, the
   model writes confident-sounding fiction.
2. **Knowledgebase and block prompts** — sharpen `extension/ai/blockCatalog.ts` so drafts
   force completeness (measurable KPIs, specific out-of-scope, high-level risks) the way
   arc42 or C4 would. A better catalog is one of the cheapest levers for depth.
3. **Orchestrator loop behavior** — clarify-before-drafting, multi-doc decomposition
   (shared investigation, sequential drafting), and context trimming as usage scales from
   1 doc to many.
4. **Editor self-verification pass** — Mermaid correctness is already gated; extend that
   instinct to prose: after a section drafts, re-check claims against the files cited.
5. **Pipeline sequencing and UX** — mechanically solid (create/check/delete); remaining
   work is UX around multi-doc runs (streaming `loadCanvas` / `loadDocTypes` progress per
   document instead of a stalled spinner).
6. **Web access** — build last. An unscoped fetch tool is the easiest way to blow the
   context budget or pull in low-quality pages mid-draft. Needs the same truncation
   discipline as the other tools plus a domain allowlist before it is wired into the loop.

## Getting started

```bash
npm install
npm run build
```

Then open this folder in VS Code, press `F5` to launch the Extension Development Host, and run
**"Charter Ai: Open Pipeline"** from the command palette.

## Configuring the AI key

Provide an OpenAI-compatible API key either way:

- **SecretStorage (recommended):** run **"Charter Ai: Configure API Key"** from the command palette.
- **Environment variable:** `export DEEPSEEK_API_KEY="sk-..."` (or `MOONSHOT_API_KEY` for Kimi)
  before launching VS Code.

Key resolution order: SecretStorage → provider env var → generic `REQ_GATH_SYS_API_KEY` /
`LLM_API_KEY`. The `local` provider (Ollama at `http://localhost:11434/v1`) needs no key.

Select the active provider/model in `.charter-ai/config.json`:

```json
{ "llm": { "provider": "deepseek", "model": null } }
```

`model: null` uses the provider's default (DeepSeek: `deepseek-v4-flash`).

## Scripts

| Command | What it does |
|---------|--------------|
| `npm run build` | Build extension bundle + webview |
| `npm run build:extension` | esbuild → `out/extension.cjs` |
| `npm run build:webview` | vite → `dist/` |
| `npm run dev` | Vite dev server (webview only) |
| `npm run preview` | Vite preview (webview only) |
| `npm run lint` | ESLint over the project |

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the layer playbook and conventions.