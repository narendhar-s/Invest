import { useState, useCallback } from 'react'

// ─── Types ────────────────────────────────────────────────────────────────────

interface Gate {
  id: number
  label: string
  question: string
  bullAnswer: string
  bearAnswer: string
  why: string
  icon: string
}

interface CheckState {
  [gateId: number]: 'bull' | 'bear' | 'none' | null
}

// ─── Constants ────────────────────────────────────────────────────────────────

const GATES: Gate[] = [
  {
    id: 1,
    label: 'Time Window',
    question: 'Is it between 10:00 AM and 2:30 PM?',
    bullAnswer: 'Yes → proceed',
    bearAnswer: 'No → DO NOT TRADE',
    why: 'Your 9:15–9:59 window has 43% WR and costs ₹12,266. Best hours: 10–11 AM and 1–3 PM.',
    icon: '⏰',
  },
  {
    id: 2,
    label: '15-Min Trend',
    question: 'On the 15-min chart, is EMA9 above EMA21?',
    bullAnswer: 'Yes → CE bias (buy calls)',
    bearAnswer: 'No → PE bias (buy puts)',
    why: 'The 15-min EMA alignment defines the session trend. Never fight the trend. Trend trades win 80%+ of the time.',
    icon: '📈',
  },
  {
    id: 3,
    label: 'VWAP Side',
    question: 'Is NIFTY price on the correct side of VWAP?',
    bullAnswer: 'Above VWAP → confirms CE',
    bearAnswer: 'Below VWAP → confirms PE',
    why: 'VWAP is the institutional price anchor. Buying calls below VWAP is fighting institutions. Wait for VWAP confirmation.',
    icon: '🎯',
  },
  {
    id: 4,
    label: 'Key Level',
    question: 'Is price at a clear support/resistance, PDH/PDL, or CPR level?',
    bullAnswer: 'At support → buy CE bounce',
    bearAnswer: 'At resistance → buy PE rejection',
    why: 'Entries near key levels give you natural SL placement. Random middle-of-range entries have no edge.',
    icon: '🏗️',
  },
  {
    id: 5,
    label: 'Volume Confirmation',
    question: 'Is the current 5-min candle volume > 1.5× average of last 10 candles?',
    bullAnswer: 'Yes → confirms breakout/breakdown',
    bearAnswer: 'No → wait for volume',
    why: 'Low-volume moves are traps. High volume = institutional participation = follow-through. No volume = fake move.',
    icon: '📊',
  },
]

const PRE_TRADE_STEPS = [
  {
    step: 1,
    time: '9:00 AM',
    title: 'Check Pre-Market Setup',
    tasks: [
      'Open NSE India → check SGX Nifty gap (up/down/flat)',
      'Check US market close (S&P500, VIX)',
      'Scan for major news: RBI, FII data, global events',
      'Write down expected bias: Bullish / Bearish / Neutral',
    ],
    icon: '🌅',
    color: 'border-sky-500/40 bg-sky-500/5',
  },
  {
    step: 2,
    time: '9:15 AM',
    title: 'Mark Your Levels — NEVER Trade Yet',
    tasks: [
      'Mark PDH (Previous Day High) and PDL (Previous Day Low)',
      'Mark weekly high and weekly low',
      'Mark round numbers: 23800, 23900, 24000, 24100...',
      'Mark CPR (Central Pivot Range) — top, pivot, bottom',
      'Set price alerts at each level (do not watch screen)',
    ],
    icon: '📐',
    color: 'border-violet-500/40 bg-violet-500/5',
  },
  {
    step: 3,
    time: '9:15–10:00',
    title: 'Observe — No Trading Allowed',
    tasks: [
      'Watch how market opens — gap up/down fill or extension?',
      'Note where NIFTY finds first support or resistance',
      'Track VWAP: is price above or below?',
      'See if opening range breaks above or below 9:15–9:30 candle high/low',
      'HANDS OFF. Just observe and learn the day\'s character.',
    ],
    icon: '👁️',
    color: 'border-amber-500/40 bg-amber-500/5',
    alert: '⚠️ NO TRADES in this window — 43% WR, kills your day',
  },
  {
    step: 4,
    time: '10:00 AM',
    title: 'Identify the Setup',
    tasks: [
      'Check 15-min chart: Is EMA9 above or below EMA21?',
      'Is price above or below VWAP?',
      'Both agree → strong bias. Disagreement → wait for alignment.',
      'Identify the nearest KEY level to trade (S/R, CPR, PDH/PDL)',
      'Write your plan: "I will buy CE at [level] if [condition]"',
    ],
    icon: '🎯',
    color: 'border-emerald-500/40 bg-emerald-500/5',
  },
  {
    step: 5,
    time: 'Before Entry',
    title: 'Run the 5-Gate Check',
    tasks: [
      'Gate 1: Time 10:00–14:30? ✓',
      'Gate 2: 15-min EMA9/21 aligned with trade direction? ✓',
      'Gate 3: Price on correct side of VWAP? ✓',
      'Gate 4: At a key level (not in middle of range)? ✓',
      'Gate 5: Volume > 1.5× average on entry candle? ✓',
      'ALL 5 GREEN → enter. Even 1 red → skip this trade.',
    ],
    icon: '🚦',
    color: 'border-rose-500/40 bg-rose-500/5',
  },
  {
    step: 6,
    time: 'At Entry',
    title: 'Execute with Precision',
    tasks: [
      'Buy limit order at the close of the confirmation 5-min candle',
      'Immediately set SL: 25% below premium paid (e.g., paid ₹100 → SL at ₹75)',
      'Identify T1 = 40% profit, T2 = 70% profit',
      'Set a 2-minute timer on your phone',
      'If 2 minutes pass and premium is flat/losing → EXIT',
    ],
    icon: '⚡',
    color: 'border-brand-500/40 bg-brand-500/5',
  },
  {
    step: 7,
    time: 'Trade Management',
    title: 'Manage with Rules — Not Emotions',
    tasks: [
      'T1 hit: exit 50% of position, move SL to entry (cost-free)',
      'T2 hit: exit remaining 50%',
      'If SL hit: close laptop, take a 30-min walk',
      'Never add lots after SL hit on same strike',
      'Max 3 trades per day. After 2 losses → stop for the day.',
    ],
    icon: '🛡️',
    color: 'border-slate-500/40 bg-slate-500/5',
  },
]

