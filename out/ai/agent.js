"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.processChat = processChat;
const llmClient_1 = require("./llmClient");
const agentLoop_1 = require("./agentLoop");
const normalizeDocumentBlocks_1 = require("./normalizeDocumentBlocks");
const mermaidValidate_1 = require("./mermaidValidate");
const formStateManager_1 = require("../formStateManager");
// Document canvases — not home/profile orchestrator modes.
function isCanvasPhase(phase) {
    const p = typeof phase === 'string' ? phase.trim() : '';
    if (!p || p === 'home' || p === 'profile')
        return false;
    return true;
}
function emptyCanvasDoc() {
    return {
        version: 1,
        kind: 'blocknote',
        blocks: [{ type: 'paragraph', content: '' }],
        anchors: {},
    };
}
function normalizeCanvasDoc(data) {
    if (data && typeof data === 'object' && !Array.isArray(data)) {
        const d = data;
        if (d.kind === 'blocknote' && Array.isArray(d.blocks)) {
            const anchors = d.anchors && typeof d.anchors === 'object' && !Array.isArray(d.anchors)
                ? d.anchors
                : {};
            return {
                version: 1,
                kind: 'blocknote',
                blocks: d.blocks.length > 0 ? d.blocks : emptyCanvasDoc().blocks,
                anchors,
            };
        }
    }
    return emptyCanvasDoc();
}
async function loadPhaseDocument(workspaceRoot, phase) {
    if (!isCanvasPhase(phase))
        return null;
    return (0, formStateManager_1.loadForm)(workspaceRoot, phase);
}
async function processChat(args) {
    const { text, phase, workspaceRoot, apiKey, provider, model, history, onStatus, onDocTypesChanged, } = args;
    const config = await (0, formStateManager_1.loadConfig)(workspaceRoot);
    const llmSettings = config.llm ?? { provider: 'deepseek', model: null };
    const llmConfig = {
        provider: provider || llmSettings.provider || 'deepseek',
        model: model ?? llmSettings.model ?? null,
        apiKey,
    };
    onStatus?.('Thinking…');
    let replyText;
    let document;
    let anchors;
    // Message transcript used as context for diagram-fix retries.
    let fixMessages;
    // Always use the agentic tool loop so the model can actually read the open workspace.
    const fieldGuide = '';
    const customLabel = phase === 'home' ? null : await (0, formStateManager_1.docLabelFor)(workspaceRoot, phase);
    const currentDocJson = phase === 'home'
        ? 'null'
        : JSON.stringify(normalizeCanvasDoc(await loadPhaseDocument(workspaceRoot, phase)), null, 2);
    const result = await (0, agentLoop_1.runAgentLoop)({
        text,
        phase,
        label: customLabel ?? undefined,
        fieldGuide,
        workspaceRoot,
        llmConfig,
        currentDocJson,
        history,
        onDocTypesChanged,
    });
    replyText = result.message;
    document = result.document;
    anchors = result.anchors;
    fixMessages = result.messages;
    const targetDoc = result.targetDoc;
    let formUpdated = false;
    let reload = null;
    // Resolve where to save. Prefer explicit targetDoc (id or name) so the agent can
    // create a pipeline slot then draft into it from Home or from another open canvas.
    let savePhase = null;
    if (document && targetDoc) {
        const resolved = await resolvePipelineDocTarget(workspaceRoot, targetDoc);
        if (resolved) {
            savePhase = resolved.id;
        }
        else {
            replyText = `${replyText}\n\n(Could not save the draft — no pipeline doc matched "${targetDoc}". Call list_pipeline / generate_pipeline first, then use that exact id or name as targetDoc.)`;
        }
    }
    else if (document && isCanvasPhase(phase)) {
        savePhase = phase;
    }
    else if (document && !targetDoc) {
        replyText = `${replyText}\n\n(Draft was not saved — set "targetDoc" to the document id or name from list_pipeline, or open that document first.)`;
    }
    if (savePhase && document) {
        const normalizedDoc = (0, normalizeDocumentBlocks_1.normalizeDocumentBlocks)(document);
        const { blocks: validatedBlocks, notes } = await validateAndFixDiagrams(normalizedDoc, llmConfig, fixMessages);
        const existing = normalizeCanvasDoc(await loadPhaseDocument(workspaceRoot, savePhase));
        const saved = {
            version: 1,
            kind: 'blocknote',
            blocks: validatedBlocks,
            anchors: anchors ?? existing.anchors ?? {},
        };
        await (0, formStateManager_1.saveForm)(workspaceRoot, savePhase, saved);
        reload = { type: 'load_canvas', phase: savePhase, data: saved };
        formUpdated = true;
        if (targetDoc || phase === 'home') {
            const label = (await (0, formStateManager_1.docLabelFor)(workspaceRoot, savePhase)) || savePhase;
            if (phase === 'home' || phase !== savePhase) {
                replyText = `${replyText}\n\n(Saved to “${label}” — open that tile on Home to view it.)`;
            }
        }
        if (notes.length) {
            return {
                message: `${replyText}\n\n(${notes.join(' ')})`,
                form_updated: formUpdated,
                reload,
            };
        }
    }
    return {
        message: replyText,
        form_updated: formUpdated,
        reload,
    };
}
/** Match targetDoc to a custom (or built-in) pipeline id by id or display name. */
async function resolvePipelineDocTarget(workspaceRoot, target) {
    const needle = target.trim().toLowerCase();
    if (!needle)
        return null;
    const types = await (0, formStateManager_1.loadDocTypes)(workspaceRoot);
    for (const raw of types) {
        if (!raw || typeof raw !== 'object')
            continue;
        const id = typeof raw.id === 'string' ? raw.id : '';
        const name = typeof raw.name === 'string' ? raw.name : '';
        if (!id)
            continue;
        if (id.toLowerCase() === needle || name.toLowerCase() === needle) {
            return { id, name: name || id };
        }
    }
    return null;
}
const DIAGRAM_FIX_RETRIES = 2;
/**
 * Parse every diagram block before commit. On failure, ask the LLM to fix Mermaid
 * (1–2 retries), then drop still-invalid diagrams rather than blanking the canvas.
 */
