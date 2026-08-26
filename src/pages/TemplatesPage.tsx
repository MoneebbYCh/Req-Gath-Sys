import { useEffect, useMemo, useState } from 'react'
import type { View } from '../hooks/useViewState'
import { BrandMark, DialogMascot } from '../components/BrandMark'
import { TemplateDocPreview } from '../components/TemplateDocPreview'
import {
  filterMarketplaceTemplates,
  listMarketplaceTemplates,
  MARKETPLACE_CATEGORIES,
  type MarketplaceCategory,
  type MarketplaceTemplate,
} from '../data/marketplaceTemplates'
import { createDocType } from '../data/documentTypes'
import { emptyCanvasDocument, type CanvasDocument } from '../types/document'
import { getVscodeApi } from '../utils/vscodeApi'
import { storageKeyFor } from '../utils/workspaceScope'

interface TemplatesPageProps {
  onNavigate: (view: View) => void
  goHome: () => void
}

function openFromTemplate(template: MarketplaceTemplate, onNavigate: (view: View) => void) {
  const created = createDocType(template.suggestedDocName || template.name, template.icon)
  const doc: CanvasDocument = {
    ...emptyCanvasDocument(),
    blocks: template.build(),
    anchors: { templateId: template.id },
  }
  try {
    localStorage.setItem(storageKeyFor(created.storageKey), JSON.stringify(doc))
  } catch {
    /* ignore */
  }
  getVscodeApi()?.postMessage({ type: 'saveCanvas', phase: created.id, data: doc })
  onNavigate({ page: created.id, seedFromMarketplaceId: template.id })
}

