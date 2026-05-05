import { useEffect, useState } from 'react'
import { getLongTermUSPicks, type LongTermUSPick, type LongTermUSReport } from '../api/client'

// ─── Sector colour palette ────────────────────────────────────────────────────

const SECTOR_STYLE: Record<string, { bg: string; text: string; border: string; dot: string }> = {
  AI_TECH:      { bg: 'bg-blue-500/15',    text: 'text-blue-400',    border: 'border-blue-500/40',    dot: 'bg-blue-400' },
  HEALTHCARE:   { bg: 'bg-emerald-500/15', text: 'text-emerald-400', border: 'border-emerald-500/40', dot: 'bg-emerald-400' },
  CLEAN_ENERGY: { bg: 'bg-green-500/15',   text: 'text-green-400',   border: 'border-green-500/40',   dot: 'bg-green-400' },
  FINTECH:      { bg: 'bg-violet-500/15',  text: 'text-violet-400',  border: 'border-violet-500/40',  dot: 'bg-violet-400' },
  CONSUMER:     { bg: 'bg-amber-500/15',   text: 'text-amber-400',   border: 'border-amber-500/40',   dot: 'bg-amber-400' },
  ENERGY:       { bg: 'bg-orange-500/15',  text: 'text-orange-400',  border: 'border-orange-500/40',  dot: 'bg-orange-400' },
  COMMODITY:    { bg: 'bg-yellow-500/15',  text: 'text-yellow-400',  border: 'border-yellow-500/40',  dot: 'bg-yellow-400' },
}
const sectorStyle = (gs: string) => SECTOR_STYLE[gs] ?? SECTOR_STYLE['CONSUMER']

// ─── Score helpers ────────────────────────────────────────────────────────────

const scoreColor = (s: number) =>
  s >= 78 ? 'text-emerald-400' : s >= 63 ? 'text-blue-400' : s >= 48 ? 'text-amber-400' : 'text-red-400'

const scoreBg = (s: number) =>
  s >= 78 ? 'bg-emerald-400' : s >= 63 ? 'bg-blue-400' : s >= 48 ? 'bg-amber-400' : 'bg-red-400'

