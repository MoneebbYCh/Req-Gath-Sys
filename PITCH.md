# Charter Ai — Code-Aware Project Document Drafting

## The Problem

Teams spend weeks writing project charters, PRDs, and architecture documents. The format
fights you — blank templates, scattered feedback, no connection to the actual codebase.
Requirements become static documents that live in a drive somewhere, disconnected from the
code they describe.

## What It Is

Charter Ai is a VS Code extension that turns document drafting from a writing exercise into
a code-aware AI-assisted workflow. Home starts empty: you ask for what your project needs
(or pick a document), and the agent investigates the real codebase — listing folders,
searching symbols, reading files — before it drafts anything.

```
[ask in chat] ←→ [agent reads your code] ←→ [BlockNote canvas draft]
```

## Current State (MVP)

A working VS Code extension with:

- **Dynamic document pipeline** — no fixed phases. Create any document (System Design,
  API Contract, Security Review, …) via **New Document**, the Ask bar, or by telling the
  agent; the Home grid only shows what you/your team created
- **Code-aware agent** — a ReAct loop with live workspace tools (`list_dir`, `glob`,
  `grep`, `read_file`) that cites files (path:line) instead of guessing
- **BlockNote canvas editing** — structured blocks (KPIs, scope bounds, stakeholder
  tables, risk lists, callouts) plus free-form text, auto-saved to `.charter-ai/`
- **Mermaid diagrams that actually render** — every diagram is parse-validated before it
  lands, with automatic LLM fix retries and a clear warning callout if it fails
- **Agent-managed pipeline** — ask the agent to "create a doc for X and draft it"; it
  creates the slot and drafts straight into it from chat
- **Retro Mac OS 9 UI** — distinctive, memorable, fast

It runs on any OpenAI-compatible provider (DeepSeek by default, Kimi or a local Ollama
endpoint optional) with your own key — no vendor lock-in, no Copilot dependency.

## Why VS Code

- Ships to every developer with zero install friction
- Webview UI means React components, not DOM hacking
- Extensions can read the actual codebase — requirements stay linked to code
- Secrets stay in VS Code SecretStorage; the agent runs locally in the extension host

## The Vision

```
Phase 1 (now)     → agentic drafting: code-grounded canvas documents + pipeline management
Phase 2 (next)    → multi-doc progress streaming, Markdown/PDF export, version history,
                    provider settings UI, edit confirmation
Phase 3 (future)  → MCP tools, web access with allowlists, code→requirement traceability
```

Not another docs tool. Requirements that live where the code lives.

## Why Now

Every team with a half-decent SDLC writes charters, PRDs, and design docs. They paste them
into Notion/Confluence/Google Docs and they rot. The gap isn't another editor — it's an
editor that knows your code and fills the boilerplate so you focus on the decisions that
matter.