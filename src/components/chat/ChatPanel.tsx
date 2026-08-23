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
  onSend,
  onCancel,
  onClear,
  onApplyPendingDraft,
}: ChatPanelProps) {
  const [input, setInput] = useState('')
  const listRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  // Auto-follow the stream only while the user is near the bottom (plan §6).
  const [pinned, setPinned] = useState(true)

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

  function handleScroll() {
    const el = listRef.current
    if (!el) return
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40
    setPinned(nearBottom)
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!input.trim() || busy) return
    onSend(input)
    setInput('')
    setPinned(true)
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
        <div className="chat-input-wrap">
          <input
            ref={inputRef}
            className="chat-input"
            type="text"
            placeholder={busy ? (running ? 'Task running…' : 'Task resuming…') : 'Type a message...'}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            disabled={busy}
          />
        </div>
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
      </form>
    </div>
  )
}
