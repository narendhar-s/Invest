import { useState, useEffect, useRef, useCallback } from 'react'

// ─── Types ────────────────────────────────────────────────────────────────────

interface TradePlan {
  premium: number
  lots: number
  capital: number
  direction: 'CE' | 'PE'
  // calculated
  sl_premium: number
  sl_pct: number
  t1_premium: number
  t2_premium: number
  t3_premium: number
  cost_total: number
  max_loss_rs: number
  max_loss_pct: number
  t1_profit: number
  t2_profit: number
  t3_profit: number
  charges: number
  breakeven_premium: number
  rr_t1: number
  rr_t2: number
  score_required: number
}

interface SetupScore {
  time: number        // 0-2
  trend: number       // 0-2
  vwap: number        // 0-2
  level: number       // 0-2
  volume: number      // 0-2
}

interface LiveTrade {
  entry: number
  current: number
  lots: number
  entry_time: string
  sl: number
  t1: number
  t2: number
}

// ─── Charge calculator ────────────────────────────────────────────────────────

function calcCharges(premium: number, lots: number): number {
  const value = premium * lots * 65
  const brokerage = 40
  const stt = value * 0.001
  const exchange = value * 2 * 0.00053
  const gst = (brokerage + exchange) * 0.18
  const stamp = value * 0.00003
  return brokerage + stt + exchange + gst + stamp
}

