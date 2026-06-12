import { useEffect, useState } from 'react'
import axios from 'axios'
import LoadingSpinner from '../components/LoadingSpinner'

// ─── Types ────────────────────────────────────────────────────────────────────

interface SessionLevels { pdh: number; pdl: number; pwhl: number; pwll: number; eq: number }
interface BreakerBlock  { high: number; low: number; mid: number; type: string; bars_ago: number }
interface Displacement  { index: number; high: number; low: number; close: number; direction: string; fvg_low: number; fvg_high: number }
interface OBZone        { high: number; low: number; mid: number; type: string; mitigated: boolean; bars_ago: number }
interface FVGZone       { low: number; high: number; type: string; filled: boolean }
interface LiqLevel      { price: number; type: string; swept: boolean; count: number }

interface HuddlestonSetup {
  score: number; grade: string; setup_type: string; direction: string; factors: string[]
}

interface HuddlestonSignal {
  symbol: string; spot_price: number; generated_at: string
  daily_bias: string; weekly_bias: string; draw_on_liquidity: string
  session: SessionLevels; po3_phase: string
  bull_breakers: BreakerBlock[]; bear_breakers: BreakerBlock[]
  displacement: Displacement | null
  bull_ob: OBZone | null; bear_ob: OBZone | null
  fvgs: FVGZone[]; liq_levels: LiqLevel[]
  ote_low: number; ote_high: number
  equilibrium: number; swing_high: number; swing_low: number
  setup: HuddlestonSetup
  signal: string; confluence: number
  entry: number; stop_loss: number; target1: number; target2: number; target_liq: number
  risk_reward: number; confidence: number; reasoning: string[]
}

interface SetupStats {
  setup_type: string; trades: number; wins: number
  win_rate: number; net_pnl_pct: number; avg_win: number; avg_loss: number
}
interface YearStats  { year: number; trades: number; wins: number; win_rate: number; net_pnl_pct: number; profit_factor: number }
interface TradeRow   { entry_date: string; exit_date: string; direction: string; entry: number; exit: number; pnl_pct: number; result: string; setup_type: string; score: number }

