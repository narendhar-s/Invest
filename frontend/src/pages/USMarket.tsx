import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { getRecommendations, getIndexSignals, type IndexSignalType } from '../api/client'
import type { Recommendation } from '../types'
import LoadingSpinner from '../components/LoadingSpinner'

type MainTab = 'index' | 'stocks'
type StockHorizonTab = 'longterm' | 'swing'

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmt(n: number | null | undefined, dec = 2, prefix = '') {
  if (n == null || n === 0) return '—'
  return prefix + n.toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec })
}

function rsiColor(rsi: number) {
  return rsi < 35 ? 'text-emerald-400' : rsi > 65 ? 'text-red-400' : 'text-amber-400'
}

// ── Direction Badge ───────────────────────────────────────────────────────────

function DirectionBadge({ dir }: { dir: string }) {
  const cfg = dir === 'LONG'
    ? 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30'
    : dir === 'SHORT'
    ? 'bg-red-500/20 text-red-400 border-red-500/30'
    : 'bg-slate-500/20 text-slate-400 border-slate-500/30'
  return <span className={`text-xs font-bold px-2.5 py-0.5 rounded-full border ${cfg}`}>{dir}</span>
}

// ── US Index Card (S&P 500, NASDAQ) ──────────────────────────────────────────

function USIndexCard({ sig }: { sig: IndexSignalType }) {
  const navigate = useNavigate()
  const borderColor = sig.direction === 'LONG'
    ? 'border-emerald-500/40 bg-emerald-500/5'
    : sig.direction === 'SHORT'
    ? 'border-red-500/40 bg-red-500/5'
    : 'border-slate-700/60'

  return (
    <div
      className={`border rounded-xl p-5 cursor-pointer hover:border-brand-600/40 transition-colors ${borderColor}`}
      onClick={() => navigate(`/stock/${encodeURIComponent(sig.symbol)}`)}
    >
      <div className="flex items-start justify-between mb-4">
        <div>
          <div className="font-bold text-white text-lg">{sig.name}</div>
          <div className="text-xs text-slate-500 font-mono">{sig.symbol}</div>
        </div>
        <DirectionBadge dir={sig.direction} />
      </div>

      <div className="text-2xl font-bold font-mono text-white mb-1">${fmt(sig.close)}</div>
      <div className="text-xs text-slate-500 mb-4">{sig.strategy}</div>

      <div className="grid grid-cols-3 gap-2 mb-4">
        {[
          { label: 'RSI', value: sig.rsi.toFixed(1), color: rsiColor(sig.rsi) },
          { label: 'MACD', value: sig.macd_hist.toFixed(2), color: sig.macd_hist > 0 ? 'text-emerald-400' : 'text-red-400' },
          { label: 'Trend', value: sig.trend || '—', color: sig.trend === 'UP' ? 'text-emerald-400' : sig.trend === 'DOWN' ? 'text-red-400' : 'text-amber-400' },
          { label: 'SMA20', value: fmt(sig.sma20, 0), color: 'text-amber-400' },
          { label: 'SMA50', value: fmt(sig.sma50, 0), color: 'text-blue-400' },
          { label: 'VWAP',  value: fmt(sig.vwap, 0),  color: 'text-purple-400' },
        ].map((item) => (
          <div key={item.label} className="bg-dark-800/60 rounded-lg p-2 text-center">
            <div className="text-xs text-slate-500 mb-0.5">{item.label}</div>
            <div className={`text-sm font-mono font-bold ${item.color}`}>{item.value}</div>
          </div>
        ))}
      </div>

      <div className="text-xs text-slate-400 bg-dark-800/60 rounded-lg p-3 leading-relaxed">
        {sig.signal}
      </div>

      <div className="mt-3 flex items-center justify-between">
        <span className="text-xs text-slate-600">Confidence</span>
        <div className="flex items-center gap-2">
          <div className="w-20 bg-dark-800 rounded-full h-1.5">
            <div
              className={`h-1.5 rounded-full ${sig.confidence >= 70 ? 'bg-emerald-500' : sig.confidence >= 55 ? 'bg-amber-500' : 'bg-slate-500'}`}
              style={{ width: `${sig.confidence}%` }}
            />
          </div>
          <span className="text-xs text-slate-400">{sig.confidence}%</span>
        </div>
      </div>
    </div>
  )
}

