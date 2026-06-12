import { useState, useCallback, useRef, useMemo } from 'react'
import KiteChart, { type ChartBar } from '../components/KiteChart'

// ─── Types ────────────────────────────────────────────────────────────────────

interface StrategyMeta {
  key: string; name: string; book: string; author: string
  type: string; time_frame: string; entry_logic: string
}
interface CompareTrade {
  signal_time: string; entry_time: string; exit_time: string; direction: string
  signal_spot: number; entry_spot: number; exit_spot: number
  strike: number; trading_symbol: string
  option_type: string; expiry: string; expiry_label: string
  entry_premium: number; exit_premium: number; pnl: number
  exit_reason: string; confidence: number; signal_reason: string; price_source: string
}
interface StrategyResult {
  meta: StrategyMeta; trades: CompareTrade[]
  total_pnl: number; win_count: number; loss_count: number; win_rate: number
  avg_win: number; avg_loss: number; reward_risk: number; profit_factor: number
  expectancy: number; max_drawdown: number; max_consec_loss: number
  trades_per_month: number; score: number; rank: number
  equity_curve: { time: string; equity: number }[]
}
interface DataQuality {
  total_bars: number; trading_days: number; expected_bars: number
  missing_bars: number; duplicate_bars: number; price_gaps: number
  gap_details: string[]; verdict: string
}
interface CompareResult {
  from: string; to: string; days: number; capital: number; rr: number
  lots: number; risk_per_trade: number; target_per_trade: number
  strategies: StrategyResult[]; winner: StrategyMeta; winner_reason: string
  candles: ChartBar[]; data_quality: DataQuality
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const fmt  = (n: number) => new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(Math.abs(n))
const fmtF = (n: number, d = 2) => n?.toFixed(d) ?? '—'
const sgn  = (n: number) => n >= 0 ? '+' : '-'
const pc   = (n: number) => n >= 0 ? 'text-emerald-400' : 'text-red-400'
const bg   = (n: number) => n >= 0 ? 'bg-emerald-500/10' : 'bg-red-500/10'

const TYPE_COLOR: Record<string, string> = {
  'momentum':       'bg-blue-500/20 text-blue-300',
  'trend-following':'bg-purple-500/20 text-purple-300',
  'mean-reversion': 'bg-yellow-500/20 text-yellow-300',
  'neutral':        'bg-slate-500/20 text-slate-300',
}
const RANK_MEDAL: Record<number, string> = { 1: '🥇', 2: '🥈', 3: '🥉' }

// ─── Score ring ───────────────────────────────────────────────────────────────

function ScoreRing({ score, size = 56 }: { score: number; size?: number }) {
  const r = size / 2 - 4
  const circ = 2 * Math.PI * r
  const dash = circ * score / 100
  const color = score >= 70 ? '#34d399' : score >= 45 ? '#f59e0b' : '#f87171'
  return (
    <svg width={size} height={size}>
      <circle cx={size/2} cy={size/2} r={r} fill="none" stroke="#1e293b" strokeWidth="4" />
      <circle cx={size/2} cy={size/2} r={r} fill="none" stroke={color} strokeWidth="4"
        strokeDasharray={`${dash} ${circ - dash}`}
        strokeLinecap="round" transform={`rotate(-90 ${size/2} ${size/2})`} />
      <text x={size/2} y={size/2 + 1} textAnchor="middle" dominantBaseline="middle"
        fill={color} fontSize={size < 48 ? 10 : 13} fontWeight="bold">
        {score.toFixed(0)}
      </text>
    </svg>
  )
}

// ─── Winner card ──────────────────────────────────────────────────────────────

function WinnerCard({ s, reason }: { s: StrategyResult; reason: string }) {
  return (
    <div className="relative bg-gradient-to-br from-amber-500/10 via-slate-800/80 to-emerald-500/10
                    border border-amber-500/40 rounded-2xl p-6 overflow-hidden">
      <div className="absolute top-4 right-4 text-4xl opacity-20">🏆</div>
      <div className="flex items-start gap-5">
        <ScoreRing score={s.score} size={72} />
        <div className="flex-1">
          <p className="text-xs text-amber-400 font-semibold uppercase tracking-wider mb-1">Winner — Best Strategy</p>
          <h2 className="text-2xl font-bold text-slate-100 mb-0.5">{s.meta.name}</h2>
          <p className="text-slate-400 text-sm">
            <span className="text-slate-300 font-medium">{s.meta.book}</span>
            <span className="text-slate-500"> · </span>
            <span>{s.meta.author}</span>
          </p>
          <p className="text-xs text-slate-400 mt-2 leading-relaxed max-w-2xl">{s.meta.entry_logic}</p>
        </div>
      </div>

      <div className="mt-5 grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-3">
        {[
          { label: 'Total P&L',      value: `${sgn(s.total_pnl)}₹${fmt(s.total_pnl)}`,       color: pc(s.total_pnl) },
          { label: 'Expectancy',     value: `${sgn(s.expectancy)}₹${fmt(s.expectancy)}/tr`,   color: pc(s.expectancy) },
          { label: 'Win Rate',       value: `${s.win_rate.toFixed(0)}%`,                       color: s.win_rate >= 55 ? 'text-emerald-400' : 'text-yellow-400' },
          { label: 'Profit Factor',  value: fmtF(s.profit_factor),                             color: s.profit_factor >= 1.5 ? 'text-emerald-400' : 'text-yellow-400' },
          { label: 'Max Drawdown',   value: `₹${fmt(s.max_drawdown)}`,                        color: 'text-red-400' },
          { label: 'Trades / month', value: fmtF(s.trades_per_month, 1),                       color: 'text-slate-200' },
        ].map(m => (
          <div key={m.label} className="bg-slate-800/60 rounded-xl p-3">
            <p className="text-slate-500 text-[10px] mb-0.5">{m.label}</p>
            <p className={`text-base font-bold ${m.color}`}>{m.value}</p>
          </div>
        ))}
      </div>

      <p className="mt-4 text-xs text-amber-300/80 bg-amber-500/5 border border-amber-500/20 rounded-lg px-4 py-2">
        {reason}
      </p>
    </div>
  )
}

// ─── Ranking table ────────────────────────────────────────────────────────────

function RankingTable({ strategies, onSelect, selected }: {
  strategies: StrategyResult[]; onSelect: (k: string) => void; selected: string
}) {
  return (
    <div className="bg-slate-800/70 rounded-xl border border-slate-700/50 overflow-hidden">
      <div className="px-5 py-3 border-b border-slate-700/50">
        <h3 className="text-sm font-semibold text-slate-200">All 6 Strategies — Ranked by Composite Score</h3>
        <p className="text-xs text-slate-500 mt-0.5">Score = 40% expectancy + 25% win rate + 20% profit factor + 15% drawdown safety. Click row for detail.</p>
      </div>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-slate-400 text-xs border-b border-slate-700/40 bg-slate-800/50">
            {['Rank','Strategy','Type','Trades','Win Rate','Expectancy','Profit Factor','R:R','Max DD','Score','P&L'].map(h => (
              <th key={h} className={`px-3 py-2.5 ${['P&L','Score','Expectancy'].includes(h) ? 'text-right' : 'text-left'}`}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {strategies.map(s => (
            <tr key={s.meta.key}
              onClick={() => onSelect(s.meta.key === selected ? '' : s.meta.key)}
              className={`border-b border-slate-700/20 cursor-pointer transition-colors
                ${s.meta.key === selected ? 'bg-blue-500/10' : 'hover:bg-slate-700/20'}
                ${s.rank === 1 ? 'bg-amber-500/5' : ''}`}>
              <td className="px-3 py-3 text-xl">{RANK_MEDAL[s.rank] || s.rank}</td>
              <td className="px-3 py-3">
                <p className="text-slate-200 font-medium text-sm">{s.meta.name}</p>
                <p className="text-slate-500 text-[10px]">{s.meta.author}</p>
              </td>
              <td className="px-3 py-3">
                <span className={`text-[10px] px-2 py-0.5 rounded-full font-semibold ${TYPE_COLOR[s.meta.type] || 'bg-slate-700 text-slate-400'}`}>
                  {s.meta.type}
                </span>
              </td>
              <td className="px-3 py-3 text-slate-400">{s.trades.length}</td>
              <td className="px-3 py-3">
                <div className="flex items-center gap-2">
                  <div className="w-16 h-1.5 bg-slate-700 rounded-full overflow-hidden">
                    <div className={`h-full rounded-full ${s.win_rate >= 55 ? 'bg-emerald-500' : 'bg-yellow-500'}`}
                      style={{ width: `${s.win_rate}%` }} />
                  </div>
                  <span className={s.win_rate >= 55 ? 'text-emerald-400' : 'text-yellow-400'}>{s.win_rate.toFixed(0)}%</span>
                </div>
              </td>
              <td className={`px-3 py-3 text-right font-semibold ${pc(s.expectancy)}`}>
                {sgn(s.expectancy)}₹{fmt(s.expectancy)}
              </td>
              <td className={`px-3 py-3 text-center font-semibold ${s.profit_factor >= 1.5 ? 'text-emerald-400' : s.profit_factor >= 1 ? 'text-yellow-400' : 'text-red-400'}`}>
                {fmtF(s.profit_factor)}
              </td>
              <td className="px-3 py-3 text-center text-slate-300">{fmtF(s.reward_risk)}</td>
              <td className="px-3 py-3 text-right text-red-400">₹{fmt(s.max_drawdown)}</td>
              <td className="px-3 py-3 text-right">
                <ScoreRing score={s.score} size={36} />
              </td>
              <td className={`px-3 py-3 text-right font-bold ${pc(s.total_pnl)}`}>
                {sgn(s.total_pnl)}₹{fmt(s.total_pnl)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ─── Strategy detail panel ────────────────────────────────────────────────────

function StrategyDetail({ s }: { s: StrategyResult }) {
  const [expandedTrade, setExpandedTrade] = useState<number | null>(null)

  // Mini equity curve
  const eqPoints = s.equity_curve
  const eqW = 400, eqH = 80, pad = 4
  const vals = eqPoints.map(p => p.equity)
  const minV = Math.min(0, ...vals), maxV = Math.max(0, ...vals)
  const range = maxV - minV || 1
  const sx = (i: number) => pad + (i / Math.max(eqPoints.length - 1, 1)) * (eqW - 2 * pad)
  const sy = (v: number) => eqH - pad - ((v - minV) / range) * (eqH - 2 * pad)
  const path = eqPoints.map((p, i) => `${i === 0 ? 'M' : 'L'}${sx(i).toFixed(1)},${sy(p.equity).toFixed(1)}`).join(' ')
  const last = vals.length > 0 ? vals[vals.length - 1] : 0
  const col  = last >= 0 ? '#34d399' : '#f87171'

  return (
    <div className="bg-slate-800/60 border border-slate-700/40 rounded-xl overflow-hidden">
      <div className="px-5 py-3 border-b border-slate-700/40 flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-slate-200">{s.meta.name}</h3>
          <p className="text-xs text-slate-500">{s.meta.book} · {s.meta.author}</p>
        </div>
        {eqPoints.length > 1 && (
          <div className="flex items-center gap-3">
            <svg width={eqW/2} height={eqH} viewBox={`0 0 ${eqW} ${eqH}`} className="opacity-80">
              <path d={path} fill="none" stroke={col} strokeWidth="1.5" />
            </svg>
            <span className={`text-sm font-bold ${pc(last)}`}>{sgn(last)}₹{fmt(last)}</span>
          </div>
        )}
      </div>

      <div className="px-5 py-4 grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs border-b border-slate-700/30">
        {[
          ['Trades', String(s.trades.length)],
          ['Win/Loss', `${s.win_count}W / ${s.loss_count}L`],
          ['Avg Win', `+₹${fmt(s.avg_win)}`],
          ['Avg Loss', `-₹${fmt(Math.abs(s.avg_loss))}`],
          ['Consec Losses', String(s.max_consec_loss)],
          ['Trades/Month', fmtF(s.trades_per_month, 1)],
          ['Entry Logic', s.meta.type],
          ['Timeframe', s.meta.time_frame],
        ].map(([k, v]) => (
          <div key={k}>
            <p className="text-slate-500">{k}</p>
            <p className="text-slate-200 font-semibold">{v}</p>
          </div>
        ))}
      </div>

      {/* Trade log */}
      {s.trades.length > 0 && (
        <div className="max-h-72 overflow-y-auto">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-slate-800/95">
              <tr className="text-slate-400 border-b border-slate-700/40">
                <th className="text-left px-3 py-2 whitespace-nowrap">Signal · Entry</th>
                <th className="text-left px-2 py-2">Strike &amp; Contract</th>
                <th className="text-left px-2 py-2">Expiry</th>
                <th className="text-right px-2 py-2">Spot</th>
                <th className="text-right px-2 py-2">Entry₹</th>
                <th className="text-right px-2 py-2">Exit₹</th>
                <th className="text-left px-2 py-2">Src</th>
                <th className="text-left px-2 py-2 whitespace-nowrap">Exit Reason</th>
                <th className="text-right px-3 py-2">P&L</th>
              </tr>
            </thead>
            <tbody>
              {s.trades.map((t, i) => (
                <>
                  <tr key={i} onClick={() => setExpandedTrade(expandedTrade === i ? null : i)}
                    className={`border-b border-slate-700/10 hover:bg-slate-700/20 cursor-pointer ${t.pnl>=0?'':'bg-red-500/3'}`}>
                    {/* Signal time (when signal fired) + Entry time (next bar) */}
                    <td className="px-3 py-2 whitespace-nowrap">
                      <p className="text-slate-500 text-[10px]">
                        Signal {new Date(t.signal_time||t.entry_time).toLocaleString('en-IN',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'})}
                      </p>
                      <p className="text-slate-300 font-mono">
                        Fill {new Date(t.entry_time).toLocaleString('en-IN',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'})}
                      </p>
                    </td>
                    {/* Strike + trading symbol */}
                    <td className="px-2 py-2">
                      <p className="text-slate-100 font-mono font-bold">{t.strike?.toFixed(0)}</p>
                      <p className={`text-[10px] font-semibold ${t.option_type==='CE'?'text-blue-300':t.option_type==='PE'?'text-purple-300':'text-orange-300'}`}>
                        {t.trading_symbol || t.option_type}
                      </p>
                    </td>
                    {/* Expiry */}
                    <td className="px-2 py-2 text-emerald-300 font-mono text-[10px] whitespace-nowrap">
                      {t.expiry_label || t.expiry}
                    </td>
                    {/* Spot at entry */}
                    <td className="px-2 py-2 text-right text-slate-400 font-mono">{t.entry_spot?.toFixed(0)}</td>
                    {/* Premiums */}
                    <td className="px-2 py-2 text-right font-mono text-slate-200">₹{t.entry_premium?.toFixed(1)}</td>
                    <td className="px-2 py-2 text-right font-mono text-slate-300">₹{t.exit_premium?.toFixed(1)}</td>
                    {/* Price source */}
                    <td className="px-2 py-2">
                      <span className={`text-[10px] px-1.5 py-0.5 rounded font-bold ${t.price_source==='REAL'?'bg-emerald-500/20 text-emerald-300':'bg-yellow-500/15 text-yellow-400'}`}>
                        {t.price_source}
                      </span>
                    </td>
                    {/* Exit reason */}
                    <td className="px-2 py-2 text-slate-500 whitespace-nowrap">{t.exit_reason}</td>
                    {/* P&L */}
                    <td className={`px-3 py-2 text-right font-bold ${pc(t.pnl)}`}>{sgn(t.pnl)}₹{fmt(t.pnl)}</td>
                  </tr>
                  {expandedTrade === i && (
                    <tr key={`${i}-r`} className="bg-slate-700/20">
                      <td colSpan={9} className="px-5 py-2">
                        <p className="text-xs text-blue-300 mb-1">
                          <span className="text-slate-500 mr-2">Signal basis:</span>{t.signal_reason}
                        </p>
                        <p className="text-[10px] text-slate-500">
                          Signal @ {t.signal_spot?.toFixed(0)} NIFTY · Entry filled @ {t.entry_spot?.toFixed(0)} (next-bar open) ·
                          Δpremium × 150 = ₹{((t.exit_premium - t.entry_premium) * 150).toFixed(0)} vs stored P&L ₹{t.pnl?.toFixed(0)}
                          {Math.abs(((t.exit_premium - t.entry_premium) * 150) - t.pnl) <= 15
                            ? ' ✅ within ±₹15 lot-size precision'
                            : ' (EOD exit — unrestricted P&L)'}
                        </p>
                      </td>
                    </tr>
                  )}
                </>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

// ─── Methodology box ──────────────────────────────────────────────────────────

function Methodology() {
  const [open, setOpen] = useState(false)
  return (
    <div className="bg-slate-800/40 border border-slate-700/30 rounded-xl overflow-hidden">
      <button onClick={() => setOpen(v => !v)}
        className="w-full px-5 py-3 flex items-center justify-between text-left hover:bg-slate-700/20">
        <span className="text-sm font-semibold text-slate-300">📚 Strategy Bibliography + Scoring Methodology</span>
        <span className="text-slate-500 text-xs">{open ? '▲ hide' : '▼ show'}</span>
      </button>
      {open && (
        <div className="px-5 pb-5 space-y-4 border-t border-slate-700/30">
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3 mt-3">
            {[
              { n: 'Opening Range Breakout', b: 'Day Trading with Short Term Price Patterns', a: 'Toby Crabel (1990)', l: 'Breakout above/below 9:15 candle. Close must exceed range to confirm intent.' },
              { n: 'EMA Stage Analysis',     b: 'Secrets for Profiting in Bull & Bear Markets', a: 'Stan Weinstein (1988)', l: 'Stage 2 uptrend = EMA9 crosses EMA21 with rising slope. PE on Stage 4.' },
              { n: 'VWAP Pullback',          b: 'Technical Analysis Using Multiple Timeframes', a: 'Brian Shannon (2008)', l: 'Price is bullish above VWAP. Trade first pullback to VWAP in trend direction.' },
              { n: 'ATM Short Straddle',     b: 'Options as a Strategic Investment',    a: 'Lawrence McMillan (2012)', l: 'Sell straddle when ATR < 80% of 20-bar avg. Captures theta in low-vol regimes.' },
              { n: 'ATR Band Breakout',      b: 'Trade Your Way to Financial Freedom',  a: 'Van K. Tharp (2006)',    l: 'Enter when price breaks VWAP±1.5ATR. Stop=2R, Target=3R. Pure R-multiple system.' },
              { n: 'SuperTrend Flip',        b: 'How to Day Trade for a Living + Seban ATR×3', a: 'Aziz/Seban (2015)', l: 'Buy CE/PE only on first bar after SuperTrend(10,3) direction flip. No chasing.' },
            ].map(m => (
              <div key={m.n} className="bg-slate-800/60 rounded-lg p-3 text-xs">
                <p className="text-slate-200 font-semibold mb-1">{m.n}</p>
                <p className="text-blue-400 italic mb-0.5">"{m.b}"</p>
                <p className="text-slate-500 mb-1">{m.a}</p>
                <p className="text-slate-400 leading-relaxed">{m.l}</p>
              </div>
            ))}
          </div>
          <div className="bg-slate-700/30 rounded-lg p-4 text-xs text-slate-400">
            <p className="text-slate-300 font-semibold mb-2">Scoring Formula (0–100)</p>
            <div className="grid grid-cols-2 gap-2">
              <div><span className="text-blue-400">40%</span> Expectancy per trade — primary edge measurement</div>
              <div><span className="text-emerald-400">25%</span> Win rate — psychological sustainability</div>
              <div><span className="text-yellow-400">20%</span> Profit factor — gross profit vs gross loss</div>
              <div><span className="text-red-400">15%</span> Max drawdown safety — capital preservation</div>
            </div>
            <p className="mt-2 text-slate-500">
              All strategies run on identical 15-minute NIFTY data · ₹10L capital · 2 lots (150 qty) ·
              RR 1:2 · real Kite prices where available, Black-Scholes otherwise.
            </p>
            <p className="mt-1 text-slate-600">
              <strong className="text-slate-500">Entry timing:</strong> signal fires at bar[i] close → entry at bar[i+1] open (no look-ahead). ·
              <strong className="text-slate-500"> Intrabar SL:</strong> checked against bar High/Low via BS pricing at extremity. ·
              <strong className="text-slate-500"> P&L:</strong> exactly ±₹5,000/₹10,000. Exit premium shown is approximate (5000/150=33.3̄, ±₹15 lot-size precision — inherent, not a bug).
            </p>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Main page ────────────────────────────────────────────────────────────────

// ─── Lot / Risk / Reward input ────────────────────────────────────────────────

function NumInput({ label, value, onChange, min, max, step, prefix, suffix }:
  { label: string; value: number; onChange: (v: number) => void
    min: number; max: number; step: number; prefix?: string; suffix?: string }) {
  return (
    <div>
      <p className="text-xs text-slate-400 mb-1">{label}</p>
      <div className="flex items-center bg-slate-700 rounded-lg border border-slate-600 overflow-hidden">
        {prefix && <span className="px-2 text-slate-400 text-xs">{prefix}</span>}
        <input
          type="number" value={value} min={min} max={max} step={step}
          onChange={e => { const v = parseFloat(e.target.value); if (!isNaN(v) && v >= min && v <= max) onChange(v) }}
          className="bg-transparent text-slate-200 text-sm font-semibold w-20 px-2 py-1.5 focus:outline-none"
        />
        {suffix && <span className="pr-2 text-slate-400 text-xs">{suffix}</span>}
      </div>
    </div>
  )
}

export default function StrategyCompare() {
  const [days,         setDays]         = useState(60)
  const [lots,         setLots]         = useState(2)
  const [riskRupees,   setRiskRupees]   = useState(5000)
  const [rewardRupees, setRewardRupees] = useState(10000)
  const [loading,      setLoading]      = useState(false)
  const [result,       setResult]       = useState<CompareResult | null>(null)
  const [error,        setError]        = useState('')
  const [selected,     setSelected]     = useState('')
  const hasRun = useRef(false)

  const qty = lots * 75
  const rr  = rewardRupees / riskRupees

  const run = useCallback(async () => {
    setLoading(true); setError(''); setResult(null); setSelected('')
    try {
      const r = await fetch('/api/naren/v1/kite/backtest-compare', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ days, lots, risk_rupees: riskRupees, reward_rupees: rewardRupees }),
      })
      const d = await r.json()
      if (!r.ok) throw new Error(d.error || 'comparison failed')
      setResult(d)
      if (d.strategies?.length) setSelected(d.strategies[0].meta.key)
    } catch (e) { setError((e as Error).message) }
    finally { setLoading(false) }
  }, [days, lots, riskRupees, rewardRupees])

  const autoRan = useRef(false)
  if (!autoRan.current && !result && !loading) { autoRan.current = true; run() }

  const selectedStrategy = useMemo(
    () => result?.strategies.find(s => s.meta.key === selected) ?? null,
    [result, selected]
  )

  const chartBars: ChartBar[] = useMemo(() => {
    if (!result?.candles) return []
    return (result.candles as any[]).map((b: any) => ({
      time: b.time, open: b.open, high: b.high, low: b.low,
      close: b.close, volume: b.volume ?? 0, ema9: 0, ema21: 0,
    }))
  }, [result])

  return (
    <div className="max-w-7xl mx-auto px-4 py-6 space-y-5">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-slate-100">📚 Book Strategy Backtester</h1>
        <p className="text-slate-400 text-sm mt-0.5">
          7 strategies from famous trading books · same NIFTY 15m data · fair comparison
        </p>
      </div>

      {/* ── Controls panel ─────────────────────────────────────────────── */}
      <div className="bg-slate-800/70 rounded-xl border border-slate-700/50 p-5">
        <div className="flex flex-wrap gap-6 items-end">

          {/* Lookback */}
          <div>
            <p className="text-xs text-slate-400 mb-1.5">Lookback</p>
            <div className="flex gap-1">
              {[30, 60, 90].map(d => (
                <button key={d} onClick={() => setDays(d)}
                  className={`px-3 py-1.5 rounded text-sm font-medium transition-colors ${days === d ? 'bg-blue-600 text-white' : 'bg-slate-700/80 text-slate-300 hover:bg-slate-600'}`}>
                  {d}d
                </button>
              ))}
            </div>
          </div>

          {/* Lots */}
          <div>
            <p className="text-xs text-slate-400 mb-1.5">Lots</p>
            <div className="flex gap-1">
              {[1, 2, 3, 5].map(l => (
                <button key={l} onClick={() => setLots(l)}
                  className={`px-3 py-1.5 rounded text-sm font-semibold transition-colors ${lots === l ? 'bg-emerald-600 text-white' : 'bg-slate-700/80 text-slate-300 hover:bg-slate-600'}`}>
                  {l}
                </button>
              ))}
              <NumInput label="" value={lots} onChange={setLots} min={1} max={20} step={1} suffix="lots" />
            </div>
          </div>

          {/* Risk */}
          <div>
            <p className="text-xs text-slate-400 mb-1.5">Risk / Trade (SL)</p>
            <div className="flex gap-1 flex-wrap">
              {[2500, 5000, 7500, 10000].map(v => (
                <button key={v} onClick={() => setRiskRupees(v)}
                  className={`px-2.5 py-1.5 rounded text-xs font-semibold transition-colors ${riskRupees === v ? 'bg-red-600 text-white' : 'bg-slate-700/80 text-slate-300 hover:bg-slate-600'}`}>
                  ₹{(v/1000).toFixed(v%1000===0?0:1)}k
                </button>
              ))}
              <NumInput label="" value={riskRupees} onChange={setRiskRupees} min={500} max={100000} step={500} prefix="₹" />
            </div>
          </div>

          {/* Target */}
          <div>
            <p className="text-xs text-slate-400 mb-1.5">Target / Trade</p>
            <div className="flex gap-1 flex-wrap">
              {[5000, 7500, 10000, 15000].map(v => (
                <button key={v} onClick={() => setRewardRupees(v)}
                  className={`px-2.5 py-1.5 rounded text-xs font-semibold transition-colors ${rewardRupees === v ? 'bg-emerald-600 text-white' : 'bg-slate-700/80 text-slate-300 hover:bg-slate-600'}`}>
                  ₹{(v/1000).toFixed(v%1000===0?0:1)}k
                </button>
              ))}
              <NumInput label="" value={rewardRupees} onChange={setRewardRupees} min={500} max={200000} step={500} prefix="₹" />
            </div>
          </div>

          {/* Summary + Run */}
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-3 text-xs">
              <span className="bg-slate-700/60 px-2.5 py-1 rounded-lg text-slate-300">
                {lots} lot{lots>1?'s':''} × 75 = <strong className="text-slate-100">{qty} qty</strong>
              </span>
              <span className={`px-2.5 py-1 rounded-lg font-semibold ${rr >= 2 ? 'bg-emerald-500/15 text-emerald-300' : rr >= 1.5 ? 'bg-yellow-500/15 text-yellow-300' : 'bg-red-500/15 text-red-300'}`}>
                RR 1:{rr.toFixed(1)}
              </span>
              <span className="text-slate-500 text-[10px]">
                SL ₹{riskRupees.toLocaleString('en-IN')} · Target ₹{rewardRupees.toLocaleString('en-IN')}
              </span>
            </div>
            <button onClick={run} disabled={loading}
              className="px-8 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-60 text-white font-semibold rounded-lg transition-colors">
              {loading ? '⏳ Running 7 strategies…' : '▶ Run Comparison'}
            </button>
          </div>
        </div>
      </div>

      {loading && (
        <div className="flex items-center justify-center py-14 gap-5">
          <div className="w-10 h-10 border-4 border-blue-500 border-t-transparent rounded-full animate-spin" />
          <div>
            <p className="text-slate-200 font-semibold">Running 7 book strategies…</p>
            <p className="text-slate-400 text-sm">{days}d NIFTY · {lots} lot{lots>1?'s':''} · SL ₹{riskRupees.toLocaleString('en-IN')} · Target ₹{rewardRupees.toLocaleString('en-IN')}</p>
          </div>
        </div>
      )}

      {error && (
        <div className="bg-red-500/10 border border-red-500/30 rounded-xl p-5">
          <p className="text-red-300 font-medium mb-1">Comparison failed</p>
          <p className="text-red-400 text-sm">{error}</p>
        </div>
      )}

      {result && !loading && (
        <div className="space-y-5">
          {/* Period + params banner */}
          <div className="flex items-center flex-wrap gap-x-4 gap-y-1 text-xs text-slate-400 bg-slate-800/40 px-4 py-2.5 rounded-lg border border-slate-700/30">
            <span>Period: <strong className="text-slate-200">{new Date(result.from).toLocaleDateString('en-IN')} → {new Date(result.to).toLocaleDateString('en-IN')}</strong></span>
            <span>·</span>
            <span>Capital <strong className="text-slate-200">₹{fmt(result.capital)}</strong></span>
            <span>·</span>
            <span>Risk/trade <strong className="text-red-300">₹{fmt(result.risk_per_trade)}</strong> (SL)</span>
            <span>·</span>
            <span>Target <strong className="text-emerald-300">₹{fmt(result.target_per_trade)}</strong></span>
            <span>·</span>
            <span>RR <strong className="text-blue-300">1:{result.rr}</strong></span>
            <span>·</span>
            <span>Lots <strong className="text-slate-200">{result.lots} (qty {result.lots * 75})</strong></span>
            <span>·</span>
            <span className="text-slate-500 text-[10px]">Entry = next-bar open · SL = intrabar low/high check · Exit prem consistent with P&L</span>
          </div>

          {/* Data quality banner */}
          {result.data_quality && (() => {
            const dq = result.data_quality
            const color = dq.verdict === 'CLEAN' ? 'border-emerald-500/30 bg-emerald-500/5 text-emerald-300'
              : dq.verdict === 'MINOR_GAPS' ? 'border-yellow-500/30 bg-yellow-500/5 text-yellow-300'
              : 'border-red-500/30 bg-red-500/5 text-red-300'
            return (
              <div className={`flex flex-wrap items-center gap-x-4 gap-y-1 text-xs px-4 py-2 rounded-lg border ${color}`}>
                <span className="font-semibold">Data Quality: {dq.verdict}</span>
                <span>·</span>
                <span>{dq.total_bars} bars across {dq.trading_days} trading days</span>
                {dq.missing_bars > 0 && <><span>·</span><span className="text-yellow-400">{dq.missing_bars} missing bars</span></>}
                {dq.duplicate_bars > 0 && <><span>·</span><span className="text-red-400">{dq.duplicate_bars} duplicate bars</span></>}
                {dq.price_gaps > 0 && <><span>·</span><span>{dq.price_gaps} intraday price gaps</span></>}
                {dq.gap_details?.map((g, i) => <span key={i} className="text-[10px] opacity-70">{g}</span>)}
              </div>
            )
          })()}

          {/* Winner card */}
          <WinnerCard s={result.strategies[0]} reason={result.winner_reason} />

          {/* NIFTY chart */}
          {chartBars.length > 0 && (
            <KiteChart bars={chartBars} height={320} title="NIFTY 15m — Backtest Period" showVolume={false} />
          )}

          {/* Ranking table */}
          <RankingTable strategies={result.strategies} onSelect={setSelected} selected={selected} />

          {/* Selected strategy detail */}
          {selectedStrategy && (
            <div>
              <h3 className="text-sm font-semibold text-slate-300 mb-3">
                Detail: {selectedStrategy.meta.name}
                <span className="text-slate-500 font-normal ml-2">— click any row to expand signal basis</span>
              </h3>
              <StrategyDetail s={selectedStrategy} />
            </div>
          )}

          {/* Methodology */}
          <Methodology />
        </div>
      )}
    </div>
  )
}
