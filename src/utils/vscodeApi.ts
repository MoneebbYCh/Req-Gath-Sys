interface VscodeApi {
  postMessage: (msg: unknown) => void
  getState: () => unknown
  setState: (state: unknown) => void
}

let _api: VscodeApi | null = null

try {
  const acquired = (window as any).acquireVsCodeApi?.()
  if (acquired) _api = acquired
} catch {
  _api = null
}

export function getVscodeApi(): VscodeApi | null {
  return _api
}
