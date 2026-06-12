import { useEffect, useState, useCallback } from 'react'
import axios from 'axios'
import LoadingSpinner from '../components/LoadingSpinner'

// ── Types ─────────────────────────────────────────────────────────────────────

interface NiftyIndexSignal {
  spot_price: number
  ma_50: number; ma_150: number; ma_200: number
  low_52w: number; high_52w: number
  rs_rating: number
  pt1_price_above_150_200: boolean
  pt2_150_above_200: boolean
  pt3_200_trending_up: boolean
  pt4_50_above_both: boolean
  pt5_price_above_50: boolean
  pt6_30pct_above_low: boolean
  pt7_within_25pct_high: boolean
  pt8_momentum_positive: boolean
  trend_template_score: number
  stage: number
  stage_label: string
  vcp_detected: boolean
  vcp_contractions: number
  base_low: number; base_high: number; pivot_level: number
  signal: string
  direction: string
  strike_price: number
  expiry: string
  entry: number; stop_loss: number; target_1: number; target_2: number
  stop_pct: number; risk_reward: number
  suggested_lots: number; lot_size: number
  max_loss_inr: number; target_gain_inr: number
  confluence: string[]
  caveats: string[]
  rating: string
  generated_at: string
}

interface MinerviniPick {
  symbol: string
  name: string
  sector: string
  current_price: number
  pt1_price_above_150_200: boolean
  pt2_150_above_200: boolean
  pt3_200_trending_up: boolean
  pt4_50_above_both: boolean
  pt5_price_above_50: boolean
  pt6_30pct_above_low: boolean
  pt7_within_25pct_high: boolean
  pt8_rs_rating_70plus: boolean
  trend_template_score: number
  stage: number
  stage_label: string
  vcp_detected: boolean
  vcp_contractions: number
  base_price_low: number
  base_price_high: number
  pivot_price: number
  ma_50: number; ma_150: number; ma_200: number
  low_52w: number; high_52w: number
  rs_rating: number
  signal: string
  direction: string
  entry: number; stop_loss: number; stop_pct: number
  target_1: number; target_2: number
  suggested_lots: number
  max_loss_inr: number; target_gain_inr: number
  risk_reward: number
  rating: string
  reasoning: string[]
  caveats: string[]
}

