/** Shared document-deliverable intent used by routing and planning. */
export const DOCUMENT_REQUEST =
  /\b(?:create|generate|write|produce|draft|build|prepare|need|want|require)\b[^.!?\n]{0,100}\b(?:documents?|docs?|documentation|prd|spec(?:ification)?)\b/i

/** A request that must produce an editable document, never chat-only prose. */
export function hasDocumentIntent(text: string): boolean {
  return DOCUMENT_REQUEST.test(text)
}
