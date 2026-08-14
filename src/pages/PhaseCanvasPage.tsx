import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { PipelineHeader } from '../components/layout/PipelineChrome'
import { DocumentCanvas } from '../components/canvas/DocumentCanvas'
import { CanvasErrorBoundary } from '../components/canvas/CanvasErrorBoundary'
import { CanvasToolsSidebar, type ToolsTab } from '../components/canvas/CanvasToolsSidebar'
import { TemplateGallery } from '../components/canvas/TemplateGallery'
import { TemplateTutorial } from '../components/canvas/TemplateTutorial'
import type { CanvasEditor } from '../components/canvas/schema'
import { usePhaseDocument } from '../hooks/usePhaseDocument'
import type { View } from '../hooks/useViewState'
import { documentHasContent, documentHasOwnHeading } from '../types/document'
import {
  templateOptionsForType,
  resolveTemplate,
  saveUserTemplate,
  type CharterTemplate,
} from '../data/docTemplates'
import { getDocumentType } from '../data/documentTypes'
import { storageKeyFor, TEMPLATE_TUTORIAL_BASE_KEY } from '../utils/workspaceScope'
import { getVscodeApi } from '../utils/vscodeApi'
import { canvasToMarkdown } from '../utils/exportMarkdown'
import { ConfirmDialog } from '../components/ConfirmDialog'

interface PhaseCanvasPageProps {
  phaseId: string
  onNavigate: (view: View) => void
  goHome: () => void
}

