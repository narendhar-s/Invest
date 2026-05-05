import { useEffect, useState } from 'react'
import {
  getScalpingBacktest,
  type ScalpBacktestReport,
  type ScalpStrategyResult,
  type YearlyResult,
} from '../api/client'
import LoadingSpinner from '../components/LoadingSpinner'

// ── Helpers ───────────────────────────────────────────────────────────────────

function pct(n: number, dec = 1) {
  return (n >= 0 ? '+' : '') + n.toFixed(dec) + '%'
}

function pctColor(n: number) {
  return n > 0 ? 'text-emerald-400' : n < 0 ? 'text-red-400' : 'text-slate-400'
}

function winRateColor(n: number) {
  if (n >= 75) return 'text-emerald-400'
  if (n >= 60) return 'text-amber-400'
  return 'text-red-400'
}

function pfColor(n: number) {
  if (n >= 2.0) return 'text-emerald-400'
  if (n >= 1.2) return 'text-amber-400'
  return 'text-red-400'
}

// ── Strategy Card ─────────────────────────────────────────────────────────────

function StrategyCard({ s, rank }: { s: ScalpStrategyResult; rank: number }) {
  const [showTrades, setShowTrades] = useState(false)
  const [showYearly, setShowYearly] = useState(false)

  const isTop = rank === 1

  return (
    <div className={`bg-dark-700 border rounded-xl p-5 transition-all ${isTop ? 'border-emerald-600/50 shadow-lg shadow-emerald-900/20' : 'border-slate-800/60'}`}>
      {/* Header */}
      <div className="flex items-start justify-between mb-4">
        <div>
          <div className="flex items-center gap-2 mb-1">
            {isTop && <span className="text-xs bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 px-2 py-0.5 rounded font-bold">#1 BEST</span>}
            <span className={`text-xs font-bold px-2 py-0.5 rounded ${
              s.win_rate >= 75 ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30' :
              s.win_rate >= 60 ? 'bg-amber-500/15 text-amber-400 border border-amber-500/30' :
              'bg-red-500/10 text-red-400 border border-red-500/20'
            }`}>
              {s.win_rate.toFixed(1)}% Win Rate
            </span>
          </div>
          <h3 className="text-white font-bold text-base">{s.strategy_name}</h3>
          <p className="text-xs text-slate-500 mt-0.5 leading-relaxed max-w-md">{s.description}</p>
        </div>
        <div className="text-right shrink-0 ml-4">
          <div className={`text-2xl font-bold font-mono ${winRateColor(s.win_rate)}`}>{s.win_rate.toFixed(1)}%</div>
          <div className="text-xs text-slate-500">win rate</div>
        </div>
      </div>

      {/* Main metrics grid */}
      <div className="grid grid-cols-4 sm:grid-cols-8 gap-2 mb-4">
        {[
          { label: 'Trades',      value: s.total_trades.toString(),         color: 'text-white' },
          { label: 'Wins',        value: s.winning_trades.toString(),        color: 'text-emerald-400' },
          { label: 'Losses',      value: s.losing_trades.toString(),         color: 'text-red-400' },
          { label: 'P.Factor',    value: s.profit_factor.toFixed(2),         color: pfColor(s.profit_factor) },
          { label: 'Net P&L',     value: pct(s.net_pnl_pct),                color: pctColor(s.net_pnl_pct) },
          { label: 'Max DD',      value: '-' + s.max_drawdown_pct.toFixed(1) + '%', color: 'text-red-400' },
          { label: 'Sharpe',      value: s.sharpe_ratio.toFixed(2),          color: s.sharpe_ratio > 1 ? 'text-emerald-400' : 'text-amber-400' },
          { label: 'Expect./tr', value: pct(s.expectancy_pct, 2),           color: pctColor(s.expectancy_pct) },
        ].map(m => (
          <div key={m.label} className="bg-dark-800/60 rounded-lg p-2 text-center">
            <div className="text-xs text-slate-500 mb-0.5">{m.label}</div>
            <div className={`text-xs font-bold font-mono ${m.color}`}>{m.value}</div>
          </div>
        ))}
      </div>

      {/* Avg win/loss */}
      <div className="flex gap-3 mb-4">
        <div className="flex-1 bg-emerald-500/10 border border-emerald-500/20 rounded-lg p-2 text-center">
          <div className="text-xs text-slate-500">Avg Win</div>
          <div className="text-sm font-bold font-mono text-emerald-400">{pct(s.avg_win_pct, 2)}</div>
        </div>
        <div className="flex-1 bg-red-500/10 border border-red-500/20 rounded-lg p-2 text-center">
          <div className="text-xs text-slate-500">Avg Loss</div>
          <div className="text-sm font-bold font-mono text-red-400">-{s.avg_loss_pct.toFixed(2)}%</div>
        </div>
        <div className="flex-1 bg-dark-800/40 border border-slate-800/40 rounded-lg p-2 text-center">
          <div className="text-xs text-slate-500">Best</div>
          <div className="text-sm font-bold font-mono text-emerald-300">{pct(s.best_trade_pct, 2)}</div>
        </div>
        <div className="flex-1 bg-dark-800/40 border border-slate-800/40 rounded-lg p-2 text-center">
          <div className="text-xs text-slate-500">Worst</div>
          <div className="text-sm font-bold font-mono text-red-300">{pct(s.worst_trade_pct, 2)}</div>
        </div>
      </div>

      {/* Win rate bar */}
      <div className="mb-4">
        <div className="flex justify-between text-xs mb-1">
          <span className="text-slate-500">Win Rate</span>
          <span className={winRateColor(s.win_rate)}>{s.win_rate.toFixed(1)}% ({s.winning_trades}W / {s.losing_trades}L)</span>
        </div>
        <div className="w-full bg-dark-800 rounded-full h-2">
          <div className={`h-2 rounded-full transition-all ${s.win_rate >= 75 ? 'bg-emerald-500' : s.win_rate >= 60 ? 'bg-amber-500' : 'bg-red-500'}`}
            style={{ width: `${Math.min(s.win_rate, 100)}%` }} />
        </div>
      </div>

      {/* Yearly breakdown toggle */}
      <div className="flex gap-2">
        <button onClick={() => setShowYearly(v => !v)}
          className="text-xs text-brand-400 hover:text-brand-300 border border-brand-600/30 px-3 py-1.5 rounded-lg">
          {showYearly ? 'Hide' : 'Show'} Yearly Breakdown
        </button>
        <button onClick={() => setShowTrades(v => !v)}
          className="text-xs text-slate-400 hover:text-slate-200 border border-slate-700 px-3 py-1.5 rounded-lg">
          {showTrades ? 'Hide' : 'Show'} Recent Trades
        </button>
      </div>

      {/* Yearly breakdown */}
      {showYearly && s.yearly_breakdown && s.yearly_breakdown.length > 0 && (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-slate-500 border-b border-slate-800/60">
                {['Year', 'Trades', 'Win Rate', 'Net P&L', 'Profit Factor'].map(h => (
                  <th key={h} className="px-2 py-2 text-left">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {s.yearly_breakdown.map((y: YearlyResult) => (
                <tr key={y.year} className="border-b border-slate-800/20 hover:bg-dark-600/30">
                  <td className="px-2 py-1.5 font-bold text-white">{y.year}</td>
                  <td className="px-2 py-1.5 text-slate-300">{y.trades}</td>
                  <td className={`px-2 py-1.5 font-bold ${winRateColor(y.win_rate)}`}>{y.win_rate.toFixed(1)}%</td>
                  <td className={`px-2 py-1.5 font-bold font-mono ${pctColor(y.net_pnl_pct)}`}>{pct(y.net_pnl_pct)}</td>
                  <td className={`px-2 py-1.5 font-bold font-mono ${pfColor(y.profit_factor)}`}>{y.profit_factor.toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Recent trades */}
      {showTrades && s.recent_trades && s.recent_trades.length > 0 && (
        <div className="mt-3 overflow-x-auto">
          <div className="text-xs text-slate-500 mb-1">Last {s.recent_trades.length} trades</div>
          <table className="w-full text-xs">
            <thead>
              <tr className="text-slate-500 border-b border-slate-800/60">
                {['Date', 'Dir', 'Entry', 'Exit', 'P&L', 'Exit Reason'].map(h => (
                  <th key={h} className="px-2 py-1.5 text-left">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {s.recent_trades.map((t, i) => (
                <tr key={i} className={`border-b border-slate-800/10 ${t.is_win ? 'bg-emerald-900/5' : 'bg-red-900/5'}`}>
                  <td className="px-2 py-1 text-slate-400">{t.date?.slice(0, 10)}</td>
                  <td className={`px-2 py-1 font-bold ${t.direction === 'BUY' ? 'text-emerald-400' : 'text-red-400'}`}>{t.direction}</td>
                  <td className="px-2 py-1 font-mono text-slate-300">{t.entry_price.toFixed(2)}</td>
                  <td className="px-2 py-1 font-mono text-slate-300">{t.exit_price.toFixed(2)}</td>
                  <td className={`px-2 py-1 font-bold font-mono ${pctColor(t.pnl_pct)}`}>{pct(t.pnl_pct, 2)}</td>
                  <td className={`px-2 py-1 text-xs ${t.exit_reason === 'TARGET' ? 'text-emerald-400' : t.exit_reason === 'STOP' ? 'text-red-400' : 'text-slate-500'}`}>{t.exit_reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

// ── Comparison Table ──────────────────────────────────────────────────────────

function ComparisonTable({ strategies }: { strategies: ScalpStrategyResult[] }) {
  const sorted = [...strategies].sort((a, b) => b.win_rate - a.win_rate)
  return (
    <div className="bg-dark-700 border border-slate-800/60 rounded-xl overflow-hidden mb-6">
      <div className="px-5 py-3 border-b border-slate-800/60">
        <h3 className="text-sm font-semibold text-white">Strategy Comparison (sorted by Win Rate)</h3>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs text-slate-500 border-b border-slate-800/60">
              {['#', 'Strategy', 'Win Rate', 'Trades', 'Profit Factor', 'Net P&L', 'Max Drawdown', 'Sharpe', 'Avg/Trade'].map(h => (
                <th key={h} className="px-4 py-3 text-left whitespace-nowrap">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.map((s, i) => (
              <tr key={s.strategy_name} className={`border-b border-slate-800/20 hover:bg-dark-600/40 ${i === 0 ? 'bg-emerald-900/10' : ''}`}>
                <td className="px-4 py-3 font-bold text-slate-400">{i === 0 ? '🏆' : i + 1}</td>
                <td className="px-4 py-3 font-semibold text-white whitespace-nowrap">{s.strategy_name}</td>
                <td className={`px-4 py-3 font-bold text-lg ${winRateColor(s.win_rate)}`}>{s.win_rate.toFixed(1)}%</td>
                <td className="px-4 py-3 text-slate-300">{s.total_trades}</td>
                <td className={`px-4 py-3 font-bold ${pfColor(s.profit_factor)}`}>{s.profit_factor.toFixed(2)}</td>
                <td className={`px-4 py-3 font-bold font-mono ${pctColor(s.net_pnl_pct)}`}>{pct(s.net_pnl_pct)}</td>
                <td className="px-4 py-3 text-red-400">-{s.max_drawdown_pct.toFixed(1)}%</td>
                <td className={`px-4 py-3 font-bold ${s.sharpe_ratio > 1 ? 'text-emerald-400' : 'text-amber-400'}`}>{s.sharpe_ratio.toFixed(2)}</td>
                <td className={`px-4 py-3 font-mono ${pctColor(s.expectancy_pct)}`}>{pct(s.expectancy_pct, 2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ── Main Page ─────────────────────────────────────────────────────────────────

const SYMBOLS = [
  { symbol: '^NSEI', label: 'NIFTY 50' },
  { symbol: '^NSEBANK', label: 'BANK NIFTY' },
]

export default function BacktestDashboard() {
  const [report, setReport] = useState<ScalpBacktestReport | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [symbol, setSymbol] = useState('^NSEI')
  const [years, setYears] = useState(5)

  const fetchReport = () => {
    setLoading(true)
    setError(null)
    getScalpingBacktest(symbol, years)
      .then(setReport)
      .catch(e => setError(e.message))
      .finally(() => setLoading(false))
  }

  useEffect(() => { fetchReport() }, [symbol, years])

  return (
    <div className="max-w-screen-2xl mx-auto px-4 sm:px-6 py-8">
      {/* Header */}
      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-white flex items-center gap-2">
            📊 Scalping Backtest Dashboard
          </h1>
          <p className="text-slate-500 text-sm mt-1">
            Historical strategy performance on NIFTY index — win rates, profit factors & per-year breakdown.
            All strategies tested on daily OHLCV bars (each bar = one trading session).
          </p>
        </div>
        <button onClick={fetchReport} className="text-xs text-brand-400 border border-brand-600/30 px-3 py-1.5 rounded-lg hover:bg-brand-600/10">
          ↻ Re-run
        </button>
      </div>

      {/* Controls */}
      <div className="flex gap-3 mb-6 flex-wrap">
        <div className="flex gap-1 bg-dark-800 rounded-xl p-1">
          {SYMBOLS.map(s => (
            <button key={s.symbol} onClick={() => setSymbol(s.symbol)}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition-all ${symbol === s.symbol ? 'bg-brand-600 text-white' : 'text-slate-400 hover:text-slate-200'}`}>
              {s.label}
            </button>
          ))}
        </div>
        <div className="flex gap-1 bg-dark-800 rounded-xl p-1">
          {[3, 5, 7].map(y => (
            <button key={y} onClick={() => setYears(y)}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition-all ${years === y ? 'bg-brand-600 text-white' : 'text-slate-400 hover:text-slate-200'}`}>
              {y}Y
            </button>
          ))}
        </div>
      </div>

      {loading && <LoadingSpinner size="lg" text={`Running ${years}-year backtest on ${symbol === '^NSEI' ? 'NIFTY 50' : 'BANK NIFTY'}...`} />}
      {error && (
        <div className="text-center py-12">
          <div className="text-red-400 text-lg mb-2">Backtest failed</div>
          <div className="text-slate-500 text-sm">{error}</div>
          <div className="text-slate-600 text-xs mt-2">Data pipeline must complete first. Check back in 10–15 minutes.</div>
        </div>
      )}

      {report && !loading && (
        <>
          {/* Summary */}
          <div className="bg-dark-700 border border-slate-800/60 rounded-xl p-5 mb-6">
            <div className="flex items-center gap-3 mb-4">
              <span className="text-2xl">🎯</span>
              <div>
                <h2 className="text-lg font-bold text-white">Backtest Summary — {report.symbol_name || report.symbol}</h2>
                <p className="text-xs text-slate-500">{report.period_years}-year period · {report.data_points} trading days · Generated {new Date(report.generated_at).toLocaleString()}</p>
              </div>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
              <div className="bg-dark-800/60 rounded-xl p-4">
                <div className="text-xs text-slate-500 mb-1">Best Win Rate</div>
                <div className={`text-2xl font-bold ${winRateColor(report.summary.best_win_rate_value)}`}>{report.summary.best_win_rate_value.toFixed(1)}%</div>
                <div className="text-xs text-slate-400 mt-1 truncate">{report.summary.best_win_rate_strategy}</div>
              </div>
              <div className="bg-dark-800/60 rounded-xl p-4">
                <div className="text-xs text-slate-500 mb-1">Best Profit Factor</div>
                <div className={`text-2xl font-bold ${pfColor(report.summary.best_profit_factor_value)}`}>{report.summary.best_profit_factor_value.toFixed(2)}x</div>
                <div className="text-xs text-slate-400 mt-1 truncate">{report.summary.best_profit_factor_strategy}</div>
              </div>
              <div className="bg-dark-800/60 rounded-xl p-4">
                <div className="text-xs text-slate-500 mb-1">Overall Win Rate</div>
                <div className={`text-2xl font-bold ${winRateColor(report.summary.overall_win_rate)}`}>{report.summary.overall_win_rate.toFixed(1)}%</div>
                <div className="text-xs text-slate-400 mt-1">{report.summary.total_signals} total signals</div>
              </div>
              <div className="bg-dark-800/60 rounded-xl p-4">
                <div className="text-xs text-slate-500 mb-1">Best Net P&L</div>
                <div className={`text-2xl font-bold ${pctColor(report.summary.best_net_pnl_value)}`}>{pct(report.summary.best_net_pnl_value)}</div>
                <div className="text-xs text-slate-400 mt-1 truncate">{report.summary.best_net_pnl_strategy}</div>
              </div>
            </div>
            <div className={`border rounded-xl p-3 text-sm ${
              report.summary.best_win_rate_value >= 75 ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300' :
              report.summary.best_win_rate_value >= 60 ? 'bg-amber-500/10 border-amber-500/30 text-amber-300' :
              'bg-red-500/10 border-red-500/30 text-red-300'
            }`}>
              {report.summary.recommendation}
            </div>
          </div>

          {/* Comparison table */}
          <ComparisonTable strategies={report.strategies} />

          {/* Individual strategy cards — sorted by win rate */}
          <div className="space-y-4">
            <h2 className="text-lg font-bold text-white">Detailed Strategy Analysis</h2>
            {[...report.strategies]
              .sort((a, b) => b.win_rate - a.win_rate)
              .map((s, i) => (
                <StrategyCard key={s.strategy_name} s={s} rank={i + 1} />
              ))
            }
          </div>

          {/* Disclaimer */}
          <div className="mt-8 bg-dark-700 border border-slate-800/40 rounded-xl p-4 text-xs text-slate-500 leading-relaxed">
            <span className="text-amber-400 font-bold">⚠️ Disclaimer: </span>
            Backtest results use daily bars as a proxy for intraday scalping sessions. Entry = next-day open,
            exit = target/stop hit or EOD close. Actual intraday results may vary. Past performance does not
            guarantee future results. Results do not include brokerage costs beyond 0.05% commission per side.
            SEBI regulations apply to all trades. Always trade within your risk tolerance.
          </div>
        </>
      )}
    </div>
  )
}
