import { useEffect, useRef, useState, useCallback } from 'react'
import axios from 'axios'
import { createChart, ColorType, CrosshairMode, LineStyle, PriceLineOptions } from 'lightweight-charts'
import type { IChartApi, ISeriesApi, SeriesMarker, Time, IPriceLine } from 'lightweight-charts'

// ── Types ──────────────────────────────────────────────────────────────────────

interface BookScalpSignal {
  strategy_id: string; strategy_name: string; book_source: string
  author: string; author_fact: string; documented_wr: number
  signal: string; direction: string; strength: string
  // Filter pipeline results (5 conditions)
  trend_bias_ok: boolean; in_killzone: boolean; trigger_fired: boolean
  volume_ok: boolean; candle_ok: boolean; filters_hit: number
  filter_detail: string[]
  spot_price: number; atm_strike: number; strike_price: number
  strike_label: string; expiry: string
  entry: number; stop_loss: number; target_1: number; target_2: number
  stop_pct: number; rr: number; suggested_lots: number
  max_loss_inr: number; target_gain_inr: number
  why: string[]; rules: string[]; levels: Record<string, number>
  history: SignalHistoryEntry[] | null
}

interface SignalHistoryEntry {
  time: string; signal: string; price: number; in_kz: boolean; kz_note: string
}

interface BookScalpDashboard {
  spot_price: number; vwap: number; change: number; change_pct: number
  trend_bias: string; trend_bias_detail: string
  ema9: number; ema21: number; ema50: number
  in_killzone: boolean; killzone_name: string
  // Pivot levels
  pdh: number; pdl: number; pdc: number
  pivot_pp: number; pivot_tc: number; pivot_bc: number
  pivot_r1: number; pivot_r2: number; pivot_s1: number; pivot_s2: number
  signals: BookScalpSignal[]; consensus: string; consensus_count: number
  total_signals: number; ce_count: number; pe_count: number
  recommended_strike: number; recommended_expiry: string; recommended_dir: string
  recommended_lots: number; recommended_max_loss: number; recommended_tgt_gain: number
  market_session: string; generated_at: string
}

interface ChartBar {
  date: string; unix_time: number
  open: number; high: number; low: number; close: number; volume: number
  ema9: number; ema21: number; sma50: number; vwap: number; rsi: number
  atr: number; signal: string; win_rate: number
}

// ── Helpers ────────────────────────────────────────────────────────────────────

const fmtINR = (n: number) => '₹' + Math.round(n || 0).toLocaleString('en-IN')
const fmtN = (n: number) => Math.round(n || 0).toLocaleString('en-IN')
const fmtDec = (n: number, d = 1) => (n || 0).toFixed(d)

const STRATEGY_ICONS: Record<string, string> = {
  orb: '🔥', holy_grail: '⚔️', vwap_momentum: '🌊',
  ttm_squeeze: '💥', al_brooks: '📐', livermore: '🏛️',
}

const STRATEGY_SHORT: Record<string, string> = {
  orb: 'ORB', holy_grail: 'Holy Grail', vwap_momentum: 'VWAP',
  ttm_squeeze: 'Squeeze', al_brooks: 'Brooks', livermore: 'Livermore',
}

// Each strategy gets a unique color identity: border, bg, text, dot
const STRATEGY_COLORS: Record<string, {
  border: string      // left border on card
  dot: string         // filled color dot
  badge: string       // strategy name badge bg+text
  header: string      // card header tint
  accent: string      // text accent
  hex: string         // raw hex for chart price line
}> = {
  orb: {
    border: 'border-l-orange-500',
    dot: 'bg-orange-500',
    badge: 'bg-orange-100 text-orange-700 border-orange-200',
    header: 'hover:bg-orange-50/50',
    accent: 'text-orange-700',
    hex: '#f97316',
  },
  holy_grail: {
    border: 'border-l-violet-500',
    dot: 'bg-violet-500',
    badge: 'bg-violet-100 text-violet-700 border-violet-200',
    header: 'hover:bg-violet-50/50',
    accent: 'text-violet-700',
    hex: '#8b5cf6',
  },
  vwap_momentum: {
    border: 'border-l-cyan-500',
    dot: 'bg-cyan-500',
    badge: 'bg-cyan-100 text-cyan-700 border-cyan-200',
    header: 'hover:bg-cyan-50/50',
    accent: 'text-cyan-700',
    hex: '#06b6d4',
  },
  ttm_squeeze: {
    border: 'border-l-rose-500',
    dot: 'bg-rose-500',
    badge: 'bg-rose-100 text-rose-700 border-rose-200',
    header: 'hover:bg-rose-50/50',
    accent: 'text-rose-700',
    hex: '#f43f5e',
  },
  al_brooks: {
    border: 'border-l-sky-500',
    dot: 'bg-sky-500',
    badge: 'bg-sky-100 text-sky-700 border-sky-200',
    header: 'hover:bg-sky-50/50',
    accent: 'text-sky-700',
    hex: '#0ea5e9',
  },
  livermore: {
    border: 'border-l-amber-500',
    dot: 'bg-amber-500',
    badge: 'bg-amber-100 text-amber-700 border-amber-200',
    header: 'hover:bg-amber-50/50',
    accent: 'text-amber-700',
    hex: '#f59e0b',
  },
}

// ── Main Component ─────────────────────────────────────────────────────────────

