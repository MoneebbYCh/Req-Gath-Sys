import { CANVAS_BLOCK_CATALOG } from '../blockCatalog'
import type { PromptMode, ToolBudgetKind } from '../agentBudget'

/** Short research policy — no tool encyclopedia (that lives on tool schemas). */
export const RESEARCH_POLICY = `RESEARCH POLICY:
- Orient with list_dir when needed, then glob → grep → read_file. Batch independent tools in one turn.
- Zero hits ≠ absent: retry with a different phrasing at least once before claiming something is missing.
- Cite path:line from read_file for factual claims. Grep snippets are leads; for counts you may sum per-file grep totals then spot-check.
- Full maps / totals only when asked: find the mount/index, then batch-read each mounted module (or sum greps). Split VERIFIED vs UNREAD if incomplete — never title a partial map as complete.
- If tool output was truncated to .charter-ai/tool-output/, re-read or narrow — do not assume completeness.
- Stop when you can answer the user's question. Do not catalogue the whole repo unless asked.
- For category / completeness questions: after concept greps, do a second pass on SDK/import anchors via patterns:[...].`

export const DRAFT_POLICY = `DRAFT POLICY:
- Investigate with tools only as needed to ground facts (cite path:line).
- When the document needs a diagram: draft Mermaid yourself, then call validate_mermaid. Fix and re-validate if it fails. Do not skip validation for diagrams you include.
- Prefer custom blocks for structured content; put the full draft in "document", not in "message".
- If creating a new Home pipeline doc: generate_pipeline (append) first, then finish with document + targetDoc.

${CANVAS_BLOCK_CATALOG}`

export const PIPELINE_POLICY = `PIPELINE POLICY (Home document slots):
- list_pipeline when asked what exists, or before remove/replace.
- generate_pipeline with mode "append" to add slots; "replace" only for a full rebuild. Prefer 1–8 focused docs. Do NOT put full canvas bodies in this tool.
- remove_pipeline_docs by ids/names or all:true — call list_pipeline first if unsure.
- To create AND draft: generate_pipeline → research → finish with document + targetDoc.
- Otherwise finish with document:null. Never invent pipeline tiles without generate_pipeline.`

export function modePolicy(mode: PromptMode, kind?: ToolBudgetKind): string {
  if (mode === 'draft') return DRAFT_POLICY
  if (mode === 'pipeline') return PIPELINE_POLICY
  // research — add a one-liner for full-inventory kind
  if (kind === 'full-inventory') {
    return `${RESEARCH_POLICY}
- This turn is a full inventory/COUNT: find mount table once, then ONE batched turn of grep with path= each mounted route file (pattern for router.get/post/…); sum the reported match counts. Spot-check 1–2 files with read_file. Do NOT re-grep the whole api/ folder, do NOT re-read huge files end-to-end, and do NOT keep looping after the sum is stable — finish with the number + definition (document:null).`
  }
  return RESEARCH_POLICY
}
