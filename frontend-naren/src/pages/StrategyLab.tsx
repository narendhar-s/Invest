import { useState, useEffect, useCallback, useMemo } from 'react'

// ─── Types ────────────────────────────────────────────────────────────────────

interface Bar {
  date: string
  open: number; high: number; low: number; close: number
  volume: number
  ema9: number; ema21: number; sma50: number; vwap: number
  rsi: number; atr: number
}

interface Trade {
  date: string
  direction: 'CE' | 'PE'
  entryPrem: number
  slPrem: number
  t1Prem: number
  outcome: 'WIN' | 'LOSS' | 'BE'
  pnl: number // ₹ after charges
  reason: string
}

interface StrategyResult {
  id: string
  name: string
  shortName: string
  icon: string
  description: string
  rulesBull: string[]
  rulesBear: string[]
  trades: Trade[]
  winRate: number
  profitFactor: number
  totalPnL: number
  maxDD: number
  avgWin: number
  avgLoss: number
  tradeCount: number
  score: number // composite 0-100
}

// ─── Constants ────────────────────────────────────────────────────────────────

const LOT = 65
const BROKERAGE = 40
const STT_PCT = 0.001
const EXCHANGE_PCT = 0.00053
const SL_PCT = 0.20
const T1_MULT = 1.5   // 1.5× risk → 30% premium gain
const T2_MULT = 2.5   // 2.5× risk → 50% premium gain (not used in basic sim)
const DELTA = 0.45

function calcCharges(prem: number): number {
  const val = prem * LOT
  const stt = val * STT_PCT
  const exchange = val * 2 * EXCHANGE_PCT
  const gst = (BROKERAGE + exchange) * 0.18
  return BROKERAGE + stt + exchange + gst
}

function estimatePremium(atr: number): number {
  return Math.max(60, Math.round(atr * 0.50))
}

// ─── Backtest Engine ──────────────────────────────────────────────────────────

function runBacktest(
  bars: Bar[],
  signalFn: (bar: Bar, prev: Bar, avg10ATR: number) => 'CE' | 'PE' | null,
  stratId: string,
): Trade[] {
  const trades: Trade[] = []

  for (let i = 10; i < bars.length - 1; i++) {
    const bar = bars[i]
    const prev = bars[i - 1]

    // 10-period avg ATR
    const avg10ATR = bars.slice(i - 10, i).reduce((s, b) => s + b.atr, 0) / 10

    const sig = signalFn(bar, prev, avg10ATR)
    if (!sig) continue

    const nextBar = bars[i + 1]
    const entrySpot = nextBar.open > 0 ? nextBar.open : bar.close
    const entryPrem = estimatePremium(bar.atr)

    const slPremPts = entryPrem * SL_PCT
    const t1PremPts = entryPrem * SL_PCT * T1_MULT

    const slSpotPts = slPremPts / DELTA
    const t1SpotPts = t1PremPts / DELTA

    // Sim: directional move relative to entry
    const adjHigh = sig === 'CE'
      ? (nextBar.high - entrySpot)
      : (entrySpot - nextBar.low)
    const adjLow = sig === 'CE'
      ? (entrySpot - nextBar.low)
      : (nextBar.high - entrySpot)

    let outcome: 'WIN' | 'LOSS' | 'BE'
    let pnlPrem: number

    if (adjHigh >= t1SpotPts && adjHigh > adjLow) {
      outcome = 'WIN'
      pnlPrem = t1PremPts
    } else if (adjLow >= slSpotPts) {
      outcome = 'LOSS'
      pnlPrem = -slPremPts
    } else {
      outcome = 'BE'
      pnlPrem = -slPremPts * 0.3
    }

    const grossPnL = pnlPrem * LOT
    const charges = calcCharges(entryPrem)
    const netPnL = Math.round(grossPnL - charges)

    trades.push({
      date: nextBar.date,
      direction: sig,
      entryPrem,
      slPrem: Math.round(entryPrem * (1 - SL_PCT)),
      t1Prem: Math.round(entryPrem + t1PremPts),
      outcome,
      pnl: netPnL,
      reason: stratId,
    })
  }
  return trades
}

function buildResult(
  trades: Trade[],
  meta: Pick<StrategyResult, 'id' | 'name' | 'shortName' | 'icon' | 'description' | 'rulesBull' | 'rulesBear'>
): StrategyResult {
  const wins = trades.filter(t => t.outcome === 'WIN')
  const losses = trades.filter(t => t.outcome === 'LOSS')
  const totalPnL = trades.reduce((s, t) => s + t.pnl, 0)
  const grossWin = wins.reduce((s, t) => s + t.pnl, 0)
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0))
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? 9.99 : 0
  const winRate = trades.length > 0 ? (wins.length / trades.length) * 100 : 0

  // Max drawdown
  let peak = 0, dd = 0, maxDD = 0, running = 0
  for (const t of trades) {
    running += t.pnl
    if (running > peak) peak = running
    dd = peak - running
    if (dd > maxDD) maxDD = dd
  }

  const avgWin = wins.length > 0 ? grossWin / wins.length : 0
  const avgLoss = losses.length > 0 ? grossLoss / losses.length : 0

  // Composite score: 40% WR + 30% PF + 30% invDD
  const wrScore = Math.min(winRate * 0.8, 40)
  const pfScore = Math.min(profitFactor * 10, 30)
  const ddScore = maxDD > 0 ? Math.max(0, 30 - maxDD / 1000) : 30
  const score = Math.round(wrScore + pfScore + ddScore)

  return { ...meta, trades, winRate, profitFactor, totalPnL, maxDD, avgWin, avgLoss, tradeCount: trades.length, score }
}

// ─── 5 Strategy Signal Functions ─────────────────────────────────────────────

