import { useEffect, useState, ReactNode } from 'react'

interface KiteStatus {
  configured: boolean
  connected: boolean
}

async function fetchKiteStatus(): Promise<KiteStatus> {
  const res = await fetch('/api/naren/v1/zerodha/status')
  if (!res.ok) throw new Error('status check failed')
  return res.json()
}

async function fetchLoginURL(): Promise<string> {
  const res = await fetch('/api/naren/v1/zerodha/login-url')
  if (!res.ok) throw new Error('could not get login URL')
  const data = await res.json()
  return data.login_url
}

type GateState = 'checking' | 'connected' | 'login_required' | 'not_configured' | 'error'

export default function LoginGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<GateState>('checking')
  const [errorMsg, setErrorMsg] = useState('')
  const [logging, setLogging] = useState(false)

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const zStatus = params.get('zerodha')

    // Clean up query params from URL without reloading
    if (zStatus) {
      const clean = window.location.pathname
      window.history.replaceState({}, '', clean)
    }

    if (zStatus === 'error') {
      const msg = params.get('msg') || 'Login failed'
      setErrorMsg(msg)
      setState('login_required')
      return
    }

    // Check actual connection status
    fetchKiteStatus()
      .then(status => {
        if (!status.configured) {
          setState('not_configured')
        } else if (status.connected) {
          setState('connected')
        } else {
          setState('login_required')
        }
      })
      .catch(() => setState('error'))
  }, [])

  const handleLogin = async () => {
    setLogging(true)
    try {
      const url = await fetchLoginURL()
      window.location.href = url
    } catch {
      setErrorMsg('Could not reach backend. Is the server running?')
      setLogging(false)
    }
  }

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
            <code className="text-blue-400">ZERODHA_API_SECRET</code> in your <code className="text-slate-300">.env</code> file,
            then restart the server.
          </p>
        </div>
      </div>
    )
  }

  // login_required or error
  return (
    <div className="min-h-screen bg-dark-900 flex items-center justify-center px-4">
      <div className="bg-dark-800 border border-slate-700 rounded-2xl p-10 max-w-sm w-full text-center space-y-6 shadow-2xl">
        {/* Logo area */}
        <div className="space-y-2">
          <div className="text-5xl">📈</div>
          <h1 className="text-2xl font-bold text-slate-100 tracking-tight">StockWise</h1>
          <p className="text-slate-400 text-sm">Connect your Kite account to continue</p>
        </div>

        {/* Error banner */}
        {errorMsg && (
          <div className="bg-red-900/40 border border-red-700/60 rounded-lg px-4 py-3 text-red-300 text-sm">
            {errorMsg}
          </div>
        )}

        {/* Login button */}
        <button
          onClick={handleLogin}
          disabled={logging}
          className="w-full flex items-center justify-center gap-3 bg-[#387ed1] hover:bg-[#2d6bb8] disabled:opacity-60 disabled:cursor-not-allowed transition-colors text-white font-semibold py-3 px-6 rounded-xl text-sm"
        >
          {logging ? (
            <>
              <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
              Redirecting to Kite…
            </>
          ) : (
            <>
              <img
                src="https://zerodha.com/static/images/logo.svg"
                alt="Zerodha"
                className="h-4 brightness-0 invert"
                onError={e => { (e.target as HTMLImageElement).style.display = 'none' }}
              />
              Login with Kite
            </>
          )}
        </button>

        <p className="text-slate-600 text-xs">
          Your credentials are handled securely by Zerodha. We never store your password.
        </p>
      </div>
    </div>
  )
}