function calcPlan(premium: number, lots: number, capital: number, sl_pct: number): TradePlan {
  const lot_size = 65
  const units = lots * lot_size
  const cost_total = premium * units
  const charges = calcCharges(premium, lots)

  const sl_premium = premium * (1 - sl_pct / 100)
  const sl_loss_pts = premium - sl_premium
  const max_loss_rs = sl_loss_pts * units + charges
  const max_loss_pct = (max_loss_rs / capital) * 100

  // charge-adjusted breakeven
  const breakeven_premium = premium + charges / units

  // Targets: 1.5× SL, 2.5× SL, 4× SL
  const t1_premium = premium + sl_loss_pts * 1.5
  const t2_premium = premium + sl_loss_pts * 2.5
  const t3_premium = premium + sl_loss_pts * 4.0

  const t1_profit = (t1_premium - premium) * units - charges
  const t2_profit = (t2_premium - premium) * units - charges
  const t3_profit = (t3_premium - premium) * units - charges

  const rr_t1 = t1_profit / max_loss_rs
  const rr_t2 = t2_profit / max_loss_rs

  return {
    premium, lots, capital, direction: 'CE',
    sl_premium, sl_pct, t1_premium, t2_premium, t3_premium,
    cost_total, max_loss_rs, max_loss_pct,
    t1_profit, t2_profit, t3_profit,
    charges, breakeven_premium, rr_t1, rr_t2,
    score_required: 7,
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmt(n: number, dec = 0) {
  return new Intl.NumberFormat('en-IN', {
    maximumFractionDigits: dec,
    minimumFractionDigits: dec,
  }).format(n)
}

function pnlColor(n: number) {
  return n >= 0 ? 'text-emerald-400' : 'text-rose-400'
}

function pnlBg(n: number, strong = false) {
  if (strong) return n >= 0 ? 'bg-emerald-500/15 border-emerald-500/40' : 'bg-rose-500/15 border-rose-500/40'
  return n >= 0 ? 'bg-emerald-500/8 border-emerald-500/25' : 'bg-rose-500/8 border-rose-500/25'
}

function getMinutes(timeStr: string): number {
  const [h, m] = timeStr.split(':').map(Number)
  return h * 60 + m
}

function nowTimeStr(): string {
  const d = new Date()
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

// ─── Score factors ────────────────────────────────────────────────────────────

const SCORE_FACTORS = [
  {
    key: 'time' as keyof SetupScore,
    label: 'Time Window',
    icon: '⏰',
    options: [
      { val: 0, label: 'Before 10 AM or after 2:30 PM', color: 'rose' },
      { val: 1, label: '11:00–12:00 (OK but not ideal)', color: 'amber' },
      { val: 2, label: '10:00–11:00 or 13:00–14:30 (Best)', color: 'emerald' },
    ],
    tip: 'Your best hours: 10 AM and 1–3 PM. Worst: 9:15–10 AM.',
  },
  {
    key: 'trend' as keyof SetupScore,
    label: '15-min Trend',
    icon: '📈',
    options: [
      { val: 0, label: 'Against trend (EMA9 < EMA21 for CE / > for PE)', color: 'rose' },
      { val: 1, label: 'Sideways / unclear EMAs', color: 'amber' },
      { val: 2, label: 'With trend (EMA9 > EMA21 for CE)', color: 'emerald' },
    ],
    tip: 'Never trade against the 15-min trend. It costs you 60% of your losses.',
  },
  {
    key: 'vwap' as keyof SetupScore,
    label: 'VWAP Position',
    icon: '🎯',
    options: [
      { val: 0, label: 'Against VWAP (CE below VWAP / PE above VWAP)', color: 'rose' },
      { val: 1, label: 'At VWAP (within ±5 pts)', color: 'amber' },
      { val: 2, label: 'Confirmed side (CE above VWAP / PE below VWAP)', color: 'emerald' },
    ],
    tip: 'VWAP is where institutions buy/sell. Trading against it is fighting them.',
  },
  {
    key: 'level' as keyof SetupScore,
    label: 'Key Level',
    icon: '🏗️',
    options: [
      { val: 0, label: 'Middle of range, no clear level', color: 'rose' },
      { val: 1, label: 'Near a minor level (EMA, round number)', color: 'amber' },
      { val: 2, label: 'At PDH/PDL, CPR, weekly S/R, round 00 level', color: 'emerald' },
    ],
    tip: 'Key levels give you an objective invalidation point for SL placement.',
  },
  {
    key: 'volume' as keyof SetupScore,
    label: 'Volume Confirmation',
    icon: '📊',
    options: [
      { val: 0, label: 'Volume below average (fake move likely)', color: 'rose' },
      { val: 1, label: 'Average volume (1×)', color: 'amber' },
      { val: 2, label: 'High volume spike (>1.5× avg) on entry candle', color: 'emerald' },
    ],
    tip: 'High volume on breakout = institutions participating = follow-through likely.',
  },
]

// ─── Sub-components ───────────────────────────────────────────────────────────

function ScoreRing({ score }: { score: number }) {
  const max = 10
  const pct = (score / max) * 100
  const r = 40
  const circ = 2 * Math.PI * r
  const dash = (pct / 100) * circ
  const color = score >= 8 ? '#10b981' : score >= 6 ? '#f59e0b' : '#ef4444'
  const label = score >= 8 ? 'TRADE IT' : score >= 6 ? 'RISKY' : 'SKIP'

  return (
    <div className="flex flex-col items-center">
      <svg width={100} height={100} className="-rotate-90">
        <circle cx={50} cy={50} r={r} stroke="#1e293b" strokeWidth={10} fill="none" />
        <circle
          cx={50} cy={50} r={r}
          stroke={color}
          strokeWidth={10}
          fill="none"
          strokeDasharray={`${dash} ${circ}`}
          strokeLinecap="round"
          style={{ transition: 'stroke-dasharray 0.4s ease' }}
        />
      </svg>
      <div className="mt-[-68px] flex flex-col items-center">
        <span className="text-2xl font-bold text-white">{score}</span>
        <span className="text-[10px] text-slate-500">/10</span>
      </div>
      <div className="mt-4 text-xs font-bold px-2 py-1 rounded" style={{ color, background: color + '20' }}>
        {label}
      </div>
    </div>
  )
}

function PriceRow({
  label,
  value,
  sub,
  accent,
  badge,
  badgeColor,
  highlight,
}: {
  label: string
  value: string
  sub?: string
  accent?: string
  badge?: string
  badgeColor?: string
  highlight?: boolean
}) {
  return (
    <div className={`flex items-center justify-between p-3 rounded-lg ${highlight ? 'bg-slate-700/50 border border-slate-600/60' : 'bg-slate-900/40'}`}>
      <div>
        <div className="text-xs text-slate-500">{label}</div>
        {sub && <div className="text-[10px] text-slate-600 mt-0.5">{sub}</div>}
      </div>
      <div className="flex items-center gap-2">
        {badge && (
          <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${badgeColor}`}>{badge}</span>
        )}
        <span className={`text-base font-bold tabular-nums ${accent ?? 'text-white'}`}>{value}</span>
      </div>
    </div>
  )
}

// ─── Tab 1: Trade Planner Calculator ─────────────────────────────────────────

function TradePlannerTab() {
  const [premium, setPremium] = useState(150)
  const [lots, setLots] = useState(2)
  const [capital, setCapital] = useState(200000)
  const [slPct, setSlPct] = useState(20)
  const [direction, setDirection] = useState<'CE' | 'PE'>('CE')

  const plan = calcPlan(premium, lots, capital, slPct)

  const isViable = plan.max_loss_pct <= 2 && plan.rr_t1 >= 1.0
  const tooRisky = plan.max_loss_pct > 3

  return (
    <div className="space-y-5">
      {/* Input panel */}
      <div className="bg-slate-800/60 border border-slate-700/60 rounded-xl p-5">
        <div className="text-sm font-semibold text-slate-300 mb-4">📥 Trade Inputs</div>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
          {/* Direction */}
          <div className="col-span-2 sm:col-span-3">
            <label className="text-xs text-slate-500 mb-2 block">Direction</label>
            <div className="flex gap-2">
              {(['CE', 'PE'] as const).map(d => (
                <button
                  key={d}
                  onClick={() => setDirection(d)}
                  className={`flex-1 py-2.5 rounded-lg font-bold text-sm border transition-colors ${
                    direction === d
                      ? d === 'CE'
                        ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/50'
                        : 'bg-rose-500/20 text-rose-300 border-rose-500/50'
                      : 'bg-slate-900/60 text-slate-400 border-slate-700 hover:border-slate-500'
                  }`}
                >
                  {d === 'CE' ? '📈 BUY CALL (CE) — Bullish' : '📉 BUY PUT (PE) — Bearish'}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="text-xs text-slate-500 mb-1.5 block">Option Premium (₹)</label>
            <input
              type="number" value={premium} onChange={e => setPremium(+e.target.value)}
              step={5} min={20}
              className="w-full bg-slate-900/60 border border-slate-700 rounded-lg px-3 py-2.5 text-white text-sm focus:border-brand-500 outline-none"
            />
            <div className="text-[10px] text-slate-600 mt-1">1 lot = ₹{fmt(premium * 65)}</div>
          </div>
          <div>
            <label className="text-xs text-slate-500 mb-1.5 block">Number of Lots</label>
            <input
              type="number" value={lots} onChange={e => setLots(+e.target.value)}
              step={1} min={1} max={25}
              className="w-full bg-slate-900/60 border border-slate-700 rounded-lg px-3 py-2.5 text-white text-sm focus:border-brand-500 outline-none"
            />
            <div className="text-[10px] text-slate-600 mt-1">= {lots * 65} units</div>
          </div>
          <div>
            <label className="text-xs text-slate-500 mb-1.5 block">Trading Capital (₹)</label>
            <input
              type="number" value={capital} onChange={e => setCapital(+e.target.value)}
              step={50000}
              className="w-full bg-slate-900/60 border border-slate-700 rounded-lg px-3 py-2.5 text-white text-sm focus:border-brand-500 outline-none"
            />
          </div>
          <div className="col-span-2 sm:col-span-3">
            <label className="text-xs text-slate-500 mb-1.5 block">
              Stop Loss: <span className="text-white font-bold">{slPct}%</span> of premium
              <span className="text-slate-600 ml-2">= ₹{(premium * slPct / 100).toFixed(1)} below entry</span>
            </label>
            <div className="flex items-center gap-3">
              <input
                type="range" min={10} max={35} step={5} value={slPct}
                onChange={e => setSlPct(+e.target.value)}
                className="flex-1 accent-brand-500"
              />
              <div className="flex gap-1">
                {[15, 20, 25, 30].map(v => (
                  <button key={v} onClick={() => setSlPct(v)}
                    className={`px-2 py-1 rounded text-xs border ${slPct === v ? 'bg-brand-600/20 text-brand-400 border-brand-600/40' : 'bg-slate-900/60 text-slate-500 border-slate-700'}`}>
                    {v}%
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Risk alert */}
      {tooRisky && (
        <div className="bg-red-500/15 border border-red-500/40 rounded-xl p-4 flex items-start gap-3">
          <span className="text-xl">🚨</span>
          <div>
            <div className="font-bold text-red-300">This trade risks {plan.max_loss_pct.toFixed(1)}% of capital — too high!</div>
            <div className="text-sm text-slate-400 mt-1">
              Reduce to <strong className="text-white">{Math.floor(capital * 0.02 / (premium * slPct / 100 * 65))} lots</strong> to keep risk under 2%.
              At {lots} lots you risk ₹{fmt(plan.max_loss_rs)} on a single trade.
            </div>
          </div>
        </div>
      )}

      {/* Main price levels */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Left: levels */}
        <div className="bg-slate-800/60 border border-slate-700/60 rounded-xl overflow-hidden">
          <div className="p-3 border-b border-slate-700/60 text-xs text-slate-500 uppercase tracking-widest">
            Price Levels — {lots} Lot{lots > 1 ? 's' : ''} ({lots * 65} units)
          </div>
          <div className="p-3 space-y-2">
            <PriceRow
              label="Entry Premium"
              value={`₹${premium.toFixed(1)}`}
              sub={`Total cost: ₹${fmt(plan.cost_total)}`}
              highlight
            />
            <PriceRow
              label="Breakeven (after charges)"
              value={`₹${plan.breakeven_premium.toFixed(1)}`}
              sub={`Charges: ₹${plan.charges.toFixed(0)} · need +₹${(plan.breakeven_premium - premium).toFixed(1)}`}
              accent="text-amber-400"
            />
            <div className="border-t border-slate-700/40 my-1" />
            <PriceRow
              label="🛑 STOP LOSS"
              value={`₹${plan.sl_premium.toFixed(1)}`}
              sub={`−₹${(premium - plan.sl_premium).toFixed(1)} pts = ₹${fmt(plan.max_loss_rs)} loss (${plan.max_loss_pct.toFixed(1)}% capital)`}
              accent="text-rose-400"
              badge="EXIT HERE"
              badgeColor="bg-rose-500/20 text-rose-400 border border-rose-500/30"
            />
            <div className="border-t border-slate-700/40 my-1" />
            <PriceRow
              label="🎯 Target 1 (exit 50%)"
              value={`₹${plan.t1_premium.toFixed(1)}`}
              sub={`+₹${(plan.t1_premium - premium).toFixed(1)} pts = ₹${fmt(plan.t1_profit)} · R:R ${plan.rr_t1.toFixed(2)}`}
              accent="text-emerald-400"
              badge={`R:R ${plan.rr_t1.toFixed(1)}`}
              badgeColor="bg-emerald-500/10 text-emerald-400 border border-emerald-500/25"
            />
            <PriceRow
              label="🎯 Target 2 (exit 40%)"
              value={`₹${plan.t2_premium.toFixed(1)}`}
              sub={`+₹${(plan.t2_premium - premium).toFixed(1)} pts = ₹${fmt(plan.t2_profit)} · R:R ${plan.rr_t2.toFixed(2)}`}
              accent="text-emerald-400"
              badge={`R:R ${plan.rr_t2.toFixed(1)}`}
              badgeColor="bg-emerald-500/10 text-emerald-400 border border-emerald-500/25"
            />
            <PriceRow
              label="🚀 Target 3 (exit 10%, runner)"
              value={`₹${plan.t3_premium.toFixed(1)}`}
              sub={`+₹${(plan.t3_premium - premium).toFixed(1)} pts = ₹${fmt(plan.t3_profit)}`}
              accent="text-sky-400"
            />
          </div>
        </div>

        {/* Right: risk summary + trade management */}
        <div className="space-y-3">
          {/* Risk/reward visual */}
          <div className="bg-slate-800/60 border border-slate-700/60 rounded-xl p-4">
            <div className="text-xs text-slate-500 mb-3 uppercase tracking-widest">Risk vs Reward</div>
            <div className="space-y-2">
              <div>
                <div className="flex justify-between text-xs mb-1">
                  <span className="text-rose-400">Max Loss (SL hit)</span>
                  <span className="text-rose-400 font-bold">−₹{fmt(plan.max_loss_rs)}</span>
                </div>
                <div className="h-3 bg-rose-500/60 rounded-full" style={{ width: '100%' }} />
              </div>
              <div>
                <div className="flex justify-between text-xs mb-1">
                  <span className="text-emerald-400">Target 1 profit</span>
                  <span className="text-emerald-400 font-bold">+₹{fmt(plan.t1_profit)}</span>
                </div>
                <div className="h-3 bg-emerald-500/60 rounded-full"
                  style={{ width: `${Math.min(200, (plan.t1_profit / plan.max_loss_rs) * 100)}%` }} />
              </div>
              <div>
                <div className="flex justify-between text-xs mb-1">
                  <span className="text-emerald-400">Target 2 profit</span>
                  <span className="text-emerald-400 font-bold">+₹{fmt(plan.t2_profit)}</span>
                </div>
                <div className="h-3 bg-emerald-500/40 rounded-full"
                  style={{ width: `${Math.min(200, (plan.t2_profit / plan.max_loss_rs) * 100)}%` }} />
              </div>
            </div>
          </div>

          {/* Exit plan */}
          <div className="bg-slate-800/60 border border-slate-700/60 rounded-xl p-4">
            <div className="text-xs text-slate-500 mb-3 uppercase tracking-widest">Exact Exit Plan</div>
            <div className="space-y-2 text-xs">
              {[
                {
                  trigger: 'Premium ≤ ₹' + plan.sl_premium.toFixed(0),
                  action: 'IMMEDIATE market exit — full position',
                  type: 'SL',
                  tc: 'text-rose-400',
                  bc: 'bg-rose-500/10 border-rose-500/25',
                },
                {
                  trigger: '90 seconds elapsed, no profit',
                  action: 'Exit at market — time SL, no exceptions',
                  type: 'TIME',
                  tc: 'text-amber-400',
                  bc: 'bg-amber-500/10 border-amber-500/25',
                },
                {
                  trigger: 'Premium = ₹' + plan.t1_premium.toFixed(0),
                  action: `Exit 50% (${Math.round(lots * 0.5)} lots). Move SL to entry (₹${premium})`,
                  type: 'T1',
                  tc: 'text-emerald-400',
                  bc: 'bg-emerald-500/10 border-emerald-500/25',
                },
                {
                  trigger: 'Premium = ₹' + plan.t2_premium.toFixed(0),
                  action: 'Exit 40% more. Trail SL to T1 level',
                  type: 'T2',
                  tc: 'text-emerald-400',
                  bc: 'bg-emerald-500/10 border-emerald-500/25',
                },
                {
                  trigger: '2:30 PM (EOD)',
                  action: 'Exit ALL positions. No overnight options.',
                  type: 'EOD',
                  tc: 'text-sky-400',
                  bc: 'bg-sky-500/10 border-sky-500/25',
                },
              ].map(item => (
                <div key={item.type} className={`flex items-start gap-2 p-2 rounded border ${item.bc}`}>
                  <span className={`text-[10px] font-bold mt-0.5 ${item.tc}`}>{item.type}</span>
                  <div>
                    <span className={`font-medium ${item.tc}`}>{item.trigger}</span>
                    <span className="text-slate-400"> → {item.action}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Go/No-go */}
          <div className={`rounded-xl p-4 border text-center ${isViable
            ? 'bg-emerald-500/10 border-emerald-500/30'
            : 'bg-rose-500/10 border-rose-500/30'}`}>
            <div className={`text-2xl font-bold ${isViable ? 'text-emerald-400' : 'text-rose-400'}`}>
              {isViable ? '✅ VIABLE TRADE' : '❌ SKIP THIS TRADE'}
            </div>
            <div className="text-xs text-slate-400 mt-1">
              {isViable
                ? `Risk ${plan.max_loss_pct.toFixed(1)}% of capital · R:R ${plan.rr_t1.toFixed(2)} at T1`
                : tooRisky
                  ? `Risk too high: ${plan.max_loss_pct.toFixed(1)}% — max allowed 2%`
                  : `R:R ${plan.rr_t1.toFixed(2)} too low — need ≥ 1.0`}
            </div>
          </div>
        </div>
      </div>

      {/* Charge summary */}
      <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-4">
        <div className="text-xs text-slate-500 mb-3 uppercase tracking-widest">Charges Breakdown (this trade)</div>
        <div className="grid grid-cols-3 sm:grid-cols-5 gap-3 text-center text-xs">
          {[
            { label: 'Brokerage', value: '₹40' },
            { label: 'STT (0.1%)', value: `₹${(premium * lots * 65 * 0.001).toFixed(0)}` },
            { label: 'Exchange', value: `₹${(premium * lots * 65 * 2 * 0.00053).toFixed(0)}` },
            { label: 'GST', value: `₹${((40 + premium * lots * 65 * 2 * 0.00053) * 0.18).toFixed(0)}` },
            { label: 'Total', value: `₹${plan.charges.toFixed(0)}`, bold: true },
          ].map(item => (
            <div key={item.label} className="bg-slate-900/60 rounded-lg p-2">
              <div className={`font-bold ${item.bold ? 'text-rose-400 text-base' : 'text-slate-300'}`}>{item.value}</div>
              <div className="text-slate-600 mt-0.5">{item.label}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

// ─── Tab 2: Setup Score ───────────────────────────────────────────────────────

function SetupScoreTab() {
  const [scores, setScores] = useState<SetupScore>({ time: -1, trend: -1, vwap: -1, level: -1, volume: -1 } as unknown as SetupScore)
  const [expanded, setExpanded] = useState<string | null>('time')

  const total = Object.values(scores).filter(v => v >= 0).reduce((s, v) => s + v, 0)
  const answered = Object.values(scores).filter(v => v >= 0).length
  const allAnswered = answered === 5

  const canTrade = allAnswered && total >= 8
  const marginal = allAnswered && total >= 6 && total < 8
  const skip = allAnswered && total < 6
  const hasZero = Object.values(scores).some(v => v === 0)

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-6 flex-wrap">
        {/* Score ring */}
        <div className="bg-slate-800/60 border border-slate-700/60 rounded-xl p-6 flex flex-col items-center min-w-[140px]">
          <ScoreRing score={total} />
          <div className="text-xs text-slate-500 mt-3 text-center">
            {answered}/5 answered
          </div>
          {hasZero && allAnswered && (
            <div className="text-[10px] text-rose-400 text-center mt-1 font-medium">
              ⚠️ Zero on any factor = skip
            </div>
          )}
        </div>

        {/* Score guide */}
        <div className="flex-1 min-w-[200px] space-y-2">
          <div className="text-xs text-slate-500 uppercase tracking-widest mb-2">Score Guide</div>
          {[
            { range: '9–10', label: 'High Conviction Trade', sub: 'All stars aligned. Execute with full size.', color: 'text-emerald-400', bg: 'bg-emerald-500/8 border-emerald-500/25' },
            { range: '7–8', label: 'Good Setup', sub: 'Minor imperfection. Trade at ½ normal lot size.', color: 'text-lime-400', bg: 'bg-lime-500/8 border-lime-500/25' },
            { range: '5–6', label: 'Marginal Setup', sub: 'Missing key confirmations. Skip or paper trade.', color: 'text-amber-400', bg: 'bg-amber-500/8 border-amber-500/25' },
            { range: '0–4', label: 'Skip This Trade', sub: 'Random entry. This is where your losses come from.', color: 'text-rose-400', bg: 'bg-rose-500/8 border-rose-500/25' },
          ].map(item => (
            <div key={item.range} className={`flex items-center gap-3 p-2.5 rounded-lg border text-xs ${item.bg}`}>
              <span className={`font-bold w-8 text-center ${item.color}`}>{item.range}</span>
              <div>
                <div className={`font-medium ${item.color}`}>{item.label}</div>
                <div className="text-slate-500">{item.sub}</div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Score factors */}
      <div className="space-y-2">
        {SCORE_FACTORS.map(factor => {
          const val = scores[factor.key]
          const isOpen = expanded === factor.key
          return (
            <div
              key={factor.key}
              className={`rounded-xl border overflow-hidden transition-colors ${
                val === 0 ? 'border-rose-500/40' :
                val === 1 ? 'border-amber-500/40' :
                val === 2 ? 'border-emerald-500/40' :
                'border-slate-700/60'
              } bg-slate-800/60`}
            >
              <button
                className="w-full flex items-center gap-3 p-4 text-left"
                onClick={() => setExpanded(isOpen ? null : factor.key)}
              >
                <span className="text-lg">{factor.icon}</span>
                <div className="flex-1">
                  <div className="font-medium text-slate-200 text-sm">{factor.label}</div>
                  {val >= 0 && (
                    <div className={`text-xs mt-0.5 ${val === 0 ? 'text-rose-400' : val === 1 ? 'text-amber-400' : 'text-emerald-400'}`}>
                      {factor.options.find(o => o.val === val)?.label}
                    </div>
                  )}
                </div>
                <div className={`text-lg font-bold w-8 text-center ${val < 0 ? 'text-slate-600' : val === 0 ? 'text-rose-400' : val === 1 ? 'text-amber-400' : 'text-emerald-400'}`}>
                  {val < 0 ? '?' : val === 0 ? '0' : `+${val}`}
                </div>
                <span className="text-slate-600 text-xs">{isOpen ? '▲' : '▼'}</span>
              </button>

              {isOpen && (
                <div className="px-4 pb-4 space-y-2 border-t border-slate-700/40 pt-3">
                  <div className="text-xs text-slate-500 italic mb-3">{factor.tip}</div>
                  {factor.options.map(opt => (
                    <button
                      key={opt.val}
                      onClick={() => {
                        setScores(prev => ({ ...prev, [factor.key]: opt.val }))
                        // auto-advance to next unanswered
                        const keys = SCORE_FACTORS.map(f => f.key)
                        const idx = keys.indexOf(factor.key)
                        const next = keys.slice(idx + 1).find(k => (scores[k] as number) < 0)
                        if (next) setExpanded(next)
                        else setExpanded(null)
                      }}
                      className={`w-full text-left flex items-center gap-3 p-3 rounded-lg border transition-colors text-sm ${
                        val === opt.val
                          ? opt.color === 'emerald' ? 'bg-emerald-500/15 border-emerald-500/50 text-emerald-300'
                          : opt.color === 'amber' ? 'bg-amber-500/15 border-amber-500/50 text-amber-300'
                          : 'bg-rose-500/15 border-rose-500/50 text-rose-300'
                          : 'bg-slate-900/40 border-slate-700/60 text-slate-400 hover:border-slate-500'
                      }`}
                    >
                      <span className={`text-xs font-bold w-4 ${
                        opt.color === 'emerald' ? 'text-emerald-400' :
                        opt.color === 'amber' ? 'text-amber-400' : 'text-rose-400'
                      }`}>+{opt.val}</span>
                      <span>{opt.label}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </div>

      {/* Final verdict */}
      {allAnswered && (
        <div className={`rounded-xl p-5 border text-center ${
          canTrade && !hasZero ? 'bg-emerald-500/10 border-emerald-500/40' :
          hasZero ? 'bg-red-500/15 border-red-500/40' :
          marginal ? 'bg-amber-500/10 border-amber-500/40' :
          'bg-rose-500/10 border-rose-500/40'
        }`}>
          <div className={`text-3xl font-bold mb-2 ${
            canTrade && !hasZero ? 'text-emerald-400' :
            hasZero ? 'text-red-400' :
            marginal ? 'text-amber-400' : 'text-rose-400'
          }`}>
            {hasZero ? '🚫 DISQUALIFIED' : canTrade ? '✅ TAKE THE TRADE' : marginal ? '⚠️ MARGINAL — SKIP' : '❌ DO NOT TRADE'}
          </div>
          <div className="text-sm text-slate-400">
            {hasZero
              ? 'A zero score on any factor is an automatic disqualification. One bad condition destroys your edge.'
              : canTrade
                ? `Score ${total}/10 — All key conditions confirmed. Execute your trade plan.`
                : marginal
                  ? `Score ${total}/10 — Missing ${8 - total} point(s) of conviction. Wait for a cleaner setup.`
                  : `Score ${total}/10 — Too many weak signals. This trade has no edge. Protect your capital.`}
          </div>
          {!hasZero && canTrade && (
            <div className="text-xs text-emerald-400/70 mt-2">→ Now go to Trade Planner to calculate your exact SL / Target</div>
          )}
          {allAnswered && (
            <button
              onClick={() => setScores({ time: -1, trend: -1, vwap: -1, level: -1, volume: -1 } as unknown as SetupScore)}
              className="mt-3 text-xs text-slate-500 hover:text-slate-300 border border-slate-700 px-3 py-1 rounded-lg"
            >
              Reset for next trade
            </button>
          )}
        </div>
      )}
    </div>
  )
}

// ─── Tab 3: Live Trade Monitor ────────────────────────────────────────────────

function LiveMonitorTab() {
  const [entry, setEntry] = useState(150)
  const [current, setCurrent] = useState(150)
  const [lots, setLots] = useState(2)
  const [slPct, setSlPct] = useState(20)
  const [entryTime, setEntryTime] = useState(nowTimeStr())
  const [elapsedSec, setElapsedSec] = useState(0)
  const [running, setRunning] = useState(false)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const sl = entry * (1 - slPct / 100)
  const t1 = entry + (entry - sl) * 1.5
  const t2 = entry + (entry - sl) * 2.5
  const units = lots * 65
  const charges = calcCharges(entry, lots)

  const pnl = (current - entry) * units - charges
  const pnlPts = current - entry
  const distSL = current - sl
  const distT1 = t1 - current
  const pnlPct = (pnlPts / entry) * 100

  const hitSL = current <= sl
  const hitT1 = current >= t1
  const hitT2 = current >= t2

  const startTimer = useCallback(() => {
    setRunning(true)
    setElapsedSec(0)
    const now = nowTimeStr()
    setEntryTime(now)
    timerRef.current = setInterval(() => {
      setElapsedSec(s => s + 1)
    }, 1000)
  }, [])

  const stopTimer = useCallback(() => {
    setRunning(false)
    if (timerRef.current) clearInterval(timerRef.current)
  }, [])

  useEffect(() => () => { if (timerRef.current) clearInterval(timerRef.current) }, [])

  const timeAlert = elapsedSec >= 90 && !hitT1
  const mins = Math.floor(elapsedSec / 60)
  const secs = elapsedSec % 60

  // Exit decision
  let exitDecision = { label: '', color: '', action: '', urgency: 0 }
  if (hitSL) {
    exitDecision = { label: '🚨 SL HIT — EXIT NOW', color: 'text-red-400', action: 'Market sell ALL lots immediately. No averaging, no waiting.', urgency: 4 }
  } else if (timeAlert && pnl < 0) {
    exitDecision = { label: '⏱️ TIME SL — EXIT NOW', color: 'text-red-400', action: '90 seconds passed with no profit. Exit at market NOW.', urgency: 4 }
  } else if (timeAlert && pnl >= 0) {
    exitDecision = { label: '⏰ 90s — Monitor closely', color: 'text-amber-400', action: 'Profitable at 90s — trail SL to entry. Let T1 run.', urgency: 2 }
  } else if (hitT2) {
    exitDecision = { label: '🚀 T2 HIT — Exit 90%', color: 'text-emerald-400', action: 'Exit 90% of position. Hold 10% with SL at T1.', urgency: 1 }
  } else if (hitT1) {
    exitDecision = { label: '🎯 T1 HIT — Partial Exit', color: 'text-emerald-400', action: 'Exit 50% now. Move SL to entry for remaining 50%.', urgency: 1 }
  } else if (pnlPct < -10) {
    exitDecision = { label: '⚠️ Approaching SL', color: 'text-rose-400', action: `${((current - sl) / entry * 100).toFixed(1)}% away from SL. Stay alert.`, urgency: 3 }
  } else if (pnlPct > 0) {
    exitDecision = { label: '✅ In Profit — Hold', color: 'text-emerald-400', action: 'Trade working. Hold until T1. SL stays at original level.', urgency: 0 }
  } else {
    exitDecision = { label: '⏳ Neutral — Watch', color: 'text-slate-400', action: 'Within normal range. No action. Set timer alert.', urgency: 0 }
  }

  return (
    <div className="space-y-4">
      {/* Setup */}
      <div className="bg-slate-800/60 border border-slate-700/60 rounded-xl p-5">
        <div className="text-sm font-semibold text-slate-300 mb-4">🎯 Trade Setup</div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-4">
          <div>
            <label className="text-xs text-slate-500 mb-1.5 block">Entry Premium (₹)</label>
            <input type="number" value={entry} onChange={e => setEntry(+e.target.value)} step={1}
              className="w-full bg-slate-900/60 border border-slate-700 rounded-lg px-3 py-2 text-white text-sm focus:border-brand-500 outline-none" />
          </div>
          <div>
            <label className="text-xs text-slate-500 mb-1.5 block">Current Premium (₹)</label>
            <input type="number" value={current} onChange={e => setCurrent(+e.target.value)} step={0.5}
              className={`w-full bg-slate-900/60 border rounded-lg px-3 py-2 text-sm focus:outline-none ${
                current <= sl ? 'border-red-500/60 text-red-400' :
                current >= t1 ? 'border-emerald-500/60 text-emerald-400' :
                'border-slate-700 text-white'
              }`} />
          </div>
          <div>
            <label className="text-xs text-slate-500 mb-1.5 block">Lots</label>
            <input type="number" value={lots} onChange={e => setLots(+e.target.value)} min={1}
              className="w-full bg-slate-900/60 border border-slate-700 rounded-lg px-3 py-2 text-white text-sm focus:border-brand-500 outline-none" />
          </div>
          <div>
            <label className="text-xs text-slate-500 mb-1.5 block">SL%</label>
            <input type="number" value={slPct} onChange={e => setSlPct(+e.target.value)} min={10} max={35} step={5}
              className="w-full bg-slate-900/60 border border-slate-700 rounded-lg px-3 py-2 text-white text-sm focus:border-brand-500 outline-none" />
          </div>
        </div>

        {/* Timer */}
        <div className="flex items-center gap-3">
          <button
            onClick={running ? stopTimer : startTimer}
            className={`px-4 py-2 rounded-lg text-sm font-bold border transition-colors ${
              running
                ? 'bg-rose-500/20 text-rose-300 border-rose-500/40 hover:bg-rose-500/30'
                : 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40 hover:bg-emerald-500/30'
            }`}
          >
            {running ? '⏹ Stop Timer' : '▶ Start 90s Timer'}
          </button>
          {running && (
            <div className={`font-mono text-2xl font-bold tabular-nums ${timeAlert ? 'text-red-400 animate-pulse' : 'text-white'}`}>
              {String(mins).padStart(2, '0')}:{String(secs).padStart(2, '0')}
            </div>
          )}
          {running && (
            <div className="flex-1 h-2 bg-slate-700 rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full transition-all ${elapsedSec >= 90 ? 'bg-red-500' : elapsedSec >= 60 ? 'bg-amber-500' : 'bg-emerald-500'}`}
                style={{ width: `${Math.min(100, (elapsedSec / 90) * 100)}%` }}
              />
            </div>
          )}
          {!running && elapsedSec > 0 && (
            <span className="text-xs text-slate-500">Last: {mins}m {secs}s</span>
          )}
        </div>
      </div>

      {/* Live P&L dashboard */}
      <div className={`rounded-xl p-5 border ${pnlBg(pnl, true)}`}>
        <div className="flex items-center justify-between mb-4">
          <div className="text-xs text-slate-500 uppercase tracking-widest">Live P&L</div>
          <div className={`text-3xl font-bold tabular-nums ${pnlColor(pnl)}`}>
            {pnl >= 0 ? '+' : ''}₹{fmt(pnl)}
          </div>
        </div>
        <div className="grid grid-cols-3 gap-3 text-center text-xs">
          <div className="bg-slate-900/40 rounded-lg p-2">
            <div className={`text-base font-bold tabular-nums ${pnlColor(pnlPts)}`}>
              {pnlPts >= 0 ? '+' : ''}{pnlPts.toFixed(1)}
            </div>
            <div className="text-slate-500">pts move</div>
          </div>
          <div className="bg-slate-900/40 rounded-lg p-2">
            <div className={`text-base font-bold tabular-nums ${pnlColor(pnlPct)}`}>
              {pnlPct >= 0 ? '+' : ''}{pnlPct.toFixed(1)}%
            </div>
            <div className="text-slate-500">% move</div>
          </div>
          <div className="bg-slate-900/40 rounded-lg p-2">
            <div className={`text-base font-bold tabular-nums ${distSL < (entry * 0.05) ? 'text-rose-400' : 'text-slate-300'}`}>
              ₹{distSL.toFixed(1)}
            </div>
            <div className="text-slate-500">to SL</div>
          </div>
        </div>
      </div>

      {/* Level progress bar */}
      <div className="bg-slate-800/60 border border-slate-700/60 rounded-xl p-4">
        <div className="text-xs text-slate-500 mb-3 uppercase tracking-widest">Position on Range</div>
        <div className="relative h-8 bg-slate-900/60 rounded-lg overflow-hidden">
          {/* SL zone */}
          <div className="absolute top-0 bottom-0 bg-rose-500/25 left-0" style={{ width: '15%' }} />
          {/* T1 zone */}
          <div className="absolute top-0 bottom-0 bg-emerald-500/15 right-0" style={{ width: '30%' }} />
          {/* Marker labels */}
          <div className="absolute inset-0 flex items-center px-2 text-[9px] font-mono justify-between">
            <span className="text-rose-400">SL ₹{sl.toFixed(0)}</span>
            <span className="text-amber-400">Entry ₹{entry}</span>
            <span className="text-emerald-400">T1 ₹{t1.toFixed(0)}</span>
            <span className="text-emerald-400">T2 ₹{t2.toFixed(0)}</span>
          </div>
          {/* Current price needle */}
          {(() => {
            const range = t2 - sl
            const pos = Math.max(2, Math.min(98, ((current - sl) / range) * 100))
            return (
              <div
                className={`absolute top-0 bottom-0 w-0.5 ${
                  current <= sl ? 'bg-red-500' : current >= t1 ? 'bg-emerald-500' : 'bg-white'
                }`}
                style={{ left: `${pos}%` }}
              >
                <div className={`absolute -top-1 left-1/2 -translate-x-1/2 text-[8px] font-bold whitespace-nowrap ${
                  current <= sl ? 'text-red-400' : current >= t1 ? 'text-emerald-400' : 'text-white'
                }`}>▼ ₹{current}</div>
              </div>
            )
          })()}
        </div>
      </div>

      {/* Exit decision */}
      <div className={`rounded-xl p-5 border ${
        exitDecision.urgency >= 4 ? 'bg-red-500/15 border-red-500/50 animate-pulse' :
        exitDecision.urgency === 3 ? 'bg-rose-500/10 border-rose-500/35' :
        exitDecision.urgency === 2 ? 'bg-amber-500/10 border-amber-500/35' :
        exitDecision.urgency === 1 ? 'bg-emerald-500/10 border-emerald-500/35' :
        'bg-slate-800/60 border-slate-700/60'
      }`}>
        <div className={`text-xl font-bold mb-2 ${exitDecision.color}`}>{exitDecision.label}</div>
        <div className="text-sm text-slate-300">{exitDecision.action}</div>
      </div>
    </div>
  )
}

// ─── Tab 4: Tight Strategy Summary ───────────────────────────────────────────

function TightStrategyTab() {
  return (
    <div className="space-y-4">
      {/* Core concept */}
      <div className="bg-slate-800/60 border border-brand-600/30 rounded-xl p-5">
        <div className="font-bold text-white text-lg mb-1">🎯 The Minimum-Loss Scalp Framework</div>
        <div className="text-slate-400 text-sm">
          Every rule below exists to answer one question:{' '}
          <strong className="text-white">"How do I keep losses small and let winners run?"</strong>
          Based on your trade data, losses happened because entries were random, SLs were missing, and exits were emotional.
        </div>
      </div>

      {/* The 3 pillars */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        {[
          {
            icon: '🛡️', title: 'Tight Entry Filter',
            points: ['Score ≥ 8 / 10', 'No zero on any factor', 'At key level only', '10 AM – 2:30 PM only'],
            color: 'border-sky-500/35 bg-sky-500/5',
            why: 'Fewer trades = fewer losses. Quality over quantity.',
          },
          {
            icon: '✂️', title: 'Automatic SL',
            points: ['20% of premium — hard rule', '90-second time SL', 'No widening, ever', 'Exit first, think later'],
            color: 'border-rose-500/35 bg-rose-500/5',
            why: 'Small losses stay small. Big losses start as "just wait a minute".',
          },
          {
            icon: '📤', title: 'Disciplined Exit',
            points: ['T1 at 1.5× risk: exit 50%', 'Move SL to entry after T1', 'T2 at 2.5× risk: exit 40%', 'No re-entry same strike'],
            color: 'border-emerald-500/35 bg-emerald-500/5',
            why: 'Lock profits immediately. Never give back a winning trade.',
          },
        ].map(p => (
          <div key={p.title} className={`rounded-xl border p-4 ${p.color}`}>
            <div className="text-2xl mb-2">{p.icon}</div>
            <div className="font-bold text-slate-200 mb-3">{p.title}</div>
            <ul className="space-y-1.5 mb-3">
              {p.points.map(pt => (
                <li key={pt} className="text-xs text-slate-400 flex items-start gap-1.5">
                  <span className="text-slate-600 mt-0.5">›</span>{pt}
                </li>
              ))}
            </ul>
            <div className="text-[11px] text-slate-500 italic border-t border-slate-700/40 pt-2">{p.why}</div>
          </div>
        ))}
      </div>

      {/* Decision flowchart */}
      <div className="bg-slate-800/60 border border-slate-700/60 rounded-xl overflow-hidden">
        <div className="p-4 border-b border-slate-700/60 font-semibold text-slate-200">
          📊 Before Every Trade — Decision Flow
        </div>
        <div className="p-5 space-y-2">
          {[
            {
              q: 'Is it between 10:00 AM and 2:30 PM?',
              y: 'Continue ✓', n: 'STOP. Come back at 10 AM.',
              yi: 'text-emerald-400', ni: 'text-rose-400',
            },
            {
              q: 'Is Setup Score ≥ 8/10 (no zeros)?',
              y: 'Continue ✓', n: 'SKIP. Wait for better setup.',
              yi: 'text-emerald-400', ni: 'text-rose-400',
            },
            {
              q: 'Is Max Loss ≤ 2% of capital with correct lot size?',
              y: 'Continue ✓', n: 'REDUCE LOTS until it is ≤ 2%.',
              yi: 'text-emerald-400', ni: 'text-amber-400',
            },
            {
              q: 'Have I had 2+ consecutive losses today?',
              y: 'STOP for 30 minutes. Reset.', n: 'Continue ✓',
              yi: 'text-rose-400', ni: 'text-emerald-400',
            },
            {
              q: 'Have I hit my daily profit target (2× daily loss limit)?',
              y: 'STOP for the day. Protect profits.', n: 'Continue ✓',
              yi: 'text-amber-400', ni: 'text-emerald-400',
            },
            {
              q: 'Is entry level clearly defined with a natural SL?',
              y: '✅ ENTER THE TRADE', n: 'Wait. Unclear entries = losses.',
              yi: 'text-emerald-400 font-bold text-base', ni: 'text-rose-400',
            },
          ].map((item, i) => (
            <div key={i} className="grid grid-cols-[auto_1fr_auto_auto] gap-2 items-center bg-slate-900/40 rounded-lg p-3">
              <span className="text-xs font-bold text-slate-600 w-5">{i + 1}</span>
              <span className="text-sm text-slate-300">{item.q}</span>
              <span className={`text-xs font-medium px-2 py-1 bg-emerald-500/10 rounded ${item.yi}`}>Y: {item.y}</span>
              <span className={`text-xs font-medium px-2 py-1 bg-rose-500/10 rounded ${item.ni}`}>N: {item.n}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Recovery protocol */}
      <div className="bg-amber-500/8 border border-amber-500/25 rounded-xl p-5">
        <div className="font-semibold text-amber-300 mb-3">🔄 After-Loss Recovery Protocol</div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-sm">
          {[
            { trigger: 'After 1 loss', action: '30-min break. Walk away from screen. Do not watch your last trade.', icon: '1️⃣' },
            { trigger: 'After 2 consecutive losses', action: 'Stop trading for the day. Review what went wrong. Reduce lot size tomorrow.', icon: '2️⃣' },
            { trigger: 'After losing ≥2% of capital', action: 'Hard stop for the day. No exceptions. Capital protection > everything.', icon: '🛑' },
          ].map(item => (
            <div key={item.trigger} className="bg-slate-900/40 rounded-lg p-3">
              <div className="text-lg mb-1">{item.icon}</div>
              <div className="font-medium text-amber-300 text-xs mb-1">{item.trigger}</div>
              <div className="text-slate-400 text-xs">{item.action}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Quick reference card */}
      <div className="bg-slate-900/60 border border-slate-600/40 rounded-xl p-4">
        <div className="text-xs text-slate-500 mb-3 uppercase tracking-widest">📌 Quick Reference Card — Screenshot & Keep</div>
        <div className="grid grid-cols-2 gap-2 text-xs font-mono">
          {[
            ['Trading hours', '10:00 AM – 2:30 PM'],
            ['Min setup score', '8 / 10 (no zeros)'],
            ['SL %', '20% of premium paid'],
            ['Time SL', '90 seconds'],
            ['T1 (exit 50%)', 'Entry + (1.5 × SL pts)'],
            ['T2 (exit 40%)', 'Entry + (2.5 × SL pts)'],
            ['Max risk/trade', '2% of capital'],
            ['Max lots (start)', '1–2 lots only'],
            ['After T1', 'Move SL to entry'],
            ['Max trades/day', '3 setups only'],
            ['Consecutive loss', 'Stop after 2nd loss'],
            ['Daily loss limit', '2% of capital'],
          ].map(([k, v]) => (
            <div key={k} className="flex justify-between bg-slate-800/60 rounded px-2 py-1.5">
              <span className="text-slate-500">{k}</span>
              <span className="text-white font-bold">{v}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

// ─── Main Page ────────────────────────────────────────────────────────────────

type Tab = 'planner' | 'score' | 'monitor' | 'strategy'

export default function TradePlanner() {
  const [tab, setTab] = useState<Tab>('planner')

  const TABS: { id: Tab; label: string; sub: string }[] = [
    { id: 'planner', label: '🧮 Trade Planner', sub: 'Entry · SL · Targets' },
    { id: 'score', label: '🎯 Setup Score', sub: '5-factor filter' },
    { id: 'monitor', label: '📡 Live Monitor', sub: 'P&L + exit signals' },
    { id: 'strategy', label: '📋 Tight Strategy', sub: 'Full framework' },
  ]

  return (
    <div className="min-h-screen bg-slate-950 text-slate-200 p-4 md:p-6">
      <div className="max-w-4xl mx-auto space-y-5">

        {/* Header */}
        <div>
          <h1 className="text-2xl font-bold text-white">📐 Trade Planner & Entry Calculator</h1>
          <p className="text-slate-400 text-sm mt-1">
            Calculate exact SL / Targets · Score your setup · Monitor live P&L · Apply tight exit rules
          </p>
        </div>

        {/* Tab bar */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 bg-slate-900/60 p-1.5 rounded-xl border border-slate-800">
          {TABS.map(t => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`px-3 py-2.5 rounded-lg text-sm transition-colors text-center ${
                tab === t.id
                  ? 'bg-brand-600/20 text-brand-400 border border-brand-600/30'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
              }`}
            >
              <div className="font-medium">{t.label}</div>
              <div className="text-[10px] opacity-60">{t.sub}</div>
            </button>
          ))}
        </div>

        {tab === 'planner' && <TradePlannerTab />}
        {tab === 'score' && <SetupScoreTab />}
        {tab === 'monitor' && <LiveMonitorTab />}
        {tab === 'strategy' && <TightStrategyTab />}
      </div>
    </div>
  )
}
