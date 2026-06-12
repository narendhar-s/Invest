import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'
import KiteChart, { type ChartBar, type TradeMarker } from '../components/KiteChart'

// ─── Types ────────────────────────────────────────────────────────────────────

interface LegSpec   { option_type: string; side: string; strike_offset: number; label: string }
interface Indicators {
  spot: number; ema9: number; ema21: number; atr14: number; vwap_proxy: number
  trend_strength: number; or_high: number; or_low: number; day_change_pct: number
}
interface Signal {
  strategy: string; direction: string; regime: string; confidence: number
  atm_strike: number; reasoning: string[]; legs: LegSpec[] | null; indicators: Indicators; as_of: string
}
interface LegState {
  trading_symbol: string; option_type: string; strike: number; side: string; qty: number
  entry_premium: number; current_premium: number; label: string
}
interface Position {
  id: string; strategy: string; direction: string; regime: string; confidence: number; mode: string
  rr: number; spot: number; atm_strike: number; legs: LegState[]; entry_time: string; exit_time?: string
  status: string; target_pnl: number; stop_pnl: number; realized_pnl: number; exit_reason?: string
  reasoning: string[]
}
interface Snapshot {
  connected: boolean; running: boolean; auto_mode: boolean; capital: number; lots: number
  risk_pct: number; rr: number; conf_threshold: number; market_open: boolean
  open: Position | null; open_pnl: number; history: Position[]
  today_realized: number; today_trades: number; total_realized: number
  win_count: number; loss_count: number; last_signal: Signal | null; last_error: string
}
interface KiteStatus {
  connected: boolean; user: string; login_url: string
  auto_login: boolean; next_refresh_at: string; ticker_running: boolean
}

