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
import { resolveWorkspaceRoot } from './workspaceRoot'
import { processChat } from './ai/agent'
import { processInlineChat } from './ai/inlineChat'
import { initDevLog, showDevLog, devLog } from './devLog'
import type { WebviewToExtensionMessage, ExtensionToWebviewMessage } from './protocol'

const log = (msg: string) => devLog(msg)

export function activate(context: vscode.ExtensionContext) {
  initDevLog(context)
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
    log(`message: ${msg.type}`)
    if (msg.type === 'loadWorkspaceInfo') {
      await ensureWorkspaceFolder()
      return
    }

    const ws = workspaceRoot()
    // No folder open: refuse to persist into the extension install directory.
    // Persistence and chat need a real workspace root.
    if (!ws) {
      log('no workspace folder — refusing to persist')
      if (msg.type === 'aiChatRequest') {
        postMessage({
          type: 'aiChatResponse',
          requestId: msg.requestId,
          kind: 'error',
          error: 'Open a folder to use Charter Ai.',
        })
        return
      }
      postMessage({
        type: 'chatStatus',
        text: 'Open a folder to use Charter Ai.',
      })
      return
    }

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
      case 'exportMarkdown': {
        const safeName =
          msg.suggestedName.replace(/[^\w\- ]+/g, '').trim() || 'document'
        const defaultUri = vscode.Uri.joinPath(vscode.Uri.file(ws), `${safeName}.md`)
        log(`export: suggested "${safeName}.md" in ${ws}`)
        const uri = await vscode.window.showSaveDialog({
          defaultUri,
          filters: { Markdown: ['md'] },
        })
        if (!uri) {
          log('export: cancelled by user')
          break
        }
        try {
          await vscode.workspace.fs.writeFile(
            uri,
            new TextEncoder().encode(msg.markdown),
          )
          log(`export: wrote ${uri.fsPath} (${msg.markdown.length} chars)`)
          vscode.window.showInformationMessage('Exported document to Markdown.')
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : String(err)
          log(`export: FAILED ${errorMsg}`)
          vscode.window.showErrorMessage(`Export failed: ${errorMsg}`)
        }
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
          postMessage({
            type: 'chatResponse',
            text: result.message,
            researchCheckpoint: result.researchCheckpoint ?? null,
          })
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : String(err)
          postMessage({ type: 'chatStatus', text: null })
          postMessage({ type: 'chatResponse', text: `Error: ${errorMsg}` })
        }
        break
      }
      case 'aiChatRequest': {
        try {
          const apiKey = (await getApiKey(context)) ?? ''
          const result = await processInlineChat({
            text: msg.text,
            context: msg.context,
            apiKey,
            workspaceRoot: ws,
          })
          postMessage({ type: 'aiChatResponse', requestId: msg.requestId, ...result })
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : String(err)
          log(`aiChat FAILED ${errorMsg}`)
          postMessage({
            type: 'aiChatResponse',
            requestId: msg.requestId,
            kind: 'error',
            error: errorMsg,
          })
        }
        break
      }
    }
  }

  function workspaceRoot(): string | null {
    // Never fall back to the extension install directory — that writes state
    // into the bundle location when no folder is open.
    return resolveWorkspaceRoot(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath)
  }

  /** Create `.charter-ai/` in the open folder (if needed) and tell the webview the path. */
  async function ensureWorkspaceFolder(): Promise<void> {
    const ws = workspaceRoot()
    if (!ws) {
      log('workspaceInfo: available=false (no folder)')
      postMessage({ type: 'workspaceInfo', path: '', name: '', available: false })
      return
    }
    try {
      await initWorkspace(ws)
    } catch {
      /* folder may be read-only; docs will surface errors later */
    }
    const folder = vscode.workspace.workspaceFolders?.[0]
    const fullPath = folder?.uri.fsPath ?? ws
    const name = folder?.name ?? path.basename(fullPath)
    postMessage({ type: 'workspaceInfo', path: fullPath, name, available: true })
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
          // window.alert / window.prompt are no-ops in the webview without this
          // (Save Template prompt and Export notifications silently died).
          allowModals: true,
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

    vscode.commands.registerCommand('charter-ai.showAgentLog', () => {
      showDevLog(false)
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