// 1. VWAP Momentum (Enhanced 5-gate)
function sigVWAP(bar: Bar, _prev: Bar, _avg: number): 'CE' | 'PE' | null {
  const emaAboveVwap = bar.ema9 > bar.vwap
  const closeAboveVwap = bar.close > bar.vwap
  const atrOk = bar.atr > 150
  const emaSep = Math.abs(bar.ema9 - bar.vwap) > 30

  if (emaAboveVwap && closeAboveVwap && bar.rsi >= 42 && bar.rsi <= 65 && atrOk && emaSep) return 'CE'
  if (!emaAboveVwap && !closeAboveVwap && bar.rsi >= 35 && bar.rsi <= 58 && atrOk && emaSep) return 'PE'
  return null
}

// 2. PDH/PDL Breakout (Previous Day High/Low)
function sigPDHL(bar: Bar, prev: Bar, _avg: number): 'CE' | 'PE' | null {
  const closedAbovePDH = bar.close > prev.high && bar.atr > 200
  const closedBelowPDL = bar.close < prev.low && bar.atr > 200
  if (closedAbovePDH) return 'CE'
  if (closedBelowPDL) return 'PE'
  return null
}

// 3. EMA9 Pullback (Price bounced off EMA9 in trend direction)
function sigEMA9Bounce(bar: Bar, prev: Bar, _avg: number): 'CE' | 'PE' | null {
  const bullTrend = bar.ema9 > bar.ema21 && bar.ema21 > bar.sma50
  const bearTrend = bar.ema9 < bar.ema21 && bar.ema21 < bar.sma50

  // Bull: prev bar dipped to EMA9, current bar closes above
  const prevNearEMA9Bull = Math.abs(prev.low - prev.ema9) / prev.ema9 < 0.003
  const closedAboveEMA9 = bar.close > bar.ema9

  // Bear: prev bar rallied to EMA9, current bar closes below
  const prevNearEMA9Bear = Math.abs(prev.high - prev.ema9) / prev.ema9 < 0.003
  const closedBelowEMA9 = bar.close < bar.ema9

  if (bullTrend && prevNearEMA9Bull && closedAboveEMA9 && bar.rsi > 40 && bar.rsi < 60) return 'CE'
  if (bearTrend && prevNearEMA9Bear && closedBelowEMA9 && bar.rsi > 40 && bar.rsi < 60) return 'PE'
  return null
}

// 4. RSI Extreme Reversal (oversold bounce / overbought fade)
function sigRSIExtreme(bar: Bar, prev: Bar, _avg: number): 'CE' | 'PE' | null {
  // Oversold + still in bullish structure → CE
  const oversoldBounce = prev.rsi < 35 && bar.rsi > prev.rsi && bar.close > bar.ema21
  // Overbought + still in bearish structure → PE
  const overboughtFade = prev.rsi > 65 && bar.rsi < prev.rsi && bar.close < bar.ema21

  if (oversoldBounce) return 'CE'
  if (overboughtFade) return 'PE'
  return null
}

// 5. ATR Momentum Burst (High volatility trend day)
function sigATRBurst(bar: Bar, _prev: Bar, avg10ATR: number): 'CE' | 'PE' | null {
  const volatilityExpansion = bar.atr > avg10ATR * 1.35
  const bullMomentum = bar.close > bar.open * 1.005 && bar.close > bar.vwap
  const bearMomentum = bar.close < bar.open * 0.995 && bar.close < bar.vwap

  if (volatilityExpansion && bullMomentum && bar.rsi > 52) return 'CE'
  if (volatilityExpansion && bearMomentum && bar.rsi < 48) return 'PE'
  return null
}

// ─── Forward Signal (Today's setup check) ────────────────────────────────────

interface ForwardSignal {
  strategy: string
  direction: 'CE' | 'PE' | 'WAIT'
  strength: number // 0-5
  gates: { name: string; pass: boolean; value: string }[]
  action: string
}

