export type View = {
    page: 'home';
} | {
    page: 'profile';
} | {
    page: string;
};
/** Prior chat turns sent with each message for short-term memory. */
export interface ChatHistoryTurn {
    role: 'user' | 'assistant';
    text: string;
}
export type ExtensionToWebviewMessage = {
    type: 'loadCanvas';
    phase: string;
    data: unknown;
} | {
    type: 'loadDocTypes';
    data: unknown;
    mode?: 'merge' | 'replace';
} | {
    type: 'navigateTo';
    view: View;
} | {
    type: 'chatResponse';
    text: string;
} | {
    type: 'chatStatus';
    text: string | null;
} | {
    type: 'workspaceInfo';
    path: string;
    name: string;
};
export type WebviewToExtensionMessage = {
    type: 'saveCanvas';
    phase: string;
    data: unknown;
} | {
    type: 'saveDocTypes';
    data: unknown;
} | {
    type: 'loadDocTypes';
} | {
    type: 'loadCanvas';
    phase: string;
} | {
    type: 'navigate';
    view: View;
} | {
    type: 'ready';
} | {
    type: 'loadWorkspaceInfo';
} | {
    type: 'chatMessage';
    text: string;
    phase: string;
    history?: ChatHistoryTurn[];
};
