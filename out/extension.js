"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = __importStar(require("vscode"));
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const apiKeyManager_1 = require("./apiKeyManager");
const formStateManager_1 = require("./formStateManager");
const agent_1 = require("./ai/agent");
function activate(context) {
    let panel;
    function getHtml(webview) {
        const distPath = path.join(context.extensionPath, 'dist', 'index.html');
        let html = fs.readFileSync(distPath, 'utf8');
        const rootUri = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'dist'));
        html = html.replace(/(src|href)=["']\.\/assets\//g, `$1="${rootUri}/assets/`);
        const csp = [
            `default-src 'none'`,
            `style-src ${webview.cspSource} 'unsafe-inline' https://fonts.googleapis.com`,
            `font-src ${webview.cspSource} data: https://fonts.gstatic.com`,
            `script-src ${webview.cspSource}`,
            `img-src ${webview.cspSource} data: blob:`,
            `worker-src ${webview.cspSource} blob:`,
            `connect-src ${webview.cspSource}`,
            `wasm-src ${webview.cspSource} blob:`,
        ].join('; ');
        html = html.replace('<head>', `<head><meta http-equiv="Content-Security-Policy" content="${csp}">`);
        return html;
    }
    function postMessage(msg) {
        panel?.webview.postMessage(msg);
    }
    async function handleMessage(msg) {
        const ws = workspaceRoot();
        switch (msg.type) {
            case 'loadDocTypes': {
                const data = await (0, formStateManager_1.loadDocTypes)(ws);
                postMessage({ type: 'loadDocTypes', data });
                break;
            }
            case 'saveDocTypes': {
                await (0, formStateManager_1.saveDocTypes)(ws, msg.data);
                break;
            }
            case 'loadCanvas': {
                const data = await (0, formStateManager_1.loadForm)(ws, msg.phase);
                postMessage({ type: 'loadCanvas', phase: msg.phase, data });
                break;
            }
            case 'saveCanvas': {
                await (0, formStateManager_1.saveForm)(ws, msg.phase, msg.data);
                break;
            }
            case 'loadWorkspaceInfo': {
                await ensureWorkspaceFolder();
                break;
            }
            case 'chatMessage': {
                try {
                    // Optional: SecretStorage key. If empty, llmClient falls back to the
                    // DEEPSEEK_API_KEY / MOONSHOT_API_KEY / generic env variables.
                    const apiKey = (await (0, apiKeyManager_1.getApiKey)(context)) ?? '';
                    const result = await (0, agent_1.processChat)({
                        text: msg.text,
                        phase: msg.phase,
                        workspaceRoot: ws,
                        apiKey,
                        history: Array.isArray(msg.history) ? msg.history : [],
                        onStatus: (text) => postMessage({ type: 'chatStatus', text }),
                        onDocTypesChanged: (data, mode) => postMessage({ type: 'loadDocTypes', data, mode }),
                    });
                    if (result.reload?.type === 'load_canvas' && result.reload.phase) {
                        postMessage({
                            type: 'loadCanvas',
                            phase: result.reload.phase,
                            data: result.reload.data,
                        });
                    }
                    postMessage({ type: 'chatStatus', text: null });
                    postMessage({ type: 'chatResponse', text: result.message });
                }
                catch (err) {
                    const errorMsg = err instanceof Error ? err.message : String(err);
                    postMessage({ type: 'chatStatus', text: null });
                    postMessage({ type: 'chatResponse', text: `Error: ${errorMsg}` });
                }
                break;
            }
        }
    }
    function workspaceRoot() {
        const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (folder)
            return folder;
        return context.extensionPath;
    }
    /** Create `.charter-ai/` in the open folder (if needed) and tell the webview the path. */
    async function ensureWorkspaceFolder() {
        const ws = workspaceRoot();
        try {
            await (0, formStateManager_1.initWorkspace)(ws);
        }
        catch {
            /* folder may be read-only; docs will surface errors later */
        }
        const folder = vscode.workspace.workspaceFolders?.[0];
        const fullPath = folder?.uri.fsPath ?? ws;
        const name = folder?.name ?? path.basename(fullPath);
        postMessage({ type: 'workspaceInfo', path: fullPath, name });
    }
    context.subscriptions.push(vscode.commands.registerCommand('charter-ai.openPipeline', async () => {
        if (panel) {
            panel.reveal(vscode.ViewColumn.One);
            await ensureWorkspaceFolder();
            return;
        }
        panel = vscode.window.createWebviewPanel('charterAiPanel', 'Charter Ai', vscode.ViewColumn.One, {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist')],
        });
        panel.webview.html = getHtml(panel.webview);
        panel.webview.onDidReceiveMessage(handleMessage);
        panel.onDidDispose(() => {
            panel = undefined;
        });
        await ensureWorkspaceFolder();
    }), vscode.workspace.onDidChangeWorkspaceFolders(() => {
        void ensureWorkspaceFolder();
    }), vscode.commands.registerCommand('charter-ai.configureApiKey', async () => {
        await (0, apiKeyManager_1.promptForApiKey)(context);
    }), vscode.commands.registerCommand('charter-ai.initializeWorkspace', async () => {
        const ws = workspaceRoot();
        if (!ws) {
            vscode.window.showErrorMessage('Open a workspace first.');
            return;
        }
        try {
            const created = await (0, formStateManager_1.initWorkspace)(ws);
            if (created) {
                vscode.window.showInformationMessage('Charter Ai workspace initialized!');
            }
            else {
                vscode.window.showInformationMessage('Charter Ai already initialized in this workspace.');
            }
        }
        catch (err) {
            const errorMsg = err instanceof Error ? err.message : String(err);
            vscode.window.showErrorMessage(`Failed to initialize workspace: ${errorMsg}`);
        }
    }));
}
function deactivate() { }