export function PhaseCanvasPage({ phaseId, onNavigate, goHome }: PhaseCanvasPageProps) {
  // In-app notice — webview window.alert is unreliable even with allowModals.
  const [notice, setNotice] = useState<string | null>(null)
  useEffect(() => {
    if (!notice) return
    const t = setTimeout(() => setNotice(null), 3500)
    return () => clearTimeout(t)
  }, [notice])

  // N7: an AI draft replaced the document while the user was editing — surface it.
  const handleDraftReplaced = useCallback((message: string) => {
    setNotice(message)
  }, [])

  const {
    meta,
    doc,
    blocks,
    setBlocks,
    applyExternalDocument,
    saveNow,
    reset,
    lastSaved,
    isDirty,
    ready,
    externalRevision,
    externalBlocks,
  } = usePhaseDocument(phaseId, { onReplaced: handleDraftReplaced })

  const tutorialKey = storageKeyFor(TEMPLATE_TUTORIAL_BASE_KEY)

  const [editor, setEditor] = useState<CanvasEditor | null>(null)
  const [toolsCollapsed, setToolsCollapsed] = useState(false)
  const [toolsTab, setToolsTab] = useState<ToolsTab>('insert')
  // Bumped after saving a template so the option list refreshes.
  const [templatesRev, setTemplatesRev] = useState(0)
  // Bumped when the doc is renamed from the header strip.
  const [titleRev, setTitleRev] = useState(0)
  const templateOptions = useMemo(
    () => templateOptionsForType(phaseId),
    [phaseId, templatesRev],
  )
  const [previewTemplateId, setPreviewTemplateId] = useState<string>(() => templateOptions[0].id)
  const [showTutorial, setShowTutorial] = useState(false)
  const autoOpenedRef = useRef(false)
  // Set when the user clicks Apply on a template while the doc has content — the
  // replacement is destructive, so it needs an explicit confirm.
  const [pendingTemplate, setPendingTemplate] = useState<CharterTemplate | null>(null)

  // Every document type gets the Templates tab (blank + user-saved).
  const templatesEnabled = true
  // Templates other than the blank "Build from scratch" option.
  const hasSavedTemplates = templateOptions.some((t) => !t.custom)
  const templateId = doc.anchors?.templateId
  const hasContent = useMemo(() => documentHasContent(doc), [doc])

  // On first open of an untouched doc that already has saved templates, show the gallery.
  const needsInitialTemplate =
    templatesEnabled && hasSavedTemplates && ready && !hasContent && !templateId

  useEffect(() => {
    autoOpenedRef.current = false
    setToolsTab('insert')
    setPreviewTemplateId(templateOptionsForType(phaseId)[0].id)
  }, [phaseId])

  useEffect(() => {
    if (needsInitialTemplate && !autoOpenedRef.current) {
      autoOpenedRef.current = true
      setToolsTab('template')
    }
  }, [needsInitialTemplate])

  // Follow the applied template when it changes (e.g. right after applying one).
  useEffect(() => {
    if (templateId && resolveTemplate(phaseId, templateId)) {
      setPreviewTemplateId(templateId)
    }
  }, [templateId, phaseId])

  const templateViewActive = templatesEnabled && toolsTab === 'template'
  const previewTemplate =
    resolveTemplate(phaseId, previewTemplateId) ?? templateOptions[0]

  // First time the Templates page is opened, run a short tutorial.
  useEffect(() => {
    if (!templateViewActive) return
    try {
      if (!localStorage.getItem(tutorialKey)) {
        setShowTutorial(true)
      }
    } catch {
      /* localStorage unavailable — skip the tutorial silently */
    }
  }, [templateViewActive, tutorialKey])

  const dismissTutorial = useCallback(() => {
    try {
      localStorage.setItem(tutorialKey, '1')
    } catch {
      /* ignore */
    }
    setShowTutorial(false)
  }, [tutorialKey])

  // Keep masthead / sidebar title in sync after header rename.
  const displayTitle = useMemo(() => {
    void titleRev
    return getDocumentType(phaseId)?.title ?? meta.title
  }, [phaseId, meta.title, titleRev])

  const applyTemplate = useCallback(
    (template: CharterTemplate) => {
      applyExternalDocument(
        {
          version: 1,
          kind: 'blocknote',
          blocks: template.build(),
          anchors: { ...(doc.anchors ?? {}), templateId: template.id },
        },
        { persistToDisk: true },
      )
      setToolsTab('insert')
      setPendingTemplate(null)
    },
    [applyExternalDocument, doc.anchors],
  )

  const requestApplyTemplate = useCallback(
    (template: CharterTemplate) => {
      // Replacing existing content is destructive — confirm first (V15).
      if (hasContent) {
        setPendingTemplate(template)
      } else {
        applyTemplate(template)
      }
    },
    [hasContent, applyTemplate],
  )

  const handleSaveTemplate = useCallback(() => {
    const source = editor?.document?.length
      ? (editor.document as unknown as typeof blocks)
      : blocks
    if (!documentHasContent({ version: 1, kind: 'blocknote', blocks: source, anchors: {} })) {
      setNotice('Add some content to this document before saving it as a template.')
      return
    }
    const name = window.prompt('Name this template', `${displayTitle} template`)
    if (!name || !name.trim()) return
    const created = saveUserTemplate(phaseId, name.trim(), source)
    setTemplatesRev((n) => n + 1)
    setPreviewTemplateId(created.id)
  }, [editor, blocks, displayTitle, phaseId])

  const handleEditorReady = useCallback((next: CanvasEditor | null) => {
    setEditor(next)
  }, [])

  const handleExport = () => {
    saveNow()
    const source = editor?.document?.length
      ? (editor.document as unknown as typeof blocks)
      : blocks
    const docForExport = {
      version: 1 as const,
      kind: 'blocknote' as const,
      blocks: source,
      anchors: {},
    }
    if (!documentHasContent(docForExport)) {
      setNotice('Add some content to this document before exporting.')
      return
    }
    getVscodeApi()?.postMessage({
      type: 'exportMarkdown',
      phase: phaseId,
      markdown: canvasToMarkdown(docForExport),
      suggestedName: displayTitle,
    })
  }

  const saveLabel = isDirty
    ? 'Saving…'
    : lastSaved
      ? `Saved ${lastSaved.toLocaleTimeString()}`
      : 'Save Draft'

  const phasePad = String(meta.number).padStart(2, '0')
  const showPhaseMasthead = useMemo(() => !documentHasOwnHeading(blocks), [blocks])

  return (
    <div className="charter-canvas-page flex flex-col h-screen overflow-hidden">
      {notice ? (
        <div
          className="fixed top-3 left-1/2 -translate-x-1/2 z-50 border-2 border-on-background bg-secondary-container px-4 py-2 text-sm font-bold text-on-background"
          style={{ fontFamily: 'var(--font-body)' }}
        >
          {notice}
        </div>
      ) : null}
      <PipelineHeader
        onHome={goHome}
        onExport={handleExport}
        onSave={saveNow}
        saveLabel={saveLabel}
        currentPhaseId={phaseId}
        onNavigate={onNavigate}
        onDocRenamed={() => setTitleRev((n) => n + 1)}
      />

      <div className="charter-canvas-workspace">
        <CanvasToolsSidebar
          editor={editor}
          blocks={blocks}
          phaseTitle={displayTitle}
          collapsed={toolsCollapsed}
          onToggleCollapsed={() => setToolsCollapsed((v) => !v)}
          tab={toolsTab}
          onTabChange={setToolsTab}
          templatesEnabled={templatesEnabled}
          templates={templateOptions}
          currentTemplateId={templateId}
          previewTemplateId={previewTemplateId}
          onPreviewTemplate={setPreviewTemplateId}
          onSaveTemplate={handleSaveTemplate}
          onShowTutorial={() => setShowTutorial(true)}
        />

        {templateViewActive ? (
          <div className="charter-canvas-scroll flex-1 min-h-0 overflow-y-auto">
            <TemplateGallery
              documentLabel={displayTitle}
              template={previewTemplate}
              currentTemplateId={templateId}
              hasExistingContent={hasContent}
              onApply={requestApplyTemplate}
              onCancel={() => setToolsTab('insert')}
            />
          </div>
        ) : (
          <div className="charter-canvas-scroll flex-1 min-h-0 overflow-y-auto">
            <div className="charter-canvas-sheet">
              {showPhaseMasthead ? (
                <header className="charter-canvas-masthead">
                  <p className="charter-canvas-kicker">{meta.kicker || `Phase ${phasePad}`}</p>
                  <h1 className="charter-canvas-title">{displayTitle}</h1>
                  <p className="charter-canvas-subtitle">{meta.subtitle}</p>
                </header>
              ) : null}

              {!ready ? (
                <p className="charter-canvas-loading">Loading canvas…</p>
              ) : (
                <CanvasErrorBoundary onReset={reset}>
                  <DocumentCanvas
                    initialBlocks={blocks}
                    onChange={setBlocks}
                    externalRevision={externalRevision}
                    externalBlocks={externalBlocks}
                    editorKey={`${phaseId}-${externalRevision}`}
                    onEditorReady={handleEditorReady}
                  />
                </CanvasErrorBoundary>
              )}

              {meta.next ? (
                <div className="charter-canvas-tail">
                  <button
                    type="button"
                    className="charter-canvas-proceed"
                    onClick={() => {
                      saveNow()
                      onNavigate({ page: meta.next!.page })
                    }}
                  >
                    {meta.next.label}
                  </button>
                </div>
              ) : null}
            </div>
          </div>
        )}
      </div>

      {templatesEnabled && showTutorial ? (
        <TemplateTutorial documentLabel={displayTitle} onClose={dismissTutorial} />
      ) : null}

      {pendingTemplate ? (
        <ConfirmDialog
          title="Apply template"
          message={`Replace the current document with "${pendingTemplate.name}"? Your current content will be overwritten.`}
          confirmLabel="Apply"
          onConfirm={() => applyTemplate(pendingTemplate)}
          onCancel={() => setPendingTemplate(null)}
        />
      ) : null}
    </div>
  )
}
