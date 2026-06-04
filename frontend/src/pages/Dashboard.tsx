import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { getDashboard, getBTSTSignals, addStock, type DashboardData, type BTSTSignal, type AddStockResult, type ZerodhaQuote } from '../api/client'
import StockCard from '../components/StockCard'
import LoadingSpinner from '../components/LoadingSpinner'

type MarketTab = 'india' | 'us'
type HorizonTab = 'intraday' | 'swing' | 'longterm' | 'btst'

// ── BTST Card ─────────────────────────────────────────────────────────────────

function BTSTCard({ s }: { s: BTSTSignal }) {
  const cc = '₹'
  const confColor = s.confidence >= 75 ? 'text-emerald-400' : s.confidence >= 60 ? 'text-amber-400' : 'text-slate-400'
  return (
    <div className="bg-dark-700 border border-slate-800/60 hover:border-slate-600 rounded-xl p-4 transition-colors">
      <div className="flex items-start justify-between mb-2">
        <div>
          <div className="font-bold text-white text-sm">{s.symbol}</div>
          <div className="text-xs text-slate-500 truncate max-w-[120px]">{s.name}</div>
          <div className="text-xs text-slate-600">{s.sector}</div>
        </div>
        <div className="text-right">
          <span className={`text-xs font-bold px-2 py-0.5 rounded bg-amber-500/15 border border-amber-500/30 ${confColor}`}>
            BTST
          </span>
          <div className={`text-sm font-bold mt-1 ${confColor}`}>{s.confidence.toFixed(0)}%</div>
          <div className="text-xs text-slate-500">conf.</div>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-1.5 mb-2">
        <div className="bg-dark-800/60 rounded p-1.5">
          <div className="text-xs text-slate-500">Entry</div>
          <div className="text-xs font-mono font-bold text-white">{cc}{s.entry_price.toLocaleString()}</div>
        </div>
        <div className="bg-emerald-500/10 rounded p-1.5">
          <div className="text-xs text-slate-500">Target</div>
          <div className="text-xs font-mono font-bold text-emerald-400">{cc}{s.target_price.toLocaleString()}</div>
        </div>
        <div className="bg-red-500/10 rounded p-1.5">
          <div className="text-xs text-slate-500">SL</div>
          <div className="text-xs font-mono font-bold text-red-400">{cc}{s.stop_loss.toLocaleString()}</div>
        </div>
      </div>

      <div className="flex items-center justify-between mb-2">
        <span className="text-xs text-slate-500">R:R</span>
        <span className={`text-xs font-bold ${s.risk_reward >= 2 ? 'text-emerald-400' : 'text-amber-400'}`}>{s.risk_reward.toFixed(1)}x</span>
        <span className="text-xs text-slate-500">Vol</span>
        <span className="text-xs font-bold text-blue-400">{s.volume_ratio.toFixed(1)}x avg</span>
        <span className="text-xs text-slate-500">RSI</span>
        <span className={`text-xs font-bold ${s.rsi >= 60 ? 'text-amber-400' : 'text-emerald-400'}`}>{s.rsi.toFixed(0)}</span>
      </div>

      {s.reasons && s.reasons.length > 0 && (
        <div className="text-xs text-slate-400 border-t border-slate-800/40 pt-2 leading-relaxed">
          {s.reasons[0]}
        </div>
      )}
    </div>
  )
}

// ── BTST Panel ────────────────────────────────────────────────────────────────

function BTSTPanel() {
  const [signals, setSignals] = useState<BTSTSignal[]>([])
  const [note, setNote] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    getBTSTSignals()
      .then(d => { setSignals(d.signals ?? []); setNote(d.note ?? '') })
      .catch(() => setSignals([]))
      .finally(() => setLoading(false))
  }, [])

  if (loading) return <LoadingSpinner size="sm" text="Scanning for BTST opportunities..." />

  return (
    <div>
      <div className="mb-4 bg-amber-500/10 border border-amber-500/30 rounded-xl p-3 text-xs text-amber-300">
        <span className="font-bold">🌙 BTST Strategy:</span> {note || 'Enter near today\'s close, exit next trading day between 10:00–15:00 IST. Always use stop-loss.'}
      </div>
      {signals.length === 0 ? (
        <div className="text-slate-500 text-sm py-12 text-center bg-dark-700 border border-slate-800/60 rounded-xl">
          No BTST opportunities today. Requires market data pipeline to complete.
          <div className="text-xs mt-2 text-slate-600">Signals generated after 15:00 IST on trading days.</div>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5 gap-4">
          {signals.map(s => <BTSTCard key={s.symbol} s={s} />)}
        </div>
      )}
    </div>
  )
}

// ── Custom-Stock Storage Key ──────────────────────────────────────────────────
const CUSTOM_STOCKS_KEY = 'stockwise_custom_stocks'

