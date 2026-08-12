export interface ProviderInfo {
    baseUrl: string;
    defaultModel: string;
    env: string;
}
export declare const PROVIDERS: Record<string, ProviderInfo>;
export interface LlmConfig {
    provider: string;
    model?: string | null;
    apiKey: string;
}
export interface ChatMessage {
    role: 'system' | 'user' | 'assistant';
    content: string;
}
export declare function resolveApiKey(config: LlmConfig): string;
export declare function resolveModel(config: LlmConfig): string;
export declare function resolveBaseUrl(provider: string): string;
export declare function callLlm(messages: ChatMessage[], config: LlmConfig, options?: {
    jsonMode?: boolean;
    timeout?: number;
    maxTokens?: number;
    retries?: number;
}): Promise<string>;
