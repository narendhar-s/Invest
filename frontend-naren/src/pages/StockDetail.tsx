import { useEffect, useMemo, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { getStockDetail, runBacktest } from '../api/client'
import type { StockDetailData, BacktestResult, PriceBar, TechnicalIndicator } from '../types'
import CandlestickChart from '../components/CandlestickChart'
import IndicatorPanel from '../components/IndicatorPanel'
import RecommendationBadge from '../components/RecommendationBadge'
import LoadingSpinner from '../components/LoadingSpinner'

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmt(n: number | null | undefined, dec = 2, prefix = '') {
  if (n == null) return '—'
  return prefix + n.toLocaleString('en', { minimumFractionDigits: dec, maximumFractionDigits: dec })
}
function fmtPct(n: number | null | undefined) {
  if (n == null) return '—'
  return `${n >= 0 ? '+' : ''}${(n * 100).toFixed(1)}%`
}

function FundRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between py-2 border-b border-slate-800/40 text-sm">
      <span className="text-slate-500">{label}</span>
      <span className="text-slate-200 font-mono">{value}</span>
    </div>
  )
}

// ── Timeframe switcher ────────────────────────────────────────────────────────

type Timeframe = '1W' | '1M' | '3M' | '6M' | '1Y' | '2Y'
const TIMEFRAME_DAYS: Record<Timeframe, number> = {
  '1W': 7, '1M': 30, '3M': 90, '6M': 180, '1Y': 365, '2Y': 730,
}

function TimeframePicker({ value, onChange }: { value: Timeframe; onChange: (t: Timeframe) => void }) {
  return (
    <div className="flex gap-1 bg-dark-800 rounded-lg p-0.5">
      {(['1W', '1M', '3M', '6M', '1Y', '2Y'] as Timeframe[]).map((t) => (
        <button
          key={t}
          onClick={() => onChange(t)}
          className={`px-3 py-1.5 rounded text-xs font-medium transition-all ${
            value === t ? 'bg-brand-600 text-white' : 'text-slate-400 hover:text-slate-200'
          }`}
        >
          {t}
        </button>
      ))}
    </div>
  )
}

// ── Horizon Rec Cards ─────────────────────────────────────────────────────────

function HorizonRecCard({
  horizon,
  rec,
  isNSE,
}: {
  horizon: string
  rec: { rec_type: 'strong_buy' | 'buy' | 'hold' | 'sell' | 'strong_sell'; confidence: number; entry_price: number; target_price: number; stop_loss: number; risk_reward: number; risk_level: string; technical_factors: string } | null | undefined
  isNSE: boolean
}) {
  const cc = isNSE ? '₹' : '$'
  const labels: Record<string, string> = { intraday: '⚡ Intraday', swing: '🔄 Short Term', longterm: '🏦 Long Term' }

  if (!rec) {
    return (
      <div className="bg-dark-700 border border-slate-800/60 rounded-xl p-4">
        <div className="text-xs font-semibold text-slate-500 mb-2">{labels[horizon] ?? horizon}</div>
        <div className="text-xs text-slate-600">No recommendation yet</div>
      </div>
    )
  }

  const borderColor = rec.rec_type === 'strong_buy' || rec.rec_type === 'buy'
    ? 'border-emerald-500/30'
    : rec.rec_type === 'hold' ? 'border-amber-500/30' : 'border-red-500/30'

  const upside = rec.entry_price > 0 ? ((rec.target_price - rec.entry_price) / rec.entry_price * 100) : 0

  return (
    <div className={`bg-dark-700 border ${borderColor} rounded-xl p-4`}>
      <div className="flex items-center justify-between mb-3">
        <span className="text-xs font-semibold text-slate-400">{labels[horizon] ?? horizon}</span>
        <RecommendationBadge recType={rec.rec_type} confidence={rec.confidence} size="sm" />
      </div>
      <div className="grid grid-cols-3 gap-2 mb-3 text-xs">
        <div className="bg-dark-800/60 rounded p-2 text-center">
          <div className="text-slate-500">Entry</div>
          <div className="font-mono text-slate-200">{cc}{fmt(rec.entry_price)}</div>
        </div>
        <div className="bg-dark-800/60 rounded p-2 text-center">
          <div className="text-slate-500">Target</div>
          <div className="font-mono text-emerald-400">{cc}{fmt(rec.target_price)}</div>
        </div>
        <div className="bg-dark-800/60 rounded p-2 text-center">
          <div className="text-slate-500">Stop</div>
          <div className="font-mono text-red-400">{cc}{fmt(rec.stop_loss)}</div>
        </div>
      </div>
      <div className="flex justify-between text-xs text-slate-500">
        <span>Conf: <span className="text-white font-bold">{rec.confidence}%</span></span>
        <span className="text-emerald-400">+{upside.toFixed(1)}% upside</span>
        <span>RR: <span className="text-amber-400">{rec.risk_reward.toFixed(1)}x</span></span>
        <span className={rec.risk_level === 'low' ? 'text-emerald-400' : rec.risk_level === 'high' ? 'text-red-400' : 'text-amber-400'}>
          {rec.risk_level?.toUpperCase()}
        </span>
      </div>
    </div>
  )
}

