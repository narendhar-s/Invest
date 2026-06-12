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
  return n > 0 ? 'text-emerald-400' : n < 0 ? 'text-rose-400' : 'text-slate-400'
}
function winRateColor(n: number) {
  if (n >= 65) return 'text-emerald-400'
  if (n >= 55) return 'text-amber-400'
  return 'text-rose-400'
}
function winRateBg(n: number) {
  if (n >= 65) return 'bg-emerald-500'
  if (n >= 55) return 'bg-amber-500'
  return 'bg-rose-500'
}
function pfColor(n: number) {
  if (n >= 2.0) return 'text-emerald-400'
  if (n >= 1.3) return 'text-amber-400'
  return 'text-rose-400'
}
function riskBadge(wr: number) {
  if (wr >= 65) return { label: 'HIGH EDGE',   cls: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30' }
  if (wr >= 55) return { label: 'MODERATE',    cls: 'bg-amber-500/15  text-amber-400  border-amber-500/30' }
  return            { label: 'LOW EDGE',    cls: 'bg-rose-500/15   text-rose-400   border-rose-500/30' }
}

// ── Metric Cell ───────────────────────────────────────────────────────────────

function MetricCell({ label, value, color, sub }: { label: string; value: string; color: string; sub?: string }) {
  return (
    <div className="bg-dark-900/50 rounded-lg p-2.5 text-center">
      <div className="text-[10px] text-slate-500 mb-1 uppercase tracking-wide">{label}</div>
      <div className={`text-sm font-bold font-mono ${color}`}>{value}</div>
      {sub && <div className="text-[10px] text-slate-600 mt-0.5">{sub}</div>}
    </div>
  )
}

// ── Win-rate Progress Bar ─────────────────────────────────────────────────────

function WinBar({ value }: { value: number }) {
  return (
    <div className="w-full bg-dark-900/60 rounded-full h-1.5 overflow-hidden">
      <div
        className={`h-1.5 rounded-full transition-all ${winRateBg(value)}`}
        style={{ width: `${Math.min(value, 100)}%` }}
      />
    </div>
  )
}

// ── Strategy Card ─────────────────────────────────────────────────────────────

function StrategyCard({ s, rank }: { s: ScalpStrategyResult; rank: number }) {
  const [showYearly, setShowYearly] = useState(false)
  const [showTrades, setShowTrades] = useState(false)
  const badge = riskBadge(s.win_rate)
  const isTop = rank === 1

  return (
    <div className={`rounded-xl border transition-all ${
      isTop
        ? 'bg-gradient-to-br from-emerald-950/40 to-dark-800 border-emerald-600/40 shadow-lg shadow-emerald-900/20'
        : 'bg-dark-800 border-slate-800/60'
    }`}>
      {/* Card header */}
      <div className="px-5 pt-4 pb-3 border-b border-slate-800/40">
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1.5 flex-wrap">
              {isTop && (
                <span className="text-[11px] bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 px-2 py-0.5 rounded font-bold tracking-wide">
                  🏆 TOP STRATEGY
                </span>
              )}
              <span className={`text-[11px] font-bold px-2 py-0.5 rounded border ${badge.cls}`}>
                {badge.label}
              </span>
              <span className="text-[11px] text-slate-500 bg-dark-900/50 px-2 py-0.5 rounded border border-slate-800/60">
                #{rank}
              </span>
            </div>
            <h3 className="text-white font-bold text-sm leading-snug">{s.strategy_name}</h3>
            <p className="text-[11px] text-slate-500 mt-0.5 leading-relaxed line-clamp-2">{s.description}</p>
          </div>
          <div className="shrink-0 text-right">
            <div className={`text-3xl font-black font-mono leading-none ${winRateColor(s.win_rate)}`}>
              {s.win_rate.toFixed(1)}
              <span className="text-lg font-bold">%</span>
            </div>
            <div className="text-[11px] text-slate-500 mt-0.5">win rate</div>
            <div className="mt-1 w-16 ml-auto">
              <WinBar value={s.win_rate} />
            </div>
          </div>
        </div>
      </div>

      {/* Metrics grid */}
      <div className="px-5 py-3 grid grid-cols-4 sm:grid-cols-8 gap-2">
        <MetricCell label="Trades"    value={s.total_trades.toString()} color="text-white" />
        <MetricCell label="Wins"      value={s.winning_trades.toString()} color="text-emerald-400" />
        <MetricCell label="Losses"    value={s.losing_trades.toString()} color="text-rose-400" />
        <MetricCell label="P.Factor"  value={s.profit_factor.toFixed(2)} color={pfColor(s.profit_factor)} />
        <MetricCell label="Net P&L"   value={pct(s.net_pnl_pct)} color={pctColor(s.net_pnl_pct)} />
        <MetricCell label="Max DD"    value={`-${s.max_drawdown_pct.toFixed(1)}%`} color="text-rose-400" />
        <MetricCell label="Sharpe"    value={s.sharpe_ratio.toFixed(2)} color={s.sharpe_ratio > 1 ? 'text-emerald-400' : 'text-amber-400'} />
        <MetricCell label="Expect."   value={pct(s.expectancy_pct, 2)} color={pctColor(s.expectancy_pct)} />
      </div>

      {/* Avg win / loss / best / worst */}
      <div className="px-5 pb-3 grid grid-cols-4 gap-2">
        <div className="bg-emerald-950/40 border border-emerald-500/20 rounded-lg p-2 text-center">
          <div className="text-[10px] text-slate-500 mb-0.5">Avg Win</div>
          <div className="text-sm font-bold font-mono text-emerald-400">{pct(s.avg_win_pct, 2)}</div>
        </div>
        <div className="bg-rose-950/30 border border-rose-500/20 rounded-lg p-2 text-center">
          <div className="text-[10px] text-slate-500 mb-0.5">Avg Loss</div>
          <div className="text-sm font-bold font-mono text-rose-400">-{s.avg_loss_pct.toFixed(2)}%</div>
        </div>
        <div className="bg-dark-900/40 border border-slate-700/30 rounded-lg p-2 text-center">
          <div className="text-[10px] text-slate-500 mb-0.5">Best Trade</div>
          <div className="text-sm font-bold font-mono text-emerald-300">{pct(s.best_trade_pct, 2)}</div>
        </div>
        <div className="bg-dark-900/40 border border-slate-700/30 rounded-lg p-2 text-center">
          <div className="text-[10px] text-slate-500 mb-0.5">Worst Trade</div>
          <div className="text-sm font-bold font-mono text-rose-300">{pct(s.worst_trade_pct, 2)}</div>
        </div>
      </div>

      {/* Win-rate bar */}
      <div className="px-5 pb-3">
        <div className="flex justify-between text-[11px] mb-1">
          <span className="text-slate-500">Win rate distribution</span>
          <span className={winRateColor(s.win_rate)}>
            {s.winning_trades}W / {s.losing_trades}L / {s.total_trades} total
          </span>
        </div>
        <div className="w-full bg-dark-900/60 rounded-full h-2 overflow-hidden flex">
          <div className="bg-emerald-500 h-full transition-all" style={{ width: `${(s.winning_trades / s.total_trades) * 100}%` }} />
          <div className="bg-rose-500 h-full transition-all" style={{ width: `${(s.losing_trades / s.total_trades) * 100}%` }} />
        </div>
      </div>

      {/* Toggles */}
      <div className="px-5 pb-4 flex gap-2 flex-wrap">
        <button
          onClick={() => { setShowYearly(v => !v); setShowTrades(false) }}
          className={`text-[11px] px-3 py-1.5 rounded-lg border transition-colors ${
            showYearly ? 'bg-brand-600/20 text-brand-400 border-brand-600/40' : 'text-slate-400 border-slate-700/60 hover:text-slate-200'
          }`}
        >
          {showYearly ? '▲' : '▼'} Year-by-Year
        </button>
        <button
          onClick={() => { setShowTrades(v => !v); setShowYearly(false) }}
          className={`text-[11px] px-3 py-1.5 rounded-lg border transition-colors ${
            showTrades ? 'bg-slate-600/20 text-slate-300 border-slate-600/40' : 'text-slate-500 border-slate-700/60 hover:text-slate-300'
          }`}
        >
          {showTrades ? '▲' : '▼'} Recent Trades
        </button>
      </div>

      {/* Yearly breakdown */}
      {showYearly && s.yearly_breakdown?.length > 0 && (
        <div className="border-t border-slate-800/40 px-5 py-3">
          <div className="text-[11px] text-slate-500 mb-2 uppercase tracking-wide">Year-by-Year Performance</div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-slate-500 border-b border-slate-800/40">
                  {['Year', 'Trades', 'Win Rate', '', 'Net P&L', 'Profit Factor'].map((h, i) => (
                    <th key={i} className="px-2 py-2 text-left whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {s.yearly_breakdown.map((y: YearlyResult) => (
                  <tr key={y.year} className="border-b border-slate-800/20 hover:bg-dark-700/40">
                    <td className="px-2 py-2 font-bold text-white">{y.year}</td>
                    <td className="px-2 py-2 text-slate-400">{y.trades}</td>
                    <td className={`px-2 py-2 font-bold ${winRateColor(y.win_rate)}`}>{y.win_rate.toFixed(1)}%</td>
                    <td className="px-2 py-2 w-24">
                      <WinBar value={y.win_rate} />
                    </td>
                    <td className={`px-2 py-2 font-bold font-mono ${pctColor(y.net_pnl_pct)}`}>{pct(y.net_pnl_pct)}</td>
                    <td className={`px-2 py-2 font-bold font-mono ${pfColor(y.profit_factor)}`}>{y.profit_factor.toFixed(2)}x</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Recent trades */}
      {showTrades && s.recent_trades?.length > 0 && (
        <div className="border-t border-slate-800/40 px-5 py-3">
          <div className="text-[11px] text-slate-500 mb-2 uppercase tracking-wide">Last {s.recent_trades.length} Trades</div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-slate-500 border-b border-slate-800/40">
                  {['Date', 'Dir', 'Entry', 'Exit', 'P&L', 'Result'].map(h => (
                    <th key={h} className="px-2 py-1.5 text-left whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {s.recent_trades.map((t, i) => (
                  <tr key={i} className={`border-b border-slate-800/10 ${t.is_win ? 'bg-emerald-950/20' : 'bg-rose-950/10'}`}>
                    <td className="px-2 py-1.5 text-slate-400 font-mono">{t.date?.slice(0, 10)}</td>
                    <td className={`px-2 py-1.5 font-bold ${t.direction === 'BUY' ? 'text-emerald-400' : 'text-rose-400'}`}>{t.direction}</td>
                    <td className="px-2 py-1.5 font-mono text-slate-300">{t.entry_price.toFixed(2)}</td>
                    <td className="px-2 py-1.5 font-mono text-slate-300">{t.exit_price.toFixed(2)}</td>
                    <td className={`px-2 py-1.5 font-bold font-mono ${pctColor(t.pnl_pct)}`}>{pct(t.pnl_pct, 2)}</td>
                    <td className={`px-2 py-1.5 text-[11px] font-bold ${
                      t.exit_reason === 'TARGET' ? 'text-emerald-400' :
                      t.exit_reason === 'STOP'   ? 'text-rose-400'    : 'text-slate-500'
                    }`}>{t.exit_reason}</td>
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

// ── Comparison Table ──────────────────────────────────────────────────────────

function ComparisonTable({ strategies }: { strategies: ScalpStrategyResult[] }) {
  const sorted = [...strategies].sort((a, b) => b.win_rate - a.win_rate)
  const maxPnL = Math.max(...sorted.map(s => s.net_pnl_pct))

  return (
    <div className="bg-dark-800 border border-slate-800/60 rounded-xl overflow-hidden">
      <div className="px-5 py-3 border-b border-slate-800/60 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-white">Strategy Comparison</h3>
        <span className="text-[11px] text-slate-500">Ranked by win rate</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-[11px] text-slate-500 border-b border-slate-800/40 uppercase tracking-wide">
              <th className="px-4 py-3 text-left">#</th>
              <th className="px-4 py-3 text-left">Strategy</th>
              <th className="px-4 py-3 text-right">Win Rate</th>
              <th className="px-4 py-3 text-left w-28">   </th>
              <th className="px-4 py-3 text-right">Trades</th>
              <th className="px-4 py-3 text-right">P.Factor</th>
              <th className="px-4 py-3 text-right">Net P&L</th>
              <th className="px-4 py-3 text-right">Max DD</th>
              <th className="px-4 py-3 text-right">Sharpe</th>
              <th className="px-4 py-3 text-right">Expect.</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((s, i) => (
              <tr
                key={s.strategy_name}
                className={`border-b border-slate-800/20 hover:bg-dark-700/50 transition-colors ${i === 0 ? 'bg-emerald-950/20' : ''}`}
              >
                <td className="px-4 py-3 font-bold text-slate-400">
                  {i === 0 ? <span className="text-base">🏆</span> : <span className="text-slate-600">{i + 1}</span>}
                </td>
                <td className="px-4 py-3">
                  <span className="font-semibold text-white whitespace-nowrap">{s.strategy_name}</span>
                </td>
                <td className={`px-4 py-3 font-black text-right font-mono text-base ${winRateColor(s.win_rate)}`}>
                  {s.win_rate.toFixed(1)}%
                </td>
                <td className="px-4 py-3 w-28">
                  <WinBar value={s.win_rate} />
                </td>
                <td className="px-4 py-3 text-right text-slate-300">{s.total_trades}</td>
                <td className={`px-4 py-3 text-right font-bold ${pfColor(s.profit_factor)}`}>{s.profit_factor.toFixed(2)}x</td>
                <td className={`px-4 py-3 text-right font-bold font-mono ${pctColor(s.net_pnl_pct)}`}>
                  <div>{pct(s.net_pnl_pct)}</div>
                  <div className="h-1 mt-1 rounded-full bg-dark-900/60 overflow-hidden">
                    <div
                      className="h-full rounded-full bg-emerald-500 transition-all"
                      style={{ width: `${(s.net_pnl_pct / maxPnL) * 100}%` }}
                    />
                  </div>
                </td>
                <td className="px-4 py-3 text-right text-rose-400">-{s.max_drawdown_pct.toFixed(1)}%</td>
                <td className={`px-4 py-3 text-right font-bold ${s.sharpe_ratio > 1 ? 'text-emerald-400' : 'text-amber-400'}`}>
                  {s.sharpe_ratio.toFixed(2)}
                </td>
                <td className={`px-4 py-3 text-right font-mono ${pctColor(s.expectancy_pct)}`}>{pct(s.expectancy_pct, 2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ── Symbols & config ──────────────────────────────────────────────────────────

const SYMBOLS = [
  { symbol: '^NSEI',       label: 'NIFTY 50',   sector: 'Index' },
  { symbol: '^NSEBANK',    label: 'Bank Nifty',  sector: 'Index' },
  { symbol: 'HDFCBANK.NS', label: 'HDFC Bank',   sector: 'Banking' },
  { symbol: 'SBIN.NS',     label: 'SBI',          sector: 'Banking' },
  { symbol: 'INFY.NS',     label: 'Infosys',      sector: 'IT' },
  { symbol: 'RELIANCE.NS', label: 'Reliance',     sector: 'Energy' },
  { symbol: 'TATAMOTORS.NS', label: 'Tata Motors', sector: 'Auto' },
  { symbol: 'ITC.NS',      label: 'ITC',          sector: 'FMCG' },
  { symbol: 'SUNPHARMA.NS', label: 'Sun Pharma',  sector: 'Pharma' },
  { symbol: 'TATASTEEL.NS', label: 'Tata Steel',  sector: 'Metal' },
  { symbol: 'NTPC.NS',     label: 'NTPC',         sector: 'Power' },
  { symbol: 'DLF.NS',      label: 'DLF',          sector: 'Realty' },
  { symbol: 'MUTHOOTFIN.NS', label: 'Muthoot Fin', sector: 'Finance' },
]

const SECTOR_COLORS: Record<string, string> = {
  Index:   'bg-brand-500/20 text-brand-400 border-brand-500/30',
  Banking: 'bg-blue-500/20 text-blue-400 border-blue-500/30',
  IT:      'bg-violet-500/20 text-violet-400 border-violet-500/30',
  Energy:  'bg-orange-500/20 text-orange-400 border-orange-500/30',
  Auto:    'bg-cyan-500/20 text-cyan-400 border-cyan-500/30',
  FMCG:   'bg-green-500/20 text-green-400 border-green-500/30',
  Pharma:  'bg-pink-500/20 text-pink-400 border-pink-500/30',
  Metal:   'bg-slate-500/20 text-slate-300 border-slate-500/30',
  Power:   'bg-yellow-500/20 text-yellow-400 border-yellow-500/30',
  Realty:  'bg-teal-500/20 text-teal-400 border-teal-500/30',
  Finance: 'bg-amber-500/20 text-amber-400 border-amber-500/30',
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function BacktestDashboard() {
  const [report, setReport] = useState<ScalpBacktestReport | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [symbol, setSymbol] = useState('^NSEI')
  const [years, setYears] = useState(3)
  const [view, setView] = useState<'cards' | 'table'>('table')
  const [selectedStrategy, setSelectedStrategy] = useState<string>('__all__')

  const fetchReport = () => {
    setLoading(true)
    setError(null)
    getScalpingBacktest(symbol, years)
      .then(data => { setReport(data); setSelectedStrategy('__all__') })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false))
  }

  useEffect(() => { fetchReport() }, [symbol, years]) // eslint-disable-line react-hooks/exhaustive-deps

  const selectedSym = SYMBOLS.find(s => s.symbol === symbol)

  // Active strategy data for the spotlight card
  const activeStrategy = selectedStrategy === '__all__'
    ? null
    : report?.strategies.find(s => s.strategy_name === selectedStrategy) ?? null

  // Strategies to show in cards/table
  const visibleStrategies = selectedStrategy === '__all__'
    ? [...(report?.strategies ?? [])].sort((a, b) => b.win_rate - a.win_rate)
    : (report?.strategies ?? []).filter(s => s.strategy_name === selectedStrategy)

  return (
    <div className="max-w-screen-2xl mx-auto px-4 sm:px-6 py-8">

      {/* ── Page header ── */}
      <div className="mb-6">
        <div className="flex items-center gap-3 mb-1">
          <span className="text-2xl">📊</span>
          <h1 className="text-2xl font-bold text-white">Strategy Backtest Dashboard</h1>
        </div>
        <p className="text-sm text-slate-500 ml-11">
          Historical win rates, profit factors and yearly breakdowns — tested on daily OHLCV bars.
          Entry at next-day open · 0.04% commission per side.
        </p>
      </div>

      {/* ── Controls ── */}
      <div className="bg-dark-800 border border-slate-800/60 rounded-xl p-4 mb-6 flex flex-wrap gap-4 items-end">

        {/* Symbol dropdown */}
        <div>
          <div className="text-[11px] text-slate-500 uppercase tracking-wide mb-2">Symbol</div>
          <select
            value={symbol}
            onChange={e => setSymbol(e.target.value)}
            className="bg-dark-900 border border-slate-700 rounded-lg px-3 py-2 text-white text-sm font-medium min-w-[180px] focus:outline-none focus:border-brand-500"
          >
            {SYMBOLS.map(s => (
              <option key={s.symbol} value={s.symbol}>
                {s.label}  ({s.sector})
              </option>
            ))}
          </select>
        </div>

        {/* Strategy dropdown */}
        <div>
          <div className="text-[11px] text-slate-500 uppercase tracking-wide mb-2">Strategy</div>
          <select
            value={selectedStrategy}
            onChange={e => setSelectedStrategy(e.target.value)}
            className="bg-dark-900 border border-slate-700 rounded-lg px-3 py-2 text-white text-sm font-medium min-w-[220px] focus:outline-none focus:border-brand-500"
          >
            <option value="__all__">All Strategies</option>
            {(report?.strategies ?? [])
              .slice()
              .sort((a, b) => b.win_rate - a.win_rate)
              .map(s => (
                <option key={s.strategy_name} value={s.strategy_name}>
                  {s.strategy_name}  —  {s.win_rate.toFixed(1)}% WR
                </option>
              ))}
          </select>
        </div>

        {/* Period */}
        <div>
          <div className="text-[11px] text-slate-500 uppercase tracking-wide mb-2">Period</div>
          <div className="flex gap-1 bg-dark-900/60 rounded-lg p-0.5">
            {[1, 3, 5].map(y => (
              <button
                key={y}
                onClick={() => setYears(y)}
                className={`px-4 py-1.5 rounded text-xs font-bold transition-all ${
                  years === y ? 'bg-brand-600 text-white shadow' : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {y}Y
              </button>
            ))}
          </div>
        </div>

        {/* View toggle */}
        <div>
          <div className="text-[11px] text-slate-500 uppercase tracking-wide mb-2">View</div>
          <div className="flex gap-1 bg-dark-900/60 rounded-lg p-0.5">
            {(['table', 'cards'] as const).map(v => (
              <button
                key={v}
                onClick={() => setView(v)}
                className={`px-3 py-1.5 rounded text-xs font-medium transition-all ${
                  view === v ? 'bg-slate-700 text-white' : 'text-slate-500 hover:text-slate-300'
                }`}
              >
                {v === 'table' ? '≡ Table' : '⊞ Cards'}
              </button>
            ))}
          </div>
        </div>

        <button
          onClick={fetchReport}
          className="text-xs text-brand-400 border border-brand-600/30 px-3 py-2 rounded-lg hover:bg-brand-600/10 transition-colors"
        >
          ↻ Re-run
        </button>
      </div>

      {/* ── Strategy spotlight (when a single strategy is selected) ── */}
      {activeStrategy && !loading && (
        <div className="bg-gradient-to-br from-brand-950/60 to-dark-800 border border-brand-600/30 rounded-xl p-5 mb-6 flex flex-wrap gap-6 items-center">
          <div className="flex-1 min-w-0">
            <div className="text-[11px] text-brand-400 uppercase tracking-wide mb-1">Selected Strategy · {selectedSym?.label}</div>
            <div className="text-lg font-bold text-white mb-0.5">{activeStrategy.strategy_name}</div>
            <div className="text-xs text-slate-400 line-clamp-2">{activeStrategy.description}</div>
          </div>
          {/* Big win rate spotlight */}
          <div className="flex gap-4 flex-wrap shrink-0">
            {[
              { label: 'Win Rate',     value: `${activeStrategy.win_rate.toFixed(1)}%`,     color: winRateColor(activeStrategy.win_rate),      big: true },
              { label: 'Profit Factor',value: `${activeStrategy.profit_factor.toFixed(2)}x`, color: pfColor(activeStrategy.profit_factor),       big: false },
              { label: 'Net P&L',      value: pct(activeStrategy.net_pnl_pct),               color: pctColor(activeStrategy.net_pnl_pct),        big: false },
              { label: 'Sharpe',       value: activeStrategy.sharpe_ratio.toFixed(2),         color: activeStrategy.sharpe_ratio > 1 ? 'text-emerald-400' : 'text-amber-400', big: false },
              { label: 'Trades',       value: activeStrategy.total_trades.toString(),         color: 'text-white',                                big: false },
            ].map(m => (
              <div key={m.label} className="text-center">
                <div className="text-[10px] text-slate-500 uppercase tracking-wide mb-1">{m.label}</div>
                <div className={`font-black font-mono ${m.big ? 'text-4xl' : 'text-xl'} ${m.color}`}>{m.value}</div>
                {m.big && (
                  <div className="mt-1.5 w-20 mx-auto">
                    <WinBar value={activeStrategy.win_rate} />
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Loading / Error ── */}
      {loading && (
        <LoadingSpinner
          size="lg"
          text={`Running ${years}-year backtest on ${selectedSym?.label ?? symbol}…`}
        />
      )}
      {!loading && error && (
        <div className="bg-dark-800 border border-rose-800/40 rounded-xl p-8 text-center">
          <div className="text-4xl mb-3">⚠️</div>
          <div className="text-rose-400 font-semibold mb-1">Backtest unavailable</div>
          <div className="text-slate-500 text-sm mb-3">{error}</div>
          <div className="text-slate-600 text-xs">
            The data pipeline may still be running. Try re-running in a few minutes.
          </div>
        </div>
      )}

      {/* ── Report ── */}
      {report && !loading && (
        <div className="space-y-6">

          {/* Summary bar */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {[
              {
                icon: '🎯',
                label: 'Best Win Rate',
                value: `${report.summary.best_win_rate_value.toFixed(1)}%`,
                sub: report.summary.best_win_rate_strategy,
                color: winRateColor(report.summary.best_win_rate_value),
              },
              {
                icon: '⚡',
                label: 'Best Profit Factor',
                value: `${report.summary.best_profit_factor_value.toFixed(2)}x`,
                sub: report.summary.best_profit_factor_strategy,
                color: pfColor(report.summary.best_profit_factor_value),
              },
              {
                icon: '📈',
                label: 'Best Net P&L',
                value: pct(report.summary.best_net_pnl_value),
                sub: report.summary.best_net_pnl_strategy,
                color: pctColor(report.summary.best_net_pnl_value),
              },
              {
                icon: '🔢',
                label: 'Overall Win Rate',
                value: `${report.summary.overall_win_rate.toFixed(1)}%`,
                sub: `${report.summary.total_signals} total signals · ${report.data_points} days`,
                color: winRateColor(report.summary.overall_win_rate),
              },
            ].map(m => (
              <div key={m.label} className="bg-dark-800 border border-slate-800/60 rounded-xl p-4">
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-lg">{m.icon}</span>
                  <span className="text-[11px] text-slate-500 uppercase tracking-wide">{m.label}</span>
                </div>
                <div className={`text-2xl font-black font-mono ${m.color}`}>{m.value}</div>
                <div className="text-[11px] text-slate-500 mt-1 truncate">{m.sub}</div>
              </div>
            ))}
          </div>

          {/* Recommendation banner */}
          <div className={`rounded-xl border px-4 py-3 text-sm font-medium flex items-start gap-3 ${
            report.summary.best_win_rate_value >= 65
              ? 'bg-emerald-950/40 border-emerald-500/30 text-emerald-300'
              : report.summary.best_win_rate_value >= 55
              ? 'bg-amber-950/40 border-amber-500/30 text-amber-300'
              : 'bg-rose-950/30 border-rose-500/20 text-rose-300'
          }`}>
            <span className="text-lg shrink-0 mt-0.5">
              {report.summary.best_win_rate_value >= 65 ? '✅' : report.summary.best_win_rate_value >= 55 ? '⚡' : '⚠️'}
            </span>
            <span>{report.summary.recommendation}</span>
          </div>

          {/* Context line */}
          <div className="flex items-center gap-2 text-xs text-slate-500">
            <span className={`font-semibold px-2 py-0.5 rounded border text-[11px] ${SECTOR_COLORS[selectedSym?.sector ?? 'Index'] ?? ''}`}>
              {selectedSym?.label ?? symbol}
            </span>
            <span>·</span>
            <span>{report.period_years}-year backtest</span>
            <span>·</span>
            <span>{report.data_points} trading sessions</span>
            <span>·</span>
            <span>Generated {new Date(report.generated_at).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}</span>
          </div>

          {/* Table or Cards view */}
          {view === 'table' ? (
            <ComparisonTable strategies={visibleStrategies} />
          ) : (
            <div className="space-y-4">
              {visibleStrategies.map((s, i) => (
                <StrategyCard key={s.strategy_name} s={s} rank={i + 1} />
              ))}
            </div>
          )}

          {/* Detailed cards always below table view */}
          {view === 'table' && (
            <div>
              <h2 className="text-sm font-semibold text-white mb-3 uppercase tracking-wide">Detailed Strategy Breakdown</h2>
              <div className="space-y-4">
                {visibleStrategies.map((s, i) => (
                  <StrategyCard key={s.strategy_name} s={s} rank={i + 1} />
                ))}
              </div>
            </div>
          )}

          {/* Disclaimer */}
          <div className="bg-dark-800 border border-slate-800/40 rounded-xl p-4 text-[11px] text-slate-500 leading-relaxed">
            <span className="text-amber-400 font-bold">⚠️ Disclaimer: </span>
            Backtest results use daily bars as a proxy for intraday scalping sessions. Entry = next-day open,
            exit = target/stop hit or end-of-day close. Actual intraday results may vary significantly.
            Commission modelled at 0.04% per side; slippage not included.
            Past performance does not guarantee future results. Always trade within your risk tolerance.
          </div>
        </div>
      )}
    </div>
  )
}
