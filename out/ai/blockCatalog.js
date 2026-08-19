"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CANVAS_BLOCK_CATALOG = void 0;
/**
 * Shared catalog text for the Charter canvas LLM.
 * Keep in sync with src/components/canvas/blocks/*.
 */
exports.CANVAS_BLOCK_CATALOG = `CUSTOM BLOCKS:

1) callout
   { "type": "callout", "props": { "variant": "info"|"warn"|"success"|"error", "title": "…", "anchorId": "optional-stable-id" }, "content": "…" }
   Use for Business Case (required, with anchorId), PM authority notes, hard constraints, approval/signature.

2) kpiGrid — Measurable Objectives (gate this hard)
   { "type": "kpiGrid", "props": { "anchorId": "obj-…", "items": [ { "metric": "…", "target": "…", "method": "…" } ] } }
   Every item MUST include a measurable condition: a number, a date, or a binary yes/no. Reject vague goals.

3) scopeBounds — description of what's in AND deliberately out
   { "type": "scopeBounds", "props": { "inScope": ["…"], "outOfScope": ["…"] } }
   Out-of-scope must be specific and positive ("DB upgrades are a separate project"), not vague.

4) stakeholderTable — names + role only (starting point, not full analysis)
   { "type": "stakeholderTable", "props": { "rows": [ { "nameRole": "Name / Role", "interest": "H", "influence": "H", "concern": "…" } ] } }

5) riskList — high-level risks only (not a full register)
   { "type": "riskList", "props": { "rows": [ { "risk": "…", "likelihood": "M", "impact": "H", "mitigation": "…" } ] } }

6) diagram — Mermaid diagram (flowchart / architecture / sequence). Content is props.code (Mermaid source string).
   { "type": "diagram", "props": { "code": "flowchart TD\\n  A[Users] --> B[Portal]\\n  B --> C[APIs]", "title": "…", "source": "llm" } }
   YOU author the Mermaid after reasoning — from codebase tools when a workspace exists, or from chat/requirements when it does not.
   Prefer small diagrams (≤ ~15–20 nodes). Use flowchart/graph/sequenceDiagram with simple node ids (no spaces in ids).
   Put labels in [brackets]. If a label contains { } / < > | # or path-like text, use quotes: A["GET /universities/{slug}"].
   Never put bare { } inside unquoted labels — Mermaid treats {} as diamond nodes.
   Always use type "diagram" (never "mermaid"). Avoid HTML, classDef, click, and style directives unless essential.
   Before finishing a document that includes a diagram, call the validate_mermaid tool and use the returned block.
   Do not use fixed templates or invent a portal/ERP overview unless that is actually what the user described.

Also: heading, paragraph, bulletListItem, numberedListItem, checkListItem.
Do not invent other custom types.`;