// ── Rec Badge ─────────────────────────────────────────────────────────────────

function RecBadge({ type }: { type: string }) {
  const map: Record<string, string> = {
    strong_buy: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/40',
    buy: 'bg-green-500/20 text-green-400 border-green-500/30',
    hold: 'bg-amber-500/20 text-amber-400 border-amber-500/30',
    sell: 'bg-red-500/20 text-red-400 border-red-500/30',
  }
  const labels: Record<string, string> = {
    strong_buy: 'STRONG BUY', buy: 'BUY', hold: 'HOLD', sell: 'SELL',
  }
  return (
    <span className={`text-xs font-bold px-2 py-0.5 rounded border ${map[type] ?? 'bg-slate-700 text-slate-400 border-slate-600'}`}>
      {labels[type] ?? type.toUpperCase()}
    </span>
  )
}

// ── Stock Rec Card ────────────────────────────────────────────────────────────

function StockRecCard({ rec, currency = '$' }: { rec: Recommendation; currency?: string }) {
  const navigate = useNavigate()
  const sym = rec.stock?.symbol ?? ''
  const name = rec.stock?.name ?? sym

  return (
    <div
      className="bg-dark-700 border border-slate-800/60 rounded-xl p-4 cursor-pointer hover:border-brand-600/40 transition-colors"
      onClick={() => navigate(`/stock/${encodeURIComponent(sym)}`)}
    >
      <div className="flex items-start justify-between mb-2">
        <div>
          <div className="font-bold text-white text-sm">{sym}</div>
          <div className="text-xs text-slate-500 truncate max-w-[120px]">{name}</div>
        </div>
        <RecBadge type={rec.rec_type} />
      </div>

      <div className="text-lg font-bold font-mono text-white mb-3">{currency}{fmt(rec.entry_price)}</div>

      <div className="grid grid-cols-2 gap-2 mb-3">
        <div className="bg-dark-800/60 rounded p-2">
          <div className="text-xs text-slate-500">Target</div>
          <div className="text-xs font-mono text-emerald-400">{currency}{fmt(rec.target_price)}</div>
        </div>
        <div className="bg-dark-800/60 rounded p-2">
          <div className="text-xs text-slate-500">Stop Loss</div>
          <div className="text-xs font-mono text-red-400">{currency}{fmt(rec.stop_loss)}</div>
        </div>
      </div>

      <div className="flex items-center justify-between text-xs text-slate-500">
        <span>Conf: <span className="text-white font-bold">{rec.confidence}%</span></span>
        <span>RR: <span className="text-amber-400">{rec.risk_reward.toFixed(2)}x</span></span>
        <span className={`font-medium ${rec.risk_level === 'low' ? 'text-emerald-400' : rec.risk_level === 'high' ? 'text-red-400' : 'text-amber-400'}`}>
          {rec.risk_level.toUpperCase()}
        </span>
      </div>

      <div className="mt-2 text-xs text-slate-500 leading-relaxed line-clamp-2">
        {rec.technical_factors}
      </div>
    </div>
  )
}

// ── Gold Section ──────────────────────────────────────────────────────────────

function GoldSection({ recs }: { recs: Recommendation[] }) {
  const goldRecs = recs.filter(r => r.stock?.symbol === 'GLD')
  if (goldRecs.length === 0) return null

  return (
    <div className="mb-6">
      <div className="flex items-center gap-2 mb-3">
        <span className="text-xl">🥇</span>
        <h3 className="font-semibold text-white">Gold (GLD)</h3>
        <span className="text-xs text-slate-500">SPDR Gold Shares ETF</span>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {goldRecs.map(r => <StockRecCard key={r.id} rec={r} />)}
      </div>
    </div>
  )
}

