import { useState, useCallback, useMemo } from 'react'
import { getDocumentType, isDocumentTypeId } from '../data/documentTypes'

/** `page` is 'home', 'profile', 'templates', or any document-type id (built-in or custom). */
export type ViewPage = 'home' | 'profile' | 'templates' | (string & {})
export type View = {
  page: ViewPage
  /** When opening a new doc from the marketplace, apply this catalog template once ready. */
  seedFromMarketplaceId?: string
}

export function useViewState() {
  const [view, setView] = useState<View>({ page: 'home' })

  const navigate = useCallback((v: View) => {
    setView(v)
  }, [])

  const phaseInfo = useMemo(() => {
    if (view.page === 'home' || view.page === 'profile' || view.page === 'templates') return null
    if (!isDocumentTypeId(view.page)) return null
    return getDocumentType(view.page) ?? null
  }, [view])

  const goHome = useCallback(() => {
    setView({ page: 'home' })
  }, [])

  return { view, navigate, goHome, phaseInfo }
}

export type ViewState = ReturnType<typeof useViewState>
