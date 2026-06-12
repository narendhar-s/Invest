import { useEffect, useState, useCallback } from 'react'
import {
  getNiftyDashboard,
  getNiftyBTST,
  getNiftyLiveSignals,
  getScalpingBacktest,
  getNewsFlags,
  getTomorrowPicks,
  getTodayPicks,
  type NiftyDashboard,
  type NiftyStrategyCard,
  type NiftyScalpSignal,
  type OptionChainRow,
  type StrikeSuggestion,
  type NiftyBTSTSignal,
  type ScalpStrategyResult,
  type NewsFlag,
  type NewsFlagsResponse,
  type TomorrowPick,
} from '../api/client'
import NiftyChart from '../components/NiftyChart'

// ─── helpers ──────────────────────────────────────────────────────────────────

function fmt(n: number, d = 2) {
  return n.toLocaleString('en-IN', { maximumFractionDigits: d, minimumFractionDigits: d })
}
function fmtInt(n: number) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
  if (n >= 1_000) return (n / 1_000).toFixed(0) + 'K'
  return String(n)
}
function cls(...args: (string | false | undefined)[]) {
  return args.filter(Boolean).join(' ')
}

const DIRECTION_COLOR: Record<string, string> = {
  BUY: 'text-emerald-400',
  SELL: 'text-rose-400',
  HOLD: 'text-amber-400',
  NEUTRAL: 'text-slate-400',
  BULLISH: 'text-emerald-400',
  BEARISH: 'text-rose-400',
  MILDLY_BULLISH: 'text-green-400',
  MILDLY_BEARISH: 'text-orange-400',
}
const DIRECTION_BG: Record<string, string> = {
  BUY: 'bg-emerald-500/15 border-emerald-500/30',
  SELL: 'bg-rose-500/15 border-rose-500/30',
  HOLD: 'bg-amber-500/15 border-amber-500/30',
  NEUTRAL: 'bg-slate-700/40 border-slate-600/30',
}
const RISK_COLOR: Record<string, string> = {
  LOW: 'text-emerald-400',
  MODERATE: 'text-amber-400',
  HIGH: 'text-rose-400',
}

// ─── Symbol list ─────────────────────────────────────────────────────────────

const CARD_SYMBOLS = [
  { symbol: '^NSEI',         label: 'NIFTY 50',          sector: 'Index' },
  { symbol: 'HDFCBANK.NS',   label: 'HDFC Bank',         sector: 'Banking' },
  { symbol: 'SBIN.NS',       label: 'SBI',               sector: 'Banking' },
  { symbol: 'INFY.NS',       label: 'Infosys',           sector: 'IT' },
  { symbol: 'RELIANCE.NS',   label: 'Reliance',          sector: 'Energy' },
  { symbol: 'TATAMOTORS.NS', label: 'Tata Motors',       sector: 'Auto' },
  { symbol: 'ITC.NS',        label: 'ITC',               sector: 'FMCG' },
  { symbol: 'SUNPHARMA.NS',  label: 'Sun Pharma',        sector: 'Pharma' },
  { symbol: 'TATASTEEL.NS',  label: 'Tata Steel',        sector: 'Metal' },
  { symbol: 'NTPC.NS',       label: 'NTPC',              sector: 'Power' },
  { symbol: 'DLF.NS',        label: 'DLF',               sector: 'Realty' },
  { symbol: 'MUTHOOTFIN.NS', label: 'Muthoot Finance',   sector: 'Finance' },
]

// Unified card shape accepted by StrategyCard
interface CardData {
  strategy_name:       string
  description:         string
  timeframe:           string
  win_rate:            number
  profit_factor:       number
  max_drawdown_pct:    number
  net_pnl_pct:         number
  sharpe_ratio:        number
  total_trades:        number
  avg_trades_per_month: number
  expectancy_pct:      number
  yearly_breakdown:    Array<{ year: number; trades: number; win_rate: number; net_pnl_pct: number; profit_factor: number }>
  current_signal:      NiftyScalpSignal | null
  rules:               string[]
  best_for:            string
  risk_level:          string
}

function niftyCardToCardData(c: NiftyStrategyCard): CardData {
  return {
    strategy_name:        c.strategy_name,
    description:          c.description,
    timeframe:            c.timeframe,
    win_rate:             c.win_rate,
    profit_factor:        c.profit_factor,
    max_drawdown_pct:     c.max_drawdown_pct,
    net_pnl_pct:          c.net_pnl_pct,
    sharpe_ratio:         c.sharpe_ratio,
    total_trades:         c.total_trades,
    avg_trades_per_month: c.avg_trades_per_month,
    expectancy_pct:       c.expectancy_pct,
    yearly_breakdown:     c.yearly_breakdown ?? [],
    current_signal:       c.current_signal ?? null,
    rules:                c.rules ?? [],
    best_for:             c.best_for ?? '',
    risk_level:           c.risk_level ?? 'MODERATE',
  }
}

function scalpResultToCardData(s: ScalpStrategyResult): CardData {
  return {
    strategy_name:        s.strategy_name,
    description:          s.description ?? '',
    timeframe:            'Daily',
    win_rate:             s.win_rate,
    profit_factor:        s.profit_factor,
    max_drawdown_pct:     s.max_drawdown_pct,
    net_pnl_pct:          s.net_pnl_pct,
    sharpe_ratio:         s.sharpe_ratio,
    total_trades:         s.total_trades,
    avg_trades_per_month: s.avg_trades_per_month,
    expectancy_pct:       s.expectancy_pct,
    yearly_breakdown:     s.yearly_breakdown ?? [],
    current_signal:       null,
    rules:                [],
    best_for:             '',
    risk_level:           s.win_rate >= 62 ? 'CONSERVATIVE' : s.win_rate >= 55 ? 'MODERATE' : 'HIGH',
  }
}

// ─── sub-components ───────────────────────────────────────────────────────────

function Stat({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs text-slate-500 uppercase tracking-wide">{label}</span>
      <span className={cls('text-lg font-bold tabular-nums', color ?? 'text-white')}>{value}</span>
    </div>
  )
}

function Badge({ text, color }: { text: string; color: string }) {
  return (
    <span className={cls('px-2 py-0.5 rounded text-xs font-semibold uppercase tracking-wide', color)}>
      {text}
    </span>
  )
}

// ─── Market Header ────────────────────────────────────────────────────────────

function MarketHeader({ d }: { d: NiftyDashboard }) {
  const changeColor = d.change >= 0 ? 'text-emerald-400' : 'text-rose-400'
  const sentColor = DIRECTION_COLOR[d.market_sentiment] ?? 'text-slate-300'
  const vixColor = d.vix > 20 ? 'text-rose-400' : d.vix > 15 ? 'text-amber-400' : 'text-emerald-400'
  const pcrColor = d.pcr >= 1.1 ? 'text-emerald-400' : d.pcr < 0.9 ? 'text-rose-400' : 'text-amber-400'

  return (
    <div className="bg-dark-800 border border-slate-800/60 rounded-xl p-5 mb-6">
      <div className="flex flex-wrap items-center gap-6">
        <div>
          <div className="text-xs text-slate-500 uppercase tracking-wide mb-1">NIFTY 50</div>
          <div className="flex items-baseline gap-3">
            <span className="text-3xl font-bold tabular-nums text-white">{fmt(d.spot_price, 0)}</span>
            <span className={cls('text-base font-semibold', changeColor)}>
              {d.change >= 0 ? '+' : ''}{fmt(d.change, 1)} ({d.change >= 0 ? '+' : ''}{fmt(d.change_pct, 2)}%)
            </span>
          </div>
        </div>
        <div className="h-10 w-px bg-slate-700/60 hidden sm:block" />
        <Stat label="India VIX" value={fmt(d.vix, 1)} color={vixColor} />
        <div className="h-10 w-px bg-slate-700/60 hidden sm:block" />
        <Stat label="PCR" value={fmt(d.pcr, 2)} color={pcrColor} />
        <div className="h-10 w-px bg-slate-700/60 hidden sm:block" />
        <Stat label="Max Pain" value={fmt(d.max_pain_strike, 0)} />
        <div className="h-10 w-px bg-slate-700/60 hidden sm:block" />
        <Stat label="ATM Strike" value={fmt(d.atm_strike, 0)} />
        <div className="h-10 w-px bg-slate-700/60 hidden sm:block" />
        <div className="flex flex-col gap-0.5">
          <span className="text-xs text-slate-500 uppercase tracking-wide">Sentiment</span>
          <span className={cls('text-base font-bold', sentColor)}>{d.market_sentiment.replace(/_/g, ' ')}</span>
        </div>
        <div className="ml-auto flex items-center gap-2 text-xs text-slate-500">
          <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
          Live • refreshes every 60s
        </div>
      </div>
    </div>
  )
}

// ─── Live Signals Tab ─────────────────────────────────────────────────────────

type LiveTf = '5m' | '15m' | 'daily'

const TF_LABELS: Record<LiveTf, string> = { '5m': '5 Min', '15m': '15 Min', 'daily': 'Daily' }
const TF_HINT: Record<LiveTf, string> = {
  '5m':    'Live intraday bars (last 7 days) — best during market hours',
  '15m':   'Live intraday bars (last 60 days) — swing intraday bias',
  'daily': 'Daily bars (last 90 days) — position & BTST bias',
}

function LiveSignalsPanel({ signals, loading }: { signals: NiftyScalpSignal[]; loading: boolean }) {
  if (loading) {
    return (
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {[1, 2, 3, 4].map(i => (
          <div key={i} className="bg-slate-800/50 border border-slate-700/40 rounded-xl p-4 animate-pulse h-36" />
        ))}
      </div>
    )
  }
  if (signals.length === 0) {
    return (
      <div className="bg-dark-800 border border-slate-800/60 rounded-xl p-8 flex flex-col items-center justify-center text-center gap-2">
        <div className="text-2xl">⚡</div>
        <div className="text-slate-400 text-sm">No signals fired — click <span className="text-white font-semibold">Fetch Signals</span> to run strategies</div>
        <div className="text-slate-600 text-xs">Market may be closed for intraday timeframes</div>
      </div>
    )
  }
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
      {signals.map((sig) => {
        const dirBg = DIRECTION_BG[sig.direction] ?? 'bg-slate-700/40 border-slate-600/30'
        const dirColor = DIRECTION_COLOR[sig.direction] ?? 'text-slate-300'
        return (
          <div key={sig.strategy} className={cls('border rounded-xl p-4', dirBg)}>
            <div className="flex items-start justify-between mb-2">
              <div>
                <div className="flex items-center gap-1.5 mb-0.5">
                  <span className="text-xs bg-slate-700/60 text-slate-300 px-1.5 py-0.5 rounded font-mono">{sig.timeframe}</span>
                </div>
                <div className="text-sm font-semibold text-white">{sig.strategy}</div>
              </div>
              <span className={cls('text-sm font-bold px-2 py-0.5 rounded', dirColor, 'bg-black/20')}>
                {sig.direction}
              </span>
            </div>
            <div className="grid grid-cols-3 gap-2 text-xs mb-3">
              <div>
                <div className="text-slate-500">Entry</div>
                <div className="text-white font-semibold tabular-nums">{fmt(sig.spot_entry || sig.entry_price, 0)}</div>
              </div>
              <div>
                <div className="text-slate-500">Target</div>
                <div className="text-emerald-400 font-semibold tabular-nums">{fmt(sig.spot_target || sig.target, 0)}</div>
              </div>
              <div>
                <div className="text-slate-500">SL</div>
                <div className="text-rose-400 font-semibold tabular-nums">{fmt(sig.spot_stop || sig.stop_loss, 0)}</div>
              </div>
            </div>
            <div className="grid grid-cols-3 gap-2 text-xs mb-2">
              <div>
                <div className="text-slate-500">R:R</div>
                <div className="text-white font-medium">{fmt(sig.risk_reward, 2)}</div>
              </div>
              <div>
                <div className="text-slate-500">Win Rate</div>
                <div className="text-indigo-300 font-medium">{sig.win_rate?.toFixed(1)}%</div>
              </div>
              <div>
                <div className="text-slate-500">Confidence</div>
                <div className="text-amber-300 font-medium">{sig.confidence.toFixed(0)}%</div>
              </div>
            </div>
            {sig.suggested_option && (
              <div className="text-xs bg-black/30 rounded-lg px-2 py-1 text-slate-300 mb-2">
                📌 {sig.suggested_option}
              </div>
            )}
            {sig.reasons?.length > 0 && (
              <ul className="space-y-0.5">
                {sig.reasons.slice(0, 2).map((r, i) => (
                  <li key={i} className="text-xs text-slate-400">• {r}</li>
                ))}
              </ul>
            )}
          </div>
        )
      })}
    </div>
  )
}

