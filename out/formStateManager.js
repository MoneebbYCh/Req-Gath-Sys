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
exports.initWorkspace = initWorkspace;
exports.loadConfig = loadConfig;
exports.saveConfig = saveConfig;
exports.loadForm = loadForm;
exports.saveForm = saveForm;
exports.loadDocTypes = loadDocTypes;
exports.saveDocTypes = saveDocTypes;
exports.docLabelFor = docLabelFor;
const vscode = __importStar(require("vscode"));
const path = __importStar(require("path"));
const brand_1 = require("./brand");
const CONFIG_FILE = 'config.json';
const DOC_TYPES_FILE = 'doc-types.json';
/** Resolve the on-disk filename for any document id. */
function fileNameForPhase(phase) {
    const safe = phase.replace(/[^a-zA-Z0-9._-]/g, '-').replace(/^-+|-+$/g, '');
    return safe ? `${safe}.json` : null;
}
function defaultConfig() {
    return {
        llm: { provider: 'deepseek', model: null },
    };
}
function primaryStateDir(workspaceRoot) {
    return path.join(workspaceRoot, brand_1.STATE_DIR);
}
function legacyStateDir(workspaceRoot) {
    return path.join(workspaceRoot, brand_1.LEGACY_STATE_DIR);
}
async function ensureDir(dir) {
    try {
        await vscode.workspace.fs.stat(vscode.Uri.file(dir));
    }
    catch {
        await vscode.workspace.fs.createDirectory(vscode.Uri.file(dir));
    }
}
async function pathExists(target) {
    try {
        await vscode.workspace.fs.stat(vscode.Uri.file(target));
        return true;
    }
    catch {
        return false;
    }
}
async function readJson(filePath) {
    try {
        const uri = vscode.Uri.file(filePath);
        const bytes = await vscode.workspace.fs.readFile(uri);
        return JSON.parse(new TextDecoder().decode(bytes));
    }
    catch {
        return null;
    }
}
async function writeJson(filePath, data) {
    await ensureDir(path.dirname(filePath));
    const uri = vscode.Uri.file(filePath);
    const bytes = new TextEncoder().encode(JSON.stringify(data, null, 2));
    await vscode.workspace.fs.writeFile(uri, bytes);
}
/** Prefer `.charter-ai/`; fall back to legacy `.req-gath-sys/` for reads. */
async function readStateJson(workspaceRoot, filename) {
    const primary = await readJson(path.join(primaryStateDir(workspaceRoot), filename));
    if (primary !== null)
        return primary;
    return readJson(path.join(legacyStateDir(workspaceRoot), filename));
}
async function initWorkspace(workspaceRoot) {
    const dir = primaryStateDir(workspaceRoot);
    if (await pathExists(dir))
        return false;
    // Already initialized under the legacy folder counts as initialized.
    if (await pathExists(legacyStateDir(workspaceRoot)))
        return false;
    await ensureDir(dir);
    const configPath = path.join(dir, CONFIG_FILE);
    if (!(await pathExists(configPath))) {
        await writeJson(configPath, defaultConfig());
    }
    return true;
}
async function loadConfig(workspaceRoot) {
    const data = await readStateJson(workspaceRoot, CONFIG_FILE);
    if (data && typeof data === 'object')
        return data;
    return defaultConfig();
}
async function saveConfig(workspaceRoot, config) {
    await writeJson(path.join(primaryStateDir(workspaceRoot), CONFIG_FILE), config);
}
async function loadForm(workspaceRoot, phase) {
    const filename = fileNameForPhase(phase);
    if (!filename)
        return null;
    return readStateJson(workspaceRoot, filename);
}
async function saveForm(workspaceRoot, phase, data) {
    const filename = fileNameForPhase(phase);
    if (!filename)
        throw new Error(`Unknown phase: ${phase}`);
    await writeJson(path.join(primaryStateDir(workspaceRoot), filename), data);
}
/** Document-type definitions for the workspace. */
async function loadDocTypes(workspaceRoot) {
    const data = await readStateJson(workspaceRoot, DOC_TYPES_FILE);
    return Array.isArray(data) ? data : [];
}
async function saveDocTypes(workspaceRoot, data) {
    await writeJson(path.join(primaryStateDir(workspaceRoot), DOC_TYPES_FILE), data);
}
/** Human-readable label for a document id from doc-types.json. */
async function docLabelFor(workspaceRoot, phase) {
    const types = await loadDocTypes(workspaceRoot);
    const match = types.find((t) => Boolean(t) && typeof t === 'object' && t.id === phase);
    return match && typeof match.name === 'string' ? match.name : null;
}
