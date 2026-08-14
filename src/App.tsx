import { useViewState } from './hooks/useViewState'
import { HomePage } from './pages/HomePage'
import { ProfilePage } from './pages/ProfilePage'
import { PhaseCanvasPage } from './pages/PhaseCanvasPage'
import { CRTMonitor } from './components/layout/CRTMonitor'
import {
  isDocumentTypeId,
  applyCustomTypesFromDisk,
} from './data/documentTypes'
import { getVscodeApi } from './utils/vscodeApi'
import {
  getWorkspaceId,
  setWorkspaceScope,
} from './utils/workspaceScope'
import { useChat } from './hooks/useChat'
import { ChatPanel } from './components/chat/ChatPanel'
import { ChatToggleButton } from './components/chat/ChatToggleButton'
import { useCallback, useEffect, useState } from 'react'

function App() {
  const vscode = getVscodeApi()
  // Wait until we know which folder we're in (VS Code) so localStorage is scoped first.
  const [scopeReady, setScopeReady] = useState(!vscode)
  const [workspaceKey, setWorkspaceKey] = useState(() => getWorkspaceId() || 'local')
  const [noWorkspace, setNoWorkspace] = useState(false)

  useEffect(() => {
    if (!vscode) return
    const handler = (event: MessageEvent) => {
      const msg = event.data
      if (msg?.type === 'workspaceInfo' && typeof msg.path === 'string') {
        if (msg.available !== false) {
          setWorkspaceScope(msg.path)
          setWorkspaceKey(getWorkspaceId() || 'workspace')
          setScopeReady(true)
          // Load doc types for *this* folder after scope is set.
          vscode.postMessage({ type: 'loadDocTypes' })
        } else {
          // No folder open — show the notice state; nothing is persisted.
          setNoWorkspace(true)
          setWorkspaceKey('no-workspace')
          setScopeReady(true)
        }
      }
    }
    window.addEventListener('message', handler)
    vscode.postMessage({ type: 'loadWorkspaceInfo' })
    return () => window.removeEventListener('message', handler)
  }, [vscode])

  if (!scopeReady) {
    return (
      <CRTMonitor>
        <div className="flex h-screen items-center justify-center text-sm text-on-surface-variant">
          Connecting to workspace…
        </div>
      </CRTMonitor>
    )
  }

  // Remount the whole app tree when the folder changes so chat + docs reset.
  return <AppShell key={workspaceKey} noWorkspace={noWorkspace} />
}

function AppShell({ noWorkspace }: { noWorkspace: boolean }) {
  const { view, navigate, goHome } = useViewState()
  // Home (and profile) use the orchestrator agent — can generate_pipeline.
  const chatPhase =
    view.page === 'home' || view.page === 'profile' ? 'home' : view.page
  const chat = useChat(chatPhase)
  const [docTypesRev, setDocTypesRev] = useState(0)

  useEffect(() => {
    const handler = (event: MessageEvent) => {
      const msg = event.data
      if (msg?.type === 'loadDocTypes') {
        const mode = msg.mode === 'replace' ? 'replace' : 'merge'
        if (applyCustomTypesFromDisk(msg.data, mode) || mode === 'replace') {
          setDocTypesRev((n) => n + 1)
        }
      }
    }
    window.addEventListener('message', handler)
    return () => window.removeEventListener('message', handler)
  }, [])

  const askFromHome = useCallback(
    (text: string) => {
      const trimmed = text.trim()
      if (!trimmed) return
      if (!chat.isOpen) chat.toggleOpen()
      chat.sendMessage(trimmed)
    },
    [chat.isOpen, chat.toggleOpen, chat.sendMessage],
  )

  // In-document Ask AI blocks hand off codebase/file work to the full agent.
  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ text?: string }>).detail
      askFromHome(detail?.text ?? '')
    }
    window.addEventListener('charter-ai:redirect-chat', handler)
    return () => window.removeEventListener('charter-ai:redirect-chat', handler)
  }, [askFromHome])

  const renderPage = () => {
    if (view.page === 'home') {
      return (
        <HomePage
          onNavigate={navigate}
          onAsk={askFromHome}
          isAsking={chat.isTyping}
          docTypesRev={docTypesRev}
          noWorkspace={noWorkspace}
        />
      )
    }
    if (view.page === 'profile') {
      return <ProfilePage onNavigate={navigate} goHome={goHome} />
    }
    if (isDocumentTypeId(view.page)) {
      return <PhaseCanvasPage phaseId={view.page} onNavigate={navigate} goHome={goHome} />
    }
    return (
      <HomePage
        onNavigate={navigate}
        onAsk={askFromHome}
        isAsking={chat.isTyping}
        docTypesRev={docTypesRev}
        noWorkspace={noWorkspace}
      />
    )
  }

  return (
    <CRTMonitor>
      {renderPage()}
      <ChatToggleButton isOpen={chat.isOpen} onClick={chat.toggleOpen} />
      <ChatPanel
        isOpen={chat.isOpen}
        onClose={chat.close}
        messages={chat.messages}
        onSend={chat.sendMessage}
        onClear={chat.clearMessages}
        isTyping={chat.isTyping}
        statusText={chat.statusText}
      />
    </CRTMonitor>
  )
}

export default App
