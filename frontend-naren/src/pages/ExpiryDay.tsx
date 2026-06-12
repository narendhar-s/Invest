import { useEffect, useState, useCallback } from 'react'
import axios from 'axios'

const apiClient = axios.create({ baseURL: '/api/naren/v1', timeout: 30000 })

// ─── Types ────────────────────────────────────────────────────────────────────

interface ExpiryLeg {
  action: string
  option_type: string
  strike: number
  ltp: number
  entry_price: number
  target: number
  stop: number
  lot_size: number
  iv: number
  oi: number
  pnl_target: number
  pnl_stop: number
  label: string
  direction?: string
}

interface PnLScenario {
  label: string
  spot_move: string
  pnl_inr: number
  pnl_pct: number
}

interface ExpirySetup {
  name: string
  type: string
  side: string
  description: string
  legs: ExpiryLeg[]
  net_premium: number
  max_profit_inr: number
  max_loss_inr: number
  breakeven_up: number
  breakeven_down: number
  risk_reward: number
  confidence: number
  phase: string
  phase_reason: string
  rules: string[]
  pnl_scenarios: PnLScenario[]
  priority: number
}

interface ORBState {
  active: boolean
  high_level: number
  low_level: number
  range_size: number
  status: string
}

interface ExpiryDaySignal {
  is_expiry_day: boolean
  expiry_type: string
  days_to_expiry: number
  next_expiry: string
  spot_price: number
  atm_strike: number
  max_pain_strike: number
  spot_vs_max_pain: number
  vix: number
  pcr: number
  market_sentiment: string
  time_phase: string
  time_phase_desc: string
  minutes_to_close: number
  orb: ORBState
  setups: ExpirySetup[]
  warnings: string[]
  summary: string
  generated_at: string
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const fmt  = (n: number, d = 0) => n?.toLocaleString('en-IN', { maximumFractionDigits: d, minimumFractionDigits: d }) ?? '—'
const fmtP = (n: number) => (n >= 0 ? '+' : '') + n?.toFixed(1) + '%'
const fmtINR = (n: number) => (n >= 0 ? '₹+' : '₹') + fmt(n, 0)

const PHASE_COLORS: Record<string, string> = {
  IDEAL: 'text-emerald-400 bg-emerald-900/30 border-emerald-700/50',
  GOOD:  'text-blue-400 bg-blue-900/30 border-blue-700/50',
  LATE:  'text-amber-400 bg-amber-900/30 border-amber-700/50',
  AVOID: 'text-red-400 bg-red-900/30 border-red-700/50',
}

const PHASE_BADGE: Record<string, string> = {
  PRE_OPEN:   'bg-slate-700 text-slate-300',
  ORB_WINDOW: 'bg-blue-700 text-blue-100',
  PRIME_TIME: 'bg-emerald-700 text-emerald-100',
  GOOD_TIME:  'bg-teal-700 text-teal-100',
  LATE:       'bg-amber-700 text-amber-100',
  AVOID:      'bg-red-700 text-red-100',
  CLOSE:      'bg-slate-800 text-slate-400',
}

// ─── Components ───────────────────────────────────────────────────────────────

function PhaseBadge({ phase }: { phase: string }) {
  const labels: Record<string, string> = {
    PRE_OPEN: '⏳ Pre-Open', ORB_WINDOW: '📊 ORB Window',
    PRIME_TIME: '🟢 Prime Time', GOOD_TIME: '🔵 Good Time',
    LATE: '🟡 Late Session', AVOID: '🔴 Avoid New Trades', CLOSE: '🔒 Market Closed',
  }
  return (
    <span className={`px-2.5 py-1 rounded-lg text-xs font-bold tracking-wide ${PHASE_BADGE[phase] ?? 'bg-slate-700 text-slate-300'}`}>
      {labels[phase] ?? phase}
    </span>
  )
}

function ConfidenceBar({ pct }: { pct: number }) {
  const color = pct >= 70 ? 'bg-emerald-500' : pct >= 55 ? 'bg-amber-500' : 'bg-red-500'
  const text  = pct >= 70 ? 'text-emerald-400' : pct >= 55 ? 'text-amber-400' : 'text-red-400'
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-1.5 bg-slate-800 rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <span className={`text-xs font-mono font-bold ${text}`}>{pct}%</span>
    </div>
  )
}

