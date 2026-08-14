import { useEffect, useRef, useState } from 'react'
import { createReactBlockSpec } from '@blocknote/react'
import { BlockActions, deleteCanvasBlock } from '../BlockActions'
import { getVscodeApi } from '../../../utils/vscodeApi'
import {
  resolveAiChatPlan,
  blockText,
  type BlockLike,
} from '../aiChatCore'
import type { AiChatContextPayload, AiChatResponsePayload } from '../../../../extension/protocol'

const TIMEOUT_MS = 180_000
const MAX_REQUEST_CHARS = 2_000

type AiChatState =
  | { phase: 'idle' }
  | { phase: 'loading'; requestText: string }
  | { phase: 'answer'; text: string }
  | { phase: 'clarify'; question: string; originalText: string }
  | { phase: 'error'; message: string; retryText?: string }
  | { phase: 'redirect'; note: string; requestText: string }
  | { phase: 'done'; note?: string; focusId?: string }

/** Minimal structural editor surface the block needs (kept type-light like Callout). */
interface EditorOps {
  document: BlockLike[]
  removeBlocks: (blocks: { id: string }[]) => void
  replaceBlocks: (ids: string[], blocks: unknown[]) => void
  insertBlocks: (blocks: unknown[], ref: string, placement: 'before' | 'after') => unknown[]
  tryParseMarkdownToBlocks: (markdown: string) => { id?: string }[]
  setTextCursorPosition: (id: string, placement: 'start' | 'end') => void
}

function nextRequestId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

