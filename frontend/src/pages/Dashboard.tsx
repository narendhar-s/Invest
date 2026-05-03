import { useEffect, useState } from 'react'
import { getDashboard, type DashboardData } from '../api/client'
import StockCard from '../components/StockCard'
import LoadingSpinner from '../components/LoadingSpinner'

type MarketTab = 'india' | 'us'
type HorizonTab = 'intraday' | 'swing' | 'longterm'

export default function Dashboard() {
  const [data, setData] = useState<DashboardData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [market, setMarket] = useState<MarketTab>('india')
  const [horizon, setHorizon] = useState<HorizonTab>('swing')

  useEffect(() => {
    getDashboard()
      .then(setData)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))
  }, [])

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
    },
    us: {
      intraday: [],
      swing:    data.us_swing    ?? [],
      longterm: data.us_longterm ?? [],
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
          ? [['intraday','⚡ Intraday'], ['swing','🔄 Swing'], ['longterm','🏦 Long-term']]
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
      </div>

      {/* Recommendations Grid */}
      {recs.length === 0 ? (
        <div className="text-slate-500 text-sm py-12 text-center bg-dark-700 border border-slate-800/60 rounded-xl">
          No {horizon} recommendations for {market === 'india' ? 'Indian' : 'US'} market yet.
          <div className="text-xs mt-2 text-slate-600">Data pipeline runs in the background — check back in a few minutes.</div>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5 gap-4">
          {recs.map((rec: any) => <StockCard key={rec.id} rec={rec} />)}
        </div>
      )}
    </div>
  )
}
