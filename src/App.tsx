import { useViewState } from './hooks/useViewState'
import { HomePage } from './pages/HomePage'
import { ProfilePage } from './pages/ProfilePage'
import { CRTMonitor } from './components/layout/CRTMonitor'
import { LoadingSplash } from './components/BrandMark'
import {
  isDocumentTypeId,
  applyCustomTypesFromDisk,
} from './data/documentTypes'
import { getVscodeApi } from './utils/vscodeApi'
import {
  getWorkspaceId,
  setWorkspaceScope,
} from './utils/workspaceScope'
import { useAgentSession } from './hooks/useAgentSession'
import { useProviders } from './hooks/useProviders'
import { ChatPanel } from './components/chat/ChatPanel'
import { ChatToggleButton } from './components/chat/ChatToggleButton'
import { lazy, Suspense, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'

/** Heavy BlockNote/Mantine canvas — keep out of the home/startup bundle. */
const PhaseCanvasPage = lazy(() =>
  import('./pages/PhaseCanvasPage').then((m) => ({ default: m.PhaseCanvasPage })),
)

/** Marketplace templates catalog — defer until Templates is opened. */
const TemplatesPage = lazy(() =>
  import('./pages/TemplatesPage').then((m) => ({ default: m.TemplatesPage })),
)

function PageSuspense({ children }: { children: ReactNode }) {
  return (
    <Suspense fallback={<LoadingSplash message="Loading…" className="h-screen" />}>
      {children}
    </Suspense>
  )
}

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
        <LoadingSplash message="Connecting to workspace…" className="h-screen" />
      </CRTMonitor>
    )
  }

  // Remount the whole app tree when the folder changes so chat + docs reset.
  return <AppShell key={workspaceKey} noWorkspace={noWorkspace} />
}

function AppShell({ noWorkspace }: { noWorkspace: boolean }) {
  const { view, navigate, goHome } = useViewState()
  // The active page/document is request metadata (surface), not session identity.
  const surface = useMemo(
    () => ({
      page: view.page,
      activeDocumentId: isDocumentTypeId(view.page) ? view.page : undefined,
    }),
    [view.page],
  )
  const chat = useAgentSession(surface)
  // Model picker beside the chat input: models exposed by providers with a
  // stored API key (discovered host-side; keys never reach the webview).
  const providers = useProviders()
  const [docTypesRev, setDocTypesRev] = useState(0)

  useEffect(() => {
    const handler = (event: MessageEvent) => {
      const msg = event.data
      if (msg?.type === 'loadDocTypes') {
        applyCustomTypesFromDisk(msg.data, 'replace')
        setDocTypesRev((n) => n + 1)
        return
      }
      if (msg?.type === 'navigateTo' && typeof msg.view?.page === 'string') {
        navigate(msg.view)
      }
    }
    window.addEventListener('message', handler)
    return () => window.removeEventListener('message', handler)
  }, [navigate])

  const askFromHome = useCallback(
    (text: string) => {
      const trimmed = text.trim()
      if (!trimmed) return
      if (!chat.isOpen) chat.toggleOpen()
      chat.send(trimmed)
    },
    [chat.isOpen, chat.toggleOpen, chat.send],
  )

  const renderPage = () => {
    if (view.page === 'home') {
      return (
        <HomePage
          onNavigate={navigate}
          onAsk={askFromHome}
          isAsking={chat.isRunning}
          docTypesRev={docTypesRev}
          noWorkspace={noWorkspace}
        />
      )
    }
    if (view.page === 'profile') {
      return <ProfilePage onNavigate={navigate} goHome={goHome} />
    }
    if (view.page === 'templates') {
      return (
        <PageSuspense>
          <TemplatesPage onNavigate={navigate} goHome={goHome} />
        </PageSuspense>
      )
    }
    if (isDocumentTypeId(view.page)) {
      return (
        <PageSuspense>
          <PhaseCanvasPage
            key={view.page}
            phaseId={view.page}
            onNavigate={navigate}
            goHome={goHome}
            seedFromMarketplaceId={view.seedFromMarketplaceId}
          />
        </PageSuspense>
      )
    }
    return (
      <HomePage
        onNavigate={navigate}
        onAsk={askFromHome}
        isAsking={chat.isRunning}
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
        activities={chat.activities}
        taskStatus={chat.taskStatus}
        plan={chat.plan}
        documents={chat.documents}
        usage={chat.usage}
        error={chat.error}
        onSend={chat.send}
        onCancel={chat.cancel}
        onClear={chat.clearMessages}
        onApplyPendingDraft={chat.applyPendingDraft}
        models={providers.state?.models ?? []}
        activeModel={providers.state?.model}
        onSelectModel={providers.setModel}
      />
    </CRTMonitor>
  )
}

export default App
