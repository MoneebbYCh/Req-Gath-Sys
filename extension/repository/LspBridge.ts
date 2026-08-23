import * as vscode from 'vscode'

/**
 * Host-side LSP execution surface (plan §11). The agent worker cannot touch
 * VS Code language providers — the host exposes them through this narrow
 * bridge and the existing repository-tool RPC. Kept string/shape-based so the
 * tool layer (and tests) never import `vscode`.
 */

/** Normalized location, 1-based lines/columns (tool-facing convention). */
export interface LspLocation {
  /** Absolute filesystem path. */
  path: string
  startLine: number
  startColumn: number
  endLine: number
  endColumn: number
  /** Symbol name, when the provider supplies one. */
  name?: string
}

export interface LspDocumentSymbol {
  name: string
  kind: string
  startLine: number
  endLine: number
}

export interface LspDiagnostic {
  severity: 'error' | 'warning' | 'information' | 'hint'
  line: number
  message: string
  source?: string
  code?: string | number
}

/** Plan §11: call hierarchy (where the language provider supports it). */
export interface CallHierarchyEntry {
  /** Caller/called symbol name. */
  name: string
  location: LspLocation
  /** The related call sites (callee locations for incoming, caller for outgoing). */
  fromRanges: LspLocation[]
}

export interface CallHierarchyResult {
  incoming: CallHierarchyEntry[]
  outgoing: CallHierarchyEntry[]
}

/** Abstraction over VS Code language providers; tests provide a fake. */
export interface LspBridge {
  workspaceSymbols(query: string, signal: AbortSignal): Promise<LspLocation[]>
  documentSymbols(absolutePath: string, signal: AbortSignal): Promise<LspDocumentSymbol[]>
  definition(
    absolutePath: string,
    line: number,
    column: number,
    signal: AbortSignal,
  ): Promise<LspLocation[]>
  references(
    absolutePath: string,
    line: number,
    column: number,
    signal: AbortSignal,
  ): Promise<LspLocation[]>
  implementations(
    absolutePath: string,
    line: number,
    column: number,
    signal: AbortSignal,
  ): Promise<LspLocation[]>
  /** Plan §11 "call hierarchy where supported" — empty lists when unsupported. */
  callHierarchy(
    absolutePath: string,
    line: number,
    column: number,
    signal: AbortSignal,
  ): Promise<CallHierarchyResult>
  diagnostics(absolutePath: string, signal: AbortSignal): Promise<LspDiagnostic[]>
  /** Cheap global probe: does any workspace-symbol provider exist? */
  probeWorkspaceSymbols(signal: AbortSignal): Promise<{ available: boolean }>
}

const DIAGNOSTIC_SEVERITY: Record<vscode.DiagnosticSeverity, LspDiagnostic['severity']> = {
  0: 'error',
  1: 'warning',
  2: 'information',
  3: 'hint',
}

function toLspLocation(location: vscode.Location): LspLocation {
  return {
    path: location.uri.fsPath,
    startLine: location.range.start.line + 1,
    startColumn: location.range.start.character + 1,
    endLine: location.range.end.line + 1,
    endColumn: location.range.end.character + 1,
  }
}

function locationLinks(location: vscode.LocationLink): LspLocation {
  const range = location.targetRange
  return {
    path: location.targetUri.fsPath,
    startLine: range.start.line + 1,
    startColumn: range.start.character + 1,
    endLine: range.end.line + 1,
    endColumn: range.end.character + 1,
  }
}

/**
 * Real VS Code implementation. Every command is raced against the task signal
 * — a hung language server must not block the gateway forever (plan §9:
 * no outbound call without a timeout).
 */
export class VscodeLspBridge implements LspBridge {
  private symbolsProbe: { available: boolean } | null = null

  async workspaceSymbols(query: string, signal: AbortSignal): Promise<LspLocation[]> {
    const symbols = await this.run(
      vscode.commands.executeCommand<vscode.SymbolInformation[]>(
        'vscode.executeWorkspaceSymbolProvider',
        query,
      ),
      signal,
    )
    return symbols.map((s) => ({
      path: s.location.uri.fsPath,
      startLine: s.location.range.start.line + 1,
      startColumn: s.location.range.start.character + 1,
      endLine: s.location.range.end.line + 1,
      endColumn: s.location.range.end.character + 1,
      name: s.name,
    }))
  }