interface BTTrade {
  entry_time: string; exit_time: string; strategy: string; direction: string
  entry_spot: number; exit_spot: number; atm_strike: number; strike: number
  option_type: string; expiry: string; expiry_label: string; confidence: number
  entry_premium: number; exit_premium: number; iv: number; dte: number
  delta_entry: number; pnl: number; pnl_per_lot: number
  exit_reason: string; bars_held: number; price_source: string; signal_basis: string[]
}
interface EquityPt  { time: string; equity: number; trade: number }
interface BTResult {
  from: string; to: string; capital: number; lots: number; rr: number; risk_pct: number
  risk_per_trade: number; target_per_trade: number
  trades: BTTrade[]; total_pnl: number; win_count: number; loss_count: number
  win_rate: number; avg_win: number; avg_loss: number; reward_risk: number
  max_drawdown: number; expectancy: number; profit_factor: number; max_consec_loss: number
  equity_curve: EquityPt[]; bar_signals: ChartBar[]
  real_price_trades: number; bs_price_trades: number; pricing_note: string
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const fmt = (n: number) => new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(Math.abs(n))
const fmtF = (n: number, d = 1) => n?.toFixed(d) ?? '—'
const pc   = (n: number) => (n >= 0 ? 'text-emerald-400' : 'text-red-400')
const sgn  = (n: number) => (n >= 0 ? '+' : '-')

const STRAT_LABEL: Record<string, string> = {
  DIRECTIONAL_CE: 'Buy CE (Bullish)', DIRECTIONAL_PE: 'Buy PE (Bearish)',
  IRON_CONDOR: 'Iron Condor', IRON_FLY: 'Iron Fly', SHORT_STRADDLE: 'Short Straddle',
  ORB_CE: 'ORB · Buy CE', ORB_PE: 'ORB · Buy PE', NO_TRADE: 'No Trade',
}

function Chip({ label, color = 'slate' }: { label: string; color?: string }) {
  const map: Record<string, string> = {
    green: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
    red: 'bg-red-500/15 text-red-300 border-red-500/30',
    blue: 'bg-blue-500/15 text-blue-300 border-blue-500/30',
    yellow: 'bg-yellow-500/15 text-yellow-300 border-yellow-500/30',
    slate: 'bg-slate-700/60 text-slate-400 border-slate-600/40',
  }
  return <span className={`text-[10px] px-2 py-0.5 rounded-full border font-semibold ${map[color] || map.slate}`}>{label}</span>
}

function DirChip({ dir }: { dir: string }) {
  const map: Record<string, string> = { BULLISH: 'green', BEARISH: 'red', NEUTRAL: 'slate' }
  return <Chip label={dir} color={map[dir] || 'slate'} />
}

function MetricCard({ label, value, sub, big = false, color = '' }: { label: string; value: string; sub?: string; big?: boolean; color?: string }) {
  return (
    <div className="bg-slate-800/70 rounded-xl p-4 border border-slate-700/50">
      <p className="text-slate-500 text-xs mb-1">{label}</p>
      <p className={`font-bold ${big ? 'text-2xl' : 'text-xl'} ${color || 'text-slate-100'}`}>{value}</p>
      {sub && <p className="text-slate-500 text-xs mt-0.5">{sub}</p>}
    </div>
  )
}

// ─── Not-connected banner ─────────────────────────────────────────────────────

function LoginBanner({ error, onTokenSet, autoLoginAvailable }: {
  error: string; onTokenSet: () => void; autoLoginAvailable?: boolean
}) {
  const [showManual,    setShowManual]    = useState(false)
  const [token,         setToken]         = useState('')
  const [saving,        setSaving]        = useState(false)
  const [manualErr,     setManualErr]     = useState('')
  const [autoLogging,   setAutoLogging]   = useState(false)

  const doAutoLogin = async () => {
    setAutoLogging(true)
    try {
      const r = await fetch('/api/naren/v1/kite/auto-login', { method: 'POST' })
      const d = await r.json()
      if (d.error) { setManualErr(d.error) } else { onTokenSet() }
    } catch (e) { setManualErr((e as Error).message) }
    finally { setAutoLogging(false) }
  }

  const submitToken = async () => {
    if (!token.trim()) return
    setSaving(true); setManualErr('')
    try {
      const r = await fetch('/api/naren/v1/kite/token', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ access_token: token.trim() }),
      })
      const d = await r.json()
      if (!r.ok) throw new Error(d.error || 'failed')
      onTokenSet()
    } catch (e) { setManualErr((e as Error).message) }
    finally { setSaving(false) }
  }

  return (
    <div className="max-w-xl mx-auto space-y-4">
      {/* Auto-login (if configured) */}
      {autoLoginAvailable && (
        <div className="bg-purple-500/10 border border-purple-500/30 rounded-2xl p-6 text-center">
          <div className="text-3xl mb-3">🔄</div>
          <h2 className="text-lg font-bold text-slate-100 mb-1">Auto-Login Available</h2>
          <p className="text-slate-400 text-sm mb-4">
            Zerodha credentials configured. Click to log in automatically — no browser redirect needed.
          </p>
          {manualErr && <p className="text-red-400 text-xs mb-3">{manualErr}</p>}
          <button onClick={doAutoLogin} disabled={autoLogging}
            className="px-8 py-2.5 bg-purple-600 hover:bg-purple-500 disabled:opacity-60 text-white font-semibold rounded-xl transition-colors">
            {autoLogging ? '⏳ Logging in…' : '🔄 Auto-Login with Zerodha'}
          </button>
          <p className="text-slate-500 text-xs mt-3">Uses stored credentials + TOTP. Fully automated.</p>
        </div>
      )}

      {/* Manual OAuth flow */}
      <div className="bg-slate-800/80 border border-slate-700/60 rounded-2xl p-8 text-center">
        <div className="text-4xl mb-4">🪁</div>
        <h2 className="text-xl font-bold text-slate-100 mb-2">
          {autoLoginAvailable ? 'Or: Browser Login' : 'Connect Kite to Continue'}
        </h2>
        <p className="text-slate-400 text-sm mb-6">
          Read-only access — live Nifty data &amp; charts only. No orders ever placed.
          Token expires at 7:30 AM IST daily.
        </p>

        {error && (
          <div className="mb-4 bg-red-500/10 border border-red-500/30 rounded-xl px-4 py-3 text-red-300 text-sm text-left">
            <strong>Login error:</strong> {error}
            <p className="text-red-400/70 text-xs mt-1">
              Common causes: redirect URL mismatch in Kite console, or browser refreshed the callback URL (token used twice).
            </p>
          </div>
        )}

        <a href="/api/naren/v1/kite/login"
          className="inline-block px-8 py-3 bg-blue-600 hover:bg-blue-500 text-white text-base font-semibold rounded-xl transition-colors">
          Login with Zerodha →
        </a>
        <p className="text-slate-500 text-xs mt-4">
          Kite console redirect URL must be exactly:{' '}
          <span className="font-mono text-blue-400">http://localhost:8082/api/naren/v1/zerodha/callback</span>
        </p>
      </div>

      {/* Manual access-token fallback */}
      <div className="bg-slate-800/60 border border-slate-700/40 rounded-xl p-5">
        <button onClick={() => setShowManual(v => !v)}
          className="flex items-center justify-between w-full text-left">
          <span className="text-slate-300 text-sm font-medium">Having trouble? Paste access token manually</span>
          <span className="text-slate-500 text-xs">{showManual ? '▲ hide' : '▼ show'}</span>
        </button>

        {showManual && (
          <div className="mt-4 space-y-3">
            <p className="text-slate-400 text-xs leading-relaxed">
              1. Open Kite Connect developer console → your app → Generate token<br />
              2. Complete the login flow and copy the <strong className="text-slate-200">access_token</strong> from the response<br />
              3. Paste it below
            </p>
            <textarea
              value={token} onChange={e => setToken(e.target.value)}
              placeholder="Paste access_token here…"
              className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-slate-200 text-xs font-mono resize-none h-20 focus:outline-none focus:border-blue-500"
            />
            {manualErr && <p className="text-red-400 text-xs">{manualErr}</p>}
            <button onClick={submitToken} disabled={saving || !token.trim()}
              className="px-5 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white text-sm rounded-lg font-medium transition-colors">
              {saving ? 'Connecting…' : 'Connect with Token'}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Tab bar ──────────────────────────────────────────────────────────────────

type Tab = 'signals' | 'paper' | 'backtest'
const TABS: { key: Tab; label: string; icon: string }[] = [
  { key: 'signals',  label: 'Live Signals',   icon: '📡' },
  { key: 'paper',    label: 'Paper Trade',     icon: '📋' },
  { key: 'backtest', label: 'Backtest',         icon: '📊' },
]

// ─── Live signals tab ─────────────────────────────────────────────────────────

function SignalsTab({ snap, onRefresh }: { snap: Snapshot; onRefresh: () => void }) {
  const [loading,       setLoading]       = useState(false)
  const [chartBars,     setChartBars]     = useState<ChartBar[]>([])
  const [days,          setDays]          = useState(3)
  const [challengePos,  setChallengePos]  = useState<any>(null)
  const sig = snap.last_signal

  const loadChart = useCallback(async (d: number) => {
    try {
      const r = await fetch(`/api/naren/v1/kite/chart-data?days=${d}`)
      if (r.ok) { const data = await r.json(); setChartBars(data.bars || []) }
    } catch { /* ignore */ }
  }, [])

  // Also fetch challenge position for the banner
  const loadChallengePos = useCallback(async () => {
    try {
      const r = await fetch('/api/naren/v1/live/state')
      if (r.ok) {
        const d = await r.json()
        if (d.open_option && d.open_trade) setChallengePos({ opt: d.open_option, trade: d.open_trade })
        else setChallengePos(null)
      }
    } catch { /* ignore */ }
  }, [])

  useEffect(() => { loadChart(days); loadChallengePos() }, [days, loadChart, loadChallengePos])

  const refresh = async () => {
    setLoading(true)
    try { await fetch('/api/naren/v1/kite/analyze'); onRefresh(); loadChart(days); loadChallengePos() }
    finally { setLoading(false) }
  }

  return (
    <div className="space-y-5">
      {/* Challenge position banner — shows when there's an open paper trade */}
      {challengePos && (
        <div className="bg-blue-500/10 border border-blue-500/40 rounded-xl px-5 py-3 flex items-center justify-between flex-wrap gap-3">
          <div className="flex items-center gap-3">
            <span className="text-blue-400 text-lg">📌</span>
            <div>
              <p className="text-xs text-blue-300 font-semibold">90-Day Challenge · Open Position</p>
              <p className="text-slate-200 font-mono font-semibold">{challengePos.trade.trading_symbol}</p>
              <p className="text-xs text-slate-400">Entry ₹{challengePos.opt.entry_premium?.toFixed(1)} · {challengePos.trade.direction} · Expiry {challengePos.trade.expiry}</p>
            </div>
          </div>
          <div className="text-right">
            {challengePos.opt.current_premium > 0 ? (
              <>
                <p className={`font-bold text-lg ${challengePos.opt.pnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                  {challengePos.opt.pnl >= 0 ? '+' : ''}₹{Math.abs(challengePos.opt.pnl).toLocaleString('en-IN', {maximumFractionDigits:0})}
                </p>
                <p className="text-xs text-slate-400">LTP ₹{challengePos.opt.current_premium?.toFixed(1)}</p>
              </>
            ) : (
              <p className="text-slate-400 text-sm animate-pulse">Fetching LTP…</p>
            )}
          </div>
          <a href="/live" className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-white text-xs rounded-lg transition-colors">
            View Live Terminal →
          </a>
        </div>
      )}

      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h2 className="text-lg font-semibold text-slate-100">Nifty 15-Min Live Chart + Signal</h2>
          <p className="text-slate-400 text-xs mt-0.5">EMA9 (blue) · EMA21 (orange) · 4-regime auto-strategy</p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex gap-1">
            {[1, 3, 5].map(d => (
              <button key={d} onClick={() => setDays(d)}
                className={`px-2.5 py-1 rounded text-xs font-medium transition-colors ${days === d ? 'bg-blue-600 text-white' : 'bg-slate-700 text-slate-400 hover:bg-slate-600'}`}>
                {d}D
              </button>
            ))}
          </div>
          <Chip label={snap.market_open ? '● Market Open' : '○ Market Closed'} color={snap.market_open ? 'green' : 'slate'} />
          <button onClick={refresh} disabled={loading}
            className="px-4 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm rounded-lg transition-colors">
            {loading ? 'Refreshing…' : '↻ Refresh'}
          </button>
        </div>
      </div>

      {/* Live chart */}
      <KiteChart bars={chartBars} height={380} title="NIFTY 15m · Live" />

      {!sig && (
        <div className="bg-slate-800/60 border border-slate-700/50 rounded-xl p-6 text-center text-slate-400">
          <p className="text-xl mb-2">📡</p>
          <p className="font-medium text-slate-300 mb-1">No signal generated yet</p>
          <p className="text-sm">Click Refresh to run the signal analysis on the chart above.</p>
          {snap.last_error && <p className="text-red-400 text-xs mt-2">⚠ {snap.last_error}</p>}
        </div>
      )}

      {sig && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
          {/* Signal card */}
          <div className="lg:col-span-2 bg-slate-800/70 rounded-xl border border-slate-700/50 p-5">
            <div className="flex items-start justify-between mb-3">
              <div>
                <p className="text-slate-400 text-xs mb-1">Current Signal · {sig.as_of ? new Date(sig.as_of).toLocaleTimeString('en-IN') : ''}</p>
                <p className="text-2xl font-bold text-slate-100">{STRAT_LABEL[sig.strategy] || sig.strategy}</p>
              </div>
              <div className="flex flex-col items-end gap-1">
                <DirChip dir={sig.direction} />
                <span className="text-xs text-slate-400">{sig.regime.replace(/_/g, ' ')}</span>
              </div>
            </div>

            <div className="mb-4">
              <div className="flex justify-between text-xs mb-1">
                <span className="text-slate-400">Confidence</span>
                <span className={`font-bold ${sig.confidence >= 65 ? 'text-emerald-400' : sig.confidence >= 50 ? 'text-yellow-400' : 'text-red-400'}`}>{sig.confidence}%</span>
              </div>
              <div className="h-2 bg-slate-700 rounded-full overflow-hidden">
                <div className={`h-full rounded-full ${sig.confidence >= 65 ? 'bg-emerald-500' : sig.confidence >= 50 ? 'bg-yellow-500' : 'bg-red-500'}`}
                  style={{ width: `${sig.confidence}%` }} />
              </div>
              {sig.confidence < 55 && <p className="text-yellow-400 text-xs mt-1">⚠ Below 55% auto-entry threshold</p>}
            </div>

            {/* Signal basis — why this signal fired */}
            <div className="mb-4 bg-slate-700/30 rounded-lg p-3">
              <p className="text-xs text-slate-400 font-semibold mb-2 uppercase tracking-wide">Signal Basis (Why this fired)</p>
              <ul className="space-y-1">
                {sig.reasoning.map((r, i) => (
                  <li key={i} className="flex gap-2 text-xs text-slate-300">
                    <span className="text-blue-400 shrink-0">›</span>{r}
                  </li>
                ))}
              </ul>
            </div>

            {/* Proposed legs */}
            {sig.legs && sig.legs.length > 0 && (
              <div>
                <p className="text-xs text-slate-400 mb-2">Proposed legs — ATM = {sig.atm_strike}</p>
                <div className="flex flex-wrap gap-2">
                  {sig.legs.map((l, i) => (
                    <div key={i} className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold border
                      ${l.side === 'BUY' ? 'bg-blue-500/15 text-blue-300 border-blue-500/30' : 'bg-orange-500/15 text-orange-300 border-orange-500/30'}`}>
                      {l.side} {l.option_type} @{sig.atm_strike + l.strike_offset}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Indicator panel */}
          <div className="space-y-3">
            <div className="bg-slate-800/70 rounded-xl border border-slate-700/50 p-4">
              <p className="text-xs text-slate-500 font-semibold uppercase tracking-wide mb-3">Indicator Values</p>
              {[
                ['Spot',       sig.indicators.spot?.toFixed(0)],
                ['ATM Strike', sig.atm_strike?.toFixed(0)],
                ['EMA 9',      sig.indicators.ema9?.toFixed(0)],
                ['EMA 21',     sig.indicators.ema21?.toFixed(0)],
                ['ATR (14)',   sig.indicators.atr14?.toFixed(1)],
                ['VWAP proxy', sig.indicators.vwap_proxy?.toFixed(0)],
                ['Trend Str.', `${sig.indicators.trend_strength?.toFixed(0)}/100`],
                ['Day Δ',      `${(sig.indicators.day_change_pct ?? 0) >= 0 ? '+' : ''}${sig.indicators.day_change_pct?.toFixed(2)}%`],
              ].map(([k, v]) => (
                <div key={k} className="flex justify-between text-xs py-1 border-b border-slate-700/30 last:border-0">
                  <span className="text-slate-500">{k}</span>
                  <span className="text-slate-200 font-mono">{v}</span>
                </div>
              ))}
            </div>
            {sig.indicators.or_high > 0 && (
              <div className="bg-slate-800/70 rounded-xl border border-slate-700/50 p-4">
                <p className="text-xs text-slate-500 font-semibold uppercase tracking-wide mb-2">Opening Range</p>
                {[
                  ['OR High', sig.indicators.or_high?.toFixed(0), 'text-emerald-400'],
                  ['OR Low',  sig.indicators.or_low?.toFixed(0),  'text-red-400'],
                  ['OR Range', ((sig.indicators.or_high - sig.indicators.or_low) || 0).toFixed(0) + ' pts', 'text-slate-200'],
                ].map(([k, v, c]) => (
                  <div key={k} className="flex justify-between text-xs py-1">
                    <span className="text-slate-500">{k}</span>
                    <span className={`font-mono ${c}`}>{v}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Paper trade tab ──────────────────────────────────────────────────────────

function PaperTab({ snap, onRefresh }: { snap: Snapshot; onRefresh: () => void }) {
  const post = async (url: string, body?: unknown) => {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
    const d = await r.json(); if (!r.ok) throw new Error(d.error || 'failed'); return d
  }
  const doAuto  = async (on: boolean)  => { await post('/api/naren/v1/paper/auto', { on }); onRefresh() }
  const doEnter = async () => { try { await post('/api/naren/v1/paper/enter'); onRefresh() } catch (e) { alert((e as Error).message) } }
  const doClose = async () => { await post('/api/naren/v1/paper/close'); onRefresh() }
  const doRR    = async (rr: number)   => { await post('/api/naren/v1/paper/params', { rr }); onRefresh() }

  const wr = snap.win_count + snap.loss_count > 0
    ? (snap.win_count / (snap.win_count + snap.loss_count) * 100).toFixed(0) : '0'

  const canEnter = !snap.open && snap.last_signal && snap.last_signal.strategy !== 'NO_TRADE' && (snap.last_signal.legs?.length ?? 0) > 0

  return (
    <div className="space-y-5">
      {/* Stats row */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <MetricCard label="Today's P&L" value={`${sgn(snap.today_realized)}₹${fmt(snap.today_realized)}`} color={pc(snap.today_realized)} />
        <MetricCard label="Open P&L"    value={`${sgn(snap.open_pnl)}₹${fmt(snap.open_pnl)}`}           color={pc(snap.open_pnl)} />
        <MetricCard label="Total Realized" value={`${sgn(snap.total_realized)}₹${fmt(snap.total_realized)}`} color={pc(snap.total_realized)} />
        <MetricCard label="Today's Trades" value={String(snap.today_trades)} />
        <MetricCard label="Win Rate" value={`${wr}%`} sub={`${snap.win_count}W / ${snap.loss_count}L`} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        {/* Controls */}
        <div className="bg-slate-800/70 rounded-xl border border-slate-700/50 p-5 space-y-4">
          <h3 className="text-sm font-semibold text-slate-200">Controls</h3>

          {/* Auto toggle */}
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-slate-200">Auto-Trade</p>
              <p className="text-xs text-slate-500">Enters when signal ≥ {snap.conf_threshold}%</p>
            </div>
            <button onClick={() => doAuto(!snap.auto_mode)}
              className={`relative w-12 h-6 rounded-full transition-colors ${snap.auto_mode ? 'bg-emerald-500' : 'bg-slate-600'}`}>
              <span className={`absolute top-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${snap.auto_mode ? 'translate-x-6' : 'translate-x-0.5'}`} />
            </button>
          </div>

          {/* Manual enter */}
          <button onClick={doEnter} disabled={!canEnter}
            className="w-full py-2.5 bg-blue-600 hover:bg-blue-500 disabled:bg-slate-700 disabled:text-slate-500 text-white text-sm rounded-lg font-medium transition-colors">
            Enter from Current Signal
          </button>

          {/* RR selector */}
          <div>
            <p className="text-xs text-slate-400 mb-1.5">Risk : Reward</p>
            <div className="flex gap-2">
              {[1.5, 2].map(r => (
                <button key={r} onClick={() => doRR(r)}
                  className={`flex-1 py-2 rounded-lg text-sm font-semibold transition-colors ${snap.rr === r ? 'bg-blue-600 text-white' : 'bg-slate-700 text-slate-300 hover:bg-slate-600'}`}>
                  1:{r}
                </button>
              ))}
            </div>
          </div>

          {/* Risk/target display */}
          <div className="grid grid-cols-2 gap-2 text-xs">
            {[
              ['Capital',      `₹${fmt(snap.capital)}`],
              ['Lots / Qty',   `${snap.lots} / ${snap.lots * 75}`],
              ['Risk / Trade', `₹${fmt(snap.capital * snap.risk_pct)}`],
              ['Target / Trade', `₹${fmt(snap.capital * snap.risk_pct * snap.rr)}`],
            ].map(([k, v]) => (
              <div key={k} className="bg-slate-700/40 rounded-lg p-2">
                <p className="text-slate-500 text-[10px]">{k}</p>
                <p className="text-slate-200 font-semibold">{v}</p>
              </div>
            ))}
          </div>
        </div>

        {/* Open position */}
        <div className="lg:col-span-2">
          {snap.open
            ? <OpenPosCard pos={snap.open} pnl={snap.open_pnl} onClose={doClose} />
            : (
              <div className="bg-slate-800/70 rounded-xl border border-slate-700/50 p-8 text-center h-full flex flex-col items-center justify-center gap-3">
                <p className="text-3xl">📋</p>
                <p className="text-slate-300 font-medium">No open position</p>
                <p className="text-slate-500 text-sm">
                  {snap.auto_mode
                    ? `Auto-trade ON — will enter when confidence ≥ ${snap.conf_threshold}%`
                    : 'Enable auto-trade or click "Enter from Current Signal"'}
                </p>
                {snap.last_signal && snap.last_signal.strategy !== 'NO_TRADE' && (
                  <div className="mt-2 text-xs text-blue-300 bg-blue-500/10 px-4 py-2 rounded-lg border border-blue-500/20">
                    Signal ready: <strong>{STRAT_LABEL[snap.last_signal.strategy]}</strong> · {snap.last_signal.confidence}% confidence
                  </div>
                )}
              </div>
            )
          }
        </div>
      </div>

      {/* History */}
      {snap.history && snap.history.length > 0 && (
        <div className="bg-slate-800/70 rounded-xl border border-slate-700/50 overflow-hidden">
          <div className="px-5 py-3 border-b border-slate-700/50">
            <h3 className="text-sm font-semibold text-slate-200">Paper Trade History</h3>
          </div>
          <div className="overflow-x-auto max-h-80 overflow-y-auto">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-slate-800/90">
                <tr className="text-slate-400 border-b border-slate-700/40">
                  {['Strategy', 'Dir', 'Entry Time', 'Exit Time', 'Reason', 'P&L'].map(h => (
                    <th key={h} className={`py-2 ${h === 'P&L' ? 'text-right px-5' : h === 'Strategy' ? 'text-left px-5' : 'text-left px-3'}`}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {snap.history.map(p => (
                  <tr key={p.id} className="border-b border-slate-700/20 hover:bg-slate-700/20">
                    <td className="px-5 py-2 text-slate-300">{STRAT_LABEL[p.strategy] || p.strategy}</td>
                    <td className="px-3 py-2"><DirChip dir={p.direction} /></td>
                    <td className="px-3 py-2 text-slate-400">{new Date(p.entry_time).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}</td>
                    <td className="px-3 py-2 text-slate-400">{p.exit_time ? new Date(p.exit_time).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }) : '—'}</td>
                    <td className="px-3 py-2 text-slate-500">{p.exit_reason}</td>
                    <td className={`px-5 py-2 text-right font-bold ${pc(p.realized_pnl)}`}>{sgn(p.realized_pnl)}₹{fmt(p.realized_pnl)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}

function OpenPosCard({ pos, pnl, onClose }: { pos: Position; pnl: number; onClose: () => void }) {
  const range = pos.target_pnl - pos.stop_pnl || 1
  const pct = Math.max(0, Math.min(100, ((pnl - pos.stop_pnl) / range) * 100))
  return (
    <div className="bg-slate-800/70 rounded-xl border border-slate-700/50 p-5 h-full">
      <div className="flex items-center justify-between mb-4">
        <div>
          <p className="text-xs text-slate-400 mb-1">Open Position</p>
          <p className="text-lg font-bold text-slate-100">{STRAT_LABEL[pos.strategy] || pos.strategy}</p>
        </div>
        <button onClick={onClose}
          className="px-4 py-1.5 bg-red-600/80 hover:bg-red-600 text-white text-xs font-semibold rounded-lg transition-colors">
          Close Position
        </button>
      </div>

      <p className={`text-4xl font-bold mb-1 ${pc(pnl)}`}>{sgn(pnl)}₹{fmt(pnl)}</p>
      <p className="text-xs text-slate-500 mb-4">Live P&L · entered {new Date(pos.entry_time).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })} · RR 1:{pos.rr}</p>

      {/* Gauge */}
      <div className="mb-4">
        <div className="flex justify-between text-[10px] mb-1">
          <span className="text-red-400">Stop -₹{fmt(-pos.stop_pnl)}</span>
          <span className="text-emerald-400">Target +₹{fmt(pos.target_pnl)}</span>
        </div>
        <div className="relative h-3 bg-slate-700 rounded-full overflow-visible">
          <div className="absolute inset-0 rounded-full overflow-hidden">
            <div className="h-full bg-gradient-to-r from-red-500/40 via-slate-700 to-emerald-500/40" />
          </div>
          <div className="absolute top-1/2 -translate-y-1/2 w-1.5 h-5 bg-white rounded-sm shadow-lg transition-all"
            style={{ left: `calc(${pct}% - 3px)` }} />
        </div>
      </div>

      {/* Legs */}
      <table className="w-full text-xs">
        <thead>
          <tr className="text-slate-500 border-b border-slate-700/40">
            <th className="text-left py-1">Leg</th><th className="text-left">Symbol</th>
            <th className="text-right">Entry ₹</th><th className="text-right">LTP ₹</th>
            <th className="text-right">P&L</th>
          </tr>
        </thead>
        <tbody>
          {pos.legs?.map((l, i) => {
            const lp = l.side === 'BUY' ? (l.current_premium - l.entry_premium) * l.qty : (l.entry_premium - l.current_premium) * l.qty
            return (
              <tr key={i} className="border-b border-slate-700/20">
                <td className="py-1.5">
                  <span className={`text-[10px] px-1.5 py-0.5 rounded font-bold ${l.side === 'BUY' ? 'bg-blue-500/20 text-blue-300' : 'bg-orange-500/20 text-orange-300'}`}>{l.side}</span>
                </td>
                <td className="font-mono text-slate-300">{l.trading_symbol}</td>
                <td className="text-right text-slate-400">₹{l.entry_premium.toFixed(1)}</td>
                <td className="text-right text-slate-300">₹{l.current_premium.toFixed(1)}</td>
                <td className={`text-right font-bold ${pc(lp)}`}>{sgn(lp)}₹{fmt(lp)}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

// ─── Backtest tab ─────────────────────────────────────────────────────────────

// ─── Shared: BacktestView renders metrics, chart, equity, trade-log ─────────

interface BacktestViewProps {
  result: BTResult
  expanded: number | null
  onExpand: (i: number | null) => void
}

function BacktestView({ result, expanded, onExpand }: BacktestViewProps) {
  const tradeMarkers: TradeMarker[] = useMemo(() => result.trades.map(t => ({
    entry_time: t.entry_time, exit_time: t.exit_time,
    direction: t.direction, pnl: t.pnl,
    strike: t.strike, option_type: t.option_type,
    expiry_label: t.expiry_label,
    entry_premium: t.entry_premium, exit_premium: t.exit_premium,
    price_source: t.price_source,
  })), [result])

  return (
    <div className="space-y-5">
      {/* Metrics */}
      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-3">
        <MetricCard label="Total P&L"    value={`${sgn(result.total_pnl)}₹${fmt(result.total_pnl)}`}    color={pc(result.total_pnl)} big />
        <MetricCard label="Win Rate"     value={`${fmtF(result.win_rate,0)}%`} sub={`${result.win_count}W ${result.loss_count}L`}
          color={result.win_rate>=50?'text-emerald-400':'text-yellow-400'} />
        <MetricCard label="R:R (actual)" value={fmtF(result.reward_risk)}
          color={result.reward_risk>=1.5?'text-emerald-400':result.reward_risk>=1?'text-yellow-400':'text-red-400'} />
        <MetricCard label="Profit Factor" value={fmtF(result.profit_factor)}
          color={result.profit_factor>=1.5?'text-emerald-400':result.profit_factor>=1?'text-yellow-400':'text-red-400'} />
        <MetricCard label="Expectancy"   value={`${sgn(result.expectancy)}₹${fmt(result.expectancy)}`} color={pc(result.expectancy)} />
        <MetricCard label="Max Drawdown" value={`₹${fmt(result.max_drawdown)}`} color="text-red-400" />
        <MetricCard label="Avg Win"      value={`+₹${fmt(result.avg_win)}`}     color="text-emerald-400" />
        <MetricCard label="Avg Loss"     value={`-₹${fmt(Math.abs(result.avg_loss))}`} color="text-red-400" />
      </div>

      {/* Pricing note */}
      <div className="bg-blue-500/8 border border-blue-500/20 rounded-xl px-4 py-2.5 text-xs text-blue-300 flex flex-wrap gap-3 items-center">
        <span>{result.pricing_note}</span>
        {result.max_consec_loss > 0 && <span className="text-red-300 border-l border-blue-500/20 pl-3">Max consec. losses: {result.max_consec_loss}</span>}
      </div>

      {/* Chart with signal overlays */}
      <KiteChart bars={result.bar_signals||[]} trades={tradeMarkers} height={380}
        title="NIFTY Chart · ▲ Entry  ✕ Exit  (scroll to pan)" />

      {/* Equity curve */}
      {result.equity_curve?.length > 1 && <EquityCurveChart points={result.equity_curve} />}

      {/* Trade log */}
      <div className="bg-slate-800/70 rounded-xl border border-slate-700/50 overflow-hidden">
        <div className="px-5 py-3 border-b border-slate-700/50 flex items-center justify-between flex-wrap gap-2">
          <h3 className="text-sm font-semibold text-slate-200">Trade Log</h3>
          <div className="flex items-center gap-3 text-xs text-slate-400">
            <span>{result.trades.length} trades · {result.lots} lots</span>
            {result.real_price_trades>0 && <span className="text-emerald-400">{result.real_price_trades} real</span>}
            <span className="text-yellow-400">{result.bs_price_trades} BS</span>
          </div>
        </div>
        <div className="overflow-x-auto max-h-[500px] overflow-y-auto">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-slate-800/95 z-10">
              <tr className="text-slate-400 border-b border-slate-700/40">
                {['#','Date·Time','Strategy','Dir','Spot','Strike','Type','Expiry','DTE','Entry₹','Exit₹','IV%','Δ','Src','Reason','P&L','P&L/Lot'].map(h=>(
                  <th key={h} className={`px-2 py-2 whitespace-nowrap ${['P&L','P&L/Lot'].includes(h)?'text-right':'text-left'}`}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {result.trades.map((t, i) => (
                <>
                  <tr key={i} onClick={()=>onExpand(expanded===i?null:i)}
                    className={`border-b border-slate-700/20 hover:bg-slate-700/20 cursor-pointer
                      ${t.pnl>=0?'':'bg-red-500/3'} ${expanded===i?'bg-slate-700/30':''}`}>
                    <td className="px-2 py-1.5 text-slate-500">{i+1}</td>
                    <td className="px-2 py-1.5 text-slate-400 whitespace-nowrap font-mono text-[10px]">
                      {new Date(t.entry_time).toLocaleString('en-IN',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'})}
                    </td>
                    <td className="px-2 py-1.5 text-slate-300 whitespace-nowrap text-[11px]">{STRAT_LABEL[t.strategy]||t.strategy}</td>
                    <td className="px-2 py-1.5"><DirChip dir={t.direction}/></td>
                    <td className="px-2 py-1.5 text-right text-slate-400 font-mono">{t.entry_spot.toFixed(0)}</td>
                    <td className="px-2 py-1.5 text-right text-slate-200 font-mono font-semibold">{t.strike.toFixed(0)}</td>
                    <td className="px-2 py-1.5">
                      <span className={`text-[10px] px-1.5 py-0.5 rounded font-bold ${t.option_type?.includes('CE')?'bg-blue-500/20 text-blue-300':t.option_type?.includes('PE')?'bg-purple-500/20 text-purple-300':'bg-orange-500/20 text-orange-300'}`}>
                        {t.option_type}
                      </span>
                    </td>
                    <td className="px-2 py-1.5 font-mono text-[10px] text-emerald-300 whitespace-nowrap">{t.expiry_label||t.expiry}</td>
                    <td className="px-2 py-1.5 text-right text-slate-400">{t.dte}d</td>
                    <td className="px-2 py-1.5 text-right font-mono text-slate-200">{t.entry_premium>0?`₹${t.entry_premium.toFixed(1)}`:'—'}</td>
                    <td className="px-2 py-1.5 text-right font-mono text-slate-300">{t.exit_premium>0?`₹${t.exit_premium.toFixed(1)}`:'—'}</td>
                    <td className="px-2 py-1.5 text-right text-slate-400">{t.iv>0?t.iv.toFixed(1):'—'}</td>
                    <td className="px-2 py-1.5 text-right text-slate-400">{t.delta_entry?t.delta_entry.toFixed(2):'—'}</td>
                    <td className="px-2 py-1.5">
                      <span className={`text-[10px] px-1.5 py-0.5 rounded font-bold ${t.price_source==='REAL'?'bg-emerald-500/20 text-emerald-300':'bg-yellow-500/15 text-yellow-400'}`}>{t.price_source}</span>
                    </td>
                    <td className="px-2 py-1.5 text-slate-500 whitespace-nowrap text-[10px]">{t.exit_reason}</td>
                    <td className={`px-2 py-1.5 text-right font-bold whitespace-nowrap ${pc(t.pnl)}`}>{sgn(t.pnl)}₹{fmt(t.pnl)}</td>
                    <td className={`px-2 py-1.5 text-right font-semibold whitespace-nowrap ${pc(t.pnl_per_lot)}`}>{sgn(t.pnl_per_lot)}₹{fmt(t.pnl_per_lot)}</td>
                  </tr>
                  {expanded===i && t.signal_basis?.length>0 && (
                    <tr key={`${i}-b`} className="bg-slate-700/20">
                      <td colSpan={17} className="px-6 pb-3 pt-1">
                        <p className="text-[10px] text-slate-500 font-semibold uppercase tracking-wide mb-1">Signal Basis — click to collapse</p>
                        <ul className="space-y-0.5">{t.signal_basis.map((b,j)=>(
                          <li key={j} className="text-xs text-slate-400 flex gap-2"><span className="text-blue-400">›</span>{b}</li>
                        ))}</ul>
                      </td>
                    </tr>
                  )}
                </>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

// ─── NSE Upload panel ─────────────────────────────────────────────────────────

interface NseStats { loaded: boolean; total_records?: number; expiry_dates?: number; date_from?: string; date_to?: string }

function NseUploadPanel({ onImported }: { onImported: () => void }) {
  const [dragging, setDragging] = useState(false)
  const [loading,  setLoading]  = useState(false)
  const [stats,    setStats]    = useState<NseStats | null>(null)
  const [msg,      setMsg]      = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  const fetchStats = useCallback(async () => {
    try { const r = await fetch('/api/naren/v1/kite/nse-status'); if (r.ok) setStats(await r.json()) } catch { /**/ }
  }, [])
  useEffect(() => { fetchStats() }, [fetchStats])

  const upload = async (file: File) => {
    setLoading(true); setMsg('')
    try {
      const form = new FormData(); form.append('file', file)
      const r = await fetch('/api/naren/v1/kite/import-nse', { method: 'POST', body: form })
      const d = await r.json()
      if (!r.ok) throw new Error(d.error||'import failed')
      setMsg(d.message); fetchStats(); onImported()
    } catch (e) { setMsg('Error: '+(e as Error).message) }
    finally { setLoading(false) }
  }

  const onDrop = (e: React.DragEvent) => { e.preventDefault(); setDragging(false); const f=e.dataTransfer.files[0]; if(f) upload(f) }

  return (
    <div className="bg-slate-800/60 border border-slate-700/50 rounded-xl overflow-hidden">
      <div className="px-5 py-3 border-b border-slate-700/50 flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-slate-200">NSE Bhavcopy Database</span>
          {stats?.loaded
            ? <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">● Loaded</span>
            : <span className="text-[10px] px-2 py-0.5 rounded-full bg-slate-700 text-slate-400">Not loaded</span>}
        </div>
        {stats?.loaded && (
          <span className="text-xs text-slate-400">
            {stats.total_records?.toLocaleString()} records · {stats.expiry_dates} expiries · {stats.date_from} → {stats.date_to}
          </span>
        )}
      </div>
      <div className="p-5 space-y-3">
        {!stats?.loaded && (
          <p className="text-xs text-slate-400 leading-relaxed">
            Upload the CSV from the NSE downloader script to enable real settlement prices for the 1-year backtest.
            Run the script <strong className="text-slate-300">locally</strong> (NSE blocks cloud IPs), then upload the{' '}
            <span className="font-mono text-blue-400">nifty_options_expiry_chains.csv</span>.
          </p>
        )}
        <div
          onDragOver={e=>{e.preventDefault();setDragging(true)}} onDragLeave={()=>setDragging(false)} onDrop={onDrop}
          onClick={()=>inputRef.current?.click()}
          className={`border-2 border-dashed rounded-lg p-5 text-center cursor-pointer transition-colors
            ${dragging?'border-blue-400 bg-blue-500/10':'border-slate-600 hover:border-slate-400'}`}>
          <input ref={inputRef} type="file" accept=".csv" className="hidden" onChange={e=>e.target.files?.[0]&&upload(e.target.files[0])} />
          {loading
            ? <p className="text-slate-400 text-sm">Importing…</p>
            : <><p className="text-slate-200 font-medium text-sm mb-1">{stats?.loaded ? 'Re-upload to refresh' : 'Drop CSV here or click to browse'}</p>
                <p className="text-slate-500 text-xs">nifty_options_expiry_chains.csv</p></>}
        </div>
        {msg && <p className={`text-xs ${msg.startsWith('Error')?'text-red-400':'text-emerald-400'}`}>{msg}</p>}
      </div>
    </div>
  )
}

// ─── BacktestTab — 3 sub-modes ────────────────────────────────────────────────

type BtMode = 'intraday' | 'daily' | 'nse'

const BT_MODES: {key:BtMode; label:string; sub:string; days:number; endpoint:string}[] = [
  { key:'intraday', label:'Intraday 15m',  sub:'60d · 15m signals · real Kite prices',   days:60,  endpoint:'/api/naren/v1/kite/backtest' },
  { key:'daily',    label:'Daily 1-Year',  sub:'365d · EMA20/50 · next-day open entry',  days:365, endpoint:'/api/naren/v1/kite/backtest-daily' },
  { key:'nse',      label:'NSE Enhanced',  sub:'Upload bhavcopy → real settlement exits', days:365, endpoint:'/api/naren/v1/kite/backtest-daily' },
]

// ─── Scalp strategy backtest (EMA50/200 + Stochastic, 1-min ATM CE/PE) ────────

interface ScalpTrade {
  entry_time: string; exit_time: string; direction: string; option_type: string
  strike: number; entry_spot: number; exit_spot: number
  entry_premium: number; exit_premium: number; pnl: number; reason: string
}
interface ScalpResult {
  days: number; lots: number; rr: number; trades: number; wins: number; losses: number
  win_rate: number; total_pnl: number; avg_pnl: number; max_drawdown: number
  profit_factor: number; equity: number[]; trade_list: ScalpTrade[]; summary: string
}

function ScalpSparkline({ equity }: { equity: number[] }) {
  if (!equity || equity.length < 2) return null
  const w = 280, h = 48
  const min = Math.min(0, ...equity), max = Math.max(0, ...equity)
  const span = max - min || 1
  const pts = equity.map((v, i) => {
    const x = (i / (equity.length - 1)) * w
    const y = h - ((v - min) / span) * h
    return `${x.toFixed(1)},${y.toFixed(1)}`
  }).join(' ')
  const last = equity[equity.length - 1]
  return (
    <svg width={w} height={h} className="overflow-visible">
      <line x1="0" y1={h - ((0 - min) / span) * h} x2={w} y2={h - ((0 - min) / span) * h}
        stroke="#475569" strokeWidth="1" strokeDasharray="3 3" />
      <polyline points={pts} fill="none" stroke={last >= 0 ? '#34d399' : '#f87171'} strokeWidth="2" />
    </svg>
  )
}

function ScalpBacktestPanel() {
  const [days, setDays] = useState(10)
  const [rr, setRr] = useState(1.5)
  const [lots, setLots] = useState(2)
  const [loading, setLoading] = useState(false)
  const [res, setRes] = useState<ScalpResult | null>(null)
  const [err, setErr] = useState('')
  const ran = useRef(false)

  const run = useCallback(async () => {
    setLoading(true); setErr(''); setRes(null)
    try {
      const r = await fetch('/api/naren/v1/kite/scalp-backtest', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ days, rr, lots }),
      })
      const d = await r.json()
      if (!r.ok) throw new Error(d.error || 'scalp backtest failed')
      setRes(d)
    } catch (e) { setErr((e as Error).message) }
    finally { setLoading(false) }
  }, [days, rr, lots])

  useEffect(() => { if (!ran.current) { ran.current = true; run() } }, [run])

  return (
    <div className="bg-gradient-to-br from-emerald-500/5 to-slate-800/40 border border-emerald-600/30 rounded-2xl p-5 space-y-4">
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h3 className="text-base font-semibold text-emerald-300">⚡ 1-Min Scalp — EMA50/200 + Stochastic</h3>
          <p className="text-xs text-slate-400 mt-0.5">
            Trend by EMA50/200 · entry on Stochastic 20/80 cross · swing stop · {rr}:1 R:R · ATM CE/PE
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-xs text-slate-400">Days
            <select value={days} onChange={e => setDays(+e.target.value)}
              className="block mt-1 bg-slate-800 border border-slate-700 rounded px-2 py-1 text-sm text-slate-200">
              {[5, 10, 15, 20, 30].map(d => <option key={d} value={d}>{d}</option>)}
            </select>
          </label>
          <label className="text-xs text-slate-400">Lots
            <select value={lots} onChange={e => setLots(+e.target.value)}
              className="block mt-1 bg-slate-800 border border-slate-700 rounded px-2 py-1 text-sm text-slate-200">
              {[1, 2, 5, 10].map(d => <option key={d} value={d}>{d}</option>)}
            </select>
          </label>
          <div>
            <p className="text-xs text-slate-400 mb-1">R:R</p>
            <div className="flex gap-1">
              {[1.5, 2].map(r => (
                <button key={r} onClick={() => setRr(r)}
                  className={`px-3 py-1.5 rounded text-sm font-semibold transition-colors ${rr === r ? 'bg-emerald-600 text-white' : 'bg-slate-700 text-slate-300 hover:bg-slate-600'}`}>
                  1:{r}
                </button>
              ))}
            </div>
          </div>
          <button onClick={run} disabled={loading}
            className="px-5 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-60 text-white font-semibold rounded-lg transition-colors">
            {loading ? '⏳ Running…' : '▶ Run'}
          </button>
        </div>
      </div>

      {err && !loading && (
        <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-3 text-sm text-red-300">{err}</div>
      )}

      {res && !loading && (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
            {[
              { l: 'Trades', v: res.trades },
              { l: 'Win Rate', v: `${res.win_rate}%` },
              { l: 'Net P&L', v: `₹${res.total_pnl.toLocaleString('en-IN')}`, c: res.total_pnl >= 0 ? 'text-emerald-400' : 'text-red-400' },
              { l: 'Avg/Trade', v: `₹${res.avg_pnl.toLocaleString('en-IN')}`, c: res.avg_pnl >= 0 ? 'text-emerald-400' : 'text-red-400' },
              { l: 'Profit Factor', v: res.profit_factor },
              { l: 'Max DD', v: `₹${res.max_drawdown.toLocaleString('en-IN')}`, c: 'text-red-400' },
            ].map(m => (
              <div key={m.l} className="bg-slate-800/60 border border-slate-700/50 rounded-lg p-3">
                <p className="text-[11px] text-slate-400">{m.l}</p>
                <p className={`text-lg font-semibold ${m.c || 'text-slate-100'}`}>{m.v}</p>
              </div>
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-6">
            <div>
              <p className="text-xs text-slate-400 mb-1">Equity curve (cumulative ₹)</p>
              <ScalpSparkline equity={res.equity} />
            </div>
            <p className="text-xs text-slate-500">{res.wins}W / {res.losses}L · {res.summary}</p>
          </div>

          {res.trade_list.length > 0 && (
            <div className="max-h-64 overflow-auto rounded-lg border border-slate-700/50">
              <table className="w-full text-xs">
                <thead className="bg-slate-800 text-slate-400 sticky top-0">
                  <tr>
                    <th className="text-left px-2 py-1.5">Entry</th>
                    <th className="text-left px-2 py-1.5">Dir</th>
                    <th className="text-right px-2 py-1.5">Strike</th>
                    <th className="text-right px-2 py-1.5">Entry₹</th>
                    <th className="text-right px-2 py-1.5">Exit₹</th>
                    <th className="text-right px-2 py-1.5">P&L</th>
                    <th className="text-left px-2 py-1.5">Why</th>
                  </tr>
                </thead>
                <tbody>
                  {res.trade_list.slice().reverse().map((t, i) => (
                    <tr key={i} className="border-t border-slate-800/70">
                      <td className="px-2 py-1.5 text-slate-300">{new Date(t.entry_time).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}</td>
                      <td className={`px-2 py-1.5 font-medium ${t.option_type === 'CE' ? 'text-emerald-400' : 'text-red-400'}`}>{t.option_type}</td>
                      <td className="px-2 py-1.5 text-right text-slate-300">{t.strike}</td>
                      <td className="px-2 py-1.5 text-right text-slate-400">{t.entry_premium}</td>
                      <td className="px-2 py-1.5 text-right text-slate-400">{t.exit_premium}</td>
                      <td className={`px-2 py-1.5 text-right font-semibold ${t.pnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{t.pnl >= 0 ? '+' : ''}{t.pnl.toLocaleString('en-IN')}</td>
                      <td className="px-2 py-1.5 text-slate-500">{t.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  )
}

function BacktestTab() {
  const [mode,     setMode]     = useState<BtMode>('intraday')
  const [rr,       setRr]       = useState(2)
  const [loading,  setLoading]  = useState(false)
  const [results,  setResults]  = useState<Record<BtMode, BTResult|null>>({ intraday:null, daily:null, nse:null })
  const [errors,   setErrors]   = useState<Record<BtMode, string>>({ intraday:'', daily:'', nse:'' })
  const [expanded, setExpanded] = useState<number|null>(null)
  const ranRef = useRef<Set<string>>(new Set())

  const cfg = BT_MODES.find(m => m.key === mode)!

  const run = useCallback(async (m: BtMode) => {
    const c = BT_MODES.find(x=>x.key===m)!
    setLoading(true)
    setErrors(e => ({...e, [m]:''}))
    setResults(r => ({...r, [m]:null}))
    setExpanded(null)
    try {
      const r = await fetch(c.endpoint, {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ days:c.days, rr, risk_pct:0.015, lots:2, conf:55 }),
      })
      const d = await r.json()
      if (!r.ok) throw new Error(d.error||'backtest failed')
      setResults(prev => ({...prev, [m]:d}))
    } catch(e) { setErrors(prev => ({...prev, [m]:(e as Error).message})) }
    finally { setLoading(false) }
  }, [rr])

  useEffect(() => {
    if (!ranRef.current.has('intraday')) { ranRef.current.add('intraday'); run('intraday') }
  }, [run])

  const switchMode = (m: BtMode) => {
    setMode(m); setExpanded(null)
    if (!ranRef.current.has(m) && m !== 'nse') { ranRef.current.add(m); run(m) }
  }

  const result = results[mode]
  const error  = errors[mode]

  return (
    <div className="space-y-5">
      {/* Scalp strategy backtest (EMA50/200 + Stochastic) */}
      <ScalpBacktestPanel />

      {/* Mode + RR + Run controls */}
      <div className="flex flex-wrap gap-3 items-end">
        <div className="flex bg-slate-800/60 rounded-xl p-1 border border-slate-700/50 gap-1">
          {BT_MODES.map(m => (
            <button key={m.key} onClick={() => switchMode(m.key)}
              className={`px-4 py-2 rounded-lg transition-colors ${mode===m.key?'bg-blue-600 text-white shadow':'text-slate-400 hover:text-slate-200 hover:bg-slate-700/60'}`}>
              <span className="text-sm font-medium">{m.label}</span>
              <span className="block text-[10px] font-normal opacity-70">{m.sub}</span>
            </button>
          ))}
        </div>

        <div>
          <p className="text-xs text-slate-400 mb-1">R:R</p>
          <div className="flex gap-1">
            {[1.5,2].map(r=>(
              <button key={r} onClick={()=>setRr(r)}
                className={`px-4 py-1.5 rounded text-sm font-semibold transition-colors ${rr===r?'bg-blue-600 text-white':'bg-slate-700 text-slate-300 hover:bg-slate-600'}`}>
                1:{r}
              </button>
            ))}
          </div>
        </div>

        <button onClick={() => run(mode)} disabled={loading}
          className="px-6 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-60 text-white font-semibold rounded-lg transition-colors">
          {loading ? '⏳ Running…' : '▶ Run'}
        </button>

        {result && !loading && (
          <span className="text-xs text-slate-400">
            {new Date(result.from).toLocaleDateString('en-IN')} → {new Date(result.to).toLocaleDateString('en-IN')}
            &nbsp;·&nbsp;<strong className="text-slate-300">{result.trades.length} trades</strong>
          </span>
        )}
      </div>

      {/* NSE upload panel (always visible in NSE mode) */}
      {mode === 'nse' && <NseUploadPanel onImported={() => run('nse')} />}

      {loading && (
        <div className="flex items-center justify-center py-14 gap-4">
          <div className="w-8 h-8 border-4 border-blue-500 border-t-transparent rounded-full animate-spin" />
          <div>
            <p className="text-slate-200 font-medium">Running {cfg.label} backtest…</p>
            <p className="text-slate-400 text-sm">{cfg.sub}</p>
          </div>
        </div>
      )}

      {error && !loading && (
        <div className="bg-red-500/10 border border-red-500/30 rounded-xl p-5">
          <p className="text-red-300 font-medium mb-1">{cfg.label} failed</p>
          <p className="text-red-400 text-sm">{error}</p>
        </div>
      )}

      {result && !loading && (
        <BacktestView result={result} expanded={expanded} onExpand={setExpanded} />
      )}

      {mode === 'nse' && !result && !loading && !error && (
        <div className="bg-slate-800/40 rounded-xl border border-slate-700/30 p-8 text-center text-slate-400">
          <p className="text-xl mb-2">📁</p>
          <p className="font-medium text-slate-300 mb-1">Upload NSE bhavcopy CSV first</p>
          <p className="text-sm">Once loaded, click Run to backtest with real settlement prices.</p>
        </div>
      )}
    </div>
  )
}


// ─── Equity curve SVG ─────────────────────────────────────────────────────────

function EquityCurveChart({ points }: { points: EquityPt[] }) {
  const w = 900, h = 180, padX = 8, padY = 10
  const vals = points.map(p => p.equity)
  const minV = Math.min(0, ...vals), maxV = Math.max(0, ...vals)
  const range = maxV - minV || 1
  const sx = (i: number) => padX + (i / Math.max(points.length - 1, 1)) * (w - 2 * padX)
  const sy = (v: number) => h - padY - ((v - minV) / range) * (h - 2 * padY)
  const path  = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${sx(i).toFixed(1)},${sy(p.equity).toFixed(1)}`).join(' ')
  const last  = vals[vals.length - 1]
  const zeroY = sy(0)
  const fill  = `${path} L${sx(points.length - 1).toFixed(1)},${zeroY.toFixed(1)} L${padX},${zeroY.toFixed(1)} Z`
  const col   = last >= 0 ? '#34d399' : '#f87171'

  return (
    <div className="bg-slate-800/70 rounded-xl border border-slate-700/50 p-5">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-slate-200">Equity Curve</h3>
        <span className={`text-base font-bold ${pc(last)}`}>{sgn(last)}₹{fmt(last)}</span>
      </div>
      <svg viewBox={`0 0 ${w} ${h}`} className="w-full" preserveAspectRatio="none" style={{ height: 140 }}>
        <defs>
          <linearGradient id="eq2" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={col} stopOpacity="0.35" />
            <stop offset="100%" stopColor={col} stopOpacity="0" />
          </linearGradient>
        </defs>
        <line x1={padX} y1={zeroY} x2={w - padX} y2={zeroY} stroke="#475569" strokeWidth="1" strokeDasharray="4 3" />
        <path d={fill} fill="url(#eq2)" />
        <path d={path} fill="none" stroke={col} strokeWidth="2" />
      </svg>
    </div>
  )
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function KiteTerminal() {
  const [searchParams, setSearchParams] = useSearchParams()
  const tabParam = searchParams.get('tab') as Tab | null
  const urlError = searchParams.get('error') ?? ''

  const [tab, setTab] = useState<Tab>(
    tabParam && ['signals', 'paper', 'backtest'].includes(tabParam) ? tabParam : 'signals'
  )
  const [kiteStatus, setKiteStatus] = useState<KiteStatus | null>(null)
  const [snap,       setSnap]       = useState<Snapshot | null>(null)
  const [statusErr,  setStatusErr]  = useState('')

  const fetchStatus = useCallback(async () => {
    try {
      const r = await fetch('/api/naren/v1/kite/status')
      if (r.ok) { setKiteStatus(await r.json()); setStatusErr('') }
      else setStatusErr('Could not reach backend — is the server running on :8082?')
    } catch { setStatusErr('Backend unreachable — is the server running on :8082?') }
  }, [])

  const fetchSnap = useCallback(async () => {
    try { const r = await fetch('/api/naren/v1/paper/state'); if (r.ok) setSnap(await r.json()) } catch { /* ignore */ }
  }, [])

  useEffect(() => { fetchStatus(); fetchSnap() }, [fetchStatus, fetchSnap])

  // Clear ?error / ?connected from the URL after reading them (keep tab)
  useEffect(() => {
    if (urlError || searchParams.get('connected')) {
      const next: Record<string, string> = {}
      if (tabParam) next['tab'] = tabParam
      setSearchParams(next, { replace: true })
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (tab !== 'paper') return
    const id = setInterval(fetchSnap, 5000)
    return () => clearInterval(id)
  }, [tab, fetchSnap])

  const changeTab = (t: Tab) => { setTab(t); setSearchParams({ tab: t }, { replace: true }) }

  const disconnect = async () => {
    await fetch('/api/naren/v1/kite/disconnect', { method: 'POST' })
    fetchStatus()
  }

  const connected = !!kiteStatus?.connected

  return (
    <div className="max-w-7xl mx-auto px-4 py-6 space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-100">🪁 Kite Terminal</h1>
          <p className="text-slate-400 text-sm mt-0.5">
            Nifty 15m · Paper trading · Black-Scholes backtest
            <span className="ml-2 text-xs text-blue-400">read-only · no live orders ever</span>
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap justify-end">
          {connected ? (
            <>
              <div className="flex items-center gap-2 bg-emerald-500/10 border border-emerald-500/30 px-4 py-2 rounded-xl">
                <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                <span className="text-emerald-300 text-sm font-medium">
                  Connected{kiteStatus?.user ? ` · ${kiteStatus.user}` : ''}
                </span>
                {kiteStatus?.ticker_running && (
                  <span className="text-[10px] bg-blue-500/20 text-blue-300 px-1.5 py-0.5 rounded font-semibold">WS Live</span>
                )}
              </div>
              {kiteStatus?.auto_login ? (
                <div className="flex items-center gap-1.5 bg-purple-500/10 border border-purple-500/30 px-3 py-2 rounded-xl text-xs text-purple-300">
                  <span>🔄</span>
                  <span>Auto-renew {kiteStatus.next_refresh_at ? `@ ${new Date(kiteStatus.next_refresh_at).toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit'})} IST` : 'daily'}</span>
                </div>
              ) : (
                <span className="text-[10px] text-yellow-400 bg-yellow-500/10 border border-yellow-500/20 px-2 py-1 rounded-lg">
                  ⚠ Manual login needed tomorrow
                </span>
              )}
              <button onClick={disconnect}
                className="px-3 py-2 bg-slate-700/80 hover:bg-red-900/60 text-slate-400 hover:text-red-300 text-xs rounded-xl transition-colors">
                Disconnect
              </button>
            </>
          ) : (
            <div className="flex items-center gap-2">
              <a href="/api/naren/v1/kite/login"
                className="flex items-center gap-2 bg-blue-600 hover:bg-blue-500 px-4 py-2 rounded-xl text-white text-sm font-semibold transition-colors">
                <span className="w-2 h-2 rounded-full bg-white/60" />
                Login with Kite (browser)
              </a>
              {kiteStatus?.auto_login && (
                <button
                  onClick={async () => {
                    const r = await fetch('/api/naren/v1/kite/auto-login', { method: 'POST' })
                    const d = await r.json()
                    if (d.error) alert('Auto-login failed: ' + d.error)
                    else { fetchStatus(); fetchSnap() }
                  }}
                  className="flex items-center gap-2 bg-purple-600 hover:bg-purple-500 px-4 py-2 rounded-xl text-white text-sm font-semibold transition-colors">
                  🔄 Auto-Login
                </button>
              )}
            </div>
          )}
          <button onClick={() => { fetchStatus(); fetchSnap() }}
            className="px-3 py-2 bg-slate-700/80 hover:bg-slate-700 text-slate-300 text-sm rounded-xl transition-colors">
            ↻
          </button>
        </div>
      </div>

      {statusErr && (
        <div className="bg-red-500/10 border border-red-500/30 rounded-xl px-5 py-3 text-red-300 text-sm">
          ⚠ {statusErr}
        </div>
      )}

      {!connected && (
        <LoginBanner error={urlError} onTokenSet={() => { fetchStatus(); fetchSnap() }}
          autoLoginAvailable={!!kiteStatus?.auto_login} />
      )}

      {connected && (
        <>
          <div className="flex gap-1 bg-slate-800/60 rounded-xl p-1 w-fit border border-slate-700/50">
            {TABS.map(t => (
              <button key={t.key} onClick={() => changeTab(t.key)}
                className={`flex items-center gap-2 px-5 py-2 rounded-lg text-sm font-medium transition-colors
                  ${tab === t.key ? 'bg-blue-600 text-white shadow-sm' : 'text-slate-400 hover:text-slate-200 hover:bg-slate-700/60'}`}>
                <span>{t.icon}</span>{t.label}
              </button>
            ))}
          </div>

          {tab === 'signals'  && snap && <SignalsTab  snap={snap}  onRefresh={fetchSnap} />}
          {tab === 'paper'    && snap && <PaperTab    snap={snap}  onRefresh={fetchSnap} />}
          {tab === 'backtest' && <BacktestTab />}
          {!snap && <div className="py-10 text-center text-slate-400">Loading…</div>}
        </>
      )}
    </div>
  )
}