function LegRow({ leg }: { leg: ExpiryLeg }) {
  const isSell = leg.action === 'SELL'
  const isCE   = leg.option_type === 'CE'
  return (
    <div className={`rounded-lg border p-3 ${
      isSell
        ? 'border-orange-700/40 bg-orange-950/20'
        : isCE
          ? 'border-emerald-700/40 bg-emerald-950/20'
          : 'border-red-700/40 bg-red-950/20'
    }`}>
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <span className={`text-xs font-bold px-1.5 py-0.5 rounded ${
            isSell ? 'bg-orange-800 text-orange-200' : 'bg-blue-800 text-blue-200'
          }`}>{leg.action}</span>
          <span className={`text-sm font-bold font-mono ${isCE ? 'text-emerald-300' : 'text-red-300'}`}>
            {fmt(leg.strike, 0)} {leg.option_type}
          </span>
          <span className="text-xs text-slate-500">{leg.label}</span>
        </div>
        <div className="text-right">
          <div className="text-xs text-slate-500">LTP</div>
          <div className="font-mono font-bold text-white">₹{leg.ltp.toFixed(1)}</div>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-2 text-xs">
        <div className="bg-slate-900/50 rounded p-1.5">
          <div className="text-slate-500 mb-0.5">Entry</div>
          <div className="font-mono text-white font-semibold">₹{leg.entry_price.toFixed(1)}</div>
        </div>
        {leg.action === 'BUY' && (
          <>
            <div className="bg-emerald-950/50 rounded p-1.5">
              <div className="text-slate-500 mb-0.5">Target</div>
              <div className="font-mono text-emerald-300 font-semibold">₹{leg.target.toFixed(1)}</div>
            </div>
            <div className="bg-red-950/50 rounded p-1.5">
              <div className="text-slate-500 mb-0.5">Stop</div>
              <div className="font-mono text-red-300 font-semibold">₹{leg.stop.toFixed(1)}</div>
            </div>
          </>
        )}
        {leg.action === 'SELL' && (
          <>
            <div className="bg-slate-900/50 rounded p-1.5">
              <div className="text-slate-500 mb-0.5">IV</div>
              <div className="font-mono text-amber-300">{leg.iv.toFixed(1)}%</div>
            </div>
            <div className="bg-slate-900/50 rounded p-1.5">
              <div className="text-slate-500 mb-0.5">OI (k)</div>
              <div className="font-mono text-slate-300">{(leg.oi / 1000).toFixed(0)}k</div>
            </div>
          </>
        )}
      </div>

      {leg.action === 'BUY' && (
        <div className="flex gap-2 mt-2 text-xs">
          <div className="flex-1 bg-emerald-950/30 rounded p-1.5 text-center">
            <div className="text-slate-500">P&L at target</div>
            <div className="font-mono font-bold text-emerald-300">{fmtINR(leg.pnl_target)}/lot</div>
          </div>
          <div className="flex-1 bg-red-950/30 rounded p-1.5 text-center">
            <div className="text-slate-500">P&L at stop</div>
            <div className="font-mono font-bold text-red-300">{fmtINR(leg.pnl_stop)}/lot</div>
          </div>
        </div>
      )}
    </div>
  )
}