function loadCustomStocks(): AddStockResult[] {
  try {
    const raw = localStorage.getItem(CUSTOM_STOCKS_KEY)
    return raw ? JSON.parse(raw) : []
  } catch {
    return []
  }
}

function saveCustomStocks(items: AddStockResult[]) {
  try { localStorage.setItem(CUSTOM_STOCKS_KEY, JSON.stringify(items)) } catch {}
}

// ── AddStockPanel ────────────────────────────────────────────────────────────
function AddStockPanel({
  customStocks,
  onAdd,
  onRemove,
}: {
  customStocks: AddStockResult[]
  onAdd: (result: AddStockResult) => void
  onRemove: (symbol: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [symbol, setSymbol] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const navigate = useNavigate()

  const handleAdd = async () => {
    const sym = symbol.trim().toUpperCase()
    if (!sym) return
    // Prevent duplicates
    if (customStocks.some(c => c.stock.symbol === sym)) {
      setError(`${sym} is already added.`)
      return
    }
    setLoading(true)
    setError(null)
    setSuccess(null)
    try {
      const result = await addStock(sym)
      onAdd(result)
      setSuccess(`✓ ${result.stock.name || sym} added with analysis!`)
      setSymbol('')
      setTimeout(() => setSuccess(null), 3000)
    } catch (e: any) {
      const msg = e?.response?.data?.details || e?.response?.data?.error || e?.message || 'Failed to fetch stock'
      setError(msg)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="mb-6 bg-dark-700 border border-slate-800/60 rounded-xl overflow-hidden">
      {/* Header row — always visible */}
      <button
        onClick={() => { setOpen(o => !o); setTimeout(() => inputRef.current?.focus(), 100) }}
        className="w-full flex items-center justify-between px-5 py-3 hover:bg-dark-600/50 transition-colors"
      >
        <div className="flex items-center gap-2 text-sm font-medium text-slate-300">
          <span className="text-brand-400 text-lg">＋</span>
          Add Any Stock for Analysis
          {customStocks.length > 0 && (
            <span className="ml-2 bg-brand-600/30 text-brand-400 text-xs px-2 py-0.5 rounded-full border border-brand-600/40">
              {customStocks.length} added
            </span>
          )}
        </div>
        <span className={`text-slate-500 transition-transform duration-200 ${open ? 'rotate-180' : ''}`}>▾</span>
      </button>

      {/* Collapsible body */}
      {open && (
        <div className="px-5 pb-5 border-t border-slate-800/40">
          <p className="text-xs text-slate-500 mt-3 mb-3">
            Enter any Yahoo Finance symbol — e.g. <code className="bg-dark-800 px-1 rounded text-brand-400">TSLA</code>, <code className="bg-dark-800 px-1 rounded text-brand-400">HDFCBANK.NS</code>, <code className="bg-dark-800 px-1 rounded text-brand-400">NVDA</code>
          </p>

          {/* Input row */}
          <div className="flex gap-2 mb-3">
            <input
              ref={inputRef}
              type="text"
              value={symbol}
              onChange={e => { setSymbol(e.target.value.toUpperCase()); setError(null) }}
              onKeyDown={e => e.key === 'Enter' && !loading && handleAdd()}
              placeholder="e.g. TSLA or WIPRO.NS"
              className="flex-1 bg-dark-800 border border-slate-700 focus:border-brand-500 rounded-lg px-4 py-2 text-sm text-white placeholder-slate-600 outline-none transition-colors font-mono"
              disabled={loading}
            />
            <button
              onClick={handleAdd}
              disabled={loading || !symbol.trim()}
              className="px-5 py-2 rounded-lg text-sm font-semibold bg-brand-600 hover:bg-brand-500 disabled:opacity-50 disabled:cursor-not-allowed text-white transition-colors flex items-center gap-2"
            >
              {loading ? <><span className="animate-spin">⟳</span> Analysing…</> : 'Analyse'}
            </button>
          </div>

          {/* Error / success feedback */}
          {error   && <div className="text-xs text-red-400 mb-3 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">{error}</div>}
          {success && <div className="text-xs text-emerald-400 mb-3 bg-emerald-500/10 border border-emerald-500/20 rounded-lg px-3 py-2">{success}</div>}

          {/* Already-added chips */}
          {customStocks.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {customStocks.map(c => (
                <div
                  key={c.stock.symbol}
                  className="flex items-center gap-1.5 bg-dark-800 border border-slate-700 rounded-lg px-3 py-1 text-xs"
                >
                  <button
                    onClick={() => navigate(`/stock/${c.stock.symbol}`)}
                    className="text-brand-400 hover:text-brand-300 font-mono font-semibold"
                  >
                    {c.stock.symbol}
                  </button>
                  <span className="text-slate-600 truncate max-w-[80px]">{c.stock.name}</span>
                  <button
                    onClick={() => onRemove(c.stock.symbol)}
                    className="text-slate-600 hover:text-red-400 transition-colors ml-1"
                    title="Remove"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ── CustomStockCard ──────────────────────────────────────────────────────────
// Shows the best-confidence recommendation for a custom stock with all metrics.
function CustomStockCard({ result }: { result: AddStockResult }) {
  const navigate = useNavigate()
  const recs = result.recommendations
  // Pick the highest-confidence recommendation
  const bestRec = Object.values(recs).reduce<any>((best, r: any) =>
    !best || (r && r.confidence > best.confidence) ? r : best, null)

  if (!bestRec) {
    return (
      <div className="bg-dark-700 border border-slate-800/60 rounded-xl p-4 flex items-center justify-center text-xs text-slate-500">
        No recommendations yet — check back after data refreshes.
      </div>
    )
  }

  const horizonBadges: Record<string, string> = {
    intraday: '⚡',
    swing:    '🔄',
    longterm: '🏦',
  }

  return (
    <div
      className="relative cursor-pointer"
      onClick={() => navigate(`/stock/${result.stock.symbol}`)}
    >
      {/* Custom badge */}
      <div className="absolute -top-2 -right-2 z-10 bg-brand-600 text-white text-[10px] font-bold px-2 py-0.5 rounded-full shadow">
        Custom
      </div>

      {/* All horizon chips */}
      <div className="absolute top-2 left-3 flex gap-1 z-10">
        {Object.keys(recs).map(h => (
          <span key={h} className="text-[10px] bg-dark-800/80 border border-slate-700 px-1.5 py-0.5 rounded text-slate-400">
            {horizonBadges[h] ?? h} {h}
          </span>
        ))}
      </div>

      <StockCard rec={{ ...bestRec, stock: result.stock }} />
    </div>
  )
}

export default function Dashboard() {
  const navigate = useNavigate()
  const [data, setData] = useState<DashboardData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [market, setMarket] = useState<MarketTab>('india')
  const [horizon, setHorizon] = useState<HorizonTab>('swing')
  const [customStocks, setCustomStocks] = useState<AddStockResult[]>(loadCustomStocks)

  useEffect(() => {
    getDashboard()
      .then(setData)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))
  }, [])

  const handleAddCustomStock = (result: AddStockResult) => {
    setCustomStocks(prev => {
      const updated = [...prev.filter(c => c.stock.symbol !== result.stock.symbol), result]
      saveCustomStocks(updated)
      return updated
    })
  }

  const handleRemoveCustomStock = (symbol: string) => {
    setCustomStocks(prev => {
      const updated = prev.filter(c => c.stock.symbol !== symbol)
      saveCustomStocks(updated)
      return updated
    })
  }

  if (loading) return <LoadingSpinner size="lg" text="Loading market data..." />
  if (error) return (
    <div className="max-w-screen-2xl mx-auto px-6 py-12 text-center">
      <div className="text-red-400 text-lg mb-2">Failed to load dashboard</div>
      <div className="text-slate-500 text-sm">{error}</div>
      <div className="text-slate-600 text-xs mt-2">Ensure the backend is running: <code className="font-mono bg-dark-700 px-1 rounded">./bin/stockwise</code></div>
    </div>
  )
  if (!data) return null

  // Pick the correct list based on market + horizon
  const recMap: Record<MarketTab, Record<HorizonTab, any[]>> = {
    india: {
      intraday: data.nse_intraday ?? [],
      swing:    data.nse_swing    ?? [],
      longterm: data.nse_longterm ?? [],
      btst:     [],
    },
    us: {
      intraday: [],
      swing:    data.us_swing    ?? [],
      longterm: data.us_longterm ?? [],
      btst:     [],
    },
  }
  const recs = recMap[market][horizon]

  const totalBuySignals =
    [...(data.nse_intraday ?? []), ...(data.nse_swing ?? []), ...(data.nse_longterm ?? []),
     ...(data.us_swing ?? []), ...(data.us_longterm ?? [])]
      .filter(r => r.rec_type === 'buy' || r.rec_type === 'strong_buy').length

  return (
    <div className="max-w-screen-2xl mx-auto px-4 sm:px-6 py-8">
      {/* Header */}
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-white">Market Dashboard</h1>
        <p className="text-slate-500 text-sm mt-1">
          Updated {data.generated_at ? new Date(data.generated_at).toLocaleString() : '—'}
          {' · '}{data.active_trades} active trades
        </p>
      </div>

      {/* Quick nav to Backtest */}
      <div className="mb-4">
        <button onClick={() => navigate('/backtest')}
          className="text-xs bg-dark-700 border border-slate-700 hover:border-brand-500 text-slate-400 hover:text-brand-400 px-4 py-2 rounded-xl transition-all flex items-center gap-2">
          📊 View Scalping Backtest Dashboard (5-year win rates)
          <span className="text-slate-600">→</span>
        </button>
      </div>

      {/* ── Add Stock Panel ──────────────────────────────────────────────── */}
      <AddStockPanel
        customStocks={customStocks}
        onAdd={handleAddCustomStock}
        onRemove={handleRemoveCustomStock}
      />

      {/* Summary Tiles */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-8">
        {[
          { label: 'Buy Signals',      value: totalBuySignals,                                icon: '⚡', color: 'text-emerald-400' },
          { label: 'NSE Intraday',     value: (data.nse_intraday ?? []).length,               icon: '🇮🇳', color: 'text-amber-400' },
          { label: 'NSE Swing/LT',     value: (data.nse_swing ?? []).length + (data.nse_longterm ?? []).length, icon: '📈', color: 'text-blue-400' },
          { label: 'US Picks',         value: (data.us_swing ?? []).length + (data.us_longterm ?? []).length,   icon: '🇺🇸', color: 'text-purple-400' },
        ].map((t) => (
          <div key={t.label} className="bg-dark-700 border border-slate-800/60 rounded-xl p-4">
            <div className="text-2xl mb-1">{t.icon}</div>
            <div className={`text-3xl font-bold ${t.color}`}>{t.value}</div>
            <div className="text-xs text-slate-500 mt-0.5">{t.label}</div>
          </div>
        ))}
      </div>

      {/* Market Tabs */}
      <div className="flex gap-2 mb-4">
        {(['india', 'us'] as MarketTab[]).map((m) => (
          <button
            key={m}
            onClick={() => { setMarket(m); if (m === 'us' && horizon === 'intraday') setHorizon('swing') }}
            className={`px-5 py-2 rounded-xl text-sm font-medium transition-all ${
              market === m
                ? 'bg-brand-600 text-white'
                : 'bg-dark-700 text-slate-400 border border-slate-800/60 hover:text-slate-200'
            }`}
          >
            {m === 'india' ? '🇮🇳 India (NSE)' : '🇺🇸 US Market'}
          </button>
        ))}
      </div>

      {/* Horizon Tabs */}
      <div className="flex gap-1 bg-dark-800 rounded-xl p-1 w-fit mb-6">
        {(market === 'india'
          ? [['intraday','⚡ Intraday'], ['swing','🔄 Swing'], ['longterm','🏦 Long-term'], ['btst','🌙 BTST']]
          : [['swing','🔄 Swing'], ['longterm','🏦 Long-term']]
        ).map(([h, label]) => (
          <button
            key={h}
            onClick={() => setHorizon(h as HorizonTab)}
            className={`px-5 py-2 rounded-lg text-sm font-medium transition-all ${
              horizon === h
                ? 'bg-brand-600 text-white shadow'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Horizon description */}
      <div className="mb-5 text-xs text-slate-500">
        {horizon === 'intraday' && 'Same-day scalping and momentum trades on NSE stocks.'}
        {horizon === 'swing'    && '1–4 week swing trades based on technical momentum and S/R levels.'}
        {horizon === 'longterm' && '3–12 month investment picks with strong fundamental + technical confluence.'}
        {horizon === 'btst'     && 'Buy Today Sell Tomorrow — enter near close, exit next trading day. EOD momentum + volume signals.'}
      </div>

      {/* BTST Panel */}
      {horizon === 'btst' && market === 'india' && <BTSTPanel />}

      {/* Recommendations Grid (all non-BTST horizons) */}
      {horizon !== 'btst' && (
        recs.length === 0 ? (
          <div className="text-slate-500 text-sm py-12 text-center bg-dark-700 border border-slate-800/60 rounded-xl">
            No {horizon} recommendations for {market === 'india' ? 'Indian' : 'US'} market yet.
            <div className="text-xs mt-2 text-slate-600">Data pipeline runs in the background — check back in a few minutes.</div>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5 gap-4">
            {recs.map((rec: any) => <StockCard key={rec.id} rec={rec} />)}
          </div>
        )
      )}

      {/* ── Custom Added Stocks ──────────────────────────────────────────── */}
      {customStocks.length > 0 && (
        <div className="mt-10">
          <div className="flex items-center gap-3 mb-4">
            <h2 className="text-base font-semibold text-white">My Custom Stocks</h2>
            <span className="text-xs text-slate-500 bg-dark-700 border border-slate-800/60 px-2 py-0.5 rounded-full">
              {customStocks.length} stock{customStocks.length !== 1 ? 's' : ''} · full analysis
            </span>
            <span className="text-xs text-slate-600">Click any card to view full detail →</span>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5 gap-4">
            {customStocks.map(result => (
              <CustomStockCard key={result.stock.symbol} result={result} />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