interface BacktestResult {
  symbol: string; period_years: number; data_points: number; generated_at: string
  total_trades: number; winning_trades: number; losing_trades: number
  win_rate: number; profit_factor: number; avg_win_pct: number; avg_loss_pct: number
  max_drawdown_pct: number; total_return_pct: number; sharpe_ratio: number; expectancy_pct: number
  a_plus_setups: SetupStats; by_setup_type: SetupStats[]; yearly_breakdown: YearStats[]; recent_trades: TradeRow[]
  pdh_sweep_wr: number; pdl_sweep_wr: number; ob_fvg_wr: number; breaker_wr: number
  avg_score_wins: number; avg_score_losses: number; methodology: string
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const biasColor = (b: string) =>
  b === 'BULL' ? 'text-emerald-400' : b === 'BEAR' ? 'text-red-400' : 'text-amber-400'

const gradeColor = (g: string) =>
  g === 'A+' ? 'text-emerald-400 bg-emerald-500/15 border-emerald-500/30'
  : g === 'A'  ? 'text-blue-400 bg-blue-500/15 border-blue-500/30'
  : g === 'B'  ? 'text-amber-400 bg-amber-500/15 border-amber-500/30'
  :              'text-slate-400 bg-slate-700 border-slate-600'

const signalColor = (s: string) =>
  s === 'CE_BUY' ? 'bg-emerald-500/20 border-emerald-500/40 text-emerald-300'
  : s === 'PE_BUY' ? 'bg-red-500/20 border-red-500/40 text-red-300'
  : 'bg-slate-700/40 border-slate-600 text-slate-400'

const wrColor = (wr: number) =>
  wr >= 60 ? 'text-emerald-400' : wr >= 50 ? 'text-amber-400' : 'text-red-400'

function fmt(v: number, d = 1) { return v?.toFixed(d) ?? '—' }
function fmtPct(v: number) { return `${v >= 0 ? '+' : ''}${v?.toFixed(1)}%` }

// ─── Score Ring ───────────────────────────────────────────────────────────────

function ScoreRing({ score, max = 10 }: { score: number; max?: number }) {
  const pct = (score / max) * 100
  const r = 22, circ = 2 * Math.PI * r, dash = (pct / 100) * circ
  const color = score >= 7 ? '#10b981' : score >= 5 ? '#3b82f6' : score >= 3 ? '#f59e0b' : '#ef4444'
  return (
    <div className="relative w-14 h-14">
      <svg className="w-14 h-14 -rotate-90" viewBox="0 0 56 56">
        <circle cx="28" cy="28" r={r} fill="none" stroke="#1e293b" strokeWidth="5" />
        <circle cx="28" cy="28" r={r} fill="none" stroke={color} strokeWidth="5"
          strokeDasharray={`${dash} ${circ}`} strokeLinecap="round" />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-sm font-black text-white leading-none">{score}</span>
        <span className="text-[9px] text-slate-500">/{max}</span>
      </div>
    </div>
  )
}

// ─── PD Array Card ────────────────────────────────────────────────────────────

function PDArrayCard({ title, color, items }: { title: string; color: string; items: { label: string; value: string; sub?: string }[] }) {
  return (
    <div className={`rounded-xl border p-3 ${color}`}>
      <div className="text-[10px] font-bold uppercase tracking-widest opacity-60 mb-2">{title}</div>
      <div className="space-y-1.5">
        {items.map((it, i) => (
          <div key={i} className="flex items-center justify-between">
            <span className="text-xs text-slate-400">{it.label}</span>
            <div className="text-right">
              <span className="text-xs font-bold text-white">₹{it.value}</span>
              {it.sub && <div className="text-[9px] text-slate-500">{it.sub}</div>}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

// ─── Signal Panel ─────────────────────────────────────────────────────────────

function SignalPanel({ sig }: { sig: HuddlestonSignal }) {
  const setup = sig.setup
  const isActive = sig.signal !== 'WAIT'

  return (
    <div className="space-y-5">
      {/* Main signal banner */}
      <div className={`border rounded-xl p-5 ${signalColor(sig.signal)}`}>
        <div className="flex items-center justify-between mb-3">
          <div>
            <div className="text-2xl font-black">{sig.signal === 'CE_BUY' ? '📈 CE BUY' : sig.signal === 'PE_BUY' ? '📉 PE BUY' : '⏸ WAIT'}</div>
            <div className="text-sm opacity-70 mt-0.5">
              {sig.signal === 'CE_BUY' ? 'Bullish ICT Setup — Long CE options'
               : sig.signal === 'PE_BUY' ? 'Bearish ICT Setup — Long PE options'
               : 'No valid Huddleston setup detected'}
            </div>
          </div>
          <div className="text-right">
            <div className="text-3xl font-black">₹{sig.spot_price.toLocaleString('en-IN')}</div>
            <div className="text-xs opacity-60">Nifty 50</div>
          </div>
        </div>

        {isActive && (
          <div className="grid grid-cols-4 gap-2 mt-2">
            {[
              { l: 'Entry', v: `₹${sig.entry.toLocaleString('en-IN')}`, c: 'text-white' },
              { l: 'Stop Loss', v: `₹${sig.stop_loss.toLocaleString('en-IN')}`, c: 'text-red-400' },
              { l: 'Target 1', v: `₹${sig.target1.toLocaleString('en-IN')}`, c: 'text-emerald-400' },
              { l: 'Target 2', v: `₹${sig.target2.toLocaleString('en-IN')}`, c: 'text-emerald-300' },
            ].map(m => (
              <div key={m.l} className="bg-black/20 rounded-lg p-2 text-center">
                <div className="text-[10px] opacity-60">{m.l}</div>
                <div className={`text-xs font-bold ${m.c}`}>{m.v}</div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Setup scorecard */}
      {setup && (
        <div className="bg-slate-800/40 border border-slate-700/60 rounded-xl p-4">
          <div className="flex items-center gap-4 mb-4">
            <ScoreRing score={setup.score} />
            <div>
              <div className="flex items-center gap-2">
                <span className="text-lg font-bold text-white">{setup.setup_type}</span>
                <span className={`text-xs font-bold px-2 py-0.5 rounded-lg border ${gradeColor(setup.grade)}`}>
                  Grade {setup.grade}
                </span>
                <span className={`text-xs font-bold px-2 py-0.5 rounded-lg ${biasColor(setup.direction) === 'text-emerald-400' ? 'bg-emerald-500/15 text-emerald-400' : 'bg-red-500/15 text-red-400'}`}>
                  {setup.direction}
                </span>
              </div>
              <div className="text-xs text-slate-500 mt-0.5">Confluence score {setup.score}/10 — {setup.score >= 7 ? 'A+ institutional setup' : setup.score >= 5 ? 'Good setup' : 'Weak setup — exercise caution'}</div>
            </div>
          </div>
          <div className="space-y-1.5">
            {(setup.factors || []).map((f, i) => (
              <div key={i} className={`flex items-start gap-2 text-xs ${f.startsWith('✓') ? 'text-slate-300' : 'text-slate-500'}`}>
                <span className="flex-shrink-0 mt-0.5">{f.startsWith('✓') ? '▸' : '▹'}</span>
                <span>{f}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* PO3 + Bias row */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          { l: 'Daily Bias', v: sig.daily_bias, color: biasColor(sig.daily_bias) },
          { l: 'Weekly Bias', v: sig.weekly_bias, color: biasColor(sig.weekly_bias) },
          { l: 'Draw on Liq', v: sig.draw_on_liquidity, color: sig.draw_on_liquidity === 'BSL' ? 'text-emerald-400' : sig.draw_on_liquidity === 'SSL' ? 'text-red-400' : 'text-slate-400' },
          { l: 'PO3 Phase', v: sig.po3_phase, color: sig.po3_phase === 'DISTRIBUTION' ? 'text-emerald-400' : sig.po3_phase === 'MANIPULATION' ? 'text-amber-400' : 'text-slate-400' },
        ].map(m => (
          <div key={m.l} className="bg-slate-800/50 rounded-lg p-2.5 text-center">
            <div className="text-[10px] text-slate-500 mb-0.5">{m.l}</div>
            <div className={`text-sm font-bold ${m.color}`}>{m.v || '—'}</div>
          </div>
        ))}
      </div>

      {/* PD Arrays grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {/* Session levels */}
        <PDArrayCard title="Session Levels (PDH/PDL)" color="bg-slate-800/40 border-slate-700/60"
          items={[
            { label: 'Previous Day High', value: fmt(sig.session.pdh, 0) },
            { label: 'Previous Day Low',  value: fmt(sig.session.pdl, 0) },
            { label: 'Week High (PWHL)',  value: fmt(sig.session.pwhl, 0) },
            { label: 'Week Low (PWLL)',   value: fmt(sig.session.pwll, 0) },
            { label: 'Weekly EQ',         value: fmt(sig.session.eq, 0) },
          ]} />

        {/* OTE / Swing */}
        <PDArrayCard title="OTE Zone (61.8–78.6% Fib)" color="bg-blue-500/5 border-blue-500/20"
          items={[
            { label: 'Swing High', value: fmt(sig.swing_high, 0) },
            { label: 'Swing Low',  value: fmt(sig.swing_low, 0) },
            { label: 'OTE High',   value: fmt(sig.ote_high, 0) },
            { label: 'OTE Low',    value: fmt(sig.ote_low, 0) },
            { label: 'Equilibrium (50%)', value: fmt(sig.equilibrium, 0) },
          ]} />

        {/* Order Blocks */}
        <PDArrayCard title="Order Blocks" color="bg-amber-500/5 border-amber-500/20"
          items={[
            { label: 'Bull OB High', value: sig.bull_ob ? fmt(sig.bull_ob.high, 0) : '—', sub: sig.bull_ob ? (sig.bull_ob.mitigated ? 'MITIGATED' : `${sig.bull_ob.bars_ago}d ago`) : '' },
            { label: 'Bull OB Low',  value: sig.bull_ob ? fmt(sig.bull_ob.low, 0) : '—' },
            { label: 'Bear OB High', value: sig.bear_ob ? fmt(sig.bear_ob.high, 0) : '—', sub: sig.bear_ob ? (sig.bear_ob.mitigated ? 'MITIGATED' : `${sig.bear_ob.bars_ago}d ago`) : '' },
            { label: 'Bear OB Low',  value: sig.bear_ob ? fmt(sig.bear_ob.low, 0) : '—' },
          ]} />

        {/* Displacement */}
        {sig.displacement && (
          <PDArrayCard title="Displacement Candle" color="bg-purple-500/5 border-purple-500/20"
            items={[
              { label: 'Direction',  value: sig.displacement.direction },
              { label: 'Range High', value: fmt(sig.displacement.high, 0) },
              { label: 'Range Low',  value: fmt(sig.displacement.low, 0) },
              { label: 'FVG High',   value: sig.displacement.fvg_high > 0 ? fmt(sig.displacement.fvg_high, 0) : '—' },
              { label: 'FVG Low',    value: sig.displacement.fvg_low > 0 ? fmt(sig.displacement.fvg_low, 0) : '—' },
            ]} />
        )}

        {/* Breaker Blocks */}
        {(sig.bull_breakers?.length > 0 || sig.bear_breakers?.length > 0) && (
          <PDArrayCard title="Breaker Blocks (Flipped OBs)" color="bg-rose-500/5 border-rose-500/20"
            items={[
              ...( sig.bull_breakers?.slice(0, 2).map((b, i) => ({ label: `Bull Breaker ${i+1}`, value: `${fmt(b.low,0)}–${fmt(b.high,0)}`, sub: `${b.bars_ago}d ago` })) ?? []),
              ...( sig.bear_breakers?.slice(0, 2).map((b, i) => ({ label: `Bear Breaker ${i+1}`, value: `${fmt(b.low,0)}–${fmt(b.high,0)}`, sub: `${b.bars_ago}d ago` })) ?? []),
            ]} />
        )}

        {/* Liquidity Levels */}
        {sig.liq_levels?.length > 0 && (
          <PDArrayCard title="Liquidity Pools" color="bg-cyan-500/5 border-cyan-500/20"
            items={sig.liq_levels.slice(0, 5).map(l => ({
              label: `${l.type} (×${l.count} cluster)`,
              value: fmt(l.price, 0),
              sub: l.swept ? 'SWEPT' : 'UNSWEPT',
            }))} />
        )}
      </div>
    </div>
  )
}

// ─── Backtest Panel ───────────────────────────────────────────────────────────

function StatBox({ label, value, sub, color = 'text-white' }: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <div className="bg-slate-800/60 rounded-xl p-3">
      <div className="text-[10px] text-slate-500 mb-0.5">{label}</div>
      <div className={`text-lg font-black ${color}`}>{value}</div>
      {sub && <div className="text-[10px] text-slate-500">{sub}</div>}
    </div>
  )
}

function BacktestPanel({ res, years, setYears }: {
  res: BacktestResult | null
  years: number
  setYears: (y: number) => void
}) {
  const [tab, setTab] = useState<'overview' | 'setups' | 'yearly' | 'trades'>('overview')

  return (
    <div className="space-y-5">
      {/* Year picker */}
      <div className="flex items-center gap-2">
        <span className="text-xs text-slate-500">Backtest period:</span>
        {[1, 2, 3, 5].map(y => (
          <button key={y} onClick={() => setYears(y)}
            className={`px-3 py-1 rounded-lg text-xs font-medium transition-all ${years === y ? 'bg-brand-600 text-white' : 'bg-slate-800 text-slate-400 hover:text-white'}`}>
            {y}Y
          </button>
        ))}
      </div>

      {!res && <LoadingSpinner size="sm" text="Running backtest..." />}
      {res && (
        <>
          {/* Headline stats */}
          <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-5 gap-3">
            <StatBox label="Win Rate" value={`${fmt(res.win_rate)}%`} color={wrColor(res.win_rate)} sub={`${res.winning_trades}W / ${res.losing_trades}L`} />
            <StatBox label="Profit Factor" value={fmt(res.profit_factor)} color={res.profit_factor >= 1.5 ? 'text-emerald-400' : 'text-amber-400'} sub="win÷loss ratio" />
            <StatBox label="Total Return" value={fmtPct(res.total_return_pct)} color={res.total_return_pct >= 0 ? 'text-emerald-400' : 'text-red-400'} sub={`${res.total_trades} trades`} />
            <StatBox label="Max Drawdown" value={`${fmt(res.max_drawdown_pct)}%`} color={res.max_drawdown_pct > 20 ? 'text-red-400' : 'text-amber-400'} />
            <StatBox label="Sharpe Ratio" value={fmt(res.sharpe_ratio)} color={res.sharpe_ratio >= 1 ? 'text-emerald-400' : 'text-amber-400'} sub="annualised" />
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <StatBox label="Avg Win" value={`+${fmt(res.avg_win_pct)}%`} color="text-emerald-400" />
            <StatBox label="Avg Loss" value={`-${fmt(res.avg_loss_pct)}%`} color="text-red-400" />
            <StatBox label="Expectancy" value={`${fmtPct(res.expectancy_pct)}`} color={res.expectancy_pct > 0 ? 'text-emerald-400' : 'text-red-400'} sub="per trade" />
            <StatBox label="A+ Win Rate" value={`${fmt(res.a_plus_setups?.win_rate ?? 0)}%`} color="text-emerald-400" sub={`score ≥7 (${res.a_plus_setups?.trades ?? 0} trades)`} />
          </div>

          {/* ICT-specific WRs */}
          <div className="bg-slate-800/30 rounded-xl border border-slate-700/60 p-4">
            <div className="text-xs font-bold text-slate-400 mb-3 uppercase tracking-widest">Win Rate by ICT Setup Type</div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {[
                { label: 'PDH Sweep', value: res.pdh_sweep_wr, desc: 'Short after PDH taken' },
                { label: 'PDL Sweep', value: res.pdl_sweep_wr, desc: 'Long after PDL taken' },
                { label: 'OB + FVG', value: res.ob_fvg_wr, desc: 'Order Block + imbalance' },
                { label: 'Breaker Block', value: res.breaker_wr, desc: 'Flipped OB retest' },
              ].map(m => (
                <div key={m.label} className="bg-slate-900/50 rounded-lg p-3 text-center">
                  <div className="text-[10px] text-slate-500 mb-1">{m.label}</div>
                  <div className={`text-xl font-black ${wrColor(m.value)}`}>{m.value > 0 ? `${fmt(m.value)}%` : '—'}</div>
                  <div className="text-[9px] text-slate-600 mt-0.5">{m.desc}</div>
                </div>
              ))}
            </div>
            <div className="flex gap-4 mt-3 text-xs text-slate-500">
              <span>Avg score on wins: <span className="text-emerald-400 font-bold">{fmt(res.avg_score_wins)}/10</span></span>
              <span>Avg score on losses: <span className="text-red-400 font-bold">{fmt(res.avg_score_losses)}/10</span></span>
            </div>
          </div>

          {/* Tabs */}
          <div className="bg-slate-800/40 border border-slate-700/60 rounded-xl overflow-hidden">
            <div className="flex border-b border-slate-700">
              {(['overview', 'setups', 'yearly', 'trades'] as const).map(t => (
                <button key={t} onClick={() => setTab(t)}
                  className={`px-4 py-2.5 text-xs font-medium capitalize transition-colors ${tab === t ? 'text-white border-b-2 border-brand-500 bg-slate-800/60' : 'text-slate-400 hover:text-white'}`}>
                  {t === 'overview' ? '📊 Overview' : t === 'setups' ? '🔍 Setup Types' : t === 'yearly' ? '📅 Yearly' : '📋 Recent Trades'}
                </button>
              ))}
            </div>
            <div className="p-4">

              {tab === 'overview' && (
                <div className="text-xs text-slate-400 leading-relaxed">
                  <div className="font-bold text-slate-300 mb-2">Methodology</div>
                  <p className="mb-3">{res.methodology}</p>
                  <div className="bg-blue-500/10 border border-blue-500/20 rounded-lg p-3 text-blue-300">
                    <strong>7 ICT Pillars scored per trade:</strong> HTF Bias (2pts) · Draw on Liquidity (1pt) · PDH/PDL Sweep (2pts) · OB/Breaker Retest (2pts) · Displacement (1pt) · OTE Zone (1pt) · MSS/CHoCH (1pt). Trade taken at score ≥4. A+ = score ≥7.
                  </div>
                </div>
              )}

              {tab === 'setups' && (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-slate-700">
                        {['Setup Type', 'Trades', 'WR %', 'Net P&L', 'Avg Win', 'Avg Loss'].map(h => (
                          <th key={h} className="text-left py-2 px-2 text-slate-500 font-medium">{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {(res.by_setup_type ?? []).map(s => (
                        <tr key={s.setup_type} className="border-b border-slate-800/40 hover:bg-slate-800/30">
                          <td className="py-2 px-2 font-bold text-slate-200">{s.setup_type}</td>
                          <td className="py-2 px-2 text-slate-400">{s.trades}</td>
                          <td className={`py-2 px-2 font-bold ${wrColor(s.win_rate)}`}>{fmt(s.win_rate)}%</td>
                          <td className={`py-2 px-2 font-mono ${s.net_pnl_pct >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{fmtPct(s.net_pnl_pct)}</td>
                          <td className="py-2 px-2 text-emerald-400 font-mono">+{fmt(s.avg_win)}%</td>
                          <td className="py-2 px-2 text-red-400 font-mono">-{fmt(s.avg_loss)}%</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {tab === 'yearly' && (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-slate-700">
                        {['Year', 'Trades', 'Win Rate', 'Net P&L', 'Profit Factor'].map(h => (
                          <th key={h} className="text-left py-2 px-2 text-slate-500 font-medium">{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {(res.yearly_breakdown ?? []).map(y => (
                        <tr key={y.year} className="border-b border-slate-800/40 hover:bg-slate-800/30">
                          <td className="py-2 px-2 font-bold text-slate-200">{y.year}</td>
                          <td className="py-2 px-2 text-slate-400">{y.trades}</td>
                          <td className={`py-2 px-2 font-bold ${wrColor(y.win_rate)}`}>{fmt(y.win_rate)}%</td>
                          <td className={`py-2 px-2 font-mono ${y.net_pnl_pct >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{fmtPct(y.net_pnl_pct)}</td>
                          <td className={`py-2 px-2 font-bold ${y.profit_factor >= 1.5 ? 'text-emerald-400' : 'text-amber-400'}`}>{fmt(y.profit_factor)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {tab === 'trades' && (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-slate-700">
                        {['Date', 'Dir', 'Entry', 'Exit', 'P&L', 'Result', 'Setup', 'Score'].map(h => (
                          <th key={h} className="text-left py-2 px-2 text-slate-500 font-medium">{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {(res.recent_trades ?? []).slice().reverse().map((t, i) => (
                        <tr key={i} className="border-b border-slate-800/30 hover:bg-slate-800/30">
                          <td className="py-1.5 px-2 text-slate-400 font-mono">{t.entry_date}</td>
                          <td className={`py-1.5 px-2 font-bold ${t.direction === 'CE' ? 'text-emerald-400' : 'text-red-400'}`}>{t.direction}</td>
                          <td className="py-1.5 px-2 font-mono text-slate-300">{t.entry.toLocaleString('en-IN')}</td>
                          <td className="py-1.5 px-2 font-mono text-slate-300">{t.exit.toLocaleString('en-IN')}</td>
                          <td className={`py-1.5 px-2 font-mono font-bold ${t.pnl_pct >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{fmtPct(t.pnl_pct)}</td>
                          <td className={`py-1.5 px-2 font-bold text-[10px] ${t.result === 'WIN' ? 'text-emerald-400' : 'text-red-400'}`}>{t.result}</td>
                          <td className="py-1.5 px-2 text-slate-400">{t.setup_type}</td>
                          <td className={`py-1.5 px-2 font-bold ${t.score >= 7 ? 'text-emerald-400' : t.score >= 5 ? 'text-amber-400' : 'text-slate-400'}`}>{t.score}/10</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  )
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function HuddlestonStrategy() {
  const [signal, setSignal]   = useState<HuddlestonSignal | null>(null)
  const [backtest, setBacktest] = useState<BacktestResult | null>(null)
  const [sigLoading, setSigLoading]   = useState(true)
  const [btLoading, setBtLoading]     = useState(true)
  const [sigError, setSigError]       = useState('')
  const [btError, setBtError]         = useState('')
  const [years, setYears]   = useState(3)
  const [view, setView]     = useState<'signal' | 'backtest'>('signal')

  useEffect(() => {
    setSigLoading(true); setSigError('')
    axios.get('/api/naren/v1/nifty/huddleston-signal')
      .then(r => setSignal(r.data))
      .catch(e => setSigError(e?.response?.data?.error ?? 'Failed to fetch signal'))
      .finally(() => setSigLoading(false))
  }, [])

  useEffect(() => {
    setBtLoading(true); setBtError(''); setBacktest(null)
    axios.get('/api/naren/v1/nifty/huddleston-backtest', { params: { years } })
      .then(r => setBacktest(r.data.result ?? r.data))
      .catch(e => setBtError(e?.response?.data?.error ?? 'Backtest failed'))
      .finally(() => setBtLoading(false))
  }, [years])

  return (
    <div className="max-w-screen-xl mx-auto px-4 sm:px-6 py-8">

      {/* Header */}
      <div className="mb-6">
        <div className="flex items-center gap-3 mb-1">
          <h1 className="text-2xl font-bold text-white">Michael J. Huddleston (ICT) Strategy</h1>
          <span className="text-xs bg-brand-600/20 border border-brand-600/30 text-brand-400 px-2 py-0.5 rounded-lg">Nifty 50</span>
        </div>
        <p className="text-slate-500 text-sm">
          7-pillar PD array model — Breaker Blocks · Displacement · Power of 3 · PDH/PDL · PWHL/PWLL · Silver Bullet · Inducement
        </p>
      </div>

      {/* View toggle */}
      <div className="flex gap-1 bg-slate-800/60 rounded-xl p-1 w-fit mb-6">
        {(['signal', 'backtest'] as const).map(v => (
          <button key={v} onClick={() => setView(v)}
            className={`px-5 py-2 rounded-lg text-sm font-medium transition-all capitalize ${view === v ? 'bg-brand-600 text-white shadow' : 'text-slate-400 hover:text-white'}`}>
            {v === 'signal' ? '📡 Live Signal' : '📊 Backtest'}
          </button>
        ))}
      </div>

      {/* ICT Killzone Info */}
      <div className="bg-slate-800/30 border border-slate-700/60 rounded-xl p-3 mb-6">
        <div className="flex flex-wrap gap-4 text-xs">
          <span className="text-slate-500 font-medium">ICT Killzones (IST):</span>
          {[
            { name: 'Asian', time: '11:30 PM – 2:30 AM', color: 'text-slate-400' },
            { name: 'London Open', time: '7:30 – 10:30 AM', color: 'text-blue-400' },
            { name: 'NSE Open (Silver Bullet)', time: '9:15 – 11:00 AM', color: 'text-emerald-400' },
            { name: 'NY Open', time: '12:30 – 3:30 PM', color: 'text-amber-400' },
            { name: 'NSE Afternoon (Silver Bullet)', time: '1:30 – 3:00 PM', color: 'text-purple-400' },
          ].map(k => (
            <span key={k.name} className={`${k.color} font-medium`}>{k.name} <span className="text-slate-600">({k.time})</span></span>
          ))}
        </div>
      </div>

      {/* Content */}
      {view === 'signal' && (
        sigLoading ? <LoadingSpinner size="lg" text="Computing ICT PD arrays..." />
        : sigError ? <div className="bg-red-500/10 border border-red-500/30 rounded-xl p-4 text-red-400 text-sm">{sigError}</div>
        : signal ? <SignalPanel sig={signal} />
        : null
      )}

      {view === 'backtest' && (
        <BacktestPanel
          res={btLoading ? null : backtest}
          years={years}
          setYears={setYears}
        />
      )}

      <div className="text-xs text-slate-600 text-center mt-8">
        Strategy based on Michael J. Huddleston's Inner Circle Trader (ICT) concepts. Backtested on Nifty 50 daily data.
        Not financial advice — always use proper risk management.
      </div>
    </div>
  )
}