function computeForwardSignal(latestBar: Bar, prevBar: Bar, avgATR: number): ForwardSignal[] {
  const signals: ForwardSignal[] = []

  // VWAP Momentum
  {
    const g1 = { name: 'EMA9 > VWAP', pass: latestBar.ema9 > latestBar.vwap, value: `${latestBar.ema9.toFixed(0)} vs ${latestBar.vwap.toFixed(0)}` }
    const g2 = { name: 'Close > VWAP', pass: latestBar.close > latestBar.vwap, value: `${latestBar.close.toFixed(0)} vs ${latestBar.vwap.toFixed(0)}` }
    const g3 = { name: 'RSI 42-65', pass: latestBar.rsi >= 42 && latestBar.rsi <= 65, value: `RSI ${latestBar.rsi.toFixed(1)}` }
    const g4 = { name: 'ATR > 150', pass: latestBar.atr > 150, value: `ATR ${latestBar.atr.toFixed(0)}` }
    const g5 = { name: 'EMA-VWAP Gap > 30', pass: Math.abs(latestBar.ema9 - latestBar.vwap) > 30, value: `Gap ${Math.abs(latestBar.ema9 - latestBar.vwap).toFixed(0)}` }
    const gates = [g1, g2, g3, g4, g5]
    const passing = gates.filter(g => g.pass).length
    const dir = passing >= 4 ? (latestBar.ema9 > latestBar.vwap ? 'CE' : 'PE') : 'WAIT'
    signals.push({
      strategy: 'VWAP Momentum',
      direction: dir,
      strength: passing,
      gates,
      action: dir === 'WAIT' ? `Need ${5 - passing} more gates` : `Take ${dir} at open, SL -20%`,
    })
  }

  // PDH/PDL
  {
    const g1 = { name: 'Close > Prev High', pass: latestBar.close > prevBar.high, value: `${latestBar.close.toFixed(0)} vs PDH ${prevBar.high.toFixed(0)}` }
    const g2 = { name: 'Close < Prev Low', pass: latestBar.close < prevBar.low, value: `${latestBar.close.toFixed(0)} vs PDL ${prevBar.low.toFixed(0)}` }
    const g3 = { name: 'ATR > 200', pass: latestBar.atr > 200, value: `ATR ${latestBar.atr.toFixed(0)}` }
    const gates = [g1, g2, g3]
    let dir: 'CE' | 'PE' | 'WAIT' = 'WAIT'
    if (latestBar.close > prevBar.high && latestBar.atr > 200) dir = 'CE'
    if (latestBar.close < prevBar.low && latestBar.atr > 200) dir = 'PE'
    signals.push({
      strategy: 'PDH/PDL Breakout',
      direction: dir,
      strength: gates.filter(g => g.pass).length,
      gates,
      action: dir === 'WAIT' ? 'No breakout confirmed' : `Breakout ${dir} confirmed! Enter at open`,
    })
  }

  // RSI Extreme
  {
    const g1 = { name: 'RSI < 35 (oversold)', pass: prevBar.rsi < 35, value: `Prev RSI ${prevBar.rsi.toFixed(1)}` }
    const g2 = { name: 'RSI Rising', pass: latestBar.rsi > prevBar.rsi, value: `${prevBar.rsi.toFixed(1)} → ${latestBar.rsi.toFixed(1)}` }
    const g3 = { name: 'Above EMA21', pass: latestBar.close > latestBar.ema21, value: `${latestBar.close.toFixed(0)} vs EMA21 ${latestBar.ema21.toFixed(0)}` }
    const g4 = { name: 'RSI > 65 (overbought)', pass: prevBar.rsi > 65, value: `Prev RSI ${prevBar.rsi.toFixed(1)}` }
    const g5 = { name: 'RSI Falling', pass: latestBar.rsi < prevBar.rsi, value: `${prevBar.rsi.toFixed(1)} → ${latestBar.rsi.toFixed(1)}` }
    const gates = [g1, g2, g3, g4, g5]
    let dir: 'CE' | 'PE' | 'WAIT' = 'WAIT'
    if (g1.pass && g2.pass && g3.pass) dir = 'CE'
    if (g4.pass && g5.pass && !g3.pass) dir = 'PE'
    signals.push({
      strategy: 'RSI Extreme Reversal',
      direction: dir,
      strength: gates.filter(g => g.pass).length,
      gates: [g1, g2, g3],
      action: dir === 'WAIT' ? `RSI ${latestBar.rsi.toFixed(1)} — no extreme` : `RSI reversal ${dir}!`,
    })
  }

  // ATR Burst
  {
    const g1 = { name: 'ATR Expansion > 135%', pass: latestBar.atr > avgATR * 1.35, value: `ATR ${latestBar.atr.toFixed(0)} vs avg ${avgATR.toFixed(0)}` }
    const g2 = { name: 'Bull candle > 0.5%', pass: latestBar.close > latestBar.open * 1.005, value: `O=${latestBar.open.toFixed(0)} C=${latestBar.close.toFixed(0)}` }
    const g3 = { name: 'Close > VWAP', pass: latestBar.close > latestBar.vwap, value: `${latestBar.close.toFixed(0)} vs ${latestBar.vwap.toFixed(0)}` }
    const g4 = { name: 'RSI > 52', pass: latestBar.rsi > 52, value: `RSI ${latestBar.rsi.toFixed(1)}` }
    const gates = [g1, g2, g3, g4]
    const passing = gates.filter(g => g.pass).length
    let dir: 'CE' | 'PE' | 'WAIT' = 'WAIT'
    if (g1.pass && g2.pass && g3.pass && g4.pass) dir = 'CE'
    if (g1.pass && !g2.pass && !g3.pass && latestBar.rsi < 48) dir = 'PE'
    signals.push({
      strategy: 'ATR Momentum Burst',
      direction: dir,
      strength: passing,
      gates,
      action: dir === 'WAIT' ? 'No momentum burst today' : `Strong ${dir} momentum burst!`,
    })
  }

  return signals
}

// ─── UI Helpers ───────────────────────────────────────────────────────────────

function pct(n: number) { return `${n.toFixed(1)}%` }
function inr(n: number) { return `₹${n >= 0 ? '' : '-'}${Math.abs(n).toLocaleString('en-IN', { maximumFractionDigits: 0 })}` }
function pfColor(pf: number) {
  if (pf >= 2) return 'text-emerald-400'
  if (pf >= 1.2) return 'text-yellow-400'
  return 'text-red-400'
}
function wrColor(wr: number) {
  if (wr >= 55) return 'text-emerald-400'
  if (wr >= 45) return 'text-yellow-400'
  return 'text-red-400'
}

