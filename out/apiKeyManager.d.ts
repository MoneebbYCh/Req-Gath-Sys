import * as vscode from 'vscode';
export declare function getApiKey(context: vscode.ExtensionContext): Promise<string | undefined>;
export declare function setApiKey(context: vscode.ExtensionContext, key: string): Promise<void>;
export declare function clearApiKey(context: vscode.ExtensionContext): Promise<void>;
export declare function promptForApiKey(context: vscode.ExtensionContext): Promise<string | undefined>;
export declare function ensureApiKey(context: vscode.ExtensionContext): Promise<string | undefined>;
