/**
 * Normalize LLM-authored BlockNote-ish blocks before save / validation.
 * Mirrors webview sanitizeCanvasBlocks for diagram aliases, Mermaid extraction,
 * and inline content shapes that crash BlockNote's initialContent parser.
 */
/** Rewrite mermaid* / content.diagram shapes into real diagram blocks with props.code. */
export declare function normalizeDocumentBlocks(blocks: unknown[]): unknown[];