function AiChatView(props: {
  block: { id?: string; props: { placeholder?: string; contextJson?: string } }
  editor: unknown
}) {
  const editor = props.editor as EditorOps
  const blockId = String(props.block.id ?? '')
  const placeholder = String(props.block.props.placeholder || 'Ask AI what you would like to change or create…')
  const ctx = useRef<AiChatContextPayload>(
    (() => {
      try {
        const parsed = JSON.parse(String(props.block.props.contextJson || '{}'))
        return parsed && typeof parsed === 'object' ? parsed : {}
      } catch {
        return {}
      }
    })(),
  ).current

  const [state, setState] = useState<AiChatState>({ phase: 'idle' })
  const [input, setInput] = useState('')
  const inputRef = useRef<HTMLTextAreaElement | null>(null)
  // The in-flight request, so late responses and retries know what was sent.
  const pendingRef = useRef<{ requestId: string; text: string } | null>(null)
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const removeBlock = () => {
    const block = editor.document.find((b) => String(b.id) === blockId)
    if (block) editor.removeBlocks([block])
  }

  const clearPending = () => {
    pendingRef.current = null
    if (timeoutRef.current) clearTimeout(timeoutRef.current)
    timeoutRef.current = null
  }

  const submit = (text: string) => {
    const trimmed = text.trim()
    if (!trimmed || trimmed.length > MAX_REQUEST_CHARS) return
    const requestId = nextRequestId()
    pendingRef.current = { requestId, text: trimmed }
    setState({ phase: 'loading', requestText: trimmed })
    setInput('')
    clearTimeout(timeoutRef.current ?? undefined)
    timeoutRef.current = setTimeout(() => {
      if (pendingRef.current?.requestId === requestId) {
        pendingRef.current = null
        setState({
          phase: 'error',
          message: 'No response received. Check your API key (Charter Ai: Configure API Key) and try again.',
        })
      }
    }, TIMEOUT_MS)
    getVscodeApi()?.postMessage({ type: 'aiChatRequest', requestId, text: trimmed, context: ctx })
  }

  /** Apply a modify/insert result. Returns focus target + deviation note, null on failure. */
  const applyResult = (
    result: AiChatResponsePayload,
  ): { focusId?: string; note?: string } | null => {
    if (!result.markdown) return null
    let blocks: { id: string }[]
    try {
      blocks = editor.tryParseMarkdownToBlocks(result.markdown)
    } catch {
      return null
    }
    if (!blocks.length) return null

    const liveBlocks = editor.document.map((b) => ({ id: String(b.id) }))
    const cursorLiveText = ctx.cursorBlock
      ? blockText(editor.document.find((b) => String(b.id) === ctx.cursorBlock?.id))
      : undefined
    const plan = resolveAiChatPlan(result, ctx, blockId, { liveBlocks, cursorLiveText })

    try {
      if (plan.mode === 'replace') {
        editor.replaceBlocks(plan.removeIds, blocks)
      } else if (plan.mode === 'after-chat') {
        const ref =
          editor.document.find((b) => String(b.id) === blockId) ??
          editor.document[editor.document.length - 1]
        if (!ref) return null
        editor.insertBlocks(blocks, String(ref.id), 'after')
      } else {
        return null
      }
    } catch {
      return null
    }
    return { focusId: blocks[0]?.id, note: plan.note ?? undefined }
  }

  const handleResponse = (msg: AiChatResponsePayload) => {
    const sentText = pendingRef.current?.text ?? ''
    clearPending()
    switch (msg.kind) {
      case 'clarify':
        setState({ phase: 'clarify', question: msg.question ?? '', originalText: sentText })
        break
      case 'answer':
        setState({ phase: 'answer', text: msg.text ?? '' })
        break
      case 'modify':
      case 'insert': {
        const applied = applyResult(msg)
        if (applied === null) {
          setState({ phase: 'error', message: 'The AI result could not be applied to the document.', retryText: sentText })
        } else {
          setState({ phase: 'done', note: applied.note, focusId: applied.focusId })
        }
        break
      }
      case 'error':
        setState({ phase: 'error', message: msg.error ?? 'Something went wrong.', retryText: sentText })
        break
      case 'redirect':
        // Hand off to the full agent: it has file tools and can act on the code.
        setState({ phase: 'redirect', note: msg.text ?? '', requestText: sentText })
        break
    }
  }

  // Route responses by requestId; ignore late responses after dismissal/cancel.
  useEffect(() => {
    const handler = (event: MessageEvent) => {
      const msg = event.data
      if (msg?.type !== 'aiChatResponse') return
      if (pendingRef.current && msg.requestId === pendingRef.current.requestId) {
        handleResponse(msg)
      }
    }
    window.addEventListener('message', handler)
    return () => {
      window.removeEventListener('message', handler)
      clearPending()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // "✓ Done" flash, then the block removes itself and focus lands on new content.
  useEffect(() => {
    if (state.phase !== 'done') return
    const t = setTimeout(() => {
      removeBlock()
      if (state.focusId) {
        try {
          editor.setTextCursorPosition(state.focusId, 'start')
        } catch {
          /* focus fallback: leave cursor where it is */
        }
      }
    }, 2_000)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.phase])

  // Autofocus the input whenever it becomes editable.
  useEffect(() => {
    if (state.phase === 'idle' || state.phase === 'clarify') {
      requestAnimationFrame(() => {
        const el = inputRef.current
        if (el) {
          el.focus()
          el.setSelectionRange(el.value.length, el.value.length)
        }
      })
    }
  }, [state.phase])

  const cancel = () => {
    if (state.phase === 'loading') {
      clearPending()
      setState({ phase: 'idle' })
      return
    }
    removeBlock()
  }

  const retryText = state.phase === 'error' ? state.retryText : undefined

  /** Open the main agent chat with the original request (AppShell listens). */
  const redirectToAgent = () => {
    const text = state.phase === 'redirect' ? state.requestText : ''
    removeBlock()
    window.dispatchEvent(
      new CustomEvent('charter-ai:redirect-chat', { detail: { text } }),
    )
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      e.stopPropagation()
      if (state.phase === 'idle') submit(input)
      else if (state.phase === 'clarify') {
        submit(`${state.originalText}\n\nClarification: ${state.question}\nAnswer: ${input}`)
      }
    } else if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      cancel()
    }
  }

  return (
    <div className={`rg-ai-chat rg-ai-chat--${state.phase}`}>
      <BlockActions
        actions={[
          {
            label: 'Delete',
            tone: 'danger',
            onClick: () =>
              deleteCanvasBlock(
                editor as unknown as { removeBlocks: (blocks: unknown[]) => void },
                props.block,
              ),
          },
        ]}
      />
      {state.phase === 'idle' || state.phase === 'clarify' ? (
        <>
          {state.phase === 'clarify' ? (
            <p className="rg-ai-chat-clarify" aria-live="polite">
              {state.question}
            </p>
          ) : null}
          <div className="rg-ai-chat-row">
            <textarea
              ref={inputRef}
              className="rg-ai-chat-input"
              value={input}
              rows={1}
              placeholder={state.phase === 'clarify' ? 'Your answer…' : placeholder}
              aria-label={state.phase === 'clarify' ? 'Answer the clarification' : 'Ask AI'}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKeyDown}
            />
            <button
              type="button"
              className="rg-ai-chat-btn"
              disabled={!input.trim() || input.trim().length > MAX_REQUEST_CHARS}
              onClick={() =>
                state.phase === 'idle'
                  ? submit(input)
                  : submit(`${state.originalText}\n\nClarification: ${state.question}\nAnswer: ${input}`)
              }
            >
              {state.phase === 'clarify' ? 'Answer' : 'Ask'}
            </button>
            <button type="button" className="rg-ai-chat-btn rg-ai-chat-btn--ghost" onClick={cancel} aria-label="Dismiss">
              ✕
            </button>
          </div>
          <p className="rg-ai-chat-hint">Enter to ask · Shift+Enter for a new line · Esc to dismiss</p>
        </>
      ) : null}

      {state.phase === 'loading' ? (
        <div className="rg-ai-chat-status" aria-live="polite">
          <span className="rg-ai-chat-spinner" aria-hidden />
          <span className="rg-ai-chat-request">“{state.requestText}”</span>
          <button type="button" className="rg-ai-chat-btn rg-ai-chat-btn--ghost" onClick={cancel} aria-label="Cancel">
            Cancel
          </button>
        </div>
      ) : null}

      {state.phase === 'answer' ? (
        <div className="rg-ai-chat-status" aria-live="polite">
          <p className="rg-ai-chat-answer">{state.text}</p>
          <div className="rg-ai-chat-row rg-ai-chat-row--end">
            <button
              type="button"
              className="rg-ai-chat-btn"
              onClick={() => {
                try {
                  const ref =
                    editor.document.find((b) => String(b.id) === blockId) ??
                    editor.document[editor.document.length - 1]
                  if (ref) {
                    editor.insertBlocks(
                      [{ type: 'callout', props: { variant: 'info', title: 'AI answer' }, content: state.text }],
                      String(ref.id),
                      'after',
                    )
                  }
                } catch {
                  /* keep the answer visible; the note is optional */
                }
                removeBlock()
              }}
            >
              Add as note
            </button>
            <button type="button" className="rg-ai-chat-btn rg-ai-chat-btn--ghost" onClick={removeBlock}>
              Done
            </button>
          </div>
        </div>
      ) : null}

      {state.phase === 'error' ? (
        <div className="rg-ai-chat-status" aria-live="polite">
          <p className="rg-ai-chat-error">{state.message}</p>
          <div className="rg-ai-chat-row rg-ai-chat-row--end">
            {retryText ? (
              <button
                type="button"
                className="rg-ai-chat-btn"
                onClick={() => {
                  setState({ phase: 'idle' })
                  setInput(retryText)
                }}
              >
                Retry
              </button>
            ) : null}
            <button type="button" className="rg-ai-chat-btn rg-ai-chat-btn--ghost" onClick={removeBlock}>
              Dismiss
            </button>
          </div>
        </div>
      ) : null}

      {state.phase === 'redirect' ? (
        <div className="rg-ai-chat-status" aria-live="polite">
          <p className="rg-ai-chat-redirect">{state.note}</p>
          <div className="rg-ai-chat-row rg-ai-chat-row--end">
            <button type="button" className="rg-ai-chat-btn" onClick={redirectToAgent}>
              Continue with full agent
            </button>
            <button type="button" className="rg-ai-chat-btn rg-ai-chat-btn--ghost" onClick={removeBlock}>
              Dismiss
            </button>
          </div>
        </div>
      ) : null}

      {state.phase === 'done' ? (
        <p className="rg-ai-chat-done" aria-live="polite">
          ✓ Done — Cmd+Z to undo
        </p>
      ) : null}
    </div>
  )
}

export const createAiChat = createReactBlockSpec(
  {
    type: 'aiChat',
    propSchema: {
      placeholder: { default: '' },
      contextJson: { default: '{}' },
    },
    content: 'none',
  },
  {
    render: (props) => <AiChatView block={props.block} editor={props.editor} />,
  },
)