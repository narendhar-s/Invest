import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props {
  children: ReactNode
}

interface State {
  error: Error | null
  info: string
}

// ErrorBoundary catches render-time exceptions in the route tree so a single
// broken page shows a readable error instead of blanking the whole app.
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, info: '' }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Surface to the console for debugging.
    // eslint-disable-next-line no-console
    console.error('Route crashed:', error, info)
    this.setState({ info: info.componentStack ?? '' })
  }

  render() {
    const { error, info } = this.state
    if (!error) return this.props.children
    return (
      <div className="max-w-3xl mx-auto px-4 py-10">
        <div className="rounded-xl border border-red-700/50 bg-red-900/20 p-5">
          <h2 className="text-lg font-semibold text-red-300 mb-2">This page hit an error</h2>
          <p className="text-sm text-red-200/90 mb-3 font-mono break-words">
            {error.name}: {error.message}
          </p>
          {error.stack && (
            <pre className="text-xs text-slate-400 bg-dark-900/60 rounded-lg p-3 overflow-auto max-h-64 whitespace-pre-wrap">
              {error.stack}
            </pre>
          )}
          {info && (
            <pre className="mt-2 text-xs text-slate-500 bg-dark-900/60 rounded-lg p-3 overflow-auto max-h-48 whitespace-pre-wrap">
              {info}
            </pre>
          )}
          <button
            onClick={() => this.setState({ error: null, info: '' })}
            className="mt-4 bg-slate-700 hover:bg-slate-600 text-slate-100 rounded-lg px-4 py-2 text-sm"
          >
            Try again
          </button>
        </div>
      </div>
    )
  }
}
