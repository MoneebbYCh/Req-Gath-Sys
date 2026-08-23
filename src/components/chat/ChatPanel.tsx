import { useEffect, useRef, useState } from 'react'
import type { AgentActivity, AgentTaskStatus, ChatMessage } from '../../hooks/useAgentSession'
import type { DocumentProgressState, PlanView } from '../../../shared/agentProtocol'
import { ChatMarkdown } from './ChatMarkdown'

interface ChatPanelProps {
  isOpen: boolean
  onClose: () => void
  messages: ChatMessage[]
  activities: AgentActivity[]
  taskStatus: AgentTaskStatus
  plan?: PlanView
  documents?: DocumentProgressState[]
  error?: string
  /** Models exposed by providers with a stored API key (chat model picker). */
  models?: string[]
  activeModel?: string
  onSelectModel?: (model: string) => void
  onSend: (text: string) => void
  onCancel: () => void
  onClear: () => void
  onApplyPendingDraft: (documentId: string, draftId: string) => void
}

const PLAN_ICONS: Record<string, string> = {
  queued: '○',
  running: '◐',
  completed: '✓',
  failed: '✕',
  blocked: '⊘',
  cancelled: '—',
}

export function ChatPanel({
  isOpen,
  onClose,
  messages,
  activities,
  taskStatus,
  plan,
  documents,
  error,
  models = [],
  activeModel,
  onSelectModel,
  onSend,
  onCancel,
  onClear,
  onApplyPendingDraft,
}: ChatPanelProps) {
  const [input, setInput] = useState('')
  const listRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  // Auto-follow the stream only while the user is near the bottom (plan §6).
  const [pinned, setPinned] = useState(true)
  const [pickerOpen, setPickerOpen] = useState(false)
  const pickerRef = useRef<HTMLDivElement>(null)

  const running = taskStatus === 'running'
  const paused = taskStatus === 'paused'
  const busy = running || paused
  const currentActivity = activities[activities.length - 1]?.text

  useEffect(() => {
    if (isOpen && inputRef.current) inputRef.current.focus()
  }, [isOpen])

  useEffect(() => {
    if (pinned && listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight
    }
  }, [messages, activities, running, pinned])

  // Close the model menu on Escape or any click outside the picker.
  useEffect(() => {
    if (!pickerOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPickerOpen(false)
    }
    const onPointer = (e: PointerEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) setPickerOpen(false)
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('pointerdown', onPointer)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('pointerdown', onPointer)
    }
  }, [pickerOpen])

  // Auto-grow the composer vertically as the user types (Cursor-style), capped.
  useEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`
  }, [input])

  function handleScroll() {
    const el = listRef.current
    if (!el) return
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40
    setPinned(nearBottom)
  }

  function doSend() {
    if (!input.trim() || busy) return
    onSend(input)
    setInput('')
    setPinned(true)
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    doSend()
  }

  // Enter sends, Shift+Enter adds a newline (chat convention).
  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      doSend()
    }
  }

  function jumpToLatest() {
    if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight
    setPinned(true)
  }

  return (
    <div
      className={`chat-panel ${isOpen ? 'chat-panel--open' : ''}`}
      role="complementary"
      aria-label="Chat"
    >
      <div className="chat-titlebar">
        <div className="chat-titlebar-stripes" />
        <span className="chat-titlebar-text">Chat</span>
        <div className="chat-titlebar-actions">
          <button
            type="button"
            className="chat-titlebar-btn"
            onClick={onClose}
            aria-label="Close chat panel"
          >
            ✕
          </button>
        </div>
      </div>

      <div ref={listRef} className="chat-messages" onScroll={handleScroll}>
        {messages.map((msg) => (
          <div key={msg.id} className={`chat-bubble chat-bubble--${msg.role}`}>
            <div className="chat-bubble-label">
              {msg.role === 'user' ? 'You' : 'Assistant'}
            </div>
            {msg.role === 'assistant' ? (
              <div className="chat-bubble-text">
                {msg.text ? <ChatMarkdown text={msg.text} /> : null}
                {msg.incomplete ? (
                  <span className="chat-incomplete" title="The task failed before this answer was complete">
                    — incomplete
                  </span>
                ) : null}
              </div>
            ) : (
              <div className="chat-bubble-text chat-bubble-text--plain">{msg.text}</div>
            )}
          </div>
        ))}

        {plan && plan.nodes.length > 0 && (
          <div className="chat-plan" aria-label="Analysis plan">
            {plan.nodes.map((node) => (
              <div key={node.id} className={`chat-plan-item chat-plan-item--${node.status}`}>
                <span className="chat-plan-icon" aria-hidden>
                  {PLAN_ICONS[node.status] ?? '○'}
                </span>
                <span className="chat-plan-title">{node.title}</span>
              </div>
            ))}
          </div>
        )}

        {documents && documents.length > 0 && (
          <div className="chat-docs" aria-label="Document generation progress">
            {documents.map((doc) => {
              const draftId = doc.pendingDraftId
              return (
                <div key={doc.documentId} className={`chat-doc-item chat-doc-item--${doc.status}`}>
                  <span className="chat-plan-icon" aria-hidden>
                    {PLAN_ICONS[doc.status] ?? '○'}
                  </span>
                  <span className="chat-plan-title">{doc.title}</span>
                  <span className="chat-doc-sections">
                    {doc.status === 'completed'
                      ? 'Complete'
                      : doc.status === 'failed'
                        ? doc.error ?? 'Failed'
                        : doc.totalSections > 0
                          ? `Section ${doc.completedSections}/${doc.totalSections}`
                          : doc.status}
                  </span>
                  {draftId && (
                    <button
                      type="button"
                      className="chat-doc-apply-btn"
                      onClick={() => onApplyPendingDraft(doc.documentId, draftId)}
                      aria-label={`Apply agent draft for ${doc.title}`}
                    >
                      Apply draft
                    </button>
                  )}
                </div>
              )
            })}
          </div>
        )}

        {running && !currentActivity && (
          <div className="chat-bubble chat-bubble--assistant">
            <div className="chat-bubble-label">Assistant</div>
            <div className="chat-typing-dots">
              <span className="chat-dot" />
              <span className="chat-dot" />
              <span className="chat-dot" />
            </div>
          </div>
        )}

        {running && currentActivity && (
          <div className="chat-activity-line">
            <span className="chat-activity-spinner" aria-hidden />
            <span>{currentActivity}</span>
          </div>
        )}

        {paused && (
          <div className="chat-activity-line chat-activity-line--paused">
            <span>⏸ Paused — resuming from the last durable checkpoint…</span>
          </div>
        )}

        {taskStatus === 'failed' && error && (
          <div className="chat-error-line" role="alert">
            {error}
          </div>
        )}
      </div>

      {!pinned && (
        <button type="button" className="chat-jump-latest" onClick={jumpToLatest}>
          ↓ Jump to latest
        </button>
      )}

      <form className="chat-inputbar" onSubmit={handleSubmit}>
        <textarea
          ref={inputRef}
          className="chat-input"
          rows={1}
          placeholder={busy ? (running ? 'Task running…' : 'Task resuming…') : 'Type a message...'}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={busy}
        />
        <div className="chat-composer-bar">
          {onSelectModel && (activeModel || models.length > 0) ? (
            <div className="chat-model-picker" ref={pickerRef}>
              <button
                type="button"
                className="chat-model-btn"
                onClick={() => setPickerOpen((open) => !open)}
                aria-haspopup="listbox"
                aria-expanded={pickerOpen}
                aria-label={`Model: ${activeModel ?? models[0] ?? ''}`}
                title="Model used for the next task"
              >
                <span className="chat-model-name">{activeModel ?? models[0]}</span>
                <span aria-hidden>⌄</span>
              </button>
              {pickerOpen && (
                <ul className="chat-model-menu" role="listbox" aria-label="Chat model">
                  {(!activeModel || models.includes(activeModel) ? models : [activeModel, ...models]).map(
                    (m) => (
                      <li key={m}>
                        <button
                          type="button"
                          role="option"
                          aria-selected={m === activeModel}
                          className={`chat-model-option ${m === activeModel ? 'chat-model-option--active' : ''}`}
                          onClick={() => {
                            onSelectModel(m)
                            setPickerOpen(false)
                            inputRef.current?.focus()
                          }}
                        >
                          <span>{m}</span>
                          {m === activeModel ? <span aria-hidden>✓</span> : null}
                        </button>
                      </li>
                    ),
                  )}
                </ul>
              )}
            </div>
          ) : null}
          <div className="chat-input-actions">
          {running ? (
            <button
              type="button"
              className="chat-stop-btn"
              onClick={onCancel}
              aria-label="Stop task"
            >
              Stop
            </button>
          ) : (
            <button
              type="submit"
              className="chat-send-btn"
              disabled={!input.trim()}
              aria-label="Send message"
            >
              Send
            </button>
          )}
          <button
            type="button"
            className="chat-clear-btn"
            onClick={onClear}
            title="Clear conversation"
            aria-label="Clear conversation"
          >
            Clear
          </button>
          </div>
        </div>
      </form>
    </div>
  )
}