const ratingLabel = (r: string) => ({
  EXCELLENT:   { label: 'Excellent SIP', cls: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40' },
  GOOD:        { label: 'Good SIP',      cls: 'bg-blue-500/20 text-blue-300 border-blue-500/40' },
  FAIR:        { label: 'Fair SIP',      cls: 'bg-amber-500/20 text-amber-300 border-amber-500/40' },
  SPECULATIVE: { label: 'Speculative',   cls: 'bg-red-500/20 text-red-300 border-red-500/40' },
}[r] ?? { label: r, cls: 'bg-slate-700 text-slate-300 border-slate-600' })

const riskStyle = (r: string) => ({
  CONSERVATIVE: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
  MODERATE:     'bg-blue-500/15 text-blue-300 border-blue-500/30',
  AGGRESSIVE:   'bg-orange-500/15 text-orange-300 border-orange-500/30',
}[r] ?? 'bg-slate-700 text-slate-300 border-slate-600')

const valZoneStyle = (z: string) => ({
  UNDERVALUED:  { cls: 'text-emerald-400', icon: '↓' },
  FAIR:         { cls: 'text-blue-400',    icon: '=' },
  SLIGHTLY_HIGH:{ cls: 'text-amber-400',  icon: '↑' },
  OVERVALUED:   { cls: 'text-red-400',    icon: '↑↑' },
}[z] ?? { cls: 'text-slate-400', icon: '?' })

const entryStyle = (e: string) => ({
  GOOD: 'text-emerald-400',
  FAIR: 'text-blue-400',
  WAIT: 'text-orange-400',
}[e] ?? 'text-slate-400')

const maTrendIcon = (t: string) => ({
  BULLISH: { icon: '▲', cls: 'text-emerald-400' },
  BEARISH: { icon: '▼', cls: 'text-red-400' },
  NEUTRAL: { icon: '─', cls: 'text-slate-400' },
}[t] ?? { icon: '─', cls: 'text-slate-400' })

const fmt = (n: number, dec = 1) =>
  n === 0 ? '—' : n.toFixed(dec)

const fmtPct = (n: number) => n === 0 ? '—' : `${n > 0 ? '+' : ''}${n.toFixed(1)}%`

// ─── Sub-components ───────────────────────────────────────────────────────────

function SectorBadge({ gs, label }: { gs: string; label: string }) {
  const s = sectorStyle(gs)
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border ${s.bg} ${s.text} ${s.border}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${s.dot}`} />
      {label}
    </span>
  )
}

function ScoreRing({ score }: { score: number }) {
  const pct = Math.min(score, 100)
  const r = 22
  const circ = 2 * Math.PI * r
  const dash = (pct / 100) * circ
  const col = score >= 78 ? '#34d399' : score >= 63 ? '#60a5fa' : score >= 48 ? '#fbbf24' : '#f87171'
  return (
    <div className="relative w-14 h-14 flex-shrink-0">
      <svg className="w-full h-full -rotate-90" viewBox="0 0 56 56">
        <circle cx="28" cy="28" r={r} fill="none" stroke="#1e293b" strokeWidth="4" />
        <circle cx="28" cy="28" r={r} fill="none" stroke={col} strokeWidth="4"
          strokeDasharray={`${dash} ${circ - dash}`} strokeLinecap="round" />
      </svg>
      <div className={`absolute inset-0 flex items-center justify-center text-sm font-bold ${scoreColor(score)}`}>
        {score.toFixed(0)}
      </div>
    </div>
  )
}

function RSIBar({ rsi }: { rsi: number }) {
  const pct = Math.min(Math.max(rsi, 0), 100)
  const col = rsi < 35 ? 'bg-emerald-400' : rsi > 70 ? 'bg-orange-400' : 'bg-blue-400'
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-xs text-slate-500 w-6">RSI</span>
      <div className="relative flex-1 h-1.5 bg-slate-700 rounded-full">
        <div className={`absolute h-full rounded-full ${col}`} style={{ width: `${pct}%` }} />
        <div className="absolute h-3 w-0.5 bg-slate-400 top-[-3px]" style={{ left: '30%' }} />
        <div className="absolute h-3 w-0.5 bg-slate-400 top-[-3px]" style={{ left: '70%' }} />
      </div>
      <span className="text-xs font-mono text-slate-300 w-8 text-right">{rsi.toFixed(0)}</span>
    </div>
  )
}

function PickCard({ pick, budget }: { pick: LongTermUSPick; budget: number }) {
  const [expanded, setExpanded] = useState(false)
  const ss = sectorStyle(pick.growth_sector)
  const rt = ratingLabel(pick.sip_rating)
  const vz = valZoneStyle(pick.valuation_zone)
  const ma = maTrendIcon(pick.ma_trend)
  const allocDollar = budget > 0 ? (pick.monthly_sip_pct / 100) * budget : 0

  return (
    <div className={`bg-dark-800 rounded-xl border ${ss.border} flex flex-col overflow-hidden transition-shadow hover:shadow-lg hover:shadow-black/30`}>
      {/* Header */}
      <div className={`px-4 py-3 ${ss.bg} border-b ${ss.border} flex items-start justify-between gap-2`}>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-xl font-bold text-white">{pick.symbol}</span>
            <span className={`px-1.5 py-0.5 rounded text-xs border ${rt.cls}`}>{rt.label}</span>
          </div>
          <p className="text-xs text-slate-400 truncate mt-0.5">{pick.name}</p>
        </div>
        <div className="flex flex-col items-end gap-1 flex-shrink-0">
          <SectorBadge gs={pick.growth_sector} label={pick.growth_sector_label} />
          <span className={`text-xs px-1.5 py-0.5 rounded border ${riskStyle(pick.risk_profile)}`}>
            {pick.risk_profile}
          </span>
        </div>
      </div>

      <div className="p-4 flex flex-col gap-3 flex-1">
        {/* Score + Price row */}
        <div className="flex items-center gap-3">
          <ScoreRing score={pick.overall_sip_score} />
          <div className="flex-1 min-w-0">
            <div className="text-xs text-slate-500 mb-0.5">Current → 3-Year Target</div>
            <div className="flex items-baseline gap-1 flex-wrap">
              <span className="text-base font-bold text-white">${fmt(pick.current_price, 2)}</span>
              <span className="text-slate-500 text-xs">→</span>
              <span className="text-sm font-semibold text-emerald-400">
                ${fmt(pick.target_3yr_low, 0)}–${fmt(pick.target_3yr_high, 0)}
              </span>
            </div>
            <div className="text-xs text-slate-400 mt-0.5">
              Exp. CAGR&nbsp;
              <span className={`font-semibold ${scoreColor(pick.expected_cagr_pct * 2)}`}>
                ~{pick.expected_cagr_pct.toFixed(1)}%/yr
              </span>
            </div>
          </div>
        </div>

        {/* Score breakdown mini-bar */}
        <div className="grid grid-cols-4 gap-1 text-center text-xs">
          {[
            { label: 'Growth', val: pick.growth_score, max: 25 },
            { label: 'Fundmt', val: pick.fund_score,  max: 35 },
            { label: 'Value',  val: pick.valuation_score, max: 25 },
            { label: 'Tech',   val: pick.tech_score,  max: 10 },
          ].map(({ label, val, max }) => (
            <div key={label} className="bg-slate-800/60 rounded p-1">
              <div className="text-slate-500 mb-0.5">{label}</div>
              <div className={`font-bold ${scoreColor((val / max) * 100)}`}>{val.toFixed(0)}</div>
              <div className="text-slate-600">/{max}</div>
            </div>
          ))}
        </div>

        {/* Fundamentals grid */}
        <div className="grid grid-cols-3 gap-x-3 gap-y-1 text-xs">
          {[
            { label: 'P/E',         val: pick.pe_ratio > 0 ? `${fmt(pick.pe_ratio, 1)}x` : '—' },
            { label: 'EPS Gr.',     val: fmtPct(pick.eps_growth_pct) },
            { label: 'ROE',         val: pick.roe_pct !== 0 ? `${fmt(pick.roe_pct, 1)}%` : '—' },
            { label: 'D/E',         val: pick.debt_equity !== 0 ? fmt(pick.debt_equity, 2) : '—' },
            { label: 'Net Margin',  val: pick.profit_margin_pct !== 0 ? `${fmt(pick.profit_margin_pct, 1)}%` : '—' },
            { label: 'Div Yield',   val: pick.dividend_yield_pct > 0 ? `${fmt(pick.dividend_yield_pct, 1)}%` : '—' },
          ].map(({ label, val }) => (
            <div key={label} className="flex justify-between">
              <span className="text-slate-500">{label}</span>
              <span className="text-slate-200 font-mono">{val}</span>
            </div>
          ))}
        </div>

        <div className="border-t border-slate-800" />

        {/* Technicals row */}
        <RSIBar rsi={pick.rsi} />
        <div className="flex items-center justify-between text-xs gap-2">
          <div className="flex items-center gap-1">
            <span className={`font-semibold ${ma.cls}`}>{ma.icon}</span>
            <span className="text-slate-400">{pick.ma_trend} MA</span>
          </div>
          <div className="flex items-center gap-1">
            {pick.above_sma200
              ? <span className="text-emerald-400">✓ Above SMA200</span>
              : <span className="text-red-400">✗ Below SMA200</span>}
          </div>
          <div className="flex items-center gap-1">
            <span className="text-slate-500">Val:</span>
            <span className={`font-medium ${vz.cls}`}>{vz.icon} {pick.valuation_zone.replace('_', ' ')}</span>
          </div>
        </div>
        <div className="text-xs flex items-center gap-1.5">
          <span className="text-slate-500">Entry signal:</span>
          <span className={`font-semibold ${entryStyle(pick.tech_entry)}`}>{pick.tech_entry}</span>
          <span className="text-slate-600 mx-1">|</span>
          <span className="text-slate-500 text-xs truncate" title={pick.best_buy_zone}>{pick.best_buy_zone}</span>
        </div>

        <div className="border-t border-slate-800" />

        {/* Monthly SIP allocation */}
        <div className="flex items-center justify-between">
          <div>
            <div className="text-xs text-slate-500">Monthly SIP allocation</div>
            <div className="flex items-baseline gap-1 mt-0.5">
              <span className={`text-lg font-bold ${scoreColor(pick.overall_sip_score)}`}>
                {pick.monthly_sip_pct.toFixed(1)}%
              </span>
              {allocDollar > 0 && (
                <span className="text-xs text-slate-400">(${allocDollar.toFixed(0)}/mo)</span>
              )}
            </div>
          </div>
          <div className="flex-1 mx-3 h-2 bg-slate-800 rounded-full overflow-hidden">
            <div
              className={`h-full rounded-full ${scoreBg(pick.overall_sip_score)}`}
              style={{ width: `${Math.min(pick.monthly_sip_pct * 5.5, 100)}%` }}
            />
          </div>
        </div>

        {/* Expandable thesis */}
        <button
          onClick={() => setExpanded(e => !e)}
          className="w-full text-left text-xs text-slate-400 hover:text-slate-200 flex items-center gap-1 transition-colors"
        >
          <span>{expanded ? '▲' : '▼'}</span>
          <span>{expanded ? 'Hide' : 'Show'} Investment Thesis ({pick.thesis.length} points)</span>
        </button>

        {expanded && (
          <div className="space-y-3">
            <div>
              <div className="text-xs font-semibold text-emerald-400 mb-1.5 flex items-center gap-1">
                <span>✓</span> Why Buy (SIP Thesis)
              </div>
              <ul className="space-y-1">
                {pick.thesis.map((t, i) => (
                  <li key={i} className="text-xs text-slate-300 flex gap-1.5">
                    <span className="text-emerald-500 flex-shrink-0 mt-0.5">•</span>
                    <span>{t}</span>
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <div className="text-xs font-semibold text-orange-400 mb-1.5 flex items-center gap-1">
                <span>⚠</span> Key Risks
              </div>
              <ul className="space-y-1">
                {pick.risks.map((r, i) => (
                  <li key={i} className="text-xs text-slate-400 flex gap-1.5">
                    <span className="text-orange-500 flex-shrink-0 mt-0.5">•</span>
                    <span>{r}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Main Page ────────────────────────────────────────────────────────────────

const ALL_SECTORS = ['ALL', 'AI_TECH', 'HEALTHCARE', 'CLEAN_ENERGY', 'FINTECH', 'CONSUMER', 'ENERGY', 'COMMODITY']
const SECTOR_LABELS: Record<string, string> = {
  ALL: 'All Sectors',
  AI_TECH: 'AI & Tech',
  HEALTHCARE: 'Healthcare',
  CLEAN_ENERGY: 'Clean Energy',
  FINTECH: 'FinTech',
  CONSUMER: 'Consumer',
  ENERGY: 'Energy',
  COMMODITY: 'Commodity',
}
const ALL_RISKS = ['ALL', 'CONSERVATIVE', 'MODERATE', 'AGGRESSIVE']

export default function LongTermSIP() {
  const [report, setReport] = useState<LongTermUSReport | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [sector, setSector] = useState('ALL')
  const [risk, setRisk] = useState('ALL')
  const [budget, setBudget] = useState(500)
  const [showMethod, setShowMethod] = useState(false)

  useEffect(() => {
    getLongTermUSPicks()
      .then(setReport)
      .catch(e => setError(e.message))
      .finally(() => setLoading(false))
  }, [])

  const filtered = (report?.picks ?? []).filter(p => {
    if (sector !== 'ALL' && p.growth_sector !== sector) return false
    if (risk !== 'ALL' && p.risk_profile !== risk) return false
    return true
  })

  const topPick = report?.picks[0]

  return (
    <div className="min-h-screen bg-dark-900 text-slate-200 pb-16">
      <div className="max-w-screen-2xl mx-auto px-4 py-8 space-y-8">

        {/* ── Page Header ──────────────────────────────────────────────────── */}
        <div className="flex flex-col gap-2">
          <div className="flex items-start justify-between flex-wrap gap-4">
            <div>
              <h1 className="text-2xl font-bold text-white flex items-center gap-2">
                🇺🇸 US Long-Term SIP Strategy
                <span className="text-sm font-normal text-slate-400 ml-1">3-Year Plan</span>
              </h1>
              <p className="text-slate-400 text-sm mt-1 max-w-2xl">
                Multi-factor analysis of US stocks for monthly SIP investing over 3 years. Scored on growth sector
                tailwinds, fundamental quality, valuation attractiveness, and technical entry timing.
              </p>
            </div>
            <button
              onClick={() => setShowMethod(v => !v)}
              className="text-xs text-brand-400 hover:text-brand-300 border border-brand-600/30 px-3 py-1.5 rounded-lg"
            >
              {showMethod ? 'Hide' : 'View'} Methodology
            </button>
          </div>

          {showMethod && report && (
            <div className="bg-slate-800/60 border border-slate-700/60 rounded-lg p-4 text-sm text-slate-400 max-w-3xl">
              <span className="text-slate-300 font-medium">Scoring: </span>
              {report.sip_methodology}
            </div>
          )}
        </div>

        {loading && (
          <div className="flex justify-center py-20">
            <div className="animate-spin rounded-full h-10 w-10 border-2 border-brand-600 border-t-transparent" />
          </div>
        )}

        {error && (
          <div className="bg-red-500/10 border border-red-500/30 rounded-xl p-4 text-red-400 text-sm">
            Failed to load SIP analysis: {error}
          </div>
        )}

        {!loading && !error && report && (
          <>
            {/* ── Summary Stats ─────────────────────────────────────────────── */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
              {[
                { label: 'Stocks Analysed',   val: report.total_picks.toString(),                  sub: 'US growth stocks' },
                { label: 'Avg Expected CAGR',  val: `${report.avg_expected_cagr_pct.toFixed(1)}%`, sub: '3-year projection' },
                { label: 'Growth Sectors',     val: report.sector_summary.length.toString(),        sub: 'covered' },
                { label: 'Top Pick',           val: topPick?.symbol ?? '—',                         sub: topPick ? `SIP score ${topPick.overall_sip_score.toFixed(0)}` : '' },
              ].map(({ label, val, sub }) => (
                <div key={label} className="bg-dark-800 border border-slate-700/60 rounded-xl p-4">
                  <div className="text-xs text-slate-500 mb-1">{label}</div>
                  <div className="text-2xl font-bold text-white">{val}</div>
                  <div className="text-xs text-slate-500 mt-0.5">{sub}</div>
                </div>
              ))}
            </div>

            {/* ── Sector allocation bar ─────────────────────────────────────── */}
            <div className="bg-dark-800 border border-slate-700/60 rounded-xl p-4">
              <div className="text-sm font-semibold text-slate-300 mb-3">Portfolio Sector Allocation</div>
              <div className="flex gap-1 h-3 rounded-full overflow-hidden">
                {report.sector_summary.map(s => {
                  const ss = sectorStyle(s.growth_sector)
                  return (
                    <div
                      key={s.growth_sector}
                      title={`${s.label}: ${s.alloc_pct.toFixed(1)}%`}
                      className={`${ss.dot} opacity-80 hover:opacity-100 transition-opacity`}
                      style={{ width: `${s.alloc_pct}%` }}
                    />
                  )
                })}
              </div>
              <div className="flex flex-wrap gap-3 mt-3">
                {report.sector_summary.map(s => {
                  const ss = sectorStyle(s.growth_sector)
                  return (
                    <div key={s.growth_sector} className="flex items-center gap-1.5 text-xs">
                      <span className={`w-2 h-2 rounded-full ${ss.dot}`} />
                      <span className="text-slate-400">{s.label}</span>
                      <span className={`font-semibold ${ss.text}`}>{s.alloc_pct.toFixed(1)}%</span>
                      <span className="text-slate-600">avg {s.avg_cagr_pct.toFixed(0)}% CAGR</span>
                    </div>
                  )
                })}
              </div>
            </div>

            {/* ── SIP Calculator + Filters ──────────────────────────────────── */}
            <div className="flex flex-wrap gap-4 items-start">
              {/* Budget input */}
              <div className="bg-dark-800 border border-slate-700/60 rounded-xl px-4 py-3 flex items-center gap-3">
                <div>
                  <div className="text-xs text-slate-500">Monthly SIP Budget</div>
                  <div className="flex items-center gap-1 mt-1">
                    <span className="text-slate-400 text-sm">$</span>
                    <input
                      type="number"
                      value={budget}
                      onChange={e => setBudget(Math.max(0, Number(e.target.value)))}
                      className="w-24 bg-slate-800 border border-slate-700 rounded px-2 py-1 text-sm text-white font-mono focus:outline-none focus:border-brand-500"
                    />
                    <span className="text-xs text-slate-500">/month</span>
                  </div>
                </div>
              </div>

              {/* Sector filter */}
              <div className="flex flex-wrap gap-1">
                {ALL_SECTORS.map(s => {
                  const ss = s !== 'ALL' ? sectorStyle(s) : null
                  const active = sector === s
                  return (
                    <button
                      key={s}
                      onClick={() => setSector(s)}
                      className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors border ${
                        active
                          ? ss ? `${ss.bg} ${ss.text} ${ss.border}` : 'bg-brand-600/20 text-brand-400 border-brand-600/40'
                          : 'text-slate-400 border-slate-700/60 hover:border-slate-600 hover:text-slate-200'
                      }`}
                    >
                      {SECTOR_LABELS[s]}
                    </button>
                  )
                })}
              </div>

              {/* Risk filter */}
              <div className="flex gap-1">
                {ALL_RISKS.map(r => {
                  const active = risk === r
                  const cls = r === 'CONSERVATIVE' ? 'text-emerald-400 border-emerald-500/40 bg-emerald-500/15'
                    : r === 'MODERATE' ? 'text-blue-400 border-blue-500/40 bg-blue-500/15'
                    : r === 'AGGRESSIVE' ? 'text-orange-400 border-orange-500/40 bg-orange-500/15'
                    : 'text-brand-400 border-brand-600/40 bg-brand-600/20'
                  return (
                    <button
                      key={r}
                      onClick={() => setRisk(r)}
                      className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors border ${
                        active ? cls : 'text-slate-400 border-slate-700/60 hover:border-slate-600'
                      }`}
                    >
                      {r === 'ALL' ? 'All Risk' : r[0] + r.slice(1).toLowerCase()}
                    </button>
                  )
                })}
              </div>
            </div>

            {/* ── Picks Grid ────────────────────────────────────────────────── */}
            {filtered.length === 0 ? (
              <div className="text-center py-12 text-slate-500">
                No stocks match the selected filters.
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-5">
                {filtered.map(pick => (
                  <PickCard key={pick.symbol} pick={pick} budget={budget} />
                ))}
              </div>
            )}

            {/* ── Sector Detail Table ───────────────────────────────────────── */}
            <div className="bg-dark-800 border border-slate-700/60 rounded-xl overflow-hidden">
              <div className="px-5 py-3 border-b border-slate-700/60">
                <h2 className="text-sm font-semibold text-slate-300">Sector Breakdown</h2>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-slate-700/60">
                      {['Sector', 'Stocks', 'Avg SIP Score', 'Avg CAGR', 'Monthly Allocation'].map(h => (
                        <th key={h} className="px-4 py-2.5 text-left text-slate-500 font-medium">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {report.sector_summary.map((s, i) => {
                      const ss = sectorStyle(s.growth_sector)
                      return (
                        <tr key={s.growth_sector}
                          className={`border-b border-slate-800/60 hover:bg-slate-800/30 ${i % 2 === 0 ? '' : 'bg-slate-800/10'}`}>
                          <td className="px-4 py-2.5">
                            <div className="flex items-center gap-2">
                              <span className={`w-2 h-2 rounded-full ${ss.dot}`} />
                              <span className={`font-medium ${ss.text}`}>{s.label}</span>
                            </div>
                          </td>
                          <td className="px-4 py-2.5 text-slate-300">{s.count}</td>
                          <td className="px-4 py-2.5">
                            <span className={`font-bold ${scoreColor(s.avg_score)}`}>{s.avg_score.toFixed(1)}</span>
                            <span className="text-slate-600">/100</span>
                          </td>
                          <td className="px-4 py-2.5 text-emerald-400 font-semibold">{s.avg_cagr_pct.toFixed(1)}%</td>
                          <td className="px-4 py-2.5">
                            <div className="flex items-center gap-2">
                              <div className="flex-1 h-1.5 bg-slate-700 rounded-full max-w-24">
                                <div className={`h-full rounded-full ${ss.dot} opacity-70`}
                                  style={{ width: `${Math.min(s.alloc_pct, 100)}%` }} />
                              </div>
                              <span className={`font-bold ${ss.text}`}>{s.alloc_pct.toFixed(1)}%</span>
                              {budget > 0 && (
                                <span className="text-slate-500">(${((s.alloc_pct / 100) * budget).toFixed(0)}/mo)</span>
                              )}
                            </div>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </div>

            {/* ── Disclaimer ───────────────────────────────────────────────── */}
            <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-4 text-xs text-slate-500">
              <span className="text-slate-400 font-semibold">Disclaimer: </span>
              This analysis is for informational purposes only and is not financial advice. Projections are model-based
              estimates using publicly available data and sector trends — actual returns may differ significantly.
              SIP investing does not guarantee profit. Past performance is not indicative of future results.
              Always do your own research and consult a financial advisor before investing.
            </div>
          </>
        )}
      </div>
    </div>
  )
}
