export interface LlmSettings {
    provider: string;
    model: string | null;
}
export interface WorkspaceConfig {
    llm: LlmSettings;
}
export declare function initWorkspace(workspaceRoot: string): Promise<boolean>;
export declare function loadConfig(workspaceRoot: string): Promise<WorkspaceConfig>;
export declare function saveConfig(workspaceRoot: string, config: WorkspaceConfig): Promise<void>;
export declare function loadForm(workspaceRoot: string, phase: string): Promise<unknown | null>;
export declare function saveForm(workspaceRoot: string, phase: string, data: unknown): Promise<void>;
/** Document-type definitions for the workspace. */
export declare function loadDocTypes(workspaceRoot: string): Promise<unknown[]>;
export declare function saveDocTypes(workspaceRoot: string, data: unknown): Promise<void>;
/** Human-readable label for a document id from doc-types.json. */
export declare function docLabelFor(workspaceRoot: string, phase: string): Promise<string | null>;