function LiveSignalsTab() {
  const [timeframe, setTimeframe] = useState<LiveTf>('daily')
  const [signals, setSignals] = useState<NiftyScalpSignal[]>([])
  const [loading, setLoading] = useState(false)
  const [generatedAt, setGeneratedAt] = useState('')
  const [error, setError] = useState('')

  const fetchSignals = useCallback(async (tf: LiveTf) => {
    setLoading(true)
    setError('')
    try {
      const res = await getNiftyLiveSignals(tf)
      setSignals(res.signals)
      setGeneratedAt(res.generated_at)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to fetch signals')
      setSignals([])
    } finally {
      setLoading(false)
    }
  }, [])

  return (
    <div>
      {/* Controls row */}
      <div className="flex flex-wrap items-center gap-2 mb-4">
        <div className="flex gap-1 bg-slate-800/60 rounded-lg p-1">
          {(['5m', '15m', 'daily'] as LiveTf[]).map(tf => (
            <button
              key={tf}
              onClick={() => setTimeframe(tf)}
              className={cls(
                'px-3 py-1.5 rounded-md text-xs font-semibold transition-all',
                timeframe === tf
                  ? 'bg-indigo-600 text-white shadow'
                  : 'text-slate-400 hover:text-white hover:bg-slate-700',
              )}
            >
              {TF_LABELS[tf]}
            </button>
          ))}
        </div>

        <button
          onClick={() => fetchSignals(timeframe)}
          disabled={loading}
          className={cls(
            'flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-xs font-semibold transition-all',
            loading
              ? 'bg-indigo-700/50 text-indigo-300 cursor-not-allowed'
              : 'bg-indigo-600 hover:bg-indigo-500 text-white',
          )}
        >
          {loading ? (
            <><span className="animate-spin">⏳</span> Fetching…</>
          ) : (
            <>⚡ Fetch Signals</>
          )}
        </button>

        {generatedAt && !loading && (
          <span className="text-xs text-slate-500">
            Updated {new Date(generatedAt).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
            · {signals.length} signal{signals.length !== 1 ? 's' : ''}
          </span>
        )}
      </div>

      {/* Timeframe hint */}
      <div className="text-xs text-slate-600 mb-3">{TF_HINT[timeframe]}</div>

      {error && (
        <div className="mb-3 bg-red-900/20 border border-red-700/40 rounded-lg px-4 py-2 text-sm text-red-300">
          {error}
        </div>
      )}

      <LiveSignalsPanel signals={signals} loading={loading} />
    </div>
  )
}

// ─── Strategy Card ────────────────────────────────────────────────────────────

const NAREN_STRATEGY = 'Naren EMA 9/21 Support — Script 1'

function StrategyCard({ card }: { card: CardData }) {
  const [expanded, setExpanded] = useState(false)
  const sig = card.current_signal
  const isNaren = card.strategy_name === NAREN_STRATEGY
  const riskColor = RISK_COLOR[card.risk_level] ?? 'text-slate-400'
  const winColor = card.win_rate >= 60 ? 'text-emerald-400' : card.win_rate >= 50 ? 'text-amber-400' : 'text-rose-400'
  const pfColor = card.profit_factor >= 2 ? 'text-emerald-400' : card.profit_factor >= 1.5 ? 'text-amber-400' : 'text-rose-400'

  return (
    <div className={cls(
      'rounded-xl overflow-hidden transition-colors',
      isNaren
        ? 'bg-dark-800 border-2 border-brand-500/50 hover:border-brand-500/80 shadow-lg shadow-brand-500/10'
        : 'bg-dark-800 border border-slate-800/60 hover:border-brand-600/30',
    )}>
      {/* Header */}
      <div className={cls('p-4 border-b border-slate-800/60', isNaren && 'bg-brand-500/5')}>
        {isNaren && (
          <div className="flex items-center gap-2 mb-2">
            <span className="px-2 py-0.5 rounded text-xs font-bold bg-brand-500/20 text-brand-400 border border-brand-500/30 uppercase tracking-wide">
              ★ Featured
            </span>
            <span className="text-xs text-slate-500">Naren's Primary Strategy</span>
          </div>
        )}
        <div className="flex items-start justify-between gap-2 mb-1">
          <div>
            <div className={cls('text-sm font-bold', isNaren ? 'text-brand-300' : 'text-white')}>{card.strategy_name}</div>
            <div className="text-xs text-slate-400 mt-0.5">{card.description}</div>
          </div>
          <div className="flex flex-col items-end gap-1 shrink-0">
            <Badge text={card.timeframe} color="bg-slate-700/60 text-slate-300" />
            <Badge text={card.risk_level} color={cls('bg-black/20', riskColor)} />
          </div>
        </div>
        {sig && (
          <div className={cls('mt-2 px-3 py-1.5 rounded-lg border text-xs font-semibold flex items-center justify-between', DIRECTION_BG[sig.direction] ?? 'bg-slate-700/40 border-slate-700')}>
            <span className={DIRECTION_COLOR[sig.direction] ?? 'text-slate-300'}>▶ {sig.direction} @ {fmt(sig.entry_price, 0)}</span>
            <span className="text-slate-400">Conf: {sig.confidence.toFixed(0)}%</span>
          </div>
        )}
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-4 divide-x divide-slate-800/60 border-b border-slate-800/60">
        <div className="p-3 text-center">
          <div className="text-xs text-slate-500 mb-0.5">Win Rate</div>
          <div className={cls('text-base font-bold', winColor)}>{card.win_rate.toFixed(1)}%</div>
        </div>
        <div className="p-3 text-center">
          <div className="text-xs text-slate-500 mb-0.5">Profit Factor</div>
          <div className={cls('text-base font-bold', pfColor)}>{card.profit_factor.toFixed(2)}</div>
        </div>
        <div className="p-3 text-center">
          <div className="text-xs text-slate-500 mb-0.5">Net PnL</div>
          <div className={cls('text-base font-bold', card.net_pnl_pct >= 0 ? 'text-emerald-400' : 'text-rose-400')}>
            {card.net_pnl_pct >= 0 ? '+' : ''}{card.net_pnl_pct.toFixed(1)}%
          </div>
        </div>
        <div className="p-3 text-center">
          <div className="text-xs text-slate-500 mb-0.5">Max DD</div>
          <div className="text-base font-bold text-amber-400">-{card.max_drawdown_pct.toFixed(1)}%</div>
        </div>
      </div>

      {/* Secondary stats */}
      <div className="grid grid-cols-3 divide-x divide-slate-800/60 border-b border-slate-800/60">
        <div className="p-3 text-center">
          <div className="text-xs text-slate-500 mb-0.5">Sharpe</div>
          <div className="text-sm font-semibold text-white">{card.sharpe_ratio.toFixed(2)}</div>
        </div>
        <div className="p-3 text-center">
          <div className="text-xs text-slate-500 mb-0.5">Trades/Mo</div>
          <div className="text-sm font-semibold text-white">{card.avg_trades_per_month.toFixed(1)}</div>
        </div>
        <div className="p-3 text-center">
          <div className="text-xs text-slate-500 mb-0.5">Total Trades</div>
          <div className="text-sm font-semibold text-white">{card.total_trades}</div>
        </div>
      </div>

      {/* Expand toggle */}
      <button
        onClick={() => setExpanded(e => !e)}
        className="w-full px-4 py-2 text-xs text-slate-400 hover:text-slate-200 flex items-center justify-between hover:bg-slate-800/30 transition-colors"
      >
        <span>3-Year Breakdown & Rules</span>
        <span>{expanded ? '▲' : '▼'}</span>
      </button>

      {expanded && (
        <div className="border-t border-slate-800/60">
          {/* Yearly breakdown */}
          {card.yearly_breakdown?.length > 0 && (
            <div className="p-4 border-b border-slate-800/60">
              <div className="text-xs text-slate-500 uppercase tracking-wide mb-2">Yearly Performance</div>
              <div className="space-y-1.5">
                {card.yearly_breakdown.map((y) => (
                  <div key={y.year} className="flex items-center gap-2 text-xs">
                    <span className="text-slate-400 w-10 shrink-0">{y.year}</span>
                    <div className="flex-1 bg-slate-800 rounded-full h-1.5 overflow-hidden">
                      <div
                        className={cls('h-full rounded-full', y.net_pnl_pct >= 0 ? 'bg-emerald-500' : 'bg-rose-500')}
                        style={{ width: `${Math.min(100, Math.abs(y.net_pnl_pct))}%` }}
                      />
                    </div>
                    <span className={cls('w-12 text-right font-medium', y.net_pnl_pct >= 0 ? 'text-emerald-400' : 'text-rose-400')}>
                      {y.net_pnl_pct >= 0 ? '+' : ''}{y.net_pnl_pct.toFixed(1)}%
                    </span>
                    <span className="text-slate-500 w-16 text-right">{y.win_rate.toFixed(0)}% WR</span>
                    <span className="text-slate-600 w-10 text-right">{y.trades}T</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Rules */}
          {card.rules?.length > 0 && (
            <div className="p-4">
              <div className="text-xs text-slate-500 uppercase tracking-wide mb-2">Entry Rules</div>
              <ul className="space-y-1">
                {card.rules.map((r, i) => (
                  <li key={i} className="text-xs text-slate-300 flex gap-1.5">
                    <span className="text-brand-500 shrink-0">›</span>{r}
                  </li>
                ))}
              </ul>
              {card.best_for && (
                <div className="mt-2 text-xs text-slate-400">
                  <span className="text-slate-500">Best for: </span>{card.best_for}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ─── Strike Suggestion Card ───────────────────────────────────────────────────

function StrikeSuggestionCard({ s }: { s: StrikeSuggestion }) {
  const isCall = s.option_type === 'CE'
  const borderColor = isCall ? 'border-emerald-500/30' : 'border-rose-500/30'
  const headerBg = isCall ? 'bg-emerald-500/10' : 'bg-rose-500/10'
  const accentColor = isCall ? 'text-emerald-400' : 'text-rose-400'
  const riskColor = RISK_COLOR[s.risk_level] ?? 'text-amber-400'

  return (
    <div className={cls('bg-dark-800 border rounded-xl overflow-hidden', borderColor)}>
      <div className={cls('px-4 py-3 flex items-center justify-between', headerBg)}>
        <div>
          <span className={cls('text-sm font-bold', accentColor)}>
            {s.option_type} {fmt(s.strike, 0)}
          </span>
          <span className="ml-2 text-xs text-slate-400">{s.label}</span>
        </div>
        <div className="flex items-center gap-2">
          <Badge text={s.risk_level} color={cls('bg-black/20', riskColor)} />
          <span className="text-xs text-slate-400">Conf: {s.confidence.toFixed(0)}%</span>
        </div>
      </div>

      <div className="p-4">
        <div className="grid grid-cols-2 gap-3 mb-3 text-sm">
          <div>
            <div className="text-xs text-slate-500 mb-0.5">LTP</div>
            <div className="font-bold text-white">{fmt(s.ltp, 1)}</div>
          </div>
          <div>
            <div className="text-xs text-slate-500 mb-0.5">Entry</div>
            <div className="font-bold text-white">{fmt(s.suggested_entry, 1)}</div>
          </div>
          <div>
            <div className="text-xs text-slate-500 mb-0.5">Target</div>
            <div className="font-bold text-emerald-400">{fmt(s.target, 1)}</div>
          </div>
          <div>
            <div className="text-xs text-slate-500 mb-0.5">Stop Loss</div>
            <div className="font-bold text-rose-400">{fmt(s.stop_loss, 1)}</div>
          </div>
        </div>

        <div className="grid grid-cols-4 gap-2 text-xs mb-3 bg-slate-900/40 rounded-lg p-2">
          <div className="text-center">
            <div className="text-slate-500">Delta</div>
            <div className="text-white font-medium">{s.delta.toFixed(2)}</div>
          </div>
          <div className="text-center">
            <div className="text-slate-500">IV%</div>
            <div className="text-white font-medium">{s.iv.toFixed(1)}</div>
          </div>
          <div className="text-center">
            <div className="text-slate-500">R:R</div>
            <div className="text-white font-medium">{s.risk_reward.toFixed(2)}</div>
          </div>
          <div className="text-center">
            <div className="text-slate-500">Lot</div>
            <div className="text-white font-medium">{s.lot_size}</div>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2 text-xs mb-3">
          <div className="bg-emerald-500/10 border border-emerald-500/20 rounded-lg px-2 py-1.5 text-center">
            <div className="text-slate-500 mb-0.5">Max Profit</div>
            <div className="text-emerald-400 font-bold">₹{fmtInt(s.max_profit)}</div>
          </div>
          <div className="bg-rose-500/10 border border-rose-500/20 rounded-lg px-2 py-1.5 text-center">
            <div className="text-slate-500 mb-0.5">Max Loss</div>
            <div className="text-rose-400 font-bold">₹{fmtInt(s.max_loss)}</div>
          </div>
        </div>

        <p className="text-xs text-slate-400 leading-relaxed">{s.rationale}</p>
        <div className="mt-1 text-xs text-slate-500">Expiry: {s.expiry_date} ({s.expiry_type})</div>
      </div>
    </div>
  )
}

// ─── Option Chain Table ───────────────────────────────────────────────────────

function OptionChainTable({ rows, atm }: { rows: OptionChainRow[]; atm: number }) {
  if (rows.length === 0) {
    return (
      <div className="flex items-center justify-center h-20 text-slate-500 text-sm">
        Option chain data unavailable
      </div>
    )
  }

  const maxCEOI = Math.max(...rows.map(r => r.ce.open_interest))
  const maxPEOI = Math.max(...rows.map(r => r.pe.open_interest))

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="text-slate-500 border-b border-slate-800">
            {/* CE side */}
            <th className="py-2 px-2 text-right text-emerald-500">OI (CE)</th>
            <th className="py-2 px-2 text-right text-emerald-500">IV%</th>
            <th className="py-2 px-2 text-right text-emerald-500">LTP</th>
            {/* Strike */}
            <th className="py-2 px-3 text-center text-white">Strike</th>
            {/* PE side */}
            <th className="py-2 px-2 text-left text-rose-500">LTP</th>
            <th className="py-2 px-2 text-left text-rose-500">IV%</th>
            <th className="py-2 px-2 text-left text-rose-500">OI (PE)</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const isATM = row.strike_price === atm
            const ceOIBarW = maxCEOI > 0 ? (row.ce.open_interest / maxCEOI) * 100 : 0
            const peOIBarW = maxPEOI > 0 ? (row.pe.open_interest / maxPEOI) * 100 : 0
            return (
              <tr
                key={row.strike_price}
                className={cls(
                  'border-b border-slate-800/40 hover:bg-slate-800/20 transition-colors',
                  isATM && 'bg-brand-600/10 border-brand-600/30',
                )}
              >
                {/* CE OI with bar */}
                <td className="py-1.5 px-2 text-right">
                  <div className="flex items-center justify-end gap-1">
                    <div
                      className="h-3 bg-emerald-500/30 rounded-sm"
                      style={{ width: `${ceOIBarW * 0.5}px`, minWidth: 2 }}
                    />
                    <span className="text-emerald-300">{fmtInt(row.ce.open_interest)}</span>
                  </div>
                </td>
                <td className="py-1.5 px-2 text-right text-slate-300">{row.ce.implied_volatility.toFixed(1)}</td>
                <td className="py-1.5 px-2 text-right font-medium text-emerald-400">{fmt(row.ce.last_price, 1)}</td>
                {/* Strike */}
                <td className={cls('py-1.5 px-3 text-center font-bold', isATM ? 'text-brand-400' : 'text-white')}>
                  {fmt(row.strike_price, 0)}
                  {isATM && <span className="ml-1 text-xs text-brand-500">ATM</span>}
                </td>
                {/* PE */}
                <td className="py-1.5 px-2 font-medium text-rose-400">{fmt(row.pe.last_price, 1)}</td>
                <td className="py-1.5 px-2 text-slate-300">{row.pe.implied_volatility.toFixed(1)}</td>
                <td className="py-1.5 px-2">
                  <div className="flex items-center gap-1">
                    <span className="text-rose-300">{fmtInt(row.pe.open_interest)}</span>
                    <div
                      className="h-3 bg-rose-500/30 rounded-sm"
                      style={{ width: `${peOIBarW * 0.5}px`, minWidth: 2 }}
                    />
                  </div>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

// ─── BTST Panel ───────────────────────────────────────────────────────────────

function useCountdown() {
  const [countdown, setCountdown] = useState('')
  const [urgent, setUrgent] = useState(false)

  useEffect(() => {
    function tick() {
      const now = new Date()
      // IST = UTC+5:30
      const istNow = new Date(now.getTime() + (5 * 60 + 30) * 60000)
      const istClose = new Date(istNow)
      istClose.setUTCHours(10, 0, 0, 0) // 15:30 IST = 10:00 UTC
      const diff = istClose.getTime() - istNow.getTime()
      if (diff <= 0) {
        setCountdown('Market Closed')
        setUrgent(false)
        return
      }
      const h = Math.floor(diff / 3600000)
      const m = Math.floor((diff % 3600000) / 60000)
      const s = Math.floor((diff % 60000) / 1000)
      setCountdown(h > 0 ? `${h}h ${m}m ${s}s` : `${m}m ${s}s`)
      setUrgent(diff < 30 * 60000) // urgent in last 30 min
    }
    tick()
    const t = setInterval(tick, 1000)
    return () => clearInterval(t)
  }, [])

  return { countdown, urgent }
}

function BTSTPanel() {
  const [data, setData] = useState<NiftyBTSTSignal | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [lastRefresh, setLastRefresh] = useState<string>('')
  const { countdown, urgent } = useCountdown()

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const d = await getNiftyBTST()
      setData(d)
      setLastRefresh(new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load BTST data')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
    // Auto-refresh every 3 minutes during market hours
    const t = setInterval(load, 3 * 60 * 1000)
    return () => clearInterval(t)
  }, [load])

  const signalConfig = {
    BUY:     { bg: 'bg-emerald-500/15 border-emerald-500/40', text: 'text-emerald-400', icon: '🟢', label: 'BUY — Enter Before 15:25 IST' },
    AVOID:   { bg: 'bg-rose-500/15 border-rose-500/40',       text: 'text-rose-400',    icon: '🔴', label: 'AVOID — Skip BTST Today' },
    NEUTRAL: { bg: 'bg-amber-500/15 border-amber-500/40',     text: 'text-amber-400',   icon: '🟡', label: 'NEUTRAL — Low Conviction' },
  }

  if (loading && !data) {
    return (
      <div className="flex items-center justify-center h-48">
        <div className="w-6 h-6 border-2 border-brand-500 border-t-transparent rounded-full animate-spin" />
      </div>
    )
  }
  if (error) {
    return (
      <div className="bg-rose-500/10 border border-rose-500/30 rounded-xl p-6 text-center">
        <div className="text-rose-400 mb-2">{error}</div>
        <button onClick={load} className="px-3 py-1.5 bg-brand-600 text-white rounded text-sm">Retry</button>
      </div>
    )
  }
  if (!data) return null

  const cfg = signalConfig[data.signal as keyof typeof signalConfig] ?? signalConfig.NEUTRAL
  const changeColor = data.change >= 0 ? 'text-emerald-400' : 'text-rose-400'
  const isOpen = data.market_status === 'OPEN'

  return (
    <div className="space-y-4">
      {/* Top bar: countdown + refresh */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className={cls(
            'flex items-center gap-2 px-3 py-1.5 rounded-lg border text-sm font-semibold',
            isOpen ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-400' : 'border-slate-700 bg-slate-800/40 text-slate-400'
          )}>
            <span className={cls('w-2 h-2 rounded-full', isOpen ? 'bg-emerald-400 animate-pulse' : 'bg-slate-500')} />
            {isOpen ? 'Market Open' : 'Market Closed'}
          </div>
          {isOpen && (
            <div className={cls(
              'flex items-center gap-2 px-3 py-1.5 rounded-lg border text-sm font-mono',
              urgent ? 'border-rose-500/60 bg-rose-500/10 text-rose-300 animate-pulse' : 'border-slate-700 text-slate-300'
            )}>
              {urgent ? '⚡ ' : '⏱ '}Closes in {countdown}
            </div>
          )}
          {urgent && isOpen && (
            <span className="text-xs text-rose-400 font-semibold animate-pulse">Enter NOW or miss BTST window!</span>
          )}
        </div>
        <div className="flex items-center gap-2 text-xs text-slate-500">
          {lastRefresh && <span>Updated {lastRefresh}</span>}
          <span className="text-slate-600">• auto-refresh 3m</span>
          <button
            onClick={load}
            disabled={loading}
            className="px-2 py-1 bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-300 rounded transition-colors disabled:opacity-50"
          >
            {loading ? '…' : '↻'}
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* ── Signal card (left 2/3) ── */}
        <div className="lg:col-span-2 space-y-4">
          {/* Main signal banner */}
          <div className={cls('border rounded-2xl p-5', cfg.bg)}>
            <div className="flex items-start justify-between mb-4">
              <div>
                <div className="text-xs text-slate-400 uppercase tracking-wide mb-1">NIFTY 50 BTST — {data.date}</div>
                <div className={cls('text-2xl font-bold', cfg.text)}>{cfg.icon} {cfg.label}</div>
                <div className="text-sm text-slate-400 mt-1">{data.strategy} • Confidence {data.confidence.toFixed(0)}%</div>
              </div>
              <div className="text-right">
                <div className="text-3xl font-bold text-white tabular-nums">{data.spot_price.toLocaleString('en-IN', { maximumFractionDigits: 0 })}</div>
                <div className={cls('text-sm font-semibold', changeColor)}>
                  {data.change >= 0 ? '+' : ''}{data.change.toFixed(0)} ({data.change >= 0 ? '+' : ''}{data.change_pct.toFixed(2)}%)
                </div>
                <div className="text-xs text-slate-500 mt-0.5">
                  O:{data.open.toFixed(0)} H:{data.high.toFixed(0)} L:{data.low.toFixed(0)}
                </div>
              </div>
            </div>

            {/* Score bar */}
            <div className="mb-4">
              <div className="flex items-center justify-between text-xs text-slate-400 mb-1">
                <span>BTST Score</span>
                <span className={cls('font-bold', data.score >= 5 ? 'text-emerald-400' : data.score <= 0 ? 'text-rose-400' : 'text-amber-400')}>
                  {data.score > 0 ? '+' : ''}{data.score} / +11
                </span>
              </div>
              <div className="w-full h-2 bg-slate-800 rounded-full overflow-hidden">
                <div
                  className={cls('h-full rounded-full transition-all', data.score >= 5 ? 'bg-emerald-500' : data.score <= 0 ? 'bg-rose-500' : 'bg-amber-500')}
                  style={{ width: `${Math.max(4, Math.min(100, (data.score + 4) / 15 * 100))}%` }}
                />
              </div>
            </div>

            {/* Entry details */}
            {data.signal === 'BUY' && (
              <div className="grid grid-cols-3 gap-3 mb-4">
                <div className="bg-black/20 rounded-xl p-3 text-center">
                  <div className="text-xs text-slate-400 mb-1">Entry (near close)</div>
                  <div className="text-lg font-bold text-white">{data.entry_price.toLocaleString('en-IN', { maximumFractionDigits: 0 })}</div>
                </div>
                <div className="bg-emerald-500/10 border border-emerald-500/20 rounded-xl p-3 text-center">
                  <div className="text-xs text-slate-400 mb-1">Target (+1.5%)</div>
                  <div className="text-lg font-bold text-emerald-400">{data.target_price.toLocaleString('en-IN', { maximumFractionDigits: 0 })}</div>
                </div>
                <div className="bg-rose-500/10 border border-rose-500/20 rounded-xl p-3 text-center">
                  <div className="text-xs text-slate-400 mb-1">Stop Loss</div>
                  <div className="text-lg font-bold text-rose-400">{data.stop_loss.toLocaleString('en-IN', { maximumFractionDigits: 0 })}</div>
                </div>
              </div>
            )}

            {data.signal === 'BUY' && (
              <div className="flex flex-wrap items-center gap-4 text-xs text-slate-300 mb-3">
                <span>R:R <span className="text-white font-bold">{data.risk_reward.toFixed(2)}</span></span>
                <span>ATR <span className="text-white">{data.atr.toFixed(0)}</span></span>
                <span className="text-slate-500">|</span>
                <span>Entry window: <span className="text-amber-300 font-medium">{data.entry_window}</span></span>
                <span>Exit: <span className="text-emerald-300 font-medium">{data.exit_window}</span></span>
              </div>
            )}

            <p className={cls('text-sm rounded-lg px-3 py-2', data.signal === 'BUY' ? 'bg-emerald-500/10 text-emerald-200' : data.signal === 'AVOID' ? 'bg-rose-500/10 text-rose-200' : 'bg-amber-500/10 text-amber-200')}>
              {data.note}
            </p>
          </div>

          {/* Criteria checklist */}
          <div className="bg-dark-800 border border-slate-800/60 rounded-xl p-4">
            <div className="text-xs text-slate-500 uppercase tracking-wide mb-3">BTST Criteria (8 checks)</div>
            <div className="space-y-2">
              {(data.criteria ?? []).map((c, i) => (
                <div key={i} className={cls(
                  'flex items-center justify-between rounded-lg px-3 py-2 text-sm',
                  c.met ? 'bg-emerald-500/8 border border-emerald-500/20' : 'bg-rose-500/8 border border-rose-500/20'
                )}>
                  <div className="flex items-center gap-2">
                    <span>{c.met ? '✅' : '❌'}</span>
                    <span className={c.met ? 'text-slate-200' : 'text-slate-400'}>{c.label}</span>
                    {c.weight >= 2 && <span className="text-xs px-1.5 py-0.5 rounded bg-slate-700/60 text-slate-400">key</span>}
                  </div>
                  <span className={cls('text-xs font-mono', c.met ? 'text-emerald-300' : 'text-rose-300')}>{c.value}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* ── Indicators sidebar (right 1/3) ── */}
        <div className="space-y-3">
          <div className="bg-dark-800 border border-slate-800/60 rounded-xl p-4">
            <div className="text-xs text-slate-500 uppercase tracking-wide mb-3">Live Indicators</div>
            <div className="space-y-3">
              {[
                { label: 'EMA 9', value: data.ema9.toFixed(0), color: data.ema9 > data.ema21 ? 'text-emerald-400' : 'text-rose-400' },
                { label: 'EMA 21', value: data.ema21.toFixed(0), color: 'text-blue-400' },
                { label: 'SMA 50', value: data.sma50.toFixed(0), color: data.spot_price > data.sma50 ? 'text-emerald-400' : 'text-rose-400' },
                { label: 'RSI (14)', value: data.rsi.toFixed(1), color: data.rsi >= 52 && data.rsi <= 72 ? 'text-emerald-400' : data.rsi > 72 ? 'text-rose-400' : 'text-amber-400' },
                { label: 'ATR (14)', value: data.atr.toFixed(0), color: 'text-slate-300' },
                { label: 'MACD Hist', value: (data.macd_hist >= 0 ? '+' : '') + data.macd_hist.toFixed(1), color: data.macd_hist >= 0 ? 'text-emerald-400' : 'text-rose-400' },
                { label: 'Vol Ratio', value: data.volume_ratio > 0 ? data.volume_ratio.toFixed(2) + 'x' : 'market open', color: data.volume_ratio >= 1.5 ? 'text-emerald-400' : data.volume_ratio >= 1.0 ? 'text-slate-300' : 'text-rose-400' },
                { label: 'Close Position', value: data.close_position.toFixed(0) + '% of range', color: data.close_position >= 55 ? 'text-emerald-400' : 'text-rose-400' },
              ].map(row => (
                <div key={row.label} className="flex items-center justify-between text-sm">
                  <span className="text-slate-400">{row.label}</span>
                  <span className={cls('font-semibold tabular-nums', row.color)}>{row.value}</span>
                </div>
              ))}
            </div>
          </div>

          {/* BTST rules */}
          <div className="bg-dark-800 border border-slate-800/60 rounded-xl p-4">
            <div className="text-xs text-slate-500 uppercase tracking-wide mb-3">BTST Rules</div>
            <ul className="space-y-2 text-xs text-slate-400">
              <li className="flex gap-2"><span className="text-brand-500 shrink-0">›</span>Enter between 15:00–15:25 IST (last 30 min)</li>
              <li className="flex gap-2"><span className="text-brand-500 shrink-0">›</span>Exit next day 10:00–15:15 IST</li>
              <li className="flex gap-2"><span className="text-brand-500 shrink-0">›</span>Use Nifty Futures (lot 25) or NIFTYBEES ETF</li>
              <li className="flex gap-2"><span className="text-brand-500 shrink-0">›</span>Stop loss below today's low. No overnight hold without SL.</li>
              <li className="flex gap-2"><span className="text-brand-500 shrink-0">›</span>Skip BTST on days with major news/RBI/Fed events</li>
              <li className="flex gap-2"><span className="text-amber-500 shrink-0">⚠</span>This is a high-risk overnight trade. Size appropriately.</li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── Strategies Tab ───────────────────────────────────────────────────────────

function StrategiesTab({
  dashboardCards,
  years,
}: {
  dashboardCards: NiftyStrategyCard[]
  years: number
}) {
  const [cardSymbol, setCardSymbol] = useState('^NSEI')
  const [backtestCards, setBacktestCards] = useState<CardData[] | null>(null)
  const [btLoading, setBtLoading]   = useState(false)
  const [btError, setBtError]       = useState<string | null>(null)

  // When symbol changes, fetch live backtest (skip for NIFTY — use dashboard data)
  useEffect(() => {
    if (cardSymbol === '^NSEI') {
      setBacktestCards(null)
      setBtError(null)
      return
    }
    setBtLoading(true)
    setBtError(null)
    getScalpingBacktest(cardSymbol, years)
      .then(report => setBacktestCards(report.strategies.map(scalpResultToCardData)))
      .catch(e => setBtError(e.message))
      .finally(() => setBtLoading(false))
  }, [cardSymbol, years])

  // Which cards to display
  const cards: CardData[] =
    cardSymbol === '^NSEI'
      ? dashboardCards.filter(c => c.win_rate >= 50).map(niftyCardToCardData)
      : (backtestCards ?? []).filter(c => c.win_rate >= 50)

  const selectedSym = CARD_SYMBOLS.find(s => s.symbol === cardSymbol)

  return (
    <div>
      {/* Header row with dropdown */}
      <div className="flex flex-wrap items-center gap-3 mb-4">
        <div>
          <h2 className="text-base font-semibold text-white">
            Strategy Cards
          </h2>
          <p className="text-xs text-slate-400 mt-0.5">
            {years}-year backtested · ≥50% win rate · select a symbol to re-run live
          </p>
        </div>

        <div className="ml-auto flex items-center gap-2">
          <span className="text-xs text-slate-500">Backtest symbol:</span>
          <select
            value={cardSymbol}
            onChange={e => setCardSymbol(e.target.value)}
            className="bg-dark-900 border border-slate-700 rounded-lg px-3 py-1.5 text-white text-sm font-medium min-w-[180px] focus:outline-none focus:border-brand-500"
          >
            {CARD_SYMBOLS.map(s => (
              <option key={s.symbol} value={s.symbol}>
                {s.label}  ({s.sector})
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Loading state */}
      {btLoading && (
        <div className="bg-dark-800 border border-slate-800/60 rounded-xl p-8 flex flex-col items-center gap-3 mb-4">
          <div className="w-8 h-8 border-2 border-brand-500 border-t-transparent rounded-full animate-spin" />
          <div className="text-sm text-slate-400">
            Running {years}-year backtest on <span className="text-white font-semibold">{selectedSym?.label}</span>…
          </div>
          <div className="text-xs text-slate-500">Fetching live data from Yahoo Finance · applying all strategies</div>
        </div>
      )}

      {/* Error state */}
      {btError && !btLoading && (
        <div className="bg-rose-500/10 border border-rose-500/30 rounded-xl p-4 mb-4 flex items-start gap-3">
          <span className="text-rose-400 text-lg shrink-0">⚠️</span>
          <div>
            <div className="text-sm text-rose-400 font-medium">Backtest failed for {selectedSym?.label}</div>
            <div className="text-xs text-slate-400 mt-0.5">{btError}</div>
          </div>
        </div>
      )}

      {/* Symbol + result context bar */}
      {!btLoading && cardSymbol !== '^NSEI' && backtestCards && (
        <div className="bg-brand-950/40 border border-brand-600/20 rounded-xl px-4 py-2.5 mb-4 flex flex-wrap items-center gap-4 text-xs">
          <span className="text-brand-400 font-semibold">{selectedSym?.label}</span>
          <span className="text-slate-500">{years}-year backtest · {backtestCards.filter(c => c.win_rate >= 50).length} strategies ≥50% WR</span>
          <div className="flex gap-3 ml-auto">
            {/* Top 3 win rates at a glance */}
            {[...backtestCards]
              .sort((a, b) => b.win_rate - a.win_rate)
              .slice(0, 3)
              .map(c => (
                <span key={c.strategy_name} className="flex items-center gap-1">
                  <span className="text-slate-400 truncate max-w-[100px]">{c.strategy_name.split(' ').slice(0, 2).join(' ')}</span>
                  <span className={`font-bold ${c.win_rate >= 60 ? 'text-emerald-400' : 'text-amber-400'}`}>
                    {c.win_rate.toFixed(1)}%
                  </span>
                </span>
              ))}
          </div>
        </div>
      )}

      {/* Cards grid */}
      {!btLoading && cards.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4 gap-4">
          {cards.map(card => (
            <StrategyCard key={card.strategy_name} card={card} />
          ))}
        </div>
      )}

      {/* Empty state */}
      {!btLoading && !btError && cards.length === 0 && backtestCards !== null && (
        <div className="bg-dark-800 border border-slate-800/60 rounded-xl p-8 text-center">
          <div className="text-2xl mb-2">📉</div>
          <div className="text-slate-400 text-sm">No strategies exceeded 50% win rate for {selectedSym?.label}</div>
          <div className="text-slate-500 text-xs mt-1">Try a different symbol or extend the backtest period</div>
        </div>
      )}
    </div>
  )
}

// ─── Tomorrow Picks Tab ──────────────────────────────────────────────────────

const DIR_STYLE: Record<string, string> = {
  BUY:     'bg-emerald-500/15 text-emerald-300 border border-emerald-500/40',
  SELL:    'bg-red-500/15 text-red-300 border border-red-500/40',
  NEUTRAL: 'bg-slate-600/40 text-slate-400 border border-slate-600',
}

const SECTOR_DOT: Record<string, string> = {
  Index:   'bg-violet-400',
  Banking: 'bg-blue-400',
  IT:      'bg-cyan-400',
  Energy:  'bg-orange-400',
  Auto:    'bg-yellow-400',
  FMCG:   'bg-green-400',
  Pharma:  'bg-pink-400',
  Metal:   'bg-slate-400',
  Power:   'bg-amber-400',
  Realty:  'bg-rose-400',
  Finance: 'bg-indigo-400',
}

function ProbBar({ value }: { value: number }) {
  const color = value >= 70 ? 'bg-emerald-500' : value >= 50 ? 'bg-amber-500' : 'bg-red-500'
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-1.5 bg-slate-700 rounded-full overflow-hidden">
        <div className={cls('h-full rounded-full transition-all', color)} style={{ width: `${value}%` }} />
      </div>
      <span className="text-xs font-bold tabular-nums text-white w-10 text-right">{value.toFixed(1)}%</span>
    </div>
  )
}

// ─── Entry / Exit Drawer ──────────────────────────────────────────────────────

const TODAY_STATUS_STYLE: Record<string, string> = {
  TARGET_HIT: 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40',
  SL_HIT:     'bg-red-500/20 text-red-300 border border-red-500/40',
  OPEN:       'bg-amber-500/20 text-amber-300 border border-amber-500/40',
  NO_SIGNAL:  'bg-slate-600/40 text-slate-400 border border-slate-600',
}
const TODAY_STATUS_LABEL: Record<string, string> = {
  TARGET_HIT: '✓ Target Hit',
  SL_HIT:     '✕ SL Hit',
  OPEN:       '◉ Open',
  NO_SIGNAL:  '— No Signal',
}

// ─── Option row inside the drawer ────────────────────────────────────────────

function pct(a: number, b: number) {
  return b > 0 ? (((a - b) / b) * 100).toFixed(0) : '0'
}

function OptionRow({ s, recommended }: { s: StrikeSuggestion; recommended: boolean }) {
  const isCE = s.option_type === 'CE'
  return (
    <tr className={cls(
      'border-b border-slate-800/60 transition-colors',
      recommended
        ? isCE ? 'bg-emerald-900/25 hover:bg-emerald-900/35' : 'bg-red-900/25 hover:bg-red-900/35'
        : 'hover:bg-slate-800/30',
    )}>
      {/* Strike */}
      <td className="py-2.5 px-3">
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className={cls(
            'text-xs font-bold px-1.5 py-0.5 rounded',
            isCE ? 'bg-emerald-500/20 text-emerald-300' : 'bg-red-500/20 text-red-300',
          )}>{s.option_type}</span>
          <span className="text-white font-bold tabular-nums text-sm">
            {s.strike.toLocaleString('en-IN', { maximumFractionDigits: 0 })}
          </span>
          {recommended && (
            <span className={cls(
              'text-xs font-bold px-1.5 py-0.5 rounded-full',
              isCE ? 'bg-emerald-500/30 text-emerald-200' : 'bg-red-500/30 text-red-200',
            )}>★ Best</span>
          )}
        </div>
        <div className="text-xs text-slate-500 mt-0.5">
          {s.label} · Δ {Math.abs(s.delta).toFixed(2)} · IV {s.iv.toFixed(0)}%
        </div>
      </td>
      {/* Entry */}
      <td className="py-2.5 px-3 text-center">
        <div className={cls('font-bold tabular-nums text-sm', recommended ? 'text-white' : 'text-slate-300')}>
          ₹{s.suggested_entry.toFixed(1)}
        </div>
      </td>
      {/* Target */}
      <td className="py-2.5 px-3 text-center">
        <div className="text-emerald-400 font-bold tabular-nums text-sm">₹{s.target.toFixed(1)}</div>
        <div className="text-xs text-emerald-600">+{pct(s.target, s.suggested_entry)}%</div>
      </td>
      {/* SL */}
      <td className="py-2.5 px-3 text-center">
        <div className="text-red-400 font-bold tabular-nums text-sm">₹{s.stop_loss.toFixed(1)}</div>
        <div className="text-xs text-red-600">-{pct(s.suggested_entry, s.stop_loss)}%</div>
      </td>
      {/* R:R */}
      <td className="py-2.5 px-3 text-center">
        <div className={cls('font-bold text-sm tabular-nums',
          s.risk_reward >= 1.5 ? 'text-emerald-400' : 'text-amber-400')}>
          1:{s.risk_reward.toFixed(1)}
        </div>
        <div className="text-xs text-slate-500">{s.risk_level === 'CONSERVATIVE' ? 'Safe' : s.risk_level === 'AGGRESSIVE' ? 'Aggr' : 'Mod'}</div>
      </td>
    </tr>
  )
}

function OptionSignalBanner({ direction, pick, opts }: {
  direction: string
  pick: TomorrowPick
  opts: NonNullable<TomorrowPick['options']>
}) {
  const isBuy   = direction === 'BUY'
  const isSell  = direction === 'SELL'
  const showCE  = isBuy || (!isBuy && !isSell)
  const showPE  = isSell || (!isBuy && !isSell)

  // Primary recommended strike = ATM of the active direction
  const primaryType = isSell ? 'PE' : 'CE'
  const rec = opts.suggestions.find(s => s.option_type === primaryType && s.label === 'ATM')
    ?? opts.suggestions.find(s => s.option_type === primaryType)

  return (
    <div className="space-y-4">
      {/* Signal banner */}
      {rec && (isBuy || isSell) && (
        <div className={cls(
          'rounded-xl border p-4',
          isBuy
            ? 'bg-emerald-900/30 border-emerald-500/40'
            : 'bg-red-900/30 border-red-500/40',
        )}>
          {/* Action line */}
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <span className={cls(
                'text-sm font-bold px-3 py-1.5 rounded-full',
                isBuy ? 'bg-emerald-500/25 text-emerald-200 border border-emerald-500/50'
                      : 'bg-red-500/25 text-red-200 border border-red-500/50',
              )}>
                {isBuy ? '📈 BUY CALL (CE)' : '📉 BUY PUT (PE)'}
              </span>
              <span className="text-slate-400 text-xs">{pick.best_strategy}</span>
            </div>
            <span className="text-xs text-slate-500">Expiry {opts.expiry}</span>
          </div>

          {/* Recommended strike spotlight */}
          <div className="text-xs text-slate-400 mb-2">
            ★ Recommended strike — ATM {rec.strike.toLocaleString('en-IN', { maximumFractionDigits: 0 })} {rec.option_type}
            <span className="ml-2 text-slate-500">Lot {rec.lot_size} · Δ {Math.abs(rec.delta).toFixed(2)} · IV {rec.iv.toFixed(0)}%</span>
          </div>
          <div className="grid grid-cols-3 gap-2">
            <div className="bg-slate-800/60 rounded-lg p-2.5 text-center">
              <div className="text-xs text-slate-500 mb-0.5">Entry</div>
              <div className="text-base font-bold text-white tabular-nums">₹{rec.suggested_entry.toFixed(1)}</div>
            </div>
            <div className={cls('rounded-lg p-2.5 text-center border',
              isBuy ? 'bg-emerald-900/30 border-emerald-700/40' : 'bg-red-900/30 border-red-700/40')}>
              <div className="text-xs text-emerald-400 mb-0.5">Target</div>
              <div className="text-base font-bold text-emerald-300 tabular-nums">₹{rec.target.toFixed(1)}</div>
              <div className="text-xs text-emerald-600">+{pct(rec.target, rec.suggested_entry)}%</div>
            </div>
            <div className="bg-red-900/20 border border-red-700/40 rounded-lg p-2.5 text-center">
              <div className="text-xs text-red-400 mb-0.5">Stop Loss</div>
              <div className="text-base font-bold text-red-300 tabular-nums">₹{rec.stop_loss.toFixed(1)}</div>
              <div className="text-xs text-red-600">-{pct(rec.suggested_entry, rec.stop_loss)}%</div>
            </div>
          </div>

          {/* Max profit / loss per lot */}
          <div className="flex items-center justify-between mt-3 pt-3 border-t border-slate-700/50 text-xs">
            <span className="text-slate-500">Per lot ({rec.lot_size} qty)</span>
            <div className="flex items-center gap-4">
              <span className="text-emerald-400 font-semibold">
                Max profit ₹{rec.max_profit.toLocaleString('en-IN', { maximumFractionDigits: 0 })}
              </span>
              <span className="text-red-400 font-semibold">
                Max loss ₹{rec.max_loss.toLocaleString('en-IN', { maximumFractionDigits: 0 })}
              </span>
              <span className={cls('font-bold', rec.risk_reward >= 1.5 ? 'text-emerald-400' : 'text-amber-400')}>
                R:R 1:{rec.risk_reward.toFixed(1)}
              </span>
            </div>
          </div>
        </div>
      )}

      {/* Neutral note */}
      {!isBuy && !isSell && (
        <div className="bg-slate-800/60 border border-slate-700/50 rounded-xl p-3 text-center text-xs text-slate-400">
          No active signal — showing all strikes for reference. Wait for a BUY or SELL signal before entering.
        </div>
      )}

      {/* Full CE table */}
      {showCE && opts.suggestions.filter(s => s.option_type === 'CE').length > 0 && (
        <div>
          <div className="text-xs text-emerald-400 font-semibold mb-1.5 flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-emerald-500" />
            CALL (CE) — Bullish strikes
          </div>
          <div className="rounded-xl overflow-hidden border border-slate-800">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-slate-800/80 text-slate-400 text-xs">
                  <th className="py-2 px-3 text-left font-medium">Strike</th>
                  <th className="py-2 px-3 text-center font-medium">Entry ₹</th>
                  <th className="py-2 px-3 text-center font-medium">Target ₹</th>
                  <th className="py-2 px-3 text-center font-medium">SL ₹</th>
                  <th className="py-2 px-3 text-center font-medium">R:R</th>
                </tr>
              </thead>
              <tbody>
                {opts.suggestions
                  .filter(s => s.option_type === 'CE')
                  .map((s, i) => (
                    <OptionRow key={i} s={s} recommended={s.label === 'ATM'} />
                  ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Full PE table */}
      {showPE && opts.suggestions.filter(s => s.option_type === 'PE').length > 0 && (
        <div>
          <div className="text-xs text-red-400 font-semibold mb-1.5 flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-red-500" />
            PUT (PE) — Bearish strikes
          </div>
          <div className="rounded-xl overflow-hidden border border-slate-800">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-slate-800/80 text-slate-400 text-xs">
                  <th className="py-2 px-3 text-left font-medium">Strike</th>
                  <th className="py-2 px-3 text-center font-medium">Entry ₹</th>
                  <th className="py-2 px-3 text-center font-medium">Target ₹</th>
                  <th className="py-2 px-3 text-center font-medium">SL ₹</th>
                  <th className="py-2 px-3 text-center font-medium">R:R</th>
                </tr>
              </thead>
              <tbody>
                {opts.suggestions
                  .filter(s => s.option_type === 'PE')
                  .map((s, i) => (
                    <OptionRow key={i} s={s} recommended={s.label === 'ATM'} />
                  ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="text-xs text-slate-600">
        Premiums estimated from ATR-derived IV · Lot sizes per NSE F&amp;O · Always verify on NSE before trading
      </div>
    </div>
  )
}

function EntryExitDrawer({ pick, mode, onClose }: { pick: TomorrowPick; mode: 'today' | 'tomorrow'; onClose: () => void }) {
  const isToday = mode === 'today'
  const rr = pick.risk_reward
  const status = pick.today_status ?? 'NO_SIGNAL'
  const opts = pick.options

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-2 sm:p-4" onClick={onClose}>
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" />
      <div
        className="relative bg-dark-900 border border-slate-700 rounded-2xl w-full max-w-2xl shadow-2xl max-h-[92vh] flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        {/* ── Header ── */}
        <div className={cls(
          'flex items-center justify-between px-5 py-4 rounded-t-2xl border-b border-slate-800 shrink-0',
          pick.direction === 'BUY' ? 'bg-emerald-900/25'
            : pick.direction === 'SELL' ? 'bg-red-900/25'
            : 'bg-slate-800/60',
        )}>
          <div>
            <div className="text-white font-bold text-base">{pick.name}
              <span className="ml-2 text-slate-400 font-normal text-sm">{pick.symbol}</span>
            </div>
            <div className="text-xs text-slate-400 mt-0.5">{pick.best_strategy} · {pick.sector}</div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <span className={cls('text-xs font-bold px-2.5 py-1 rounded-full', DIR_STYLE[pick.direction] ?? DIR_STYLE.NEUTRAL)}>
              {pick.direction === 'BUY' ? '▲ BUY' : pick.direction === 'SELL' ? '▼ SELL' : '— NEUTRAL'}
            </span>
            {isToday && status !== 'NO_SIGNAL' && (
              <span className={cls('text-xs font-bold px-2.5 py-1 rounded-full', TODAY_STATUS_STYLE[status])}>
                {TODAY_STATUS_LABEL[status]}
              </span>
            )}
            <button onClick={onClose} className="text-slate-400 hover:text-white text-xl leading-none">✕</button>
          </div>
        </div>

        {/* ── Scrollable body ── */}
        <div className="overflow-y-auto p-5 space-y-5">

          {/* Today's OHLC */}
          {isToday && pick.today_close > 0 && (
            <div className="bg-slate-800/60 rounded-xl p-4">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs text-slate-500">Today's Bar · {pick.signal_date}</span>
                <span className={cls('text-sm font-bold tabular-nums',
                  pick.today_pnl_pct >= 0 ? 'text-emerald-400' : 'text-red-400')}>
                  {pick.today_pnl_pct >= 0 ? '+' : ''}{pick.today_pnl_pct.toFixed(2)}% P&L
                </span>
              </div>
              <div className="grid grid-cols-4 gap-2 text-center text-xs">
                {(['Open', 'High', 'Low', 'Close'] as const).map((label) => {
                  const val = label === 'Open' ? pick.today_open : label === 'High' ? pick.today_high
                    : label === 'Low' ? pick.today_low : pick.today_close
                  return (
                    <div key={label} className="bg-slate-700/50 rounded-lg py-2">
                      <div className="text-slate-500 mb-0.5">{label}</div>
                      <div className="font-semibold text-white tabular-nums">
                        ₹{val.toLocaleString('en-IN', { maximumFractionDigits: 0 })}
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {/* ── Underlying entry / exit ── */}
          <div>
            <div className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">
              Underlying (Stock / Index)
            </div>
            {pick.direction !== 'NEUTRAL' && pick.entry_price > 0 ? (
              <div className="space-y-2">
                {/* Three price boxes */}
                <div className="grid grid-cols-3 gap-2">
                  <div className="bg-slate-800/60 rounded-xl p-3 text-center">
                    <div className="text-xs text-slate-500 mb-1">Entry</div>
                    <div className="text-base font-bold text-white tabular-nums">
                      ₹{pick.entry_price.toLocaleString('en-IN', { maximumFractionDigits: 2 })}
                    </div>
                    <div className="text-xs text-slate-500 mt-0.5">
                      {isToday ? "Today's open" : "Tomorrow's open"}
                    </div>
                  </div>
                  <div className={cls('rounded-xl p-3 text-center border',
                    isToday && status === 'TARGET_HIT'
                      ? 'bg-emerald-500/20 border-emerald-400/50' : 'bg-emerald-900/20 border-emerald-700/40')}>
                    <div className="text-xs text-emerald-400 mb-1">Target {isToday && status === 'TARGET_HIT' && '✓'}</div>
                    <div className="text-base font-bold text-emerald-300 tabular-nums">
                      ₹{pick.target_price.toLocaleString('en-IN', { maximumFractionDigits: 2 })}
                    </div>
                    <div className="text-xs text-emerald-600 mt-0.5">+{pick.target_pct.toFixed(2)}%</div>
                  </div>
                  <div className={cls('rounded-xl p-3 text-center border',
                    isToday && status === 'SL_HIT'
                      ? 'bg-red-500/20 border-red-400/50' : 'bg-red-900/20 border-red-700/40')}>
                    <div className="text-xs text-red-400 mb-1">Stop Loss {isToday && status === 'SL_HIT' && '✕'}</div>
                    <div className="text-base font-bold text-red-300 tabular-nums">
                      ₹{pick.stop_loss.toLocaleString('en-IN', { maximumFractionDigits: 2 })}
                    </div>
                    <div className="text-xs text-red-600 mt-0.5">-{pick.stop_pct.toFixed(2)}%</div>
                  </div>
                </div>

                {/* Visual range bar */}
                <div className="bg-slate-800/40 rounded-xl px-4 py-3">
                  <div className="flex justify-between text-xs text-slate-500 mb-1.5">
                    <span>SL ₹{pick.stop_loss.toLocaleString('en-IN', { maximumFractionDigits: 0 })}</span>
                    <span>Entry ₹{pick.entry_price.toLocaleString('en-IN', { maximumFractionDigits: 0 })}</span>
                    <span>TGT ₹{pick.target_price.toLocaleString('en-IN', { maximumFractionDigits: 0 })}</span>
                  </div>
                  <div className="relative h-2 bg-slate-700 rounded-full overflow-hidden">
                    <div className="absolute left-0 h-full bg-red-500/50" style={{ width: '33%' }} />
                    <div className="absolute right-0 h-full bg-emerald-500/50" style={{ width: '67%' }} />
                    <div className="absolute top-0 bottom-0 w-0.5 bg-white" style={{ left: '33%' }} />
                    {isToday && pick.today_close > 0 && pick.target_price > pick.stop_loss && (() => {
                      const pos = ((pick.today_close - pick.stop_loss) / (pick.target_price - pick.stop_loss)) * 100
                      return <div className="absolute top-0 bottom-0 w-1 bg-amber-400 rounded-full"
                        style={{ left: `${Math.min(Math.max(pos, 0), 100)}%` }} />
                    })()}
                  </div>
                  {isToday && pick.today_close > 0 && (
                    <div className="text-xs text-amber-400 mt-1 text-right">
                      ● Current ₹{pick.today_close.toLocaleString('en-IN', { maximumFractionDigits: 0 })}
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <div className="bg-slate-800/40 rounded-xl p-4 text-center">
                <div className="text-slate-400 text-sm">No active signal · showing historical averages</div>
                <div className="grid grid-cols-2 gap-3 mt-3">
                  <div className="py-2 px-3 bg-emerald-900/20 border border-emerald-700/30 rounded-lg">
                    <div className="text-xs text-emerald-400">Avg Win</div>
                    <div className="text-sm font-bold text-emerald-300">+{pick.avg_win_pct.toFixed(2)}%</div>
                  </div>
                  <div className="py-2 px-3 bg-red-900/20 border border-red-700/30 rounded-lg">
                    <div className="text-xs text-red-400">Avg Loss</div>
                    <div className="text-sm font-bold text-red-300">{pick.avg_loss_pct.toFixed(2)}%</div>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* ── Option Strike Suggestions ── */}
          {opts && (
            <OptionSignalBanner direction={pick.direction} pick={pick} opts={opts} />
          )}

          {/* ── Strategy stats ── */}
          <div className="grid grid-cols-4 gap-2 text-center">
            {[
              { label: 'Win Rate', val: `${pick.win_rate.toFixed(1)}%`, color: 'text-white' },
              { label: 'R:R', val: `1:${rr.toFixed(1)}`, color: rr >= 2 ? 'text-emerald-400' : rr >= 1 ? 'text-amber-400' : 'text-red-400' },
              { label: 'Prob.', val: `${pick.trade_probability.toFixed(1)}%`, color: 'text-white' },
              { label: 'Exp P&L', val: `${pick.expected_pnl >= 0 ? '+' : ''}${pick.expected_pnl.toFixed(2)}%`, color: pick.expected_pnl >= 0 ? 'text-emerald-400' : 'text-red-400' },
            ].map(({ label, val, color }) => (
              <div key={label} className="bg-slate-800/60 rounded-lg py-2.5">
                <div className="text-xs text-slate-500 mb-0.5">{label}</div>
                <div className={cls('text-sm font-bold', color)}>{val}</div>
              </div>
            ))}
          </div>

          <div className="text-xs text-slate-600 text-center pb-1">
            {pick.total_trades} backtested trades · {pick.data_points} days of data
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── Shared Pick Card ─────────────────────────────────────────────────────────

function PickCard({ pick, rank, mode }: { pick: TomorrowPick; rank: number; mode: 'today' | 'tomorrow' }) {
  const [drawerOpen, setDrawerOpen] = useState(false)
  const isToday = mode === 'today'
  const dirStyle = DIR_STYLE[pick.direction] ?? DIR_STYLE.NEUTRAL
  const dotColor = SECTOR_DOT[pick.sector] ?? 'bg-slate-400'
  const status = pick.today_status ?? 'NO_SIGNAL'

  return (
    <>
      <div className={cls(
        'border rounded-xl p-4 flex flex-col gap-3 hover:border-slate-600 transition-colors',
        isToday && status === 'TARGET_HIT' ? 'bg-emerald-900/10 border-emerald-700/40'
          : isToday && status === 'SL_HIT' ? 'bg-red-900/10 border-red-700/40'
          : 'bg-dark-800 border-slate-800/60',
      )}>
        {/* Header */}
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-2">
            <span className="text-slate-500 text-xs font-mono w-5">#{rank}</span>
            <span className={cls('w-2 h-2 rounded-full shrink-0', dotColor)} />
            <div>
              <div className="text-sm font-semibold text-white">{pick.name}</div>
              <div className="text-xs text-slate-500">{pick.symbol} · {pick.sector}</div>
            </div>
          </div>
          <div className="flex flex-col items-end gap-1">
            <span className={cls('text-xs font-bold px-2.5 py-0.5 rounded-full', dirStyle)}>
              {pick.direction === 'BUY' ? '▲ BUY' : pick.direction === 'SELL' ? '▼ SELL' : '— NEUTRAL'}
            </span>
            {isToday && status !== 'NO_SIGNAL' && (
              <span className={cls('text-xs font-semibold px-2 py-0.5 rounded-full', TODAY_STATUS_STYLE[status])}>
                {TODAY_STATUS_LABEL[status]}
              </span>
            )}
          </div>
        </div>

        {/* Today P&L or probability bar */}
        {isToday && status !== 'NO_SIGNAL' ? (
          <div className="flex items-center justify-between bg-slate-800/60 rounded-lg px-3 py-2">
            <span className="text-xs text-slate-500">Today P&L</span>
            <span className={cls(
              'text-sm font-bold tabular-nums',
              pick.today_pnl_pct >= 0 ? 'text-emerald-400' : 'text-red-400',
            )}>
              {pick.today_pnl_pct >= 0 ? '+' : ''}{pick.today_pnl_pct.toFixed(2)}%
            </span>
          </div>
        ) : (
          <div>
            <span className="text-xs text-slate-500">Trade Probability</span>
            <ProbBar value={pick.trade_probability} />
          </div>
        )}

        {/* Key metrics */}
        <div className="grid grid-cols-3 gap-2 text-center">
          <div className="bg-slate-800/60 rounded-lg py-2">
            <div className="text-xs text-slate-500 mb-0.5">Win Rate</div>
            <div className="text-sm font-bold text-white tabular-nums">{pick.win_rate.toFixed(1)}%</div>
          </div>
          <div className="bg-slate-800/60 rounded-lg py-2">
            <div className="text-xs text-slate-500 mb-0.5">R:R</div>
            <div className={cls(
              'text-sm font-bold tabular-nums',
              pick.risk_reward >= 2 ? 'text-emerald-400' : pick.risk_reward >= 1 ? 'text-amber-400' : 'text-red-400',
            )}>1:{pick.risk_reward.toFixed(1)}</div>
          </div>
          <div className="bg-slate-800/60 rounded-lg py-2">
            <div className="text-xs text-slate-500 mb-0.5">Net P&L</div>
            <div className={cls('text-sm font-bold tabular-nums', pick.net_pnl_pct >= 0 ? 'text-emerald-400' : 'text-red-400')}>
              {pick.net_pnl_pct >= 0 ? '+' : ''}{pick.net_pnl_pct.toFixed(1)}%
            </div>
          </div>
        </div>

        {/* Entry/Exit button + strategy footer */}
        <div className="border-t border-slate-800 pt-2 flex items-center justify-between gap-2">
          <span className="text-xs text-slate-500 truncate">{pick.best_strategy}</span>
          <button
            onClick={() => setDrawerOpen(true)}
            className="shrink-0 flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg bg-brand-600/20 text-brand-400 border border-brand-500/30 hover:bg-brand-600/30 transition-colors"
          >
            <span>📌</span> Entry / Exit
          </button>
        </div>
      </div>

      {drawerOpen && <EntryExitDrawer pick={pick} mode={mode} onClose={() => setDrawerOpen(false)} />}
    </>
  )
}

// ─── Shared PicksTab (used by both Today & Tomorrow) ──────────────────────────

function PicksTab({
  mode,
}: {
  mode: 'today' | 'tomorrow'
}) {
  const [data, setData] = useState<TomorrowPick[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [fetchedAt, setFetchedAt] = useState<Date | null>(null)
  const [years, setYears] = useState(3)

  const isToday = mode === 'today'

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = isToday ? await getTodayPicks(years) : await getTomorrowPicks(years)
      setData(res.picks ?? [])
      setFetchedAt(new Date())
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to fetch picks')
    } finally {
      setLoading(false)
    }
  }, [years, isToday])

  const topPick = data && data.length > 0 ? data[0] : null

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <h2 className="text-base font-semibold text-white">
            {isToday ? "Today's Trades" : "Tomorrow's Best Trades"}
          </h2>
          {data && (
            <span className="text-xs text-slate-500">
              {data.length} scripts · sorted by trade probability
            </span>
          )}
        </div>
        <div className="flex items-center gap-3">
          <select
            value={years}
            onChange={e => { setYears(Number(e.target.value)); setData(null) }}
            className="bg-slate-800 border border-slate-700 text-white text-xs rounded-lg px-3 py-2 focus:outline-none"
          >
            <option value={1}>1 Year</option>
            <option value={3}>3 Years</option>
            <option value={5}>5 Years</option>
          </select>
          {fetchedAt && (
            <span className="text-xs text-slate-500">
              {fetchedAt.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}
            </span>
          )}
          <button
            onClick={load}
            disabled={loading}
            className={cls(
              'flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold transition-all',
              loading
                ? 'bg-slate-700 text-slate-500 cursor-not-allowed'
                : 'bg-brand-600 hover:bg-brand-500 text-white',
            )}
          >
            {loading ? (
              <>
                <span className="w-4 h-4 border-2 border-slate-400 border-t-transparent rounded-full animate-spin" />
                Analysing…
              </>
            ) : (
              <>
                <span>{isToday ? '⚡' : '📅'}</span>
                {data ? 'Refresh' : isToday ? "Get Today's Picks" : "Get Tomorrow's Picks"}
              </>
            )}
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded-xl bg-red-900/20 border border-red-500/30 p-4 text-red-300 text-sm">{error}</div>
      )}

      {/* Empty state */}
      {!data && !loading && (
        <div className="rounded-xl bg-slate-800/40 border border-slate-700/50 p-12 flex flex-col items-center gap-4 text-center">
          <span className="text-4xl">{isToday ? '⚡' : '📅'}</span>
          <p className="text-slate-400 text-sm max-w-md">
            Click <strong className="text-white">{isToday ? "Get Today's Picks" : "Get Tomorrow's Picks"}</strong> to run all 8 strategies across NIFTY and 11 stocks, then rank by trade probability.
          </p>
          <p className="text-slate-500 text-xs">Each card has an <strong className="text-slate-400">Entry / Exit</strong> button with exact price levels, target, stop-loss, and R:R ratio.</p>
        </div>
      )}

      {/* Top pick spotlight */}
      {topPick && (
        <div className={cls(
          'rounded-xl border p-5 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4',
          topPick.direction === 'BUY' ? 'bg-emerald-900/15 border-emerald-500/30'
            : topPick.direction === 'SELL' ? 'bg-red-900/15 border-red-500/30'
            : 'bg-slate-800/40 border-slate-700/50',
        )}>
          <div>
            <div className="text-xs text-slate-400 mb-1">
              {isToday ? '⚡ Top Pick for Today' : '📅 Top Pick for Tomorrow'}
            </div>
            <div className="text-xl font-bold text-white">{topPick.name}</div>
            <div className="text-sm text-slate-400 mt-0.5">{topPick.best_strategy}</div>
          </div>
          <div className="flex items-center gap-4 flex-wrap">
            <div className="text-center">
              <div className="text-2xl font-bold text-white tabular-nums">{topPick.trade_probability.toFixed(1)}%</div>
              <div className="text-xs text-slate-500">Probability</div>
            </div>
            <div className="text-center">
              <div className="text-2xl font-bold text-white tabular-nums">{topPick.win_rate.toFixed(1)}%</div>
              <div className="text-xs text-slate-500">Win Rate</div>
            </div>
            {topPick.entry_price > 0 && (
              <div className="text-center">
                <div className="text-2xl font-bold text-white tabular-nums">
                  1:{topPick.risk_reward.toFixed(1)}
                </div>
                <div className="text-xs text-slate-500">Risk:Reward</div>
              </div>
            )}
            <span className={cls('text-sm font-bold px-4 py-2 rounded-full', DIR_STYLE[topPick.direction] ?? DIR_STYLE.NEUTRAL)}>
              {topPick.direction === 'BUY' ? '▲ BUY' : topPick.direction === 'SELL' ? '▼ SELL' : '— NEUTRAL'}
            </span>
          </div>
        </div>
      )}

      {/* Grid of cards */}
      {data && data.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {data.map((pick, i) => (
            <PickCard key={pick.symbol} pick={pick} rank={i + 1} mode={mode} />
          ))}
        </div>
      )}
    </div>
  )
}

// ─── News Flags Tab ───────────────────────────────────────────────────────────

const IMPACT_COLOR: Record<string, string> = {
  HIGH:   'bg-red-500/20 text-red-300 border border-red-500/40',
  MEDIUM: 'bg-amber-500/20 text-amber-300 border border-amber-500/40',
  LOW:    'bg-slate-600/40 text-slate-400 border border-slate-600',
}

function NewsFlagCard({ item }: { item: NewsFlag }) {
  const isGreen = item.flag === 'GREEN'
  return (
    <div className={cls(
      'rounded-xl border p-4 flex flex-col gap-2',
      isGreen
        ? 'bg-emerald-900/20 border-emerald-500/30'
        : 'bg-red-900/20 border-red-500/30',
    )}>
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2 flex-wrap">
          <span className={cls(
            'text-xs font-bold px-2 py-0.5 rounded-full',
            isGreen ? 'bg-emerald-500/20 text-emerald-300' : 'bg-red-500/20 text-red-300',
          )}>
            {isGreen ? '▲ GREEN' : '▼ RED'}
          </span>
          <span className="text-xs text-slate-400 font-medium">{item.name}</span>
          <span className="text-xs text-slate-500">{item.sector}</span>
          {item.category === 'Sector' && (
            <span className="text-xs bg-blue-500/20 text-blue-300 border border-blue-500/30 px-1.5 py-0.5 rounded">Sector</span>
          )}
        </div>
        <span className={cls('text-xs px-2 py-0.5 rounded shrink-0', IMPACT_COLOR[item.impact] ?? IMPACT_COLOR.LOW)}>
          {item.impact}
        </span>
      </div>
      <p className="text-sm text-white font-medium leading-snug">
        {item.url ? (
          <a href={item.url} target="_blank" rel="noopener noreferrer" className="hover:underline">
            {item.headline}
          </a>
        ) : item.headline}
      </p>
      {item.summary && <p className="text-xs text-slate-400 leading-relaxed">{item.summary}</p>}
      <div className="flex items-center justify-between mt-1">
        {item.source && <span className="text-xs text-slate-500">{item.source}</span>}
        <span className="text-xs text-slate-600 ml-auto">
          {new Date(item.fetched_at).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}
        </span>
      </div>
    </div>
  )
}

function NewsTab() {
  const [data, setData] = useState<NewsFlagsResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [lastFetch, setLastFetch] = useState<Date | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const d = await getNewsFlags()
      setData(d)
      setLastFetch(new Date())
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load news')
    } finally {
      setLoading(false)
    }
  }, [])

  const green = data?.green_flags ?? []
  const red   = data?.red_flags ?? []
  const total = green.length + red.length

  return (
    <div className="space-y-6">
      {/* Header with fetch button */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-4">
          {data && (
            <>
              <div className="flex items-center gap-2">
                <span className="w-2.5 h-2.5 rounded-full bg-emerald-500" />
                <span className="text-sm text-emerald-400 font-semibold">{green.length} Green Flags</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="w-2.5 h-2.5 rounded-full bg-red-500" />
                <span className="text-sm text-red-400 font-semibold">{red.length} Red Flags</span>
              </div>
              {total === 0 && <span className="text-sm text-slate-500">No significant news found</span>}
            </>
          )}
          {!data && !loading && (
            <span className="text-sm text-slate-500">Click to fetch latest news for all 12 scripts</span>
          )}
        </div>
        <div className="flex items-center gap-3">
          {lastFetch && (
            <span className="text-xs text-slate-500">
              Fetched at {lastFetch.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}
            </span>
          )}
          <button
            onClick={load}
            disabled={loading}
            className={cls(
              'flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold transition-all',
              loading
                ? 'bg-slate-700 text-slate-500 cursor-not-allowed'
                : 'bg-brand-600 hover:bg-brand-500 text-white',
            )}
          >
            {loading ? (
              <>
                <span className="w-4 h-4 border-2 border-slate-400 border-t-transparent rounded-full animate-spin" />
                Fetching…
              </>
            ) : (
              <>
                <span>🗞️</span>
                {data ? 'Refresh News' : 'Fetch News'}
              </>
            )}
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded-xl bg-red-900/20 border border-red-500/30 p-4 text-red-300 text-sm">{error}</div>
      )}

      {!data && !loading && (
        <div className="rounded-xl bg-slate-800/40 border border-slate-700/50 p-12 flex flex-col items-center gap-4 text-center">
          <span className="text-4xl">🗞️</span>
          <p className="text-slate-400 text-sm">Press <strong className="text-white">Fetch News</strong> to pull the latest headlines for NIFTY, HDFC Bank, SBI, Infosys, Reliance and 8 more scripts.</p>
          <p className="text-slate-500 text-xs">News is classified as Green (bullish) or Red (bearish) using keyword sentiment analysis.</p>
        </div>
      )}

      {data && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Green flags */}
          <div>
            <h3 className="text-emerald-400 font-semibold text-sm mb-3 flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-emerald-500" />
              Positive / Bullish News
            </h3>
            {green.length === 0 ? (
              <div className="rounded-xl bg-slate-800/40 border border-slate-700/50 p-5 text-slate-500 text-sm text-center">
                No bullish signals found
              </div>
            ) : (
              <div className="space-y-3">
                {green.map((item, i) => <NewsFlagCard key={i} item={item} />)}
              </div>
            )}
          </div>

          {/* Red flags */}
          <div>
            <h3 className="text-red-400 font-semibold text-sm mb-3 flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-red-500" />
              Negative / Bearish News
            </h3>
            {red.length === 0 ? (
              <div className="rounded-xl bg-slate-800/40 border border-slate-700/50 p-5 text-slate-500 text-sm text-center">
                No bearish signals found
              </div>
            ) : (
              <div className="space-y-3">
                {red.map((item, i) => <NewsFlagCard key={i} item={item} />)}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Main Page ────────────────────────────────────────────────────────────────

type Tab = 'chart' | 'signals' | 'strategies' | 'strikes' | 'chain' | 'btst' | 'news' | 'today' | 'tomorrow'

export default function NiftyScalping() {
  const [dashboard, setDashboard] = useState<NiftyDashboard | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>('btst')
  const [years, setYears] = useState(3)

  const load = useCallback(async () => {
    try {
      const d = await getNiftyDashboard(undefined, years)
      setDashboard(d)
      setError(null)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load Nifty data')
    } finally {
      setLoading(false)
    }
  }, [years])

  useEffect(() => {
    setLoading(true)
    load()
    const t = setInterval(load, 60_000)
    return () => clearInterval(t)
  }, [load])

  const tabs: { id: Tab; label: string }[] = [
    { id: 'btst', label: '🌙 BTST' },
    { id: 'chart', label: '📈 Live Chart' },
    { id: 'signals', label: '⚡ Live Signals' },
    { id: 'strategies', label: '📊 Strategy Cards' },
    { id: 'strikes', label: '🎯 Strike Picks' },
    { id: 'chain', label: '📋 Option Chain' },
    { id: 'today', label: '⚡ Today' },
    { id: 'tomorrow', label: '📅 Tomorrow' },
    { id: 'news', label: '🗞️ News Flags' },
  ]

  if (loading) {
    return (
      <div className="max-w-screen-2xl mx-auto px-4 py-8 flex items-center justify-center h-96">
        <div className="flex flex-col items-center gap-3">
          <div className="w-8 h-8 border-2 border-brand-500 border-t-transparent rounded-full animate-spin" />
          <span className="text-slate-400 text-sm">Loading Nifty Terminal…</span>
        </div>
      </div>
    )
  }

  if (error || !dashboard) {
    return (
      <div className="max-w-screen-2xl mx-auto px-4 py-8">
        <div className="bg-rose-500/10 border border-rose-500/30 rounded-xl p-6 text-center">
          <div className="text-rose-400 text-lg font-semibold mb-1">Failed to load</div>
          <div className="text-slate-400 text-sm">{error}</div>
          <button
            onClick={load}
            className="mt-4 px-4 py-2 bg-brand-600 hover:bg-brand-500 text-white rounded-lg text-sm transition-colors"
          >
            Retry
          </button>
        </div>
      </div>
    )
  }

  const suggestions = dashboard.strike_suggestions?.suggestions ?? []
  const chain = dashboard.option_chain

  return (
    <div className="max-w-screen-2xl mx-auto px-4 py-6">
      {/* Page title */}
      <div className="flex items-center justify-between mb-5">
        <div>
          <h1 className="text-2xl font-bold text-white">Nifty Scalping Terminal</h1>
          <p className="text-sm text-slate-400 mt-0.5">
            NSE Option Chain • Live Signals • 8-Strategy Backtest • Strike Suggestions
          </p>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2 text-xs text-slate-400">
            <label htmlFor="years-select">Backtest years:</label>
            <select
              id="years-select"
              value={years}
              onChange={e => setYears(Number(e.target.value))}
              className="bg-slate-800 border border-slate-700 rounded px-2 py-1 text-white text-xs"
            >
              {[1, 2, 3, 4, 5].map(y => <option key={y} value={y}>{y}Y</option>)}
            </select>
          </div>
          <button
            onClick={load}
            className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-300 rounded-lg text-xs transition-colors"
          >
            ↻ Refresh
          </button>
        </div>
      </div>

      {/* Market header */}
      <MarketHeader d={dashboard} />

      {/* Support / Resistance quick view */}
      {chain && (
        <div className="flex flex-wrap gap-3 mb-5 text-xs">
          <div className="flex items-center gap-2">
            <span className="text-slate-500">Supports:</span>
            {(chain.support_levels ?? []).map(l => (
              <span key={l} className="px-2 py-0.5 bg-emerald-500/15 border border-emerald-500/30 text-emerald-400 rounded">
                {fmt(l, 0)}
              </span>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <span className="text-slate-500">Resistances:</span>
            {(chain.resistance_levels ?? []).map(l => (
              <span key={l} className="px-2 py-0.5 bg-rose-500/15 border border-rose-500/30 text-rose-400 rounded">
                {fmt(l, 0)}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Tab bar */}
      <div className="flex gap-1 mb-5 bg-dark-800 border border-slate-800/60 rounded-xl p-1">
        {tabs.map(t => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={cls(
              'flex-1 py-2 px-3 rounded-lg text-sm font-medium transition-colors',
              tab === t.id
                ? 'bg-brand-600/20 text-brand-400 border border-brand-600/30'
                : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/50',
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      {tab === 'btst' && (
        <div>
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="text-base font-semibold text-white">BTST — Buy Today Sell Tomorrow</h2>
              <p className="text-xs text-slate-400 mt-0.5">
                Live assessment of Nifty 50 for overnight BTST trade. Enter 15:00–15:25 IST, exit next day.
              </p>
            </div>
          </div>
          <BTSTPanel />
        </div>
      )}

      {tab === 'chart' && (
        <div>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-base font-semibold text-white">
              NIFTY Chart — Strategy Signals
              <span className="ml-2 text-xs text-slate-400 font-normal">
                Green ▲ = BUY signal · Red ▼ = SELL signal
              </span>
            </h2>
          </div>
          <NiftyChart />
        </div>
      )}

      {tab === 'signals' && <LiveSignalsTab />}

      {tab === 'strategies' && (
        <StrategiesTab dashboardCards={dashboard.strategies} years={years} />
      )}

      {tab === 'strikes' && (
        <div>
          <div className="mb-3">
            <h2 className="text-base font-semibold text-white">
              Strike Price Suggestions
            </h2>
            {dashboard.strike_suggestions && (
              <p className="text-xs text-slate-400 mt-0.5">
                Direction: <span className={DIRECTION_COLOR[dashboard.strike_suggestions.direction] ?? 'text-white'}>
                  {dashboard.strike_suggestions.direction}
                </span>
                {' '}• Spot: {fmt(dashboard.strike_suggestions.spot_price, 0)}
                {' '}• ATM: {fmt(dashboard.strike_suggestions.atm_strike, 0)}
                {' '}• PCR: {dashboard.strike_suggestions.pcr.toFixed(2)}
              </p>
            )}
          </div>
          {suggestions.length === 0 ? (
            <div className="flex items-center justify-center h-32 text-slate-500 text-sm">
              No strike suggestions available
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {suggestions.map((s: StrikeSuggestion, i: number) => (
                <StrikeSuggestionCard key={i} s={s} />
              ))}
            </div>
          )}

          <div className="mt-4 p-3 bg-amber-500/10 border border-amber-500/20 rounded-lg text-xs text-amber-300/80">
            ⚠ Strike suggestions are based on technical signals and option chain data. Options trading carries significant risk. Always use stop-losses and size positions appropriately.
          </div>
        </div>
      )}

      {tab === 'chain' && (
        <div>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-base font-semibold text-white">
              NSE Option Chain
              {chain?.selected_expiry && (
                <span className="ml-2 text-xs text-slate-400 font-normal">Expiry: {chain.selected_expiry}</span>
              )}
            </h2>
            {chain && (
              <div className="flex items-center gap-4 text-xs text-slate-400">
                <span>Total CE OI: <span className="text-emerald-400">{fmtInt(chain.total_ce_oi)}</span></span>
                <span>Total PE OI: <span className="text-rose-400">{fmtInt(chain.total_pe_oi)}</span></span>
                <span>IV Skew: <span className="text-white">{chain.iv_skew.toFixed(2)}</span></span>
              </div>
            )}
          </div>
          <div className="bg-dark-800 border border-slate-800/60 rounded-xl overflow-hidden">
            {chain ? (
              <OptionChainTable rows={chain.rows ?? []} atm={chain.atm_strike} />
            ) : (
              <div className="flex items-center justify-center h-24 text-slate-500 text-sm">
                Option chain data unavailable
              </div>
            )}
          </div>
          {chain?.timestamp && (
            <div className="mt-2 text-xs text-slate-500 text-right">
              NSE timestamp: {chain.timestamp}
            </div>
          )}
        </div>
      )}

      {tab === 'today' && <PicksTab mode="today" />}
      {tab === 'tomorrow' && <PicksTab mode="tomorrow" />}
      {tab === 'news' && <NewsTab />}
    </div>
  )
}
