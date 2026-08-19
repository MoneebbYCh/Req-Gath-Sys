"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.normalizeMermaidSource = normalizeMermaidSource;
exports.sanitizeMermaidLabels = sanitizeMermaidLabels;
exports.looksLikeValidMermaid = looksLikeValidMermaid;
exports.parseMermaid = parseMermaid;
exports.extractDiagramCodes = extractDiagramCodes;
/**
 * Validate Mermaid in the extension host before committing diagram blocks.
 *
 * Mermaid 11's `parse()` needs DOMPurify / DOM APIs that are incomplete in
 * Node/VS Code host. Labeled nodes (`A[Label]`) often throw
 * `DOMPurify.addHook is not a function` or return false even for valid diagrams.
 *
 * Strategy: normalize + structural checks are authoritative in the host.
 * Full `mermaid.parse` is best-effort only — never reject a structurally-valid
 * diagram because of environment/API failures.
 */
const mermaid_1 = __importDefault(require("mermaid"));
let initialized = false;
const DIAGRAM_HEADERS = /^(graph|flowchart|sequenceDiagram|classDiagram|stateDiagram(?:-v2)?|erDiagram|journey|gantt|pie|mindmap|timeline|quadrantChart|requirementDiagram|C4Context|C4Container|C4Component|C4Dynamic|C4Deployment|gitGraph|sankey-beta|xychart-beta|block-beta|architecture-beta)\b/i;
function getMermaidApi() {
    const mod = mermaid_1.default;
    if (mod && typeof mod.parse === 'function')
        return mod;
    if (mod?.default && typeof mod.default.parse === 'function')
        return mod.default;
    return null;
}
function ensureInit() {
    const api = getMermaidApi();
    if (!api)
        return null;
    if (!initialized) {
        try {
            api.initialize({ startOnLoad: false, securityLevel: 'strict' });
        }
        catch {
            // Extension host may lack DOM — continue with structural validation.
        }
        initialized = true;
    }
    return api;
}
/** Strip fences / literal \\n so tool + LLM payloads become real Mermaid source. */
function normalizeMermaidSource(code) {
    let s = (code || '').trim();
    if (!s)
        return '';
    const fence = s.match(/^```(?:mermaid)?\s*([\s\S]*?)\s*```$/i);
    if (fence)
        s = fence[1].trim();
    // Common when args were double-encoded: real newlines missing, "\\n" present.
    if (!s.includes('\n') && /\\n/.test(s)) {
        s = s.replace(/\\n/g, '\n').replace(/\\t/g, '\t');
    }
    return sanitizeMermaidLabels(s.trim());
}
/**
 * Mermaid treats bare `{}` as diamond nodes. Quote labels that contain
 * shape/punctuation specials (e.g. GET /universities/{slug}).
 */
function sanitizeMermaidLabels(code) {
    if (!code)
        return code;
    const labelSpecials = /[{}<>|#;]/;
    const quoteIfNeeded = (label) => {
        const trimmed = label.trim();
        if (!trimmed)
            return '""';
        if ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
            (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
            return trimmed;
        }
        if (!labelSpecials.test(trimmed) && !/\//.test(trimmed)) {
            return trimmed;
        }
        const escaped = trimmed.replace(/\\/g, '\\\\').replace(/"/g, "'");
        return `"${escaped}"`;
    };
    let out = code.replace(/(\b[A-Za-z][\w]*)\[\s*(?!")([^\]]*?)\]/g, (_m, id, label) => `${id}[${quoteIfNeeded(label)}]`);
    out = out.replace(/(\|--?>?|--)\s*\|(?!\s*")([^|]*?)\|/g, (_m, arrow, label) => {
        if (!labelSpecials.test(label) && !/\//.test(label))
            return `${arrow}|${label}|`;
        return `${arrow}|${quoteIfNeeded(label)}|`;
    });
    return out;
}
/** Strip %% comments and blank lines to find the diagram header. */
function firstDiagramLine(source) {
    for (const line of source.split(/\r?\n/)) {
        const t = line.trim();
        if (!t || t.startsWith('%%'))
            continue;
        return t;
    }
    return '';
}
/**
 * Light structural check used when full parse is unavailable/unreliable in Node.
 * Rejects empty / unknown headers / wildly unbalanced brackets.
 */
function looksLikeValidMermaid(code) {
    const source = normalizeMermaidSource(code);
    if (!source)
        return false;
    const header = firstDiagramLine(source);
    if (!DIAGRAM_HEADERS.test(header))
        return false;
    const openSq = (source.match(/\[/g) || []).length;
    const closeSq = (source.match(/\]/g) || []).length;
    const openPar = (source.match(/\(/g) || []).length;
    const closePar = (source.match(/\)/g) || []).length;
    const openCurly = (source.match(/\{/g) || []).length;
    const closeCurly = (source.match(/\}/g) || []).length;
    // Square brackets should mostly balance (node labels).
    if (Math.abs(openSq - closeSq) > 2)
        return false;
    // Labels often contain many (), so only reject extreme imbalance.
    if (Math.abs(openPar - closePar) > 8)
        return false;
    if (Math.abs(openCurly - closeCurly) > 4)
        return false;
    const bodyLines = source
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('%%'));
    if (bodyLines.length < 2 && !/-->|---|==>|-.->|->>|-->>/.test(source))
        return false;
    return true;
}
async function parseMermaid(code) {
    const source = normalizeMermaidSource(code);
    if (!source)
        return { ok: false, error: 'Empty Mermaid source' };
    const structuralOk = looksLikeValidMermaid(source);
    try {
        const api = ensureInit();
        if (!api) {
            // No Mermaid API in host — structural is the gate.
            return structuralOk
                ? { ok: true, code: source }
                : {
                    ok: false,
                    error: 'Mermaid API unavailable in extension host and source failed structural checks (need a diagram header like flowchart TD and at least one edge).',
                };
        }
        try {
            api.detectType?.(source);
        }
        catch {
            // detectType can throw on unknown types; structural still decides.
        }
        try {
            const parsed = await api.parse(source, { suppressErrors: true });
            if (parsed !== false)
                return { ok: true, code: source };
        }
        catch {
            // DOMPurify / missing document — ignore; structural decides.
        }
        if (structuralOk)
            return { ok: true, code: source };
        return {
            ok: false,
            error: 'Mermaid failed structural checks. Use a known header (flowchart TD / sequenceDiagram / …), balance [], and include at least one edge or a second content line.',
        };
    }
    catch (err) {
        // Any unexpected host error: still accept structurally valid diagrams.
        if (structuralOk)
            return { ok: true, code: source };
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false, error: msg };
    }
}
function extractDiagramCodes(blocks) {
    const out = [];
    blocks.forEach((raw, index) => {
        if (!raw || typeof raw !== 'object')
            return;
        const block = raw;
        if (block.type !== 'diagram')
            return;
        const props = block.props && typeof block.props === 'object' && !Array.isArray(block.props)
            ? block.props
            : {};
        const code = typeof props.code === 'string' ? props.code : '';
        out.push({ index, code });
    });
    return out;
}