// ─── Lot Size Calculator ──────────────────────────────────────────────────────

function LotSizeCalculator() {
  const [capital, setCapital] = useState(200000)
  const [premium, setPremium] = useState(150)
  const [riskPct, setRiskPct] = useState(2)
  const [slPct, setSlPct] = useState(25)

  const maxRisk = capital * riskPct / 100
  const slPerUnit = premium * slPct / 100
  const slPerLot = slPerUnit * 65
  const maxLots = Math.max(1, Math.floor(maxRisk / slPerLot))
  const lotCost = premium * 65
  const totalCost = maxLots * lotCost
  const totalRisk = maxLots * slPerLot

  // Charges estimate for this trade
  const brokerage = 20 * 2 // buy + sell
  const stt = (maxLots * 65 * premium) * 0.001 // on sell side
  const exchange = (maxLots * 65 * premium * 2) * 0.00053
  const gst = (brokerage + exchange) * 0.18
  const totalCharges = brokerage + stt + exchange + gst

  const breakeven = totalCharges / (maxLots * 65)
  const targetMinPts = breakeven + (premium * 0.40)

  return (
    <div className="bg-slate-800/60 border border-slate-700/60 rounded-xl overflow-hidden">
      <div className="p-4 border-b border-slate-700/60 flex items-center gap-2">
        <span className="text-lg">🧮</span>
        <div>
          <div className="font-semibold text-slate-200">Lot Size Calculator</div>
          <div className="text-xs text-slate-500">2% risk rule · includes charges</div>
        </div>
      </div>
      <div className="p-5 space-y-5">
        {/* Inputs */}
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="text-xs text-slate-500 mb-1.5 block">Capital (₹)</label>
            <input
              type="number"
              value={capital}
              onChange={e => setCapital(Number(e.target.value))}
              className="w-full bg-slate-900/60 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:border-brand-500 outline-none"
              step="50000"
            />
          </div>
          <div>
            <label className="text-xs text-slate-500 mb-1.5 block">Option Premium (₹)</label>
            <input
              type="number"
              value={premium}
              onChange={e => setPremium(Number(e.target.value))}
              className="w-full bg-slate-900/60 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:border-brand-500 outline-none"
              step="10"
            />
          </div>
          <div>
            <label className="text-xs text-slate-500 mb-1.5 block">Risk per Trade: {riskPct}%</label>
            <input
              type="range" min={1} max={5} step={0.5} value={riskPct}
              onChange={e => setRiskPct(Number(e.target.value))}
              className="w-full accent-brand-500"
            />
          </div>
          <div>
            <label className="text-xs text-slate-500 mb-1.5 block">SL% of Premium: {slPct}%</label>
            <input
              type="range" min={15} max={40} step={5} value={slPct}
              onChange={e => setSlPct(Number(e.target.value))}
              className="w-full accent-brand-500"
            />
          </div>
        </div>

        {/* Results */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div className="bg-brand-600/10 border border-brand-600/30 rounded-lg p-3 text-center">
            <div className="text-2xl font-bold text-brand-400">{maxLots}</div>
            <div className="text-xs text-slate-500 mt-0.5">Max Lots</div>
          </div>
          <div className="bg-slate-900/40 border border-slate-700/60 rounded-lg p-3 text-center">
            <div className="text-lg font-bold text-white">₹{(totalCost/1000).toFixed(0)}k</div>
            <div className="text-xs text-slate-500 mt-0.5">Premium Cost</div>
          </div>
          <div className="bg-rose-500/10 border border-rose-500/25 rounded-lg p-3 text-center">
            <div className="text-lg font-bold text-rose-400">₹{totalRisk.toFixed(0)}</div>
            <div className="text-xs text-slate-500 mt-0.5">Max Loss (SL hit)</div>
          </div>
          <div className="bg-amber-500/10 border border-amber-500/25 rounded-lg p-3 text-center">
            <div className="text-lg font-bold text-amber-400">₹{totalCharges.toFixed(0)}</div>
            <div className="text-xs text-slate-500 mt-0.5">Charges (round-trip)</div>
          </div>
        </div>

        {/* Breakeven alert */}
        <div className="bg-slate-900/60 rounded-lg p-3 space-y-1.5 text-xs">
          <div className="flex justify-between">
            <span className="text-slate-500">Breakeven premium move</span>
            <span className="text-amber-400 font-bold">+₹{breakeven.toFixed(1)} pts needed just for charges</span>
          </div>
          <div className="flex justify-between">
            <span className="text-slate-500">Min target to be worthwhile (T1)</span>
            <span className="text-emerald-400 font-bold">₹{targetMinPts.toFixed(0)} premium (+{((targetMinPts/premium)*100).toFixed(0)}%)</span>
          </div>
          <div className="flex justify-between">
            <span className="text-slate-500">SL level if entered at ₹{premium}</span>
            <span className="text-rose-400 font-bold">₹{(premium - slPerUnit).toFixed(0)} ({slPct}% stop)</span>
          </div>
        </div>

        {maxLots > 5 && (
          <div className="bg-rose-500/10 border border-rose-500/30 rounded-lg p-3 text-xs text-rose-300">
            ⚠️ <strong>Warning:</strong> Your calculator says {maxLots} lots, but start with <strong>max 3 lots</strong> until you achieve 75%+ WR consistently for 20+ trades.
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Gate Checker ─────────────────────────────────────────────────────────────

function GateChecker() {
  const [answers, setAnswers] = useState<CheckState>({})
  const [direction, setDirection] = useState<'CE' | 'PE' | null>(null)

  const setAnswer = useCallback((gateId: number, val: 'bull' | 'bear' | 'none') => {
    setAnswers(prev => ({ ...prev, [gateId]: val }))
  }, [])

  const answered = Object.keys(answers).length
  const gatesOpen = GATES.filter(g => {
    const a = answers[g.id]
    if (!a || a === 'none') return false
    return true
  }).length

  const allOpen = GATES.every(g => answers[g.id] === 'bull' || answers[g.id] === 'bear')
  const hasBlock = answers[1] === 'none' // time gate blocked

  const bullCount = Object.values(answers).filter(v => v === 'bull').length
  const bearCount = Object.values(answers).filter(v => v === 'bear').length

  const canTrade = allOpen && !hasBlock && (bullCount >= 4 || bearCount >= 4)
  const suggestedDir = bullCount >= bearCount ? 'CE' : 'PE'

  const reset = () => { setAnswers({}); setDirection(null) }

  return (
    <div className="bg-slate-800/60 border border-slate-700/60 rounded-xl overflow-hidden">
      <div className="p-4 border-b border-slate-700/60 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-lg">🚦</span>
          <div>
            <div className="font-semibold text-slate-200">Live 5-Gate Pre-Trade Check</div>
            <div className="text-xs text-slate-500">Answer all 5 before every trade</div>
          </div>
        </div>
        {answered > 0 && (
          <button onClick={reset} className="text-xs text-slate-500 hover:text-slate-300 border border-slate-700 px-2 py-1 rounded">
            Reset
          </button>
        )}
      </div>

      <div className="divide-y divide-slate-800/60">
        {GATES.map(gate => {
          const ans = answers[gate.id]
          const isBlocked = gate.id > 1 && answers[1] === 'none'
          return (
            <div
              key={gate.id}
              className={`p-4 transition-all ${
                isBlocked ? 'opacity-30 pointer-events-none' :
                ans === 'bull' ? 'bg-emerald-500/5' :
                ans === 'bear' ? 'bg-rose-500/5' :
                ans === 'none' ? 'bg-red-500/10' : ''
              }`}
            >
              <div className="flex items-start gap-3">
                <div className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold flex-shrink-0 ${
                  ans === 'bull' || ans === 'bear' ? 'bg-emerald-500/20 text-emerald-400' :
                  ans === 'none' ? 'bg-red-500/20 text-red-400' :
                  'bg-slate-700 text-slate-400'
                }`}>
                  {ans ? (ans === 'none' ? '✗' : '✓') : gate.id}
                </div>
                <div className="flex-1">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-sm">{gate.icon}</span>
                    <span className="font-medium text-slate-200 text-sm">Gate {gate.id}: {gate.label}</span>
                  </div>
                  <div className="text-sm text-slate-300 mb-3">{gate.question}</div>
                  <div className="flex gap-2 flex-wrap mb-2">
                    <button
                      onClick={() => setAnswer(gate.id, 'bull')}
                      className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                        ans === 'bull'
                          ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/50'
                          : 'bg-slate-900/60 text-slate-400 border-slate-700 hover:border-emerald-500/50 hover:text-emerald-400'
                      }`}
                    >
                      ✓ {gate.bullAnswer}
                    </button>
                    <button
                      onClick={() => setAnswer(gate.id, 'bear')}
                      className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                        ans === 'bear'
                          ? 'bg-rose-500/20 text-rose-300 border-rose-500/50'
                          : 'bg-slate-900/60 text-slate-400 border-slate-700 hover:border-rose-500/50 hover:text-rose-400'
                      }`}
                    >
                      ✓ {gate.bearAnswer}
                    </button>
                    {gate.id === 1 && (
                      <button
                        onClick={() => setAnswer(gate.id, 'none')}
                        className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                          ans === 'none'
                            ? 'bg-red-500/20 text-red-300 border-red-500/50'
                            : 'bg-slate-900/60 text-slate-400 border-slate-700 hover:border-red-500/50 hover:text-red-400'
                        }`}
                      >
                        ✗ Not in window → NO TRADE
                      </button>
                    )}
                  </div>
                  <div className="text-xs text-slate-500 italic">{gate.why}</div>
                </div>
              </div>
            </div>
          )
        })}
      </div>

      {/* Result */}
      {allOpen && (
        <div className={`p-5 border-t ${canTrade ? 'bg-emerald-500/10 border-emerald-500/30' : 'bg-rose-500/10 border-rose-500/30'}`}>
          {canTrade ? (
            <div className="text-center">
              <div className="text-2xl mb-2">✅</div>
              <div className="font-bold text-emerald-300 text-lg">ALL GATES OPEN — Setup Confirmed</div>
              <div className="text-emerald-400 text-sm mt-1">
                Suggested direction: <strong>Buy {suggestedDir === 'CE' ? '📈 CALL (CE)' : '📉 PUT (PE)'}</strong>
              </div>
              <div className="text-slate-400 text-xs mt-2">Now apply lot size calculator and set SL before entering</div>
            </div>
          ) : (
            <div className="text-center">
              <div className="text-2xl mb-2">❌</div>
              <div className="font-bold text-rose-300 text-lg">Mixed Signals — DO NOT TRADE</div>
              <div className="text-slate-400 text-sm mt-1">
                {bullCount} bullish, {bearCount} bearish signals. Wait for confluence before entering.
              </div>
            </div>
          )}
        </div>
      )}

      {hasBlock && answers[1] === 'none' && (
        <div className="p-5 bg-red-500/10 border-t border-red-500/30 text-center">
          <div className="text-2xl mb-2">🚫</div>
          <div className="font-bold text-red-300">Outside Trading Window</div>
          <div className="text-slate-400 text-sm mt-1">Close the app. Return at 10:00 AM.</div>
        </div>
      )}
    </div>
  )
}

