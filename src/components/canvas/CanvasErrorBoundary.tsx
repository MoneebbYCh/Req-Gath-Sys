import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props {
  children: ReactNode
  onReset: () => void
}

interface State {
  error: Error | null
}

/** Catches BlockNote / custom-block crashes so the webview does not go blank. */
export class CanvasErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[DocumentCanvas]', error, info.componentStack)
  }

  private handleReset = () => {
    this.setState({ error: null })
    this.props.onReset()
  }

  render() {
    if (this.state.error) {
      return (
        <div className="charter-canvas-error" role="alert">
          <p className="charter-canvas-error-title">Canvas failed to render</p>
          <p className="charter-canvas-error-body">
            The saved document had content the editor could not load. Reset to a blank page, or
            check the console for details.
          </p>
          <p className="charter-canvas-error-detail">
            {this.state.error.message}
            {this.state.error.cause instanceof Error
              ? ` — ${this.state.error.cause.message}`
              : ''}
          </p>
          <button type="button" className="charter-canvas-error-reset" onClick={this.handleReset}>
            Reset canvas
          </button>
        </div>
      )
    }

    return this.props.children
  }
}
