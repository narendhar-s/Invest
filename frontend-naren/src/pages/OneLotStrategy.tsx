import { useState, useEffect, useRef, useCallback } from 'react'
import {
  getOptionsSignal,
  getNiftyChartData,
  getNiftyLiveSignals,
  type OptionsSignal,
  type NiftyChartBar,
  type NiftyScalpSignal,
} from '../api/client'

// ─── Constants ────────────────────────────────────────────────────────────────

const LOT_SIZE = 65
const SL_PCT   = 0.20   // 20% of premium
const T1_MULT  = 1.5    // 1.5× risk
const T2_MULT  = 2.5    // 2.5× risk
const MAX_HOLD = 90     // seconds
const BROKERAGE = 40    // buy + sell
const STT_PCT   = 0.001 // on sell side

// ─── Types ────────────────────────────────────────────────────────────────────

interface LiveTrade {
  active: boolean
  direction: 'CE' | 'PE'
  entry: number
  sl: number
  t1: number
  t2: number
  startSec: number
  status: 'live' | 'hit_t1' | 'hit_sl' | 'time_sl' | 'hit_t2'
  current: number
}

interface BacktestDay {
  date:       string
  direction:  'CE' | 'PE' | null
  signal:     string
  entry_px:   number   // NIFTY spot
  exit_px:    number
  prem_entry: number
  prem_exit:  number
  pnl_rs:     number
  result:     'WIN' | 'LOSS' | 'BE' | 'NO_TRADE'
  exit_reason: string
  gates:      number   // how many gates passed
  ema9:       number
  ema21:      number
  vwap:       number
  rsi:        number
  atr:        number
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtN(n: number, dec = 0) {
  return new Intl.NumberFormat('en-IN', { maximumFractionDigits: dec }).format(Math.abs(n))
}

function pnlColor(n: number) { return n > 0 ? 'text-emerald-400' : n < 0 ? 'text-rose-400' : 'text-slate-400' }
function pnlBg(n: number)    { return n > 0 ? 'bg-emerald-500/10 border-emerald-500/30' : n < 0 ? 'bg-rose-500/10 border-rose-500/30' : 'bg-slate-800/60 border-slate-700/60' }
function wrColor(wr: number)  { return wr >= 75 ? 'text-emerald-400' : wr >= 60 ? 'text-amber-400' : 'text-rose-400' }

function calcCharges(prem: number) {
  const val = prem * LOT_SIZE
  const stt = val * STT_PCT
  const exchange = val * 2 * 0.00053
  const gst = (BROKERAGE + exchange) * 0.18
  return BROKERAGE + stt + exchange + gst
}

// Premium estimate: weekly ATM option ≈ 50-60% of daily ATR
function estimatePremium(atr: number): number {
  return Math.max(70, Math.round(atr * 0.55))
}

// ─── Generate signal from raw bar data (no bar.signal dependency) ─────────────
// Gate 1: Time (daily bar = always ok for backtest)
// Gate 2: EMA9 vs VWAP (trend anchor)
// Gate 3: Close vs VWAP (momentum)
// Gate 4: RSI in healthy zone (not overbought/oversold)
// Gate 5: ATR > 150 (enough volatility for options)

interface BarSignal {
  direction: 'CE' | 'PE' | null
  gates: number
  gateDetails: string[]
  reason: string
}

function getBarSignal(bar: NiftyChartBar): BarSignal {
  // Skip bars where EMA9 = EMA21 = close (insufficient warmup data from server)
  const emaValid = Math.abs(bar.ema9 - bar.ema21) > 5
  const atrValid = bar.atr > 100
  const vwapValid = bar.vwap > 0

  if (!atrValid || !vwapValid) {
    return { direction: null, gates: 0, gateDetails: [], reason: 'Insufficient data' }
  }

  // Gate states
  const g1_time    = true                              // daily = always in window
  const g2_ema     = emaValid ? (bar.ema9 > bar.vwap ? 'bull' : 'bear') : null
  const g3_close   = bar.close > bar.vwap ? 'bull' : 'bear'
  const g4_rsi_ce  = bar.rsi >= 38 && bar.rsi <= 68   // RSI zone for CE
  const g4_rsi_pe  = bar.rsi >= 32 && bar.rsi <= 62   // RSI zone for PE
  const g5_vol     = bar.atr > 150                     // enough volatility

  const bullGates = [
    g1_time,
    g2_ema === 'bull',
    g3_close === 'bull',
    g4_rsi_ce,
    g5_vol,
  ]
  const bearGates = [
    g1_time,
    g2_ema === 'bear',
    g3_close === 'bear',
    g4_rsi_pe,
    g5_vol,
  ]

  const bullCount = bullGates.filter(Boolean).length
  const bearCount = bearGates.filter(Boolean).length

  const details = [
    `Time: ✓`,
    `EMA9 vs VWAP: ${g2_ema ?? 'unclear'}`,
    `Close vs VWAP: ${g3_close}`,
    `RSI ${bar.rsi.toFixed(0)}: ${g4_rsi_ce ? 'ok' : 'out of range'}`,
    `ATR ${bar.atr.toFixed(0)}: ${g5_vol ? 'ok' : 'too low'}`,
  ]

  // Need ≥ 4 gates for a trade
  if (bullCount >= 4 && bullCount >= bearCount) {
    return { direction: 'CE', gates: bullCount, gateDetails: details, reason: `${bullCount}/5 bullish gates` }
  }
  if (bearCount >= 4 && bearCount > bullCount) {
    return { direction: 'PE', gates: bearCount, gateDetails: details, reason: `${bearCount}/5 bearish gates` }
  }
  return {
    direction: null,
    gates: Math.max(bullCount, bearCount),
    gateDetails: details,
    reason: `Only ${Math.max(bullCount, bearCount)}/5 gates (need ≥4)`,
  }
}

// ─── Simulate backtest on chart bars ─────────────────────────────────────────

function runBacktest(bars: NiftyChartBar[]): BacktestDay[] {
  if (!bars || bars.length < 2) return []
  const results: BacktestDay[] = []

  for (let i = 0; i < bars.length - 1; i++) {
    const bar     = bars[i]
    const nextBar = bars[i + 1]

    const sig = getBarSignal(bar)

    if (!sig.direction) {
      results.push({
        date: bar.date, direction: null, signal: 'NO_SIGNAL',
        entry_px: bar.close, exit_px: 0, prem_entry: 0, prem_exit: 0,
        pnl_rs: 0, result: 'NO_TRADE',
        exit_reason: sig.reason,
        gates: sig.gates,
        ema9: bar.ema9, ema21: bar.ema21, vwap: bar.vwap, rsi: bar.rsi, atr: bar.atr,
      })
      continue
    }

    const direction = sig.direction
    const premEntry = estimatePremium(bar.atr)
    const slPremPts = premEntry * SL_PCT           // 20% of premium in ₹
    const t1PremPts = slPremPts * T1_MULT          // 1.5× risk
    const slPrem    = premEntry - slPremPts
    const t1Prem    = premEntry + t1PremPts
    const charges   = calcCharges(premEntry)

    // Convert premium SL/T1 to NIFTY spot pts (delta ≈ 0.45 for ATM)
    const DELTA     = 0.45
    const slSpotPts = slPremPts / DELTA           // spot pts to hit SL
    const t1SpotPts = t1PremPts / DELTA           // spot pts to hit T1

    // We enter at next bar's open and use its intraday H/L to determine outcome
    const entrySpot  = nextBar.open > 0 ? nextBar.open : bar.close
    const intraHigh  = nextBar.high - entrySpot    // max intraday gain
    const intraLow   = entrySpot - nextBar.low     // max intraday loss
    const adjHigh    = direction === 'CE' ? intraHigh : intraLow
    const adjLow     = direction === 'CE' ? intraLow  : intraHigh

    let premExit: number
    let result: BacktestDay['result']
    let exitReason: string

    if (adjHigh >= t1SpotPts && adjHigh >= adjLow) {
      // T1 touched before SL during the day
      premExit   = t1Prem
      result     = 'WIN'
      exitReason = `T1 hit (+${t1SpotPts.toFixed(0)} spot pts)`
    } else if (adjLow >= slSpotPts) {
      // SL touched
      premExit   = slPrem
      result     = 'LOSS'
      exitReason = `SL hit (−${slSpotPts.toFixed(0)} spot pts)`
    } else {
      // Neither T1 nor SL hit → time-stop
      const eodMove  = direction === 'CE' ? (nextBar.close - entrySpot) : (entrySpot - nextBar.close)
      const premMove = eodMove * DELTA * 0.6      // partial premium capture
      premExit       = Math.max(slPrem + 2, premEntry + premMove)
      result         = 'BE'
      exitReason     = `Time SL (${eodMove >= 0 ? '+' : ''}${eodMove.toFixed(0)} pts eod)`
    }

    const pnlPts = premExit - premEntry
    const pnl_rs = pnlPts * LOT_SIZE - charges

    results.push({
      date: bar.date, direction,
      signal: direction === 'CE' ? 'BUY' : 'SELL',
      entry_px: bar.close, exit_px: nextBar.close,
      prem_entry: premEntry, prem_exit: Math.round(premExit),
      pnl_rs: Math.round(pnl_rs),
      result, exit_reason: exitReason,
      gates: sig.gates,
      ema9: bar.ema9, ema21: bar.ema21, vwap: bar.vwap, rsi: bar.rsi, atr: bar.atr,
    })
  }
  return results
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function GatePill({ ok, label }: { ok: boolean; label: string }) {
  return (
    <div className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-xs font-medium ${
      ok ? 'bg-emerald-500/12 border-emerald-500/35 text-emerald-400'
         : 'bg-rose-500/12 border-rose-500/35 text-rose-400'
    }`}>
      <span>{ok ? '✓' : '✗'}</span>
      <span>{label}</span>
    </div>
  )
}

function PulsingDot({ color }: { color: string }) {
  return <span className={`inline-block w-2 h-2 rounded-full ${color} animate-pulse`} />
}

// ─── Live Signal Panel ────────────────────────────────────────────────────────

function LiveSignalPanel({ signal, liveSignals }: { signal: OptionsSignal | null; liveSignals: NiftyScalpSignal[] }) {
  if (!signal) return (
    <div className="bg-slate-800/60 border border-slate-700/60 rounded-2xl p-8 text-center">
      <div className="w-8 h-8 border-2 border-brand-500 border-t-transparent rounded-full animate-spin mx-auto mb-3" />
      <div className="text-slate-400 text-sm">Fetching live NIFTY signal…</div>
    </div>
  )

  const isBuy   = signal.signal === 'CE_BUY'
  const isSell  = signal.signal === 'PE_BUY'
  const isWait  = !isBuy && !isSell

  // Derive gate states from factors
  const f = signal.factors ?? []
  const fMap: Record<string, boolean> = {}
  f.forEach(fac => { fMap[fac.name.toLowerCase()] = fac.ok })

  const gates = [
    { label: 'Supertrend', ok: fMap['supertrend (7,3)'] ?? false },
    { label: 'EMA 9/21',   ok: fMap['ema 9 / 21'] ?? false },
    { label: 'VWAP',       ok: fMap['vwap'] ?? false },
    { label: 'RSI',        ok: fMap['rsi (14)'] ?? false },
    { label: 'Volume',     ok: fMap['volume'] ?? false },
  ]

  const openGates = gates.filter(g => g.ok).length
  const premEntry = signal.entry
  const slPrem    = premEntry * (1 - SL_PCT)
  const slDelta   = premEntry - slPrem
  const t1Prem    = premEntry + slDelta * T1_MULT
  const t2Prem    = premEntry + slDelta * T2_MULT
  const charges   = calcCharges(premEntry)
  const maxLoss   = slDelta * LOT_SIZE + charges
  const t1Profit  = (t1Prem - premEntry) * LOT_SIZE - charges
  const t2Profit  = (t2Prem - premEntry) * LOT_SIZE - charges

  const dirColor = isBuy ? 'emerald' : isSell ? 'rose' : 'slate'

  return (
    <div className={`rounded-2xl border overflow-hidden ${
      isBuy  ? 'border-emerald-500/30 bg-emerald-500/5' :
      isSell ? 'border-rose-500/30 bg-rose-500/5' :
               'border-slate-700/60 bg-slate-800/40'
    }`}>
      {/* Header bar */}
      <div className={`px-5 py-4 border-b flex items-center justify-between ${
        isBuy  ? 'border-emerald-500/20' :
        isSell ? 'border-rose-500/20' :
                 'border-slate-700/40'
      }`}>
        <div className="flex items-center gap-3">
          <PulsingDot color={isBuy ? 'bg-emerald-400' : isSell ? 'bg-rose-400' : 'bg-slate-500'} />
          <span className="font-bold text-white text-base">
            {isBuy ? '📈 BUY CALL (CE)' : isSell ? '📉 BUY PUT (PE)' : '⏸ WAIT — No Setup'}
          </span>
        </div>
        <div className="flex items-center gap-3">
          <span className={`text-sm font-bold px-3 py-1 rounded-full border ${
            signal.confidence >= 70
              ? 'bg-emerald-500/15 border-emerald-500/35 text-emerald-400'
              : signal.confidence >= 50
                ? 'bg-amber-500/15 border-amber-500/35 text-amber-400'
                : 'bg-rose-500/15 border-rose-500/35 text-rose-400'
          }`}>{signal.confidence.toFixed(0)}% confidence</span>
          <span className="text-xs text-slate-500">{openGates}/5 gates</span>
        </div>
      </div>

      {/* Gates strip */}
      <div className="px-5 py-3 flex flex-wrap gap-2 border-b border-slate-800/60">
        {gates.map(g => <GatePill key={g.label} ok={g.ok} label={g.label} />)}
      </div>

      {/* Main content */}
      <div className="p-5">
        {isWait ? (
          <div className="text-center py-6">
            <div className="text-4xl mb-3">⏳</div>
            <div className="font-bold text-slate-300 text-lg mb-1">No setup — Stand aside</div>
            <div className="text-slate-500 text-sm">
              Only {openGates}/5 conditions met. Need all 5 green. Check back in 5 minutes.
            </div>
            <div className="mt-4 text-xs text-amber-400">
              ⚠️ Trading without a setup is gambling. Your rule: skip if score &lt; 8/10.
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
            {/* Left: 1-lot price levels */}
            <div>
              <div className="text-xs text-slate-500 uppercase tracking-widest mb-3">
                1-Lot Trade Levels ({LOT_SIZE} units)
              </div>
              <div className="space-y-2">
                {[
                  {
                    label: '📥 Entry Premium',
                    value: `₹${premEntry.toFixed(1)}`,
                    sub: `Total cost: ₹${fmtN(premEntry * LOT_SIZE)}`,
                    accent: 'text-white',
                    highlight: true,
                  },
                  {
                    label: `🛑 Stop Loss (${(SL_PCT * 100).toFixed(0)}%)`,
                    value: `₹${slPrem.toFixed(1)}`,
                    sub: `Max loss: ₹${fmtN(maxLoss)} · −${(SL_PCT * 100).toFixed(0)}% prem`,
                    accent: 'text-rose-400',
                    highlight: false,
                  },
                  {
                    label: '⏱ Time SL',
                    value: '90 seconds',
                    sub: 'Exit at market if no profit in 90s',
                    accent: 'text-amber-400',
                    highlight: false,
                  },
                  {
                    label: '🎯 Target 1 (exit 50%)',
                    value: `₹${t1Prem.toFixed(1)}`,
                    sub: `Profit: +₹${fmtN(t1Profit)} · R:R 1:${T1_MULT}`,
                    accent: 'text-emerald-400',
                    highlight: false,
                  },
                  {
                    label: '🚀 Target 2 (exit 50%)',
                    value: `₹${t2Prem.toFixed(1)}`,
                    sub: `Profit: +₹${fmtN(t2Profit)} · R:R 1:${T2_MULT}`,
                    accent: 'text-emerald-400',
                    highlight: false,
                  },
                ].map(item => (
                  <div key={item.label} className={`flex justify-between items-start px-3 py-2.5 rounded-lg ${
                    item.highlight ? 'bg-slate-700/60 border border-slate-600/60' : 'bg-slate-900/40'
                  }`}>
                    <div>
                      <div className="text-xs text-slate-500">{item.label}</div>
                      {item.sub && <div className="text-[11px] text-slate-600 mt-0.5">{item.sub}</div>}
                    </div>
                    <div className={`text-base font-bold tabular-nums ${item.accent}`}>{item.value}</div>
                  </div>
                ))}
              </div>
            </div>

            {/* Right: execution guide */}
            <div className="space-y-3">
              <div className={`rounded-xl p-4 border text-center ${
                isBuy ? 'bg-emerald-500/10 border-emerald-500/30' : 'bg-rose-500/10 border-rose-500/30'
              }`}>
                <div className="text-xs text-slate-500 mb-1">Strike to buy</div>
                <div className={`text-2xl font-bold ${isBuy ? 'text-emerald-400' : 'text-rose-400'}`}>
                  {signal.strike ?? 'ATM'} {isBuy ? 'CE' : 'PE'}
                </div>
                <div className="text-xs text-slate-500 mt-1">Expiry: {signal.expiry ?? 'Weekly'}</div>
              </div>

              <div className="bg-slate-900/60 rounded-xl p-4 space-y-2">
                <div className="text-xs text-slate-500 uppercase tracking-widest mb-2">Execution Steps</div>
                {[
                  `Open Zerodha → Search ${signal.strike ?? 'ATM'} ${isBuy ? 'CE' : 'PE'}`,
                  `Place LIMIT BUY at ₹${premEntry.toFixed(0)} · Qty: ${LOT_SIZE} (1 lot)`,
                  `Immediately set SL order at ₹${slPrem.toFixed(0)}`,
                  'Start 90-second timer on phone now',
                  `T1 at ₹${t1Prem.toFixed(0)} → exit 50% · move SL to ₹${premEntry.toFixed(0)}`,
                  `T2 at ₹${t2Prem.toFixed(0)} → exit remaining 50%`,
                ].map((step, i) => (
                  <div key={i} className="flex items-start gap-2 text-sm">
                    <span className="text-slate-600 font-mono text-xs mt-0.5 w-4 flex-shrink-0">{i + 1}.</span>
                    <span className="text-slate-300">{step}</span>
                  </div>
                ))}
              </div>

              <div className="bg-amber-500/8 border border-amber-500/25 rounded-xl p-3 text-xs text-amber-300">
                💸 Charges this trade: ≈ ₹{charges.toFixed(0)} (brokerage + STT + exchange)
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Live signals from strategies */}
      {liveSignals.length > 0 && (
        <div className="border-t border-slate-800/60 px-5 py-3">
          <div className="text-xs text-slate-500 mb-2 uppercase tracking-widest">Additional strategy signals</div>
          <div className="flex flex-wrap gap-2">
            {liveSignals.slice(0, 4).map((s, i) => (
              <div key={i} className={`text-xs px-2.5 py-1 rounded-full border ${
                s.signal === 'BUY' ? 'border-emerald-500/30 text-emerald-400 bg-emerald-500/8' :
                s.signal === 'SELL' ? 'border-rose-500/30 text-rose-400 bg-rose-500/8' :
                'border-slate-700 text-slate-500'
              }`}>
                {s.strategy}: {s.signal === 'BUY' ? '↑ CE' : s.signal === 'SELL' ? '↓ PE' : 'WAIT'}
                {s.confidence > 0 && ` · ${s.confidence.toFixed(0)}%`}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Live Trade Tracker ───────────────────────────────────────────────────────

function LiveTracker({ signal }: { signal: OptionsSignal | null }) {
  const [trade, setTrade]   = useState<LiveTrade | null>(null)
  const [elapsed, setElapsed] = useState(0)
  const [currentPrem, setCurrentPrem] = useState('')
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const startTrade = useCallback((dir: 'CE' | 'PE', entry: number) => {
    if (timerRef.current) clearInterval(timerRef.current)
    const sl = entry * (1 - SL_PCT)
    const t1 = entry + (entry - sl) * T1_MULT
    const t2 = entry + (entry - sl) * T2_MULT
    setElapsed(0)
    setTrade({ active: true, direction: dir, entry, sl, t1, t2, startSec: Date.now(), status: 'live', current: entry })
    timerRef.current = setInterval(() => setElapsed(s => s + 1), 1000)
  }, [])

  const exitTrade = useCallback(() => {
    if (timerRef.current) clearInterval(timerRef.current)
    setTrade(null)
    setElapsed(0)
    setCurrentPrem('')
  }, [])

  useEffect(() => () => { if (timerRef.current) clearInterval(timerRef.current) }, [])

  // Update current premium from input
  const cur = parseFloat(currentPrem) || (trade?.entry ?? 0)

  useEffect(() => {
    if (!trade || !trade.active) return
    const current = cur
    let status: LiveTrade['status'] = 'live'
    if (current <= trade.sl) status = 'hit_sl'
    else if (current >= trade.t2) status = 'hit_t2'
    else if (current >= trade.t1) status = 'hit_t1'
    else if (elapsed >= MAX_HOLD && current < trade.entry) status = 'time_sl'
    setTrade(prev => prev ? { ...prev, status, current } : null)
  }, [cur, elapsed, trade?.sl, trade?.t1, trade?.t2, trade?.entry])

  const pnlPts = trade ? cur - trade.entry : 0
  const pnlRs  = trade ? pnlPts * LOT_SIZE - calcCharges(trade.entry) : 0
  const mins   = Math.floor(elapsed / 60)
  const secs   = elapsed % 60
  const timeAlert = elapsed >= MAX_HOLD

  const isBuy  = signal?.signal === 'CE_BUY'
  const isSell = signal?.signal === 'PE_BUY'
  const entryPrem = signal?.entry ?? 0

  if (!trade) {
    return (
      <div className="bg-slate-800/60 border border-slate-700/60 rounded-2xl p-5">
        <div className="text-sm font-semibold text-slate-300 mb-4 flex items-center gap-2">
          <PulsingDot color="bg-slate-500" />
          Live Trade Tracker
        </div>
        <div className="text-xs text-slate-500 mb-4">When you enter a trade, click the button to start tracking P&L and the 90-second timer.</div>
        <div className="flex gap-3 flex-wrap">
          <button
            onClick={() => startTrade('CE', entryPrem)}
            disabled={!isBuy || entryPrem === 0}
            className={`flex-1 py-3 rounded-xl font-bold text-sm border transition-colors ${
              isBuy && entryPrem > 0
                ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-400 hover:bg-emerald-500/25'
                : 'bg-slate-700/30 border-slate-700 text-slate-600 cursor-not-allowed'
            }`}
          >
            ▶ Entered CE Trade
          </button>
          <button
            onClick={() => startTrade('PE', entryPrem)}
            disabled={!isSell || entryPrem === 0}
            className={`flex-1 py-3 rounded-xl font-bold text-sm border transition-colors ${
              isSell && entryPrem > 0
                ? 'bg-rose-500/15 border-rose-500/40 text-rose-400 hover:bg-rose-500/25'
                : 'bg-slate-700/30 border-slate-700 text-slate-600 cursor-not-allowed'
            }`}
          >
            ▶ Entered PE Trade
          </button>
        </div>
        {!isBuy && !isSell && (
          <div className="text-xs text-amber-400 mt-3 text-center">⚠️ No active signal — tracking disabled</div>
        )}
      </div>
    )
  }

  // Status display
  const STATUS_MAP: Record<LiveTrade['status'], { label: string; color: string; bg: string; action: string }> = {
    live:    { label: '🟢 IN TRADE',     color: 'text-emerald-400', bg: 'bg-emerald-500/10 border-emerald-500/30', action: 'Hold. Watch timer and levels.' },
    hit_t1:  { label: '🎯 T1 HIT!',      color: 'text-emerald-400', bg: 'bg-emerald-500/15 border-emerald-500/40', action: 'Exit 50% NOW. Move SL to entry.' },
    hit_t2:  { label: '🚀 T2 HIT!',      color: 'text-emerald-400', bg: 'bg-emerald-500/20 border-emerald-500/50', action: 'Exit remaining 50%. Trade complete.' },
    hit_sl:  { label: '🛑 SL HIT',       color: 'text-rose-400',    bg: 'bg-rose-500/15 border-rose-500/40',    action: 'EXIT NOW. Full position. Walk away.' },
    time_sl: { label: '⏱ TIME SL!',      color: 'text-amber-400',   bg: 'bg-amber-500/15 border-amber-500/40',   action: 'Exit at market. 90s elapsed with loss.' },
  }
  const status = STATUS_MAP[trade.status]

  return (
    <div className={`rounded-2xl border overflow-hidden ${status.bg}`}>
      {/* Status bar */}
      <div className={`px-5 py-3 border-b ${status.bg} flex items-center justify-between`}>
        <div className={`font-bold text-lg ${status.color}`}>{status.label}</div>
        <div className="flex items-center gap-3">
          <div className={`font-mono text-xl font-bold tabular-nums ${timeAlert ? 'text-red-400 animate-pulse' : 'text-white'}`}>
            {String(mins).padStart(2, '0')}:{String(secs).padStart(2, '0')}
          </div>
          <div className="text-xs text-slate-500">/ 1:30</div>
        </div>
      </div>

      {/* Timer bar */}
      <div className="h-1 bg-slate-800">
        <div
          className={`h-full transition-all ${elapsed >= 90 ? 'bg-red-500' : elapsed >= 60 ? 'bg-amber-500' : 'bg-emerald-500'}`}
          style={{ width: `${Math.min(100, (elapsed / MAX_HOLD) * 100)}%` }}
        />
      </div>

      <div className="p-5 space-y-4">
        {/* Action */}
        <div className={`text-sm font-medium ${status.color}`}>{status.action}</div>

        {/* Current premium input */}
        <div>
          <label className="text-xs text-slate-500 mb-1.5 block">Current Premium (update as it changes)</label>
          <input
            type="number"
            value={currentPrem}
            onChange={e => setCurrentPrem(e.target.value)}
            placeholder={`Entry: ₹${trade.entry.toFixed(1)}`}
            step="0.5"
            className={`w-full bg-slate-900/60 border rounded-xl px-4 py-3 text-xl font-bold focus:outline-none tabular-nums ${
              cur <= trade.sl ? 'border-red-500/60 text-red-400' :
              cur >= trade.t1 ? 'border-emerald-500/60 text-emerald-400' :
              'border-slate-700 text-white focus:border-brand-500'
            }`}
          />
        </div>

        {/* P&L */}
        <div className={`rounded-xl p-4 text-center border ${pnlBg(pnlRs)}`}>
          <div className="text-xs text-slate-500 mb-1">Live P&L (1 lot)</div>
          <div className={`text-3xl font-bold tabular-nums ${pnlColor(pnlRs)}`}>
            {pnlRs >= 0 ? '+' : ''}₹{fmtN(pnlRs)}
          </div>
          <div className={`text-sm mt-1 ${pnlColor(pnlPts)}`}>
            {pnlPts >= 0 ? '+' : ''}{pnlPts.toFixed(1)} pts
          </div>
        </div>

        {/* Level indicator */}
        <div className="space-y-1.5 text-xs">
          {[
            { label: 'T2', val: trade.t2, color: 'text-emerald-400' },
            { label: 'T1', val: trade.t1, color: 'text-emerald-400' },
            { label: 'Entry', val: trade.entry, color: 'text-white' },
            { label: 'SL', val: trade.sl, color: 'text-rose-400' },
          ].map(level => {
            const isCur = Math.abs(cur - level.val) < trade.entry * 0.01
            return (
              <div key={level.label} className={`flex items-center gap-2 ${isCur ? 'opacity-100' : 'opacity-60'}`}>
                <span className={`font-mono w-10 font-bold ${level.color}`}>{level.label}</span>
                <span className="font-mono text-slate-300 flex-1">₹{level.val.toFixed(1)}</span>
                {isCur && <span className="text-white font-bold">← here</span>}
              </div>
            )
          })}
        </div>

        {/* Exit button */}
        <button
          onClick={exitTrade}
          className="w-full py-3 bg-rose-500/15 border border-rose-500/40 text-rose-400 hover:bg-rose-500/25 rounded-xl font-bold text-sm transition-colors"
        >
          ■ Close Trade & Reset
        </button>
      </div>
    </div>
  )
}

// ─── Backtest Results ─────────────────────────────────────────────────────────

function BacktestPanel({ bars }: { bars: NiftyChartBar[] }) {
  const [showAll, setShowAll] = useState(false)
  const [showNoTrade, setShowNoTrade] = useState(false)

  if (bars.length === 0) return (
    <div className="bg-slate-800/60 border border-slate-700/60 rounded-2xl p-12 text-center space-y-3">
      <div className="w-8 h-8 border-2 border-brand-500 border-t-transparent rounded-full animate-spin mx-auto" />
      <div className="text-slate-400 text-sm">Loading NIFTY chart data…</div>
      <div className="text-slate-600 text-xs">Fetching from backend · This may take a moment</div>
    </div>
  )

  const allDays  = runBacktest(bars)
  const traded   = allDays.filter(d => d.result !== 'NO_TRADE')
  const wins     = traded.filter(d => d.result === 'WIN')
  const losses   = traded.filter(d => d.result === 'LOSS')
  const bes      = traded.filter(d => d.result === 'BE')
  const wr       = traded.length ? (wins.length / traded.length) * 100 : 0
  const totalPnl = allDays.reduce((s, d) => s + d.pnl_rs, 0)
  const avgWin   = wins.length ? wins.reduce((s, d) => s + d.pnl_rs, 0) / wins.length : 0
  const avgLoss  = losses.length ? losses.reduce((s, d) => s + d.pnl_rs, 0) / losses.length : 0
  const maxWin   = wins.length ? Math.max(...wins.map(d => d.pnl_rs)) : 0
  const maxLoss  = losses.length ? Math.min(...losses.map(d => d.pnl_rs)) : 0
  const rr       = avgLoss !== 0 ? Math.abs(avgWin / avgLoss) : 0

  const displayRows = (showAll ? allDays : allDays.slice(-20))
    .filter(d => showNoTrade || d.result !== 'NO_TRADE')

  // Running equity curve (all days incl. 0-pnl no-trade days)
  let equity = 0
  const equityCurve: { x: number; y: number; date: string; pnl: number }[] = []
  allDays.forEach((d, i) => {
    equity += d.pnl_rs
    equityCurve.push({ x: i, y: equity, date: d.date.slice(5), pnl: d.pnl_rs })
  })
  const eqMax = Math.max(...equityCurve.map(p => p.y), 1)
  const eqMin = Math.min(...equityCurve.map(p => p.y), 0)
  const eqRange = eqMax - eqMin || 1
  const W = equityCurve.length - 1 || 1

  return (
    <div className="space-y-4">
      {/* Data info bar */}
      <div className="flex items-center gap-3 text-xs text-slate-500 bg-slate-800/40 border border-slate-700/40 rounded-xl px-4 py-2.5">
        <span>📊 {allDays.length} trading days analysed</span>
        <span className="text-slate-700">·</span>
        <span className="text-brand-400">{traded.length} setups found</span>
        <span className="text-slate-700">·</span>
        <span className="text-slate-500">{allDays.length - traded.length} days skipped (gates failed)</span>
        <span className="text-slate-700 hidden sm:inline">·</span>
        <span className="text-slate-600 hidden sm:inline">Simulation: ATM weekly option, 1 lot (65 units)</span>
      </div>

      {/* Summary KPIs */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          {
            label: 'Win Rate',
            value: traded.length ? `${wr.toFixed(1)}%` : '—',
            accent: wrColor(wr),
            sub: `${wins.length}W · ${losses.length}L · ${bes.length}BE`,
          },
          {
            label: 'Net P&L · 1 Lot',
            value: totalPnl !== 0 ? `${totalPnl >= 0 ? '+' : ''}₹${fmtN(Math.abs(totalPnl))}` : '₹0',
            accent: pnlColor(totalPnl),
            sub: `${traded.length} trades taken`,
          },
          {
            label: 'Avg Win',
            value: avgWin > 0 ? `+₹${fmtN(avgWin)}` : '—',
            accent: 'text-emerald-400',
            sub: `Best: +₹${fmtN(maxWin)}`,
          },
          {
            label: 'Avg Loss',
            value: avgLoss < 0 ? `−₹${fmtN(Math.abs(avgLoss))}` : '—',
            accent: 'text-rose-400',
            sub: `Worst: −₹${fmtN(Math.abs(maxLoss))}`,
          },
        ].map(item => (
          <div key={item.label} className="bg-slate-800/60 border border-slate-700/60 rounded-xl p-4">
            <div className="text-xs text-slate-500 mb-1">{item.label}</div>
            <div className={`text-2xl font-bold tabular-nums ${item.accent}`}>{item.value}</div>
            <div className="text-xs text-slate-600 mt-0.5">{item.sub}</div>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          { label: 'R:R Ratio', value: rr > 0 ? `1 : ${rr.toFixed(2)}` : '—', accent: rr >= 1.2 ? 'text-emerald-400' : 'text-rose-400' },
          { label: 'Win Streak', value: (() => { let m=0,c=0; traded.forEach(d=>{if(d.result==='WIN'){c++;m=Math.max(m,c)}else c=0}); return String(m) })(), accent: 'text-emerald-400' },
          { label: 'Loss Streak', value: (() => { let m=0,c=0; traded.forEach(d=>{if(d.result==='LOSS'){c++;m=Math.max(m,c)}else c=0}); return String(m) })(), accent: 'text-rose-400' },
          { label: 'Days Skipped', value: String(allDays.length - traded.length), accent: 'text-amber-400' },
        ].map(item => (
          <div key={item.label} className="bg-slate-800/60 border border-slate-700/60 rounded-xl p-3 text-center">
            <div className={`text-xl font-bold tabular-nums ${item.accent}`}>{item.value}</div>
            <div className="text-xs text-slate-500 mt-0.5">{item.label}</div>
          </div>
        ))}
      </div>

      {/* Equity Curve */}
      {equityCurve.length > 1 && (
        <div className="bg-slate-800/60 border border-slate-700/60 rounded-2xl p-5">
          <div className="flex items-center justify-between mb-4">
            <div className="text-sm font-semibold text-slate-300">📈 Cumulative P&L Curve</div>
            <div className={`text-sm font-bold tabular-nums ${pnlColor(totalPnl)}`}>
              {totalPnl >= 0 ? '+' : ''}₹{fmtN(Math.abs(totalPnl))} total
            </div>
          </div>
          <div className="relative h-36">
            {/* Y-axis labels */}
            <div className="absolute left-0 top-0 bottom-0 flex flex-col justify-between text-[10px] text-slate-600 font-mono pr-2 w-14">
              <span>+₹{fmtN(eqMax)}</span>
              <span>₹0</span>
              {eqMin < 0 && <span>-₹{fmtN(Math.abs(eqMin))}</span>}
            </div>
            <div className="ml-14 h-full relative">
              <svg viewBox={`0 0 ${W} 100`} preserveAspectRatio="none" className="w-full h-full">
                <defs>
                  <linearGradient id="eqG" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={totalPnl >= 0 ? '#10b981' : '#ef4444'} stopOpacity="0.25" />
                    <stop offset="100%" stopColor={totalPnl >= 0 ? '#10b981' : '#ef4444'} stopOpacity="0.02" />
                  </linearGradient>
                </defs>
                {/* Zero line */}
                <line
                  x1="0" x2={W}
                  y1={100 - ((0 - eqMin) / eqRange) * 100}
                  y2={100 - ((0 - eqMin) / eqRange) * 100}
                  stroke="#475569" strokeWidth="0.5" strokeDasharray="3 3"
                />
                {/* Area fill */}
                <polygon
                  points={[
                    `0,${100 - ((0 - eqMin) / eqRange) * 100}`,
                    ...equityCurve.map(p => `${p.x},${100 - ((p.y - eqMin) / eqRange) * 100}`),
                    `${W},${100 - ((0 - eqMin) / eqRange) * 100}`,
                  ].join(' ')}
                  fill="url(#eqG)"
                />
                {/* Line */}
                <polyline
                  points={equityCurve.map(p => `${p.x},${100 - ((p.y - eqMin) / eqRange) * 100}`).join(' ')}
                  fill="none"
                  stroke={totalPnl >= 0 ? '#10b981' : '#ef4444'}
                  strokeWidth="1.5"
                  strokeLinejoin="round"
                />
                {/* Dots for traded days */}
                {equityCurve.filter((_p, i) => allDays[i]?.result !== 'NO_TRADE').map((p, idx) => (
                  <circle
                    key={idx}
                    cx={p.x} cy={100 - ((p.y - eqMin) / eqRange) * 100}
                    r="2"
                    fill={p.pnl > 0 ? '#10b981' : p.pnl < 0 ? '#ef4444' : '#f59e0b'}
                  />
                ))}
              </svg>
            </div>
          </div>
          {/* X-axis date labels */}
          <div className="ml-14 flex justify-between text-[10px] text-slate-600 font-mono mt-1">
            <span>{equityCurve[0]?.date}</span>
            <span>{equityCurve[Math.floor(equityCurve.length / 2)]?.date}</span>
            <span>{equityCurve[equityCurve.length - 1]?.date}</span>
          </div>
        </div>
      )}

      {/* No-trade days insight */}
      {traded.length === 0 && (
        <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl p-5 text-center">
          <div className="text-2xl mb-2">🔍</div>
          <div className="font-bold text-amber-300">No qualifying setups in this period</div>
          <div className="text-slate-400 text-sm mt-2">
            The 5-gate filter requires: EMA9 above/below VWAP + Close on correct VWAP side + RSI in 38–68 range + ATR &gt; 150.
            All {allDays.length} days had at least one gate failing. This is the filter working — it prevents low-quality trades.
          </div>
        </div>
      )}

      {/* Trade table */}
      <div className="bg-slate-800/60 border border-slate-700/60 rounded-2xl overflow-hidden">
        <div className="p-4 border-b border-slate-700/60 flex items-center gap-3 flex-wrap">
          <div className="text-sm font-semibold text-slate-300 flex-1">📅 Day-by-Day Simulation</div>
          <button
            onClick={() => setShowNoTrade(v => !v)}
            className={`text-xs border px-2.5 py-1 rounded-lg transition-colors ${
              showNoTrade ? 'bg-slate-700 text-slate-300 border-slate-600' : 'text-slate-500 border-slate-700 hover:text-slate-300'
            }`}
          >
            {showNoTrade ? '✓ Showing all days' : 'Show no-trade days'}
          </button>
          <button
            onClick={() => setShowAll(v => !v)}
            className="text-xs text-brand-400 border border-brand-600/30 px-2.5 py-1 rounded-lg hover:text-brand-300"
          >
            {showAll ? 'Last 20' : `All ${allDays.length} days`}
          </button>
        </div>

        {displayRows.length === 0 ? (
          <div className="p-8 text-center text-slate-500 text-sm">
            No trades to display. Toggle "Show no-trade days" to see all sessions.
          </div>
        ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-slate-700/60 text-[11px] text-slate-500 bg-slate-900/40">
                <th className="text-left p-3 pl-4">Date</th>
                <th className="text-center p-3">Dir</th>
                <th className="text-right p-3">NIFTY</th>
                <th className="text-right p-3">Prem In</th>
                <th className="text-right p-3">Prem Out</th>
                <th className="text-center p-3">RSI</th>
                <th className="text-center p-3">Gates</th>
                <th className="text-center p-3">Exit</th>
                <th className="text-right p-3 pr-4">P&L</th>
              </tr>
            </thead>
            <tbody>
              {displayRows.map((d, i) => (
                <tr
                  key={i}
                  className={`border-b border-slate-800/40 hover:bg-slate-700/15 transition-colors ${
                    d.result === 'WIN'      ? 'bg-emerald-500/3' :
                    d.result === 'LOSS'     ? 'bg-rose-500/3' :
                    d.result === 'NO_TRADE' ? 'opacity-35' : ''
                  }`}
                >
                  <td className="p-3 pl-4 font-mono text-slate-400 text-[11px]">{d.date}</td>
                  <td className="p-3 text-center">
                    {d.direction
                      ? <span className={`font-bold text-xs px-1.5 py-0.5 rounded ${
                          d.direction === 'CE'
                            ? 'bg-emerald-500/15 text-emerald-400'
                            : 'bg-rose-500/15 text-rose-400'
                        }`}>{d.direction}</span>
                      : <span className="text-slate-700 text-[10px]">—</span>}
                  </td>
                  <td className="p-3 text-right font-mono text-slate-400 text-[11px]">
                    {d.entry_px.toFixed(0)}
                  </td>
                  <td className="p-3 text-right font-mono text-slate-300">
                    {d.prem_entry > 0 ? `₹${d.prem_entry}` : <span className="text-slate-700">—</span>}
                  </td>
                  <td className="p-3 text-right font-mono">
                    {d.prem_exit > 0
                      ? <span className={d.prem_exit > d.prem_entry ? 'text-emerald-400' : d.prem_exit < d.prem_entry ? 'text-rose-400' : 'text-slate-400'}>
                          ₹{d.prem_exit}
                        </span>
                      : <span className="text-slate-700">—</span>}
                  </td>
                  <td className={`p-3 text-center font-mono text-[11px] ${
                    d.rsi >= 38 && d.rsi <= 68 ? 'text-emerald-400' : 'text-rose-400'
                  }`}>{d.rsi.toFixed(0)}</td>
                  <td className="p-3 text-center">
                    <span className={`text-[11px] font-bold ${
                      d.gates >= 4 ? 'text-emerald-400' : d.gates >= 3 ? 'text-amber-400' : 'text-rose-400'
                    }`}>{d.gates}/5</span>
                  </td>
                  <td className="p-3 text-center text-[10px] text-slate-500 max-w-[100px] truncate">
                    {d.exit_reason}
                  </td>
                  <td className={`p-3 pr-4 text-right font-bold tabular-nums ${
                    d.result === 'WIN'  ? 'text-emerald-400' :
                    d.result === 'LOSS' ? 'text-rose-400' :
                    d.result === 'BE'   ? 'text-amber-400' :
                    'text-slate-700'
                  }`}>
                    {d.result === 'NO_TRADE'
                      ? <span className="text-slate-700 font-normal">no trade</span>
                      : `${d.pnl_rs >= 0 ? '+' : ''}₹${fmtN(Math.abs(d.pnl_rs))}`}
                  </td>
                </tr>
              ))}
            </tbody>
            {traded.length > 0 && (
              <tfoot>
                <tr className="border-t border-slate-600/60 bg-slate-800/60">
                  <td colSpan={8} className="p-3 pl-4 text-xs text-slate-500">
                    {traded.length} trades · {wins.length} wins · {losses.length} losses · {bes.length} BE
                  </td>
                  <td className={`p-3 pr-4 text-right font-bold text-sm ${pnlColor(totalPnl)}`}>
                    {totalPnl >= 0 ? '+' : ''}₹{fmtN(Math.abs(totalPnl))}
                  </td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
        )}
        <div className="px-4 py-2.5 bg-slate-900/40 border-t border-slate-800 text-[11px] text-slate-600">
          ⚠️ Simulated backtest. Premium = ATR × 0.55. Win if NIFTY moves &gt;40% ATR in signal direction. Loss if moves &gt;25% ATR against.
          Not real options data — actual premium moves may vary. Use as directional guide only.
        </div>
      </div>
    </div>
  )
}

// ─── Main Page ────────────────────────────────────────────────────────────────

type Tab = 'live' | 'tracker' | 'backtest'

export default function OneLotStrategy() {
  const [tab, setTab] = useState<Tab>('live')
  const [signal, setSignal]       = useState<OptionsSignal | null>(null)
  const [liveSignals, setLiveSignals] = useState<NiftyScalpSignal[]>([])
  const [chartBars, setChartBars] = useState<NiftyChartBar[]>([])
  const [loading, setLoading]     = useState(true)
  const [lastRefresh, setLastRefresh] = useState<Date>(new Date())
  const [error, setError]         = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [sig, live, chart] = await Promise.all([
        getOptionsSignal(),
        getNiftyLiveSignals('5m'),
        getNiftyChartData(45, 'Triple Trend Momentum', 'daily', '^NSEI'),
      ])
      setSignal(sig)
      setLiveSignals(live.signals ?? [])
      setChartBars(chart.bars ?? [])
      setLastRefresh(new Date())
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load live data')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  // Auto-refresh every 5 minutes
  useEffect(() => {
    const id = setInterval(() => load(), 5 * 60 * 1000)
    return () => clearInterval(id)
  }, [load])

  const isBuy  = signal?.signal === 'CE_BUY'
  const isSell = signal?.signal === 'PE_BUY'

  const TABS = [
    { id: 'live' as Tab,     label: '📡 Live Signal',   sub: 'Entry · SL · Targets' },
    { id: 'tracker' as Tab,  label: '⏱ Trade Tracker',  sub: 'Live P&L + timer' },
    { id: 'backtest' as Tab, label: '📊 30-Day Backtest', sub: 'Simulated results' },
  ]

  return (
    <div className="min-h-screen bg-slate-950 text-slate-200 p-4 md:p-6">
      <div className="max-w-5xl mx-auto space-y-5">

        {/* Header */}
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <h1 className="text-2xl font-bold text-white">⚡ 1-Lot Strategy — Live</h1>
              <div className={`px-2 py-0.5 rounded-full text-xs font-bold border ${
                isBuy  ? 'bg-emerald-500/20 border-emerald-500/40 text-emerald-400' :
                isSell ? 'bg-rose-500/20 border-rose-500/40 text-rose-400' :
                         'bg-slate-700/40 border-slate-600 text-slate-400'
              }`}>
                {loading ? '…' : isBuy ? '↑ CE SIGNAL' : isSell ? '↓ PE SIGNAL' : 'WAIT'}
              </div>
            </div>
            <p className="text-slate-500 text-sm">
              5-gate filter · 20% SL · 90-sec time-stop · 1 lot only · 3 trades max/day
            </p>
          </div>
          <div className="flex items-center gap-3">
            <div className="text-xs text-slate-600">
              Last: {lastRefresh.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}
            </div>
            <button
              onClick={load}
              disabled={loading}
              className="px-4 py-2 bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded-lg text-sm text-slate-300 transition-colors disabled:opacity-50"
            >
              {loading ? '⟳ Loading…' : '↻ Refresh'}
            </button>
          </div>
        </div>

        {error && (
          <div className="bg-rose-500/10 border border-rose-500/30 rounded-xl p-4 text-rose-400 text-sm">
            ⚠️ {error} — Backend may be down. Check Go server.
          </div>
        )}

        {/* 1-lot rules quick-ref */}
        <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
          {[
            { label: 'Lots', value: '1 only', color: 'text-brand-400' },
            { label: 'SL', value: '20% prem', color: 'text-rose-400' },
            { label: 'Time SL', value: '90 secs', color: 'text-amber-400' },
            { label: 'T1 exit', value: '50%', color: 'text-emerald-400' },
            { label: 'Max/day', value: '3 trades', color: 'text-sky-400' },
            { label: 'Window', value: '10–2:30', color: 'text-violet-400' },
          ].map(item => (
            <div key={item.label} className="bg-slate-800/60 border border-slate-700/40 rounded-xl p-2.5 text-center">
              <div className={`text-sm font-bold ${item.color}`}>{item.value}</div>
              <div className="text-[10px] text-slate-600 mt-0.5">{item.label}</div>
            </div>
          ))}
        </div>

        {/* Tab bar */}
        <div className="flex gap-1.5 bg-slate-900/60 p-1.5 rounded-xl border border-slate-800">
          {TABS.map(t => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`flex-1 py-2.5 px-3 rounded-lg text-sm transition-colors text-center ${
                tab === t.id
                  ? 'bg-brand-600/20 text-brand-400 border border-brand-600/30'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
              }`}
            >
              <div className="font-medium">{t.label}</div>
              <div className="text-[10px] opacity-50 mt-0.5">{t.sub}</div>
            </button>
          ))}
        </div>

        {/* Tab content */}
        {tab === 'live' && (
          <LiveSignalPanel signal={signal} liveSignals={liveSignals} />
        )}

        {tab === 'tracker' && (
          <LiveTracker signal={signal} />
        )}

        {tab === 'backtest' && (
          <BacktestPanel bars={chartBars} />
        )}

        {/* Daily rules reminder */}
        <div className="bg-slate-900/40 border border-slate-800/60 rounded-xl p-4">
          <div className="text-xs text-slate-600 uppercase tracking-widest mb-3">📌 Today's Rules (read before every session)</div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
            {[
              '⏰ No trades before 10:00 AM — no exceptions',
              '🎯 Only enter when 5/5 gates are green',
              '🛑 SL = 20% of premium — set it before entry',
              '⏱ Exit if no profit after 90 seconds',
              '📈 T1 hit → exit 50%, move SL to entry',
              '🚫 Never re-enter same strike after a loss',
              '📉 After 2 consecutive losses → stop for the day',
              '💰 Max 3 trades per day, even if signals fire more',
            ].map((rule, i) => (
              <div key={i} className="flex items-start gap-2 text-slate-500">
                <span className="text-slate-700 mt-0.5 flex-shrink-0">{i + 1}.</span>
                <span>{rule}</span>
              </div>
            ))}
          </div>
        </div>

      </div>
    </div>
  )
}
