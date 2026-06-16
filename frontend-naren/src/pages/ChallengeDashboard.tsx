import { useState, useEffect, useCallback, useMemo } from 'react'

// ─── Types ────────────────────────────────────────────────────────────────────

interface ChallengeConfig {
  id: number; start_date: string; end_date: string; initial_capital: number
  target_capital: number; lots: number; risk_per_trade: number; target_per_trade: number
  status: string; notes: string; created_at: string
}

interface OptionSnapshot {
  pcr: number; call_oi: number; put_oi: number; iv: number
  atm_call_ltp: number; atm_put_ltp: number
}

interface ChallengeTrade {
  id: string; challenge_id: number; day_number: number
  strategy: string; direction: string; regime: string
  signal_basis: string[]; mode: string
  trading_symbol: string; expiry: string; strike: number; option_type: string
  lots: number; qty: number; dte: number
  entry_time: string; entry_spot: number; entry_premium: number
  entry_iv: number; entry_pcr: number; entry_oi: number
  entry_snapshot: OptionSnapshot
  exit_time?: string; exit_spot: number; exit_premium: number; exit_reason: string
  rr: number; pnl: number; pnl_pct: number; status: string
  live: boolean; live_order_id: string; live_exit_order_id: string
  created_at: string
}

interface ChallengeDay {
  id: number; challenge_id: number; date: string; day_number: number
  opening_balance: number; closing_balance: number; daily_pnl: number
  trade_count: number; wins: number; losses: number
  nifty_open: number; nifty_close: number
  best_trade: number; worst_trade: number
}

interface ChainStrike {
  Strike: number; CELTP: number; PELTP: number; CEOI: number; PEOI: number
}

interface ChainSnap {
  Spot: number; ATM: number; Strikes: ChainStrike[]
  TotalCallOI: number; TotalPutOI: number; PCR: number
  ATMCallLTP: number; ATMPutLTP: number
}

interface ChallengeStatus {
  active?: ChallengeConfig; day_number: number; days_remaining: number; progress_pct: number
  current_capital: number; total_pnl: number
  open_trade?: ChallengeTrade; open_pnl: number
  today_pnl: number; today_trades: number; total_trades: number
  win_count: number; loss_count: number; win_rate: number
  best_day: number; worst_day: number; current_streak: number
  last_signal?: { strategy: string; direction: string; confidence: number; reasoning: string[]; indicators: any }
  last_chain?: ChainSnap
  last_error: string
  live_allowed?: boolean
  live_enabled?: boolean
  live_profit_target?: number
  live_max_lots?: number
  live_min_profit?: number
  live_window_start?: string
  live_window_end?: string
  live_hold_confidence?: number
  live_rr?: number
  live_max_daily_loss?: number
  live_max_consec_losses?: number
  live_daily_risk_capital?: number
  live_max_entries_per_day?: number
}

// Streamed every ~2s over SSE from /live/stream (Kite-WebSocket driven).
interface LiveSnap {
  spot?: number
  total_pnl?: number
  today_pnl?: number
  ticker_live?: boolean
  last_error?: string
  open_option?: {
    current_premium?: number
    pnl?: number
    pnl_pct?: number
    premium_change?: number
    sl_premium?: number
    target_premium?: number
    // Dynamic SL fields
    effective_sl_amt?: number
    peak_pnl?: number
    trailing_sl_active?: boolean
    trailing_sl_level?: number
    trailing_sl_premium?: number
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const fmt  = (n: number) => new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(Math.abs(n))
const fmtF = (n: number, d = 1) => (n ?? 0).toFixed(d)
const sgn  = (n: number) => n >= 0 ? '+' : '-'
const pc   = (n: number) => n >= 0 ? 'text-emerald-400' : 'text-red-400'
const bgpc = (n: number) => n >= 0 ? 'bg-emerald-500/10 border-emerald-500/30' : 'bg-red-500/10 border-red-500/30'

const STRAT_SHORT: Record<string, string> = {
  DIRECTIONAL_CE:'Buy CE', DIRECTIONAL_PE:'Buy PE',
  ORB_CE:'ORB CE', ORB_PE:'ORB PE',
  SUPERTREND:'SuperTrend', EMA_CROSS:'EMA Cross',
  ATR_MOMENTUM:'ATR Break', VWAP:'VWAP',
  IRON_CONDOR:'Iron Condor', IRON_FLY:'Iron Fly', SHORT_STRADDLE:'Straddle',
  NO_TRADE:'No Trade',
}

function post(url: string, body?: unknown, signal?: AbortSignal) {
  return fetch(url, { method:'POST', headers:{'Content-Type':'application/json'}, body: body ? JSON.stringify(body) : undefined, signal }).then(r => r.json())
}

function postWithTimeout(url: string, body?: unknown, timeoutMs = 8000) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  return post(url, body, ctrl.signal).finally(() => clearTimeout(timer))
}

// ─── Countdown ────────────────────────────────────────────────────────────────

function Countdown({ status }: { status: ChallengeStatus }) {
  if (!status.active) return null
  const pct = Math.min(100, status.progress_pct)
  const endDate = new Date(status.active.end_date).toLocaleDateString('en-IN', { day:'2-digit', month:'short', year:'numeric' })
  return (
    <div className="bg-gradient-to-r from-blue-500/10 via-slate-800/80 to-purple-500/10 border border-blue-500/30 rounded-2xl p-5">
      <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
        <div>
          <p className="text-xs text-blue-300 font-semibold uppercase tracking-wide">90-Day Paper Trading Challenge</p>
          <p className="text-2xl font-bold text-slate-100 mt-0.5">
            Day <span className="text-blue-400">{status.day_number}</span> of 90
          </p>
        </div>
        <div className="text-right">
          <p className="text-xs text-slate-400">Ends {endDate}</p>
          <p className={`text-xl font-bold ${pc(status.total_pnl)}`}>{sgn(status.total_pnl)}₹{fmt(status.total_pnl)}</p>
          <p className="text-xs text-slate-400">Total P&L · {status.total_trades} trades</p>
        </div>
      </div>
      <div className="h-3 bg-slate-700 rounded-full overflow-hidden">
        <div className="h-full bg-gradient-to-r from-blue-500 to-purple-500 rounded-full transition-all"
          style={{ width: `${pct}%` }} />
      </div>
      <div className="flex justify-between text-xs text-slate-500 mt-1">
        <span>Start: {new Date(status.active.start_date).toLocaleDateString('en-IN')}</span>
        <span>{status.days_remaining} days remaining</span>
      </div>
    </div>
  )
}

// ─── Stats row ────────────────────────────────────────────────────────────────

function StatsRow({ s }: { s: ChallengeStatus }) {
  const cards = [
    { label: 'Capital Now',    value: `₹${fmt(s.current_capital)}`,          color: pc(s.total_pnl) },
    { label: "Today's P&L",   value: `${sgn(s.today_pnl)}₹${fmt(s.today_pnl)}`, color: pc(s.today_pnl) },
    { label: 'Open P&L',      value: `${sgn(s.open_pnl)}₹${fmt(s.open_pnl)}`, color: pc(s.open_pnl) },
    { label: 'Win Rate',      value: `${fmtF(s.win_rate, 0)}%`,              color: s.win_rate >= 55 ? 'text-emerald-400' : 'text-yellow-400',
      sub: `${s.win_count}W / ${s.loss_count}L` },
    { label: 'Best Day',      value: `+₹${fmt(s.best_day)}`,                 color: 'text-emerald-400' },
    { label: 'Worst Day',     value: `-₹${fmt(Math.abs(s.worst_day))}`,      color: 'text-red-400' },
    { label: 'Streak',        value: s.current_streak > 0 ? `+${s.current_streak} wins` : s.current_streak < 0 ? `${s.current_streak} losses` : '—',
      color: s.current_streak > 0 ? 'text-emerald-400' : s.current_streak < 0 ? 'text-red-400' : 'text-slate-400' },
    { label: 'Risk / Target', value: `₹${fmt(s.active?.risk_per_trade??5000)} / ₹${fmt(s.active?.target_per_trade??10000)}`,
      color: 'text-slate-300' },
  ]
  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-3">
      {cards.map(c => (
        <div key={c.label} className="bg-slate-800/70 rounded-xl p-3 border border-slate-700/50">
          <p className="text-slate-500 text-[10px] mb-0.5">{c.label}</p>
          <p className={`text-base font-bold leading-tight ${c.color}`}>{c.value}</p>
          {c.sub && <p className="text-slate-500 text-[10px] mt-0.5">{c.sub}</p>}
        </div>
      ))}
    </div>
  )
}

