import type { ChatHistoryTurn } from '../protocol';
export interface ChatReload {
    type: 'load_canvas';
    data: unknown;
    phase?: string;
}
export interface ChatResult {
    message: string;
    form_updated: boolean;
    reload: ChatReload | null;
}
export interface ProcessChatArgs {
    text: string;
    phase: string;
    workspaceRoot: string;
    apiKey: string;
    provider?: string | null;
    model?: string | null;
    /** Prior user/assistant turns for short-term memory (excludes the current message). */
    history?: ChatHistoryTurn[];
    /** Interim UX status (e.g. "Updating code index…"). Pass null to clear. */
    onStatus?: (text: string | null) => void;
    /** Fired when generate_pipeline updates doc-types.json. */
    onDocTypesChanged?: (data: unknown[], mode: 'merge' | 'replace') => void;
}
export declare function processChat(args: ProcessChatArgs): Promise<ChatResult>;
