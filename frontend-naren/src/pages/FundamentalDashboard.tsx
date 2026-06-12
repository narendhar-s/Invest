import { useState, useEffect, useRef } from 'react'
import axios from 'axios'
import LoadingSpinner from '../components/LoadingSpinner'

// ─── Types ────────────────────────────────────────────────────────────────────

interface SearchResult {
  id: number
  name: string
  url: string
  market_cap: string
  symbol: string
}

interface Pillar {
  name: string
  score: number
  max_score: number
  pct: number
  status: 'STRONG' | 'GOOD' | 'FAIR' | 'WEAK'
  details: string[]
}

interface BuffettScore {
  total: number
  grade: string
  verdict: string
  buy_signal: string
  pillars: Pillar[]
  roce: number
  roe: number
  debt_equity: number
  profit_margin: number
  revenue_cagr: number
  eps_growth: number
  peg: number
  free_cash_flow: number
  reasoning: string[]
}

interface QuarterResult { period: string; sales: number; expenses: number; net_profit: number; eps: number }
interface AnnualResult  { year: string; sales: number; net_profit: number; eps: number }

interface ScreenerData {
  symbol: string
  name: string
  current_price: number
  market_cap: number
  pe_ratio: number
  book_value: number
  price_to_book: number
  dividend_yield: number
  roce: number
  roe: number
  high_52w: number
  low_52w: number
  free_cash_flow: number
  quarterly_results: QuarterResult[]
  annual_results: AnnualResult[]
}

interface TechSummary {
  rsi: number
  macd: number
  macd_signal: string
  trend: string
  sma20: number
  sma50: number
  sma200: number
  above_sma200: boolean
  technical_score: number
  signal: string
}

interface PeerStock {
  symbol: string
  name: string
  pe_ratio: number
  roe: number
  market_cap_cr: number
  fundamental_score: number
}

interface Fundamentals {
  pe_ratio: number | null
  forward_pe: number | null
  eps: number | null
  eps_growth: number | null
  revenue_growth: number | null
  debt_equity: number | null
  roe: number | null
  roa: number | null
  market_cap: number | null
  dividend_yield: number | null
  price_to_book: number | null
  profit_margin: number | null
  fundamental_score: number
}

interface AnalysisData {
  symbol: string
  name: string
  market: string
  sector: string
  generated_at: string
  current_price: number
  market_cap_cr: number
  high_52w: number
  low_52w: number
  price_from_high_pct: number
  buffett_score: BuffettScore
  screener_data: ScreenerData | null
  fundamentals: Fundamentals | null
  technical: TechSummary | null
  peers: PeerStock[] | null
}

// ─── Pillar Ring ──────────────────────────────────────────────────────────────

function PillarRing({ pillar }: { pillar: Pillar }) {
  const r = 28
  const circ = 2 * Math.PI * r
  const dash = (pillar.pct / 100) * circ
  const color = pillar.status === 'STRONG' ? '#10b981' : pillar.status === 'GOOD' ? '#3b82f6' : pillar.status === 'FAIR' ? '#f59e0b' : '#ef4444'
  const bg = pillar.status === 'STRONG' ? 'bg-emerald-500/10 border-emerald-500/20' : pillar.status === 'GOOD' ? 'bg-blue-500/10 border-blue-500/20' : pillar.status === 'FAIR' ? 'bg-amber-500/10 border-amber-500/20' : 'bg-red-500/10 border-red-500/20'

  return (
    <div className={`rounded-xl border p-3 flex flex-col items-center gap-2 ${bg}`}>
      <div className="relative w-16 h-16">
        <svg className="w-16 h-16 -rotate-90" viewBox="0 0 72 72">
          <circle cx="36" cy="36" r={r} fill="none" stroke="#1e293b" strokeWidth="6" />
          <circle cx="36" cy="36" r={r} fill="none" stroke={color} strokeWidth="6"
            strokeDasharray={`${dash} ${circ}`} strokeLinecap="round"
            style={{ transition: 'stroke-dasharray 0.6s ease' }}
          />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-xs font-bold text-white leading-none">{pillar.score.toFixed(0)}</span>
          <span className="text-[9px] text-slate-500 leading-none">/{pillar.max_score}</span>
        </div>
      </div>
      <div className="text-center">
        <div className="text-xs font-semibold text-slate-200 leading-tight">{pillar.name}</div>
        <div className={`text-[10px] font-bold mt-0.5 ${
          pillar.status === 'STRONG' ? 'text-emerald-400' :
          pillar.status === 'GOOD' ? 'text-blue-400' :
          pillar.status === 'FAIR' ? 'text-amber-400' : 'text-red-400'
        }`}>{pillar.status}</div>
      </div>
      {pillar.details.length > 0 && (
        <div className="text-[10px] text-slate-500 text-center leading-tight">
          {pillar.details[0]}
        </div>
      )}
    </div>
  )
}