// ── Sector Block ──────────────────────────────────────────────────────────────

function SectorBlock({ sector, recs }: { sector: string; recs: Recommendation[] }) {
  const [open, setOpen] = useState(false)
  const buyCount = recs.filter(r => r.rec_type === 'buy' || r.rec_type === 'strong_buy').length
  const avgConf = recs.reduce((s, r) => s + r.confidence, 0) / recs.length

  return (
    <div className="border border-slate-800/60 rounded-xl overflow-hidden mb-4">
      <button
        className="w-full flex items-center justify-between p-4 bg-dark-700 hover:bg-dark-600/60 transition-colors"
        onClick={() => setOpen(p => !p)}
      >
        <div className="flex items-center gap-3">
          <span className="text-white font-semibold">{sector}</span>
          <span className="text-xs bg-brand-600/20 text-brand-400 border border-brand-600/30 px-2 py-0.5 rounded-full">
            {recs.length} stocks
          </span>
          {buyCount > 0 && (
            <span className="text-xs bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 px-2 py-0.5 rounded-full">
              {buyCount} buy signals
            </span>
          )}
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs text-slate-500">Avg conf: <span className="text-white">{avgConf.toFixed(0)}%</span></span>
          <span className="text-slate-400 text-sm">{open ? '▲' : '▼'}</span>
        </div>
      </button>
      {open && (
        <div className="p-4 bg-dark-800/30 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
          {recs.map(rec => <StockRecCard key={rec.id} rec={rec} />)}
        </div>
      )}
    </div>
  )
}

// ── Stocks Tab ────────────────────────────────────────────────────────────────