export default function ScalpingTerminal() {
  const [dash, setDash] = useState<BookScalpDashboard | null>(null)
  const [loading, setLoading] = useState(true)
  const [account, setAccount] = useState(100000)
  const [risk, setRisk] = useState(1.0)
  const [autoRefresh, setAutoRefresh] = useState(false)
  const [lastAt, setLastAt] = useState<Date | null>(null)
  const [chartStrategy, setChartStrategy] = useState<string | null>(null)

  const fetchDash = useCallback(() => {
    setLoading(true)
    axios.get(`/api/naren/v1/nifty/book-scalp?account=${account}&risk=${risk}`)
      .then(r => { setDash(r.data); setLastAt(new Date()) })
      .catch(console.error)
      .finally(() => setLoading(false))
  }, [account, risk])

  useEffect(() => { fetchDash() }, [fetchDash])
  useEffect(() => {
    if (!autoRefresh) return
    const t = setInterval(fetchDash, 60000)
    return () => clearInterval(t)
  }, [autoRefresh, fetchDash])

  // Signal loaded on chart (only when explicitly selected via button)
  const chartSignal = chartStrategy
    ? (dash?.signals?.find(s => s.strategy_id === chartStrategy) ?? null)
    : null

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900 font-sans">

      {/* ── TOP BAR ── */}
      <div className="bg-white border-b border-gray-200 px-4 py-3 shadow-sm">
        <div className="max-w-screen-2xl mx-auto flex flex-wrap items-center gap-4">

          {/* Title */}
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 bg-indigo-600 rounded-lg flex items-center justify-center">
              <span className="text-white text-xs font-black">ST</span>
            </div>
            <div>
              <div className="text-sm font-bold text-gray-900 leading-tight">Scalping Terminal</div>
              <div className="text-[10px] text-gray-400 leading-tight">6 Book Strategies · 5-min NIFTY</div>
            </div>
          </div>

          {/* Market data */}
          {dash && (
            <>
              <div className="h-8 w-px bg-gray-200" />
              <div className="flex items-center gap-1">
                <span className="text-xs text-gray-500">NIFTY</span>
                <span className="text-lg font-bold text-gray-900 tabular-nums">{fmtN(dash.spot_price)}</span>
                <span className={`text-sm font-semibold ${dash.change >= 0 ? 'text-green-600' : 'text-red-500'}`}>
                  {dash.change >= 0 ? '+' : ''}{fmtDec(dash.change_pct, 2)}%
                </span>
              </div>
              <div className="flex items-center gap-1 text-xs text-gray-500">
                <span className="text-indigo-600 font-medium">VWAP</span>
                <span className="font-mono tabular-nums">{fmtN(dash.vwap)}</span>
              </div>
              <SessionPill session={dash.market_session} />
            </>
          )}

          {/* Controls */}
          <div className="ml-auto flex items-center gap-3 flex-wrap">
            <label className="flex items-center gap-1.5 text-xs text-gray-600">
              Account ₹
              <input type="number" value={account} step={10000} min={10000}
                onChange={e => setAccount(+e.target.value)}
                className="w-24 border border-gray-300 rounded-md px-2 py-1 text-xs font-mono bg-white focus:outline-none focus:ring-2 focus:ring-indigo-300" />
            </label>
            <label className="flex items-center gap-1.5 text-xs text-gray-600">
              Risk
              <input type="range" min={0.5} max={3} step={0.25} value={risk}
                onChange={e => setRisk(+e.target.value)}
                className="w-20 accent-indigo-600" />
              <span className="font-semibold text-indigo-600 w-8">{risk}%</span>
            </label>
            <button onClick={() => setAutoRefresh(a => !a)}
              className={`px-3 py-1.5 rounded-md text-xs font-medium border transition-all ${
                autoRefresh
                  ? 'bg-green-50 border-green-300 text-green-700'
                  : 'bg-white border-gray-300 text-gray-600 hover:bg-gray-50'
              }`}>
              {autoRefresh ? '🟢 Auto' : '⏹ Manual'}
            </button>
            <button onClick={fetchDash}
              className="px-3 py-1.5 rounded-md text-xs font-semibold bg-indigo-600 hover:bg-indigo-700 text-white transition-colors flex items-center gap-1">
              {loading ? <span className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin inline-block" /> : '↺'}
              Refresh
            </button>
          </div>
        </div>
      </div>

      {/* ── LOADING ── */}
      {loading && !dash && (
        <div className="flex flex-col items-center justify-center h-96 gap-3">
          <div className="w-10 h-10 border-4 border-indigo-600 border-t-transparent rounded-full animate-spin" />
          <div className="text-sm text-gray-500">Fetching live 5-min NIFTY bars + running 6 strategies…</div>
        </div>
      )}

      {dash && (
        <div className="max-w-screen-2xl mx-auto px-4 py-4">

          {/* ── TREND + KILLZONE STATUS BAR ── */}
          <TrendKillzoneBar dash={dash} />

          {/* ── CONSENSUS BANNER ── */}
          <div className="mt-3">
            <ConsensusBanner dash={dash} />
          </div>

          {/* ── MAIN BODY: Chart + Signals ── */}
          <div className="grid grid-cols-1 xl:grid-cols-[1fr_380px] gap-4 mt-4">

            {/* LEFT: Chart */}
            <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
              <ChartPanel dash={dash} chartSignal={chartSignal} chartStrategy={chartStrategy} />
            </div>

            {/* RIGHT: Signals */}
            <div className="flex flex-col gap-3">

              {/* Strategy vote bar + color legend */}
              <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-3">
                <div className="flex items-center justify-between mb-2">
                  <div className="text-[10px] font-bold text-gray-500 uppercase tracking-wider">
                    Signal Votes ({dash.total_signals} strategies)
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span className="text-green-600 text-[10px] font-semibold">CE {dash.ce_count}</span>
                    <span className="text-gray-300">·</span>
                    <span className="text-gray-400 text-[10px]">WAIT {dash.total_signals - dash.ce_count - dash.pe_count}</span>
                    <span className="text-gray-300">·</span>
                    <span className="text-red-500 text-[10px] font-semibold">PE {dash.pe_count}</span>
                  </div>
                </div>
                <div className="flex gap-1 h-2.5 rounded-full overflow-hidden bg-gray-100">
                  <div className="bg-green-500 transition-all rounded-l-full"
                    style={{ width: `${(dash.ce_count / dash.total_signals) * 100}%` }} />
                  <div className="bg-gray-200 flex-1" />
                  <div className="bg-red-500 transition-all rounded-r-full"
                    style={{ width: `${(dash.pe_count / dash.total_signals) * 100}%` }} />
                </div>
                {/* Per-strategy color legend */}
                <div className="mt-2.5 flex flex-wrap gap-x-3 gap-y-1">
                  {Object.entries(STRATEGY_COLORS).map(([id, c]) => {
                    const sig = dash.signals?.find(s => s.strategy_id === id)
                    const sigIcon = sig?.signal === 'BUY_CE' ? '▲' : sig?.signal === 'BUY_PE' ? '▼' : '–'
                    const sigColor = sig?.signal === 'BUY_CE' ? 'text-green-600' : sig?.signal === 'BUY_PE' ? 'text-red-500' : 'text-gray-400'
                    return (
                      <span key={id} className="flex items-center gap-1 text-[10px]">
                        <span className={`w-2 h-2 rounded-full ${c.dot} flex-shrink-0`} />
                        <span className="text-gray-600">{STRATEGY_SHORT[id]}</span>
                        <span className={`font-bold ${sigColor}`}>{sigIcon}</span>
                      </span>
                    )
                  })}
                </div>
              </div>

              {/* Signal cards */}
              <div className="flex flex-col gap-2 overflow-y-auto max-h-[calc(100vh-320px)]">
                {dash.signals.map(sig => (
                  <SignalCard
                    key={sig.strategy_id}
                    sig={sig}
                    onChart={chartStrategy === sig.strategy_id}
                    onLoadChart={() => setChartStrategy(
                      chartStrategy === sig.strategy_id ? null : sig.strategy_id
                    )}
                  />
                ))}
              </div>

              {/* Last refresh */}
              {lastAt && (
                <div className="text-center text-[10px] text-gray-400">
                  Last updated {lastAt.toLocaleTimeString('en-IN')} · Lot = 25 qty · Delta ≈ 0.5
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Trend + Killzone Status Bar ───────────────────────────────────────────────

function TrendKillzoneBar({ dash }: { dash: BookScalpDashboard }) {
  const { trend_bias, trend_bias_detail, ema9, ema21, ema50, in_killzone, killzone_name } = dash

  const trendColor = trend_bias === 'BULL'
    ? 'bg-green-50 border-green-200 text-green-800'
    : trend_bias === 'BEAR'
    ? 'bg-red-50 border-red-200 text-red-800'
    : 'bg-amber-50 border-amber-200 text-amber-800'

  const trendIcon = trend_bias === 'BULL' ? '▲' : trend_bias === 'BEAR' ? '▼' : '↔'
  const trendLabel = trend_bias === 'BULL' ? 'BULLISH BIAS' : trend_bias === 'BEAR' ? 'BEARISH BIAS' : 'NEUTRAL BIAS'

  const kzColor = in_killzone
    ? 'bg-green-50 border-green-200 text-green-800'
    : 'bg-gray-50 border-gray-200 text-gray-500'

  const KILLZONE_WINDOWS = [
    { id: 'KZ1', label: 'Opening', time: '09:30–10:45' },
    { id: 'KZ2', label: 'Midday', time: '11:30–13:00' },
    { id: 'KZ3', label: 'Power Close', time: '13:30–14:45' },
  ]

  return (
    <div className="flex flex-wrap gap-3">
      {/* Trend Bias */}
      <div className={`flex-1 min-w-[240px] rounded-xl border px-4 py-3 ${trendColor}`}>
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-black uppercase tracking-widest opacity-60">EMA Structure · Trend Bias</span>
            </div>
            <div className="flex items-center gap-2 mt-0.5">
              <span className="text-xl font-black">{trendIcon} {trendLabel}</span>
            </div>
            <div className="text-[11px] opacity-70 mt-0.5">{trend_bias_detail}</div>
          </div>
          {/* EMA stack */}
          <div className="flex gap-2 text-[10px] font-mono tabular-nums flex-shrink-0">
            <div className="text-center">
              <div className="text-amber-600 font-bold">EMA9</div>
              <div>{ema9?.toFixed(0) ?? '—'}</div>
            </div>
            <div className="text-center">
              <div className="text-blue-600 font-bold">EMA21</div>
              <div>{ema21?.toFixed(0) ?? '—'}</div>
            </div>
            <div className="text-center">
              <div className="text-gray-500 font-bold">EMA50</div>
              <div>{ema50?.toFixed(0) ?? '—'}</div>
            </div>
          </div>
        </div>
      </div>

      {/* Killzone Status */}
      <div className={`rounded-xl border px-4 py-3 min-w-[260px] ${kzColor}`}>
        <div className="text-[10px] font-black uppercase tracking-widest opacity-60 mb-1">Trading Killzones</div>
        <div className="flex items-center gap-2 mb-2">
          {in_killzone ? (
            <>
              <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
              <span className="text-sm font-black text-green-800">{killzone_name}</span>
            </>
          ) : (
            <>
              <span className="w-2 h-2 rounded-full bg-gray-300" />
              <span className="text-sm font-semibold text-gray-500">Outside All Killzones — Wait</span>
            </>
          )}
        </div>
        <div className="flex gap-2">
          {KILLZONE_WINDOWS.map(kz => {
            const active = in_killzone && killzone_name.includes(kz.id.replace('KZ', ''))
            return (
              <div key={kz.id} className={`flex-1 rounded-lg px-2 py-1.5 text-center transition-all ${
                active
                  ? 'bg-green-200 text-green-900 ring-1 ring-green-400'
                  : 'bg-white/60 text-gray-500'
              }`}>
                <div className={`text-[9px] font-black uppercase ${active ? 'text-green-700' : 'text-gray-400'}`}>{kz.id}</div>
                <div className="text-[9px] font-medium">{kz.label}</div>
                <div className="text-[8px] opacity-70">{kz.time}</div>
              </div>
            )
          })}
        </div>
      </div>

      {/* Filter pipeline legend */}
      <div className="rounded-xl border border-gray-200 bg-white px-4 py-3 min-w-[200px]">
        <div className="text-[10px] font-black uppercase tracking-widest text-gray-400 mb-2">Signal Gate (all 5 required)</div>
        <div className="space-y-1">
          {[
            { label: 'Trend Bias', desc: 'EMAs aligned' },
            { label: 'Killzone', desc: 'Right time window' },
            { label: 'Strategy Trigger', desc: 'Book rule met' },
            { label: 'Volume Confirm', desc: '≥2.0× avg vol' },
            { label: 'Candle Quality', desc: 'Body ≥55% range' },
          ].map((item, i) => (
            <div key={i} className="flex items-center gap-2 text-[10px]">
              <div className="w-4 h-4 rounded border border-gray-200 bg-gray-50 flex items-center justify-center text-[9px] text-gray-400 font-bold flex-shrink-0">{i + 1}</div>
              <span className="font-semibold text-gray-700">{item.label}</span>
              <span className="text-gray-400">— {item.desc}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

// ── Consensus Banner ───────────────────────────────────────────────────────────

function ConsensusBanner({ dash }: { dash: BookScalpDashboard }) {
  const c = dash.consensus
  const isCE = c.includes('CE')
  const isPE = c.includes('PE')
  const isStrong = c.includes('STRONG')
  const isWait = !isCE && !isPE

  const bg = isCE ? (isStrong ? 'bg-green-600' : 'bg-green-500') : isPE ? (isStrong ? 'bg-red-600' : 'bg-red-500') : 'bg-gray-400'
  const label = isStrong && isCE ? '⚡⚡ STRONG BUY CE'
    : isCE ? '⚡ BUY CE'
    : c.includes('LEAN_CE') ? '↗ LEAN CE'
    : isStrong && isPE ? '⚡⚡ STRONG BUY PE'
    : isPE ? '⚡ BUY PE'
    : c.includes('LEAN_PE') ? '↘ LEAN PE'
    : c === 'MIXED' ? '⚡ MIXED SIGNALS' : '⏸ WAIT — No Clear Setup'

  return (
    <div className={`rounded-xl text-white overflow-hidden shadow ${bg}`}>
      <div className="px-5 py-4 flex flex-wrap items-center justify-between gap-4">

        {/* Left: consensus */}
        <div className="flex items-center gap-4">
          {isStrong && <div className="w-3 h-3 rounded-full bg-white animate-ping opacity-75" />}
          <div>
            <div className="text-[10px] uppercase tracking-widest opacity-75 font-medium">Strategy Consensus</div>
            <div className="text-2xl font-black tracking-tight">{label}</div>
            <div className="text-xs opacity-75 mt-0.5">
              {dash.consensus_count} of {dash.total_signals} strategies agree · 5-min NIFTY
            </div>
          </div>
        </div>

        {/* Right: trade details */}
        {!isWait && (
          <div className="flex gap-2 flex-wrap">
            {[
              { l: 'Strike', v: `${fmtN(dash.recommended_strike)} ${dash.recommended_dir}`, big: true },
              { l: 'Expiry', v: dash.recommended_expiry },
              { l: 'Lots', v: String(dash.recommended_lots) },
              { l: 'Max Risk', v: fmtINR(dash.recommended_max_loss) },
              { l: 'Potential', v: fmtINR(dash.recommended_tgt_gain) },
            ].map(({ l, v, big }) => (
              <div key={l} className="bg-white/20 rounded-lg px-3 py-2 text-center min-w-[90px]">
                <div className="text-[9px] uppercase tracking-wide opacity-80">{l}</div>
                <div className={`font-bold ${big ? 'text-base' : 'text-sm'}`}>{v}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

// ── Signal Card ────────────────────────────────────────────────────────────────

function SignalCard({ sig, onChart, onLoadChart }: {
  sig: BookScalpSignal; onChart: boolean; onLoadChart: () => void
}) {
  const [expanded, setExpanded] = useState(false)
  const isCE = sig.signal === 'BUY_CE'
  const isPE = sig.signal === 'BUY_PE'
  const isActive = isCE || isPE

  const sc = STRATEGY_COLORS[sig.strategy_id] ?? {
    border: 'border-l-gray-400', dot: 'bg-gray-400',
    badge: 'bg-gray-100 text-gray-700 border-gray-200',
    header: 'hover:bg-gray-50', accent: 'text-gray-700', hex: '#9ca3af',
  }

  const signalBg = isCE ? 'bg-green-50 text-green-700 border-green-200'
    : isPE ? 'bg-red-50 text-red-600 border-red-200'
    : 'bg-gray-100 text-gray-400 border-gray-200'
  const stratShort = STRATEGY_SHORT[sig.strategy_id] ?? sig.strategy_id

  return (
    <div
      className={`bg-white rounded-xl border border-gray-200 border-l-4 ${sc.border} shadow-sm overflow-hidden transition-all`}
      style={onChart ? { boxShadow: `0 0 0 2px ${sc.hex}` } : undefined}
    >
      {/* Header row */}
      <div className={`px-3 py-2.5 flex items-center gap-2 ${sc.header}`}>
        {/* Strategy color dot + icon */}
        <div className="flex items-center gap-1.5 flex-shrink-0">
          <span className={`w-2.5 h-2.5 rounded-full ${sc.dot} flex-shrink-0`} />
          <span className="text-base">{STRATEGY_ICONS[sig.strategy_id] ?? '📈'}</span>
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className={`px-1.5 py-0.5 rounded text-[10px] font-black border ${sc.badge}`}>
              {stratShort}
            </span>
            <span className="text-xs font-bold text-gray-800">{sig.strategy_name}</span>
          </div>
          <div className="text-[10px] text-gray-400 mt-0.5">
            <span className={`font-semibold ${sc.accent}`}>{sig.author.split(' ').slice(-1)}</span>
            {' · '}{sig.documented_wr}% WR documented
          </div>
        </div>

        {/* Signal badge */}
        <div className={`rounded-lg border px-2.5 py-1.5 flex-shrink-0 text-center ${signalBg}`}>
          <div className="text-[11px] font-black leading-none whitespace-nowrap">
            {isCE ? `▲ CE` : isPE ? `▼ PE` : `WAIT`}
          </div>
          <div className={`text-[10px] font-bold leading-none mt-0.5 whitespace-nowrap ${isActive ? sc.accent : 'text-gray-400'}`}>
            ({stratShort})
          </div>
          {isActive && sig.strength && sig.strength !== 'NONE' && (
            <div className="text-[8px] opacity-60 mt-0.5">{sig.strength}</div>
          )}
        </div>
      </div>

      {/* ── Load on Chart button ── */}
      <div className="px-3 pb-2.5 flex items-center gap-2">
        <button
          onClick={onLoadChart}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold border transition-all ${
            onChart
              ? `text-white border-transparent`
              : `bg-white border-gray-200 text-gray-600 hover:border-gray-300 hover:bg-gray-50`
          }`}
          style={onChart ? { backgroundColor: sc.hex, borderColor: sc.hex } : undefined}
        >
          <span>{onChart ? '📊' : '📈'}</span>
          <span>{onChart ? 'Loaded on Chart' : 'Load on Chart'}</span>
          {onChart && <span className="text-[10px] opacity-80">✕ click to remove</span>}
        </button>
        {isActive && (
          <span className={`text-[10px] font-semibold ${sc.accent}`}>
            Entry {fmtN(sig.entry)} · SL {fmtN(sig.stop_loss)} · T1 {fmtN(sig.target_1)}
          </span>
        )}
      </div>

      {/* Active: trade details */}
      {isActive && (
        <div className="px-3 pb-3 border-t border-gray-100">
          {/* Strike + expiry */}
          <div className={`mt-2 rounded-lg px-3 py-2 ${isCE ? 'bg-green-50' : 'bg-red-50'}`}>
            <div className="flex items-center justify-between mb-2">
              <div>
                <div className="text-[9px] text-gray-500 uppercase">Trade This Strike</div>
                <div className={`text-xl font-black tabular-nums ${isCE ? 'text-green-700' : 'text-red-600'}`}>
                  {fmtN(sig.strike_price)} {sig.direction}
                </div>
                <div className="text-[10px] text-gray-500">{sig.strike_label} · {sig.expiry}</div>
              </div>
              <div className="text-right">
                <div className="text-[9px] text-gray-500">R:R Ratio</div>
                <div className="text-xl font-black text-amber-600">1:{fmtDec(sig.rr)}</div>
                <div className="text-[10px] text-gray-500">{sig.suggested_lots} lots</div>
              </div>
            </div>

            {/* Level grid */}
            <div className="grid grid-cols-4 gap-1">
              {[
                { l: 'Entry', v: fmtN(sig.entry), c: 'text-indigo-700 font-bold' },
                { l: `SL`, v: fmtN(sig.stop_loss), c: 'text-red-600 font-bold' },
                { l: 'Target 1', v: fmtN(sig.target_1), c: 'text-green-700 font-bold' },
                { l: 'Target 2', v: fmtN(sig.target_2), c: 'text-green-600' },
              ].map(({ l, v, c }) => (
                <div key={l} className="bg-white rounded-md p-1.5 text-center shadow-sm">
                  <div className="text-[8px] text-gray-400 uppercase">{l}</div>
                  <div className={`text-xs tabular-nums ${c}`}>{v}</div>
                </div>
              ))}
            </div>

            {/* R:R bar */}
            <div className="mt-2 h-1.5 rounded-full overflow-hidden flex bg-gray-200">
              <div className="bg-red-400 rounded-l-full" style={{ flex: 1 }} />
              <div className="bg-green-500 rounded-r-full" style={{ flex: sig.rr > 0 ? sig.rr : 1 }} />
            </div>
            <div className="flex justify-between mt-1 text-[9px]">
              <span className="text-red-500">Risk {fmtINR(sig.max_loss_inr)}</span>
              <span className="text-green-600">Target {fmtINR(sig.target_gain_inr)}</span>
            </div>
          </div>

          {/* Filter gate summary for active signal */}
          <div className="mt-2 px-2 py-1.5 bg-white rounded-lg border border-gray-100">
            <FilterChecklist sig={sig} />
          </div>

          {/* Why bullets */}
          <div className="mt-2 space-y-0.5">
            {sig.why.slice(0, 3).map((w, i) => (
              <div key={i} className={`text-[11px] leading-snug flex gap-1 ${
                w.startsWith('✓') ? 'text-green-700' :
                w.startsWith('✗') ? 'text-red-600' :
                w.startsWith('⚡') ? 'text-amber-700' : 'text-gray-500'
              }`}>{w}</div>
            ))}
          </div>

          {/* Expand rules */}
          <button
            onClick={e => { e.stopPropagation(); setExpanded(x => !x) }}
            className="mt-2 text-[10px] text-indigo-500 hover:text-indigo-700 transition-colors flex items-center gap-1"
          >
            {expanded ? '▲ Hide rules' : '▼ Show strategy rules'}
          </button>

          {expanded && (
            <div className="mt-2 border-t border-gray-100 pt-2">
              <ol className="space-y-1">
                {sig.rules.map((r, i) => (
                  <li key={i} className="text-[11px] text-gray-600 flex gap-1.5">
                    <span className="text-gray-400 flex-shrink-0">{i + 1}.</span>{r}
                  </li>
                ))}
              </ol>
              {Object.keys(sig.levels).length > 0 && (
                <div className="mt-2 grid grid-cols-2 gap-1">
                  {Object.entries(sig.levels).map(([k, v]) => (
                    <div key={k} className="flex justify-between bg-gray-50 rounded px-2 py-1 text-[10px]">
                      <span className="text-gray-500 capitalize">{k.replace(/_/g, ' ')}</span>
                      <span className="font-mono text-gray-800">{typeof v === 'number' && v > 100 ? fmtN(v) : fmtDec(v, 2)}</span>
                    </div>
                  ))}
                </div>
              )}
              <div className="mt-2 p-2 bg-amber-50 rounded text-[10px] text-amber-800 italic">💡 {sig.author_fact}</div>
            </div>
          )}
        </div>
      )}

      {/* WAIT: Filter pipeline checklist */}
      {!isActive && (
        <div className="px-3 pb-2">
          <FilterChecklist sig={sig} />
        </div>
      )}

      {/* Today's signal history */}
      <SignalHistory sig={sig} sc={sc} />
    </div>
  )
}

// ── Signal History ─────────────────────────────────────────────────────────────

function SignalHistory({ sig, sc }: { sig: BookScalpSignal; sc: typeof STRATEGY_COLORS[string] }) {
  const history = sig.history ?? []
  if (history.length === 0) return null

  // Show only last 6, most recent first
  const recent = [...history].reverse().slice(0, 6)
  const ceCount = history.filter(h => h.signal === 'BUY_CE').length
  const peCount = history.filter(h => h.signal === 'BUY_PE').length

  return (
    <div className="border-t border-gray-100 px-3 py-2">
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-[9px] font-black uppercase tracking-widest text-gray-400">
          Today's Signals
        </span>
        <div className="flex items-center gap-2 text-[9px]">
          {ceCount > 0 && <span className="text-green-600 font-bold">▲ CE ×{ceCount}</span>}
          {peCount > 0 && <span className="text-red-500 font-bold">▼ PE ×{peCount}</span>}
          <span className={`font-bold ${sc.accent}`}>{history.length} total</span>
        </div>
      </div>
      <div className="flex flex-wrap gap-1">
        {recent.map((h, i) => {
          const isCE = h.signal === 'BUY_CE'
          const stratLabel = STRATEGY_SHORT[sig.strategy_id] ?? sig.strategy_id
          return (
            <div
              key={i}
              className={`flex items-center gap-1 px-1.5 py-1 rounded text-[9px] font-bold border ${
                isCE
                  ? 'bg-green-50 text-green-700 border-green-200'
                  : 'bg-red-50 text-red-600 border-red-200'
              }`}
            >
              <span>{isCE ? '▲' : '▼'}</span>
              <span>{isCE ? 'CE' : 'PE'}</span>
              <span className="opacity-70">({stratLabel})</span>
              <span className="text-gray-500 font-medium">{h.time}</span>
              <span className="font-mono text-gray-700">{Math.round(h.price)}</span>
              {h.in_kz && <span title={h.kz_note}>🎯</span>}
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ── Filter Checklist ───────────────────────────────────────────────────────────

function FilterChecklist({ sig }: { sig: BookScalpSignal }) {
  const checks = [
    { label: 'Trend Bias', ok: sig.trend_bias_ok },
    { label: 'Killzone', ok: sig.in_killzone },
    { label: 'Trigger', ok: sig.trigger_fired },
    { label: 'Volume', ok: sig.volume_ok },
    { label: 'Candle', ok: sig.candle_ok },
  ]
  const passCount = checks.filter(c => c.ok).length

  return (
    <div>
      {/* Mini 5-dot progress bar */}
      <div className="flex items-center gap-1.5 mb-1.5">
        {checks.map((c, i) => (
          <div key={i} className={`flex-1 h-1.5 rounded-full transition-colors ${c.ok ? 'bg-green-400' : 'bg-gray-200'}`} />
        ))}
        <span className={`text-[10px] font-bold ml-1 flex-shrink-0 ${passCount >= 4 ? 'text-amber-600' : passCount >= 2 ? 'text-gray-500' : 'text-red-400'}`}>
          {passCount}/5
        </span>
      </div>

      {/* Per-filter dots + label */}
      <div className="flex flex-wrap gap-x-3 gap-y-0.5">
        {checks.map((c, i) => (
          <span key={i} className={`text-[10px] flex items-center gap-0.5 ${c.ok ? 'text-green-600' : 'text-gray-400'}`}>
            {c.ok ? '✓' : '✗'} {c.label}
          </span>
        ))}
      </div>

      {/* Detail messages from backend */}
      {sig.filter_detail && sig.filter_detail.length > 0 && (
        <div className="mt-1.5 space-y-0.5">
          {sig.filter_detail.map((d, i) => (
            <div key={i} className={`text-[10px] leading-snug ${
              d.startsWith('✓') ? 'text-green-600' :
              d.startsWith('✗') ? 'text-red-500' : 'text-amber-600'
            }`}>{d}</div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Chart Panel ────────────────────────────────────────────────────────────────

function ChartPanel({ dash, chartSignal, chartStrategy }: {
  dash: BookScalpDashboard
  chartSignal: BookScalpSignal | null
  chartStrategy: string | null
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const rsiRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const rsiChartRef = useRef<IChartApi | null>(null)
  const candleRef = useRef<ISeriesApi<'Candlestick'> | null>(null)
  const vwapRef = useRef<ISeriesApi<'Line'> | null>(null)
  const ema9Ref = useRef<ISeriesApi<'Line'> | null>(null)
  const ema21Ref = useRef<ISeriesApi<'Line'> | null>(null)
  const rsiLineRef = useRef<ISeriesApi<'Line'> | null>(null)
  const pivotLines = useRef<IPriceLine[]>([])   // static pivot / CPR lines
  const stratLines = useRef<IPriceLine[]>([])   // dynamic strategy entry/SL/target lines
  const barsRef = useRef<ChartBar[]>([])
  const [hovered, setHovered] = useState<ChartBar | null>(null)
  const [chartLoading, setChartLoading] = useState(true)
  const initialized = useRef(false)

  // Init charts once
  useEffect(() => {
    if (!containerRef.current || !rsiRef.current || initialized.current) return
    initialized.current = true

    const chartOpts = (h: number, showTime: boolean) => ({
      layout: { background: { type: ColorType.Solid, color: '#ffffff' }, textColor: '#6b7280', fontSize: 11 },
      grid: { vertLines: { color: '#f3f4f6' }, horzLines: { color: '#f3f4f6' } },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: '#e5e7eb', scaleMargins: { top: 0.05, bottom: 0.15 } },
      timeScale: { borderColor: '#e5e7eb', timeVisible: true, visible: showTime },
      width: containerRef.current!.clientWidth,
      height: h,
    })

    const mc = createChart(containerRef.current, chartOpts(400, false))
    chartRef.current = mc

    candleRef.current = mc.addCandlestickSeries({
      upColor: '#16a34a', downColor: '#dc2626',
      borderUpColor: '#16a34a', borderDownColor: '#dc2626',
      wickUpColor: '#16a34a', wickDownColor: '#dc2626',
    })
    vwapRef.current = mc.addLineSeries({
      color: '#4f46e5', lineWidth: 1, lineStyle: LineStyle.Dashed,
      title: 'VWAP', priceLineVisible: false, lastValueVisible: true,
    })
    ema9Ref.current = mc.addLineSeries({
      color: '#f59e0b', lineWidth: 1, title: 'EMA9', priceLineVisible: false, lastValueVisible: false,
    })
    ema21Ref.current = mc.addLineSeries({
      color: '#3b82f6', lineWidth: 1, title: 'EMA21', priceLineVisible: false, lastValueVisible: false,
    })

    const rc = createChart(rsiRef.current, chartOpts(80, true))
    rsiChartRef.current = rc
    rsiLineRef.current = rc.addLineSeries({
      color: '#8b5cf6', lineWidth: 1, title: 'RSI', priceLineVisible: false, lastValueVisible: true,
    })

    mc.timeScale().subscribeVisibleLogicalRangeChange(r => { if (r) rc.timeScale().setVisibleLogicalRange(r) })
    rc.timeScale().subscribeVisibleLogicalRangeChange(r => { if (r) mc.timeScale().setVisibleLogicalRange(r) })
    mc.subscribeCrosshairMove(p => {
      if (!p.time) return
      const b = barsRef.current.find(x => x.unix_time === (p.time as number)) ?? null
      if (b) setHovered(b)
    })

    const ro = new ResizeObserver(() => {
      if (containerRef.current) mc.applyOptions({ width: containerRef.current.clientWidth })
      if (rsiRef.current) rc.applyOptions({ width: rsiRef.current.clientWidth })
    })
    ro.observe(containerRef.current)
    return () => { ro.disconnect(); initialized.current = false; mc.remove(); rc.remove() }
  }, [])

  // Load bars
  useEffect(() => {
    if (!candleRef.current) return
    setChartLoading(true)
    axios.get('/api/naren/v1/nifty/chart-data?symbol=%5ENSEI&timeframe=5m')
      .then(r => {
        const bars: ChartBar[] = r.data.bars ?? []
        barsRef.current = bars
        if (!bars.length) return
        setHovered(bars[bars.length - 1])
        const toTime = (b: ChartBar) => b.unix_time as unknown as Time
        candleRef.current?.setData(bars.map(b => ({ time: toTime(b), open: b.open, high: b.high, low: b.low, close: b.close })))
        vwapRef.current?.setData(bars.filter(b => b.vwap > 0).map(b => ({ time: toTime(b), value: b.vwap })))
        ema9Ref.current?.setData(bars.filter(b => b.ema9 > 0).map(b => ({ time: toTime(b), value: b.ema9 })))
        ema21Ref.current?.setData(bars.filter(b => b.ema21 > 0).map(b => ({ time: toTime(b), value: b.ema21 })))
        rsiLineRef.current?.setData(bars.filter(b => b.rsi > 0).map(b => ({ time: toTime(b), value: b.rsi })))
        chartRef.current?.timeScale().fitContent()
        rsiChartRef.current?.timeScale().fitContent()
      })
      .catch(console.error)
      .finally(() => setChartLoading(false))
  }, [])

  // Draw VWAP + Pivot / CPR / S&R price lines once dashboard loads
  useEffect(() => {
    if (!candleRef.current || !dash) return
    // Clear old pivot lines
    pivotLines.current.forEach(pl => { try { candleRef.current?.removePriceLine(pl) } catch {} })
    pivotLines.current = []

    const pivotDefs: Array<Partial<PriceLineOptions> & { price: number }> = [
      { price: dash.pivot_pp, color: '#7c3aed', lineWidth: 2, lineStyle: LineStyle.Solid,   axisLabelVisible: true, title: 'PP' },
      { price: dash.pivot_tc, color: '#7c3aed', lineWidth: 1, lineStyle: LineStyle.Dashed,  axisLabelVisible: true, title: 'CPR Top' },
      { price: dash.pivot_bc, color: '#7c3aed', lineWidth: 1, lineStyle: LineStyle.Dashed,  axisLabelVisible: true, title: 'CPR Bot' },
      { price: dash.pivot_r1, color: '#dc2626', lineWidth: 1, lineStyle: LineStyle.Dotted,  axisLabelVisible: true, title: 'R1' },
      { price: dash.pivot_r2, color: '#b91c1c', lineWidth: 1, lineStyle: LineStyle.Dotted,  axisLabelVisible: true, title: 'R2' },
      { price: dash.pivot_s1, color: '#16a34a', lineWidth: 1, lineStyle: LineStyle.Dotted,  axisLabelVisible: true, title: 'S1' },
      { price: dash.pivot_s2, color: '#15803d', lineWidth: 1, lineStyle: LineStyle.Dotted,  axisLabelVisible: true, title: 'S2' },
      { price: dash.pdh,      color: '#ea580c', lineWidth: 1, lineStyle: LineStyle.SparseDotted, axisLabelVisible: true, title: 'PDH' },
      { price: dash.pdl,      color: '#0284c7', lineWidth: 1, lineStyle: LineStyle.SparseDotted, axisLabelVisible: true, title: 'PDL' },
    ]
    pivotDefs.forEach(def => {
      if (!def.price || def.price <= 0) return
      try { pivotLines.current.push(candleRef.current!.createPriceLine(def as PriceLineOptions)) } catch {}
    })
  }, [dash?.pivot_pp])

  // Draw strategy entry/SL/target lines when button clicked
  useEffect(() => {
    if (!candleRef.current) return
    stratLines.current.forEach(pl => { try { candleRef.current?.removePriceLine(pl) } catch {} })
    stratLines.current = []

    if (!chartSignal || chartSignal.signal === 'WAIT' || !chartStrategy) return

    const sc = STRATEGY_COLORS[chartSignal.strategy_id]
    const hex = sc?.hex ?? '#4f46e5'
    const isCE = chartSignal.signal === 'BUY_CE'
    const t1Pct = fmtDec(Math.abs(chartSignal.target_1 - chartSignal.entry) / Math.max(chartSignal.entry, 1) * 100, 1)

    const defs: Array<Partial<PriceLineOptions> & { price: number }> = [
      { price: chartSignal.entry,     color: hex,       lineWidth: 2, lineStyle: LineStyle.Solid,       axisLabelVisible: true, title: `▶ ENTRY (${STRATEGY_SHORT[chartSignal.strategy_id]})` },
      { price: chartSignal.stop_loss, color: '#dc2626', lineWidth: 1, lineStyle: LineStyle.Dashed,      axisLabelVisible: true, title: `✖ STOP` },
      { price: chartSignal.target_1,  color: '#16a34a', lineWidth: 1, lineStyle: LineStyle.Dashed,      axisLabelVisible: true, title: `T1 ${isCE ? '+' : '-'}${t1Pct}%` },
      { price: chartSignal.target_2,  color: '#15803d', lineWidth: 1, lineStyle: LineStyle.SparseDotted,axisLabelVisible: true, title: `T2` },
    ]
    if (chartSignal.strategy_id === 'orb' && chartSignal.levels.orb_high) {
      defs.push(
        { price: chartSignal.levels.orb_high, color: '#f97316', lineWidth: 1, lineStyle: LineStyle.Dotted, axisLabelVisible: true, title: 'ORB H' },
        { price: chartSignal.levels.orb_low,  color: '#f97316', lineWidth: 1, lineStyle: LineStyle.Dotted, axisLabelVisible: true, title: 'ORB L' },
      )
    }
    if (chartSignal.strategy_id === 'holy_grail' && chartSignal.levels.ema20) {
      defs.push({ price: chartSignal.levels.ema20, color: '#8b5cf6', lineWidth: 1, lineStyle: LineStyle.Dotted, axisLabelVisible: true, title: 'EMA20' })
    }
    defs.forEach(def => {
      if (!def.price || def.price <= 0) return
      try { stratLines.current.push(candleRef.current!.createPriceLine(def as PriceLineOptions)) } catch {}
    })
  }, [chartSignal, chartStrategy])

  const last = hovered ?? barsRef.current[barsRef.current.length - 1]

  return (
    <div>
      {/* Chart toolbar */}
      <div className="px-4 py-2.5 border-b border-gray-100 flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          <span className="text-xs font-bold text-gray-700">NIFTY 50 · 5-min</span>
          {chartSignal && chartSignal.signal !== 'WAIT' && (
            <span
              className="px-2 py-0.5 rounded text-[10px] font-bold text-white"
              style={{ backgroundColor: STRATEGY_COLORS[chartSignal.strategy_id]?.hex ?? '#4f46e5' }}
            >
              {STRATEGY_ICONS[chartSignal.strategy_id]} {STRATEGY_SHORT[chartSignal.strategy_id]} levels
            </span>
          )}
        </div>
        <div className="ml-auto flex items-center gap-3 text-[10px] text-gray-500">
          <LegendDot color="bg-amber-400" label="EMA9" />
          <LegendDot color="bg-blue-500" label="EMA21" />
          <LegendDot color="bg-indigo-600" label="VWAP" dashed />
          {chartSignal && chartSignal.signal !== 'WAIT' && <>
            <LegendDot color="bg-indigo-600" label="Entry" />
            <LegendDot color="bg-red-500" label="SL" dashed />
            <LegendDot color="bg-green-600" label="T1/T2" dashed />
          </>}
        </div>
      </div>

      {/* OHLCV bar */}
      {last && (
        <div className="px-4 py-1.5 bg-gray-50 border-b border-gray-100 flex flex-wrap gap-3 text-xs">
          <span className="font-mono tabular-nums text-gray-600">
            O <span className="text-gray-900 font-semibold">{last.open.toFixed(1)}</span>
          </span>
          <span className="font-mono tabular-nums text-gray-600">
            H <span className="text-green-700 font-semibold">{last.high.toFixed(1)}</span>
          </span>
          <span className="font-mono tabular-nums text-gray-600">
            L <span className="text-red-600 font-semibold">{last.low.toFixed(1)}</span>
          </span>
          <span className="font-mono tabular-nums text-gray-600">
            C <span className="text-gray-900 font-bold">{last.close.toFixed(1)}</span>
          </span>
          <span className="text-amber-600">EMA9 {last.ema9.toFixed(0)}</span>
          <span className="text-blue-600">EMA21 {last.ema21.toFixed(0)}</span>
          <span className="text-indigo-600">VWAP {last.vwap.toFixed(0)}</span>
          <span className={last.rsi >= 70 ? 'text-red-600 font-bold' : last.rsi <= 30 ? 'text-green-700 font-bold' : 'text-purple-600'}>
            RSI {last.rsi.toFixed(1)}
          </span>
          <span className="text-gray-400 ml-auto">{last.date}</span>
        </div>
      )}

      {/* Canvas */}
      <div className="relative">
        {chartLoading && (
          <div className="absolute inset-0 bg-white/80 flex items-center justify-center z-10">
            <div className="w-6 h-6 border-2 border-indigo-600 border-t-transparent rounded-full animate-spin" />
          </div>
        )}
        <div ref={containerRef} />
      </div>

      {/* RSI sub-chart */}
      <div className="border-t border-gray-100">
        <div className="px-4 py-1 flex gap-4 text-[10px] text-gray-400 bg-gray-50">
          <span className="text-purple-500 font-medium">RSI(14)</span>
          <span>OB <span className="text-red-500">70</span></span>
          <span>OS <span className="text-green-600">30</span></span>
        </div>
        <div ref={rsiRef} />
      </div>

      {/* Active signal summary below chart */}
      {chartSignal && chartSignal.signal !== 'WAIT' && (
        <div
          className="px-4 py-3 border-t"
          style={{
            backgroundColor: (STRATEGY_COLORS[chartSignal.strategy_id]?.hex ?? '#4f46e5') + '12',
            borderColor: (STRATEGY_COLORS[chartSignal.strategy_id]?.hex ?? '#4f46e5') + '40',
          }}
        >
          <div className="flex flex-wrap items-center gap-4 text-sm">
            <span className="font-bold text-gray-800">
              {STRATEGY_ICONS[chartSignal.strategy_id]} {chartSignal.strategy_name}
            </span>
            <span className="text-gray-400 text-xs">—</span>
            {[
              { l: 'Entry', v: fmtN(chartSignal.entry), c: 'text-indigo-700' },
              { l: 'Stop', v: fmtN(chartSignal.stop_loss), c: 'text-red-600' },
              { l: 'T1', v: fmtN(chartSignal.target_1), c: 'text-green-700' },
              { l: 'T2', v: fmtN(chartSignal.target_2), c: 'text-green-600' },
              { l: 'R:R', v: `1:${fmtDec(chartSignal.rr)}`, c: 'text-amber-700' },
            ].map(({ l, v, c }) => (
              <span key={l} className="text-xs text-gray-500">
                {l} <span className={`font-bold ${c} tabular-nums`}>{v}</span>
              </span>
            ))}
            <span
              className="ml-auto px-2 py-1 rounded font-bold text-xs text-white"
              style={{ backgroundColor: STRATEGY_COLORS[chartSignal.strategy_id]?.hex ?? '#4f46e5' }}
            >
              {fmtN(chartSignal.strike_price)} {chartSignal.direction} · {chartSignal.expiry}
            </span>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Small helpers ──────────────────────────────────────────────────────────────

function SessionPill({ session }: { session: string }) {
  if (session === 'OPEN') return (
    <span className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-green-100 text-green-700 text-[10px] font-bold border border-green-200">
      <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />LIVE
    </span>
  )
  if (session === 'PRE_OPEN') return (
    <span className="px-2.5 py-1 rounded-full bg-amber-100 text-amber-700 text-[10px] font-bold border border-amber-200">PRE-OPEN</span>
  )
  return (
    <span className="px-2.5 py-1 rounded-full bg-gray-100 text-gray-500 text-[10px] font-bold border border-gray-200">CLOSED</span>
  )
}

function LegendDot({ color, label, dashed }: { color: string; label: string; dashed?: boolean }) {
  return (
    <span className="flex items-center gap-1">
      <span className={`inline-block w-4 h-0.5 ${color} ${dashed ? 'opacity-60' : ''}`}
        style={dashed ? { backgroundImage: 'repeating-linear-gradient(90deg, currentColor 0, currentColor 3px, transparent 3px, transparent 6px)' } : {}} />
      {label}
    </span>
  )
}