async function validateAndFixDiagrams(blocks, llmConfig, priorMessages) {
    const notes = [];
    let next = blocks.map((b) => b && typeof b === 'object' ? { ...b } : b);
    for (let attempt = 0; attempt <= DIAGRAM_FIX_RETRIES; attempt++) {
        const diagrams = (0, mermaidValidate_1.extractDiagramCodes)(next);
        const failures = [];
        for (const d of diagrams) {
            const result = await (0, mermaidValidate_1.parseMermaid)(d.code);
            if (!result.ok) {
                failures.push({ ...d, error: result.error });
                continue;
            }
            // Persist normalized source (unescaped \\n, stripped fences).
            const block = next[d.index];
            if (block && typeof block === 'object') {
                const b = { ...block };
                const props = b.props && typeof b.props === 'object' && !Array.isArray(b.props)
                    ? { ...b.props }
                    : {};
                props.code = result.code;
                b.props = props;
                next[d.index] = b;
            }
        }
        if (failures.length === 0)
            return { blocks: next, notes };
        if (attempt === DIAGRAM_FIX_RETRIES) {
            // Last resort: replace with a warn callout — never a canned fake diagram.
            for (const f of failures) {
                const block = next[f.index];
                if (!block || typeof block !== 'object')
                    continue;
                const props = block.props &&
                    typeof block.props === 'object' &&
                    !Array.isArray(block.props)
                    ? block.props
                    : {};
                const title = typeof props.title === 'string' && props.title.trim()
                    ? props.title.trim()
                    : 'Diagram';
                next[f.index] = {
                    type: 'callout',
                    props: {
                        variant: 'warn',
                        title: `${title} — Mermaid could not be validated`,
                    },
                    content: 'Ask me to regenerate this diagram from the codebase or our chat so I can validate Mermaid again.',
                };
            }
            notes.push(`Replaced ${failures.length} invalid Mermaid diagram(s) with a warning callout after failed parse retries.`);
            return { blocks: next, notes };
        }
        const fixPrompt = [
            'The document you returned has Mermaid diagram block(s) that failed to parse.',
            'Return a JSON object: { "message": "fixed", "fixes": [ { "index": <blockIndex>, "code": "<valid mermaid>" } ] }',
            'Only include diagram fixes. Do not rewrite the whole document.',
            '',
            'Failures:',
            ...failures.map((f) => `- index ${f.index}: error=${JSON.stringify(f.error)}\n  code=\n\`\`\`\n${f.code}\n\`\`\``),
        ].join('\n');
        try {
            const rawFix = await (0, llmClient_1.callLlm)([...priorMessages, { role: 'user', content: fixPrompt }], llmConfig, { jsonMode: true });
            const fixes = parseDiagramFixes(rawFix);
            for (const fix of fixes) {
                const block = next[fix.index];
                if (!block || typeof block !== 'object')
                    continue;
                const b = { ...block };
                const props = b.props && typeof b.props === 'object' && !Array.isArray(b.props)
                    ? { ...b.props }
                    : {};
                props.code = (0, mermaidValidate_1.normalizeMermaidSource)(fix.code) || fix.code;
                if (props.source !== 'code-index')
                    props.source = 'llm';
                b.type = 'diagram';
                b.props = props;
                next[fix.index] = b;
            }
            notes.push(`Re-validated Mermaid after fix attempt ${attempt + 1}.`);
        }
        catch (err) {
            notes.push(`Diagram fix attempt failed: ${err instanceof Error ? err.message : String(err)}`);
        }
    }
    return { blocks: next, notes };
}
function parseDiagramFixes(text) {
    let trimmed = text.trim();
    const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (fence)
        trimmed = fence[1].trim();
    try {
        const parsed = JSON.parse(trimmed);
        const fixes = parsed?.fixes;
        if (!Array.isArray(fixes))
            return [];
        return fixes
            .map((f) => {
            if (!f || typeof f !== 'object')
                return null;
            const row = f;
            const index = Number(row.index);
            const code = typeof row.code === 'string' ? row.code : '';
            if (!Number.isFinite(index) || !code.trim())
                return null;
            return { index: Math.trunc(index), code };
        })
            .filter((x) => x !== null);
    }
    catch {
        return [];
    }
}
