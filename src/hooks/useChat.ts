import { useState, useCallback, useRef, useEffect } from 'react'
import { getVscodeApi } from '../utils/vscodeApi'
import { BRAND_NAME } from '../brand'

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  timestamp: number
  researchCheckpoint?: string
}

const vscode = getVscodeApi()

let msgId = 0
function nextId(): string {
  return `chat-${++msgId}`
}

const WELCOME: ChatMessage = {
  id: 'chat-welcome',
  role: 'assistant',
  text: `Hello! I'm your ${BRAND_NAME} assistant. From Home I can read this codebase and generate a document pipeline for the project. On a document page I can draft the canvas. Configure your API key first (command palette: ${BRAND_NAME}: Configure API Key), then ask away!`,
  timestamp: Date.now(),
}

/** How many prior UI turns to send (each user or assistant bubble counts as one). */
const MAX_HISTORY_MESSAGES = 20
/** Cap each prior bubble so context stays bounded. */
const MAX_HISTORY_CHARS = 4_000

/**
 * Agentic chat can run many sequential LLM steps (each up to ~3 min server-side).
 * Client timeout must exceed typical full-inventory runs (~3–6+ min), not a single LLM call.
 */
const TIMEOUT_MS = 600_000

function buildHistoryPayload(
  messages: ChatMessage[],
): Array<{ role: 'user' | 'assistant'; text: string; researchCheckpoint?: string }> {
  return messages
    .filter((m) => m.id !== WELCOME.id)
    .slice(-MAX_HISTORY_MESSAGES)
    .map((m) => ({
      role: m.role,
      text: m.text.length > MAX_HISTORY_CHARS ? `${m.text.slice(0, MAX_HISTORY_CHARS)}\n…(truncated)` : m.text,
      ...(m.researchCheckpoint ? { researchCheckpoint: m.researchCheckpoint } : {}),
    }))
    .filter((m) => m.text.trim().length > 0)
}

export function useChat(phase: string) {
  const [isOpen, setIsOpen] = useState(false)
  const [messages, setMessages] = useState<ChatMessage[]>([WELCOME])
  const [isTyping, setIsTyping] = useState(false)
  /** Interim status from the extension (thinking, tool progress, …). */
  const [statusText, setStatusText] = useState<string | null>(null)
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** Id of a soft-timeout bubble so a late real reply can replace it. */
  const timeoutMsgIdRef = useRef<string | null>(null)

  const toggleOpen = useCallback(() => {
    setIsOpen((prev) => !prev)
  }, [])

  const close = useCallback(() => {
    setIsOpen(false)
  }, [])

  const clearTimeout_ = useCallback(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current)
      timeoutRef.current = null
    }
  }, [])

  useEffect(() => {
    const handler = (event: MessageEvent) => {
      const msg = event.data
      if (msg.type === 'chatStatus') {
        setStatusText(typeof msg.text === 'string' ? msg.text : null)
      }
      if (msg.type === 'chatResponse') {
        clearTimeout_()
        setIsTyping(false)
        setStatusText(null)
        const reply: ChatMessage = {
          id: nextId(),
          role: 'assistant',
          text: msg.text,
          timestamp: Date.now(),
          ...(typeof msg.researchCheckpoint === 'string' && msg.researchCheckpoint.trim()
            ? { researchCheckpoint: msg.researchCheckpoint }
            : {}),
        }
        const staleTimeoutId = timeoutMsgIdRef.current
        timeoutMsgIdRef.current = null
        setMessages((prev) => {
          const withoutTimeout = staleTimeoutId
            ? prev.filter((m) => m.id !== staleTimeoutId)
            : prev
          return [...withoutTimeout, reply]
        })
      }
    }
    window.addEventListener('message', handler)
    return () => {
      window.removeEventListener('message', handler)
      clearTimeout_()
    }
  }, [clearTimeout_])

  const sendMessage = useCallback(
    (text: string) => {
      const trimmed = text.trim()
      if (!trimmed) return

      const userMsg: ChatMessage = {
        id: nextId(),
        role: 'user',
        text: trimmed,
        timestamp: Date.now(),
      }

      // Snapshot prior turns before appending the new user message.
      const history = buildHistoryPayload(messages)

      setMessages((prev) => [...prev, userMsg])

      if (!vscode) {
        const fallback: ChatMessage = {
          id: nextId(),
          role: 'assistant',
          text: 'AI assistant is only available when running inside VS Code with an API key configured.',
          timestamp: Date.now(),
        }
        setMessages((prev) => [...prev, fallback])
        return
      }

      setIsTyping(true)
      setStatusText(null)
      timeoutMsgIdRef.current = null
      vscode.postMessage({ type: 'chatMessage', text: trimmed, phase, history })

      clearTimeout_()
      timeoutRef.current = setTimeout(() => {
        // Soft timeout: keep waiting for a late chatResponse (extension may still be running).
        setStatusText('Still working — large inventories can take several minutes…')
        const timeoutId = nextId()
        timeoutMsgIdRef.current = timeoutId
        const timeoutMsg: ChatMessage = {
          id: timeoutId,
          role: 'assistant',
          text:
            'This is taking longer than usual (common for full route/API counts). ' +
            'The agent is likely still running — if a reply appears below, ignore this notice. ' +
            `If nothing arrives, check your API key (${BRAND_NAME}: Configure API Key) or try a narrower question.`,
          timestamp: Date.now(),
        }
        setMessages((prev) => [...prev, timeoutMsg])
      }, TIMEOUT_MS)
    },
    [phase, messages, clearTimeout_]
  )

  const clearMessages = useCallback(() => {
    clearTimeout_()
    timeoutMsgIdRef.current = null
    setIsTyping(false)
    setStatusText(null)
    setMessages([{ ...WELCOME, timestamp: Date.now() }])
  }, [clearTimeout_])

  return {
    isOpen,
    toggleOpen,
    close,
    messages,
    sendMessage,
    clearMessages,
    isTyping,
    statusText,
  }
}