function StocksTab({ recs }: { recs: Record<StockHorizonTab, Recommendation[]> }) {
  const [stockTab, setStockTab] = useState<StockHorizonTab>('longterm')

  const currentRecs = recs[stockTab] ?? []
  const nonGold = currentRecs.filter(r => r.stock?.symbol !== 'GLD')
  const goldRecs = currentRecs.filter(r => r.stock?.symbol === 'GLD')

  const bySector: Record<string, Recommendation[]> = {}
  for (const rec of nonGold) {
    const sector = rec.stock?.sector ?? 'Other'
    if (!bySector[sector]) bySector[sector] = []
    bySector[sector].push(rec)
  }
  const sectors = Object.keys(bySector).sort()

  const horizonLabels: Record<StockHorizonTab, string> = {
    longterm: '🏦 Long Term',
    swing: '🔄 Short Term',
  }

  return (
    <div>
      <div className="flex gap-1 bg-dark-800 rounded-xl p-1 w-fit mb-6">
        {(['longterm', 'swing'] as StockHorizonTab[]).map(h => (
          <button
            key={h}
            onClick={() => setStockTab(h)}
            className={`px-5 py-2 rounded-lg text-sm font-medium transition-all ${
              stockTab === h
                ? 'bg-brand-600 text-white shadow'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            {horizonLabels[h]}
          </button>
        ))}
      </div>

      <div className="text-xs text-slate-500 mb-5">
        {stockTab === 'longterm' && '3–12 month investment picks with strong fundamental + technical confluence.'}
        {stockTab === 'swing' && '1–4 week short-term swing trades based on technical momentum.'}
      </div>

      {goldRecs.length > 0 && <GoldSection recs={goldRecs} />}

      {sectors.length === 0 ? (
        <div className="text-slate-500 text-sm py-12 text-center bg-dark-700 border border-slate-800/60 rounded-xl">
          No recommendations yet — pipeline is processing data.
        </div>
      ) : (
        <div>
          {sectors.map(sector => (
            <SectorBlock key={sector} sector={sector} recs={bySector[sector]} />
          ))}
        </div>
      )}
    </div>
  )
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function USMarket() {
  const [tab, setTab] = useState<MainTab>('index')
  const [indexSignals, setIndexSignals] = useState<IndexSignalType[]>([])
  const [swingRecs, setSwingRecs] = useState<Recommendation[]>([])
  const [longtermRecs, setLongtermRecs] = useState<Recommendation[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    Promise.all([
      getIndexSignals('US'),
      getRecommendations('US', 'swing', 50),
      getRecommendations('US', 'longterm', 50),
    ])
      .then(([idx, swing, lt]) => {
        setIndexSignals(idx.signals ?? [])
        setSwingRecs(swing.recommendations ?? [])
        setLongtermRecs(lt.recommendations ?? [])
      })
      .catch(console.error)
      .finally(() => setLoading(false))
  }, [])

  if (loading) return <LoadingSpinner size="lg" text="Loading US market data..." />

  const recs: Record<StockHorizonTab, Recommendation[]> = {
    swing: swingRecs,
    longterm: longtermRecs,
  }

  const totalBuySignals =
    [...swingRecs, ...longtermRecs].filter(r => r.rec_type === 'buy' || r.rec_type === 'strong_buy').length

  return (
    <div className="max-w-screen-2xl mx-auto px-4 sm:px-6 py-8">
      {/* Header */}
      <div className="flex items-center gap-4 mb-8">
        <span className="text-3xl">🇺🇸</span>
        <div>
          <h1 className="text-2xl font-bold text-white">US Market</h1>
          <p className="text-slate-500 text-sm">S&P 500 · NASDAQ · Long-term Investment Focus · Gold</p>
        </div>
      </div>

      {/* Summary */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-8">
        {[
          { label: 'Index Signals',  value: indexSignals.length,   icon: '📊', color: 'text-brand-400' },
          { label: 'Total Buy Signals', value: totalBuySignals,    icon: '⚡', color: 'text-emerald-400' },
          { label: 'Swing Picks',    value: swingRecs.filter(r => r.rec_type === 'buy' || r.rec_type === 'strong_buy').length, icon: '🔄', color: 'text-blue-400' },
          { label: 'Long-term Picks',value: longtermRecs.filter(r => r.rec_type === 'buy' || r.rec_type === 'strong_buy').length, icon: '🏦', color: 'text-purple-400' },
        ].map(t => (
          <div key={t.label} className="bg-dark-700 border border-slate-800/60 rounded-xl p-4">
            <div className="text-2xl mb-1">{t.icon}</div>
            <div className={`text-3xl font-bold ${t.color}`}>{t.value}</div>
            <div className="text-xs text-slate-500 mt-0.5">{t.label}</div>
          </div>
        ))}
      </div>

      {/* Main Tabs */}
      <div className="flex gap-2 mb-6">
        {([['index', '📊 Index Signals'], ['stocks', '📈 Stocks by Sector']] as [MainTab, string][]).map(([t, label]) => (
          <button
            key={t}
            onClick={() => setTab(t as MainTab)}
            className={`px-5 py-2 rounded-xl text-sm font-medium transition-all ${
              tab === t
                ? 'bg-brand-600 text-white'
                : 'bg-dark-700 text-slate-400 border border-slate-800/60 hover:text-slate-200'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Index Tab */}
      {tab === 'index' && (
        <div>
          <p className="text-xs text-slate-500 mb-5">
            Live signals for S&P 500 and NASDAQ based on RSI, MACD, trend and volume analysis.
          </p>
          {indexSignals.length === 0 ? (
            <div className="text-slate-500 text-sm py-12 text-center bg-dark-700 border border-slate-800/60 rounded-xl">
              No index signals yet — pipeline is processing data.
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
              {indexSignals.map(sig => <USIndexCard key={sig.symbol} sig={sig} />)}
            </div>
          )}
        </div>
      )}

      {/* Stocks Tab */}
      {tab === 'stocks' && <StocksTab recs={recs} />}
    </div>
  )
}