// ─── Open position ────────────────────────────────────────────────────────────

function OpenPosition({ t, pnl, onExit, current, pnlPct, liveOn, snap }: {
  t: ChallengeTrade; pnl: number; onExit: () => void
  current?: number; pnlPct?: number; liveOn?: boolean
  snap?: LiveSnap['open_option']
}) {
  const eff       = snap?.effective_sl_amt ?? 0
  const peak      = snap?.peak_pnl ?? 0
  const trailOn   = snap?.trailing_sl_active ?? false
  const trailLvl  = snap?.trailing_sl_level ?? 0
  const trailPrem = snap?.trailing_sl_premium ?? 0
  const slPremium = snap?.sl_premium ?? 0
  const tgtPrem   = snap?.target_premium ?? 0

  // Progress bar: 0 = at SL, 1 = at target
  const slAmt  = eff > 0 ? eff : 5000
  const tgtAmt = t.qty > 0 && tgtPrem > 0 ? (tgtPrem - t.entry_premium) * t.qty : 0
  const range  = slAmt + (tgtAmt > 0 ? tgtAmt : slAmt)
  const barPct = Math.min(100, Math.max(0, ((pnl + slAmt) / range) * 100))
  const barCol = trailOn ? 'bg-blue-500' : pnl >= 0 ? 'bg-emerald-500' : 'bg-red-500'

  return (
    <div className={`rounded-xl border p-5 space-y-4 ${bgpc(pnl)}`}>
      {/* ── Header ── */}
      <div className="flex items-start justify-between">
        <div>
          <p className="text-xs text-slate-400 mb-1 flex items-center gap-1.5">
            Open Position — Day {t.day_number}
            {liveOn && <span className="inline-flex items-center gap-1 text-emerald-400"><span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />live</span>}
          </p>
          <p className="text-xl font-bold text-slate-100">{t.trading_symbol}</p>
          <p className="text-sm text-slate-400">
            Expiry: <span className="text-emerald-300">{t.expiry}</span> · DTE at entry: {t.dte}d · {t.qty} qty ({t.lots} lots)
          </p>
        </div>
        <div className="text-right">
          <p className={`text-3xl font-bold ${pc(pnl)}`}>{sgn(pnl)}₹{fmt(pnl)}
            {pnlPct != null && <span className="text-sm ml-1">({pnlPct >= 0 ? '+' : ''}{pnlPct.toFixed(0)}%)</span>}
          </p>
          {current != null && current > 0 && (
            <p className="text-xs text-slate-400">LTP ₹{current.toFixed(1)} <span className="text-slate-500">(entry ₹{t.entry_premium?.toFixed(1)})</span></p>
          )}
          <button onClick={onExit}
            className="mt-1 px-4 py-1.5 bg-red-600/80 hover:bg-red-600 text-white text-xs font-semibold rounded-lg transition-colors">
            Square Off
          </button>
        </div>
      </div>

      {/* ── Dynamic SL panel ── */}
      <div className="bg-slate-900/60 rounded-xl border border-slate-700/60 p-4 space-y-3">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <p className="text-[10px] text-slate-400 font-semibold uppercase tracking-wide">Stop-Loss Regime</p>
          {trailOn
            ? <span className="flex items-center gap-1 text-[10px] font-bold text-blue-400 bg-blue-500/10 border border-blue-500/30 rounded-full px-2 py-0.5">
                <span className="inline-block w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse" />
                Trailing SL active
              </span>
            : <span className="text-[10px] text-slate-500 bg-slate-800 border border-slate-700 rounded-full px-2 py-0.5">Fixed SL</span>
          }
        </div>

        {/* SL / target numbers */}
        <div className="grid grid-cols-3 gap-2 text-xs">
          <div className="bg-red-500/10 border border-red-500/20 rounded-lg p-2 text-center">
            <p className="text-red-300 text-[10px] mb-0.5">{trailOn ? 'Trailing SL' : 'Effective SL'}</p>
            <p className="text-red-200 font-bold">-₹{fmt(slAmt)}</p>
            {slPremium > 0 && <p className="text-red-400/70 text-[10px] mt-0.5">prem ₹{slPremium.toFixed(1)}</p>}
          </div>
          <div className="bg-slate-800/80 border border-slate-700/50 rounded-lg p-2 text-center">
            <p className="text-slate-400 text-[10px] mb-0.5">Peak P&L</p>
            <p className={`font-bold ${pc(peak)}`}>{peak > 0 ? '+' : ''}{peak === 0 ? '—' : `₹${fmt(peak)}`}</p>
            {trailOn && trailLvl > 0 && (
              <p className="text-blue-400 text-[10px] mt-0.5">floor +₹{fmt(trailLvl)}</p>
            )}
          </div>
          <div className="bg-emerald-500/10 border border-emerald-500/20 rounded-lg p-2 text-center">
            <p className="text-emerald-300 text-[10px] mb-0.5">Target</p>
            <p className="text-emerald-200 font-bold">+₹{fmt(tgtAmt > 0 ? tgtAmt : 0)}</p>
            {tgtPrem > 0 && <p className="text-emerald-400/70 text-[10px] mt-0.5">prem ₹{tgtPrem.toFixed(1)}</p>}
          </div>
        </div>

        {/* P&L progress bar */}
        <div>
          <div className="h-2 bg-slate-700 rounded-full overflow-hidden">
            <div className={`h-full rounded-full transition-all duration-500 ${barCol}`} style={{ width: `${barPct}%` }} />
          </div>
          <div className="flex justify-between text-[10px] text-slate-500 mt-0.5">
            <span>SL -₹{fmt(slAmt)}</span>
            <span>B/E</span>
            <span>Target +₹{fmt(tgtAmt > 0 ? tgtAmt : slAmt)}</span>
          </div>
        </div>

        {/* Trailing SL explanation when active */}
        {trailOn && (
          <div className="bg-blue-500/8 border border-blue-500/20 rounded-lg p-2 text-[10px] text-blue-300">
            Peak ₹{peak.toFixed(0)} reached — trailing SL locked at +₹{trailLvl.toFixed(0)}
            {trailPrem > 0 && ` (prem ₹${trailPrem.toFixed(1)})`}.
            Position exits if P&L falls back to this level.
          </div>
        )}

        {/* SL source note */}
        <p className="text-[10px] text-slate-600">
          SL = min(today's profit, algo risk per trade){trailOn ? ' · trailing at 1:1 from peak' : ' · trailing activates once peak ≥ 1×SL'}
        </p>
      </div>

      {/* ── Entry details grid ── */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
        {[
          ['Entry Premium', `₹${t.entry_premium?.toFixed(1)}`],
          ['Entry Spot', `${t.entry_spot?.toFixed(0)}`],
          ['Entry IV', `${t.entry_iv?.toFixed(1)}%`],
          ['Entry PCR', t.entry_pcr?.toFixed(3)],
          ['Strike', t.strike?.toFixed(0)],
          ['Strategy', STRAT_SHORT[t.strategy] || t.strategy],
          ['Direction', t.direction],
          ['Mode', t.mode],
        ].map(([k, v]) => (
          <div key={k} className="bg-slate-800/60 rounded-lg p-2">
            <p className="text-slate-500 text-[10px]">{k}</p>
            <p className="text-slate-200 font-semibold">{v}</p>
          </div>
        ))}
      </div>
      {t.signal_basis?.length > 0 && (
        <div className="bg-slate-800/40 rounded-lg p-3">
          <p className="text-[10px] text-slate-500 font-semibold uppercase tracking-wide mb-1">Signal Basis</p>
          {t.signal_basis.map((r, i) => (
            <p key={i} className="text-xs text-slate-400 flex gap-2">
              <span className="text-blue-400">›</span>{r}
            </p>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── Option chain panel ───────────────────────────────────────────────────────

function ChainPanel({ chain }: { chain?: ChainSnap }) {
  if (!chain) return null
  const pcrColor = chain.PCR > 1.2 ? 'text-emerald-400' : chain.PCR < 0.8 ? 'text-red-400' : 'text-slate-300'
  const pcrLabel = chain.PCR > 1.3 ? 'BULLISH (contrarian)' : chain.PCR > 1.1 ? 'MILDLY BULLISH' :
    chain.PCR < 0.7 ? 'BEARISH (contrarian)' : chain.PCR < 0.85 ? 'MILDLY BEARISH' : 'NEUTRAL'
  return (
    <div className="bg-slate-800/70 rounded-xl border border-slate-700/50 overflow-hidden">
      <div className="px-5 py-3 border-b border-slate-700/50 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-slate-200">Live Option Chain (NIFTY)</h3>
        <div className="flex items-center gap-3 text-xs">
          <span className="text-slate-400">Spot <strong className="text-slate-200">{chain.Spot?.toFixed(0)}</strong></span>
          <span className="text-slate-400">ATM <strong className="text-slate-200">{chain.ATM?.toFixed(0)}</strong></span>
          <span>PCR <strong className={pcrColor}>{chain.PCR?.toFixed(3)} {pcrLabel}</strong></span>
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-slate-400 border-b border-slate-700/40 bg-slate-800/50">
              <th className="text-right px-3 py-2">CE OI</th>
              <th className="text-right px-3 py-2">CE LTP</th>
              <th className="text-center px-4 py-2 text-slate-200 font-bold">Strike</th>
              <th className="text-right px-3 py-2">PE LTP</th>
              <th className="text-right px-3 py-2">PE OI</th>
            </tr>
          </thead>
          <tbody>
            {chain.Strikes?.map((s, i) => {
              const isATM = Math.abs(s.Strike - chain.ATM) < 0.01
              return (
                <tr key={i} className={`border-b border-slate-700/10 ${isATM ? 'bg-blue-500/8' : 'hover:bg-slate-700/20'}`}>
                  <td className="px-3 py-1.5 text-right text-slate-400 font-mono">{s.CEOI > 0 ? (s.CEOI/1e5).toFixed(1)+'L' : '—'}</td>
                  <td className={`px-3 py-1.5 text-right font-mono font-semibold ${s.CELTP > 0 ? 'text-blue-300' : 'text-slate-500'}`}>
                    {s.CELTP > 0 ? `₹${s.CELTP?.toFixed(1)}` : '—'}
                  </td>
                  <td className={`px-4 py-1.5 text-center font-bold ${isATM ? 'text-blue-400' : 'text-slate-300'}`}>
                    {s.Strike?.toFixed(0)} {isATM ? '◄ATM' : ''}
                  </td>
                  <td className={`px-3 py-1.5 text-right font-mono font-semibold ${s.PELTP > 0 ? 'text-purple-300' : 'text-slate-500'}`}>
                    {s.PELTP > 0 ? `₹${s.PELTP?.toFixed(1)}` : '—'}
                  </td>
                  <td className="px-3 py-1.5 text-right text-slate-400 font-mono">{s.PEOI > 0 ? (s.PEOI/1e5).toFixed(1)+'L' : '—'}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ─── Equity curve ─────────────────────────────────────────────────────────────

function EquityCurve({ days, initial, current }: { days: ChallengeDay[]; initial: number; current?: number }) {
  const w = 900, h = 200, padX = 8, padY = 12
  // Start at initial capital, add each completed day's closing balance, then a
  // live "now" point so the curve updates intraday (via the SSE stream) instead
  // of only after end-of-day snapshots are written.
  const vals = [initial, ...days.map(d => d.closing_balance)]
  if (current != null && current > 0 && Math.abs(current - vals[vals.length - 1]) > 0.5) vals.push(current)
  if (vals.length < 2) return (
    <div className="bg-slate-800/60 rounded-xl border border-slate-700/50 p-8 text-center text-slate-400 text-sm">
      Equity curve will appear once trading begins.
    </div>
  )
  const minV = Math.min(...vals), maxV = Math.max(...vals)
  const range = maxV - minV || 1
  const sx = (i: number) => padX + (i / Math.max(vals.length - 1, 1)) * (w - 2 * padX)
  const sy = (v: number) => h - padY - ((v - minV) / range) * (h - 2 * padY)
  const zeroY = sy(initial)
  const path = vals.map((v, i) => `${i === 0 ? 'M' : 'L'}${sx(i).toFixed(1)},${sy(v).toFixed(1)}`).join(' ')
  const last = vals[vals.length - 1]
  const col  = last >= initial ? '#34d399' : '#f87171'
  const fill = `${path} L${sx(vals.length-1).toFixed(1)},${zeroY.toFixed(1)} L${padX},${zeroY.toFixed(1)} Z`

  return (
    <div className="bg-slate-800/70 rounded-xl border border-slate-700/50 p-5">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-slate-200">Capital Growth Curve</h3>
        <div className="flex items-center gap-4 text-xs">
          <span className="text-slate-400">Start ₹{fmt(initial)}</span>
          <span className={`font-bold ${pc(last - initial)}`}>Now ₹{fmt(last)} ({sgn(last-initial)}{((last-initial)/initial*100).toFixed(1)}%)</span>
        </div>
      </div>
      <svg viewBox={`0 0 ${w} ${h}`} className="w-full" preserveAspectRatio="none" style={{ height: 160 }}>
        <defs>
          <linearGradient id="chEqFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={col} stopOpacity="0.3" />
            <stop offset="100%" stopColor={col} stopOpacity="0" />
          </linearGradient>
        </defs>
        <line x1={padX} y1={zeroY} x2={w - padX} y2={zeroY} stroke="#475569" strokeWidth="1" strokeDasharray="4 3" />
        <path d={fill} fill="url(#chEqFill)" />
        <path d={path} fill="none" stroke={col} strokeWidth="2" />
      </svg>
    </div>
  )
}

// ─── Daily P&L table ──────────────────────────────────────────────────────────

function DailyTable({ days }: { days: ChallengeDay[] }) {
  return (
    <div className="bg-slate-800/70 rounded-xl border border-slate-700/50 overflow-hidden">
      <div className="px-5 py-3 border-b border-slate-700/50">
        <h3 className="text-sm font-semibold text-slate-200">Daily P&L Log</h3>
      </div>
      <div className="overflow-x-auto max-h-72 overflow-y-auto">
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-slate-800/95">
            <tr className="text-slate-400 border-b border-slate-700/40">
              {['Day','Date','Opening ₹','Daily P&L','Closing ₹','Trades','W/L','NIFTY'].map(h => (
                <th key={h} className={`px-3 py-2 ${['Opening ₹','Daily P&L','Closing ₹'].includes(h)?'text-right':'text-left'}`}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {[...days].reverse().map(d => (
              <tr key={d.id} className={`border-b border-slate-700/20 hover:bg-slate-700/20 ${d.daily_pnl >= 0 ? '' : 'bg-red-500/3'}`}>
                <td className="px-3 py-2 text-slate-400">{d.day_number}</td>
                <td className="px-3 py-2 text-slate-300 whitespace-nowrap">{new Date(d.date).toLocaleDateString('en-IN', { day:'2-digit', month:'short' })}</td>
                <td className="px-3 py-2 text-right text-slate-400 font-mono">₹{fmt(d.opening_balance)}</td>
                <td className={`px-3 py-2 text-right font-bold ${pc(d.daily_pnl)}`}>{sgn(d.daily_pnl)}₹{fmt(d.daily_pnl)}</td>
                <td className="px-3 py-2 text-right text-slate-300 font-mono">₹{fmt(d.closing_balance)}</td>
                <td className="px-3 py-2 text-slate-400">{d.trade_count}</td>
                <td className="px-3 py-2">
                  <span className="text-emerald-400">{d.wins}W</span>
                  <span className="text-slate-500"> / </span>
                  <span className="text-red-400">{d.losses}L</span>
                </td>
                <td className="px-3 py-2 text-slate-400 font-mono">
                  {d.nifty_open > 0 ? `${d.nifty_open.toFixed(0)}→${d.nifty_close.toFixed(0)}` : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ─── Full trade log ───────────────────────────────────────────────────────────

function TradeLog({ trades }: { trades: ChallengeTrade[] }) {
  const [expanded, setExpanded] = useState<string | null>(null)
  return (
    <div className="bg-slate-800/70 rounded-xl border border-slate-700/50 overflow-hidden">
      <div className="px-5 py-3 border-b border-slate-700/50 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-slate-200">All Trades</h3>
        <span className="text-xs text-slate-400">{trades.length} trades — click row for signal basis</span>
      </div>
      <div className="overflow-x-auto max-h-[480px] overflow-y-auto">
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-slate-800/95 z-10">
            <tr className="text-slate-400 border-b border-slate-700/40">
              <th className="text-left px-3 py-2">Day</th>
              <th className="text-left px-3 py-2 whitespace-nowrap">Entry Time</th>
              <th className="text-left px-3 py-2">Contract</th>
              <th className="text-left px-2 py-2">Expiry</th>
              <th className="text-right px-2 py-2">Strike</th>
              <th className="text-right px-2 py-2">DTE</th>
              <th className="text-right px-2 py-2">Entry₹</th>
              <th className="text-right px-2 py-2">Exit₹</th>
              <th className="text-right px-2 py-2">IV%</th>
              <th className="text-right px-2 py-2">PCR</th>
              <th className="text-left px-2 py-2">Strategy</th>
              <th className="text-left px-2 py-2">Reason</th>
              <th className="text-right px-3 py-2">P&L</th>
            </tr>
          </thead>
          <tbody>
            {trades.map(t => (
              <>
                <tr key={t.id} onClick={() => setExpanded(expanded === t.id ? null : t.id)}
                  className={`border-b border-slate-700/15 hover:bg-slate-700/20 cursor-pointer
                    ${t.pnl >= 0 ? '' : 'bg-red-500/3'} ${t.status === 'OPEN' ? 'bg-blue-500/5' : ''}`}>
                  <td className="px-3 py-2 text-slate-500">{t.day_number}</td>
                  <td className="px-3 py-2 text-slate-400 font-mono whitespace-nowrap">
                    {new Date(t.entry_time).toLocaleString('en-IN', { day:'2-digit', month:'short', hour:'2-digit', minute:'2-digit' })}
                  </td>
                  <td className="px-3 py-2 font-mono text-slate-100 font-semibold">
                    {t.trading_symbol}
                    {t.live && <span title={`Real Zerodha order: ${t.live_order_id}`} className="ml-1.5 text-[10px] font-bold text-amber-400 bg-amber-400/10 border border-amber-400/30 rounded px-1 py-0.5 align-middle">⚡ LIVE</span>}
                  </td>
                  <td className="px-2 py-2 text-emerald-300 font-mono text-[10px]">{t.expiry}</td>
                  <td className="px-2 py-2 text-right text-slate-200 font-mono font-bold">{t.strike?.toFixed(0)}</td>
                  <td className="px-2 py-2 text-right text-slate-400">{t.dte}d</td>
                  <td className="px-2 py-2 text-right font-mono text-slate-200">₹{t.entry_premium?.toFixed(1)}</td>
                  <td className="px-2 py-2 text-right font-mono text-slate-300">
                    {t.status === 'CLOSED' ? `₹${t.exit_premium?.toFixed(1)}` : <span className="text-blue-400 animate-pulse">OPEN</span>}
                  </td>
                  <td className="px-2 py-2 text-right text-slate-400">{t.entry_iv?.toFixed(1)}</td>
                  <td className="px-2 py-2 text-right text-slate-400">{t.entry_pcr?.toFixed(2)}</td>
                  <td className="px-2 py-2 text-slate-300">{STRAT_SHORT[t.strategy] || t.strategy}</td>
                  <td className="px-2 py-2 text-slate-500 whitespace-nowrap">{t.exit_reason || '—'}</td>
                  <td className={`px-3 py-2 text-right font-bold ${t.status === 'OPEN' ? 'text-blue-400' : pc(t.pnl)}`}>
                    {t.status === 'OPEN' ? '—' : `${sgn(t.pnl)}₹${fmt(t.pnl)}`}
                  </td>
                </tr>
                {expanded === t.id && (
                  <tr key={`${t.id}-x`} className="bg-slate-700/20">
                    <td colSpan={13} className="px-5 py-3">
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div>
                          <p className="text-[10px] text-slate-500 font-semibold uppercase tracking-wide mb-1.5">Signal Basis</p>
                          {t.signal_basis?.map((r, i) => (
                            <p key={i} className="text-xs text-slate-400 flex gap-2 mb-0.5">
                              <span className="text-blue-400 shrink-0">›</span>{r}
                            </p>
                          ))}
                        </div>
                        <div>
                          <p className="text-[10px] text-slate-500 font-semibold uppercase tracking-wide mb-1.5">Market Context at Entry</p>
                          <div className="grid grid-cols-2 gap-1 text-xs">
                            {[
                              ['OI (this option)', (t.entry_oi/1e5).toFixed(1)+'L'],
                              ['PCR', t.entry_pcr?.toFixed(3)],
                              ['IV', t.entry_iv?.toFixed(1)+'%'],
                              ['ATM Call LTP', `₹${t.entry_snapshot?.atm_call_ltp?.toFixed(1)}`],
                              ['ATM Put LTP',  `₹${t.entry_snapshot?.atm_put_ltp?.toFixed(1)}`],
                              ['Total Call OI', (t.entry_snapshot?.call_oi/1e5)?.toFixed(1)+'L'],
                            ].map(([k,v]) => (
                              <div key={k} className="flex justify-between">
                                <span className="text-slate-500">{k}:</span>
                                <span className="text-slate-300 font-mono">{v}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      </div>
                    </td>
                  </tr>
                )}
              </>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ─── Expiry breakdown ─────────────────────────────────────────────────────────

function ExpiryBreakdown({ data }: { data: any[] }) {
  if (!data?.length) return null
  const max = Math.max(...data.map((d: any) => Math.abs(d.total_pnl)))
  return (
    <div className="bg-slate-800/70 rounded-xl border border-slate-700/50 overflow-hidden">
      <div className="px-5 py-3 border-b border-slate-700/50">
        <h3 className="text-sm font-semibold text-slate-200">Expiry-wise Performance</h3>
      </div>
      <table className="w-full text-xs">
        <thead>
          <tr className="text-slate-400 border-b border-slate-700/40 bg-slate-800/50">
            <th className="text-left px-5 py-2">Expiry</th>
            <th className="text-right px-3 py-2">Trades</th>
            <th className="text-right px-3 py-2">Win Rate</th>
            <th className="text-right px-3 py-2">Avg Entry₹</th>
            <th className="text-right px-3 py-2">Total P&L</th>
            <th className="px-5 py-2">Bar</th>
          </tr>
        </thead>
        <tbody>
          {data.map((d: any) => (
            <tr key={d.expiry} className="border-b border-slate-700/20 hover:bg-slate-700/20">
              <td className="px-5 py-2.5 font-mono text-emerald-300">{d.expiry}</td>
              <td className="px-3 py-2.5 text-right text-slate-400">{d.trades}</td>
              <td className="px-3 py-2.5 text-right">
                <span className={d.win_rate >= 50 ? 'text-emerald-400' : 'text-red-400'}>{fmtF(d.win_rate)}%</span>
              </td>
              <td className="px-3 py-2.5 text-right text-slate-300 font-mono">₹{fmtF(d.avg_premium)}</td>
              <td className={`px-3 py-2.5 text-right font-bold ${pc(d.total_pnl)}`}>{sgn(d.total_pnl)}₹{fmt(d.total_pnl)}</td>
              <td className="px-5 py-2.5 w-28">
                <div className="h-2 bg-slate-700 rounded-full overflow-hidden">
                  <div className={`h-full rounded-full ${d.total_pnl >= 0 ? 'bg-emerald-500' : 'bg-red-500'}`}
                    style={{ width: `${Math.min(100, Math.abs(d.total_pnl) / max * 100)}%` }} />
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ─── Start challenge form ─────────────────────────────────────────────────────

function StartForm({ onStart }: { onStart: () => void }) {
  const [lots,   setLots]   = useState(2)
  const [risk,   setRisk]   = useState(5000)
  const [target, setTarget] = useState(10000)
  const [notes,  setNotes]  = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const start = async () => {
    setLoading(true); setError('')
    try {
      const r = await post('/api/naren/v1/challenge/start', { lots, risk_per_trade: risk, target_per_trade: target, notes })
      if (r.error) throw new Error(r.error)
      onStart()
    } catch (e) { setError((e as Error).message) }
    finally { setLoading(false) }
  }

  const rr = target / risk

  return (
    <div className="max-w-xl mx-auto bg-slate-800/80 border border-slate-700/60 rounded-2xl p-8 space-y-5">
      <div className="text-center">
        <div className="text-5xl mb-3">🏆</div>
        <h2 className="text-xl font-bold text-slate-100">Start Your 90-Day Challenge</h2>
        <p className="text-slate-400 text-sm mt-1">Pure paper trading · Real Kite signals · PCR + IV filtered · Track every trade</p>
      </div>

      <div className="grid grid-cols-3 gap-3">
        <div>
          <p className="text-xs text-slate-400 mb-1">Lots</p>
          <input type="number" value={lots} min={1} max={20} onChange={e => setLots(+e.target.value)}
            className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-slate-200 text-sm" />
          <p className="text-[10px] text-slate-500 mt-0.5">{lots * 75} qty total</p>
        </div>
        <div>
          <p className="text-xs text-slate-400 mb-1">Risk / Trade (SL)</p>
          <div className="relative">
            <span className="absolute left-2.5 top-2 text-slate-400 text-xs">₹</span>
            <input type="number" value={risk} min={500} step={500} onChange={e => setRisk(+e.target.value)}
              className="w-full bg-slate-700 border border-slate-600 rounded-lg pl-6 pr-3 py-2 text-slate-200 text-sm" />
          </div>
        </div>
        <div>
          <p className="text-xs text-slate-400 mb-1">Target / Trade</p>
          <div className="relative">
            <span className="absolute left-2.5 top-2 text-slate-400 text-xs">₹</span>
            <input type="number" value={target} min={500} step={500} onChange={e => setTarget(+e.target.value)}
              className="w-full bg-slate-700 border border-slate-600 rounded-lg pl-6 pr-3 py-2 text-slate-200 text-sm" />
          </div>
        </div>
      </div>

      <div className="flex items-center gap-3 text-sm bg-slate-700/40 rounded-lg px-4 py-2.5">
        <span className={`font-semibold px-2 py-0.5 rounded ${rr >= 2 ? 'bg-emerald-500/20 text-emerald-300' : rr >= 1.5 ? 'bg-yellow-500/20 text-yellow-300' : 'bg-red-500/20 text-red-300'}`}>
          RR 1:{rr.toFixed(1)}
        </span>
        <span className="text-slate-400">·</span>
        <span className="text-slate-300">{lots} lots × 75 = {lots * 75} qty</span>
        <span className="text-slate-400">·</span>
        <span className="text-slate-400 text-xs">90 days · real Kite LTP at fill · PCR filter</span>
      </div>

      <div>
        <p className="text-xs text-slate-400 mb-1">Notes (optional)</p>
        <input type="text" value={notes} onChange={e => setNotes(e.target.value)}
          placeholder="e.g. Starting with conservative approach..."
          className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-slate-200 text-sm" />
      </div>

      {error && <p className="text-red-400 text-sm">{error}</p>}

      <button onClick={start} disabled={loading}
        className="w-full py-3 bg-blue-600 hover:bg-blue-500 disabled:opacity-60 text-white font-bold rounded-xl transition-colors">
        {loading ? 'Starting…' : '🚀 Start 90-Day Challenge'}
      </button>
    </div>
  )
}

// ─── Backtest panel ─────────────────────────────────────────────────────────

function BacktestPanel() {
  const [days, setDays] = useState(60)
  const [lots, setLots] = useState(2)
  const [risk, setRisk] = useState(5000)
  const [target, setTarget] = useState(10000)
  const [res, setRes] = useState<any>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const run = async () => {
    setBusy(true); setErr(''); setRes(null)
    try {
      const r = await post('/api/naren/v1/challenge/backtest', { days, lots, risk, target })
      if (r?.error) setErr(r.error); else setRes(r)
    } catch { setErr('backtest failed') }
    finally { setBusy(false) }
  }

  const cards: [string, string, string][] = res ? [
    ['Total P&L', `${res.total_pnl >= 0 ? '+' : ''}₹${fmt(res.total_pnl)}`, pc(res.total_pnl)],
    ['Trades', `${res.trades?.length || 0}`, 'text-slate-200'],
    ['Win Rate', `${fmtF(res.win_rate, 0)}%`, res.win_rate >= 50 ? 'text-emerald-400' : 'text-yellow-400'],
    ['Profit Factor', fmtF(res.profit_factor, 2), res.profit_factor >= 1.3 ? 'text-emerald-400' : 'text-red-400'],
    ['Expectancy/trade', `₹${fmt(res.expectancy)}`, pc(res.expectancy)],
    ['Max Drawdown', `-₹${fmt(res.max_drawdown)}`, 'text-red-400'],
    ['Avg Win', `₹${fmt(res.avg_win)}`, 'text-emerald-400'],
    ['Avg Loss', `₹${fmt(res.avg_loss)}`, 'text-red-400'],
    ['Reward:Risk', fmtF(res.reward_risk, 2), 'text-slate-200'],
    ['Max Consec Loss', `${res.max_consec_loss}`, 'text-slate-300'],
  ] : []

  return (
    <div className="bg-slate-800/70 rounded-xl border border-slate-700/50 p-5">
      <div className="flex items-end gap-3 flex-wrap">
        <h3 className="text-sm font-semibold text-slate-200 mr-1">🧪 Backtest the challenge</h3>
        <label className="text-xs text-slate-400">Days
          <input type="number" min={5} max={180} value={days} onChange={e => setDays(+e.target.value)} className="block mt-1 w-20 bg-slate-900 border border-slate-700 rounded px-2 py-1 text-sm text-slate-100" /></label>
        <label className="text-xs text-slate-400">Lots
          <input type="number" min={1} value={lots} onChange={e => setLots(+e.target.value)} className="block mt-1 w-16 bg-slate-900 border border-slate-700 rounded px-2 py-1 text-sm text-slate-100" /></label>
        <label className="text-xs text-slate-400">Risk ₹
          <input type="number" min={500} step={500} value={risk} onChange={e => setRisk(+e.target.value)} className="block mt-1 w-24 bg-slate-900 border border-slate-700 rounded px-2 py-1 text-sm text-slate-100" /></label>
        <label className="text-xs text-slate-400">Target ₹
          <input type="number" min={500} step={500} value={target} onChange={e => setTarget(+e.target.value)} className="block mt-1 w-24 bg-slate-900 border border-slate-700 rounded px-2 py-1 text-sm text-slate-100" /></label>
        <button onClick={run} disabled={busy} className="px-4 py-2 rounded-lg text-sm font-semibold bg-blue-600 hover:bg-blue-500 text-white disabled:opacity-50">{busy ? 'Running…' : 'Run Backtest'}</button>
      </div>
      {err && <p className="text-red-400 text-xs mt-2">⚠ {err}</p>}
      {res && (
        <div className="mt-4">
          <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-5 gap-3">
            {cards.map(([k, v, c]) => (
              <div key={k} className="bg-slate-800/60 rounded-lg p-2 border border-slate-700/40">
                <p className="text-slate-500 text-[10px]">{k}</p>
                <p className={`text-sm font-bold ${c}`}>{v}</p>
              </div>
            ))}
          </div>
          <p className="text-[10px] text-slate-500 mt-2">{res.pricing_note}</p>
          <p className="text-[10px] text-amber-400/80 mt-1">Simulated (Black-Scholes premiums, no costs/slippage). Past performance ≠ future results.</p>

          {/* Trade-by-trade log: every entry/exit the challenge would have taken */}
          {res.trades?.length > 0 && (
            <div className="mt-4 bg-slate-800/60 rounded-xl border border-slate-700/50 overflow-hidden">
              <div className="px-4 py-2 border-b border-slate-700/50 flex items-center justify-between">
                <h4 className="text-xs font-semibold text-slate-200">Trades it would have taken</h4>
                <span className="text-[10px] text-slate-500">{res.trades.length} trades</span>
              </div>
              <div className="overflow-x-auto max-h-96 overflow-y-auto">
                <table className="w-full text-xs">
                  <thead className="sticky top-0 bg-slate-800/95">
                    <tr className="text-slate-400 border-b border-slate-700/40">
                      <th className="text-left px-3 py-2">#</th>
                      <th className="text-left px-3 py-2 whitespace-nowrap">Entry</th>
                      <th className="text-left px-3 py-2 whitespace-nowrap">Exit</th>
                      <th className="text-left px-2 py-2">Contract</th>
                      <th className="text-left px-2 py-2">Dir</th>
                      <th className="text-right px-2 py-2">Conf</th>
                      <th className="text-right px-2 py-2">DTE</th>
                      <th className="text-right px-2 py-2">Entry₹</th>
                      <th className="text-right px-2 py-2">Exit₹</th>
                      <th className="text-left px-2 py-2">Reason</th>
                      <th className="text-right px-3 py-2">P&L</th>
                    </tr>
                  </thead>
                  <tbody>
                    {res.trades.map((t: any, i: number) => (
                      <tr key={i} className={`border-b border-slate-700/15 hover:bg-slate-700/20 ${t.pnl >= 0 ? '' : 'bg-red-500/5'}`}>
                        <td className="px-3 py-1.5 text-slate-500">{i + 1}</td>
                        <td className="px-3 py-1.5 text-slate-400 font-mono whitespace-nowrap">
                          {new Date(t.entry_time).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
                        </td>
                        <td className="px-3 py-1.5 text-slate-400 font-mono whitespace-nowrap">
                          {t.exit_time ? new Date(t.exit_time).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—'}
                        </td>
                        <td className="px-2 py-1.5 font-mono text-slate-200 whitespace-nowrap">{t.strike?.toFixed(0)} {t.option_type}</td>
                        <td className={`px-2 py-1.5 ${t.direction === 'BULLISH' ? 'text-emerald-400' : t.direction === 'BEARISH' ? 'text-red-400' : 'text-slate-400'}`}>{t.direction}</td>
                        <td className="px-2 py-1.5 text-right text-slate-400">{t.confidence}%</td>
                        <td className="px-2 py-1.5 text-right text-slate-400">{t.dte}d</td>
                        <td className="px-2 py-1.5 text-right font-mono text-slate-200">₹{t.entry_premium?.toFixed(1)}</td>
                        <td className="px-2 py-1.5 text-right font-mono text-slate-300">₹{t.exit_premium?.toFixed(1)}</td>
                        <td className="px-2 py-1.5 text-slate-500 whitespace-nowrap">{t.exit_reason}</td>
                        <td className={`px-3 py-1.5 text-right font-bold ${pc(t.pnl)}`}>{sgn(t.pnl)}₹{fmt(t.pnl)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ─── Live trading panel ───────────────────────────────────────────────────────

function LiveTradingPanel({ status, onChange }: { status: ChallengeStatus; onChange: () => void }) {
  const [enabled, setEnabled] = useState(!!status.live_enabled)
  const [target, setTarget] = useState<number>(status.live_profit_target || 2000)
  const [maxLots, setMaxLots] = useState<number>(status.live_max_lots || 0)
  const [minProfit, setMinProfit] = useState<number>(status.live_min_profit || 0)
  const [winStart, setWinStart] = useState<string>(status.live_window_start || '')
  const [winEnd, setWinEnd] = useState<string>(status.live_window_end || '')
  const [holdConf, setHoldConf] = useState<number>(status.live_hold_confidence || 70)
  const [rr, setRr] = useState<number>(status.live_rr || 0)
  const [maxDailyLoss, setMaxDailyLoss] = useState<number>(status.live_max_daily_loss || 0)
  const [maxConsec, setMaxConsec] = useState<number>(status.live_max_consec_losses || 0)
  const [dailyRiskCap, setDailyRiskCap] = useState<number>(status.live_daily_risk_capital || 0)
  const [maxEntries, setMaxEntries] = useState<number>(status.live_max_entries_per_day || 3)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')

  useEffect(() => {
    setEnabled(!!status.live_enabled)
    if (status.live_profit_target) setTarget(status.live_profit_target)
    if (status.live_max_lots != null) setMaxLots(status.live_max_lots)
    if (status.live_min_profit != null) setMinProfit(status.live_min_profit)
    if (status.live_window_start != null) setWinStart(status.live_window_start)
    if (status.live_window_end != null) setWinEnd(status.live_window_end)
    if (status.live_hold_confidence) setHoldConf(status.live_hold_confidence)
    if (status.live_rr != null) setRr(status.live_rr)
    if (status.live_max_daily_loss != null) setMaxDailyLoss(status.live_max_daily_loss)
    if (status.live_max_consec_losses != null) setMaxConsec(status.live_max_consec_losses)
    if (status.live_daily_risk_capital != null) setDailyRiskCap(status.live_daily_risk_capital)
    if (status.live_max_entries_per_day != null) setMaxEntries(status.live_max_entries_per_day || 3)
  }, [status.live_enabled, status.live_profit_target, status.live_max_lots, status.live_min_profit, status.live_window_start, status.live_window_end, status.live_hold_confidence, status.live_rr, status.live_max_daily_loss, status.live_max_consec_losses, status.live_daily_risk_capital, status.live_max_entries_per_day])

  const allowed = !!status.live_allowed

  const save = async (nextEnabled: boolean) => {
    setBusy(true); setMsg('')
    try {
      const r = await postWithTimeout('/api/naren/v1/challenge/live-config', {
        enabled: nextEnabled,
        profit_target: target,
        max_lots: maxLots,
        min_profit: minProfit,
        window_start: winStart,
        window_end: winEnd,
        hold_confidence: holdConf,
        rr: rr,
        max_daily_loss: maxDailyLoss,
        max_consec_losses: maxConsec,
        daily_risk_capital: dailyRiskCap,
        max_entries_per_day: maxEntries,
      })
      if (r?.error) { setMsg(r.error); setEnabled(!!status.live_enabled) }
      else onChange()
    } catch (e: any) {
      const msg = e?.name === 'AbortError' ? 'Request timed out — server may be busy' : (e?.message || 'Request failed')
      setMsg(msg); setEnabled(!!status.live_enabled)
    } finally { setBusy(false) }
  }

  return (
    <div className={`rounded-2xl p-4 border ${status.live_enabled ? 'bg-red-500/10 border-red-500/50' : 'bg-slate-800/40 border-slate-700/60'}`}>
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h3 className="text-sm font-semibold text-slate-100">
            {status.live_enabled ? '🔴 LIVE TRADING — REAL ORDERS ON ZERODHA' : '🟢 Live Trading — off (paper only)'}
          </h3>
          <p className="text-xs text-slate-400 mt-0.5">
            When ON, every challenge entry and exit is sent as a real MIS market order to your Zerodha account.
          </p>
        </div>
        <div className="flex items-end gap-3 flex-wrap">
          <label className="text-xs text-slate-400">Profit square-off (₹ / position)
            <input type="number" min={0} step={500} value={target}
              onChange={e => setTarget(Math.max(0, +e.target.value))}
              className="block mt-1 w-36 bg-slate-900 border border-slate-700 rounded px-2 py-1 text-sm text-slate-100" />
          </label>
          <label className="text-xs text-slate-400">Min profit floor (₹)
            <input type="number" min={0} step={500} value={minProfit}
              onChange={e => setMinProfit(Math.max(0, +e.target.value))}
              title="Live profit exits are suppressed until P&L reaches this amount. 0 = no floor."
              className="block mt-1 w-28 bg-slate-900 border border-slate-700 rounded px-2 py-1 text-sm text-slate-100" />
          </label>
          <label className="text-xs text-slate-400">Max lots (live)
            <input type="number" min={0} step={1} value={maxLots}
              onChange={e => setMaxLots(Math.max(0, Math.floor(+e.target.value)))}
              title="Caps the lots sent on real orders. 0 = no cap (use the challenge's configured lots)."
              className="block mt-1 w-24 bg-slate-900 border border-slate-700 rounded px-2 py-1 text-sm text-slate-100" />
          </label>
          <label className="text-xs text-slate-400">Window start
            <input type="time" value={winStart}
              onChange={e => setWinStart(e.target.value)}
              title="Earliest time (IST) a live entry may open. Blank = no limit."
              className="block mt-1 w-28 bg-slate-900 border border-slate-700 rounded px-2 py-1 text-sm text-slate-100" />
          </label>
          <label className="text-xs text-slate-400">Window end
            <input type="time" value={winEnd}
              onChange={e => setWinEnd(e.target.value)}
              title="Latest time (IST) a live entry may open. Blank = no limit."
              className="block mt-1 w-28 bg-slate-900 border border-slate-700 rounded px-2 py-1 text-sm text-slate-100" />
          </label>
          <label className="text-xs text-slate-400">Hold if conf ≥ (%)
            <input type="number" min={0} max={100} step={1} value={holdConf}
              onChange={e => setHoldConf(Math.min(100, Math.max(0, Math.floor(+e.target.value))))}
              title="Above the profit floor, keep riding while signal confidence stays at/above this. Below it, book the profit."
              className="block mt-1 w-24 bg-slate-900 border border-slate-700 rounded px-2 py-1 text-sm text-slate-100" />
          </label>
          <label className="text-xs text-slate-400">Risk:Reward (RR)
            <input type="number" min={0} step={0.5} value={rr}
              onChange={e => setRr(Math.max(0, +e.target.value))}
              title="Live profit target = Risk × RR. 0 = use the ₹ profit square-off / challenge target."
              className="block mt-1 w-24 bg-slate-900 border border-slate-700 rounded px-2 py-1 text-sm text-slate-100" />
          </label>
          <label className="text-xs text-slate-400">Max loss / day (₹)
            <input type="number" min={0} step={1000} value={maxDailyLoss}
              onChange={e => setMaxDailyLoss(Math.max(0, +e.target.value))}
              title="Once the day's realized LIVE loss reaches this, no more live trades today. 0 = no limit."
              className="block mt-1 w-28 bg-slate-900 border border-slate-700 rounded px-2 py-1 text-sm text-slate-100" />
          </label>
          <label className="text-xs text-slate-400">Max B2B losses / day
            <input type="number" min={0} step={1} value={maxConsec}
              onChange={e => setMaxConsec(Math.max(0, Math.floor(+e.target.value)))}
              title="Stop live trades after this many back-to-back losing trades in a day. 0 = no limit."
              className="block mt-1 w-24 bg-slate-900 border border-slate-700 rounded px-2 py-1 text-sm text-slate-100" />
          </label>
          <label className="text-xs text-slate-400">Max entries / day
            <input type="number" min={1} step={1} value={maxEntries}
              onChange={e => setMaxEntries(Math.max(1, Math.floor(+e.target.value)))}
              title="Maximum number of entries allowed per calendar day. Default is 3."
              className="block mt-1 w-24 bg-slate-900 border border-slate-700 rounded px-2 py-1 text-sm text-slate-100" />
          </label>
          <label className="text-xs text-slate-400">Risk capital / day (₹)
            <input type="number" min={0} step={1000} value={dailyRiskCap}
              onChange={e => setDailyRiskCap(Math.max(0, +e.target.value))}
              title="Day's live risk budget. Stops once (live trades today × risk/trade) reaches this. 0 = no limit."
              className="block mt-1 w-28 bg-slate-900 border border-slate-700 rounded px-2 py-1 text-sm text-slate-100" />
          </label>
          <button disabled={!allowed || busy} onClick={() => { const n = !enabled; setEnabled(n); save(n) }}
            className={`px-4 py-2 rounded-lg text-sm font-semibold transition-colors disabled:opacity-50 ${status.live_enabled ? 'bg-red-600 hover:bg-red-500 text-white' : 'bg-emerald-600 hover:bg-emerald-500 text-white'}`}>
            {busy ? '…' : status.live_enabled ? 'Turn LIVE off' : 'Go LIVE'}
          </button>
          {status.live_enabled && (
            <button disabled={busy} onClick={() => save(true)}
              className="px-3 py-2 rounded-lg text-sm bg-slate-700 hover:bg-slate-600 text-slate-200">Update ₹</button>
          )}
        </div>
      </div>
      {!allowed && (
        <p className="text-[11px] text-amber-300 mt-2">
          Live trading is locked by the server. Set <code className="text-amber-200">kite.live_trading_enabled: true</code> in <code className="text-amber-200">config.naren.yaml</code> and restart to allow it.
        </p>
      )}
      {status.live_enabled && (
        <p className="text-[11px] text-red-300 mt-2 font-medium">
          ⚠ Real money. Orders fire automatically with no confirmation. The open position is squared off on Zerodha as soon as its P&L reaches ₹{target.toLocaleString('en-IN')}. Live resets to OFF if the server restarts.
        </p>
      )}
      {msg && <p className="text-[11px] text-red-400 mt-2">{msg}</p>}
    </div>
  )
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function ChallengeDashboard() {
  const [status,  setStatus]  = useState<ChallengeStatus | null>(null)
  const [trades,  setTrades]  = useState<ChallengeTrade[]>([])
  const [days,    setDays]    = useState<ChallengeDay[]>([])
  const [expiries, setExpiries] = useState<any[]>([])
  const [tab,     setTab]     = useState<'live' | 'trades' | 'daily' | 'expiry'>('live')
  const [error,   setError]   = useState('')
  const [enterErr, setEnterErr] = useState('')
  const [live,    setLive]    = useState<LiveSnap | null>(null)

  const loadAll = useCallback(async () => {
    try {
      const [s, t, d, e] = await Promise.all([
        fetch('/api/naren/v1/challenge/status').then(r => r.json()),
        fetch('/api/naren/v1/challenge/trades?limit=500').then(r => r.json()),
        fetch('/api/naren/v1/challenge/daily').then(r => r.json()),
        fetch('/api/naren/v1/challenge/expiry-breakdown').then(r => r.json()),
      ])
      // Reflect the latest backend error, and clear it once it resolves
      // (e.g. after the shared Zerodha token reconnects Kite).
      setError(s.last_error || '')
      setStatus(s); setTrades(t); setDays(d); setExpiries(e)
    } catch { setError('Could not reach backend') }
  }, [])

  useEffect(() => { loadAll() }, [loadAll])
  useEffect(() => {
    if (!status?.active) return
    const id = setInterval(loadAll, 15000)
    return () => clearInterval(id)
  }, [status?.active, loadAll])

  // Live price/P&L via SSE (backend pushes the Kite-WebSocket-driven snapshot
  // every ~2s). EventSource auto-reconnects on drop. Tables still refresh on the
  // 15s poll above; this just keeps the open position's price and P&L live.
  useEffect(() => {
    if (!status?.active) { setLive(null); return }
    const es = new EventSource('/api/naren/v1/live/stream')
    es.onmessage = (e) => { try { setLive(JSON.parse(e.data)) } catch { /* ignore */ } }
    return () => es.close()
  }, [status?.active])

  const onExit = async () => {
    await post('/api/naren/v1/challenge/exit')
    loadAll()
  }

  const openTrade = useMemo(
    () => trades.find(t => t.status === 'OPEN') ?? undefined,
    [trades]
  )

  // Merge the live SSE snapshot over the polled status so the headline P&L and
  // stats update every ~2s instead of only on the 15s reload.
  const dispStatus = useMemo(() => {
    if (!status || !live) return status
    const tp = live.total_pnl ?? status.total_pnl
    const op = live.open_option?.pnl ?? status.open_pnl ?? 0
    const initial = status.active?.initial_capital
    return {
      ...status,
      total_pnl: tp,
      today_pnl: live.today_pnl ?? status.today_pnl,
      open_pnl:  op,
      // Live mark-to-market equity = initial + realized + open, so the capital
      // growth curve and stats move with every tick.
      current_capital: initial != null ? initial + tp + op : status.current_capital,
    }
  }, [status, live])

  return (
    <div className="max-w-7xl mx-auto px-4 py-6 space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-100">🏆 90-Day Challenge</h1>
          <p className="text-slate-400 text-sm mt-0.5">
            Paper trading · Real Kite LTP · PCR-filtered signals · All trades recorded in PostgreSQL
          </p>
        </div>
        {status?.active && (
          <div className="flex items-center gap-2">
            <button onClick={loadAll} className="px-3 py-1.5 bg-slate-700 hover:bg-slate-600 text-slate-300 text-sm rounded-lg transition-colors">↻ Refresh</button>
            <button onClick={() => post('/api/naren/v1/challenge/snapshot').then(loadAll)}
              className="px-3 py-1.5 bg-slate-700 hover:bg-slate-600 text-slate-300 text-sm rounded-lg transition-colors">Write Snapshot</button>
          </div>
        )}
      </div>

      {error && (
        <div className="bg-yellow-500/10 border border-yellow-500/30 rounded-xl px-4 py-2 text-yellow-300 text-xs">⚠ {error}</div>
      )}

      {/* Live trading controls */}
      {status?.active && <LiveTradingPanel status={status} onChange={loadAll} />}

      {/* No active challenge */}
      {status && !status.active && (
        <StartForm onStart={loadAll} />
      )}

      {/* Active challenge */}
      {status?.active && (
        <>
          <Countdown status={dispStatus || status} />
          <StatsRow s={dispStatus || status} />
          <BacktestPanel />

          {/* Open position */}
          {openTrade && (
            <OpenPosition t={openTrade}
              pnl={live?.open_option?.pnl ?? status.open_pnl}
              pnlPct={live?.open_option?.pnl_pct}
              current={live?.open_option?.current_premium}
              liveOn={!!live?.ticker_live}
              snap={live?.open_option}
              onExit={onExit} />
          )}

          {/* Tab nav */}
          <div className="flex gap-1 bg-slate-800/60 rounded-xl p-1 w-fit border border-slate-700/50">
            {([
              ['live',   '📡 Live',   ''],
              ['trades', '📋 Trades', `${trades.filter(t=>t.status==='CLOSED').length}`],
              ['daily',  '📅 Daily',  `${days.length}d`],
              ['expiry', '🗂 Expiry', `${expiries.length}`],
            ] as const).map(([key, label, badge]) => (
              <button key={key} onClick={() => setTab(key as any)}
                className={`flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-sm font-medium transition-colors
                  ${tab === key ? 'bg-blue-600 text-white' : 'text-slate-400 hover:text-slate-200 hover:bg-slate-700/60'}`}>
                {label}
                {badge && <span className="text-[10px] bg-slate-600 text-slate-300 px-1.5 py-0.5 rounded-full">{badge}</span>}
              </button>
            ))}
          </div>

          {tab === 'live' && (
            <div className="space-y-5">
              {/* Current signal */}
              {status.last_signal && (
                <div className="bg-slate-800/70 rounded-xl border border-slate-700/50 p-5">
                  <p className="text-xs text-slate-400 mb-2">Latest Signal (Nifty 5m + PCR + IV)</p>
                  <div className="flex items-center gap-3 flex-wrap">
                    <span className="text-lg font-bold text-slate-100">{STRAT_SHORT[status.last_signal.strategy] || status.last_signal.strategy}</span>
                    <span className={`text-xs px-2 py-1 rounded font-bold ${status.last_signal.direction==='BULLISH'?'bg-emerald-500/20 text-emerald-300':status.last_signal.direction==='BEARISH'?'bg-red-500/20 text-red-300':'bg-slate-700 text-slate-300'}`}>
                      {status.last_signal.direction}
                    </span>
                    <span className="text-xs text-slate-400">Confidence: <strong className={status.last_signal.confidence>=65?'text-emerald-400':status.last_signal.confidence>=50?'text-yellow-400':'text-red-400'}>{status.last_signal.confidence}%</strong></span>
                    {status.last_chain && (
                      <span className="text-xs text-slate-400">PCR: <strong className="text-slate-200">{status.last_chain.PCR?.toFixed(3)}</strong></span>
                    )}
                  </div>
                  {status.last_signal.reasoning?.map((r, i) => (
                    <p key={i} className="text-xs text-slate-400 flex gap-2 mt-1"><span className="text-blue-400">›</span>{r}</p>
                  ))}
                  {!openTrade && status.last_signal.strategy !== 'NO_TRADE' && (
                    <div className="mt-3 flex items-center gap-3 flex-wrap">
                      <button onClick={async () => {
                        setEnterErr('')
                        const r = await post('/api/naren/v1/challenge/enter')
                        if (r?.error) setEnterErr(r.error)
                        else loadAll()
                      }}
                        className="px-5 py-1.5 bg-blue-600 hover:bg-blue-500 text-white text-sm rounded-lg font-medium transition-colors">
                        Enter Trade Manually
                      </button>
                      {enterErr && <span className="text-red-400 text-xs">⚠ {enterErr}</span>}
                    </div>
                  )}
                </div>
              )}
              <ChainPanel chain={status.last_chain} />
              <EquityCurve days={days} initial={status.active.initial_capital} current={(dispStatus || status).current_capital} />
            </div>
          )}

          {tab === 'trades' && <TradeLog trades={trades} />}
          {tab === 'daily' && <div className="space-y-5"><DailyTable days={days} /><EquityCurve days={days} initial={status.active.initial_capital} current={(dispStatus || status).current_capital} /></div>}
          {tab === 'expiry' && <ExpiryBreakdown data={expiries} />}
        </>
      )}
    </div>
  )
}
