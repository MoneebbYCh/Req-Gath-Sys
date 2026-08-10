# Legacy fixed 6-phase pipeline (archived)

This folder is **reference only** — not imported by the app.

It preserves the old hard-coded Charter → PRD → System Design → Dev → QA → Post Dev
pipeline content after the product moved to a fully dynamic document set (Home starts
empty; docs come from Ask / New Document / `generate_pipeline`).

## Files

| File | What it was |
|------|-------------|
| `canvasPhases.ts` | Built-in phase metadata (titles, kickers, storage keys, “Proceed to …” links) |
| `fieldGuides.ts` | Per-phase AI drafting guides injected into chat |
| `charterTemplates.ts` | Curated starting templates (PMBOK, Lean, Agile, Six Sigma) + blank option |

## Related live code (after cleanup)

- Document registry: `src/data/documentTypes.ts` (custom docs only)
- Templates UI: blank + user-saved only (`src/data/docTemplates.ts`)
- Agent: generic canvas prompts; no phase-specific guides
