import { useEffect, useState, ReactNode } from 'react'

interface KiteStatus {
  connected: boolean
  login_url: string
}

async function fetchKiteStatus(): Promise<{ status: KiteStatus | null; notConfigured: boolean }> {
  const res = await fetch('/api/naren/v1/kite/status')
  if (res.status === 503) return { status: null, notConfigured: true }
  if (!res.ok) throw new Error('unreachable')
  return { status: await res.json(), notConfigured: false }
}

type GateState = 'checking' | 'connected' | 'login_required' | 'not_configured' | 'error'

export default function LoginGate({ children }: { children: ReactNode }) {
  const [state, setState]       = useState<GateState>('checking')
  const [loginURL, setLoginURL] = useState('')
  const [errorMsg, setErrorMsg] = useState('')

  useEffect(() => {
    // Pick up any error message passed back by the OAuth callback (?error=...)
    const params = new URLSearchParams(window.location.search)
    const err = params.get('error')
    if (err) {
      setErrorMsg(decodeURIComponent(err))
      window.history.replaceState({}, '', window.location.pathname)
    }

    fetchKiteStatus()
      .then(({ status, notConfigured }) => {
        if (notConfigured)      { setState('not_configured'); return }
        if (status?.login_url)  setLoginURL(status.login_url)
        if (status?.connected)  setState('connected')
        else                    setState('login_required')
      })
      .catch(() => setState('error'))
  }, [])

  const handleLogin = () => {
    // Full-page redirect to Kite OAuth.
    // KiteLogin (backend) sets a cookie so the callback knows to come back here.
    window.location.href = '/api/naren/v1/kite/login'
  }

  // ── Screens ───────────────────────────────────────────────────────────────

  if (state === 'checking') {
    return (
      <div className="min-h-screen bg-dark-900 flex items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <div className="w-10 h-10 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
          <p className="text-slate-400 text-sm">Checking Kite connection…</p>
        </div>
      </div>
    )
  }

  if (state === 'error') {
    return (
      <div className="min-h-screen bg-dark-900 flex items-center justify-center">
        <div className="bg-dark-800 border border-red-700/60 rounded-2xl p-10 max-w-md w-full text-center space-y-4">
          <div className="text-4xl">⚠️</div>
          <h1 className="text-xl font-semibold text-slate-100">Backend Unreachable</h1>
          <p className="text-slate-400 text-sm">Could not reach the server. Is it running on port 8080?</p>
          <button onClick={() => window.location.reload()} className="text-blue-400 text-sm hover:text-blue-300">
            Try again
          </button>
        </div>
      </div>
    )
  }

  if (state === 'connected') {
    return <>{children}</>
  }

  if (state === 'not_configured') {
    return (
      <div className="min-h-screen bg-dark-900 flex items-center justify-center">
        <div className="bg-dark-800 border border-slate-700 rounded-2xl p-10 max-w-md w-full text-center space-y-4">
          <div className="text-4xl">⚙️</div>
          <h1 className="text-xl font-semibold text-slate-100">Kite Not Configured</h1>
          <p className="text-slate-400 text-sm">
            Set <code className="text-blue-400">ZERODHA_API_KEY</code> and{' '}
            <code className="text-blue-400">ZERODHA_API_SECRET</code> in your{' '}
            <code className="text-slate-300">.env</code> file, then restart the server.
          </p>
        </div>
      </div>
    )
  }

  // login_required
  return (
    <div className="min-h-screen bg-dark-900 flex items-center justify-center px-4">
      <div className="bg-dark-800 border border-slate-700 rounded-2xl p-10 max-w-sm w-full text-center space-y-6 shadow-2xl">

        <div className="space-y-2">
          <div className="text-5xl">📈</div>
          <h1 className="text-2xl font-bold text-slate-100 tracking-tight">StockWise</h1>
          <p className="text-slate-400 text-sm">Connect your Kite account to continue</p>
        </div>

        {errorMsg && (
          <div className="bg-red-900/40 border border-red-700/60 rounded-lg px-4 py-3 text-red-300 text-sm">
            {errorMsg}
          </div>
        )}

        <button
          onClick={handleLogin}
          className="w-full flex items-center justify-center gap-3 bg-[#387ed1] hover:bg-[#2d6bb8] transition-colors text-white font-semibold py-3 px-6 rounded-xl text-sm"
        >
          <img
            src="https://zerodha.com/static/images/logo.svg"
            alt="Zerodha"
            className="h-4 brightness-0 invert"
            onError={e => { (e.target as HTMLImageElement).style.display = 'none' }}
          />
          Login with Kite
        </button>

        <p className="text-slate-600 text-xs">
          Your credentials are handled securely by Zerodha. We never store your password.
        </p>
      </div>
    </div>
  )
}
