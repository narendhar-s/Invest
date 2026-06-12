import { useEffect, useState } from 'react'
import {
  getSMCFVGVWAPBacktest,
  type SMCFVGVWAPBacktestResult,
  type SMCFVGVWAPTrade,
  type SMCFVGVWAPYearlyResult,
} from '../api/client'

// ─── Helpers ──────────────────────────────────────────────────────────────────

const fmt  = (n: number, d = 0) =>
  n?.toLocaleString('en-IN', { maximumFractionDigits: d, minimumFractionDigits: d }) ?? '—'
const fmtP = (n: number) => (n >= 0 ? '+' : '') + n?.toFixed(1) + '%'
const fmtD = (iso: string) => new Date(iso).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: '2-digit' })

function Badge({ label, color }: { label: string; color: string }) {
  return (
    <span className={`px-2 py-0.5 rounded text-xs font-bold tracking-wide ${color}`}>{label}</span>
  )
}

function StatCard({
  label, value, sub, color = 'text-white',
}: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <div className="bg-dark-800 border border-slate-800 rounded-xl p-4 flex flex-col gap-1">
      <div className="text-xs text-slate-500 uppercase tracking-wide">{label}</div>
      <div className={`text-2xl font-bold font-mono ${color}`}>{value}</div>
      {sub && <div className="text-xs text-slate-500">{sub}</div>}
    </div>
  )
}

function WinBar({ wr, label }: { wr: number; label: string }) {
  const color = wr >= 65 ? 'bg-emerald-500' : wr >= 52 ? 'bg-amber-500' : 'bg-red-500'
  const text  = wr >= 65 ? 'text-emerald-400' : wr >= 52 ? 'text-amber-400' : 'text-red-400'
  return (
    <div className="space-y-1">
      <div className="flex justify-between text-xs">
        <span className="text-slate-400">{label}</span>
        <span className={`font-mono font-bold ${text}`}>{wr.toFixed(1)}%</span>
      </div>
      <div className="h-2 bg-slate-800 rounded-full overflow-hidden">
        <div className={`h-full rounded-full transition-all duration-700 ${color}`} style={{ width: `${Math.min(wr, 100)}%` }} />
      </div>
    </div>
  )
}

// ─── Yearly Breakdown Table ───────────────────────────────────────────────────

