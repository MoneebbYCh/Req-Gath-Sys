import * as vscode from 'vscode'
import * as fs from 'fs'
import * as path from 'path'
import { getApiKey, promptForApiKey } from './apiKeyManager'
import {
  initWorkspace,
  loadDocTypes,
  loadForm,
  saveDocTypes,
  saveForm,
} from './formStateManager'
import { processChat } from './ai/agent'
import type { WebviewToExtensionMessage, ExtensionToWebviewMessage } from './protocol'

export function activate(context: vscode.ExtensionContext) {
  let panel: vscode.WebviewPanel | undefined

  function getHtml(webview: vscode.Webview): string {
    const distPath = path.join(context.extensionPath, 'dist', 'index.html')
    let html = fs.readFileSync(distPath, 'utf8')

    const rootUri = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'dist'))

    html = html.replace(/(src|href)=["']\.\/assets\//g, `$1="${rootUri}/assets/`)

    const csp = [
      `default-src 'none'`,
      `style-src ${webview.cspSource} 'unsafe-inline' https://fonts.googleapis.com`,
      `font-src ${webview.cspSource} data: https://fonts.gstatic.com`,
      `script-src ${webview.cspSource}`,
      `img-src ${webview.cspSource} data: blob:`,
      `worker-src ${webview.cspSource} blob:`,
      `connect-src ${webview.cspSource}`,
      `wasm-src ${webview.cspSource} blob:`,
    ].join('; ')

    html = html.replace('<head>', `<head><meta http-equiv="Content-Security-Policy" content="${csp}">`)

    return html
  }

  function postMessage(msg: ExtensionToWebviewMessage): void {
    panel?.webview.postMessage(msg)
  }

  async function handleMessage(msg: WebviewToExtensionMessage): Promise<void> {
    const ws = workspaceRoot()

    switch (msg.type) {
      case 'loadDocTypes': {
        const data = await loadDocTypes(ws)
        postMessage({ type: 'loadDocTypes', data })
        break
      }
      case 'saveDocTypes': {
        await saveDocTypes(ws, msg.data)
        break
      }
      case 'loadCanvas': {
        const data = await loadForm(ws, msg.phase)
        postMessage({ type: 'loadCanvas', phase: msg.phase, data })
        break
      }
      case 'saveCanvas': {
        await saveForm(ws, msg.phase, msg.data)
        break
      }
      case 'loadWorkspaceInfo': {
        await ensureWorkspaceFolder()
        break
      }
      case 'chatMessage': {
        try {
          // Optional: SecretStorage key. If empty, llmClient falls back to the
          // DEEPSEEK_API_KEY / MOONSHOT_API_KEY / generic env variables.
          const apiKey = (await getApiKey(context)) ?? ''

          const result = await processChat({
            text: msg.text,
            phase: msg.phase,
            workspaceRoot: ws,
            apiKey,
            history: Array.isArray(msg.history) ? msg.history : [],
            onStatus: (text) => postMessage({ type: 'chatStatus', text }),
            onDocTypesChanged: (data, mode) =>
              postMessage({ type: 'loadDocTypes', data, mode }),
          })

          if (result.reload?.type === 'load_canvas' && result.reload.phase) {
            postMessage({
              type: 'loadCanvas',
              phase: result.reload.phase,
              data: result.reload.data,
            })
          }

          postMessage({ type: 'chatStatus', text: null })
          postMessage({ type: 'chatResponse', text: result.message })
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : String(err)
          postMessage({ type: 'chatStatus', text: null })
          postMessage({ type: 'chatResponse', text: `Error: ${errorMsg}` })
        }
        break
      }
    }
  }

  function workspaceRoot(): string {
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
    if (folder) return folder
    return context.extensionPath
  }

  /** Create `.charter-ai/` in the open folder (if needed) and tell the webview the path. */
  async function ensureWorkspaceFolder(): Promise<void> {
    const ws = workspaceRoot()
    try {
      await initWorkspace(ws)
    } catch {
      /* folder may be read-only; docs will surface errors later */
    }
    const folder = vscode.workspace.workspaceFolders?.[0]
    const fullPath = folder?.uri.fsPath ?? ws
    const name = folder?.name ?? path.basename(fullPath)
    postMessage({ type: 'workspaceInfo', path: fullPath, name })
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('charter-ai.openPipeline', async () => {
      if (panel) {
        panel.reveal(vscode.ViewColumn.One)
        await ensureWorkspaceFolder()
        return
      }

      panel = vscode.window.createWebviewPanel(
        'charterAiPanel',
        'Charter Ai',
        vscode.ViewColumn.One,
        {
          enableScripts: true,
          retainContextWhenHidden: true,
          localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist')],
        },
      )

      panel.webview.html = getHtml(panel.webview)

      panel.webview.onDidReceiveMessage(handleMessage)

      panel.onDidDispose(() => {
        panel = undefined
      })

      await ensureWorkspaceFolder()
    }),

    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      void ensureWorkspaceFolder()
    }),

    vscode.commands.registerCommand('charter-ai.configureApiKey', async () => {
      await promptForApiKey(context)
    }),

    vscode.commands.registerCommand('charter-ai.initializeWorkspace', async () => {
      const ws = workspaceRoot()
      if (!ws) { vscode.window.showErrorMessage('Open a workspace first.'); return }

      try {
        const created = await initWorkspace(ws)
        if (created) {
          vscode.window.showInformationMessage('Charter Ai workspace initialized!')
        } else {
          vscode.window.showInformationMessage('Charter Ai already initialized in this workspace.')
        }
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err)
        vscode.window.showErrorMessage(`Failed to initialize workspace: ${errorMsg}`)
      }
    }),
  )
}

export function deactivate() {}
