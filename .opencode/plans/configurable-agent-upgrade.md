# Plan: Configurable Agent Upgrade (no framework)

## Understanding

Goal: a better overall Charter Ai agent that is easy to configure. "Better" = agentic
capabilities: tool retries, evaluations, token & cost monitoring. Config audience =
the developer, via a file in the workspace. Multi-provider = any OpenAI-compatible
endpoint. Framework migration was evaluated and rejected — the custom stack stays;
this plan adds a config layer and fills four capability gaps.

Grounding findings (verified in code):

| Gap | Current state |
|---|---|
| Config | All knobs are constants: `ANALYSIS_NODE_BUDGET`/`DOCUMENT_NODE_BUDGET` (Planner.ts), `TOOL_LOOP_BUDGET_PRESETS` (toolLoopTaskRunner.ts), hardcoded `allowedTools` in `workerSpecFor`, 5 playbooks in playbooks.ts |
| Providers | `normalizeProviderId()` collapses everything to `'deepseek'`; custom OpenAI-compatible entry commented out in Providers.ts |
| Tool retries | Stream-level retries exist; **tool execution is single-attempt** (`executeToolCalls`). `ToolError.retryable` flag exists but nothing retries on it |
| Cost monitor | `ModelPricing` + `estimatedCost` fully implemented in `TaskBudgetController.snapshot()` but **pricing is never passed in production** (runTaskGraph.ts:206, toolLoopTaskRunner.ts:598) |
| Evals | 9 metric functions + fixtures exist and are unit-tested; **no execution runner exists** |

## Scope — files that change

### A. Config foundation

1. **NEW `extension/agent/config/AgentConfigFile.ts`** — zod schema for
   `charterai.config.json` (workspace root):
   ```jsonc
   {
     "providers": [{ "id": "ollama-local", "label": "Ollama", "baseUrl": "http://localhost:11434/v1", "defaultModel": "qwen3" }],
     "models": { "planner": "...", "explore": "...", "analyze": "...", "validate": "...", "document": "..." },
     "pricing": { "<model-id>": { "inputPerMillion": 0.27, "outputPerMillion": 1.1 } },
     "budgets": { "analysis": { ...TaskBudget partial }, "document": { ... }, "toolLoopTier": "fast" },
     "playbooks": [{ "id": "my-domain", "domain": "...", "keywords": ["regex-source"], "areas": ["..."] }],
     "toolRetries": 2
   }
   ```
   Schema clamps budgets to sane maxima; rejects unknown top-level keys and any key
   matching /api_?key/i (keys never belong in a committable file). Provider ids must
   match `[a-z0-9-]+` (they become secret-storage key suffixes).
2. **NEW `extension/agent/config/AgentConfig.ts`** — loader + merge:
   read file at task start (no fs watcher v1) → validate → produce one
   `ResolvedAgentConfig` { providers, models, pricing, budgets, playbooks, toolRetries }.
   Precedence: file wins for what it declares; VS Code settings remain fallback
   (provider id, model); API keys live only in secret storage.
3. **`extension/extension.ts`** — replace direct `providerDef(...)` calls
   (L313, L317, L338, L479) with the resolved-config accessor so there is one source.

### B. Multi-provider

4. **`extension/agent/config/Providers.ts`** — accept config-declared providers:
   `providerDef(id)` consults resolved config after built-ins; `normalizeProviderId`
   accepts known ids (built-in + configured), still falls back to `'deepseek'` for
   garbage so stale settings never reroute keys.
5. **`extension/agent/config/ProviderConfig.test.ts` / `ProviderValidation*`** —
   additive updates for custom ids.

### C. Tool retries

6. **`extension/agent/model/toolLoopTaskRunner.ts`** — in `executeToolCalls`, when a
   result is `ok:false` and retryable, retry up to `config.toolRetries ?? 2` with the
   existing `retryDelay` backoff; honor AbortSignal; count attempts in telemetry.
7. **Executor result shape** — add `retryable?: boolean` to the `ToolExecutor.execute`
   result; the gateway copies it from caught `ToolError`s.

### D. Token & cost monitoring

8. **`extension/agent/runtime/runTaskGraph.ts:206`** and
   **`toolLoopTaskRunner.ts:598`** — pass `ModelPricing` from resolved config into
   both production `TaskBudgetController` constructions so `snapshot().estimatedCost`
   computes in real runs.
9. Surface: include estimated cost/tokens in the existing task-summary/diagnostics
   output path (diagnostics channel line + whatever task-completed payload reaches the
   webview today — no new dashboard).

### E. Evaluation runner

10. **NEW `extension/agent/eval/runner.ts`** — executes fixture questions against the
    current workspace using real tools + real provider via the single-loop path;
    derives `retrieved[]` from evidence-ledger paths; computes the 9 existing metrics;
    writes JSON + markdown report to `.charterai-eval/`.
11. **NEW command** `charter-ai.runEvaluation` ("Charter Ai: Run Evaluation") in
    package.json + extension.ts; report also printed to diagnostics channel.
12. `.gitignore` — add `.charterai-eval/`.

## Steps (ordered)

1. A1–A3 config schema/loader/wiring (foundation)
2. B4–B5 multi-provider unlock
3. D8–D9 pricing → cost numbers appear
4. C6–C7 tool retries
5. E10–E12 eval runner + command
6. Full gate: `npm test && npm run typecheck && npm run lint`

Dependencies: B and D depend on step 1. C is independent (uses config knob with default).
E last (reads provider/model from config).

## Tests

- AgentConfigFile: schema accepts valid file, rejects apiKey fields/unknown keys,
  clamps absurd budgets, sanitizes provider ids.
- AgentConfig: merge precedence (file > settings), missing-file fallback = current behavior.
- Providers: normalizeProviderId accepts configured ids, still 'deepseek' for garbage
  (update existing length assertions additively).
- toolLoopTaskRunner: retriable tool error → second attempt succeeds → loop continues;
  non-retriable → no retry; budget counts attempts.
- TaskControls: already covered; add wiring assertion that runTaskGraph passes pricing.
- Eval runner: offline unit test with fake provider+executor computing metrics on a
  scripted run; report file written.

## Risks & edge cases

- Stale settings must never silently reroute API keys → keep 'deepseek' fallback semantics.
- Custom baseUrl = user-controlled outbound endpoint — acceptable local-dev tradeoff; keys never transit config file.
- Absurd budget overrides → schema clamps.
- Eval runs spend real tokens → command requires configured provider + prints estimate first? (v1: just document; runs are small).
- Flaky suite member seen once earlier this session (unrelated area) — not caused by this work.

## Out of scope

- Framework/LangGraph migration (rejected — prior discussion)
- Settings-UI panels, fs watchers, CI eval execution, per-node model routing (config makes it trivial later)