function YearlyTable({ rows }: { rows: SMCFVGVWAPYearlyResult[] }) {
  if (!rows?.length) return null
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-slate-800">
            {['Year', 'Trades', 'Win Rate', 'Option P&L', 'Profit Factor', 'Max DD'].map(h => (
              <th key={h} className="text-left text-xs text-slate-500 uppercase pb-2 pr-4">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.year} className="border-b border-slate-800/50 hover:bg-slate-800/30">
              <td className="py-2 pr-4 font-mono text-slate-300">{r.year}</td>
              <td className="py-2 pr-4 font-mono text-white">{r.trades}</td>
              <td className="py-2 pr-4">
                <span className={`font-mono font-bold ${r.win_rate >= 65 ? 'text-emerald-400' : r.win_rate >= 52 ? 'text-amber-400' : 'text-red-400'}`}>
                  {r.win_rate.toFixed(1)}%
                </span>
              </td>
              <td className="py-2 pr-4">
                <span className={`font-mono font-bold ${r.option_net_pnl_pct >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                  {fmtP(r.option_net_pnl_pct)}
                </span>
              </td>
              <td className="py-2 pr-4 font-mono text-amber-300">{r.profit_factor.toFixed(2)}</td>
              <td className="py-2 pr-4 font-mono text-red-400">{r.max_drawdown_pct.toFixed(1)}%</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ─── Recent Trades Table ──────────────────────────────────────────────────────

function TradesTable({ trades }: { trades: SMCFVGVWAPTrade[] }) {
  if (!trades?.length) return null
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-slate-800">
            {['Date', 'Type', 'Entry', 'Target', 'Stop', 'Exit', 'Spot P&L', 'Option P&L', 'Reason', 'VWAP', 'ATR'].map(h => (
              <th key={h} className="text-left text-slate-500 uppercase pb-2 pr-3 whitespace-nowrap">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {[...trades].reverse().map((t, i) => (
            <tr key={i} className={`border-b border-slate-800/40 hover:bg-slate-800/20 ${t.is_win ? 'bg-emerald-950/20' : 'bg-red-950/10'}`}>
              <td className="py-1.5 pr-3 text-slate-400 whitespace-nowrap">{fmtD(t.date)}</td>
              <td className="py-1.5 pr-3">
                <span className={`font-bold ${t.option_type === 'CE' ? 'text-emerald-400' : 'text-red-400'}`}>
                  {t.option_type}
                </span>
              </td>
              <td className="py-1.5 pr-3 font-mono">{fmt(t.spot_entry, 0)}</td>
              <td className="py-1.5 pr-3 font-mono text-emerald-300">{fmt(t.spot_target, 0)}</td>
              <td className="py-1.5 pr-3 font-mono text-red-300">{fmt(t.spot_stop, 0)}</td>
              <td className="py-1.5 pr-3 font-mono text-slate-300">{fmt(t.spot_exit, 0)}</td>
              <td className="py-1.5 pr-3">
                <span className={`font-mono font-bold ${t.spot_pnl_pct >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                  {fmtP(t.spot_pnl_pct)}
                </span>
              </td>
              <td className="py-1.5 pr-3">
                <span className={`font-mono font-bold text-sm ${t.option_pnl_pct >= 0 ? 'text-emerald-300' : 'text-red-300'}`}>
                  {fmtP(t.option_pnl_pct)}
                </span>
              </td>
              <td className="py-1.5 pr-3">
                <span className={`px-1.5 py-0.5 rounded text-xs font-bold ${
                  t.exit_reason === 'TARGET' ? 'bg-emerald-900/50 text-emerald-300' :
                  t.exit_reason === 'STOP'   ? 'bg-red-900/50 text-red-300' :
                                               'bg-slate-700 text-slate-300'
                }`}>{t.exit_reason}</span>
              </td>
              <td className="py-1.5 pr-3 font-mono text-blue-300">{fmt(t.vwap_level, 0)}</td>
              <td className="py-1.5 pr-3 font-mono text-slate-400">{fmt(t.atr, 0)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ─── Strategy Logic Explanation ───────────────────────────────────────────────

function StrategyExplainer() {
  const steps = [
    {
      icon: '📊',
      title: '15-Min HTF Context',
      desc: 'Identify market structure using swing highs/lows over the last 20 bars. HH+HL = BULL bias. LH+LL = BEAR bias.',
      color: 'border-blue-700/40 bg-blue-950/20',
    },
    {
      icon: '〰️',
      title: 'VWAP Alignment',
      desc: 'Compute 20-bar volume-weighted average price. Only take BULL setups when close > VWAP and BEAR setups when close < VWAP.',
      color: 'border-violet-700/40 bg-violet-950/20',
    },
    {
      icon: '⚡',
      title: 'FVG Detection',
      desc: 'Find an unfilled Fair Value Gap (3-candle imbalance) within the last 8 bars that aligns with HTF bias.',
      color: 'border-amber-700/40 bg-amber-950/20',
    },
    {
      icon: '🎯',
      title: '5-Min Entry Trigger',
      desc: 'Price retests into the FVG zone on the entry bar. Must close above FVG mid (BULL) or below FVG mid (BEAR).',
      color: 'border-emerald-700/40 bg-emerald-950/20',
    },
    {
      icon: '🏦',
      title: 'Options Buy',
      desc: 'Buy ATM weekly CE (BULL) or PE (BEAR). Target: 1.8×ATR spot move → +55% premium. Stop: 0.6×ATR → –32% premium.',
      color: 'border-fuchsia-700/40 bg-fuchsia-950/20',
    },
  ]
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
      {steps.map((s, i) => (
        <div key={i} className={`border rounded-xl p-3 ${s.color}`}>
          <div className="text-2xl mb-1">{s.icon}</div>
          <div className="text-xs font-bold text-slate-200 mb-1">Step {i + 1}: {s.title}</div>
          <div className="text-xs text-slate-400 leading-relaxed">{s.desc}</div>
        </div>
      ))}
    </div>
  )
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function SMCFVGVWAPBacktest() {
  const [data,    setData]    = useState<SMCFVGVWAPBacktestResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [years,   setYears]   = useState(3)
  const [error,   setError]   = useState('')

  const run = async (y = years) => {
    setLoading(true)
    setError('')
    try {
      const result = await getSMCFVGVWAPBacktest(y)
      setData(result)
    } catch (e: any) {
      setError(e?.response?.data?.error ?? 'Failed to run backtest')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { run(3) }, []) // eslint-disable-line

  const d = data

  return (
    <div className="max-w-7xl mx-auto px-4 py-6 space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-white">SMC + FVG + VWAP Backtest</h1>
          <p className="text-sm text-slate-400 mt-1">
            15-min structure analysis → 5-min entry → ATM options buying (NIFTY 50)
          </p>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex gap-1 bg-dark-800 border border-slate-800 rounded-lg p-1">
            {[1, 2, 3].map(y => (
              <button
                key={y}
                onClick={() => { setYears(y); run(y) }}
                className={`px-3 py-1.5 rounded text-sm font-semibold transition-colors ${
                  years === y
                    ? 'bg-blue-600 text-white'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >{y}Y</button>
            ))}
          </div>
          <button
            onClick={() => run(years)}
            disabled={loading}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white font-semibold rounded-lg text-sm transition-colors"
          >
            {loading ? 'Running…' : '▶ Run Backtest'}
          </button>
        </div>
      </div>

      {/* Strategy Explainer */}
      <StrategyExplainer />

      {error && (
        <div className="bg-red-900/30 border border-red-700/40 rounded-xl p-4 text-red-300 text-sm">{error}</div>
      )}

      {loading && (
        <div className="text-center py-16 text-slate-400">
          <div className="text-4xl mb-3 animate-pulse">⚙️</div>
          <div>Running {years}-year backtest on NIFTY 50…</div>
        </div>
      )}

      {d && !loading && (
        <>
          {/* Recommendation Banner */}
          <div className={`rounded-xl border p-4 text-sm ${
            d.win_rate >= 70 ? 'border-emerald-700/50 bg-emerald-950/30 text-emerald-200' :
            d.win_rate >= 60 ? 'border-amber-700/50 bg-amber-950/30 text-amber-200' :
                               'border-red-700/50 bg-red-950/30 text-red-200'
          }`}>
            <span className="font-bold mr-2">{d.win_rate >= 70 ? '✅' : d.win_rate >= 60 ? '⚠️' : '❌'}</span>
            {d.recommendation}
          </div>

          {/* Core Stats Grid */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
            <StatCard
              label="Win Rate"
              value={d.win_rate.toFixed(1) + '%'}
              sub={`${d.winning_trades}W / ${d.losing_trades}L`}
              color={d.win_rate >= 65 ? 'text-emerald-400' : d.win_rate >= 52 ? 'text-amber-400' : 'text-red-400'}
            />
            <StatCard
              label="Profit Factor"
              value={d.profit_factor.toFixed(2) + 'x'}
              sub="gross win / gross loss"
              color={d.profit_factor >= 2 ? 'text-emerald-400' : d.profit_factor >= 1.3 ? 'text-amber-400' : 'text-red-400'}
            />
            <StatCard
              label="Option Net P&L"
              value={fmtP(d.option_net_pnl_pct)}
              sub="cumulative premium %"
              color={d.option_net_pnl_pct >= 0 ? 'text-emerald-400' : 'text-red-400'}
            />
            <StatCard
              label="Total Trades"
              value={String(d.total_trades)}
              sub={`${d.avg_trades_per_month.toFixed(1)} / month`}
            />
            <StatCard
              label="Max Drawdown"
              value={d.max_drawdown_pct.toFixed(1) + '%'}
              sub="on cumulative premium"
              color={d.max_drawdown_pct <= 20 ? 'text-emerald-400' : d.max_drawdown_pct <= 40 ? 'text-amber-400' : 'text-red-400'}
            />
            <StatCard
              label="Sharpe Ratio"
              value={d.sharpe_ratio.toFixed(2)}
              sub="annualised"
              color={d.sharpe_ratio >= 1.5 ? 'text-emerald-400' : d.sharpe_ratio >= 0.8 ? 'text-amber-400' : 'text-red-400'}
            />
          </div>

          {/* Secondary Stats */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <StatCard label="Avg Win" value={fmtP(d.avg_win_pct)} sub="per winning trade" color="text-emerald-400" />
            <StatCard label="Avg Loss" value={'-' + d.avg_loss_pct.toFixed(1) + '%'} sub="per losing trade" color="text-red-400" />
            <StatCard label="Best Trade" value={fmtP(d.best_trade_pct)} sub="option premium" color="text-emerald-300" />
            <StatCard label="Worst Trade" value={fmtP(d.worst_trade_pct)} sub="option premium" color="text-red-300" />
          </div>

          {/* Win Rate Bars + Direction Analysis */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {/* Win Rate Visual */}
            <div className="bg-dark-800 border border-slate-800 rounded-xl p-5 space-y-4">
              <div className="text-sm font-semibold text-slate-300">Win Rate Overview</div>
              <WinBar wr={d.win_rate} label="Overall" />
              {d.by_direction && Object.entries(d.by_direction).map(([dir, ds]) => (
                <WinBar key={dir} wr={ds.win_rate} label={dir === 'BULL' ? 'CE Buys (BULL)' : 'PE Buys (BEAR)'} />
              ))}
            </div>

            {/* Direction Breakdown */}
            <div className="bg-dark-800 border border-slate-800 rounded-xl p-5 space-y-4">
              <div className="text-sm font-semibold text-slate-300">Direction Breakdown</div>
              <div className="space-y-3">
                {d.by_direction && Object.entries(d.by_direction).map(([dir, ds]) => {
                  const isBull = dir === 'BULL'
                  return (
                    <div key={dir} className={`rounded-lg border p-3 ${isBull ? 'border-emerald-700/40 bg-emerald-950/20' : 'border-red-700/40 bg-red-950/20'}`}>
                      <div className="flex items-center justify-between mb-2">
                        <span className={`text-sm font-bold ${isBull ? 'text-emerald-400' : 'text-red-400'}`}>
                          {isBull ? '🟢 CE Buys (BULL)' : '🔴 PE Buys (BEAR)'}
                        </span>
                        <Badge
                          label={ds.win_rate.toFixed(1) + '% WR'}
                          color={ds.win_rate >= 65 ? 'bg-emerald-900/50 text-emerald-300' : 'bg-amber-900/50 text-amber-300'}
                        />
                      </div>
                      <div className="grid grid-cols-3 gap-2 text-xs">
                        <div>
                          <div className="text-slate-500">Trades</div>
                          <div className="font-mono text-white">{ds.trades}</div>
                        </div>
                        <div>
                          <div className="text-slate-500">Wins</div>
                          <div className="font-mono text-emerald-300">{ds.wins}</div>
                        </div>
                        <div>
                          <div className="text-slate-500">Avg P&L</div>
                          <div className={`font-mono font-bold ${ds.avg_pnl_pct >= 0 ? 'text-emerald-300' : 'text-red-300'}`}>
                            {fmtP(ds.avg_pnl_pct)}
                          </div>
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          </div>

          {/* Exit Reason + Period Info */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            {/* Exit Reason Pie-like */}
            <div className="bg-dark-800 border border-slate-800 rounded-xl p-5">
              <div className="text-sm font-semibold text-slate-300 mb-4">Exit Breakdown</div>
              <div className="space-y-3">
                {d.by_exit_reason && Object.entries(d.by_exit_reason).map(([reason, count]) => {
                  const pct = (count / d.total_trades) * 100
                  const color = reason === 'TARGET' ? 'bg-emerald-500' : reason === 'STOP' ? 'bg-red-500' : 'bg-slate-500'
                  const text  = reason === 'TARGET' ? 'text-emerald-400' : reason === 'STOP' ? 'text-red-400' : 'text-slate-400'
                  return (
                    <div key={reason} className="space-y-1">
                      <div className="flex justify-between text-xs">
                        <span className={text}>{reason}</span>
                        <span className="font-mono text-slate-300">{count} ({pct.toFixed(0)}%)</span>
                      </div>
                      <div className="h-2 bg-slate-800 rounded-full overflow-hidden">
                        <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>

            {/* Risk Info */}
            <div className="bg-dark-800 border border-slate-800 rounded-xl p-5 space-y-3">
              <div className="text-sm font-semibold text-slate-300">Options Simulation Parameters</div>
              {[
                ['Instrument', 'ATM Weekly CE / PE'],
                ['Win (Target hit)', '+55% premium'],
                ['Loss (Stop hit)', '–32% premium'],
                ['Target (spot)', '1.8 × ATR'],
                ['Stop (spot)', '0.6 × ATR'],
                ['R:R on spot', '3.0 : 1'],
                ['Entry timeframe', '5-min retest of FVG'],
                ['Analysis timeframe', '15-min (20-bar proxy)'],
                ['VWAP period', '20 bars'],
                ['FVG lookback', '8 bars'],
              ].map(([k, v]) => (
                <div key={k} className="flex justify-between text-xs border-b border-slate-800/50 pb-1.5">
                  <span className="text-slate-500">{k}</span>
                  <span className="text-slate-200 font-mono">{v}</span>
                </div>
              ))}
            </div>

            {/* Data Info */}
            <div className="bg-dark-800 border border-slate-800 rounded-xl p-5 space-y-3">
              <div className="text-sm font-semibold text-slate-300">Backtest Info</div>
              {[
                ['Symbol', d.symbol_name || d.symbol],
                ['Period', `${d.period_years} years`],
                ['Total Bars', fmt(d.total_bars)],
                ['Signals Found', fmt(d.total_trades)],
                ['Avg Confluence', d.avg_confluence.toFixed(1) + ' / 3'],
                ['Generated', new Date(d.generated_at).toLocaleString('en-IN')],
              ].map(([k, v]) => (
                <div key={k} className="flex justify-between text-xs border-b border-slate-800/50 pb-1.5">
                  <span className="text-slate-500">{k}</span>
                  <span className="text-slate-200 font-mono">{v}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Yearly Breakdown */}
          {d.yearly_breakdown?.length > 0 && (
            <div className="bg-dark-800 border border-slate-800 rounded-xl p-5">
              <div className="text-sm font-semibold text-slate-300 mb-4">Year-by-Year Performance</div>
              <YearlyTable rows={d.yearly_breakdown} />
            </div>
          )}

          {/* Recent Trades */}
          {d.recent_trades?.length > 0 && (
            <div className="bg-dark-800 border border-slate-800 rounded-xl p-5">
              <div className="text-sm font-semibold text-slate-300 mb-4">
                Recent Trades (last {d.recent_trades.length})
              </div>
              <TradesTable trades={d.recent_trades} />
            </div>
          )}

          {/* Strategy Description */}
          <div className="bg-dark-800 border border-slate-800 rounded-xl p-5">
            <div className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">Strategy Description</div>
            <p className="text-sm text-slate-300 leading-relaxed">{d.strategy_description}</p>
            <div className="mt-3 p-3 bg-slate-900/50 rounded-lg">
              <p className="text-xs text-slate-400 leading-relaxed">
                <span className="text-amber-400 font-semibold">Note: </span>
                This backtest uses NIFTY 50 daily price bars as a proxy for 15-min + 5-min analysis.
                The multi-timeframe logic is simulated: the 20-bar HTF window represents 15-min structure,
                and the next bar serves as the 5-min entry trigger. Options P&L uses realistic ATM weekly
                parameters (delta ≈ 0.5, target +55% / stop –32%). Actual live trading results may vary.
              </p>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