  async documentSymbols(absolutePath: string, signal: AbortSignal): Promise<LspDocumentSymbol[]> {
    const symbols = await this.run(
      vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
        'vscode.executeDocumentSymbolProvider',
        vscode.Uri.file(absolutePath),
      ),
      signal,
    )
    const flat: LspDocumentSymbol[] = []
    const walk = (list: vscode.DocumentSymbol[]): void => {
      for (const s of list) {
        flat.push({
          name: s.name,
          kind: vscode.SymbolKind[s.kind] ?? String(s.kind),
          startLine: s.range.start.line + 1,
          endLine: s.range.end.line + 1,
        })
        walk(s.children)
      }
    }
    walk(symbols)
    return flat
  }

  async definition(
    absolutePath: string,
    line: number,
    column: number,
    signal: AbortSignal,
  ): Promise<LspLocation[]> {
    const result = await this.run(
      vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>(
        'vscode.executeDefinitionProvider',
        vscode.Uri.file(absolutePath),
        new vscode.Position(line - 1, column - 1),
      ),
      signal,
    )
    return result.map((r) => ('uri' in r ? toLspLocation(r) : locationLinks(r)))
  }

  async references(
    absolutePath: string,
    line: number,
    column: number,
    signal: AbortSignal,
  ): Promise<LspLocation[]> {
    const result = await this.run(
      vscode.commands.executeCommand<vscode.Location[]>(
        'vscode.executeReferenceProvider',
        vscode.Uri.file(absolutePath),
        new vscode.Position(line - 1, column - 1),
      ),
      signal,
    )
    return result.map(toLspLocation)
  }

  async implementations(
    absolutePath: string,
    line: number,
    column: number,
    signal: AbortSignal,
  ): Promise<LspLocation[]> {
    const result = await this.run(
      vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>(
        'vscode.executeImplementationProvider',
        vscode.Uri.file(absolutePath),
        new vscode.Position(line - 1, column - 1),
      ),
      signal,
    )
    return result.map((r) => ('uri' in r ? toLspLocation(r) : locationLinks(r)))
  }

  async diagnostics(absolutePath: string, signal: AbortSignal): Promise<LspDiagnostic[]> {
    const result = this.run(
      Promise.resolve(vscode.languages.getDiagnostics(vscode.Uri.file(absolutePath))),
      signal,
    )
    return (await result).map((d) => ({
      severity: DIAGNOSTIC_SEVERITY[d.severity] ?? 'information',
      line: d.range.start.line + 1,
      message: d.message,
      source: d.source,
      code: typeof d.code === 'object' && d.code !== null ? String(d.code.value) : d.code,
    }))
  }

  /**
   * Plan §11 "call hierarchy where supported": uses the standard VS Code
   * commands; providers without support simply return empty/undefined and
   * degrade at the tool layer.
   */
  async callHierarchy(
    absolutePath: string,
    line: number,
    column: number,
    signal: AbortSignal,
  ): Promise<CallHierarchyResult> {
    const uri = vscode.Uri.file(absolutePath)
    const position = new vscode.Position(line - 1, column - 1)
    const items = await this.run(
      vscode.commands.executeCommand<vscode.CallHierarchyItem[]>(
        'vscode.prepareCallHierarchy',
        uri,
        position,
      ),
      signal,
    )
    if (!items || items.length === 0) return { incoming: [], outgoing: [] }
    const item = items[0]
    const incoming = await this.run(
      vscode.commands.executeCommand<vscode.CallHierarchyIncomingCall[]>(
        'vscode.provideIncomingCalls',
        item,
      ),
      signal,
    )
    const outgoing = await this.run(
      vscode.commands.executeCommand<vscode.CallHierarchyOutgoingCall[]>(
        'vscode.provideOutgoingCalls',
        item,
      ),
      signal,
    )
    return {
      incoming: incoming.map((call) => ({
        name: call.from.name,
        location: toLspLocation(new vscode.Location(call.from.uri, call.from.selectionRange)),
        fromRanges: call.fromRanges.map((r) => toLspLocation(new vscode.Location(call.from.uri, r))),
      })),
      outgoing: outgoing.map((call) => ({
        name: call.to.name,
        location: toLspLocation(new vscode.Location(call.to.uri, call.to.selectionRange)),
        fromRanges: call.fromRanges.map((r) => toLspLocation(new vscode.Location(call.to.uri, r))),
      })),
    }
  }

  async probeWorkspaceSymbols(signal: AbortSignal): Promise<{ available: boolean }> {
    if (this.symbolsProbe) return this.symbolsProbe
    try {
      await this.run(
        vscode.commands.executeCommand('vscode.executeWorkspaceSymbolProvider', '__charter_ai_probe__'),
        signal,
      )
      this.symbolsProbe = { available: true }
    } catch {
      this.symbolsProbe = { available: false }
    }
    return this.symbolsProbe
  }

  /** Races a command against the signal; abort wins with a friendly error. */
  private async run<T>(promise: Thenable<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) throw new Error('LSP call cancelled.')
    return new Promise<T>((resolve, reject) => {
      const onAbort = (): void => reject(new Error('LSP call cancelled.'))
      signal.addEventListener('abort', onAbort, { once: true })
      promise.then(
        (v) => {
          signal.removeEventListener('abort', onAbort)
          resolve(v)
        },
        (err) => {
          signal.removeEventListener('abort', onAbort)
          reject(err instanceof Error ? err : new Error(String(err)))
        },
      )
    })
  }
}
