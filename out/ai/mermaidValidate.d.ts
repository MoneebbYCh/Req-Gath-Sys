/** Strip fences / literal \\n so tool + LLM payloads become real Mermaid source. */
export declare function normalizeMermaidSource(code: string): string;
/**
 * Mermaid treats bare `{}` as diamond nodes. Quote labels that contain
 * shape/punctuation specials (e.g. GET /universities/{slug}).
 */
export declare function sanitizeMermaidLabels(code: string): string;
/**
 * Light structural check used when full parse is unavailable/unreliable in Node.
 * Rejects empty / unknown headers / wildly unbalanced brackets.
 */
export declare function looksLikeValidMermaid(code: string): boolean;
export declare function parseMermaid(code: string): Promise<{
    ok: true;
    code: string;
} | {
    ok: false;
    error: string;
}>;
export declare function extractDiagramCodes(blocks: unknown[]): {
    index: number;
    code: string;
}[];
