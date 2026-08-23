import { useState, useCallback, useMemo } from 'react'
import { getDocumentType, isDocumentTypeId } from '../data/documentTypes'

/** `page` is 'home', 'profile', or any document-type id (built-in or custom). */
export type ViewPage = 'home' | 'profile' | (string & {})
export type View = { page: ViewPage }

export function useViewState() {
  const [view, setView] = useState<View>({ page: 'home' })

  const navigate = useCallback((v: View) => {
    setView(v)
  }, [])

  const phaseInfo = useMemo(() => {
    if (view.page === 'home' || view.page === 'profile') return null
    if (!isDocumentTypeId(view.page)) return null
    return getDocumentType(view.page) ?? null
  }, [view])

  const goHome = useCallback(() => {
    setView({ page: 'home' })
  }, [])

  return { view, navigate, goHome, phaseInfo }
}

export type ViewState = ReturnType<typeof useViewState>