// ── Technical Summary Card ────────────────────────────────────────────────────

function TechnicalSummary({ ind, close, isNSE }: { ind: TechnicalIndicator; close: number; isNSE: boolean }) {
  const cc = isNSE ? '₹' : '$'
  const items = [
    { label: 'RSI (14)', value: fmt(ind.rsi, 1), color: (ind.rsi ?? 50) < 35 ? 'text-emerald-400' : (ind.rsi ?? 50) > 65 ? 'text-red-400' : 'text-amber-400' },
    { label: 'MACD Hist', value: fmt(ind.macd_hist, 3), color: (ind.macd_hist ?? 0) > 0 ? 'text-emerald-400' : 'text-red-400' },
    { label: 'Trend', value: ind.trend_direction || '—', color: ind.trend_direction === 'UP' ? 'text-emerald-400' : ind.trend_direction === 'DOWN' ? 'text-red-400' : 'text-amber-400' },
    { label: 'SMA 20', value: cc + fmt(ind.sma20, 2), color: close > (ind.sma20 ?? 0) ? 'text-emerald-400' : 'text-red-400' },
    { label: 'SMA 50', value: cc + fmt(ind.sma50, 2), color: close > (ind.sma50 ?? 0) ? 'text-emerald-400' : 'text-red-400' },
    { label: 'SMA 200', value: cc + fmt(ind.sma200, 2), color: close > (ind.sma200 ?? 0) ? 'text-emerald-400' : 'text-red-400' },
    { label: 'EMA 20', value: cc + fmt(ind.ema20, 2), color: 'text-blue-400' },
    { label: 'EMA 50', value: cc + fmt(ind.ema50, 2), color: 'text-purple-400' },
    { label: 'BB Upper', value: cc + fmt(ind.bb_upper, 2), color: 'text-red-400' },
    { label: 'BB Lower', value: cc + fmt(ind.bb_lower, 2), color: 'text-emerald-400' },
    { label: 'VWAP', value: cc + fmt(ind.vwap, 2), color: 'text-amber-400' },
    { label: 'Vol Spike', value: ind.volume_spike ? 'Yes' : 'No', color: ind.volume_spike ? 'text-emerald-400' : 'text-slate-400' },
  ]

  return (
    <div className="bg-dark-700 border border-slate-800/60 rounded-xl p-5">
      <div className="flex items-center justify-between mb-4">
        <h3 className="font-semibold text-white">Technical Indicators</h3>
        <div className="flex items-center gap-2">
          <span className="text-xs text-slate-500">Tech Score:</span>
          <div className="flex items-center gap-1.5">
            <div className="w-16 bg-dark-800 rounded-full h-1.5">
              <div className="bg-brand-500 h-1.5 rounded-full" style={{ width: `${ind.technical_score}%` }} />
            </div>
            <span className="text-xs font-bold text-white">{ind.technical_score.toFixed(0)}/100</span>
          </div>
        </div>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
        {items.map((item) => (
          <div key={item.label} className="bg-dark-800/60 rounded-lg p-3">
            <div className="text-xs text-slate-500 mb-1">{item.label}</div>
            <div className={`text-sm font-mono font-bold ${item.color}`}>{item.value}</div>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Main Component ────────────────────────────────────────────────────────────

export default function StockDetail() {
  const { symbol } = useParams<{ symbol: string }>()
  const navigate = useNavigate()
  const [data, setData] = useState<StockDetailData | null>(null)
  const [loading, setLoading] = useState(true)
  const [backtestResult, setBacktestResult] = useState<BacktestResult | null>(null)
  const [backtestLoading, setBacktestLoading] = useState(false)
  const [activeTab, setActiveTab] = useState<'chart' | 'analysis' | 'fundamental' | 'backtest'>('chart')
  const [timeframe, setTimeframe] = useState<Timeframe>('1Y')

  useEffect(() => {
    if (!symbol) return
    setLoading(true)
    getStockDetail(symbol)
      .then(setData)
      .catch(console.error)
      .finally(() => setLoading(false))
  }, [symbol])

  const filteredBars = useMemo<PriceBar[]>(() => {
    if (!data?.price_history) return []
    const cutoff = new Date()
    cutoff.setDate(cutoff.getDate() - TIMEFRAME_DAYS[timeframe])
    return data.price_history.filter(b => new Date(b.date) >= cutoff)
  }, [data?.price_history, timeframe])

  const filteredIndicators = useMemo<TechnicalIndicator[]>(() => {
    if (!data?.indicators) return []
    const cutoff = new Date()
    cutoff.setDate(cutoff.getDate() - TIMEFRAME_DAYS[timeframe])
    return data.indicators.filter(i => new Date(i.date) >= cutoff)
  }, [data?.indicators, timeframe])

  const handleBacktest = async (strategy: string) => {
    if (!symbol) return
    setBacktestLoading(true)
    try {
      const result = await runBacktest(symbol, strategy)
      setBacktestResult(result)
    } catch (e) {
      console.error(e)
    } finally {
      setBacktestLoading(false)
    }
  }

  if (loading) return <LoadingSpinner size="lg" text="Loading stock data..." />
  if (!data) return (
    <div className="max-w-screen-2xl mx-auto px-6 py-12 text-center">
      <div className="text-slate-400">Stock not found</div>
      <button onClick={() => navigate(-1)} className="mt-4 text-brand-400 text-sm hover:underline">← Go back</button>
    </div>
  )

  const { stock, latest_indicator, fundamental, sr_levels, recommendation, recommendations_by_horizon } = data
  const isNSE = stock.market === 'NSE'
  const cc = isNSE ? '₹' : '$'

  const currentPrice = filteredBars.length > 0 ? filteredBars[filteredBars.length - 1].close : null

  const srCounts = {
    support: sr_levels.filter(l => l.level_type === 'support').length,
    resistance: sr_levels.filter(l => l.level_type === 'resistance').length,
    accumulation: sr_levels.filter(l => l.level_type === 'accumulation').length,
  }

  // Available horizons
  const horizons = isNSE ? ['intraday', 'swing', 'longterm'] : ['swing', 'longterm']

  return (
    <div className="max-w-screen-2xl mx-auto px-4 sm:px-6 py-8">
      <button onClick={() => navigate(-1)} className="text-slate-500 hover:text-slate-300 text-sm mb-6 flex items-center gap-1">
        ← Back
      </button>

      {/* Stock Header */}
      <div className="flex flex-wrap items-start gap-6 mb-6">
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-center gap-2 mb-1">
            <h1 className="text-2xl font-bold text-white">{stock.symbol}</h1>
            <span className="text-xs bg-dark-700 border border-slate-700 px-2 py-0.5 rounded text-slate-400">{stock.market}</span>
            {stock.sector && <span className="text-xs bg-dark-700 border border-slate-700 px-2 py-0.5 rounded text-slate-400">{stock.sector}</span>}
            {stock.exchange && <span className="text-xs bg-dark-700 border border-slate-700 px-2 py-0.5 rounded text-slate-400">{stock.exchange}</span>}
          </div>
          <div className="text-slate-400 text-sm">{stock.name}</div>
          {currentPrice != null && (
            <div className="mt-2">
              <span className="text-3xl font-bold text-white font-mono">{cc}{fmt(currentPrice)}</span>
            </div>
          )}
        </div>

        {/* Best recommendation box */}
        {recommendation && (
          <div className="bg-dark-700 border border-slate-800/60 rounded-xl p-4 min-w-[240px]">
            <div className="flex items-center justify-between mb-2">
              <RecommendationBadge recType={recommendation.rec_type} confidence={recommendation.confidence} size="lg" />
              <span className="text-xs text-slate-500 capitalize">{recommendation.horizon} · {recommendation.risk_level} risk</span>
            </div>
            <div className="flex justify-between text-xs text-slate-500 mt-2">
              <span>Target: <span className="text-emerald-400 font-mono">{cc}{fmt(recommendation.target_price)}</span></span>
              <span>Stop: <span className="text-red-400 font-mono">{cc}{fmt(recommendation.stop_loss)}</span></span>
            </div>
          </div>
        )}
      </div>

      {/* S/R Level pills */}
      <div className="flex flex-wrap gap-2 mb-6">
        {[
          { label: 'Support', count: srCounts.support, color: 'text-emerald-400', bg: 'bg-emerald-500/10', border: 'border-emerald-500/20' },
          { label: 'Resistance', count: srCounts.resistance, color: 'text-red-400', bg: 'bg-red-500/10', border: 'border-red-500/20' },
          { label: 'Accumulation', count: srCounts.accumulation, color: 'text-blue-400', bg: 'bg-blue-500/10', border: 'border-blue-500/20' },
        ].map((item) => (
          <div key={item.label} className={`${item.bg} border ${item.border} rounded-lg px-3 py-2 text-xs`}>
            <span className={`font-semibold ${item.color}`}>{item.count}</span>
            <span className="text-slate-500 ml-1">{item.label}</span>
          </div>
        ))}
      </div>

      {/* Horizon Recommendations row */}
      {recommendations_by_horizon && (
        <div className="mb-6">
          <h3 className="text-sm font-semibold text-slate-400 mb-3">Recommendations by Horizon</h3>
          <div className={`grid gap-3 ${horizons.length === 3 ? 'grid-cols-1 sm:grid-cols-3' : 'grid-cols-1 sm:grid-cols-2'}`}>
            {horizons.map(h => (
              <HorizonRecCard key={h} horizon={h} rec={recommendations_by_horizon[h]} isNSE={isNSE} />
            ))}
          </div>
        </div>
      )}

      {/* Tab Nav */}
      <div className="flex gap-1 mb-6 bg-dark-800 rounded-xl p-1 w-fit flex-wrap">
        {(['chart', 'analysis', 'fundamental', 'backtest'] as const).map((t) => (
          <button
            key={t}
            onClick={() => setActiveTab(t)}
            className={`px-5 py-2 rounded-lg text-sm font-medium transition-all capitalize ${
              activeTab === t ? 'bg-brand-600 text-white' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            {t === 'analysis' ? 'Technical Analysis' : t.charAt(0).toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>

      {/* ── Chart Tab ──────────────────────────────────────────────────────────── */}
      {activeTab === 'chart' && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-white">Candlestick Chart</h3>
            <TimeframePicker value={timeframe} onChange={setTimeframe} />
          </div>

          <CandlestickChart bars={filteredBars} indicators={filteredIndicators} srLevels={sr_levels} height={500} />

          {recommendation && (
            <div className="bg-dark-700 border border-slate-800/60 rounded-xl p-5">
              <h3 className="font-semibold text-white mb-3">Analysis Summary</h3>
              <p className="text-sm text-slate-300 leading-relaxed mb-3">{recommendation.technical_factors}</p>
              <p className="text-sm text-slate-400 leading-relaxed">{recommendation.fundamental_factors}</p>
            </div>
          )}
        </div>
      )}

      {/* ── Analysis Tab ───────────────────────────────────────────────────────── */}
      {activeTab === 'analysis' && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-white">Indicator History</h3>
            <TimeframePicker value={timeframe} onChange={setTimeframe} />
          </div>

          {latest_indicator && currentPrice != null && (
            <TechnicalSummary ind={latest_indicator} close={currentPrice} isNSE={isNSE} />
          )}

          <IndicatorPanel indicators={filteredIndicators} bars={filteredBars} />
        </div>
      )}

      {/* ── Fundamental Tab ───────────────────────────────────────────────────── */}
      {activeTab === 'fundamental' && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {fundamental ? (
            <>
              <div className="bg-dark-700 border border-slate-800/60 rounded-xl p-5">
                <h3 className="font-semibold text-white mb-4">Valuation</h3>
                <FundRow label="P/E Ratio (TTM)" value={fmt(fundamental.pe_ratio, 2)} />
                <FundRow label="Forward P/E" value={fmt(fundamental.forward_pe, 2)} />
                <FundRow label="Price to Book" value={fmt(fundamental.price_to_book, 2)} />
                <FundRow label="EPS (TTM)" value={fmt(fundamental.eps, 2)} />
                <FundRow label="Dividend Yield" value={fmtPct(fundamental.dividend_yield)} />
                <FundRow label="Market Cap" value={fundamental.market_cap != null
                  ? (fundamental.market_cap > 1e12
                    ? `${(fundamental.market_cap / 1e12).toFixed(2)}T`
                    : fundamental.market_cap > 1e9
                    ? `${(fundamental.market_cap / 1e9).toFixed(2)}B`
                    : `${(fundamental.market_cap / 1e6).toFixed(0)}M`) + (isNSE ? ' ₹' : ' $')
                  : '—'}
                />
              </div>
              <div className="bg-dark-700 border border-slate-800/60 rounded-xl p-5">
                <h3 className="font-semibold text-white mb-4">Growth & Quality</h3>
                <FundRow label="EPS Growth (YoY)" value={fmtPct(fundamental.eps_growth)} />
                <FundRow label="Revenue Growth (YoY)" value={fmtPct(fundamental.revenue_growth)} />
                <FundRow label="ROE" value={fmtPct(fundamental.roe)} />
                <FundRow label="ROA" value={fmtPct(fundamental.roa)} />
                <FundRow label="Profit Margin" value={fmtPct(fundamental.profit_margin)} />
                <FundRow label="Debt/Equity" value={fmt(fundamental.debt_equity, 2)} />
              </div>
              <div className="bg-dark-700 border border-slate-800/60 rounded-xl p-5 lg:col-span-2">
                <h3 className="font-semibold text-white mb-4">Composite Scores</h3>
                <div className="grid grid-cols-2 gap-6">
                  {[
                    { label: 'Fundamental Score', value: fundamental.fundamental_score, color: 'bg-purple-500', desc: 'Based on P/E, growth, ROE, margins, D/E' },
                    { label: 'Technical Score', value: latest_indicator?.technical_score ?? 0, color: 'bg-brand-500', desc: 'Based on RSI, MACD, trend, volume' },
                  ].map((item) => (
                    <div key={item.label}>
                      <div className="flex justify-between text-sm mb-1">
                        <span className="text-slate-400">{item.label}</span>
                        <span className="text-white font-semibold">{item.value.toFixed(1)} / 100</span>
                      </div>
                      <div className="bg-dark-800 rounded-full h-3 mb-1">
                        <div className={`${item.color} h-3 rounded-full transition-all`} style={{ width: `${item.value}%` }} />
                      </div>
                      <div className="text-xs text-slate-600">{item.desc}</div>
                    </div>
                  ))}
                </div>
              </div>
            </>
          ) : (
            <div className="lg:col-span-2 text-slate-500 text-sm py-12 text-center bg-dark-700 border border-slate-800/60 rounded-xl">
              Fundamental data not available for this stock.
            </div>
          )}
        </div>
      )}

      {/* ── Backtest Tab ───────────────────────────────────────────────────────── */}
      {activeTab === 'backtest' && (
        <div className="space-y-6">
          <div className="flex flex-wrap gap-3">
            {[
              { id: 'RSI_MACD', label: 'RSI + MACD Strategy' },
              { id: 'ORB', label: 'Opening Range Breakout' },
            ].map((strat) => (
              <button
                key={strat.id}
                onClick={() => handleBacktest(strat.id)}
                disabled={backtestLoading}
                className="px-5 py-2.5 bg-brand-600 hover:bg-brand-700 text-white rounded-lg text-sm font-medium transition-colors disabled:opacity-50"
              >
                {backtestLoading ? 'Running...' : `Run ${strat.label}`}
              </button>
            ))}
          </div>

          {!backtestResult && !backtestLoading && (
            <div className="bg-dark-700 border border-slate-800/60 rounded-xl p-6 text-center text-slate-500 text-sm">
              Select a strategy above to run a 2-year backtest on this stock.
              <div className="text-xs text-slate-600 mt-2">
                Uses daily OHLCV data · commission 0.1% · slippage 0.05% · 10% position sizing
              </div>
            </div>
          )}

          {backtestLoading && <LoadingSpinner text="Running backtest simulation..." />}

          {backtestResult && (
            <div className="space-y-5">
              <div className="bg-dark-700 border border-slate-800/60 rounded-xl p-6">
                <div className="flex items-center justify-between mb-5">
                  <h3 className="font-semibold text-white">
                    {backtestResult.strategy} — {backtestResult.symbol}
                  </h3>
                  <span className={`text-sm font-bold px-3 py-1 rounded-lg ${backtestResult.net_pnl_pct > 0 ? 'bg-emerald-500/20 text-emerald-400' : 'bg-red-500/20 text-red-400'}`}>
                    {backtestResult.net_pnl_pct > 0 ? '+' : ''}{backtestResult.net_pnl_pct.toFixed(1)}% overall
                  </span>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-5">
                  {[
                    { label: 'Total Trades', value: backtestResult.total_trades.toString() },
                    { label: 'Win Rate', value: `${backtestResult.win_rate.toFixed(1)}%`, color: backtestResult.win_rate > 50 ? 'text-emerald-400' : 'text-red-400' },
                    { label: 'Profit Factor', value: backtestResult.profit_factor.toFixed(2), color: backtestResult.profit_factor > 1 ? 'text-emerald-400' : 'text-red-400' },
                    { label: 'Max Drawdown', value: `${backtestResult.max_drawdown.toFixed(1)}%`, color: 'text-red-400' },
                    { label: 'Net P&L', value: `${cc}${backtestResult.net_pnl.toFixed(0)}`, color: backtestResult.net_pnl > 0 ? 'text-emerald-400' : 'text-red-400' },
                    { label: 'Sharpe Ratio', value: backtestResult.sharpe_ratio.toFixed(2), color: backtestResult.sharpe_ratio > 1 ? 'text-emerald-400' : 'text-amber-400' },
                    { label: 'Avg Win', value: `${cc}${backtestResult.avg_win.toFixed(0)}`, color: 'text-emerald-400' },
                    { label: 'Avg Loss', value: `${cc}${backtestResult.avg_loss.toFixed(0)}`, color: 'text-red-400' },
                  ].map((item) => (
                    <div key={item.label} className="bg-dark-800 rounded-lg p-3">
                      <div className="text-xs text-slate-500 mb-1">{item.label}</div>
                      <div className={`text-lg font-bold font-mono ${item.color ?? 'text-white'}`}>{item.value}</div>
                    </div>
                  ))}
                </div>

                {/* Win/Loss bar */}
                <div className="mb-2 text-xs text-slate-500">Win rate</div>
                <div className="flex rounded-full overflow-hidden h-3 bg-dark-800">
                  <div className="bg-emerald-500 h-3" style={{ width: `${backtestResult.win_rate}%` }} />
                  <div className="bg-red-500 h-3 flex-1" />
                </div>
                <div className="flex justify-between text-xs text-slate-500 mt-1">
                  <span className="text-emerald-400">{backtestResult.win_rate.toFixed(0)}% wins</span>
                  <span className="text-red-400">{(100 - backtestResult.win_rate).toFixed(0)}% losses</span>
                </div>
              </div>

              {/* Trade history */}
              {backtestResult.trades && backtestResult.trades.length > 0 && (
                <div className="bg-dark-700 border border-slate-800/60 rounded-xl p-5">
                  <h3 className="font-semibold text-white mb-4">Trade History ({backtestResult.trades.length} trades)</h3>
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="text-slate-500 border-b border-slate-800">
                          <th className="text-left py-2 pr-4">Entry</th>
                          <th className="text-left py-2 pr-4">Exit</th>
                          <th className="text-right py-2 pr-4">Entry {cc}</th>
                          <th className="text-right py-2 pr-4">Exit {cc}</th>
                          <th className="text-right py-2 pr-4">P&L</th>
                          <th className="text-right py-2">P&L %</th>
                        </tr>
                      </thead>
                      <tbody>
                        {backtestResult.trades.map((t, i) => (
                          <tr key={i} className="border-b border-slate-800/40 hover:bg-dark-600/30">
                            <td className="py-2 pr-4 text-slate-400 font-mono">{t.EntryDate?.split('T')[0] ?? '—'}</td>
                            <td className="py-2 pr-4 text-slate-400 font-mono">{t.ExitDate?.split('T')[0] ?? '—'}</td>
                            <td className="py-2 pr-4 text-right font-mono text-slate-300">{cc}{t.EntryPrice?.toFixed(2)}</td>
                            <td className="py-2 pr-4 text-right font-mono text-slate-300">{cc}{t.ExitPrice?.toFixed(2)}</td>
                            <td className={`py-2 pr-4 text-right font-mono font-bold ${t.PnL >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                              {t.PnL >= 0 ? '+' : ''}{cc}{t.PnL?.toFixed(0)}
                            </td>
                            <td className={`py-2 text-right font-mono font-bold ${t.PnLPct >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                              {t.PnLPct >= 0 ? '+' : ''}{t.PnLPct?.toFixed(2)}%
                            </td>
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
      )}
    </div>
  )
}
