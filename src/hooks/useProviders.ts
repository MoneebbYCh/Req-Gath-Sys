import { useCallback, useEffect, useState } from 'react'
import type { ProvidersState } from '../../shared/providersProtocol'
import { getVscodeApi } from '../utils/vscodeApi'

/**
 * DeepSeek settings state. The webview only ever sees status/model names —
 * API keys are typed into a native VS Code prompt and stored in SecretStorage
 * (plan invariant 6: credentials never enter webview state).
 */
export function useProviders() {
  const vscode = getVscodeApi()
  const [state, setState] = useState<ProvidersState | null>(null)

  useEffect(() => {
    if (!vscode) return
    const handler = (event: MessageEvent) => {
      if (event.data?.type === 'providersState') {
        setState(event.data.state as ProvidersState)
      }
    }
    window.addEventListener('message', handler)
    vscode.postMessage({ type: 'providersLoad' })
    return () => window.removeEventListener('message', handler)
  }, [vscode])

  const post = useCallback(
    (msg: Record<string, unknown>) => vscode?.postMessage(msg),
    [vscode],
  )

  const setKey = useCallback(() => post({ type: 'providersSetKey' }), [post])
  const validate = useCallback(() => post({ type: 'providersValidate' }), [post])
  const clearKey = useCallback(() => post({ type: 'providersClearKey' }), [post])
  const setModel = useCallback((model: string) => post({ type: 'providersSetModel', model }), [post])

  return { state, setKey, validate, clearKey, setModel }
}

export type ProvidersApi = ReturnType<typeof useProviders>
