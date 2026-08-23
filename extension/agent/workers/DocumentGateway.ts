import type { DocumentIR } from '../../documents/DocumentIR'

/**
 * Worker-side document gateway (plan §11/§12): typed RPC surface the document
 * worker uses to create documents and checkpoint sections host-side. Kept
 * vscode-free — the host implements it through DocumentService.
 */

export interface CreatedDocType {
  id: string
  name: string
  icon: string
  created: boolean
}

export interface CheckpointResult {
  ok: boolean
  revision: number
  conflict: boolean
  pendingDraftId?: string
  error?: string
}

export interface DocumentGateway {
  /** Create a document type in the canonical registry + an empty canvas. */
  create(name: string, icon?: string): Promise<CreatedDocType>
  /** Revision-safe full-document checkpoint (user edits win on conflict). */
  checkpoint(documentId: string, baseRevision: number, ir: DocumentIR): Promise<CheckpointResult>
  /**
   * Load the agent's latest stored IR for targeted section regeneration
   * (plan §13) plus the current host revision to checkpoint against. Null
   * when the document has no agent IR yet.
   */
  loadIR(documentId: string): Promise<{ ir: DocumentIR; revision: number } | null>
}
