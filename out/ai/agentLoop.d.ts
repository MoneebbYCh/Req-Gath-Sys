import { type ChatMessage, type LlmConfig } from './llmClient';
import type { ChatHistoryTurn } from '../protocol';
export interface AgentLoopArgs {
    text: string;
    phase: string;
    label?: string;
    fieldGuide: string;
    workspaceRoot: string;
    llmConfig: LlmConfig;
    currentDocJson: string;
    /** Prior user/assistant turns (excludes the current user message). */
    history?: ChatHistoryTurn[];
    onDocTypesChanged?: (data: unknown[], mode: 'merge' | 'replace') => void;
}
export interface AgentLoopResult {
    message: string;
    document: unknown[] | null;
    anchors: Record<string, string> | null;
    /** When set (e.g. from Home), save `document` into this pipeline doc id or name. */
    targetDoc: string | null;
    /** Final message transcript, for downstream diagram-fix retries. */
    messages: ChatMessage[];
}
interface ParsedStep {
    tool?: string;
    args?: Record<string, unknown>;
    final?: {
        message: string;
        document: unknown[] | null;
        anchors: Record<string, string> | null;
        targetDoc: string | null;
    };
}
/**
 * Parse a model step. Tolerates fences, leading/trailing junk, and partially
 * truncated finals by recovering message/document/anchors with field extractors.
 */
export declare function parseStep(raw: string): ParsedStep | null;
/** Agentic ReAct loop: investigate the code with tools, then draft the document. */
export declare function runAgentLoop(args: AgentLoopArgs): Promise<AgentLoopResult>;
export {};