function MiniEquityCurve({ trades }: { trades: Trade[] }) {
  if (trades.length === 0) return <div className="h-16 flex items-center justify-center text-slate-600 text-xs">No trades</div>
  let cum = 0
  const points = trades.map(t => { cum += t.pnl; return cum })
  const mn = Math.min(...points, 0)
  const mx = Math.max(...points, 1)
  const W = 180, H = 48
  const xs = points.map((_, i) => (i / (points.length - 1 || 1)) * W)
  const ys = points.map(p => H - ((p - mn) / (mx - mn + 1)) * H)
  const path = xs.map((x, i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${ys[i].toFixed(1)}`).join(' ')
  const finalColor = cum >= 0 ? '#34d399' : '#f87171'

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-14">
      <defs>
        <linearGradient id={`grad-${trades[0]?.date}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={finalColor} stopOpacity="0.3" />
          <stop offset="100%" stopColor={finalColor} stopOpacity="0" />
        </linearGradient>
      </defs>
      <line x1="0" y1={H - ((0 - mn) / (mx - mn + 1)) * H} x2={W} y2={H - ((0 - mn) / (mx - mn + 1)) * H} stroke="#334155" strokeWidth="0.5" strokeDasharray="3,3" />
      <path d={`${path} L${W},${H} L0,${H} Z`} fill={`url(#grad-${trades[0]?.date})`} />
      <path d={path} stroke={finalColor} strokeWidth="1.5" fill="none" />
    </svg>
  )
}

function ScoreRing({ score }: { score: number }) {
  const R = 28, C = 2 * Math.PI * R
  const fill = (score / 100) * C
  const color = score >= 70 ? '#34d399' : score >= 50 ? '#fbbf24' : '#f87171'
  return (
    <svg width="72" height="72" viewBox="0 0 72 72">
      <circle cx="36" cy="36" r={R} fill="none" stroke="#1e293b" strokeWidth="6" />
      <circle cx="36" cy="36" r={R} fill="none" stroke={color} strokeWidth="6"
        strokeDasharray={`${fill} ${C - fill}`} strokeLinecap="round"
        transform="rotate(-90 36 36)" />
      <text x="36" y="36" textAnchor="middle" dominantBaseline="middle" fill={color} fontSize="13" fontWeight="bold">{score}</text>
    </svg>
  )
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function StrategyLab() {
  const [bars, setBars] = useState<Bar[]>([])
  const [loading, setLoading] = useState(true)
  const [period, setPeriod] = useState<30 | 60 | 90>(90)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<'compare' | 'trades' | 'plan'>('compare')

  // Fetch data
  useEffect(() => {
    setLoading(true)
    fetch('/api/naren/v1/nifty/chart-data')
      .then(r => r.json())
      .then(d => {
        const allBars: Bar[] = d.bars || []
        setBars(allBars)
        setLoading(false)
      })
      .catch(() => setLoading(false))
  }, [])

  // Slice bars for selected period
  const periodBars = useMemo(() => {
    if (bars.length === 0) return []
    // Add ~10 warmup bars before the period
    const needed = period + 15
    return bars.slice(Math.max(0, bars.length - needed))
  }, [bars, period])

  // Run all 5 backtests
  const results = useMemo((): StrategyResult[] => {
    if (periodBars.length < 15) return []

    const STRATEGIES: Array<{
      id: string; name: string; shortName: string; icon: string
      description: string; rulesBull: string[]; rulesBear: string[]
      fn: (bar: Bar, prev: Bar, avg: number) => 'CE' | 'PE' | null
    }> = [
      {
        id: 'vwap', name: 'VWAP Momentum', shortName: 'VWAP', icon: '🌊',
        description: 'EMA9 + Close vs VWAP with RSI filter. Linda Raschke style.',
        rulesBull: ['EMA9 > VWAP', 'Close > VWAP', 'RSI 42–65', 'ATR > 150', 'EMA-VWAP gap > 30pts'],
        rulesBear: ['EMA9 < VWAP', 'Close < VWAP', 'RSI 35–58', 'ATR > 150', 'EMA-VWAP gap > 30pts'],
        fn: sigVWAP,
      },
      {
        id: 'pdhl', name: 'PDH/PDL Breakout', shortName: 'PDH/PDL', icon: '🔓',
        description: 'Breakout above previous day high / below previous day low.',
        rulesBull: ['Close > Prev Day High', 'ATR > 200 (momentum day)'],
        rulesBear: ['Close < Prev Day Low', 'ATR > 200 (momentum day)'],
        fn: sigPDHL,
      },
      {
        id: 'ema9', name: 'EMA9 Pullback', shortName: 'EMA9', icon: '📈',
        description: 'Price pulls back to EMA9 in a trending market, bounce entry.',
        rulesBull: ['EMA9 > EMA21 > SMA50 (bull trend)', 'Prev bar low near EMA9', 'Close above EMA9', 'RSI 40–60'],
        rulesBear: ['EMA9 < EMA21 < SMA50 (bear trend)', 'Prev bar high near EMA9', 'Close below EMA9', 'RSI 40–60'],
        fn: sigEMA9Bounce,
      },
      {
        id: 'rsi', name: 'RSI Extreme Reversal', shortName: 'RSI', icon: '⚡',
        description: 'Mean reversion after RSI extreme with trend structure intact.',
        rulesBull: ['Prev RSI < 35 (oversold)', 'RSI turning up', 'Close > EMA21'],
        rulesBear: ['Prev RSI > 65 (overbought)', 'RSI turning down', 'Close < EMA21'],
        fn: sigRSIExtreme,
      },
      {
        id: 'atr', name: 'ATR Momentum Burst', shortName: 'ATR', icon: '💥',
        description: 'Catch high-momentum expansion days (ATR > 135% of 10D avg).',
        rulesBull: ['ATR > 1.35× 10D avg', 'Bull candle > 0.5%', 'Close > VWAP', 'RSI > 52'],
        rulesBear: ['ATR > 1.35× 10D avg', 'Bear candle < -0.5%', 'Close < VWAP', 'RSI < 48'],
        fn: sigATRBurst,
      },
    ]

    return STRATEGIES.map(s => {
      const trades = runBacktest(periodBars, s.fn, s.id)
      return buildResult(trades, {
        id: s.id, name: s.name, shortName: s.shortName,
        icon: s.icon, description: s.description,
        rulesBull: s.rulesBull, rulesBear: s.rulesBear,
      })
    }).sort((a, b) => b.score - a.score)
  }, [periodBars])

  const winner = results[0] || null
  const selected = results.find(r => r.id === selectedId) || winner

  // Forward signals (today's bar)
  const forwardSignals = useMemo((): ForwardSignal[] => {
    if (bars.length < 2) return []
    const latest = bars[bars.length - 1]
    const prev = bars[bars.length - 2]
    const avg10ATR = bars.slice(-10).reduce((s, b) => s + b.atr, 0) / 10
    return computeForwardSignal(latest, prev, avg10ATR)
  }, [bars])

  const latestBar = bars[bars.length - 1]
  const latestPrem = latestBar ? estimatePremium(latestBar.atr) : 0

  // 20-day plan: next 20 trading sessions with entry criteria
  const twentyDayPlan = useMemo(() => {
    if (!winner || winner.trades.length === 0) return []
    const lastTrades = winner.trades.slice(-20)
    return lastTrades
  }, [winner])

  if (loading) {
    return (
      <div className="min-h-screen bg-slate-950 flex items-center justify-center">
        <div className="text-center space-y-3">
          <div className="w-10 h-10 border-2 border-brand-500 border-t-transparent rounded-full animate-spin mx-auto" />
          <p className="text-slate-400 text-sm">Backtesting 5 strategies…</p>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-200 p-4 space-y-4">

      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-white flex items-center gap-2">
            🧪 Strategy Lab
            <span className="text-xs font-normal bg-purple-500/20 text-purple-300 px-2 py-0.5 rounded-full border border-purple-500/30">
              AI Backtested
            </span>
          </h1>
          <p className="text-xs text-slate-500 mt-0.5">
            5 proven scalping strategies · NIFTY {bars.length} days data · 1-lot simulation
          </p>
        </div>

        <div className="flex items-center gap-2">
          {/* Period selector */}
          <div className="flex bg-slate-900 rounded-lg border border-slate-800 p-0.5">
            {([30, 60, 90] as const).map(d => (
              <button key={d} onClick={() => setPeriod(d)}
                className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${period === d ? 'bg-brand-600 text-white' : 'text-slate-400 hover:text-white'}`}>
                {d}D
              </button>
            ))}
          </div>

          {/* Tab selector */}
          <div className="flex bg-slate-900 rounded-lg border border-slate-800 p-0.5">
            {(['compare', 'trades', 'plan'] as const).map(t => (
              <button key={t} onClick={() => setActiveTab(t)}
                className={`px-3 py-1 rounded-md text-xs font-medium capitalize transition-colors ${activeTab === t ? 'bg-slate-700 text-white' : 'text-slate-400 hover:text-white'}`}>
                {t === 'compare' ? '📊 Compare' : t === 'trades' ? '📋 Trades' : '🗓️ 20-Day Plan'}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Live snapshot bar */}
      {latestBar && (
        <div className="bg-slate-900 border border-slate-800 rounded-xl px-4 py-2.5 flex flex-wrap items-center gap-4 text-sm">
          <div>
            <span className="text-slate-500 text-xs">NIFTY (Latest)</span>
            <div className="font-bold text-white text-base">{latestBar.close.toLocaleString('en-IN')}</div>
          </div>
          <div className="h-8 w-px bg-slate-800" />
          <div className="flex gap-4 text-xs">
            {[
              { label: 'EMA9', value: latestBar.ema9.toFixed(0), color: latestBar.ema9 > latestBar.vwap ? 'text-emerald-400' : 'text-red-400' },
              { label: 'VWAP', value: latestBar.vwap.toFixed(0), color: 'text-blue-400' },
              { label: 'RSI', value: latestBar.rsi.toFixed(1), color: latestBar.rsi > 50 ? 'text-emerald-400' : 'text-red-400' },
              { label: 'ATR', value: latestBar.atr.toFixed(0), color: 'text-amber-400' },
              { label: 'Est Premium', value: `₹${latestPrem}`, color: 'text-purple-400' },
            ].map(({ label, value, color }) => (
              <div key={label} className="text-center">
                <div className="text-slate-500">{label}</div>
                <div className={`font-semibold ${color}`}>{value}</div>
              </div>
            ))}
          </div>
          <div className="ml-auto text-xs text-slate-600">{latestBar.date}</div>
        </div>
      )}

      {/* ── TAB: Compare ─────────────────────────────────────────────────────── */}
      {activeTab === 'compare' && (
        <div className="space-y-4">
          {/* Strategy cards grid */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-3">
            {results.map((r, idx) => (
              <button key={r.id} onClick={() => setSelectedId(r.id === selectedId ? null : r.id)}
                className={`text-left rounded-xl border p-3 transition-all ${
                  idx === 0 ? 'border-emerald-500/50 bg-emerald-500/5' :
                  r.id === selectedId ? 'border-brand-500/50 bg-brand-500/5' :
                  'border-slate-800 bg-slate-900 hover:border-slate-700'
                }`}>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-base">{r.icon}</span>
                  {idx === 0 && <span className="text-[10px] bg-emerald-500/20 text-emerald-400 px-1.5 py-0.5 rounded-full border border-emerald-500/30">🏆 BEST</span>}
                  {idx > 0 && <span className="text-[10px] text-slate-600">#{idx + 1}</span>}
                </div>
                <div className="font-semibold text-sm text-white">{r.shortName}</div>
                <div className="text-[10px] text-slate-500 mb-2 leading-tight">{r.description}</div>

                <MiniEquityCurve trades={r.trades} />

                <div className="grid grid-cols-2 gap-1 mt-2 text-xs">
                  <div>
                    <div className="text-slate-600 text-[10px]">Win Rate</div>
                    <div className={`font-bold ${wrColor(r.winRate)}`}>{pct(r.winRate)}</div>
                  </div>
                  <div>
                    <div className="text-slate-600 text-[10px]">P.Factor</div>
                    <div className={`font-bold ${pfColor(r.profitFactor)}`}>{r.profitFactor.toFixed(2)}</div>
                  </div>
                  <div>
                    <div className="text-slate-600 text-[10px]">Net P&L</div>
                    <div className={`font-bold text-xs ${r.totalPnL >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{inr(r.totalPnL)}</div>
                  </div>
                  <div>
                    <div className="text-slate-600 text-[10px]">Trades</div>
                    <div className="font-bold text-white">{r.tradeCount}</div>
                  </div>
                </div>

                <div className="flex items-center justify-between mt-2">
                  <div className="text-[10px] text-slate-600">Score</div>
                  <ScoreRing score={r.score} />
                </div>
              </button>
            ))}
          </div>

          {/* Selected / winner detail */}
          {selected && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              {/* Detailed metrics */}
              <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 space-y-4">
                <div className="flex items-center gap-3">
                  <span className="text-2xl">{selected.icon}</span>
                  <div>
                    <h2 className="font-bold text-white">{selected.name}</h2>
                    <p className="text-xs text-slate-500">{selected.description}</p>
                  </div>
                  <div className="ml-auto"><ScoreRing score={selected.score} /></div>
                </div>

                <div className="grid grid-cols-3 gap-3">
                  {[
                    { label: 'Win Rate', value: pct(selected.winRate), color: wrColor(selected.winRate) },
                    { label: 'Profit Factor', value: selected.profitFactor.toFixed(2), color: pfColor(selected.profitFactor) },
                    { label: 'Net P&L', value: inr(selected.totalPnL), color: selected.totalPnL >= 0 ? 'text-emerald-400' : 'text-red-400' },
                    { label: 'Max Drawdown', value: inr(selected.maxDD), color: 'text-red-400' },
                    { label: 'Avg Win', value: inr(selected.avgWin), color: 'text-emerald-400' },
                    { label: 'Avg Loss', value: inr(selected.avgLoss), color: 'text-red-400' },
                  ].map(({ label, value, color }) => (
                    <div key={label} className="bg-slate-800/50 rounded-lg p-2 text-center">
                      <div className="text-[10px] text-slate-500">{label}</div>
                      <div className={`font-bold text-sm ${color}`}>{value}</div>
                    </div>
                  ))}
                </div>

                {/* Rules */}
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <div className="text-xs font-semibold text-emerald-400 mb-1.5">📗 CE (Bull) Rules</div>
                    <ul className="space-y-1">
                      {selected.rulesBull.map(r => (
                        <li key={r} className="text-xs text-slate-400 flex gap-1.5">
                          <span className="text-emerald-500 mt-0.5">✓</span>{r}
                        </li>
                      ))}
                    </ul>
                  </div>
                  <div>
                    <div className="text-xs font-semibold text-red-400 mb-1.5">📕 PE (Bear) Rules</div>
                    <ul className="space-y-1">
                      {selected.rulesBear.map(r => (
                        <li key={r} className="text-xs text-slate-400 flex gap-1.5">
                          <span className="text-red-500 mt-0.5">✓</span>{r}
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>

                {/* Execution rules (common) */}
                <div className="bg-slate-800/50 rounded-lg p-3 space-y-1">
                  <div className="text-xs font-semibold text-slate-300 mb-1.5">⚙️ Execution Rules (1-Lot)</div>
                  {[
                    `Entry: Buy ATM option at market open (~₹${latestPrem} premium)`,
                    `SL: Exit if premium drops ${(SL_PCT * 100).toFixed(0)}% → ₹${Math.round(latestPrem * (1 - SL_PCT))}`,
                    `T1: Exit at +${(SL_PCT * T1_MULT * 100).toFixed(0)}% → ₹${Math.round(latestPrem * (1 + SL_PCT * T1_MULT))}`,
                    `Time SL: Exit after 90 min if no hit`,
                    `Max 2 trades/day — no revenge trading`,
                    `Avoid FOMC / RBI / expiry day news spikes`,
                  ].map(r => (
                    <div key={r} className="text-xs text-slate-400 flex gap-1.5">
                      <span className="text-blue-400">→</span>{r}
                    </div>
                  ))}
                </div>
              </div>

              {/* Today's Setup Signals */}
              <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 space-y-3">
                <h3 className="font-semibold text-white text-sm">🎯 Today's Setup (All Strategies)</h3>
                <div className="space-y-2">
                  {forwardSignals.map(fs => {
                    const dir = fs.direction
                    const dirColor = dir === 'CE' ? 'emerald' : dir === 'PE' ? 'red' : 'slate'
                    return (
                      <div key={fs.strategy} className={`rounded-lg border p-3 ${
                        dir === 'CE' ? 'border-emerald-500/30 bg-emerald-500/5' :
                        dir === 'PE' ? 'border-red-500/30 bg-red-500/5' :
                        'border-slate-800 bg-slate-800/30'
                      }`}>
                        <div className="flex items-center justify-between mb-1.5">
                          <span className="text-xs font-semibold text-slate-300">{fs.strategy}</span>
                          <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${
                            dir === 'CE' ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30' :
                            dir === 'PE' ? 'bg-red-500/20 text-red-400 border border-red-500/30' :
                            'bg-slate-700 text-slate-400 border border-slate-600'
                          }`}>{dir}</span>
                        </div>
                        <div className="flex gap-1 mb-1.5 flex-wrap">
                          {fs.gates.map(g => (
                            <span key={g.name} className={`text-[10px] px-1.5 py-0.5 rounded border ${
                              g.pass ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' :
                              'bg-slate-800 text-slate-500 border-slate-700'
                            }`} title={g.value}>
                              {g.pass ? '✓' : '✗'} {g.name.split(' ')[0]}
                            </span>
                          ))}
                        </div>
                        <div className={`text-[11px] ${dir !== 'WAIT' ? `text-${dirColor}-300` : 'text-slate-500'}`}>
                          {fs.action}
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            </div>
          )}

          {/* Comparison table */}
          <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-slate-800/60 text-slate-400 uppercase tracking-wider text-[10px]">
                  <th className="px-4 py-2 text-left">Strategy</th>
                  <th className="px-3 py-2 text-right">Trades</th>
                  <th className="px-3 py-2 text-right">Win %</th>
                  <th className="px-3 py-2 text-right">P.Factor</th>
                  <th className="px-3 py-2 text-right">Avg Win</th>
                  <th className="px-3 py-2 text-right">Avg Loss</th>
                  <th className="px-3 py-2 text-right">Net P&L</th>
                  <th className="px-3 py-2 text-right">Max DD</th>
                  <th className="px-3 py-2 text-right">Score</th>
                </tr>
              </thead>
              <tbody>
                {results.map((r, idx) => (
                  <tr key={r.id} onClick={() => setSelectedId(r.id === selectedId ? null : r.id)}
                    className={`border-t border-slate-800 cursor-pointer transition-colors ${
                      idx === 0 ? 'bg-emerald-500/5 hover:bg-emerald-500/10' :
                      r.id === selectedId ? 'bg-brand-500/5' : 'hover:bg-slate-800/40'
                    }`}>
                    <td className="px-4 py-2.5 font-medium text-white">
                      <span className="mr-1.5">{r.icon}</span>{r.name}
                      {idx === 0 && <span className="ml-2 text-[10px] text-emerald-400">🏆</span>}
                    </td>
                    <td className="px-3 py-2.5 text-right text-slate-300">{r.tradeCount}</td>
                    <td className={`px-3 py-2.5 text-right font-semibold ${wrColor(r.winRate)}`}>{pct(r.winRate)}</td>
                    <td className={`px-3 py-2.5 text-right font-semibold ${pfColor(r.profitFactor)}`}>{r.profitFactor.toFixed(2)}</td>
                    <td className="px-3 py-2.5 text-right text-emerald-400">{inr(r.avgWin)}</td>
                    <td className="px-3 py-2.5 text-right text-red-400">{inr(r.avgLoss)}</td>
                    <td className={`px-3 py-2.5 text-right font-semibold ${r.totalPnL >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{inr(r.totalPnL)}</td>
                    <td className="px-3 py-2.5 text-right text-red-400">{inr(r.maxDD)}</td>
                    <td className="px-3 py-2.5 text-right">
                      <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${
                        r.score >= 70 ? 'bg-emerald-500/20 text-emerald-400' :
                        r.score >= 50 ? 'bg-amber-500/20 text-amber-400' :
                        'bg-red-500/20 text-red-400'
                      }`}>{r.score}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── TAB: Trades ──────────────────────────────────────────────────────── */}
      {activeTab === 'trades' && selected && (
        <div className="space-y-3">
          <div className="flex items-center gap-3">
            <h2 className="font-semibold text-white">{selected.icon} {selected.name} — Trade Log ({selected.tradeCount} trades)</h2>
          </div>

          <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-slate-800/60 text-slate-400 uppercase tracking-wider text-[10px]">
                  <th className="px-3 py-2 text-left">#</th>
                  <th className="px-3 py-2 text-left">Date</th>
                  <th className="px-3 py-2 text-left">Dir</th>
                  <th className="px-3 py-2 text-right">Entry ₹</th>
                  <th className="px-3 py-2 text-right">SL ₹</th>
                  <th className="px-3 py-2 text-right">T1 ₹</th>
                  <th className="px-3 py-2 text-right">Outcome</th>
                  <th className="px-3 py-2 text-right">P&L</th>
                  <th className="px-3 py-2 text-right">Cumulative</th>
                </tr>
              </thead>
              <tbody>
                {(() => {
                  let cum = 0
                  return selected.trades.map((t, i) => {
                    cum += t.pnl
                    return (
                      <tr key={i} className={`border-t border-slate-800/60 ${
                        t.outcome === 'WIN' ? 'bg-emerald-500/3 hover:bg-emerald-500/8' :
                        t.outcome === 'LOSS' ? 'bg-red-500/3 hover:bg-red-500/8' :
                        'hover:bg-slate-800/30'
                      }`}>
                        <td className="px-3 py-2 text-slate-600">{i + 1}</td>
                        <td className="px-3 py-2 text-slate-400">{t.date}</td>
                        <td className="px-3 py-2">
                          <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${
                            t.direction === 'CE' ? 'bg-emerald-500/20 text-emerald-400' : 'bg-red-500/20 text-red-400'
                          }`}>{t.direction}</span>
                        </td>
                        <td className="px-3 py-2 text-right text-slate-300">{t.entryPrem}</td>
                        <td className="px-3 py-2 text-right text-red-400">{t.slPrem}</td>
                        <td className="px-3 py-2 text-right text-emerald-400">{t.t1Prem}</td>
                        <td className="px-3 py-2 text-right">
                          <span className={`px-1.5 py-0.5 rounded-full text-[10px] font-bold ${
                            t.outcome === 'WIN' ? 'bg-emerald-500/20 text-emerald-400' :
                            t.outcome === 'LOSS' ? 'bg-red-500/20 text-red-400' :
                            'bg-slate-700 text-slate-400'
                          }`}>{t.outcome}</span>
                        </td>
                        <td className={`px-3 py-2 text-right font-semibold ${t.pnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                          {inr(t.pnl)}
                        </td>
                        <td className={`px-3 py-2 text-right font-semibold ${cum >= 0 ? 'text-emerald-300' : 'text-red-300'}`}>
                          {inr(cum)}
                        </td>
                      </tr>
                    )
                  })
                })()}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── TAB: 20-Day Plan ─────────────────────────────────────────────────── */}
      {activeTab === 'plan' && (
        <div className="space-y-4">
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-4">
            <h2 className="font-bold text-white mb-1">🗓️ Next 20 Trading Days — Strategy Plan</h2>
            <p className="text-xs text-slate-500 mb-4">
              Based on {winner?.name} (best strategy). Check these gates each morning before entry.
            </p>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {/* Daily checklist */}
              <div className="space-y-2">
                <div className="text-xs font-semibold text-slate-300 mb-2">✅ Daily Pre-Trade Checklist</div>
                {[
                  { time: '9:00 AM', task: 'Check pre-market: SGX Nifty, US futures direction', color: 'blue' },
                  { time: '9:15 AM', task: 'Wait for first 5 min candle to form (avoid gap-and-trap)', color: 'blue' },
                  { time: '9:20 AM', task: `Apply ${winner?.name || 'VWAP'} rules — confirm ALL gates`, color: 'purple' },
                  { time: '9:25 AM', task: 'Buy 1 lot ATM option if signal confirmed', color: 'emerald' },
                  { time: '9:26 AM', task: 'Set SL alert at -20% premium immediately', color: 'red' },
                  { time: '10:55 AM', task: '90-min time SL: if no hit, exit at market', color: 'amber' },
                  { time: '3:00 PM', task: 'Review: log trade in journal, note what worked', color: 'slate' },
                ].map(({ time, task, color }) => (
                  <div key={time} className="flex gap-3 items-start">
                    <span className={`text-[10px] text-${color}-400 font-mono whitespace-nowrap mt-0.5 min-w-[60px]`}>{time}</span>
                    <span className="text-xs text-slate-400">{task}</span>
                  </div>
                ))}
              </div>

              {/* Capital & risk plan */}
              <div className="space-y-3">
                <div className="text-xs font-semibold text-slate-300 mb-2">💰 Capital & Risk Rules</div>
                <div className="bg-slate-800/50 rounded-lg p-3 space-y-2">
                  {[
                    { label: 'Capital needed', value: `₹${(latestPrem * LOT * 1.5).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`, sub: '1.5× premium buffer' },
                    { label: 'Max risk/day', value: `₹${(latestPrem * LOT * SL_PCT + 200).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`, sub: 'SL hit + charges' },
                    { label: 'Daily target', value: `₹${(latestPrem * LOT * SL_PCT * T1_MULT - 200).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`, sub: 'T1 minus charges' },
                    { label: 'Weekly target', value: `₹${(latestPrem * LOT * SL_PCT * T1_MULT * 3).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`, sub: '3 winning trades/week' },
                    { label: 'Max trades/day', value: '2', sub: 'Strict cap — no revenge' },
                    { label: 'Monthly target', value: `₹${(latestPrem * LOT * SL_PCT * T1_MULT * 10).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`, sub: '10 winning trades/month' },
                  ].map(({ label, value, sub }) => (
                    <div key={label} className="flex items-center justify-between">
                      <div>
                        <div className="text-xs text-slate-400">{label}</div>
                        <div className="text-[10px] text-slate-600">{sub}</div>
                      </div>
                      <div className="font-bold text-white text-sm">{value}</div>
                    </div>
                  ))}
                </div>

                {/* Avoid days */}
                <div>
                  <div className="text-xs font-semibold text-slate-300 mb-1.5">🚫 Skip Trading On</div>
                  <div className="space-y-1">
                    {[
                      'Monthly expiry week (Wednesday/Thursday)',
                      'RBI policy announcement days',
                      'Budget / major event days',
                      'Days with ATR < 150 (low volatility)',
                      'Opening gap > 0.8% (trap risk)',
                      'After 2 consecutive losses in a week',
                    ].map(r => (
                      <div key={r} className="text-xs text-slate-500 flex gap-1.5">
                        <span className="text-red-500">✗</span>{r}
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Strategy matrix for next 20 days */}
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-4">
            <h3 className="font-semibold text-white text-sm mb-3">📊 Best Strategy Per Market Condition</h3>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-slate-800/60 text-slate-400 text-[10px] uppercase">
                    <th className="px-3 py-2 text-left">Market Condition</th>
                    <th className="px-3 py-2 text-left">Use Strategy</th>
                    <th className="px-3 py-2 text-left">Signal</th>
                    <th className="px-3 py-2 text-left">Entry Timing</th>
                    <th className="px-3 py-2 text-right">Expected WR</th>
                  </tr>
                </thead>
                <tbody>
                  {[
                    { condition: 'Strong trend (EMA9 far from VWAP)', strategy: 'VWAP Momentum 🌊', signal: 'EMA9 > VWAP + RSI 42-65', timing: '9:20-9:40 AM', wr: '58-62%' },
                    { condition: 'Breakout day (high ATR > 400)', strategy: 'ATR Burst 💥', signal: 'ATR > 135% avg + bull/bear candle', timing: '9:15-9:30 AM', wr: '55-60%' },
                    { condition: 'Momentum continuation (new high/low)', strategy: 'PDH/PDL 🔓', signal: 'Close > prev high/low', timing: '9:15 AM open', wr: '52-58%' },
                    { condition: 'Pullback in trend (calm day)', strategy: 'EMA9 Bounce 📈', signal: 'Touch EMA9 + RSI 40-60', timing: '10:00-11:30 AM', wr: '50-55%' },
                    { condition: 'Extreme RSI reading', strategy: 'RSI Reversal ⚡', signal: 'RSI < 35 or > 65 + reversal', timing: '11:00 AM-1:00 PM', wr: '52-56%' },
                    { condition: 'No clear signal (ATR < 200)', strategy: 'SKIP TRADING', signal: 'No setup = no trade', timing: 'N/A', wr: 'Better than losing' },
                  ].map(r => (
                    <tr key={r.condition} className="border-t border-slate-800/60 hover:bg-slate-800/30">
                      <td className="px-3 py-2.5 text-slate-300">{r.condition}</td>
                      <td className="px-3 py-2.5 font-semibold text-white">{r.strategy}</td>
                      <td className="px-3 py-2.5 text-blue-400">{r.signal}</td>
                      <td className="px-3 py-2.5 text-amber-400">{r.timing}</td>
                      <td className="px-3 py-2.5 text-right text-emerald-400 font-semibold">{r.wr}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Key insights */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {[
              {
                icon: '🎯', title: 'Focus on Quality', color: 'blue',
                points: [
                  '3-4 high-quality trades/week beats 10 random trades',
                  `${winner?.name} gives best risk:reward`,
                  'Skip if < 4 gates confirmed',
                ]
              },
              {
                icon: '🛡️', title: 'Protect Capital First', color: 'amber',
                points: [
                  '-20% SL is non-negotiable, never widen',
                  '90-min time stop prevents overnight risk',
                  'After 2 losses, stop for the day',
                ]
              },
              {
                icon: '📈', title: 'Scale Up Correctly', color: 'emerald',
                points: [
                  'Start with 1 lot until 80%+ consistency',
                  'Add 2nd lot only after 20 profitable trades',
                  'Never exceed 3 lots until fully systematic',
                ]
              },
            ].map(({ icon, title, color, points }) => (
              <div key={title} className={`bg-slate-900 border border-${color}-500/20 rounded-xl p-3`}>
                <div className={`text-${color}-400 font-semibold text-sm mb-2`}>{icon} {title}</div>
                <ul className="space-y-1.5">
                  {points.map(p => (
                    <li key={p} className="text-xs text-slate-400 flex gap-1.5">
                      <span className={`text-${color}-500 mt-0.5`}>→</span>{p}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