export function TemplatesPage({ onNavigate, goHome }: TemplatesPageProps) {
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState<MarketplaceCategory>('All')
  const [selected, setSelected] = useState<MarketplaceTemplate | null>(null)
  const [variantId, setVariantId] = useState<string | null>(null)
  const [rev, setRev] = useState(0)

  const all = useMemo(() => listMarketplaceTemplates(), [rev])
  const filtered = useMemo(
    () => filterMarketplaceTemplates(all, query, category),
    [all, query, category],
  )

  const activeTemplate = useMemo(() => {
    if (!selected) return null
    if (!selected.variants?.length) return selected
    return selected.variants.find((v) => v.id === variantId) ?? selected.variants[0]
  }, [selected, variantId])

  const activeBlocks = useMemo(
    () => (activeTemplate ? activeTemplate.build() : []),
    [activeTemplate],
  )

  useEffect(() => {
    if (!selected) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setSelected(null)
        setVariantId(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selected])

  const openPreview = (template: MarketplaceTemplate) => {
    setSelected(template)
    setVariantId(template.variants?.[0]?.id ?? null)
  }

  const handleUse = (template: MarketplaceTemplate) => {
    openFromTemplate(template, onNavigate)
    setRev((n) => n + 1)
  }

  return (
    <div className="home-desktop h-screen w-full overflow-hidden flex flex-col dither-bg">
      <div className="home-mac-window flex-1 min-h-0 m-2 md:m-3 border-2 border-on-background bg-white mac-window-shadow flex flex-col">
        <div className="flex items-center gap-2 border-b-2 border-on-background bg-secondary-container px-2 py-1 shrink-0">
          <div className="mac-striped-header flex-1 min-w-0" aria-hidden />
          <span
            className="text-xs font-bold text-on-background px-2 whitespace-nowrap"
            style={{ fontFamily: 'var(--font-label)' }}
          >
            Template Gallery
          </span>
          <div className="mac-striped-header flex-1 min-w-0" aria-hidden />
        </div>

        <div className="flex items-center justify-between gap-3 px-3 py-2 border-b-2 border-on-background bg-surface-container-low shrink-0">
          <button
            type="button"
            onClick={goHome}
            className="border-2 border-on-background bg-white text-on-background font-bold px-3 py-1 text-xs outset-button"
            style={{ fontFamily: 'var(--font-label)' }}
          >
            ← Desktop
          </button>
          <span className="text-[11px] text-on-surface-variant" style={{ fontFamily: 'var(--font-label)' }}>
            Pick a starting point · creates a new document
          </span>
        </div>

        <div className="mp-toolbar border-b-2 border-on-background px-4 md:px-6 py-3 shrink-0">
          <div className="flex items-center gap-3 flex-wrap mb-3">
            <BrandMark size="sm" />
            <div className="min-w-0 flex-1">
              <h1
                className="text-lg font-bold text-on-background leading-tight"
                style={{ fontFamily: 'var(--font-headline)' }}
              >
                Templates
              </h1>
              <p className="text-[11px] text-on-surface-variant" style={{ fontFamily: 'var(--font-label)' }}>
                Preview finished-looking starters — then open one in the canvas.
              </p>
            </div>
          </div>

          <form className="mp-search" onSubmit={(e) => e.preventDefault()} role="search">
            <span className="material-symbols-outlined mp-search-icon" aria-hidden>
              search
            </span>
            <input
              type="search"
              className="mp-search-input"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search — README, PRD, arc42, ADR, Diátaxis…"
              aria-label="Search templates"
            />
            {query ? (
              <button
                type="button"
                className="mp-search-clear"
                onClick={() => setQuery('')}
                aria-label="Clear search"
              >
                ×
              </button>
            ) : null}
          </form>
        </div>

        <div className="mp-filterbar" role="tablist" aria-label="Template categories">
          {MARKETPLACE_CATEGORIES.map((cat) => (
            <button
              key={cat}
              type="button"
              role="tab"
              aria-selected={category === cat}
              className={`mp-pill${category === cat ? ' mp-pill--active' : ''}`}
              onClick={() => setCategory(cat)}
            >
              {cat}
            </button>
          ))}
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto p-4 md:p-6 bg-surface-container-low">
          <div className="flex items-center gap-2 mb-3">
            <span
              className="text-xs font-bold tracking-widest text-on-surface-variant uppercase"
              style={{ fontFamily: 'var(--font-label)' }}
            >
              {category === 'All' ? 'All templates' : category}
            </span>
            <div className="flex-1 h-px bg-on-background/30" />
            <span className="text-[11px] text-on-surface-variant" style={{ fontFamily: 'var(--font-label)' }}>
              {filtered.length} template{filtered.length === 1 ? '' : 's'}
            </span>
          </div>

          {filtered.length === 0 ? (
            <div className="border-2 border-on-background bg-white p-8 text-center">
              <p className="text-sm text-on-surface-variant mb-1" style={{ fontFamily: 'var(--font-body)' }}>
                No templates match that search.
              </p>
              <button
                type="button"
                className="text-xs font-bold text-primary underline mt-2"
                style={{ fontFamily: 'var(--font-label)' }}
                onClick={() => {
                  setQuery('')
                  setCategory('All')
                }}
              >
                Clear filters
              </button>
            </div>
          ) : (
            <div className="mp-grid">
              {filtered.map((template) => {
                const thumbBlocks = template.build()
                const badge = template.standard || template.category
                return (
                  <button
                    key={template.id}
                    type="button"
                    className="mp-card"
                    onClick={() => openPreview(template)}
                  >
                    <div className="mp-card-preview" aria-hidden>
                      <div className="mp-card-preview-bar">
                        <span className="mp-dot" />
                        <span className="mp-dot" />
                        <span className="mp-dot" />
                        <span className="mp-card-preview-title">{template.name}</span>
                      </div>
                      <div className="mp-card-preview-clip">
                        <div className="mp-card-preview-scale">
                          <TemplateDocPreview blocks={thumbBlocks} mode="thumb" />
                        </div>
                      </div>
                    </div>
                    <div className="mp-card-meta">
                      <span className="mp-card-text">
                        <span className="mp-card-name">{template.name}</span>
                        <span className="mp-card-tagline">{template.tagline}</span>
                      </span>
                      <span className="mp-standard-badge">{badge}</span>
                    </div>
                  </button>
                )
              })}
            </div>
          )}
        </div>
      </div>

      {selected && activeTemplate ? (
        <div
          className="mp-modal-backdrop"
          role="presentation"
          onClick={() => {
            setSelected(null)
            setVariantId(null)
          }}
        >
          <div
            className="mp-modal mp-modal--wide dialog-panel"
            role="dialog"
            aria-modal="true"
            aria-labelledby="mp-modal-title"
            onClick={(e) => e.stopPropagation()}
          >
            <DialogMascot />
            <div className="mp-modal-titlebar">
              <span className="mac-striped-header flex-1 min-w-0" aria-hidden />
              <span className="mp-modal-titlebar-label">{selected.name}</span>
              <span className="mac-striped-header flex-1 min-w-0" aria-hidden />
            </div>
            <div className="mp-modal-body mp-modal-body--split">
              <aside className="mp-modal-side">
                <p className="mp-modal-kicker">
                  {selected.category}
                  {activeTemplate.standard ? ` · ${activeTemplate.standard}` : ''}
                </p>
                <h2 id="mp-modal-title" className="mp-modal-name">
                  {selected.name}
                </h2>
                <p className="mp-modal-desc">{selected.description}</p>

                {selected.variants && selected.variants.length > 0 ? (
                  <div className="mp-variants" role="radiogroup" aria-label="ADR format">
                    <p className="mp-modal-section-title">Choose format</p>
                    <div className="mp-variant-col">
                      {selected.variants.map((v) => {
                        const active = activeTemplate.id === v.id
                        return (
                          <button
                            key={v.id}
                            type="button"
                            role="radio"
                            aria-checked={active}
                            className={`mp-variant${active ? ' mp-variant--active' : ''}`}
                            onClick={() => setVariantId(v.id)}
                          >
                            <span className="mp-variant-name">
                              {v.name}
                              {v.standard ? (
                                <span className="mp-standard-badge mp-standard-badge--inline">{v.standard}</span>
                              ) : null}
                            </span>
                            <span className="mp-variant-tagline">{v.tagline}</span>
                          </button>
                        )
                      })}
                    </div>
                  </div>
                ) : null}
              </aside>

              <div className="mp-modal-doc">
                <p className="mp-modal-section-title">
                  Preview
                  {selected.variants?.length ? ` · ${activeTemplate.name}` : ''}
                </p>
                <div className="mp-modal-doc-sheet">
                  <TemplateDocPreview blocks={activeBlocks} mode="full" />
                </div>
              </div>
            </div>
            <div className="mp-modal-actions">
              <button
                type="button"
                className="border-2 border-on-background bg-white text-on-background font-bold px-5 py-2 text-sm outset-button"
                style={{ fontFamily: 'var(--font-label)' }}
                onClick={() => {
                  setSelected(null)
                  setVariantId(null)
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                className="border-2 border-on-background bg-primary text-on-primary font-bold px-5 py-2 text-sm outset-button hover:opacity-90"
                style={{ fontFamily: 'var(--font-label)' }}
                onClick={() => handleUse(activeTemplate)}
              >
                Use this template
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