// ─── Charges Calculator ───────────────────────────────────────────────────────

function ChargesBreakdown() {
  const [lots, setLots] = useState(2)
  const [premium, setPremium] = useState(150)
  const [tradesPerDay, setTradesPerDay] = useState(3)

  const premiumValue = lots * 65 * premium

  // Per trade round-trip
  const brokerage = 40 // ₹20 buy + ₹20 sell
  const stt = premiumValue * 0.001
  const exchange = premiumValue * 2 * 0.00053
  const gst = (brokerage + exchange) * 0.18
  const stamp = premiumValue * 0.00003
  const sebi = premiumValue * 2 * 0.0000001
  const perTrade = brokerage + stt + exchange + gst + stamp + sebi

  const perDay = perTrade * tradesPerDay
  const perMonth = perDay * 20 // 20 trading days

  // Comparison: current (11.9 lots avg) vs new (user's lots)
  const currentAvgLots = 11.9
  const currentAvgTrades = 11 // from analysis
  const currentPerTrade = 40 + (currentAvgLots * 65 * premium * 0.001) + (currentAvgLots * 65 * premium * 2 * 0.00053) + 3
  const currentPerDay = currentPerTrade * currentAvgTrades

  return (
    <div className="bg-slate-800/60 border border-slate-700/60 rounded-xl overflow-hidden">
      <div className="p-4 border-b border-slate-700/60 flex items-center gap-2">
        <span className="text-lg">💸</span>
        <div>
          <div className="font-semibold text-slate-200">Charges Impact Calculator</div>
          <div className="text-xs text-slate-500">See how charges eat your profits</div>
        </div>
      </div>

      {/* Alert */}
      <div className="p-4 bg-rose-500/10 border-b border-rose-500/20">
        <div className="text-sm font-bold text-rose-300 mb-1">🚨 Your data shows: Charges ate 62.5% of your gross profits</div>
        <div className="text-xs text-slate-400">
          Gross P&L: <span className="text-emerald-400">₹59,896</span> ·
          Charges paid: <span className="text-rose-400">₹37,414</span> ·
          Net kept: <span className="text-white">₹22,482</span>
        </div>
        <div className="text-xs text-slate-500 mt-1">Avg: 11.9 lots/trade, 11 trades/day. That's ₹331 in charges per round-trip.</div>
      </div>

      <div className="p-5 space-y-5">
        <div className="grid grid-cols-3 gap-4">
          <div>
            <label className="text-xs text-slate-500 mb-1.5 block">Lots per Trade</label>
            <input
              type="number" min={1} max={25} value={lots}
              onChange={e => setLots(Number(e.target.value))}
              className="w-full bg-slate-900/60 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:border-brand-500 outline-none"
            />
          </div>
          <div>
            <label className="text-xs text-slate-500 mb-1.5 block">Avg Premium (₹)</label>
            <input
              type="number" min={50} max={500} step={10} value={premium}
              onChange={e => setPremium(Number(e.target.value))}
              className="w-full bg-slate-900/60 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:border-brand-500 outline-none"
            />
          </div>
          <div>
            <label className="text-xs text-slate-500 mb-1.5 block">Trades/Day</label>
            <input
              type="number" min={1} max={20} value={tradesPerDay}
              onChange={e => setTradesPerDay(Number(e.target.value))}
              className="w-full bg-slate-900/60 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:border-brand-500 outline-none"
            />
          </div>
        </div>

        {/* Breakdown table */}
        <div className="space-y-2">
          <div className="text-xs text-slate-500 uppercase tracking-widest">Per Trade Charges (round-trip)</div>
          {[
            { label: 'Brokerage (₹20 × 2)', value: brokerage, color: 'text-slate-300' },
            { label: 'STT (0.1% on sell side)', value: stt, color: 'text-rose-400' },
            { label: 'Exchange charges (0.053%)', value: exchange, color: 'text-amber-400' },
            { label: 'GST (18% on brokerage+exchange)', value: gst, color: 'text-slate-400' },
            { label: 'Stamp duty + SEBI', value: stamp + sebi, color: 'text-slate-500' },
          ].map(item => (
            <div key={item.label} className="flex justify-between text-sm">
              <span className="text-slate-500">{item.label}</span>
              <span className={`font-mono font-medium ${item.color}`}>₹{item.value.toFixed(0)}</span>
            </div>
          ))}
          <div className="border-t border-slate-700/60 pt-2 flex justify-between font-bold">
            <span className="text-slate-300">Total per trade</span>
            <span className="text-rose-400 font-mono">₹{perTrade.toFixed(0)}</span>
          </div>
        </div>

        {/* Daily/Monthly */}
        <div className="grid grid-cols-3 gap-3">
          <div className="bg-slate-900/40 rounded-lg p-3 text-center">
            <div className="text-sm font-bold text-rose-400">₹{perTrade.toFixed(0)}</div>
            <div className="text-xs text-slate-500">Per Trade</div>
          </div>
          <div className="bg-slate-900/40 rounded-lg p-3 text-center">
            <div className="text-sm font-bold text-rose-400">₹{perDay.toFixed(0)}</div>
            <div className="text-xs text-slate-500">Per Day ({tradesPerDay} trades)</div>
          </div>
          <div className="bg-slate-900/40 rounded-lg p-3 text-center">
            <div className="text-sm font-bold text-rose-400">₹{(perMonth/1000).toFixed(1)}k</div>
            <div className="text-xs text-slate-500">Per Month</div>
          </div>
        </div>

        {/* Comparison */}
        <div className="bg-slate-900/40 rounded-lg p-4">
          <div className="text-xs text-slate-500 mb-3 uppercase tracking-widest">Your current vs. disciplined approach</div>
          <div className="space-y-2 text-sm">
            <div className="flex justify-between items-center">
              <span className="text-slate-400">Current (11.9 lots, 11 trades/day)</span>
              <span className="text-rose-400 font-bold">₹{currentPerDay.toFixed(0)}/day</span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-slate-400">{lots} lots, {tradesPerDay} trades/day</span>
              <span className="text-emerald-400 font-bold">₹{perDay.toFixed(0)}/day</span>
            </div>
            <div className="flex justify-between items-center border-t border-slate-700/60 pt-2 font-bold">
              <span className="text-emerald-300">Daily savings in charges</span>
              <span className="text-emerald-400">₹{(currentPerDay - perDay).toFixed(0)}/day</span>
            </div>
          </div>
        </div>

        {/* Tips */}
        <div className="space-y-2">
          <div className="text-xs text-slate-500 uppercase tracking-widest">How to reduce charges</div>
          {[
            { tip: 'Trade fewer lots (2–3 max)', impact: 'STT drops by 80%+', icon: '📉' },
            { tip: 'Trade fewer times/day (3 quality vs 11 random)', impact: 'Saves ₹2,000+/day in charges', icon: '🎯' },
            { tip: 'Use limit orders, not market orders', impact: 'Saves slippage (₹5–15 per lot)', icon: '📋' },
            { tip: 'Target bigger moves (40%+ premium profit)', impact: 'Charges become < 5% of profit', icon: '💰' },
            { tip: 'Avoid churning same strike multiple times', impact: 'Each re-entry pays full charges again', icon: '🔄' },
          ].map(item => (
            <div key={item.tip} className="flex items-start gap-2 text-xs bg-emerald-500/5 border border-emerald-500/15 rounded-lg p-2.5">
              <span>{item.icon}</span>
              <div>
                <span className="text-emerald-300 font-medium">{item.tip}</span>
                <span className="text-slate-500"> — {item.impact}</span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

// ─── Win Rate Strategy ────────────────────────────────────────────────────────

function WinRateStrategy() {
  return (
    <div className="space-y-5">
      {/* Strategy overview */}
      <div className="bg-slate-800/60 border border-brand-600/30 rounded-xl p-5">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 bg-brand-600/20 rounded-xl flex items-center justify-center text-xl">🏆</div>
          <div>
            <div className="font-bold text-white text-lg">The 5-Gate NIFTY Scalp System</div>
            <div className="text-xs text-slate-500">Target: 80%+ Win Rate · 1:1.5 R:R · 3 trades/day max</div>
          </div>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-5">
          {[
            { label: 'Target WR', value: '80%+', color: 'text-emerald-400' },
            { label: 'R:R Ratio', value: '1 : 1.5', color: 'text-brand-400' },
            { label: 'Max Lots', value: '2–3', color: 'text-amber-400' },
            { label: 'Max Trades', value: '3/day', color: 'text-sky-400' },
          ].map(item => (
            <div key={item.label} className="bg-slate-900/60 rounded-lg p-3 text-center">
              <div className={`text-xl font-bold ${item.color}`}>{item.value}</div>
              <div className="text-xs text-slate-500 mt-0.5">{item.label}</div>
            </div>
          ))}
        </div>

        <div className="text-sm text-slate-400 leading-relaxed">
          Based on your trade data: your <strong className="text-white">edge is in &lt; 2-min holds</strong> with 80% WR.
          The 5-Gate system only enters when all conditions align — similar to how your 10:00 AM window (100% WR) worked.
          By filtering to only high-confluence setups, you eliminate the random trades that have sub-50% WR.
        </div>
      </div>

      {/* Entry rules */}
      <div className="bg-slate-800/60 border border-slate-700/60 rounded-xl overflow-hidden">
        <div className="p-4 border-b border-slate-700/60 font-semibold text-slate-200">📋 Entry Rules (all must be true)</div>
        <div className="divide-y divide-slate-800/60">
          {[
            { rule: 'Time', detail: '10:00 AM to 2:30 PM only. No trades in first 45 min or last 30 min.', tag: 'FILTER', tc: 'text-sky-400' },
            { rule: 'Bias', detail: '15-min EMA9 > EMA21 → bullish (CE only). 15-min EMA9 < EMA21 → bearish (PE only). Mixed = wait.', tag: 'TREND', tc: 'text-violet-400' },
            { rule: 'VWAP', detail: 'Price > VWAP = CE trades only. Price < VWAP = PE trades only. At VWAP = skip.', tag: 'ANCHOR', tc: 'text-emerald-400' },
            { rule: 'Level', detail: 'Entry only at: PDH/PDL retest, CPR top/bottom, round numbers (23800, 24000). No mid-range entries.', tag: 'LEVEL', tc: 'text-amber-400' },
            { rule: 'Volume', detail: 'Entry candle volume must be > 1.5× the 10-candle average. Low volume = trap.', tag: 'CONFIRM', tc: 'text-rose-400' },
          ].map(item => (
            <div key={item.rule} className="flex items-start gap-3 p-4">
              <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded border flex-shrink-0 mt-0.5 ${
                item.tc === 'text-sky-400' ? 'bg-sky-500/10 border-sky-500/30 text-sky-400' :
                item.tc === 'text-violet-400' ? 'bg-violet-500/10 border-violet-500/30 text-violet-400' :
                item.tc === 'text-emerald-400' ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400' :
                item.tc === 'text-amber-400' ? 'bg-amber-500/10 border-amber-500/30 text-amber-400' :
                'bg-rose-500/10 border-rose-500/30 text-rose-400'
              }`}>{item.tag}</span>
              <div>
                <span className="font-medium text-slate-200 text-sm">{item.rule}: </span>
                <span className="text-sm text-slate-400">{item.detail}</span>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* SL and Target rules */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="bg-rose-500/8 border border-rose-500/25 rounded-xl p-5">
          <div className="font-semibold text-rose-300 mb-3">🛑 Stop Loss Rules</div>
          <div className="space-y-2 text-sm text-slate-300">
            <div className="flex gap-2"><span className="text-rose-400 font-bold">→</span> SL = 25% of premium paid (hard rule)</div>
            <div className="flex gap-2"><span className="text-rose-400 font-bold">→</span> <span>Time SL: if no profit in <strong>90 seconds</strong>, exit at market</span></div>
            <div className="flex gap-2"><span className="text-rose-400 font-bold">→</span> Never move SL away from entry (no widening)</div>
            <div className="flex gap-2"><span className="text-rose-400 font-bold">→</span> After SL hit: 30-min mandatory break, no re-entry same strike</div>
            <div className="mt-3 text-xs text-rose-400/70 italic">
              Example: Bought at ₹150 → SL at ₹112 (₹38 loss × 65 × 2 lots = ₹4,940)
            </div>
          </div>
        </div>
        <div className="bg-emerald-500/8 border border-emerald-500/25 rounded-xl p-5">
          <div className="font-semibold text-emerald-300 mb-3">🎯 Target & Exit Rules</div>
          <div className="space-y-2 text-sm text-slate-300">
            <div className="flex gap-2"><span className="text-emerald-400 font-bold">→</span> T1 = +40% on premium (exit 50% of position)</div>
            <div className="flex gap-2"><span className="text-emerald-400 font-bold">→</span> Move SL to entry after T1 (trade is now risk-free)</div>
            <div className="flex gap-2"><span className="text-emerald-400 font-bold">→</span> T2 = +70% on premium (exit remaining 50%)</div>
            <div className="flex gap-2"><span className="text-emerald-400 font-bold">→</span> After 2 winning trades → stop for the day (protect profits)</div>
            <div className="mt-3 text-xs text-emerald-400/70 italic">
              Example: Bought at ₹150 → T1 at ₹210 (+₹60), T2 at ₹255 (+₹105)
            </div>
          </div>
        </div>
      </div>

      {/* Win rate improvement levers */}
      <div className="bg-slate-800/60 border border-slate-700/60 rounded-xl overflow-hidden">
        <div className="p-4 border-b border-slate-700/60 font-semibold text-slate-200">📈 Win Rate Improvement — Ranked by Impact</div>
        <div className="divide-y divide-slate-800/60">
          {[
            {
              rank: 1,
              title: 'Stop trading before 10:00 AM',
              impact: '+15–20% WR',
              detail: 'Your 9:15–9:59 WR is 43%. Your 10:00 AM WR is 100%. Just wait 45 minutes.',
              effort: 'Easy',
              ec: 'text-emerald-400',
            },
            {
              rank: 2,
              title: 'Exit within 90 seconds if in loss',
              impact: '+10–15% WR',
              detail: '< 2 min trades: 80% WR. 2–10 min: 19% WR. Your edge disappears fast.',
              effort: 'Medium',
              ec: 'text-amber-400',
            },
            {
              rank: 3,
              title: 'Only trade at key levels (PDH/PDL, CPR)',
              impact: '+10% WR',
              detail: 'Trades from key levels have defined SL placement. Random entries = random results.',
              effort: 'Medium',
              ec: 'text-amber-400',
            },
            {
              rank: 4,
              title: 'Wait for volume confirmation',
              impact: '+8% WR',
              detail: 'High volume breakouts continue 80% of the time. Low volume breakouts fail 70%.',
              effort: 'Medium',
              ec: 'text-amber-400',
            },
            {
              rank: 5,
              title: 'Stop after 2 consecutive losses',
              impact: 'Saves capital',
              detail: 'Your consecutive loss runs lead to revenge trading and blowout days. Hard stop prevents this.',
              effort: 'Hard',
              ec: 'text-rose-400',
            },
            {
              rank: 6,
              title: 'Never re-enter same strike after a loss',
              impact: 'Eliminates revenge trades',
              detail: 'Every same-strike re-entry in your data after a loss also lost. The market doesn\'t owe you back your money.',
              effort: 'Hard',
              ec: 'text-rose-400',
            },
            {
              rank: 7,
              title: 'Reduce lots to 2–3 max',
              impact: 'Psychological edge',
              detail: 'Smaller positions = less emotion = better decisions = higher WR. High lots cause panic exits and bad decisions.',
              effort: 'Medium',
              ec: 'text-amber-400',
            },
          ].map(item => (
            <div key={item.rank} className="flex items-start gap-4 p-4">
              <div className="w-7 h-7 bg-slate-700/60 rounded-full flex items-center justify-center text-xs font-bold text-slate-400 flex-shrink-0">
                {item.rank}
              </div>
              <div className="flex-1">
                <div className="flex items-center gap-3 flex-wrap mb-1">
                  <span className="font-medium text-slate-200 text-sm">{item.title}</span>
                  <span className={`text-xs font-bold px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-400`}>{item.impact}</span>
                  <span className={`text-xs ml-auto ${item.ec}`}>{item.effort} to implement</span>
                </div>
                <div className="text-xs text-slate-500">{item.detail}</div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Lot size table */}
      <div className="bg-slate-800/60 border border-slate-700/60 rounded-xl overflow-hidden">
        <div className="p-4 border-b border-slate-700/60 font-semibold text-slate-200">📏 Lot Size by Capital (2% Risk Rule)</div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs text-slate-500 border-b border-slate-700/60">
                <th className="text-left p-3 pl-4">Capital</th>
                <th className="text-center p-3">Max Risk/Trade</th>
                <th className="text-center p-3">At ₹100 Premium</th>
                <th className="text-center p-3">At ₹150 Premium</th>
                <th className="text-center p-3">At ₹200 Premium</th>
                <th className="text-right p-3 pr-4">Daily Loss Limit</th>
              </tr>
            </thead>
            <tbody>
              {[
                { cap: '₹50,000', risk: '₹1,000', l100: '1', l150: '1', l200: '1', dll: '₹2,000' },
                { cap: '₹1,00,000', risk: '₹2,000', l100: '1', l150: '1', l200: '1', dll: '₹4,000' },
                { cap: '₹2,00,000', risk: '₹4,000', l100: '2', l150: '1', l200: '1', dll: '₹8,000' },
                { cap: '₹5,00,000', risk: '₹10,000', l100: '4', l150: '2', l200: '2', dll: '₹20,000' },
                { cap: '₹10,00,000', risk: '₹20,000', l100: '8', l150: '5', l200: '3', dll: '₹40,000' },
              ].map((row, i) => (
                <tr key={i} className="border-b border-slate-800/60 hover:bg-slate-700/20">
                  <td className="p-3 pl-4 font-bold text-slate-200">{row.cap}</td>
                  <td className="p-3 text-center text-rose-400">{row.risk}</td>
                  <td className="p-3 text-center text-brand-400 font-bold">{row.l100} lot</td>
                  <td className="p-3 text-center text-brand-400 font-bold">{row.l150} lot</td>
                  <td className="p-3 text-center text-brand-400 font-bold">{row.l200} lot</td>
                  <td className="p-3 pr-4 text-right text-amber-400">{row.dll}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="p-4 bg-amber-500/8 border-t border-amber-500/20 text-xs text-amber-300">
          ⚠️ <strong>Rule:</strong> SL assumed at 25% of premium. Lot size = floor(MaxRisk ÷ (SL% × Premium × 65)).
          Start with <strong>1 lot</strong> regardless of capital until you hit 75%+ WR over 20+ trades.
          Scale lots only after proving your edge.
        </div>
      </div>
    </div>
  )
}

// ─── Main Page ────────────────────────────────────────────────────────────────

type Tab = 'strategy' | 'gates' | 'lots' | 'charges' | 'steps'

export default function TradingEdge() {
  const [tab, setTab] = useState<Tab>('strategy')

  const TABS: { id: Tab; label: string }[] = [
    { id: 'strategy', label: '🏆 Strategy & WR' },
    { id: 'gates', label: '🚦 Pre-Trade Check' },
    { id: 'steps', label: '📋 Step-by-Step' },
    { id: 'lots', label: '🧮 Lot Size Calc' },
    { id: 'charges', label: '💸 Charges Impact' },
  ]

  return (
    <div className="min-h-screen bg-slate-950 text-slate-200 p-4 md:p-6">
      <div className="max-w-5xl mx-auto space-y-6">

        {/* Header */}
        <div className="text-center pt-2">
          <h1 className="text-3xl font-bold text-white mb-2">⚡ Trading Edge Improvement</h1>
          <p className="text-slate-400 text-sm">5-Gate System · Lot Size Rules · Charges Reduction · Step-by-Step Process</p>
          <div className="flex justify-center gap-6 mt-4 text-sm">
            <div className="text-center">
              <div className="text-2xl font-bold text-emerald-400">80%+</div>
              <div className="text-xs text-slate-500">Target WR</div>
            </div>
            <div className="text-center">
              <div className="text-2xl font-bold text-brand-400">1:1.5</div>
              <div className="text-xs text-slate-500">Target R:R</div>
            </div>
            <div className="text-center">
              <div className="text-2xl font-bold text-amber-400">3</div>
              <div className="text-xs text-slate-500">Max Trades/Day</div>
            </div>
            <div className="text-center">
              <div className="text-2xl font-bold text-rose-400">62%↓</div>
              <div className="text-xs text-slate-500">Charges Reduction</div>
            </div>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex flex-wrap gap-1 bg-slate-900/60 p-1 rounded-xl border border-slate-800">
          {TABS.map(t => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors flex-1 sm:flex-none ${
                tab === t.id
                  ? 'bg-brand-600/20 text-brand-400 border border-brand-600/30'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* Tab Content */}
        {tab === 'strategy' && <WinRateStrategy />}

        {tab === 'gates' && (
          <div className="space-y-4">
            <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl p-4 text-sm text-amber-300">
              💡 <strong>Use this checklist before EVERY trade.</strong> If any gate fails → no trade.
              This filter alone should take your win rate from 70% to 80%+.
            </div>
            <GateChecker />
          </div>
        )}

        {tab === 'steps' && (
          <div className="space-y-4">
            <div className="bg-slate-800/60 border border-slate-700/60 rounded-xl p-4 text-sm text-slate-400">
              Follow these steps <strong className="text-white">every single trading day</strong>.
              Skip a step and you skip your edge. This is your daily operating procedure.
            </div>
            {PRE_TRADE_STEPS.map(item => (
              <div key={item.step} className={`p-5 rounded-xl border ${item.color}`}>
                <div className="flex items-start gap-4">
                  <div className="w-10 h-10 bg-slate-800/60 rounded-xl flex items-center justify-center text-xl flex-shrink-0">
                    {item.icon}
                  </div>
                  <div className="flex-1">
                    <div className="flex items-center gap-3 mb-1 flex-wrap">
                      <span className="font-bold text-slate-200">Step {item.step}: {item.title}</span>
                      <span className="text-xs text-slate-500 bg-slate-800/60 px-2 py-0.5 rounded">{item.time}</span>
                    </div>
                    {item.alert && (
                      <div className="text-xs bg-red-500/15 border border-red-500/30 text-red-400 rounded px-2 py-1 mb-2 font-bold">
                        {item.alert}
                      </div>
                    )}
                    <ul className="space-y-1.5 mt-2">
                      {item.tasks.map((task, i) => (
                        <li key={i} className="flex items-start gap-2 text-sm text-slate-400">
                          <span className="text-slate-600 mt-0.5 flex-shrink-0">›</span>
                          <span>{task}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

        {tab === 'lots' && (
          <div className="space-y-4">
            <div className="bg-rose-500/10 border border-rose-500/30 rounded-xl p-4 text-sm text-rose-300">
              🚨 <strong>Your avg lot size was 11.9 lots.</strong> That's ₹331 in charges per trade.
              With a 69% WR, that's unsustainable. Recommended: start with <strong>1–2 lots max.</strong>
            </div>
            <LotSizeCalculator />
          </div>
        )}

        {tab === 'charges' && (
          <div className="space-y-4">
            <ChargesBreakdown />
          </div>
        )}
      </div>
    </div>
  )
}
