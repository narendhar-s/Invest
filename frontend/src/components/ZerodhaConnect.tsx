import { useEffect, useState, useRef } from 'react'
import { getZerodhaStatus, getZerodhaLoginUrl, zerodhaLogout, type ZerodhaStatus, type ZerodhaQuote } from '../api/client'

interface Props {
  onQuotesUpdate?: (quotes: Record<string, ZerodhaQuote>) => void
}

export default function ZerodhaConnect({ onQuotesUpdate }: Props) {
  const [status, setStatus] = useState<ZerodhaStatus | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const esRef = useRef<EventSource | null>(null)

  const fetchStatus = async () => {
    try {
      const s = await getZerodhaStatus()
      setStatus(s)
      if (s.connected && s.streaming) {
        startStream()
      }
    } catch {
      // backend may not have zerodha configured — that's fine
    }
  }

  useEffect(() => {
    fetchStatus()
    // Check for zerodha=connected callback in URL
    const params = new URLSearchParams(window.location.search)
    if (params.get('zerodha') === 'connected') {
      window.history.replaceState({}, '', window.location.pathname)
      fetchStatus()
    }
    if (params.get('zerodha') === 'error') {
      setError('Zerodha login failed: ' + (params.get('msg') || 'unknown error'))
      window.history.replaceState({}, '', window.location.pathname)
    }
    return () => { esRef.current?.close() }
  }, [])

  const startStream = () => {
    if (esRef.current) return
    const es = new EventSource('/api/v1/zerodha/stream')
    es.onmessage = (e) => {
      try {
        const quotes = JSON.parse(e.data) as Record<string, ZerodhaQuote>
        onQuotesUpdate?.(quotes)
      } catch {}
    }
    es.onerror = () => {
      es.close()
      esRef.current = null
    }
    esRef.current = es
  }

  const stopStream = () => {
    esRef.current?.close()
    esRef.current = null
  }

  const handleLogin = async () => {
    setLoading(true)
    setError(null)
    try {
      const { login_url, configured } = await getZerodhaLoginUrl()
      if (!configured) {
        setError('Zerodha not configured — add ZERODHA_API_KEY to .env')
        return
      }
      window.location.href = login_url
    } catch (e: any) {
      setError(e?.response?.data?.error || 'Failed to get login URL')
    } finally {
      setLoading(false)
    }
  }

  const handleLogout = async () => {
    stopStream()
    await zerodhaLogout()
    setStatus(prev => prev ? { ...prev, connected: false, streaming: false } : prev)
  }

  if (!status) return null
  if (!status.configured) {
    // Don't hide silently — show a disabled hint so the missing API key is obvious.
    return (
      <div
        className="flex items-center gap-1.5 bg-slate-700/20 border border-slate-600/40 text-slate-400 rounded-lg px-3 py-1.5 text-xs font-medium cursor-not-allowed"
        title="Set ZERODHA_API_KEY and ZERODHA_API_SECRET in your .env, then restart the backend."
      >
        <span className="text-sm">🔗</span> Connect Zerodha
        <span className="text-[10px] text-amber-400/80">(set API key)</span>
      </div>
    )
  }

  const isConnected = status.connected
  const isStreaming = status.streaming

  return (
    <div className="flex items-center gap-2">
      {error && (
        <span className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 px-2 py-1 rounded-lg">
          {error}
          <button onClick={() => setError(null)} className="ml-2 text-red-300 hover:text-red-100">×</button>
        </span>
      )}

      {isConnected ? (
        <div className="flex items-center gap-2">
          {/* Live streaming indicator */}
          <div className="flex items-center gap-1.5 bg-emerald-500/10 border border-emerald-500/30 rounded-lg px-3 py-1.5">
            <span className={`w-2 h-2 rounded-full ${isStreaming ? 'bg-emerald-400 animate-pulse' : 'bg-slate-400'}`} />
            <span className="text-xs font-medium text-emerald-400">Zerodha Live</span>
            {status.token_date && (
              <span className="text-xs text-emerald-600 hidden sm:inline">· {status.token_date}</span>
            )}
          </div>
          <button
            onClick={handleLogout}
            className="text-xs text-slate-500 hover:text-red-400 transition-colors px-2 py-1 rounded"
          >
            Disconnect
          </button>
        </div>
      ) : (
        <button
          onClick={handleLogin}
          disabled={loading}
          className="flex items-center gap-1.5 bg-[#387ED1]/15 hover:bg-[#387ED1]/25 border border-[#387ED1]/40 text-[#5A9FE0] hover:text-[#7BB8F0] rounded-lg px-3 py-1.5 text-xs font-medium transition-all disabled:opacity-50"
        >
          {loading ? (
            <><span className="animate-spin text-sm">⟳</span> Connecting…</>
          ) : (
            <><span className="text-sm">🔗</span> Connect Zerodha</>
          )}
        </button>
      )}
    </div>
  )
}