function ScenarioTable({ scenarios }: { scenarios: PnLScenario[] }) {
  return (
    <div className="rounded-lg border border-slate-800 overflow-hidden">
      <table className="w-full text-xs">
        <thead>
          <tr className="bg-slate-900/60">
            <th className="text-left text-slate-500 px-3 py-2">Scenario</th>
            <th className="text-right text-slate-500 px-3 py-2">Spot Move</th>
            <th className="text-right text-slate-500 px-3 py-2">P&L (₹/set)</th>
            <th className="text-right text-slate-500 px-3 py-2">P&L %</th>
          </tr>
        </thead>
        <tbody>
          {scenarios?.map((s, i) => (
            <tr key={i} className="border-t border-slate-800/60">
              <td className="px-3 py-2 text-slate-300">{s.label}</td>
              <td className="px-3 py-2 text-right font-mono text-slate-400">{s.spot_move}</td>
              <td className={`px-3 py-2 text-right font-mono font-bold ${s.pnl_inr > 0 ? 'text-emerald-400' : s.pnl_inr < 0 ? 'text-red-400' : 'text-slate-400'}`}>
                {fmtINR(s.pnl_inr)}
              </td>
              <td className={`px-3 py-2 text-right font-mono ${s.pnl_pct > 0 ? 'text-emerald-400' : s.pnl_pct < 0 ? 'text-red-400' : 'text-slate-400'}`}>
                {fmtP(s.pnl_pct)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function MultiLotTable({ setup }: { setup: ExpirySetup }) {
  const lots = [1, 2, 5, 10]
  const mp = setup.max_profit_inr
  const ml = setup.max_loss_inr > 0 ? -setup.max_loss_inr : setup.max_loss_inr
  return (
    <div className="rounded-lg border border-slate-800 overflow-hidden">
      <div className="text-xs text-slate-500 px-3 py-2 bg-slate-900/40">P&L scaling by lot count</div>
      <table className="w-full text-xs">
        <thead>
          <tr className="bg-slate-900/60">
            <th className="text-left text-slate-500 px-3 py-2">Lots</th>
            <th className="text-right text-slate-500 px-3 py-2">Max Profit</th>
            <th className="text-right text-slate-500 px-3 py-2">Max Loss</th>
          </tr>
        </thead>
        <tbody>
          {lots.map(l => (
            <tr key={l} className="border-t border-slate-800/60">
              <td className="px-3 py-2 font-mono text-slate-300">{l} lot{l > 1 ? 's' : ''}</td>
              <td className="px-3 py-2 text-right font-mono font-bold text-emerald-400">
                {mp > 0 ? fmtINR(mp * l) : '—'}
              </td>
              <td className="px-3 py-2 text-right font-mono font-bold text-red-400">
                {ml < 0 ? fmtINR(ml * l) : setup.max_loss_inr === -1 ? 'Unlimited' : '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function SetupCard({ setup }: { setup: ExpirySetup }) {
  const [expanded, setExpanded] = useState(setup.priority <= 2)
  const phaseStyle = PHASE_COLORS[setup.phase] ?? PHASE_COLORS.LATE
  const isSell = setup.side === 'SELL_PREMIUM'

  return (
    <div className={`border rounded-xl overflow-hidden ${phaseStyle}`}>
      {/* Header */}
      <button
        onClick={() => setExpanded(v => !v)}
        className="w-full text-left p-4 hover:bg-white/5 transition-colors"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap mb-1">
              <span className="font-bold text-white text-base">{setup.name}</span>
              <span className={`text-xs px-1.5 py-0.5 rounded font-bold ${
                isSell ? 'bg-orange-800/60 text-orange-200' : 'bg-blue-800/60 text-blue-200'
              }`}>{isSell ? 'SELL PREMIUM' : 'BUY PREMIUM'}</span>
              <span className={`text-xs px-1.5 py-0.5 rounded font-bold border ${phaseStyle}`}>
                {setup.phase}
              </span>
            </div>
            <p className="text-xs text-slate-400 leading-relaxed">{setup.description}</p>
          </div>
          <div className="flex-shrink-0 text-right">
            <div className={`text-xl font-bold font-mono ${setup.max_profit_inr > 0 ? 'text-emerald-400' : 'text-slate-300'}`}>
              {setup.max_profit_inr > 0 ? fmtINR(setup.max_profit_inr) : '—'}
            </div>
            <div className="text-xs text-slate-500">max profit/set</div>
          </div>
        </div>

        <div className="mt-3 grid grid-cols-2 sm:grid-cols-4 gap-2">
          <div>
            <div className="text-xs text-slate-500">Net Premium</div>
            <div className={`font-mono font-bold text-sm ${setup.net_premium >= 0 ? 'text-emerald-300' : 'text-red-300'}`}>
              {setup.net_premium >= 0 ? '+' : ''}{setup.net_premium.toFixed(1)} pts
            </div>
          </div>
          <div>
            <div className="text-xs text-slate-500">Max Loss</div>
            <div className="font-mono font-bold text-sm text-red-300">
              {setup.max_loss_inr === -1 ? 'Unlimited' : setup.max_loss_inr > 0 ? fmtINR(-setup.max_loss_inr) : '—'}
            </div>
          </div>
          <div>
            <div className="text-xs text-slate-500">Breakeven</div>
            <div className="font-mono text-sm text-slate-300">
              {fmt(setup.breakeven_down, 0)} – {fmt(setup.breakeven_up, 0)}
            </div>
          </div>
          <div>
            <div className="text-xs text-slate-500">Confidence</div>
            <ConfidenceBar pct={setup.confidence} />
          </div>
        </div>

        <div className="mt-2 text-xs text-slate-500 text-right">{expanded ? '▲ collapse' : '▼ expand details'}</div>
      </button>

      {/* Expanded content */}
      {expanded && (
        <div className="border-t border-white/10 p-4 space-y-4">
          {/* Phase reason */}
          <div className={`text-xs rounded-lg px-3 py-2 border ${phaseStyle}`}>
            ⏱ {setup.phase_reason}
          </div>

          {/* Legs */}
          <div>
            <div className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-2">Legs</div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {setup.legs?.map((leg, i) => <LegRow key={i} leg={leg} />)}
            </div>
          </div>

          {/* P&L Scenarios */}
          <div>
            <div className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-2">P&L Scenarios</div>
            <ScenarioTable scenarios={setup.pnl_scenarios} />
          </div>

          {/* Multi-lot P&L */}
          <div>
            <div className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-2">Scale by Lots</div>
            <MultiLotTable setup={setup} />
          </div>

          {/* Rules */}
          <div>
            <div className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-2">Trade Rules</div>
            <div className="space-y-1.5">
              {setup.rules?.map((r, i) => (
                <div key={i} className="flex gap-2 text-xs text-slate-300">
                  <span className="text-slate-600 flex-shrink-0">{i + 1}.</span>
                  <span>{r}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Countdown Timer ──────────────────────────────────────────────────────────

function Countdown({ minutes }: { minutes: number }) {
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  const color = minutes < 60 ? 'text-red-400' : minutes < 120 ? 'text-amber-400' : 'text-emerald-400'
  return (
    <div className="text-center">
      <div className={`text-3xl font-bold font-mono ${color}`}>
        {h > 0 ? `${h}h ` : ''}{m}m
      </div>
      <div className="text-xs text-slate-500">until market close (3:15 PM)</div>
    </div>
  )
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function ExpiryDay() {
  const [data,      setData]      = useState<ExpiryDaySignal | null>(null)
  const [loading,   setLoading]   = useState(false)
  const [error,     setError]     = useState('')
  const [lastFetch, setLastFetch] = useState<Date | null>(null)
  const [lots,      setLots]      = useState(1)

  const fetch = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const { data: d } = await apiClient.get('/nifty/expiry-day')
      setData(d)
      setLastFetch(new Date())
    } catch (e: any) {
      setError(e?.response?.data?.error ?? 'Failed to fetch expiry day signal')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetch()
    const id = setInterval(fetch, 30_000) // auto-refresh every 30s
    return () => clearInterval(id)
  }, [fetch])

  const d = data

  return (
    <div className="max-w-7xl mx-auto px-4 py-6 space-y-5">

      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-white flex items-center gap-2">
            {d?.is_expiry_day ? <span className="text-2xl">🔥</span> : <span className="text-2xl">📅</span>}
            Expiry Day Strategy
            {d?.is_expiry_day && (
              <span className="ml-2 px-2 py-0.5 rounded-lg text-xs font-bold bg-red-600 text-white animate-pulse">
                LIVE EXPIRY
              </span>
            )}
          </h1>
          <p className="text-sm text-slate-400 mt-1">
            Live NIFTY option chain → Iron Fly · Straddle · ORB · Max Pain  •  Auto-refresh 30s
          </p>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2 text-xs text-slate-500">
            {loading && <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />}
            {lastFetch && !loading && (
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
            )}
            {lastFetch ? `Updated ${lastFetch.toLocaleTimeString('en-IN')}` : 'Fetching…'}
          </div>
          <button
            onClick={fetch}
            disabled={loading}
            className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm font-semibold rounded-lg"
          >
            {loading ? '⟳ Loading…' : '⟳ Refresh'}
          </button>
        </div>
      </div>

      {error && (
        <div className="bg-red-900/30 border border-red-700/40 rounded-xl p-4 text-red-300 text-sm">{error}</div>
      )}

      {d && (
        <>
          {/* Expiry Banner */}
          <div className={`rounded-xl border p-4 ${
            d.is_expiry_day
              ? 'border-orange-600/50 bg-gradient-to-r from-orange-950/60 to-red-950/40'
              : 'border-slate-700/50 bg-slate-900/40'
          }`}>
            <div className="flex flex-col sm:flex-row sm:items-center gap-3">
              <div className="flex-1">
                <div className="flex items-center gap-2 mb-1">
                  {d.is_expiry_day
                    ? <span className="text-orange-300 font-bold text-lg">🔥 EXPIRY DAY — {d.expiry_type} ({d.next_expiry})</span>
                    : <span className="text-slate-300 font-bold">📅 Next Expiry: {d.next_expiry} ({d.days_to_expiry} days away)</span>
                  }
                </div>
                <p className="text-sm text-slate-400">{d.summary}</p>
              </div>
              <div className="flex-shrink-0">
                <PhaseBadge phase={d.time_phase} />
              </div>
            </div>
          </div>

          {/* Warnings */}
          {d.warnings?.length > 0 && (
            <div className="space-y-2">
              {d.warnings.map((w, i) => (
                <div key={i} className="bg-amber-950/30 border border-amber-700/40 rounded-lg px-4 py-2 text-sm text-amber-200">{w}</div>
              ))}
            </div>
          )}

          {/* Market Snapshot */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
            {[
              { label: 'Spot Price', value: fmt(d.spot_price, 0), color: 'text-white', sub: 'NIFTY 50' },
              { label: 'ATM Strike', value: fmt(d.atm_strike, 0), color: 'text-blue-300', sub: 'Nearest 50' },
              { label: 'Max Pain', value: fmt(d.max_pain_strike, 0), color: 'text-amber-300', sub: `${d.spot_vs_max_pain > 0 ? 'Spot +' : 'Spot '}${d.spot_vs_max_pain.toFixed(0)} pts` },
              { label: 'VIX', value: d.vix.toFixed(1), color: d.vix > 20 ? 'text-red-400' : d.vix < 13 ? 'text-amber-400' : 'text-emerald-400', sub: d.vix > 20 ? 'High — caution' : 'Normal range' },
              { label: 'PCR', value: d.pcr.toFixed(2), color: d.pcr >= 1.1 ? 'text-emerald-400' : d.pcr < 0.9 ? 'text-red-400' : 'text-slate-300', sub: d.market_sentiment },
              { label: 'To Close', value: `${d.minutes_to_close}m`, color: d.minutes_to_close < 60 ? 'text-red-400' : 'text-slate-300', sub: 'Until 3:15 PM' },
            ].map(s => (
              <div key={s.label} className="bg-dark-800 border border-slate-800 rounded-xl p-3">
                <div className="text-xs text-slate-500 mb-1">{s.label}</div>
                <div className={`text-xl font-bold font-mono ${s.color}`}>{s.value}</div>
                <div className="text-xs text-slate-500 mt-0.5">{s.sub}</div>
              </div>
            ))}
          </div>

          {/* Time Phase + Countdown */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className={`rounded-xl border p-4 ${PHASE_COLORS[d.time_phase] ?? PHASE_COLORS.LATE}`}>
              <div className="text-xs font-semibold uppercase tracking-wide mb-2 opacity-70">Current Phase</div>
              <PhaseBadge phase={d.time_phase} />
              <p className="text-sm mt-2 opacity-80">{d.time_phase_desc}</p>
            </div>
            <div className="bg-dark-800 border border-slate-800 rounded-xl p-4 flex items-center justify-center">
              <Countdown minutes={d.minutes_to_close} />
            </div>
          </div>

          {/* ORB State */}
          {(d.time_phase === 'ORB_WINDOW' || d.time_phase === 'PRIME_TIME') && d.orb && (
            <div className="bg-dark-800 border border-blue-800/40 rounded-xl p-4">
              <div className="text-sm font-semibold text-blue-300 mb-3">📊 Opening Range Breakout (ORB) Levels</div>
              <div className="grid grid-cols-3 gap-4 text-sm">
                <div className="text-center">
                  <div className="text-xs text-slate-500 mb-1">OR Low</div>
                  <div className="text-xl font-bold font-mono text-red-300">{fmt(d.orb.low_level, 0)}</div>
                  <div className="text-xs text-slate-500">Breakdown trigger → Buy PE</div>
                </div>
                <div className="text-center">
                  <div className="text-xs text-slate-500 mb-1">OR Range</div>
                  <div className="text-xl font-bold font-mono text-slate-300">{d.orb.range_size.toFixed(0)} pts</div>
                  <div className="text-xs text-slate-500">First 15-min range</div>
                </div>
                <div className="text-center">
                  <div className="text-xs text-slate-500 mb-1">OR High</div>
                  <div className="text-xl font-bold font-mono text-emerald-300">{fmt(d.orb.high_level, 0)}</div>
                  <div className="text-xs text-slate-500">Breakout trigger → Buy CE</div>
                </div>
              </div>
            </div>
          )}

          {/* Lot selector */}
          <div className="flex items-center gap-3">
            <div className="text-sm text-slate-400">Show P&L for:</div>
            {[1, 2, 5, 10].map(l => (
              <button
                key={l}
                onClick={() => setLots(l)}
                className={`px-3 py-1 rounded-lg text-sm font-semibold transition-colors ${
                  lots === l ? 'bg-blue-600 text-white' : 'bg-slate-800 text-slate-400 hover:text-white'
                }`}
              >{l} lot{l > 1 ? 's' : ''}</button>
            ))}
          </div>

          {/* Setups */}
          {d.setups?.length > 0 ? (
            <div className="space-y-4">
              <div className="text-sm font-semibold text-slate-300">
                {d.setups.length} Live Setups — Ranked by Priority
              </div>
              {d.setups.map((setup, i) => (
                <SetupCard key={i} setup={setup} />
              ))}
            </div>
          ) : (
            <div className="bg-dark-800 border border-slate-800 rounded-xl p-8 text-center text-slate-500">
              <div className="text-4xl mb-3">📭</div>
              <div>No active setups for the current time phase.</div>
              <div className="text-sm mt-1">Check back during 9:30 AM – 1:00 PM on expiry day (Thursday).</div>
            </div>
          )}

          {/* Quick Reference */}
          <div className="bg-dark-800 border border-slate-800 rounded-xl p-5">
            <div className="text-sm font-semibold text-slate-300 mb-4">⚡ Expiry Day Quick Reference</div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 text-xs">
              {[
                {
                  title: '9:15–9:30 AM',
                  color: 'border-blue-700/40',
                  items: ['Observe first candle', 'Note OR High and OR Low', 'Do NOT enter yet', 'Watch for gap up/down'],
                },
                {
                  title: '9:30–11:30 AM',
                  color: 'border-emerald-700/40',
                  items: ['Best Iron Fly window', 'ORB breakout entries', 'Max pain directional', 'Highest premium value'],
                },
                {
                  title: '11:30–1:30 PM',
                  color: 'border-amber-700/40',
                  items: ['Theta accelerating', 'Target 50% premium profit', 'Avoid new buy positions', 'Adjust Iron Fly if breached'],
                },
                {
                  title: '1:30–3:15 PM',
                  color: 'border-red-700/40',
                  items: ['Close all sell positions', 'No new entries', 'Spreads widen after 2:30', 'Hard exit at 3:00 PM'],
                },
              ].map(section => (
                <div key={section.title} className={`border rounded-lg p-3 ${section.color}`}>
                  <div className="font-semibold text-slate-200 mb-2">{section.title}</div>
                  <ul className="space-y-1">
                    {section.items.map((item, i) => (
                      <li key={i} className="text-slate-400 flex gap-1.5">
                        <span className="text-slate-600">•</span>{item}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </div>

          <div className="text-xs text-slate-600 text-center pb-2">
            Data sourced from NSE India option chain (live). Lot size: 75 (NIFTY).
            All P&L figures are per lot × lot size = ₹ values. Generated: {new Date(d.generated_at).toLocaleTimeString('en-IN')}
          </div>
        </>
      )}

      {!d && !loading && !error && (
        <div className="text-center py-20 text-slate-500">
          <div className="text-5xl mb-4">📊</div>
          <div>Loading expiry day signal…</div>
        </div>
      )}
    </div>
  )
}