// ─── Metric Badge ──────────────────────────────────────────────────────────────

function MetricBadge({ label, value, good }: { label: string; value: string; good?: boolean | null }) {
  const color = good === true ? 'text-emerald-400' : good === false ? 'text-red-400' : 'text-slate-300'
  return (
    <div className="bg-slate-800/60 rounded-lg p-2.5">
      <div className="text-[10px] text-slate-500 mb-0.5">{label}</div>
      <div className={`text-sm font-bold ${color}`}>{value}</div>
    </div>
  )
}

// ─── Quarterly Table ───────────────────────────────────────────────────────────

function QuarterlyTable({ data }: { data: QuarterResult[] }) {
  if (!data || data.length === 0) return <EmptyState msg="No quarterly data available" />
  const fmt = (v: number) => v > 0 ? v.toLocaleString('en-IN', { maximumFractionDigits: 0 }) : '—'
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-slate-800">
            <th className="text-left py-2 px-3 text-slate-500 font-medium">Metric (₹ Cr)</th>
            {data.map(q => <th key={q.period} className="text-right py-2 px-3 text-slate-400 font-medium">{q.period}</th>)}
          </tr>
        </thead>
        <tbody>
          {[
            { key: 'sales', label: 'Revenue' },
            { key: 'expenses', label: 'Expenses' },
            { key: 'net_profit', label: 'Net Profit' },
            { key: 'eps', label: 'EPS (₹)' },
          ].map(row => (
            <tr key={row.key} className="border-b border-slate-800/40 hover:bg-slate-800/30">
              <td className="py-2 px-3 text-slate-400 font-medium">{row.label}</td>
              {data.map(q => {
                const v = q[row.key as keyof QuarterResult] as number
                const isProfit = row.key === 'net_profit' || row.key === 'eps'
                return (
                  <td key={q.period} className={`py-2 px-3 text-right font-mono ${isProfit ? (v > 0 ? 'text-emerald-400' : 'text-red-400') : 'text-slate-300'}`}>
                    {fmt(v)}
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ─── Annual Table ──────────────────────────────────────────────────────────────

function AnnualTable({ data }: { data: AnnualResult[] }) {
  if (!data || data.length === 0) return <EmptyState msg="No annual data available" />
  const fmt = (v: number) => v > 0 ? v.toLocaleString('en-IN', { maximumFractionDigits: 0 }) : '—'
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-slate-800">
            <th className="text-left py-2 px-3 text-slate-500 font-medium">Metric (₹ Cr)</th>
            {data.map(a => <th key={a.year} className="text-right py-2 px-3 text-slate-400 font-medium">{a.year}</th>)}
          </tr>
        </thead>
        <tbody>
          {[
            { key: 'sales', label: 'Revenue' },
            { key: 'net_profit', label: 'Net Profit' },
            { key: 'eps', label: 'EPS (₹)' },
          ].map(row => (
            <tr key={row.key} className="border-b border-slate-800/40 hover:bg-slate-800/30">
              <td className="py-2 px-3 text-slate-400 font-medium">{row.label}</td>
              {data.map((a, i) => {
                const v = a[row.key as keyof AnnualResult] as number
                const prev = i > 0 ? data[i-1][row.key as keyof AnnualResult] as number : 0
                const growing = i > 0 && prev > 0 && v > prev
                return (
                  <td key={a.year} className={`py-2 px-3 text-right font-mono ${growing ? 'text-emerald-400' : v < 0 ? 'text-red-400' : 'text-slate-300'}`}>
                    {fmt(v)}{growing && i > 0 && <span className="text-emerald-500 ml-0.5">↑</span>}
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ─── Technical Panel ──────────────────────────────────────────────────────────

function TechnicalPanel({ tech, price }: { tech: TechSummary | null; price: number }) {
  if (!tech) return <EmptyState msg="No technical data in database yet. Run the backend data pipeline first." />

  const rsiColor = tech.rsi > 70 ? 'text-red-400' : tech.rsi < 30 ? 'text-emerald-400' : 'text-amber-400'
  const trendColor = tech.trend === 'UP' ? 'text-emerald-400' : tech.trend === 'DOWN' ? 'text-red-400' : 'text-amber-400'
  const signalColor = tech.signal === 'BUY' ? 'bg-emerald-500/20 text-emerald-400 border-emerald-500/40' : tech.signal === 'SELL' ? 'bg-red-500/20 text-red-400 border-red-500/40' : 'bg-amber-500/20 text-amber-400 border-amber-500/40'

  return (
    <div className="space-y-4">
      {/* Signal Banner */}
      <div className={`border rounded-xl p-4 flex items-center justify-between ${signalColor}`}>
        <div>
          <div className="text-lg font-bold">{tech.signal}</div>
          <div className="text-xs opacity-70">Technical Signal</div>
        </div>
        <div className="text-right">
          <div className="text-xl font-bold">{tech.technical_score.toFixed(0)}/100</div>
          <div className="text-xs opacity-70">Tech Score</div>
        </div>
      </div>

      {/* Key TA metrics */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        <MetricBadge label="RSI" value={tech.rsi.toFixed(1)} good={tech.rsi > 40 && tech.rsi < 70 ? true : null} />
        <MetricBadge label="Trend" value={tech.trend} good={tech.trend === 'UP'} />
        <MetricBadge label="MACD" value={tech.macd_signal} good={tech.macd_signal === 'BULLISH'} />
        {tech.sma20 > 0 && <MetricBadge label="SMA 20" value={`₹${tech.sma20.toFixed(1)}`} good={price > 0 ? price > tech.sma20 : null} />}
        {tech.sma50 > 0 && <MetricBadge label="SMA 50" value={`₹${tech.sma50.toFixed(1)}`} good={price > 0 ? price > tech.sma50 : null} />}
        {tech.sma200 > 0 && <MetricBadge label="SMA 200" value={`₹${tech.sma200.toFixed(1)}`} good={tech.above_sma200} />}
      </div>

      {/* RSI gauge bar */}
      <div>
        <div className="flex justify-between text-xs text-slate-500 mb-1">
          <span>Oversold (30)</span>
          <span className={`font-bold ${rsiColor}`}>RSI {tech.rsi.toFixed(1)}</span>
          <span>Overbought (70)</span>
        </div>
        <div className="relative h-2 bg-slate-800 rounded-full">
          <div className="absolute inset-y-0 left-[30%] right-[30%] bg-emerald-500/20 rounded-full" />
          <div
            className="absolute top-0 h-full w-1 bg-white rounded-full transition-all"
            style={{ left: `${Math.min(Math.max(tech.rsi, 0), 100)}%` }}
          />
        </div>
      </div>

      <div className="text-xs text-slate-500 mt-2">
        {tech.above_sma200
          ? '✅ Price is above 200-day SMA — long-term uptrend intact'
          : '⚠️ Price is below 200-day SMA — long-term trend is down'}
      </div>
    </div>
  )
}

// ─── Peers Table ──────────────────────────────────────────────────────────────

function PeersTable({ peers, sector }: { peers: PeerStock[] | null; sector: string }) {
  if (!peers || peers.length === 0) return <EmptyState msg={`No sector peers found for ${sector}`} />
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-slate-800">
            {['Symbol', 'Name', 'P/E', 'ROE %', 'Mkt Cap (Cr)', 'Fund. Score'].map(h => (
              <th key={h} className="text-left py-2 px-3 text-slate-500 font-medium">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {peers.map(p => (
            <tr key={p.symbol} className="border-b border-slate-800/40 hover:bg-slate-800/30 cursor-pointer">
              <td className="py-2 px-3 font-mono font-bold text-brand-400">{p.symbol}</td>
              <td className="py-2 px-3 text-slate-300 max-w-[150px] truncate">{p.name}</td>
              <td className="py-2 px-3 text-slate-300">{p.pe_ratio > 0 ? p.pe_ratio.toFixed(1) : '—'}</td>
              <td className={`py-2 px-3 font-bold ${p.roe > 15 ? 'text-emerald-400' : p.roe > 8 ? 'text-amber-400' : 'text-red-400'}`}>
                {p.roe > 0 ? p.roe.toFixed(1) : '—'}
              </td>
              <td className="py-2 px-3 text-slate-300">{p.market_cap_cr > 0 ? p.market_cap_cr.toLocaleString('en-IN', { maximumFractionDigits: 0 }) : '—'}</td>
              <td className="py-2 px-3">
                <div className="flex items-center gap-1.5">
                  <div className="h-1.5 w-16 bg-slate-700 rounded-full overflow-hidden">
                    <div className="h-full bg-brand-500 rounded-full" style={{ width: `${p.fundamental_score}%` }} />
                  </div>
                  <span className="text-slate-400">{p.fundamental_score.toFixed(0)}</span>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ─── Warren Buffett Key Metrics Bar ───────────────────────────────────────────

function BuffettMetrics({ bs }: { bs: BuffettScore }) {
  const metrics = [
    { label: 'ROCE', value: bs.roce > 0 ? `${bs.roce.toFixed(1)}%` : '—', good: bs.roce >= 15 },
    { label: 'ROE', value: bs.roe > 0 ? `${bs.roe.toFixed(1)}%` : '—', good: bs.roe >= 15 },
    { label: 'D/E Ratio', value: bs.debt_equity > 0 ? bs.debt_equity.toFixed(2) : 'Debt Free', good: bs.debt_equity < 0.5 },
    { label: 'Profit Margin', value: bs.profit_margin > 0 ? `${bs.profit_margin.toFixed(1)}%` : '—', good: bs.profit_margin >= 10 },
    { label: 'Revenue CAGR', value: bs.revenue_cagr !== 0 ? `${bs.revenue_cagr.toFixed(1)}%` : '—', good: bs.revenue_cagr >= 10 },
    { label: 'EPS Growth', value: bs.eps_growth !== 0 ? `${bs.eps_growth.toFixed(1)}%` : '—', good: bs.eps_growth >= 10 },
    { label: 'PEG Ratio', value: bs.peg > 0 ? bs.peg.toFixed(2) : '—', good: bs.peg > 0 && bs.peg < 1.5 },
    { label: 'Free Cash Flow', value: bs.free_cash_flow > 0 ? `₹${bs.free_cash_flow.toLocaleString('en-IN', { maximumFractionDigits: 0 })} Cr` : bs.free_cash_flow < 0 ? 'Negative' : '—', good: bs.free_cash_flow > 0 },
  ]
  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
      {metrics.map(m => (
        <div key={m.label} className="bg-slate-800/50 rounded-lg p-2.5">
          <div className="text-[10px] text-slate-500">{m.label}</div>
          <div className={`text-sm font-bold mt-0.5 ${m.good === true ? 'text-emerald-400' : m.good === false ? 'text-red-400' : 'text-slate-300'}`}>
            {m.value}
          </div>
        </div>
      ))}
    </div>
  )
}

// ─── Search Bar ───────────────────────────────────────────────────────────────

function SearchBar({ onSelect }: { onSelect: (symbol: string, url?: string) => void }) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchResult[]>([])
  const [loading, setLoading] = useState(false)
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const timer = useRef<ReturnType<typeof setTimeout>>()

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const search = (q: string) => {
    if (q.length < 2) { setResults([]); setOpen(false); return }
    clearTimeout(timer.current)
    timer.current = setTimeout(async () => {
      setLoading(true)
      try {
        const { data } = await axios.get('/api/naren/v1/fundamental/search', { params: { q } })
        setResults(data.results ?? [])
        setOpen(true)
      } catch { setResults([]) }
      finally { setLoading(false) }
    }, 350)
  }

  return (
    <div ref={ref} className="relative w-full max-w-xl">
      <div className="flex items-center gap-2 bg-slate-800 border border-slate-700 rounded-xl px-4 py-3 focus-within:border-brand-500 transition-colors">
        <svg className="w-4 h-4 text-slate-500 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
        </svg>
        <input
          className="flex-1 bg-transparent text-white placeholder-slate-500 text-sm outline-none"
          placeholder="Search stock symbol or company name (e.g. RELIANCE, TCS, AAPL)..."
          value={query}
          onChange={e => { setQuery(e.target.value); search(e.target.value) }}
          onKeyDown={e => { if (e.key === 'Enter' && query.length > 0) { onSelect(query.toUpperCase()); setOpen(false) } }}
        />
        {loading && <div className="w-4 h-4 border-2 border-brand-500 border-t-transparent rounded-full animate-spin" />}
      </div>

      {open && results.length > 0 && (
        <div className="absolute top-full left-0 right-0 mt-1.5 bg-slate-900 border border-slate-700 rounded-xl shadow-2xl z-50 overflow-hidden">
          {results.slice(0, 8).map(r => (
            <button
              key={r.id ?? r.symbol}
              className="w-full flex items-center justify-between px-4 py-3 hover:bg-slate-800 transition-colors text-left"
              onClick={() => { setQuery(r.symbol || r.name); setOpen(false); onSelect(r.symbol || '', r.url) }}
            >
              <div>
                <div className="text-sm font-bold text-white">{r.symbol || 'NSE'}</div>
                <div className="text-xs text-slate-400">{r.name}</div>
              </div>
              {r.market_cap && <div className="text-xs text-slate-500">₹{r.market_cap} Cr</div>}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── Empty State ──────────────────────────────────────────────────────────────

function EmptyState({ msg }: { msg: string }) {
  return (
    <div className="py-8 text-center text-slate-500 text-sm">{msg}</div>
  )
}

// ─── Score Badge ──────────────────────────────────────────────────────────────

function ScoreBadge({ bs }: { bs: BuffettScore }) {
  const colorMap: Record<string, string> = {
    STRONG_BUY: 'bg-emerald-500/20 border-emerald-500/40 text-emerald-300',
    BUY: 'bg-blue-500/20 border-blue-500/40 text-blue-300',
    HOLD: 'bg-amber-500/20 border-amber-500/40 text-amber-300',
    AVOID: 'bg-red-500/20 border-red-500/40 text-red-300',
  }
  const cls = colorMap[bs.buy_signal] ?? 'bg-slate-700 border-slate-600 text-slate-300'

  // Color the big score ring
  const pct = bs.total
  const bigColor = pct >= 65 ? '#10b981' : pct >= 50 ? '#3b82f6' : pct >= 35 ? '#f59e0b' : '#ef4444'
  const r = 40
  const circ = 2 * Math.PI * r
  const dash = (pct / 100) * circ

  return (
    <div className="flex items-center gap-6">
      {/* Big ring */}
      <div className="relative w-24 h-24 flex-shrink-0">
        <svg className="w-24 h-24 -rotate-90" viewBox="0 0 96 96">
          <circle cx="48" cy="48" r={r} fill="none" stroke="#1e293b" strokeWidth="8" />
          <circle cx="48" cy="48" r={r} fill="none" stroke={bigColor} strokeWidth="8"
            strokeDasharray={`${dash} ${circ}`} strokeLinecap="round" />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-2xl font-black text-white">{pct.toFixed(0)}</span>
          <span className="text-[10px] text-slate-500">/100</span>
        </div>
      </div>
      <div>
        <div className="flex items-center gap-2 mb-1">
          <span className="text-2xl font-black text-white">Grade {bs.grade}</span>
          <span className={`text-xs font-bold px-2 py-0.5 rounded-lg border ${cls}`}>{bs.buy_signal.replace('_', ' ')}</span>
        </div>
        <div className="text-sm text-slate-300 mb-2">{bs.verdict}</div>
        <div className="text-xs text-slate-500">Warren Buffett Fundamental Score</div>
      </div>
    </div>
  )
}

// ─── Main Page ─────────────────────────────────────────────────────────────────

type Tab = 'quarterly' | 'annual' | 'technical' | 'peers'

export default function FundamentalDashboard() {
  const [selectedSymbol, setSelectedSymbol] = useState('')
  const [selectedURL, setSelectedURL] = useState('')
  const [analysis, setAnalysis] = useState<AnalysisData | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [tab, setTab] = useState<Tab>('quarterly')

  const analyze = async (symbol: string, screenerUrl?: string) => {
    if (!symbol) return
    setLoading(true)
    setError('')
    setAnalysis(null)

    try {
      const params: Record<string, string> = {}
      if (screenerUrl) params.screener_url = screenerUrl
      const { data } = await axios.get(
        `/api/naren/v1/fundamental/analyze/${encodeURIComponent(symbol)}`,
        { params },
      )
      setAnalysis(data)
      setTab('quarterly')
    } catch (e: any) {
      setError(e?.response?.data?.error ?? 'Failed to analyze. Try again.')
    } finally {
      setLoading(false)
    }
  }

  const handleSelect = (symbol: string, url?: string) => {
    setSelectedSymbol(symbol)
    setSelectedURL(url ?? '')
    analyze(symbol, url)
  }

  const sd = analysis?.screener_data
  const bs = analysis?.buffett_score

  // Popular stocks quick-select
  const QUICK = ['RELIANCE', 'TCS', 'HDFCBANK', 'INFY', 'WIPRO', 'ICICIBANK', 'BAJFINANCE', 'ITC']

  return (
    <div className="max-w-screen-xl mx-auto px-4 sm:px-6 py-8">

      {/* Page Header */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-white">Fundamental Analysis</h1>
        <p className="text-slate-500 text-sm mt-1">
          Warren Buffett style stock screening · Screener.in data · Technical confluence
        </p>
      </div>

      {/* Search */}
      <div className="mb-4">
        <SearchBar onSelect={handleSelect} />
      </div>

      {/* Quick-select chips */}
      <div className="flex flex-wrap gap-2 mb-8">
        {QUICK.map(sym => (
          <button
            key={sym}
            onClick={() => handleSelect(sym)}
            className={`text-xs px-3 py-1.5 rounded-lg border transition-all ${
              selectedSymbol === sym
                ? 'bg-brand-600 text-white border-brand-600'
                : 'bg-slate-800/60 text-slate-400 border-slate-700 hover:text-white hover:border-slate-500'
            }`}
          >
            {sym}
          </button>
        ))}
      </div>

      {/* Loading */}
      {loading && <LoadingSpinner size="lg" text="Fetching fundamentals from Screener.in..." />}

      {/* Error */}
      {error && !loading && (
        <div className="bg-red-500/10 border border-red-500/30 rounded-xl p-4 text-red-400 text-sm mb-6">{error}</div>
      )}

      {/* Empty state */}
      {!loading && !analysis && !error && (
        <div className="bg-slate-800/40 border border-slate-700/60 rounded-2xl p-12 text-center">
          <div className="text-4xl mb-3">📊</div>
          <div className="text-white font-semibold text-lg mb-1">Search a Stock to Begin</div>
          <div className="text-slate-500 text-sm max-w-sm mx-auto">
            Enter any NSE/BSE symbol or company name. We'll fetch live financials from Screener.in and score it using Warren Buffett's 6-pillar framework.
          </div>
        </div>
      )}

      {/* Analysis results */}
      {analysis && bs && !loading && (
        <div className="space-y-6">

          {/* ── Company Header ── */}
          <div className="bg-slate-800/40 border border-slate-700/60 rounded-2xl p-5">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <div className="flex items-center gap-3">
                  <h2 className="text-xl font-black text-white">{analysis.name || analysis.symbol}</h2>
                  <span className="text-xs bg-slate-700 text-slate-300 px-2 py-0.5 rounded-lg font-mono">{analysis.symbol}</span>
                  {analysis.market && <span className="text-xs bg-brand-600/20 text-brand-400 border border-brand-600/30 px-2 py-0.5 rounded-lg">{analysis.market}</span>}
                </div>
                {analysis.sector && <div className="text-sm text-slate-400 mt-1">{analysis.sector}</div>}
              </div>
              <div className="text-right">
                {analysis.current_price > 0 && (
                  <div className="text-2xl font-black text-white">₹{analysis.current_price.toLocaleString('en-IN')}</div>
                )}
                {analysis.market_cap_cr > 0 && (
                  <div className="text-xs text-slate-500">Mkt Cap ₹{analysis.market_cap_cr.toLocaleString('en-IN', { maximumFractionDigits: 0 })} Cr</div>
                )}
              </div>
            </div>

            {/* 52-week range */}
            {analysis.high_52w > 0 && analysis.low_52w > 0 && (
              <div className="mt-4">
                <div className="flex justify-between text-xs text-slate-500 mb-1">
                  <span>52W Low ₹{analysis.low_52w.toLocaleString('en-IN')}</span>
                  {analysis.price_from_high_pct > 0 && <span className="text-amber-400">{analysis.price_from_high_pct.toFixed(1)}% from 52W High</span>}
                  <span>52W High ₹{analysis.high_52w.toLocaleString('en-IN')}</span>
                </div>
                <div className="relative h-2 bg-slate-700 rounded-full">
                  <div
                    className="absolute top-0 h-full bg-brand-500 rounded-full"
                    style={{ width: `${Math.max(5, 100 - analysis.price_from_high_pct)}%` }}
                  />
                </div>
              </div>
            )}

            {/* Key ratios row */}
            {sd && (
              <div className="grid grid-cols-3 sm:grid-cols-6 gap-2 mt-4">
                {[
                  { label: 'P/E', value: sd.pe_ratio > 0 ? sd.pe_ratio.toFixed(1) : '—', good: sd.pe_ratio > 0 && sd.pe_ratio < 30 ? true : null },
                  { label: 'P/B', value: sd.price_to_book > 0 ? sd.price_to_book.toFixed(2) : '—', good: sd.price_to_book > 0 && sd.price_to_book < 3 ? true : null },
                  { label: 'ROCE', value: sd.roce > 0 ? `${sd.roce.toFixed(1)}%` : '—', good: sd.roce >= 15 },
                  { label: 'ROE', value: sd.roe > 0 ? `${sd.roe.toFixed(1)}%` : '—', good: sd.roe >= 15 },
                  { label: 'Div Yield', value: sd.dividend_yield > 0 ? `${sd.dividend_yield.toFixed(2)}%` : '—', good: sd.dividend_yield >= 1 ? true : null },
                  { label: 'Book Val', value: sd.book_value > 0 ? `₹${sd.book_value.toFixed(0)}` : '—', good: null },
                ].map(m => <MetricBadge key={m.label} {...m} />)}
              </div>
            )}
          </div>

          {/* ── Warren Buffett Scorecard ── */}
          <div className="bg-slate-800/40 border border-slate-700/60 rounded-2xl p-5">
            <div className="text-xs font-bold text-slate-500 uppercase tracking-widest mb-4">Warren Buffett Scorecard</div>

            <div className="mb-5">
              <ScoreBadge bs={bs} />
            </div>

            {/* 6 pillars */}
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 mb-5">
              {bs.pillars.map((p, i) => <PillarRing key={i} pillar={p} />)}
            </div>

            {/* Key metrics */}
            <BuffettMetrics bs={bs} />

            {/* Reasoning */}
            {bs.reasoning && bs.reasoning.length > 0 && (
              <div className="mt-4 space-y-1.5">
                <div className="text-xs font-bold text-slate-500 uppercase tracking-widest">Buffett Analysis</div>
                {bs.reasoning.map((r, i) => (
                  <div key={i} className="flex items-start gap-2 text-xs text-slate-400">
                    <span className="text-brand-400 mt-0.5 flex-shrink-0">▸</span>
                    <span>{r}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* ── Financial Data Tabs ── */}
          <div className="bg-slate-800/40 border border-slate-700/60 rounded-2xl overflow-hidden">
            {/* Tabs */}
            <div className="flex border-b border-slate-700">
              {([
                ['quarterly', '📅 Quarterly'],
                ['annual', '📆 Annual P&L'],
                ['technical', '📈 Technical'],
                ['peers', '🏢 Peers'],
              ] as [Tab, string][]).map(([t, label]) => (
                <button
                  key={t}
                  onClick={() => setTab(t)}
                  className={`px-4 py-3 text-xs font-medium transition-colors ${
                    tab === t
                      ? 'text-white border-b-2 border-brand-500 bg-slate-800/60'
                      : 'text-slate-400 hover:text-white'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>

            <div className="p-4">
              {tab === 'quarterly' && <QuarterlyTable data={sd?.quarterly_results ?? []} />}
              {tab === 'annual'    && <AnnualTable data={sd?.annual_results ?? []} />}
              {tab === 'technical' && <TechnicalPanel tech={analysis.technical} price={analysis.current_price} />}
              {tab === 'peers'     && <PeersTable peers={analysis.peers} sector={analysis.sector} />}
            </div>
          </div>

          {/* ── Disclaimer ── */}
          <div className="text-xs text-slate-600 text-center pb-4">
            Data sourced from Screener.in and Yahoo Finance. Not financial advice — always do your own research before investing.
            Generated {new Date(analysis.generated_at).toLocaleString('en-IN')}
          </div>
        </div>
      )}
    </div>
  )
}
