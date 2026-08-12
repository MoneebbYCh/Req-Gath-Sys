"use strict";
/**
 * Normalize LLM-authored BlockNote-ish blocks before save / validation.
 * Mirrors webview sanitizeCanvasBlocks for diagram aliases, Mermaid extraction,
 * and inline content shapes that crash BlockNote's initialContent parser.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.normalizeDocumentBlocks = normalizeDocumentBlocks;
const DIAGRAM_ALIASES = new Set([
    'diagram',
    'mermaid',
    'mermaidDiagram',
    'mermaidBlock',
    'flowchart',
    'architectureDiagram',
    'diagramBlock',
]);
const NONE_CONTENT_TYPES = new Set([
    'kpiGrid',
    'scopeBounds',
    'stakeholderTable',
    'riskList',
    'diagram',
    'divider',
    'image',
    'file',
    'video',
    'audio',
]);
const KNOWN_STYLES = new Set([
    'bold',
    'italic',
    'underline',
    'strike',
    'code',
    'textColor',
    'backgroundColor',
]);
function tryString(v) {
    return typeof v === 'string' && v.trim() ? v.trim() : '';
}
function extractPlainText(content) {
    if (typeof content === 'string')
        return content;
    if (typeof content === 'number' || typeof content === 'boolean')
        return String(content);
    if (!content || typeof content !== 'object')
        return '';
    if (!Array.isArray(content)) {
        const obj = content;
        if (typeof obj.text === 'string')
            return obj.text;
        return '';
    }
    return content
        .map((part) => {
        if (typeof part === 'string')
            return part;
        if (typeof part === 'number' || typeof part === 'boolean')
            return String(part);
        if (part && typeof part === 'object' && 'text' in part) {
            return String(part.text ?? '');
        }
        return '';
    })
        .join('');
}
function sanitizeStyles(styles) {
    if (!styles || typeof styles !== 'object' || Array.isArray(styles))
        return {};
    const out = {};
    for (const [key, value] of Object.entries(styles)) {
        if (!KNOWN_STYLES.has(key))
            continue;
        if (key === 'textColor' || key === 'backgroundColor') {
            if (typeof value === 'string' && value.trim())
                out[key] = value.trim();
            continue;
        }
        if (value)
            out[key] = true;
    }
    return out;
}
function sanitizeInlineContent(content) {
    if (content == null)
        return '';
    if (typeof content === 'string')
        return content;
    if (typeof content === 'number' || typeof content === 'boolean')
        return String(content);
    if (Array.isArray(content)) {
        const parts = [];
        for (const item of content) {
            if (typeof item === 'string') {
                if (item)
                    parts.push(item);
                continue;
            }
            if (typeof item === 'number' || typeof item === 'boolean') {
                parts.push(String(item));
                continue;
            }
            if (!item || typeof item !== 'object')
                continue;
            const obj = item;
            if (obj.type === 'link' || (typeof obj.href === 'string' && obj.content != null)) {
                const href = typeof obj.href === 'string' ? obj.href.trim() : '';
                const nested = sanitizeInlineContent(obj.content);
                const linkBody = typeof nested === 'string' ? nested : extractPlainText(nested);
                if (href && linkBody)
                    parts.push({ type: 'link', href, content: linkBody });
                else if (linkBody)
                    parts.push(linkBody);
                continue;
            }
            if (obj.type === 'text' || typeof obj.text === 'string') {
                parts.push({
                    type: 'text',
                    text: String(obj.text ?? ''),
                    styles: sanitizeStyles(obj.styles),
                });
            }
        }
        return parts.length > 0 ? parts : '';
    }
    if (typeof content === 'object') {
        const obj = content;
        if (typeof obj.text === 'string')
            return obj.text;
        return extractPlainText(content);
    }
    return '';
}
function extractMermaidCode(block) {
    const props = block.props && typeof block.props === 'object' && !Array.isArray(block.props)
        ? block.props
        : {};
    let code = tryString(props.code) ||
        tryString(props.mermaid) ||
        tryString(props.sourceCode) ||
        tryString(props.diagram);
    let title = tryString(props.title);
    const content = block.content;
    if (!code && typeof content === 'string') {
        code = content.trim();
    }
    else if (!code && content && typeof content === 'object' && !Array.isArray(content)) {
        const c = content;
        code =
            tryString(c.diagram) ||
                tryString(c.code) ||
                tryString(c.mermaid) ||
                tryString(c.source) ||
                tryString(c.sourceCode);
        if (!title)
            title = tryString(c.title);
    }
    const fence = code.match(/^```(?:mermaid)?\s*([\s\S]*?)\s*```$/i);
    if (fence)
        code = fence[1].trim();
    return { code, title };
}
function normalizeCustomProps(type, props) {
    if (type === 'heading') {
        const level = Number(props.level);
        props.level = Number.isFinite(level) && level >= 1 && level <= 6 ? Math.trunc(level) : 1;
    }
    if (type === 'callout') {
        if (props.title == null)
            props.title = '';
        if (props.anchorId == null)
            props.anchorId = '';
        const allowed = new Set(['info', 'warn', 'success', 'error']);
        if (!allowed.has(String(props.variant ?? '')))
            props.variant = 'info';
    }
    if (type === 'kpiGrid') {
        if (Array.isArray(props.items)) {
            props.itemsJson = JSON.stringify(props.items);
            delete props.items;
        }
        else if (typeof props.itemsJson !== 'string') {
            props.itemsJson = '[]';
        }
        if (props.anchorId == null)
            props.anchorId = '';
    }
    if (type === 'stakeholderTable' || type === 'riskList') {
        if (Array.isArray(props.rows)) {
            props.rowsJson = JSON.stringify(props.rows);
            delete props.rows;
        }
        else if (typeof props.rowsJson !== 'string') {
            props.rowsJson = '[]';
        }
    }
    if (type === 'scopeBounds') {
        if (Array.isArray(props.inScope)) {
            props.inScopeJson = JSON.stringify(props.inScope);
            delete props.inScope;
        }
        else if (typeof props.inScopeJson !== 'string') {
            props.inScopeJson = '[]';
        }
        if (Array.isArray(props.outOfScope)) {
            props.outOfScopeJson = JSON.stringify(props.outOfScope);
            delete props.outOfScope;
        }
        else if (typeof props.outOfScopeJson !== 'string') {
            props.outOfScopeJson = '[]';
        }
    }
    for (const key of Object.keys(props)) {
        const value = props[key];
        if (value !== null && typeof value === 'object') {
            try {
                props[key] = JSON.stringify(value);
            }
            catch {
                delete props[key];
            }
        }
    }
}
/** Rewrite mermaid* / content.diagram shapes into real diagram blocks with props.code. */
function normalizeDocumentBlocks(blocks) {
    return blocks.map((raw) => {
        if (!raw || typeof raw !== 'object')
            return raw;
        const block = { ...raw };
        let type = String(block.type || 'paragraph');
        if (DIAGRAM_ALIASES.has(type)) {
            const props = block.props && typeof block.props === 'object' && !Array.isArray(block.props)
                ? { ...block.props }
                : {};
            const { code, title } = extractMermaidCode(block);
            if (code)
                props.code = code;
            if (title)
                props.title = title;
            else if (typeof props.title !== 'string')
                props.title = '';
            if (props.source !== 'code-index')
                props.source = 'llm';
            delete props.mermaid;
            delete props.sourceCode;
            delete props.diagram;
            delete block.content;
            normalizeCustomProps('diagram', props);
            return { ...block, type: 'diagram', props };
        }
        const props = block.props && typeof block.props === 'object' && !Array.isArray(block.props)
            ? { ...block.props }
            : {};
        normalizeCustomProps(type, props);
        if (NONE_CONTENT_TYPES.has(type)) {
            delete block.content;
        }
        else if (block.content !== undefined && block.content !== null) {
            // Flatten object content / fix bare {text} / strip unknown styles before save.
            if (type === 'table' &&
                block.content &&
                typeof block.content === 'object' &&
                !Array.isArray(block.content) &&
                block.content.type === 'tableContent') {
                // leave tableContent; webview sanitize will validate rows
            }
            else {
                block.content = sanitizeInlineContent(block.content);
            }
        }
        if (Array.isArray(block.children) && block.children.length) {
            block.children = normalizeDocumentBlocks(block.children);
        }
        else {
            delete block.children;
        }
        return { ...block, type, props };
    });
}
