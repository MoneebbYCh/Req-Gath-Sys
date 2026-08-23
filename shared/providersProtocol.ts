/**
 * Webview ↔ extension protocol for the provider picker UI. Shared so the
 * webview (vite) and extension host (esbuild) both consume the same shapes.
 */
export interface ProviderUiInfo {
  id: string
  label: string
  baseUrl: string
  keyRequired: boolean
  defaultModel?: string
}

export interface ProvidersState {
  providers: ProviderUiInfo[]
  activeProviderId: string
  hasKey: boolean
  /** True when the stored key passed the last validation for this provider. */
  keyValidated: boolean
  model: string
  /** Effective base URL (editable only for the custom provider). */
  baseUrl: string
  /** Models discovered by the last successful validation. */
  models: string[]
  error?: string
}

export type WebviewToExtensionProvidersMessage =
  | { type: 'providersLoad' }
  | { type: 'providersSetKey' }
  | { type: 'providersValidate' }
  | { type: 'providersClearKey' }
  | { type: 'providersSetModel'; model: string }
