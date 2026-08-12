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
exports.getApiKey = getApiKey;
exports.setApiKey = setApiKey;
exports.clearApiKey = clearApiKey;
exports.promptForApiKey = promptForApiKey;
exports.ensureApiKey = ensureApiKey;
const vscode = __importStar(require("vscode"));
const brand_1 = require("./brand");
const SECRET_KEY = 'charterAi.apiKey';
const LEGACY_SECRET_KEY = 'reqGathSys.apiKey';
async function getApiKey(context) {
    const key = await context.secrets.get(SECRET_KEY);
    if (key)
        return key;
    const legacy = await context.secrets.get(LEGACY_SECRET_KEY);
    if (legacy) {
        await context.secrets.store(SECRET_KEY, legacy);
        return legacy;
    }
    return undefined;
}
async function setApiKey(context, key) {
    await context.secrets.store(SECRET_KEY, key);
}
async function clearApiKey(context) {
    await context.secrets.delete(SECRET_KEY);
    await context.secrets.delete(LEGACY_SECRET_KEY);
}
async function promptForApiKey(context) {
    const existing = await getApiKey(context);
    const value = await vscode.window.showInputBox({
        title: `${brand_1.BRAND_NAME}: Configure API Key`,
        prompt: 'Enter your DeepSeek / Kimi / OpenAI-compatible API key',
        password: true,
        placeHolder: 'sk-...',
        value: existing ? '••••••••' : undefined,
        ignoreFocusOut: true,
    });
    if (value === undefined)
        return undefined;
    if (!value || value === '••••••••')
        return existing;
    await setApiKey(context, value.trim());
    vscode.window.showInformationMessage(`${brand_1.BRAND_NAME} API key saved securely.`);
    return value.trim();
}
async function ensureApiKey(context) {
    const key = await getApiKey(context);
    if (key)
        return key;
    return promptForApiKey(context);
}
