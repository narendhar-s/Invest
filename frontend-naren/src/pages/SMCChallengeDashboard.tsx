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
  live_daily_target_profit?: number
  live_trail_sl?: number
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

function post(url: string, body?: unknown) {
  return fetch(url, { method:'POST', headers:{'Content-Type':'application/json'}, body: body ? JSON.stringify(body) : undefined }).then(r => r.json())
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

function OpenPosition({ t, pnl, onExit }: { t: ChallengeTrade; pnl: number; onExit: () => void }) {
  const risk = t.qty * (t.entry_premium - (t.entry_premium - (t.entry_premium * 0.33)))
  return (
    <div className={`rounded-xl border p-5 ${bgpc(pnl)}`}>
      <div className="flex items-start justify-between mb-3">
        <div>
          <p className="text-xs text-slate-400 mb-1">Open Position — Day {t.day_number}</p>
          <p className="text-xl font-bold text-slate-100">{t.trading_symbol}</p>
          <p className="text-sm text-slate-400">
            Expiry: <span className="text-emerald-300">{t.expiry}</span> · DTE at entry: {t.dte}d · {t.qty} qty ({t.lots} lots)
          </p>
        </div>
        <div className="text-right">
          <p className={`text-3xl font-bold ${pc(pnl)}`}>{sgn(pnl)}₹{fmt(pnl)}</p>
          <button onClick={onExit}
            className="mt-1 px-4 py-1.5 bg-red-600/80 hover:bg-red-600 text-white text-xs font-semibold rounded-lg transition-colors">
            Square Off
          </button>
        </div>
      </div>
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
        <div className="mt-3 bg-slate-800/40 rounded-lg p-3">
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

function EquityCurve({ days, initial }: { days: ChallengeDay[]; initial: number }) {
  if (days.length < 2) return (
    <div className="bg-slate-800/60 rounded-xl border border-slate-700/50 p-8 text-center text-slate-400 text-sm">
      Equity curve will appear after the first trading day.
    </div>
  )
  const w = 900, h = 200, padX = 8, padY = 12
  const vals = [initial, ...days.map(d => d.closing_balance)]
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
                  <td className="px-3 py-2 font-mono text-slate-100 font-semibold">{t.trading_symbol}</td>
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
                    {t.status === 'OPEN' ? 'LIVE' : `${sgn(t.pnl)}₹${fmt(t.pnl)}`}
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
      const r = await post('/api/naren/v1/smc-challenge/start', { lots, risk_per_trade: risk, target_per_trade: target, notes })
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
        <h2 className="text-xl font-bold text-slate-100">Start Your 90-Day SMC Challenge</h2>
        <p className="text-slate-400 text-sm mt-1">Pure paper trading · Real Kite signals · SMC + FVG + VWAP confluence · Track every trade</p>
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
        <span className="text-slate-400 text-xs">90 days · real Kite LTP at fill · 5m entry / 15m HTF</span>
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
        {loading ? 'Starting…' : '🚀 Start 90-Day SMC Challenge'}
      </button>
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
  const [dailyTarget, setDailyTarget] = useState<number>(status.live_daily_target_profit || 0)
  const [trailSL, setTrailSL] = useState<number>(status.live_trail_sl || 0)
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
    if (status.live_daily_target_profit != null) setDailyTarget(status.live_daily_target_profit)
    if (status.live_trail_sl != null) setTrailSL(status.live_trail_sl)
  }, [status.live_enabled, status.live_profit_target, status.live_max_lots, status.live_min_profit, status.live_window_start, status.live_window_end, status.live_hold_confidence, status.live_rr, status.live_max_daily_loss, status.live_max_consec_losses, status.live_daily_target_profit, status.live_trail_sl])

  const allowed = !!status.live_allowed

  const save = async (nextEnabled: boolean) => {
    setBusy(true); setMsg('')
    try {
      const r = await post('/api/naren/v1/smc-challenge/live-config', {
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
        daily_target_profit: dailyTarget,
        trail_sl: trailSL,
      })
      if (r?.error) { setMsg(r.error); setEnabled(!!status.live_enabled) }
      else onChange()
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
          <label className="text-xs text-slate-400">Daily target profit (₹)
            <input type="number" min={0} step={1000} value={dailyTarget}
              onChange={e => setDailyTarget(Math.max(0, +e.target.value))}
              title="Once the day's realized LIVE profit reaches this, no more live trades today. 0 = no target."
              className="block mt-1 w-28 bg-slate-900 border border-slate-700 rounded px-2 py-1 text-sm text-slate-100" />
          </label>
          <label className="text-xs text-slate-400">Trailing SL (₹)
            <input type="number" min={0} step={500} value={trailSL}
              onChange={e => setTrailSL(Math.max(0, +e.target.value))}
              title="Trailing stop: exit the live position when its P&L falls this far from its peak. 0 = off."
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

// ─── Backtest panel ─────────────────────────────────────────────────────────

interface SMCBtTrade {
  entry_time: string; exit_time: string; direction: string; option_type: string
  strike: number; entry_spot: number; exit_spot: number
  entry_premium: number; exit_premium: number; pnl: number; confidence: number; reason: string
}
interface SMCBtResult {
  days: number; lots: number; rr: number; trades: number; wins: number; losses: number
  win_rate: number; total_pnl: number; avg_pnl: number; max_drawdown: number
  profit_factor: number; equity: number[]; trade_list: SMCBtTrade[]; summary: string
}

function BacktestEquity({ equity }: { equity: number[] }) {
  if (!equity?.length) return null
  const w = 720, h = 120, pad = 4
  const min = Math.min(0, ...equity), max = Math.max(0, ...equity)
  const range = max - min || 1
  const x = (i: number) => pad + (i / Math.max(1, equity.length - 1)) * (w - 2 * pad)
  const y = (v: number) => h - pad - ((v - min) / range) * (h - 2 * pad)
  const pts = equity.map((v, i) => `${x(i)},${y(v)}`).join(' ')
  const zeroY = y(0)
  const up = equity[equity.length - 1] >= 0
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full h-28">
      <line x1={pad} y1={zeroY} x2={w - pad} y2={zeroY} stroke="#475569" strokeWidth="0.5" strokeDasharray="3 3" />
      <polyline points={pts} fill="none" stroke={up ? '#34d399' : '#f87171'} strokeWidth="1.5" />
    </svg>
  )
}

function BacktestPanel() {
  const [days, setDays] = useState(15)
  const [lots, setLots] = useState(2)
  const [rr, setRr] = useState(3)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [res, setRes] = useState<SMCBtResult | null>(null)

  const run = async () => {
    setBusy(true); setErr(''); setRes(null)
    try {
      const r = await post('/api/naren/v1/kite/smc-backtest', { days, lots, rr })
      if (r?.error) setErr(r.error)
      else setRes(r as SMCBtResult)
    } catch (e: any) {
      setErr(e?.message || 'Backtest request failed')
    } finally { setBusy(false) }
  }

  const fmt = (n: number) => (n ?? 0).toLocaleString('en-IN', { maximumFractionDigits: 0 })

  return (
    <div className="space-y-5">
      <div className="bg-slate-800/70 rounded-xl border border-slate-700/50 p-5">
        <h3 className="text-sm font-semibold text-slate-200 mb-1">Backtest — SMC + FVG + VWAP</h3>
        <p className="text-xs text-slate-400 mb-4">
          Replays the exact live signal pipeline (5-min entries on a 15-min HTF context) over recent
          NIFTY history with Black-Scholes-priced ATM weekly options. Entries fill at the next bar's open.
        </p>
        <div className="flex items-end gap-3 flex-wrap">
          <label className="text-xs text-slate-400">Days (history)
            <input type="number" min={1} max={60} value={days}
              onChange={e => setDays(Math.min(60, Math.max(1, Math.floor(+e.target.value))))}
              title="Calendar days of 5-min NIFTY history to replay (max 60)."
              className="block mt-1 w-24 bg-slate-900 border border-slate-700 rounded px-2 py-1 text-sm text-slate-100" />
          </label>
          <label className="text-xs text-slate-400">Lots
            <input type="number" min={1} step={1} value={lots}
              onChange={e => setLots(Math.max(1, Math.floor(+e.target.value)))}
              className="block mt-1 w-20 bg-slate-900 border border-slate-700 rounded px-2 py-1 text-sm text-slate-100" />
          </label>
          <label className="text-xs text-slate-400">R:R (target ÷ stop)
            <input type="number" min={0.5} step={0.5} value={rr}
              onChange={e => setRr(Math.max(0.5, +e.target.value))}
              title="Spot reward-to-risk. Default 3.0 = 1.8×ATR target ÷ 0.6×ATR stop."
              className="block mt-1 w-24 bg-slate-900 border border-slate-700 rounded px-2 py-1 text-sm text-slate-100" />
          </label>
          <button disabled={busy} onClick={run}
            className="px-5 py-2 rounded-lg text-sm font-semibold bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white transition-colors">
            {busy ? 'Running…' : '▶ Run Backtest'}
          </button>
        </div>
        {err && <p className="text-xs text-red-400 mt-3">{err}</p>}
      </div>

      {res && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {([
              ['Net P&L', `₹${fmt(res.total_pnl)}`, res.total_pnl >= 0 ? 'text-emerald-400' : 'text-red-400'],
              ['Win Rate', `${res.win_rate}%`, res.win_rate >= 50 ? 'text-emerald-400' : 'text-yellow-400'],
              ['Trades', `${res.trades}`, 'text-slate-100'],
              ['Profit Factor', `${res.profit_factor}`, res.profit_factor >= 1.5 ? 'text-emerald-400' : 'text-yellow-400'],
              ['Wins / Losses', `${res.wins} / ${res.losses}`, 'text-slate-100'],
              ['Avg / Trade', `₹${fmt(res.avg_pnl)}`, res.avg_pnl >= 0 ? 'text-emerald-400' : 'text-red-400'],
              ['Max Drawdown', `₹${fmt(res.max_drawdown)}`, 'text-red-400'],
              ['Window', `${res.days}d · ${res.lots} lot · RR ${res.rr}`, 'text-slate-300'],
            ] as const).map(([label, val, cls]) => (
              <div key={label} className="bg-slate-800/70 rounded-xl border border-slate-700/50 px-4 py-3">
                <p className="text-[11px] text-slate-400">{label}</p>
                <p className={`text-lg font-bold ${cls}`}>{val}</p>
              </div>
            ))}
          </div>

          {res.summary && <p className="text-xs text-slate-400">{res.summary}</p>}

          {res.equity?.length > 0 && (
            <div className="bg-slate-800/70 rounded-xl border border-slate-700/50 p-4">
              <p className="text-xs text-slate-400 mb-1">Equity Curve (cumulative ₹ P&L)</p>
              <BacktestEquity equity={res.equity} />
            </div>
          )}

          {res.trade_list?.length > 0 && (
            <div className="bg-slate-800/70 rounded-xl border border-slate-700/50 overflow-hidden">
              <div className="px-5 py-3 border-b border-slate-700/50">
                <h3 className="text-sm font-semibold text-slate-200">Trades ({res.trade_list.length})</h3>
              </div>
              <div className="overflow-x-auto max-h-[28rem]">
                <table className="w-full text-xs">
                  <thead className="sticky top-0 bg-slate-800">
                    <tr className="text-slate-400 border-b border-slate-700/40">
                      <th className="text-left px-3 py-2">Entry</th>
                      <th className="text-left px-2 py-2">Dir</th>
                      <th className="text-right px-2 py-2">Strike</th>
                      <th className="text-right px-2 py-2">Entry₹</th>
                      <th className="text-right px-2 py-2">Exit₹</th>
                      <th className="text-right px-2 py-2">Conf</th>
                      <th className="text-left px-2 py-2">Reason</th>
                      <th className="text-right px-3 py-2">P&L</th>
                    </tr>
                  </thead>
                  <tbody>
                    {res.trade_list.slice().reverse().map((t, i) => (
                      <tr key={i} className="border-b border-slate-800/60">
                        <td className="px-3 py-1.5 text-slate-300 whitespace-nowrap">{new Date(t.entry_time).toLocaleString('en-IN', { day:'2-digit', month:'short', hour:'2-digit', minute:'2-digit' })}</td>
                        <td className="px-2 py-1.5"><span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${t.option_type==='CE'?'bg-emerald-500/20 text-emerald-300':'bg-red-500/20 text-red-300'}`}>{t.option_type}</span></td>
                        <td className="px-2 py-1.5 text-right text-slate-300">{t.strike}</td>
                        <td className="px-2 py-1.5 text-right text-slate-300">{t.entry_premium}</td>
                        <td className="px-2 py-1.5 text-right text-slate-300">{t.exit_premium}</td>
                        <td className="px-2 py-1.5 text-right text-slate-400">{t.confidence}%</td>
                        <td className="px-2 py-1.5 text-slate-400">{t.reason}</td>
                        <td className={`px-3 py-1.5 text-right font-semibold ${t.pnl>=0?'text-emerald-400':'text-red-400'}`}>₹{fmt(t.pnl)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function SMCChallengeDashboard() {
  const [status,  setStatus]  = useState<ChallengeStatus | null>(null)
  const [trades,  setTrades]  = useState<ChallengeTrade[]>([])
  const [days,    setDays]    = useState<ChallengeDay[]>([])
  const [expiries, setExpiries] = useState<any[]>([])
  const [tab,     setTab]     = useState<'live' | 'trades' | 'daily' | 'expiry' | 'backtest'>('live')
  const [error,   setError]   = useState('')

  const loadAll = useCallback(async () => {
    try {
      const [s, t, d, e] = await Promise.all([
        fetch('/api/naren/v1/smc-challenge/status').then(r => r.json()),
        fetch('/api/naren/v1/smc-challenge/trades?limit=500').then(r => r.json()),
        fetch('/api/naren/v1/smc-challenge/daily').then(r => r.json()),
        fetch('/api/naren/v1/smc-challenge/expiry-breakdown').then(r => r.json()),
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

  const onExit = async () => {
    await post('/api/naren/v1/smc-challenge/exit')
    loadAll()
  }

  const openTrade = useMemo(
    () => trades.find(t => t.status === 'OPEN') ?? undefined,
    [trades]
  )

  return (
    <div className="max-w-7xl mx-auto px-4 py-6 space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-100">🎯 90-Day SMC Challenge</h1>
          <p className="text-slate-400 text-sm mt-0.5">
            Paper trading · Real Kite LTP · PCR-filtered signals · All trades recorded in PostgreSQL
          </p>
        </div>
        {status?.active && (
          <div className="flex items-center gap-2">
            <button onClick={loadAll} className="px-3 py-1.5 bg-slate-700 hover:bg-slate-600 text-slate-300 text-sm rounded-lg transition-colors">↻ Refresh</button>
            <button onClick={() => post('/api/naren/v1/smc-challenge/snapshot').then(loadAll)}
              className="px-3 py-1.5 bg-slate-700 hover:bg-slate-600 text-slate-300 text-sm rounded-lg transition-colors">Write Snapshot</button>
          </div>
        )}
      </div>

      {error && (
        <div className="bg-yellow-500/10 border border-yellow-500/30 rounded-xl px-4 py-2 text-yellow-300 text-xs">⚠ {error}</div>
      )}

      {/* Live trading controls */}
      {status?.active && <LiveTradingPanel status={status} onChange={loadAll} />}

      {/* No active challenge — let users backtest the strategy before starting */}
      {status && !status.active && (
        <div className="space-y-6">
          <StartForm onStart={loadAll} />
          <div>
            <h3 className="text-sm font-semibold text-slate-300 mb-2">🧪 Backtest the strategy first</h3>
            <BacktestPanel />
          </div>
        </div>
      )}

      {/* Active challenge */}
      {status?.active && (
        <>
          <Countdown status={status} />
          <StatsRow s={status} />

          {/* Open position */}
          {openTrade && (
            <OpenPosition t={openTrade} pnl={status.open_pnl} onExit={onExit} />
          )}

          {/* Tab nav */}
          <div className="flex gap-1 bg-slate-800/60 rounded-xl p-1 w-fit border border-slate-700/50">
            {([
              ['live',   '📡 Live',   ''],
              ['trades', '📋 Trades', `${trades.filter(t=>t.status==='CLOSED').length}`],
              ['daily',  '📅 Daily',  `${days.length}d`],
              ['expiry', '🗂 Expiry', `${expiries.length}`],
              ['backtest', '🧪 Backtest', ''],
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
                  <p className="text-xs text-slate-400 mb-2">Latest Signal (Nifty 5m → 15m HTF · SMC + FVG + VWAP)</p>
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
                    <button onClick={() => post('/api/naren/v1/smc-challenge/enter').then(loadAll)}
                      className="mt-3 px-5 py-1.5 bg-blue-600 hover:bg-blue-500 text-white text-sm rounded-lg font-medium transition-colors">
                      Enter Trade Manually
                    </button>
                  )}
                </div>
              )}
              <ChainPanel chain={status.last_chain} />
              <EquityCurve days={days} initial={status.active.initial_capital} />
            </div>
          )}

          {tab === 'trades' && <TradeLog trades={trades} />}
          {tab === 'daily' && <div className="space-y-5"><DailyTable days={days} /><EquityCurve days={days} initial={status.active.initial_capital} /></div>}
          {tab === 'expiry' && <ExpiryBreakdown data={expiries} />}
          {tab === 'backtest' && <BacktestPanel />}
        </>
      )}
    </div>
  )
}