interface MinerviniReport {
  picks: MinerviniPick[]
  top_buys: MinerviniPick[]
  top_shorts: MinerviniPick[]
  stage1_watch: MinerviniPick[]
  methodology: string
  book_source: string
  generated_at: string
  data_as_of: string
  nifty_rs_6m: number
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const fmtINR = (n: number) => '₹' + Math.round(n || 0).toLocaleString('en-IN')
const fmtN   = (n: number, d = 0) => n?.toLocaleString('en-IN', { maximumFractionDigits: d })

const ratingColors: Record<string, { bg: string; text: string; border: string }> = {
  EXCELLENT: { bg: 'bg-emerald-500/20', text: 'text-emerald-300', border: 'border-emerald-500/50' },
  GOOD:      { bg: 'bg-lime-500/20',    text: 'text-lime-300',    border: 'border-lime-500/50' },
  STRONG:    { bg: 'bg-emerald-500/20', text: 'text-emerald-300', border: 'border-emerald-500/50' },
  MODERATE:  { bg: 'bg-amber-500/20',   text: 'text-amber-300',   border: 'border-amber-500/50' },
  FAIR:      { bg: 'bg-amber-500/20',   text: 'text-amber-300',   border: 'border-amber-500/50' },
  WATCH:     { bg: 'bg-cyan-500/20',    text: 'text-cyan-300',    border: 'border-cyan-500/50' },
  WAIT:      { bg: 'bg-slate-700/30',   text: 'text-slate-300',   border: 'border-slate-600/50' },
  NO_TRADE:  { bg: 'bg-slate-700/30',   text: 'text-slate-300',   border: 'border-slate-600/50' },
  AVOID:     { bg: 'bg-rose-500/20',    text: 'text-rose-300',    border: 'border-rose-500/50' },
  WEAK:      { bg: 'bg-rose-500/20',    text: 'text-rose-300',    border: 'border-rose-500/50' },
}

const stageColors: Record<number, { bg: string; text: string; label: string }> = {
  1: { bg: 'bg-cyan-500/20',    text: 'text-cyan-300',    label: 'BASING — Watch' },
  2: { bg: 'bg-emerald-500/20', text: 'text-emerald-300', label: 'ADVANCING — Buy zone' },
  3: { bg: 'bg-amber-500/20',   text: 'text-amber-300',   label: 'TOPPING — Tighten stops' },
  4: { bg: 'bg-rose-500/20',    text: 'text-rose-300',    label: 'DECLINING — Avoid longs' },
}

// ── NIFTY INDEX SIGNAL PANEL ──────────────────────────────────────────────────

function NiftyIndexPanel({ account, risk }: { account: number; risk: number }) {
  const [sig, setSig] = useState<NiftyIndexSignal | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    axios.get(`/api/naren/v1/nifty/minervini-index?account=${account}&risk=${risk}`)
      .then(r => setSig(r.data))
      .catch(() => setSig(null))
      .finally(() => setLoading(false))
  }, [account, risk])

  if (loading) return (
    <div className="bg-dark-900 rounded-2xl border border-dark-700 p-6 mb-6 flex items-center gap-3">
      <LoadingSpinner /><span className="text-slate-400 text-sm">Analysing NIFTY 50 with Minervini framework…</span>
    </div>
  )

  if (!sig) return null

  const isCE = sig.signal === 'BUY_CE'
  const isPE = sig.signal === 'BUY_PE'
  const isWait = !isCE && !isPE

  const sigColor  = isCE ? 'text-emerald-400' : isPE ? 'text-rose-400' : 'text-slate-400'
  const sigBorder = isCE ? 'border-emerald-500/40' : isPE ? 'border-rose-500/40' : 'border-slate-700'
  const sigBg     = isCE ? 'bg-emerald-500/5' : isPE ? 'bg-rose-500/5' : 'bg-dark-900'
  const r         = ratingColors[sig.rating] ?? ratingColors.WAIT
  const stg       = stageColors[sig.stage] ?? stageColors[1]

  // Score bar segments
  const pts = [
    sig.pt1_price_above_150_200, sig.pt2_150_above_200, sig.pt3_200_trending_up,
    sig.pt4_50_above_both, sig.pt5_price_above_50, sig.pt6_30pct_above_low,
    sig.pt7_within_25pct_high, sig.pt8_momentum_positive,
  ]
  const ptLabels = [
    'Price > 150 & 200 MA', '150 > 200 MA', '200 MA trending up',
    '50 > 150 & 200 MA', 'Price > 50 MA', '25% above 52w Low',
    'Within 20% of 52w High', '3-month Momentum +ve',
  ]

  return (
    <div className={`rounded-2xl border-2 ${sigBorder} ${sigBg} p-5 mb-6`}>
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-4 mb-4">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <div className="w-2 h-7 bg-yellow-400 rounded-full" />
            <h2 className="text-xl font-bold text-white">NIFTY 50 INDEX — Options Signal</h2>
            <span className="px-2 py-0.5 text-[10px] font-bold rounded bg-yellow-500/20 text-yellow-300 border border-yellow-500/30 uppercase">
              Minervini Framework
            </span>
          </div>
          <div className="text-xs text-slate-500 ml-4">
            Stage Analysis + 8-Point Trend Template + VCP on ^NSEI Daily chart
          </div>
        </div>

        {/* Big signal badge */}
        <div className="flex items-center gap-3">
          {!isWait ? (
            <div className={`px-5 py-3 rounded-xl border-2 ${sigBorder} text-center min-w-[130px]`}>
              <div className={`text-3xl font-black font-mono ${sigColor}`}>
                {isCE ? '⚡ BUY CE' : '⚡ BUY PE'}
              </div>
              <div className="text-xs text-slate-400 mt-1">Strike {fmtN(sig.strike_price)} · {sig.expiry}</div>
            </div>
          ) : (
            <div className="px-5 py-3 rounded-xl border border-slate-700 text-center min-w-[130px]">
              <div className="text-2xl font-black font-mono text-slate-400">⏸ WAIT</div>
              <div className="text-xs text-slate-500 mt-1">{sig.stage_label.split('—')[0].trim()}</div>
            </div>
          )}

          {/* Rating + Stage */}
          <div className="flex flex-col gap-1.5">
            <span className={`px-3 py-1 rounded text-xs font-bold border ${r.bg} ${r.text} ${r.border}`}>
              {sig.rating}
            </span>
            <span className={`px-3 py-1 rounded text-xs font-bold ${stg.bg} ${stg.text}`}>
              {stg.label}
            </span>
          </div>
        </div>
      </div>

      {/* Spot + MAs row */}
      <div className="grid grid-cols-3 md:grid-cols-6 gap-2 mb-4">
        {[
          { label: 'NIFTY Spot', val: fmtN(sig.spot_price), color: 'text-white' },
          { label: '50 MA',      val: fmtN(sig.ma_50),       color: sig.spot_price > sig.ma_50   ? 'text-emerald-400' : 'text-rose-400' },
          { label: '150 MA',     val: fmtN(sig.ma_150),      color: sig.spot_price > sig.ma_150  ? 'text-emerald-400' : 'text-rose-400' },
          { label: '200 MA',     val: fmtN(sig.ma_200),      color: sig.spot_price > sig.ma_200  ? 'text-emerald-400' : 'text-rose-400' },
          { label: '52w Low',    val: fmtN(sig.low_52w),     color: 'text-slate-300' },
          { label: '52w High',   val: fmtN(sig.high_52w),    color: 'text-slate-300' },
        ].map(({ label, val, color }) => (
          <div key={label} className="bg-dark-800/60 rounded-lg p-2 text-center">
            <div className="text-[9px] text-slate-500 uppercase tracking-wide mb-0.5">{label}</div>
            <div className={`text-sm font-bold font-mono ${color}`}>{val}</div>
          </div>
        ))}
      </div>

      {/* Trade levels (if signal active) */}
      {!isWait && (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-2 mb-4">
          <LevelCard label="Entry (NIFTY level)" val={fmtN(sig.entry)} color="text-cyan-400" />
          <LevelCard label={`Target 1 (${isCE?'+':'-'}1.5%)`} val={fmtN(sig.target_1)} color="text-emerald-400" />
          <LevelCard label={`Target 2 (${isCE?'+':'-'}3%)`}   val={fmtN(sig.target_2)} color="text-emerald-300" />
          <LevelCard label={`Stop (-${sig.stop_pct}%)`}        val={fmtN(sig.stop_loss)} color="text-rose-400" />
          <LevelCard label="R:R Ratio"                         val={`1:${sig.risk_reward}`} color="text-yellow-400" />
        </div>
      )}

      {/* Position sizing (if signal active) */}
      {!isWait && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-4">
          <div className="bg-dark-800/60 rounded-lg p-3 text-center">
            <div className="text-[9px] text-slate-500 uppercase mb-0.5">Strike to Trade</div>
            <div className="text-base font-bold font-mono text-white">
              {fmtN(sig.strike_price)} {sig.direction}
            </div>
          </div>
          <div className="bg-dark-800/60 rounded-lg p-3 text-center">
            <div className="text-[9px] text-slate-500 uppercase mb-0.5">Suggested Lots</div>
            <div className="text-base font-bold font-mono text-cyan-400">
              {sig.suggested_lots} × {sig.lot_size} qty
            </div>
          </div>
          <div className="bg-dark-800/60 rounded-lg p-3 text-center">
            <div className="text-[9px] text-slate-500 uppercase mb-0.5">Max Loss (1.25% risk)</div>
            <div className="text-base font-bold font-mono text-rose-400">{fmtINR(sig.max_loss_inr)}</div>
          </div>
          <div className="bg-dark-800/60 rounded-lg p-3 text-center">
            <div className="text-[9px] text-slate-500 uppercase mb-0.5">Target Gain (T1)</div>
            <div className="text-base font-bold font-mono text-emerald-400">{fmtINR(sig.target_gain_inr)}</div>
          </div>
        </div>
      )}

      {/* VCP badge */}
      {sig.vcp_detected && (
        <div className="mb-4 p-2.5 bg-emerald-500/10 border border-emerald-500/30 rounded-lg text-xs">
          <span className="font-bold text-emerald-300">✓ VCP on NIFTY INDEX Detected</span>
          <span className="text-slate-400">
            {' '}— {sig.vcp_contractions} contractions · base {fmtN(sig.base_low)}–{fmtN(sig.base_high)} · pivot @ {fmtN(sig.pivot_level)}
          </span>
        </div>
      )}

      {/* 8-point checklist */}
      <div className="mb-4">
        <div className="flex items-center gap-2 mb-2">
          <span className="text-xs font-bold text-slate-400 uppercase">
            Trend Template Score:
          </span>
          <span className="text-sm font-black font-mono text-white">{sig.trend_template_score}/100</span>
          {/* Score bar */}
          <div className="flex gap-0.5 ml-1">
            {pts.map((ok, i) => (
              <div key={i} className={`w-6 h-3 rounded-sm ${ok ? 'bg-emerald-500' : 'bg-slate-700'}`} title={ptLabels[i]} />
            ))}
          </div>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-1.5">
          {pts.map((ok, i) => (
            <Check key={i} ok={ok} text={ptLabels[i]} />
          ))}
        </div>
      </div>

      {/* Confluence + Caveats */}
      {(sig.confluence?.length > 0 || sig.caveats?.length > 0) && (
        <div className="space-y-1 text-xs">
          {sig.confluence?.map((c, i) => (
            <div key={i} className={c.startsWith('✓') ? 'text-emerald-300' : c.startsWith('✗') ? 'text-rose-300' : 'text-slate-400'}>
              {c}
            </div>
          ))}
          {sig.caveats?.map((c, i) => (
            <div key={i} className="text-amber-400">⚠ {c}</div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Full Scan Types ───────────────────────────────────────────────────────────

interface PromoterData {
  available: boolean
  promoter_holding: number; promoter_prev: number; promoter_delta: number
  pledging_pct: number
  fii_holding: number; dii_holding: number
  fii_increasing: boolean; dii_increasing: boolean
  promoter_score: number; promoter_grade: string
  flags: string[]
}
interface FullScanPick {
  symbol: string; name: string; sector: string
  price: number; ma_50: number; ma_150: number; ma_200: number
  high_52w: number; low_52w: number
  trend_score: number; stage: number; stage_label: string
  vcp: boolean; pivot_price: number; rs_rating: number
  signal: string; entry: number; stop_loss: number
  target_1: number; target_2: number; stop_pct: number; risk_reward: number
  reasoning: string[]
  promoter: PromoterData
  combined_score: number; final_grade: string; recommendation: string
  data_as_of: string
}
interface FullScanReport {
  picks: FullScanPick[]; top_buys: FullScanPick[]; watchlist: FullScanPick[]
  total_scanned: number; data_as_of: string; nifty_rs_6m: number
  generated_at: string; methodology: string
}

// ── Promoter Badge ────────────────────────────────────────────────────────────

function PromoterBadge({ p }: { p: PromoterData }) {
  const gradeColor =
    p.promoter_grade === 'A'  ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40' :
    p.promoter_grade === 'B+' ? 'bg-lime-500/20 text-lime-300 border-lime-500/40' :
    p.promoter_grade === 'B'  ? 'bg-blue-500/20 text-blue-300 border-blue-500/40' :
    p.promoter_grade === 'C'  ? 'bg-amber-500/20 text-amber-300 border-amber-500/40' :
    p.promoter_grade === 'DISQUALIFIED' ? 'bg-red-500/30 text-red-300 border-red-500/50' :
    'bg-slate-700 text-slate-400 border-slate-600'

  return (
    <div className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded border text-[10px] font-bold ${gradeColor}`}>
      🛡 Promoter {p.promoter_grade}
    </div>
  )
}

// ── Full Scan Pick Card ───────────────────────────────────────────────────────

function FullScanCard({ pick }: { pick: FullScanPick }) {
  const [open, setOpen] = useState(false)
  const rec = pick.recommendation
  const recColor =
    rec === 'STRONG BUY' ? 'text-emerald-300 bg-emerald-500/15 border-emerald-500/30' :
    rec === 'BUY'        ? 'text-blue-300 bg-blue-500/15 border-blue-500/30' :
    rec === 'ACCUMULATE' ? 'text-cyan-300 bg-cyan-500/15 border-cyan-500/30' :
    rec === 'WATCHLIST'  ? 'text-amber-300 bg-amber-500/15 border-amber-500/30' :
    rec === 'AVOID'      ? 'text-red-300 bg-red-500/15 border-red-500/30' :
                           'bg-slate-700/40 text-slate-400 border-slate-600'
  const pledgeBad = pick.promoter.pledging_pct > 15
  const promoterDeltaColor = pick.promoter.promoter_delta > 0 ? 'text-emerald-400' : pick.promoter.promoter_delta < -0.5 ? 'text-red-400' : 'text-slate-400'

  return (
    <div className={`bg-dark-900 rounded-xl border-2 ${recColor.includes('emerald') ? 'border-emerald-500/30' : recColor.includes('blue') ? 'border-blue-500/30' : recColor.includes('amber') ? 'border-amber-500/30' : 'border-dark-700'} overflow-hidden`}>
      {/* Header row */}
      <div className="flex items-start justify-between gap-3 p-4 cursor-pointer" onClick={() => setOpen(o => !o)}>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2 mb-0.5">
            <span className="text-base font-bold text-white">{pick.symbol.replace('.NS', '')}</span>
            <span className={`text-[10px] font-bold px-2 py-0.5 rounded border ${recColor}`}>{rec}</span>
            <PromoterBadge p={pick.promoter} />
            {pick.vcp && <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-purple-500/20 text-purple-300 border border-purple-500/30">VCP</span>}
          </div>
          <div className="text-xs text-slate-400">{pick.name} · {pick.sector}</div>
        </div>

        <div className="text-right flex-shrink-0">
          <div className="text-lg font-black text-white font-mono">₹{Math.round(pick.price).toLocaleString('en-IN')}</div>
          <div className="flex items-center justify-end gap-2 mt-0.5">
            <span className="text-[10px] text-slate-500">Score</span>
            <span className="text-sm font-bold text-white">{pick.combined_score}<span className="text-slate-500 font-normal">/150</span></span>
            <span className="text-[10px] font-bold text-white bg-slate-700 px-1.5 py-0.5 rounded">{pick.final_grade}</span>
          </div>
        </div>
      </div>

      {/* Key metrics strip */}
      <div className="grid grid-cols-5 border-t border-dark-700 text-center divide-x divide-dark-700">
        {[
          { l: 'Trend', v: `${pick.trend_score}/100`, c: pick.trend_score >= 75 ? 'text-emerald-400' : pick.trend_score >= 50 ? 'text-amber-400' : 'text-red-400' },
          { l: 'Stage', v: `S${pick.stage}`, c: pick.stage === 2 ? 'text-emerald-400' : pick.stage === 4 ? 'text-red-400' : 'text-amber-400' },
          { l: 'RS', v: `${pick.rs_rating}`, c: pick.rs_rating >= 70 ? 'text-emerald-400' : pick.rs_rating >= 50 ? 'text-amber-400' : 'text-red-400' },
          { l: 'Promoter', v: `${pick.promoter.promoter_holding > 0 ? pick.promoter.promoter_holding.toFixed(1) + '%' : '—'}`, c: pick.promoter.promoter_holding >= 50 ? 'text-emerald-400' : pick.promoter.promoter_holding >= 25 ? 'text-amber-400' : 'text-slate-400' },
          { l: 'Pledged', v: `${pick.promoter.pledging_pct > 0 ? pick.promoter.pledging_pct.toFixed(1) + '%' : '0%'}`, c: pledgeBad ? 'text-red-400' : 'text-emerald-400' },
        ].map(m => (
          <div key={m.l} className="py-2 px-1">
            <div className="text-[9px] text-slate-500">{m.l}</div>
            <div className={`text-xs font-bold ${m.c}`}>{m.v}</div>
          </div>
        ))}
      </div>

      {/* Expanded detail */}
      {open && (
        <div className="border-t border-dark-700 p-4 space-y-3">
          {/* Trade levels */}
          {pick.signal !== 'WAIT' && (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
              <LevelCard label="Entry" val={`₹${pick.entry.toFixed(0)}`} color="text-cyan-400" />
              <LevelCard label={`Target 1 (+${((pick.target_1/pick.entry - 1)*100).toFixed(1)}%)`} val={`₹${pick.target_1.toFixed(0)}`} color="text-emerald-400" />
              <LevelCard label={`Stop (-${pick.stop_pct.toFixed(1)}%)`} val={`₹${pick.stop_loss.toFixed(0)}`} color="text-red-400" />
              <LevelCard label="R:R" val={`1:${pick.risk_reward.toFixed(1)}`} color="text-yellow-400" />
            </div>
          )}

          {/* MA levels */}
          <div className="grid grid-cols-3 md:grid-cols-5 gap-1.5 text-[10px] font-mono text-slate-500">
            <div>MA50: <span className="text-slate-300">₹{pick.ma_50.toFixed(0)}</span></div>
            <div>MA150: <span className="text-slate-300">₹{pick.ma_150.toFixed(0)}</span></div>
            <div>MA200: <span className="text-slate-300">₹{pick.ma_200.toFixed(0)}</span></div>
            <div>52w H: <span className="text-slate-300">₹{pick.high_52w.toFixed(0)}</span></div>
            <div>52w L: <span className="text-slate-300">₹{pick.low_52w.toFixed(0)}</span></div>
          </div>

          {/* Promoter integrity detail */}
          <div className="bg-dark-800/60 rounded-lg p-3">
            <div className="text-[10px] font-bold text-slate-400 uppercase mb-2">🛡 Promoter Integrity</div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-2 text-xs">
              <div className="bg-dark-900 rounded p-2">
                <div className="text-slate-500 text-[9px]">Promoter Holding</div>
                <div className={`font-bold ${pick.promoter.promoter_holding >= 50 ? 'text-emerald-400' : 'text-amber-400'}`}>
                  {pick.promoter.promoter_holding > 0 ? pick.promoter.promoter_holding.toFixed(2) + '%' : '—'}
                </div>
              </div>
              <div className="bg-dark-900 rounded p-2">
                <div className="text-slate-500 text-[9px]">QoQ Change</div>
                <div className={`font-bold ${promoterDeltaColor}`}>
                  {pick.promoter.promoter_prev > 0 ? `${pick.promoter.promoter_delta >= 0 ? '+' : ''}${pick.promoter.promoter_delta.toFixed(2)}%` : '—'}
                </div>
              </div>
              <div className="bg-dark-900 rounded p-2">
                <div className="text-slate-500 text-[9px]">Pledged</div>
                <div className={`font-bold ${pledgeBad ? 'text-red-400' : 'text-emerald-400'}`}>
                  {pick.promoter.pledging_pct > 0 ? pick.promoter.pledging_pct.toFixed(2) + '%' : '0% ✓'}
                </div>
              </div>
              <div className="bg-dark-900 rounded p-2">
                <div className="text-slate-500 text-[9px]">FII / DII</div>
                <div className="font-bold text-slate-300">
                  {pick.promoter.fii_holding.toFixed(1)}% / {pick.promoter.dii_holding.toFixed(1)}%
                  {pick.promoter.fii_increasing && <span className="text-emerald-400 ml-1">↑FII</span>}
                  {pick.promoter.dii_increasing && <span className="text-emerald-400 ml-1">↑DII</span>}
                </div>
              </div>
            </div>
            <div className="space-y-0.5">
              {(pick.promoter.flags || []).map((f, i) => (
                <div key={i} className={`text-[11px] ${f.startsWith('✓') ? 'text-emerald-400' : f.startsWith('✗') || f.startsWith('🚨') ? 'text-red-400' : 'text-amber-400'}`}>{f}</div>
              ))}
            </div>
          </div>

          {/* Reasoning */}
          {pick.reasoning?.length > 0 && (
            <div className="space-y-0.5">
              {pick.reasoning.map((r, i) => <div key={i} className="text-xs text-slate-300">{r}</div>)}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ── Full Scan Panel ───────────────────────────────────────────────────────────

function FullScanPanel({ account, risk }: { account: number; risk: number }) {
  const [report, setReport] = useState<FullScanReport | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [scanFilter, setScanFilter] = useState<'top_buys' | 'watchlist' | 'all'>('top_buys')
  const [elapsed, setElapsed] = useState(0)

  const runScan = useCallback(() => {
    setLoading(true); setError(''); setReport(null)
    const t0 = Date.now()
    const timer = setInterval(() => setElapsed(Math.round((Date.now() - t0) / 1000)), 1000)
    axios.get(`/api/naren/v1/nifty/minervini-full?account=${account}&risk=${risk}&limit=30`, { timeout: 120000 })
      .then(r => setReport(r.data))
      .catch(e => setError(e?.response?.data?.error ?? 'Scan failed'))
      .finally(() => { setLoading(false); clearInterval(timer) })
  }, [account, risk])

  const picks = report
    ? scanFilter === 'top_buys' ? report.top_buys
    : scanFilter === 'watchlist' ? report.watchlist
    : report.picks
    : []

  return (
    <div>
      {/* Scan trigger */}
      {!report && !loading && (
        <div className="bg-dark-900 rounded-2xl border border-dark-700 p-8 text-center">
          <div className="text-4xl mb-3">🔬</div>
          <h3 className="text-lg font-bold text-white mb-1">Full NSE Universe Scan</h3>
          <p className="text-slate-400 text-sm mb-1 max-w-md mx-auto">
            Scans ~75 NSE stocks (Nifty 50 + Nifty Next 50) using Minervini SEPA + Promoter Integrity filter.
          </p>
          <p className="text-slate-500 text-xs mb-6">
            Fetches live prices from Yahoo Finance + promoter data from Screener.in. Takes ~30–60 seconds.
          </p>
          <button onClick={runScan}
            className="px-6 py-3 bg-emerald-600 hover:bg-emerald-500 text-white font-bold rounded-xl transition-all flex items-center gap-2 mx-auto">
            🚀 Run Full Scan
          </button>
        </div>
      )}

      {loading && (
        <div className="bg-dark-900 rounded-2xl border border-dark-700 p-10 text-center">
          <LoadingSpinner size="lg" />
          <div className="text-slate-300 font-medium mt-4">Scanning {elapsed < 15 ? 'NSE universe…' : elapsed < 30 ? 'Running Minervini scoring…' : 'Fetching promoter data from Screener.in…'}</div>
          <div className="text-slate-500 text-sm mt-1">{elapsed}s elapsed · typically 30–60s</div>
          <div className="mt-3 flex justify-center gap-1">
            {[0,1,2,3,4].map(i => (
              <div key={i} className={`w-2 h-2 rounded-full ${elapsed % 5 === i ? 'bg-emerald-400' : 'bg-slate-700'} transition-all`} />
            ))}
          </div>
        </div>
      )}

      {error && <div className="bg-red-500/10 border border-red-500/30 rounded-xl p-4 text-red-400 text-sm">{error}</div>}

      {report && (
        <div className="space-y-4">
          {/* Summary bar */}
          <div className="bg-dark-900 rounded-xl border border-dark-700 p-4 flex flex-wrap items-center gap-6">
            <div className="text-center">
              <div className="text-2xl font-black text-white">{report.total_scanned}</div>
              <div className="text-[10px] text-slate-500">Stocks scanned</div>
            </div>
            <div className="text-center">
              <div className="text-2xl font-black text-emerald-400">{report.top_buys.length}</div>
              <div className="text-[10px] text-slate-500">Strong Buy / Buy</div>
            </div>
            <div className="text-center">
              <div className="text-2xl font-black text-cyan-400">{report.watchlist.length}</div>
              <div className="text-[10px] text-slate-500">Watchlist / Accumulate</div>
            </div>
            <div className="ml-auto text-right text-xs">
              <div className="text-slate-300">Data as of <span className="font-bold text-white">{report.data_as_of}</span></div>
              <div className="text-slate-500">Nifty 6M: <span className={`font-bold ${(report.nifty_rs_6m ?? 0) >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{(report.nifty_rs_6m ?? 0) >= 0 ? '+' : ''}{(report.nifty_rs_6m ?? 0).toFixed(1)}%</span></div>
            </div>
            <button onClick={runScan} className="px-3 py-1.5 bg-slate-700 hover:bg-slate-600 text-white text-xs font-bold rounded-lg">🔄 Rescan</button>
          </div>

          {/* Promoter integrity legend */}
          <div className="bg-dark-900/60 rounded-xl border border-dark-700 px-4 py-2.5 text-[10px] flex flex-wrap gap-3 items-center">
            <span className="text-slate-500 font-bold uppercase">Promoter Score:</span>
            {[
              { g: 'A', c: 'text-emerald-400', d: '7-10 pts — zero/low pledge + high holding' },
              { g: 'B+', c: 'text-lime-400', d: '5-6 pts — clean but moderate holding' },
              { g: 'B', c: 'text-blue-400', d: '3-4 pts — acceptable' },
              { g: 'C', c: 'text-amber-400', d: '1-2 pts — watch pledging' },
              { g: 'DISQUALIFIED', c: 'text-red-400', d: 'Pledging >50% or holding <10%' },
            ].map(x => (
              <span key={x.g} className={`${x.c} font-bold`}>{x.g} <span className="text-slate-500 font-normal">— {x.d}</span></span>
            ))}
          </div>

          {/* Filter tabs */}
          <div className="flex gap-2">
            {([['top_buys','🟢 Strong Buy / Buy'], ['watchlist','🔵 Watchlist'], ['all','📋 All Picks']] as const).map(([f, label]) => (
              <button key={f} onClick={() => setScanFilter(f)}
                className={`px-4 py-2 rounded-xl text-xs font-bold transition-all ${scanFilter === f ? 'bg-emerald-600 text-white' : 'bg-dark-900 border border-dark-700 text-slate-400 hover:text-white'}`}>
                {label} ({f === 'top_buys' ? report.top_buys.length : f === 'watchlist' ? report.watchlist.length : report.picks.length})
              </button>
            ))}
          </div>

          {/* Cards */}
          {picks.length === 0 ? (
            <div className="text-center py-8 text-slate-500 text-sm bg-dark-900 rounded-xl border border-dark-700">
              No picks in this category. Minervini's rules are strict — this is normal in a sideways/down market.
            </div>
          ) : (
            <div className="space-y-3">
              {picks.map(p => <FullScanCard key={p.symbol} pick={p} />)}
            </div>
          )}

          <div className="text-xs text-slate-600 text-center pt-2">{report.methodology}</div>
        </div>
      )}
    </div>
  )
}

// ── MAIN PAGE ─────────────────────────────────────────────────────────────────

export default function Minervini() {
  const [report, setReport] = useState<MinerviniReport | null>(null)
  const [loading, setLoading] = useState(true)
  const [account, setAccount] = useState(100000)
  const [risk, setRisk] = useState(1.25)
  const [filter, setFilter] = useState<'all' | 'buy' | 'short' | 'watch'>('buy')
  const [mainTab, setMainTab] = useState<'quick' | 'full'>('quick')

  const fetchData = () => {
    setLoading(true)
    axios.get(`/api/naren/v1/nifty/minervini?account=${account}&risk=${risk}`)
      .then(r => setReport(r.data))
      .finally(() => setLoading(false))
  }

  useEffect(() => { fetchData() /* eslint-disable-next-line */ }, [account, risk])

  if (loading) return <div className="p-8"><LoadingSpinner /></div>
  if (!report) return <div className="p-8 text-rose-400">Failed to load Minervini analysis</div>

  const filteredPicks = filter === 'all' ? report.picks
    : filter === 'buy'   ? report.top_buys
    : filter === 'short' ? report.top_shorts
    : report.stage1_watch

  return (
    <div className="min-h-screen bg-dark-950 text-slate-100 p-4 md:p-6">
      {/* Page header */}
      <div className="mb-5">
        <div className="flex flex-wrap items-center gap-3 mb-1">
          <div className="w-2 h-8 bg-emerald-500 rounded-full" />
          <h1 className="text-2xl font-bold text-white">Minervini SEPA — Champion Strategy</h1>
          <span className="px-2 py-0.5 rounded text-xs bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 font-mono font-bold">
            220% (2021 US Champion · Audited)
          </span>
        </div>
        <p className="text-slate-400 text-xs ml-5">{report.book_source}</p>
      </div>

      {/* Risk controls */}
      <div className="bg-dark-900 rounded-xl border border-dark-700 p-4 mb-5">
        <div className="flex flex-wrap items-center gap-4">
          <span className="text-xs font-bold text-slate-300 uppercase">⚙️ Risk Settings:</span>
          <label className="flex items-center gap-2 text-sm">
            <span className="text-slate-400">Account:</span>
            <input type="number" value={account} onChange={e => setAccount(+e.target.value)}
              className="w-28 px-2 py-1 bg-dark-800 border border-dark-600 rounded text-slate-200 font-mono text-sm"
              step={10000} min={10000} />
            <span className="text-slate-500">₹</span>
          </label>
          <label className="flex items-center gap-2 text-sm">
            <span className="text-slate-400">Risk per trade:</span>
            <input type="range" min={0.5} max={3} step={0.25} value={risk}
              onChange={e => setRisk(+e.target.value)} className="w-32 accent-emerald-500" />
            <span className="text-emerald-400 font-mono font-bold">{risk}%</span>
            <span className="text-slate-500">(Minervini: 1.25%)</span>
          </label>
          <button onClick={fetchData}
            className="ml-auto px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-bold rounded">
            🔄 Refresh
          </button>
        </div>
      </div>

      {/* ★ NIFTY INDEX signal — always shown first ★ */}
      <NiftyIndexPanel account={account} risk={risk} />

      {/* Data freshness bar */}
      <div className="bg-dark-900 rounded-xl border border-dark-700 px-4 py-3 mb-5 flex flex-wrap items-center gap-4 text-xs">
        <div className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
          <span className="text-slate-400">Data as of:</span>
          <span className="font-bold text-white">{report.data_as_of || '—'}</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-slate-400">Nifty 6M return (RS benchmark):</span>
          <span className={`font-bold font-mono ${(report.nifty_rs_6m ?? 0) >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
            {(report.nifty_rs_6m ?? 0) >= 0 ? '+' : ''}{(report.nifty_rs_6m ?? 0).toFixed(1)}%
          </span>
        </div>
        <div className="text-slate-500">
          RS Rating = stock 6M return − Nifty 6M return. ≥70 = outperforming market.
        </div>
      </div>

      {/* Tab switcher: Quick (25 DB stocks) vs Full Scan (75 NSE + promoter) */}
      <div className="flex gap-1 bg-dark-900 rounded-xl p-1 w-fit mb-5 border border-dark-700">
        <button onClick={() => setMainTab('quick')}
          className={`px-5 py-2 rounded-lg text-sm font-bold transition-all ${mainTab === 'quick' ? 'bg-emerald-600 text-white' : 'text-slate-400 hover:text-white'}`}>
          ⚡ Quick Scan (DB stocks)
        </button>
        <button onClick={() => setMainTab('full')}
          className={`px-5 py-2 rounded-lg text-sm font-bold transition-all flex items-center gap-2 ${mainTab === 'full' ? 'bg-purple-600 text-white' : 'text-slate-400 hover:text-white'}`}>
          🔬 Full NSE Scan + Promoter Integrity
          <span className="text-[9px] bg-amber-500/30 text-amber-300 px-1.5 py-0.5 rounded font-bold">~75 stocks</span>
        </button>
      </div>

      {mainTab === 'quick' && (
        <>
          {/* Stock filter buttons */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-5">
            <FilterButton active={filter === 'buy'}   onClick={() => setFilter('buy')}
              label="🟢 Top Buys (CE)" count={report.top_buys.length} color="emerald" />
            <FilterButton active={filter === 'short'} onClick={() => setFilter('short')}
              label="🔴 Top Shorts (PE)" count={report.top_shorts.length} color="rose" />
            <FilterButton active={filter === 'watch'} onClick={() => setFilter('watch')}
              label="🔵 Watch (Stage 1)" count={report.stage1_watch.length} color="cyan" />
            <FilterButton active={filter === 'all'}   onClick={() => setFilter('all')}
              label="📋 All Stocks" count={report.picks.length} color="slate" />
          </div>
          <div className="space-y-4">
            {filteredPicks.length === 0 ? (
              <div className="bg-dark-900 rounded-xl border border-dark-700 p-8 text-center text-slate-400">
                <div className="text-3xl mb-2">🔍</div>
                <div>No picks match this filter right now.</div>
                <div className="text-xs mt-1">Minervini's rules are strict — quality over quantity.</div>
              </div>
            ) : (
              filteredPicks.map(p => <PickCard key={p.symbol} pick={p} />)
            )}
          </div>
        </>
      )}

      {mainTab === 'full' && <FullScanPanel account={account} risk={risk} />}

      {/* Methodology */}
      <div className="mt-6 bg-dark-900 rounded-xl border border-dark-700 p-5">
        <h2 className="text-sm font-bold text-slate-300 mb-2">📖 Methodology</h2>
        <p className="text-xs text-slate-400 leading-relaxed">{report.methodology}</p>
      </div>
    </div>
  )
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function FilterButton({ active, onClick, label, count, color }: any) {
  const colors: Record<string, string> = {
    emerald: active ? 'bg-emerald-500/30 border-emerald-500/50 text-emerald-200' : 'bg-dark-900 border-dark-700 text-slate-400 hover:bg-dark-800',
    rose:    active ? 'bg-rose-500/30 border-rose-500/50 text-rose-200'         : 'bg-dark-900 border-dark-700 text-slate-400 hover:bg-dark-800',
    cyan:    active ? 'bg-cyan-500/30 border-cyan-500/50 text-cyan-200'         : 'bg-dark-900 border-dark-700 text-slate-400 hover:bg-dark-800',
    slate:   active ? 'bg-slate-500/30 border-slate-500/50 text-slate-200'      : 'bg-dark-900 border-dark-700 text-slate-400 hover:bg-dark-800',
  }
  return (
    <button onClick={onClick} className={`p-3 rounded-xl border-2 transition-all text-left ${colors[color]}`}>
      <div className="text-xs font-bold opacity-80">{label}</div>
      <div className="text-2xl font-black font-mono mt-1">{count}</div>
    </button>
  )
}

function PickCard({ pick }: { pick: MinerviniPick }) {
  const r     = ratingColors[pick.rating] ?? ratingColors.WAIT
  const stage = stageColors[pick.stage]   ?? stageColors[1]
  const sigColor = pick.signal === 'BUY_CE' ? 'text-emerald-400'
                 : pick.signal === 'BUY_PE' ? 'text-rose-400'
                 : pick.signal === 'HOLD'   ? 'text-amber-400'
                 : 'text-slate-400'
  const sigText  = pick.signal === 'BUY_CE' ? '⚡ BUY CE'
                 : pick.signal === 'BUY_PE' ? '⚡ BUY PE'
                 : pick.signal === 'HOLD'   ? 'HOLD existing'
                 : 'WAIT'

  return (
    <div className={`bg-dark-900 rounded-xl border-2 ${r.border} p-4`}>
      {/* Top row */}
      <div className="flex flex-wrap items-start justify-between gap-3 mb-3">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <h3 className="text-lg font-bold text-white">{pick.symbol.replace('.NS', '')}</h3>
            <span className={`px-2 py-0.5 rounded text-xs font-bold ${r.bg} ${r.text}`}>{pick.rating}</span>
            <span className={`px-2 py-0.5 rounded text-xs font-bold ${stage.bg} ${stage.text}`}>{stage.label}</span>
          </div>
          <div className="text-xs text-slate-500">{pick.sector} · ₹{pick.current_price.toFixed(2)}</div>
        </div>
        <div className="flex items-center gap-3">
          <div className="text-right">
            <div className={`text-2xl font-black font-mono ${sigColor}`}>{sigText}</div>
            {pick.signal !== 'WAIT' && pick.signal !== 'HOLD' && (
              <div className="text-xs text-slate-500">{pick.suggested_lots} lots · R:R 1:{pick.risk_reward}</div>
            )}
          </div>
        </div>
      </div>

      {/* Trade levels */}
      {(pick.signal === 'BUY_CE' || pick.signal === 'BUY_PE') && (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-2 mb-3">
          <LevelCard label="Entry"   val={`₹${pick.entry.toFixed(2)}`} color="text-cyan-400" />
          <LevelCard label={pick.signal === 'BUY_CE' ? 'Target 1 (+8%)' : 'Target 1 (-8%)'}
            val={`₹${pick.target_1.toFixed(2)}`} color="text-emerald-400" />
          <LevelCard label={pick.signal === 'BUY_CE' ? 'Target 2 (+25%)' : 'Target 2 (-25%)'}
            val={`₹${pick.target_2.toFixed(2)}`} color="text-emerald-300" />
          <LevelCard label={`Stop (-${pick.stop_pct}%)`} val={`₹${pick.stop_loss.toFixed(2)}`} color="text-rose-400" />
          <LevelCard label="Max Loss" val={fmtINR(pick.max_loss_inr)} color="text-rose-300" />
        </div>
      )}

      {/* VCP info */}
      {pick.vcp_detected && (
        <div className="mb-3 p-2 bg-emerald-500/10 border border-emerald-500/30 rounded text-xs">
          <span className="font-bold text-emerald-300">✓ VCP Pattern Detected</span>
          <span className="text-slate-400"> — {pick.vcp_contractions} contractions, base ₹{pick.base_price_low.toFixed(2)}–₹{pick.base_price_high.toFixed(2)}, pivot @ ₹{pick.pivot_price.toFixed(2)}</span>
        </div>
      )}

      {/* 8-point checklist */}
      <div className="mb-3">
        <div className="text-xs font-bold text-slate-400 uppercase mb-2">
          Trend Template: <span className="text-white font-mono">{pick.trend_template_score}/100</span>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-1.5">
          <Check ok={pick.pt1_price_above_150_200} text="Price > 150 & 200 MA" />
          <Check ok={pick.pt2_150_above_200}       text="150 MA > 200 MA" />
          <Check ok={pick.pt3_200_trending_up}     text="200 MA trending up" />
          <Check ok={pick.pt4_50_above_both}       text="50 MA > 150 & 200" />
          <Check ok={pick.pt5_price_above_50}      text="Price > 50 MA" />
          <Check ok={pick.pt6_30pct_above_low}     text="30% above 52w low" />
          <Check ok={pick.pt7_within_25pct_high}   text="Within 25% of 52w high" />
          <Check ok={pick.pt8_rs_rating_70plus}    text={`RS Rating ≥70 (${pick.rs_rating})`} />
        </div>
      </div>

      {/* Reasoning */}
      {pick.reasoning?.length > 0 && (
        <div className="text-xs space-y-1">
          {pick.reasoning.map((line, i) => <div key={i} className="text-slate-300">{line}</div>)}
          {pick.caveats?.map((c, i) => <div key={i} className="text-amber-400">⚠ {c}</div>)}
        </div>
      )}

      {/* Key MAs */}
      <div className="mt-3 pt-3 border-t border-dark-700 grid grid-cols-2 md:grid-cols-5 gap-2 text-[10px] font-mono text-slate-500">
        <div>50 MA: <span className="text-slate-300">₹{pick.ma_50.toFixed(2)}</span></div>
        <div>150 MA: <span className="text-slate-300">₹{pick.ma_150.toFixed(2)}</span></div>
        <div>200 MA: <span className="text-slate-300">₹{pick.ma_200.toFixed(2)}</span></div>
        <div>52w Low: <span className="text-slate-300">₹{pick.low_52w.toFixed(2)}</span></div>
        <div>52w High: <span className="text-slate-300">₹{pick.high_52w.toFixed(2)}</span></div>
      </div>
    </div>
  )
}

function LevelCard({ label, val, color }: { label: string; val: string; color: string }) {
  return (
    <div className="bg-dark-800 rounded p-2 text-center">
      <div className="text-[9px] text-slate-500 uppercase tracking-wide">{label}</div>
      <div className={`text-sm font-bold font-mono ${color}`}>{val}</div>
    </div>
  )
}

function Check({ ok, text }: { ok: boolean; text: string }) {
  return (
    <div className={`flex items-center gap-1.5 text-[11px] ${ok ? 'text-emerald-400' : 'text-slate-500'}`}>
      <span className={`w-4 h-4 rounded flex items-center justify-center text-[10px] font-bold flex-shrink-0 ${
        ok ? 'bg-emerald-500/20 text-emerald-400' : 'bg-slate-700/50 text-slate-500'}`}>
        {ok ? '✓' : '✗'}
      </span>
      <span>{text}</span>
    </div>
  )
}
