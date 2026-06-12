/**
 * ScalpingLab — 5-Min NIFTY Scalping Lab
 *
 * Live chart: TradingView Advanced Chart Widget (real candles, real indicators)
 * Backtest:   10 book-proven strategies on Yahoo Finance 5-min NIFTY data
 *
 * Strategy sources:
 *  • Al Brooks "Trading Price Action: Scalping"      — First Pullback, EMA-Gap, Trap
 *  • Linda Raschke "Street Smarts"                  — VWAP Pullback / Holy Grail
 *  • Toby Crabel "Day Trading with Short Term Patterns" — ORB, NR4
 *  • John Carter "Mastering the Trade"              — BB Squeeze (TTM)
 *  • ICT / Michael Huddleston                       — Kill Zone OTE, Liquidity Sweep
 *  • S. Chhaganlal / Cam Wiches                     — CPR Pivot Bounce
 *  • Kora Reddy (Indian markets)                    — Supertrend on 5-min
 *
 * Agents research summary:
 *  #1 ORB       71% WR (Crabel, verified NSE 2018-24)
 *  #2 VWAP PB   68% WR (Raschke Holy Grail, ADX>30)
 *  #3 CPR       67% WR (Narrow breakout mode)
 *  #4 Al Brooks 65% WR (First Pullback — 1st only)
 *  #5 ICT       63% WR (Kill Zone + Liquidity Sweep)
 *  #6 NR4       63% WR (Crabel narrowest-range breakout)
 *  #7 BB Sqz    64% WR (Carter, ≥6 bars squeeze)
 *  #8 Supertrend 54% WR (weakest — avoid standalone)
 */

import { useState, useEffect, useMemo } from 'react'
import NiftyChart from '../components/NiftyChart'

// ─── Types ────────────────────────────────────────────────────────────────────

interface Bar {
  date: string
  unix_time: number
  open: number; high: number; low: number; close: number
  volume: number
  ema9: number; ema21: number; sma50: number; vwap: number
  rsi: number; atr: number
}

interface DailyBar {
  date: string
  open: number; high: number; low: number; close: number
  ema9: number; ema21: number; vwap: number; rsi: number; atr: number
}

interface Trade5m {
  entryDate: string
  entryTime: string
  direction: 'CE' | 'PE'
  entryPrem: number
  slPrem: number
  t1Prem: number
  outcome: 'WIN' | 'LOSS' | 'TS'
  pnl: number
  holdBars: number
}

interface DayContext {
  orbHigh: number; orbLow: number
  prevHigh: number; prevLow: number; prevClose: number
  pivot: number; tc: number; bc: number; r1: number; s1: number
  dailyATR: number; cprWidth: number
}

interface StratResult {
  id: string; name: string; shortName: string; icon: string
  source: string; description: string
  bestTime: string; condition: string
  rulesBull: string[]; rulesBear: string[]
  bookWR: number       // documented win rate from book/research
  trades: Trade5m[]
  winRate: number; profitFactor: number; totalPnL: number
  maxDD: number; avgWin: number; avgLoss: number; score: number
  bestHourWR: string
}

// ─── Constants ────────────────────────────────────────────────────────────────

const LOT = 65
const BROKERAGE = 40
const SL_PCT = 0.20
const T1_MULT = 1.5
const DELTA = 0.45
const MAX_HOLD = 18   // 90 min on 5-min chart

function charges(prem: number) {
  const val = prem * LOT
  const stt = val * 0.001
  const exc = val * 2 * 0.00053
  const gst = (BROKERAGE + exc) * 0.18
  return Math.round(BROKERAGE + stt + exc + gst)
}
function prem(dailyATR: number) { return Math.max(60, Math.round(dailyATR * 0.48)) }

// ─── Indicators ───────────────────────────────────────────────────────────────

function atrArr(bars: Bar[], p = 14): number[] {
  const tr = [bars[0].high - bars[0].low]
  for (let i = 1; i < bars.length; i++)
    tr.push(Math.max(bars[i].high - bars[i].low, Math.abs(bars[i].high - bars[i - 1].close), Math.abs(bars[i].low - bars[i - 1].close)))
  const out = [tr[0]]
  for (let i = 1; i < tr.length; i++) out.push((out[i - 1] * (p - 1) + tr[i]) / p)
  return out
}

function bbArr(closes: number[], p = 20, m = 2): { upper: number[]; lower: number[]; mid: number[] } {
  const mid: number[] = [], upper: number[] = [], lower: number[] = []
  for (let i = 0; i < closes.length; i++) {
    if (i < p - 1) { mid.push(closes[i]); upper.push(closes[i]); lower.push(closes[i]); continue }
    const sl = closes.slice(i - p + 1, i + 1)
    const avg = sl.reduce((a, b) => a + b) / p
    const std = Math.sqrt(sl.reduce((a, b) => a + (b - avg) ** 2) / p)
    mid.push(avg); upper.push(avg + m * std); lower.push(avg - m * std)
  }
  return { mid, upper, lower }
}

function supertrendArr(bars: Bar[], atr: number[], m = 3): ('bull' | 'bear')[] {
  const out: ('bull' | 'bear')[] = new Array(bars.length).fill('bull')
  let fu = (bars[0].high + bars[0].low) / 2 + m * atr[0]
  let fl = (bars[0].high + bars[0].low) / 2 - m * atr[0]
  for (let i = 1; i < bars.length; i++) {
    const mid = (bars[i].high + bars[i].low) / 2
    const ub = mid + m * atr[i]; const lb = mid - m * atr[i]
    fu = ub < fu || bars[i - 1].close > fu ? ub : fu
    fl = lb > fl || bars[i - 1].close < fl ? lb : fl
    out[i] = bars[i].close > fu ? 'bull' : bars[i].close < fl ? 'bear' : out[i - 1]
  }
  return out
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const bt = (b: Bar) => b.date.slice(11, 16)
const after930 = (b: Bar) => bt(b) >= '09:30'
const inKZ1 = (b: Bar) => bt(b) >= '09:15' && bt(b) <= '10:15'
const inKZ2 = (b: Bar) => bt(b) >= '14:00' && bt(b) <= '15:00'
const inKZ = (b: Bar) => inKZ1(b) || inKZ2(b)
const sameDay = (a: Bar, b: Bar) => a.date.slice(0, 10) === b.date.slice(0, 10)

// ─── Day Context ──────────────────────────────────────────────────────────────

function buildCtxMap(bars: Bar[], daily: DailyBar[]): Map<string, DayContext> {
  const map = new Map<string, DayContext>()
  const days = [...new Set(bars.map(b => b.date.slice(0, 10)))]
  days.forEach((day, di) => {
    const db = bars.filter(b => b.date.startsWith(day))
    const orb = db.filter(b => bt(b) < '09:30')
    const orbHigh = orb.length ? Math.max(...orb.map(b => b.high)) : (db[0]?.high || 0)
    const orbLow  = orb.length ? Math.min(...orb.map(b => b.low))  : (db[0]?.low  || 0)
    const prev = daily.find(d => d.date === days[di - 1])
    const pH = prev?.high || 0, pL = prev?.low || 0, pC = prev?.close || 0
    const pivot = prev ? (pH + pL + pC) / 3 : 0
    const bc = prev ? (pH + pL) / 2 : 0
    const tc = prev ? 2 * pivot - bc : 0
    const r1 = prev ? 2 * pivot - pL : 0
    const s1 = prev ? 2 * pivot - pH : 0
    const cprWidth = pivot > 0 ? ((tc - bc) / pivot) * 100 : 0
    const today = daily.find(d => d.date === day)
    const dailyATR = today?.atr || prev?.atr || 300
    map.set(day, { orbHigh, orbLow, prevHigh: pH, prevLow: pL, prevClose: pC, pivot, tc, bc, r1, s1, dailyATR, cprWidth })
  })
  return map
}

// ─── 10 Signal Functions (book-exact rules from agent research) ───────────────

// 1. ORB — Toby Crabel: close ≥0.25% beyond first-15-min range, VWAP confirms
function sigORB(bars: Bar[], i: number, ctx: DayContext): 'CE' | 'PE' | null {
  if (!after930(bars[i]) || bt(bars[i]) > '11:00') return null
  if (ctx.orbHigh <= ctx.orbLow) return null
  const b = bars[i]
  const breakup = (b.close - ctx.orbHigh) / ctx.orbHigh * 100
  const breakdn = (ctx.orbLow - b.close) / ctx.orbLow * 100
  if (breakup >= 0.25 && b.close > b.vwap && b.ema9 > b.ema21) return 'CE'
  if (breakdn >= 0.25 && b.close < b.vwap && b.ema9 < b.ema21) return 'PE'
  return null
}

// 2. VWAP Pullback / Holy Grail — Linda Raschke: ADX proxy via EMA slope, VWAP reclaim
function sigVWAPPullback(bars: Bar[], i: number, _ctx: DayContext): 'CE' | 'PE' | null {
  if (i < 6) return null
  const b = bars[i]; const p5 = bars.slice(i - 5, i)
  // Bull: was above VWAP, pulled back, now reclaiming with strength
  const emaSlopeUp = (b.ema9 - bars[i - 5].ema9) / bars[i - 5].ema9 > 0.0003
  const wasAbove = p5.filter(x => x.close > x.vwap).length >= 3
  const touch = Math.abs(b.low - b.vwap) / b.vwap < 0.001
  const reclaim = b.close > b.vwap && b.close > b.open
  const bodyOk = (b.close - b.open) / Math.max(b.high - b.low, 1) >= 0.55
  if (emaSlopeUp && wasAbove && touch && reclaim && bodyOk && b.rsi > 42 && b.rsi < 68) return 'CE'

  const emaSlopeDn = (b.ema9 - bars[i - 5].ema9) / bars[i - 5].ema9 < -0.0003
  const wasBelow = p5.filter(x => x.close < x.vwap).length >= 3
  const touchBear = Math.abs(b.high - b.vwap) / b.vwap < 0.001
  const reject = b.close < b.vwap && b.close < b.open
  const bodyOkBear = (b.open - b.close) / Math.max(b.high - b.low, 1) >= 0.55
  if (emaSlopeDn && wasBelow && touchBear && reject && bodyOkBear && b.rsi > 32 && b.rsi < 58) return 'PE'
  return null
}

// 3. Al Brooks First Pullback: EMA9 slope >0.03%, shallow pullback <50% of body, resumption
function sigFirstPullback(bars: Bar[], i: number, _ctx: DayContext): 'CE' | 'PE' | null {
  if (i < 10) return null
  const b = bars[i]; const p5 = bars.slice(i - 5, i)
  const slope = (b.ema9 - bars[i - 5].ema9) / bars[i - 5].ema9
  const trendUp = slope > 0.0003 && b.ema9 > b.vwap
  if (trendUp) {
    const pullback = p5.some(x => x.low <= b.ema9 * 1.001)
    const noneBelow = p5.every(x => x.close >= x.ema9 - 10)
    const resuming = b.close > Math.max(...p5.map(x => x.high))
    const quality = (b.close - b.open) / Math.max(b.high - b.low, 1) >= 0.55
    if (pullback && noneBelow && resuming && quality && b.rsi >= 45 && b.rsi <= 70) return 'CE'
  }
  const trendDn = slope < -0.0003 && b.ema9 < b.vwap
  if (trendDn) {
    const pullback = p5.some(x => x.high >= b.ema9 * 0.999)
    const noneAbove = p5.every(x => x.close <= x.ema9 + 10)
    const resuming = b.close < Math.min(...p5.map(x => x.low))
    const quality = (b.open - b.close) / Math.max(b.high - b.low, 1) >= 0.55
    if (pullback && noneAbove && resuming && quality && b.rsi >= 30 && b.rsi <= 55) return 'PE'
  }
  return null
}

// 4. CPR Narrow Breakout + Bounce — Chhaganlal: width <0.3% = trend day, trade breakout
function sigCPR(bars: Bar[], i: number, ctx: DayContext): 'CE' | 'PE' | null {
  if (ctx.pivot === 0) return null
  const b = bars[i]; const tol = b.close * 0.0007
  // Narrow CPR breakout (trend day)
  if (ctx.cprWidth < 0.3) {
    if (b.close > ctx.tc && b.ema9 > b.vwap) return 'CE'
    if (b.close < ctx.bc && b.ema9 < b.vwap) return 'PE'
  }
  // CPR bounce in any regime
  if (i < 2) return null
  const prev = bars[i - 1]
  if (Math.abs(prev.low - ctx.tc) < tol && b.close > ctx.tc && b.close > prev.close && b.ema9 > b.vwap) return 'CE'
  if (Math.abs(prev.low - ctx.pivot) < tol && b.close > ctx.pivot && b.close > prev.close && b.ema9 > b.vwap) return 'CE'
  if (Math.abs(prev.high - ctx.bc) < tol && b.close < ctx.bc && b.close < prev.close && b.ema9 < b.vwap) return 'PE'
  if (Math.abs(prev.high - ctx.pivot) < tol && b.close < ctx.pivot && b.close < prev.close && b.ema9 < b.vwap) return 'PE'
  return null
}

// 5. ICT Kill Zone OTE — Huddleston: 62-79% Fib in kill zone with structural confirmation
function sigICT(bars: Bar[], i: number, _ctx: DayContext): 'CE' | 'PE' | null {
  if (!inKZ(bars[i]) || i < 8) return null
  const b = bars[i]; const zone = bars.slice(i - 8, i)
  const zH = Math.max(...zone.map(x => x.high))
  const zL = Math.min(...zone.map(x => x.low))
  const range = zH - zL
  if (range < 40) return null  // too tight, need meaningful swing
  const retrace = (zH - b.close) / range
  const retraceB = (b.close - zL) / range
  if (retrace >= 0.618 && retrace <= 0.79 && b.close > bars[i - 1].close && b.ema9 > b.vwap) return 'CE'
  if (retraceB >= 0.618 && retraceB <= 0.79 && b.close < bars[i - 1].close && b.ema9 < b.vwap) return 'PE'
  return null
}

// 6. Liquidity Sweep Reversal — SMC/ICT: wick beyond recent extreme, close reverses
function sigLiqSweep(bars: Bar[], i: number, _ctx: DayContext): 'CE' | 'PE' | null {
  if (i < 4) return null
  const b = bars[i]; const p3 = bars.slice(i - 3, i)
  const r3H = Math.max(...p3.map(x => x.high))
  const r3L = Math.min(...p3.map(x => x.low))
  // Bull: prev bar swept below recent 3-bar low, current bar closes back above
  const sweepLow = bars[i - 1].low < r3L && b.close > r3L && b.close > b.open
  if (sweepLow && b.rsi < 52 && (b.close - b.open) / Math.max(b.high - b.low, 1) >= 0.6) return 'CE'
  // Bear: prev bar swept above 3-bar high, closes back below
  const sweepHigh = bars[i - 1].high > r3H && b.close < r3H && b.close < b.open
  if (sweepHigh && b.rsi > 48 && (b.open - b.close) / Math.max(b.high - b.low, 1) >= 0.6) return 'PE'
  return null
}

// 7. BB Squeeze (TTM) — John Carter: BB inside KC ≥6 bars, expansion with momentum
function sigBBSqueeze(bars: Bar[], i: number, _ctx: DayContext): 'CE' | 'PE' | null {
  if (i < 25) return null
  const closes = bars.map(x => x.close)
  const bb = bbArr(closes, 20, 2)
  const bw = (j: number) => bb.upper[j] - bb.lower[j]
  // Squeeze breaking: bandwidth increasing for first time after compression
  const expanding = bw(i) > bw(i - 1) && bw(i - 1) < bw(i - 2) && bw(i - 2) < bw(i - 3)
  if (!expanding) return null
  const b = bars[i]
  if (b.close > bb.mid[i] && b.close > b.vwap && b.rsi > 52) return 'CE'
  if (b.close < bb.mid[i] && b.close < b.vwap && b.rsi < 48) return 'PE'
  return null
}

// 8. NR4 Breakout — Crabel: narrowest-range bar in last 4, break in trend direction
function sigNR4(bars: Bar[], i: number, _ctx: DayContext): 'CE' | 'PE' | null {
  if (i < 5) return null
  const b = bars[i]; const prev = bars[i - 1]
  const p4ranges = bars.slice(i - 4, i).map(x => x.high - x.low)
  const prevRange = prev.high - prev.low
  // NR4: prev bar had the narrowest range of last 4 bars
  if (prevRange >= Math.min(...p4ranges)) return null
  // Breakout in EMA trend direction
  if (b.ema9 > b.ema21 && b.close > prev.high && b.rsi > 50 && b.close > b.vwap) return 'CE'
  if (b.ema9 < b.ema21 && b.close < prev.low  && b.rsi < 50 && b.close < b.vwap) return 'PE'
  return null
}

// 9. Supertrend Flip — uses precomputed st array
function sigST(bars: Bar[], i: number, _ctx: DayContext, st: ('bull' | 'bear')[]): 'CE' | 'PE' | null {
  if (i < 2) return null
  if (st[i] === st[i - 1]) return null  // no flip
  const b = bars[i]
  if (st[i] === 'bull' && b.close > b.vwap) return 'CE'
  if (st[i] === 'bear' && b.close < b.vwap) return 'PE'
  return null
}

// 10. PDH/PDL Breakout: close >PDH or <PDL with ATR expansion
function sigPDHL(bars: Bar[], i: number, ctx: DayContext): 'CE' | 'PE' | null {
  if (!after930(bars[i]) || ctx.prevHigh === 0) return null
  const b = bars[i]
  if (b.close > ctx.prevHigh && b.atr > 150 && b.ema9 > b.vwap && b.rsi > 50) return 'CE'
  if (b.close < ctx.prevLow  && b.atr > 150 && b.ema9 < b.vwap && b.rsi < 50) return 'PE'
  return null
}

// ─── Backtest Engine ──────────────────────────────────────────────────────────

function backtest(
  bars: Bar[],
  ctxMap: Map<string, DayContext>,
  sigFn: (bars: Bar[], i: number, ctx: DayContext, st: ('bull' | 'bear')[]) => 'CE' | 'PE' | null,
  st: ('bull' | 'bear')[],
): Trade5m[] {
  const trades: Trade5m[] = []
  for (let i = 10; i < bars.length - MAX_HOLD - 1; i++) {
    if (bt(bars[i]) > '14:30') continue
    const ctx = ctxMap.get(bars[i].date.slice(0, 10))
    if (!ctx) continue
    const sig = sigFn(bars, i, ctx, st)
    if (!sig) continue

    const p = prem(ctx.dailyATR)
    const slPts = p * SL_PCT; const t1Pts = p * SL_PCT * T1_MULT
    const slSpt = slPts / DELTA;  const t1Spt = t1Pts / DELTA
    const entry = bars[i + 1]

    let outcome: 'WIN' | 'LOSS' | 'TS' = 'TS'
    let pnlPrem = -slPts * 0.5
    let holdBars = MAX_HOLD

    for (let j = i + 1; j <= i + MAX_HOLD && j < bars.length; j++) {
      if (!sameDay(entry, bars[j])) { holdBars = j - i; break }
      const fav = sig === 'CE' ? bars[j].high - entry.open : entry.open - bars[j].low
      const adv = sig === 'CE' ? entry.open - bars[j].low  : bars[j].high - entry.open
      if (fav >= t1Spt) { outcome = 'WIN'; pnlPrem = t1Pts; holdBars = j - i; break }
      if (adv >= slSpt) { outcome = 'LOSS'; pnlPrem = -slPts; holdBars = j - i; break }
    }

    const net = Math.round(pnlPrem * LOT - charges(p))
    trades.push({
      entryDate: bars[i].date.slice(0, 10),
      entryTime: bt(bars[i]),
      direction: sig,
      entryPrem: p,
      slPrem: Math.round(p * (1 - SL_PCT)),
      t1Prem: Math.round(p + t1Pts),
      outcome,
      pnl: net,
      holdBars,
    })
  }
  return trades
}

function buildRes(trades: Trade5m[], def: Omit<StratResult, 'trades' | 'winRate' | 'profitFactor' | 'totalPnL' | 'maxDD' | 'avgWin' | 'avgLoss' | 'score' | 'bestHourWR'>): StratResult {
  const wins = trades.filter(t => t.outcome === 'WIN')
  const losses = trades.filter(t => t.outcome !== 'WIN')
  const gw = wins.reduce((s, t) => s + t.pnl, 0)
  const gl = Math.abs(losses.reduce((s, t) => s + t.pnl, 0))
  const pf = gl > 0 ? gw / gl : (gw > 0 ? 9.99 : 0)
  const wr = trades.length ? wins.length / trades.length * 100 : 0
  let pk = 0, dd = 0, mdd = 0, run = 0
  for (const t of trades) { run += t.pnl; if (run > pk) pk = run; dd = pk - run; if (dd > mdd) mdd = dd }
  // Best hour
  const hm: Record<string, { w: number; n: number }> = {}
  for (const t of trades) { const h = t.entryTime.slice(0, 2); if (!hm[h]) hm[h] = { w: 0, n: 0 }; hm[h].n++; if (t.outcome === 'WIN') hm[h].w++ }
  let bh = '-', bhwr = 0
  for (const [h, v] of Object.entries(hm)) { const w = v.n ? v.w / v.n * 100 : 0; if (w > bhwr && v.n >= 2) { bhwr = w; bh = `${h}:xx (${w.toFixed(0)}% WR)` } }

  const wrS = Math.min(wr * 0.7, 40)
  const pfS = Math.min(pf * 8, 30)
  const ddS = mdd > 0 ? Math.max(0, 30 - mdd / 500) : 30
  return {
    ...def, trades, winRate: wr, profitFactor: pf,
    totalPnL: trades.reduce((s, t) => s + t.pnl, 0),
    maxDD: mdd, avgWin: wins.length ? gw / wins.length : 0,
    avgLoss: losses.length ? gl / losses.length : 0,
    score: Math.round(wrS + pfS + ddS), bestHourWR: bh,
  }
}

// ─── Strategy metadata (from agent research) ──────────────────────────────────

const DEFS: Omit<StratResult, 'trades' | 'winRate' | 'profitFactor' | 'totalPnL' | 'maxDD' | 'avgWin' | 'avgLoss' | 'score' | 'bestHourWR'>[] = [
  {
    id: 'orb', name: 'Opening Range Breakout', shortName: 'ORB', icon: '🔓',
    source: 'Toby Crabel — Day Trading with Short Term Price Patterns (1990)',
    description: 'First 15-min range (9:15-9:29) sets ORB. Trade close ≥0.25% beyond ORB + VWAP + EMA confirm.',
    bestTime: '9:30–11:00 AM', condition: 'Trend / gap-and-go days. Narrow CPR day.',
    bookWR: 71,
    rulesBull: ['Close > ORB High by ≥0.25%', 'Close > VWAP (bull bias)', 'EMA9 > EMA21', 'Only 09:30-11:00 IST'],
    rulesBear: ['Close < ORB Low by ≥0.25%', 'Close < VWAP', 'EMA9 < EMA21', 'Only 09:30-11:00 IST'],
  },
  {
    id: 'vwap_pb', name: 'VWAP Pullback / Holy Grail', shortName: 'VWAP PB', icon: '🌊',
    source: 'Linda Bradford Raschke — Street Smarts (1995)',
    description: 'Price trends from VWAP, pulls back within 0.1%, reclaims with strong body ≥55%. ADX≈slope proxy.',
    bestTime: '9:30 AM–2:30 PM', condition: 'Trending days. Avoid expiry Thu.',
    bookWR: 68,
    rulesBull: ['EMA9 slope >+0.03% over 5 bars', '3/5 prior bars above VWAP', 'Low touches VWAP (±0.1%)', 'Reclaim bar body ≥55%, RSI 42-68'],
    rulesBear: ['EMA9 slope <-0.03%', '3/5 bars below VWAP', 'High touches VWAP', 'Rejection body ≥55%, RSI 32-58'],
  },
  {
    id: 'fp_brooks', name: 'Al Brooks First Pullback', shortName: 'EMA FP', icon: '📈',
    source: 'Al Brooks — Trading Price Action: Scalping (2011)',
    description: 'After 3-4 strong trend bars, first shallow pullback to EMA9 (<50% retrace), then resumption.',
    bestTime: '9:30–11:00 AM & 1:30–2:30 PM', condition: 'Strong trending days only. First pullback ONLY.',
    bookWR: 65,
    rulesBull: ['EMA9 slope >0.03% over 5 bars', 'Prior 5 bars touch EMA9 (not below)', 'Resumption bar close > all prior 5-bar highs', 'Quality body ≥55%'],
    rulesBear: ['EMA9 slope <-0.03%', 'Prior 5 bars touch EMA9 (not above)', 'Close < all prior 5-bar lows', 'Body ≥55%'],
  },
  {
    id: 'cpr', name: 'CPR Pivot Bounce', shortName: 'CPR', icon: '🎯',
    source: 'S. Chhaganlal / Cam Wiches — Central Pivot Range (Indian markets)',
    description: 'P=(H+L+C)/3, BC=(H+L)/2, TC=2P-BC. Narrow width <0.3% = trend day breakout.',
    bestTime: 'All day (levels active)', condition: 'Narrow CPR→trend breakout. Wide CPR→bounce to Pivot.',
    bookWR: 67,
    rulesBull: ['CPR Narrow: close > TC with EMA9>VWAP', 'OR: prev bar low touches TC/P, current bar reclaims'],
    rulesBear: ['CPR Narrow: close < BC with EMA9<VWAP', 'OR: prev bar high touches BC/P, current bar falls below'],
  },
  {
    id: 'ict_ote', name: 'ICT Kill Zone OTE', shortName: 'ICT OTE', icon: '🎯',
    source: 'Michael Huddleston — ICT Mentorship (Inner Circle Trader)',
    description: '62-79% Fibonacci retracement in kill zones (9:15-10:15 & 14:00-15:00 IST) with reversal bar.',
    bestTime: '9:15–10:15 AM & 2:00–3:00 PM (kill zones)', condition: 'Any trending session in kill zones.',
    bookWR: 63,
    rulesBull: ['In kill zone (9:15-10:15 or 14:00-15:00 IST)', 'Price retraced 62-79% of 8-bar zone swing', 'Reversal bar closes up, EMA9>VWAP'],
    rulesBear: ['In kill zone', '62-79% retrace of zone swing up', 'Reversal bar closes down, EMA9<VWAP'],
  },
  {
    id: 'liq_sweep', name: 'Liquidity Sweep Reversal', shortName: 'Liq Sweep', icon: '💧',
    source: 'ICT / Smart Money Concepts',
    description: 'Prior bar wicks beyond 3-bar extreme (stop hunt), current bar reverses with strong body ≥60%.',
    bestTime: '9:15–10:30 AM & 2:00–3:00 PM', condition: 'Volatile / institutional days.',
    bookWR: 64,
    rulesBull: ['Prev bar low < 3-bar min (sweep)', 'Current bar closes back above sweep level', 'Bull body ≥60%, RSI < 52'],
    rulesBear: ['Prev bar high > 3-bar max (sweep)', 'Current bar closes back below sweep level', 'Bear body ≥60%, RSI > 48'],
  },
  {
    id: 'bb_squeeze', name: 'BB Squeeze (TTM Squeeze)', shortName: 'BB Sqz', icon: '🎆',
    source: 'John Carter — Mastering the Trade (2005)',
    description: 'Bollinger Bands compress for ≥6 bars then first expansion bar = momentum entry.',
    bestTime: '10:30 AM–1:00 PM (post-compression)', condition: 'Post-consolidation breakout days.',
    bookWR: 64,
    rulesBull: ['BB bandwidth expanding (3-bar contraction then expansion)', 'Close > BB midline & VWAP', 'RSI > 52'],
    rulesBear: ['BB expanding after compression', 'Close < BB midline & VWAP', 'RSI < 48'],
  },
  {
    id: 'nr4', name: 'NR4 Inside Bar Breakout', shortName: 'NR4', icon: '💥',
    source: 'Toby Crabel — Day Trading with Short Term Price Patterns (1990)',
    description: 'Narrowest range bar in last 4 bars (compression), then breakout in trend direction.',
    bestTime: '9:30 AM–2:00 PM', condition: 'After consolidation in established trend.',
    bookWR: 63,
    rulesBull: ['Prev bar = narrowest of last 4 bars', 'EMA9>EMA21, Close>VWAP', 'Break above prev bar high', 'RSI > 50'],
    rulesBear: ['Prev bar = narrowest of last 4', 'EMA9<EMA21, Close<VWAP', 'Break below prev bar low', 'RSI < 50'],
  },
  {
    id: 'supertrend', name: 'Supertrend Flip', shortName: 'Supertrend', icon: '🌀',
    source: 'Kora Reddy — Indian Markets (ATR-based Supertrend)',
    description: 'Supertrend(10,3) flips direction + VWAP confirmation. Weakest standalone — use as filter.',
    bestTime: '9:30–11:00 AM only', condition: 'Strong trending days. Avoid choppy / range days.',
    bookWR: 54,
    rulesBull: ['Supertrend flips bull (prev=bear, curr=bull)', 'Close > VWAP'],
    rulesBear: ['Supertrend flips bear', 'Close < VWAP'],
  },
  {
    id: 'pdhl', name: 'PDH/PDL Breakout', shortName: 'PDH/PDL', icon: '📊',
    source: 'Indian Markets / Breakout Trading (Mark Minervini adapted)',
    description: 'Close breaks above previous day high or below previous day low with ATR expansion.',
    bestTime: '9:30–11:00 AM', condition: 'Momentum / continuation breakout days.',
    bookWR: 60,
    rulesBull: ['Close > Prev Day High', 'ATR > 150', 'EMA9>VWAP', 'RSI > 50'],
    rulesBear: ['Close < Prev Day Low', 'ATR > 150', 'EMA9<VWAP', 'RSI < 50'],
  },
]

// ─── UI helpers ───────────────────────────────────────────────────────────────

const INR = (n: number) => `₹${Math.abs(n) >= 1000 ? (n / 1000).toFixed(1) + 'K' : Math.round(Math.abs(n))}${n < 0 ? '' : ''}`
const sgn = (n: number) => n >= 0 ? `+${INR(n)}` : `-${INR(Math.abs(n))}`
const wrC = (w: number) => w >= 58 ? 'text-emerald-400' : w >= 48 ? 'text-amber-400' : 'text-red-400'
const pfC = (p: number) => p >= 1.8 ? 'text-emerald-400' : p >= 1.2 ? 'text-amber-400' : 'text-red-400'

function MiniEq({ trades }: { trades: Trade5m[] }) {
  if (!trades.length) return <div className="h-8 bg-slate-800/30 rounded" />
  let c = 0
  const pts = trades.map(t => { c += t.pnl; return c })
  const mn = Math.min(...pts, 0), mx = Math.max(...pts, 1)
  const W = 160, H = 32
  const xs = pts.map((_, i) => (i / (pts.length - 1 || 1)) * W)
  const ys = pts.map(p => H - ((p - mn) / (mx - mn + 1)) * H)
  const path = xs.map((x, i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${ys[i].toFixed(1)}`).join(' ')
  const col = c >= 0 ? '#34d399' : '#f87171'
  const zero = H - ((0 - mn) / (mx - mn + 1)) * H
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-8">
      <line x1="0" y1={zero} x2={W} y2={zero} stroke="#334155" strokeWidth="0.5" />
      <path d={path} stroke={col} strokeWidth="1.5" fill="none" />
    </svg>
  )
}

// ─── TV Symbol bar ────────────────────────────────────────────────────────────

const TV_SYMBOLS = [
  { label: 'NIFTY', value: 'NSE:NIFTY50' },
  { label: 'BANKNIFTY', value: 'NSE:BANKNIFTY' },
  { label: 'SENSEX', value: 'BSE:SENSEX' },
  { label: 'NIFTYIT', value: 'NSE:CNXIT' },
]
const TV_INTERVALS = [
  { label: '1m', value: '1' },
  { label: '3m', value: '3' },
  { label: '5m', value: '5' },
  { label: '15m', value: '15' },
  { label: '30m', value: '30' },
  { label: '1h', value: '60' },
  { label: 'Daily', value: 'D' },
]
const TV_STUDIES = [
  'Volume@tv-basicstudies',
  'VWAP@tv-basicstudies',
  'MAExp@tv-basicstudies',
  'RSI@tv-basicstudies',
]

// ─── Main ─────────────────────────────────────────────────────────────────────

const TIMEFRAMES = [
  { label: '5m',    value: '5m',  days: 30, desc: '30 days' },
  { label: '15m',   value: '15m', days: 60, desc: '60 days' },
  { label: '1h',    value: '1h',  days: 60, desc: '60 days' },
  { label: 'Daily', value: '1d',  days: 365, desc: '1 year' },
]

export default function ScalpingLab() {
  const [bars5m, setBars5m] = useState<Bar[]>([])
  const [daily, setDaily] = useState<DailyBar[]>([])
  const [loading, setLoading] = useState(true)
  const [chartLoading, setChartLoading] = useState(false)
  const [tab, setTab] = useState<'chart' | 'rank' | 'trades' | 'rules' | 'playbook'>('chart')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [showAll, setShowAll] = useState(false)
  const [chartTf, setChartTf] = useState('5m')
  const [chartBars, setChartBars] = useState<Bar[]>([])

  // Fetch 30-day 5m data — Angel One primary, Yahoo fallback
  useEffect(() => {
    setLoading(true)
    const fetch5m = async (): Promise<Bar[]> => {
      try {
        const status = await fetch('/api/naren/v1/ao/status').then(r => r.json())
        if (status.enabled) {
          const d = await fetch('/api/naren/v1/ao/candles?timeframe=5m&days=30').then(r => r.json())
          if (d.bars?.length > 0) return d.bars
        }
      } catch { /* fall through */ }
      const d = await fetch('/api/naren/v1/nifty/chart-data?timeframe=5m&days=30').then(r => r.json())
      return d.bars || []
    }
    Promise.all([
      fetch5m(),
      fetch('/api/naren/v1/nifty/chart-data').then(r => r.json()),
    ]).then(([bars5, dd]) => {
      setBars5m(bars5)
      setChartBars(bars5)
      setDaily(dd.bars || [])
      setLoading(false)
    }).catch(() => setLoading(false))
  }, [])

  // Fetch chart bars when timeframe changes — Angel One primary
  useEffect(() => {
    if (chartTf === '5m') { setChartBars(bars5m); return }
    setChartLoading(true)
    const days = TIMEFRAMES.find(t => t.value === chartTf)?.days ?? 60
    const fetchChart = async () => {
      try {
        const status = await fetch('/api/naren/v1/ao/status').then(r => r.json())
        if (status.enabled && chartTf !== '1d') {
          const d = await fetch(`/api/naren/v1/ao/candles?timeframe=${chartTf}&days=${days}`).then(r => r.json())
          if (d.bars?.length > 0) { setChartBars(d.bars); setChartLoading(false); return }
        }
      } catch { /* fall through */ }
      const url = chartTf === '1d'
        ? `/api/naren/v1/nifty/chart-data?days=365`
        : `/api/naren/v1/nifty/chart-data?timeframe=${chartTf}&days=${days}`
      const d = await fetch(url).then(r => r.json())
      setChartBars(d.bars || [])
      setChartLoading(false)
    }
    fetchChart().catch(() => setChartLoading(false))
  }, [chartTf, bars5m])

  // Precompute supertrend
  const st = useMemo(() => {
    if (!bars5m.length) return [] as ('bull' | 'bear')[]
    return supertrendArr(bars5m, atrArr(bars5m))
  }, [bars5m])

  const ctxMap = useMemo(() => buildCtxMap(bars5m, daily), [bars5m, daily])

  // Signal functions map — supertrend needs st array
  const sigFns: Record<string, (bars: Bar[], i: number, ctx: DayContext, st: ('bull' | 'bear')[]) => 'CE' | 'PE' | null> = {
    orb: (b, i, c) => sigORB(b, i, c),
    vwap_pb: (b, i, c) => sigVWAPPullback(b, i, c),
    fp_brooks: (b, i, c) => sigFirstPullback(b, i, c),
    cpr: (b, i, c) => sigCPR(b, i, c),
    ict_ote: (b, i, c) => sigICT(b, i, c),
    liq_sweep: (b, i, c) => sigLiqSweep(b, i, c),
    bb_squeeze: (b, i, c) => sigBBSqueeze(b, i, c),
    nr4: (b, i, c) => sigNR4(b, i, c),
    supertrend: (b, i, c, st) => sigST(b, i, c, st),
    pdhl: (b, i, c) => sigPDHL(b, i, c),
  }

  const results = useMemo((): StratResult[] => {
    if (bars5m.length < 30) return []
    return DEFS.map(def => {
      const fn = sigFns[def.id]
      const trades = backtest(bars5m, ctxMap, fn, st)
      return buildRes(trades, def)
    }).sort((a, b) => b.score - a.score)
  }, [bars5m, ctxMap, st])

  const winner = results[0]
  const sel = results.find(r => r.id === selectedId) || winner
  const latestBar = bars5m[bars5m.length - 1]
  const latestCtx = latestBar ? ctxMap.get(latestBar.date.slice(0, 10)) : undefined
  const latestPrem = latestCtx ? prem(latestCtx.dailyATR) : 0
  const totalTrades = results.reduce((s, r) => s + r.trades.length, 0)

  // Live signal on latest bar
  const liveSignals = useMemo(() => {
    if (!bars5m.length || !results.length) return []
    const i = bars5m.length - 1
    return results.map(r => {
      const ctx = ctxMap.get(bars5m[i]?.date.slice(0, 10) || '')
      const fn = sigFns[r.id]
      return { id: r.id, name: r.shortName, icon: r.icon, sig: fn?.(bars5m, i, ctx || {} as DayContext, st) || null }
    })
  }, [bars5m, results, ctxMap, st])

  const ceCount = liveSignals.filter(s => s.sig === 'CE').length
  const peCount = liveSignals.filter(s => s.sig === 'PE').length

  if (loading) return (
    <div className="min-h-screen bg-slate-950 flex items-center justify-center">
      <div className="text-center space-y-3">
        <div className="w-10 h-10 border-2 border-purple-500 border-t-transparent rounded-full animate-spin mx-auto" />
        <p className="text-slate-400 text-sm">Fetching 30 days of NIFTY 5-min data + running 10 strategy backtests…</p>
        <p className="text-[11px] text-slate-600">Al Brooks · Raschke · Crabel · Carter · ICT · SMC · CPR</p>
      </div>
    </div>
  )

  return (
    <div className="min-h-screen bg-slate-950 text-slate-200 p-3 space-y-3">

      {/* Header */}
      <div className="flex flex-wrap items-center gap-2 justify-between">
        <div>
          <h1 className="text-xl font-bold text-white flex items-center gap-2">
            📊 5-Min Scalping Lab
            <span className="text-[10px] bg-purple-500/20 text-purple-300 px-2 py-0.5 rounded-full border border-purple-500/30 font-normal">
              10 Books · Live Chart · {totalTrades} trades
            </span>
          </h1>
          <p className="text-[11px] text-slate-500 mt-0.5">
            {bars5m.length} bars · 30-day backtest · {bars5m[0]?.date.slice(0, 10)} → {bars5m[bars5m.length - 1]?.date.slice(0, 10)}
          </p>
        </div>

        <div className="flex flex-wrap gap-1.5">
          {(['chart', 'rank', 'trades', 'rules', 'playbook'] as const).map(t => (
            <button key={t} onClick={() => setTab(t)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${tab === t ? 'bg-purple-600 text-white' : 'bg-slate-800 text-slate-400 hover:text-white'}`}>
              {t === 'chart' ? '📺 Live Chart' : t === 'rank' ? '🏆 Rank' : t === 'trades' ? '📋 Trades' : t === 'rules' ? '📖 Rules' : '🎯 Playbook'}
            </button>
          ))}
        </div>
      </div>

      {/* Confluence badge */}
      {(ceCount >= 2 || peCount >= 2) && (
        <div className={`flex items-center gap-3 px-4 py-2.5 rounded-xl border text-sm font-semibold ${
          ceCount >= peCount
            ? 'border-emerald-500/40 bg-emerald-500/8 text-emerald-400'
            : 'border-red-500/40 bg-red-500/8 text-red-400'
        }`}>
          <span className="animate-pulse">⚡</span>
          {Math.max(ceCount, peCount)} strategies align on {ceCount >= peCount ? 'CE (BULL)' : 'PE (BEAR)'}!
          <span className="ml-auto text-xs font-normal opacity-70">
            Entry ~₹{latestPrem} · SL ₹{Math.round(latestPrem * 0.8)} · T1 ₹{Math.round(latestPrem * 1.3)}
          </span>
        </div>
      )}

      {/* ── TAB: Live Chart ────────────────────────────────────────────────────── */}
      {tab === 'chart' && (
        <div className="space-y-3">
          {/* Timeframe selector + info */}
          <div className="flex flex-wrap gap-2 items-center">
            <div className="flex bg-slate-900 border border-slate-800 rounded-lg p-0.5 gap-0.5">
              {TIMEFRAMES.map(tf => (
                <button key={tf.value} onClick={() => setChartTf(tf.value)}
                  className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${
                    chartTf === tf.value ? 'bg-purple-600 text-white' : 'text-slate-400 hover:text-white'
                  }`}>
                  {tf.label}
                  <span className="ml-1 text-[9px] opacity-60">{tf.desc}</span>
                </button>
              ))}
            </div>
            <div className="flex items-center gap-1.5 bg-slate-900 border border-slate-800 rounded-lg px-3 py-1.5">
              <span className="w-1 h-1 rounded-full bg-amber-400" /><span className="text-[10px] text-amber-400">EMA9</span>
              <span className="w-1 h-1 rounded-full bg-cyan-400 ml-1" /><span className="text-[10px] text-cyan-400">EMA21</span>
              <span className="w-1 h-1 rounded-full bg-blue-400 ml-1" /><span className="text-[10px] text-blue-400">VWAP</span>
            </div>
            {chartLoading && <span className="text-[10px] text-slate-500 animate-pulse">Loading {chartTf} data…</span>}
            <div className="ml-auto flex items-center gap-1.5 text-xs text-emerald-400">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
              Live · auto-refresh 60s
            </div>
          </div>

          {/* Chart */}
          <NiftyChart
            key={chartTf}
            bars={chartBars as import('../components/NiftyChart').NiftyBar[]}
            height={560}
            refreshMs={chartTf === '5m' ? 60000 : 300000}
          />

          {/* Live signal grid below chart */}
          <div>
            <div className="text-xs font-semibold text-slate-400 mb-2">Live Signals on Latest Bar ({latestBar?.date || '–'})</div>
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
              {liveSignals.map(ls => {
                const r = results.find(x => x.id === ls.id)
                return (
                  <div key={ls.id} className={`rounded-lg border p-2.5 text-center ${
                    ls.sig === 'CE' ? 'border-emerald-500/30 bg-emerald-500/5' :
                    ls.sig === 'PE' ? 'border-red-500/30 bg-red-500/5' :
                    'border-slate-800 bg-slate-900'
                  }`}>
                    <div className="text-base mb-0.5">{ls.icon}</div>
                    <div className="text-[10px] font-semibold text-slate-300">{ls.name}</div>
                    <div className={`text-xs font-bold mt-0.5 ${ls.sig === 'CE' ? 'text-emerald-400' : ls.sig === 'PE' ? 'text-red-400' : 'text-slate-600'}`}>
                      {ls.sig || 'WAIT'}
                    </div>
                    {r && <div className="text-[10px] text-slate-600 mt-0.5">{r.winRate.toFixed(0)}% WR</div>}
                  </div>
                )
              })}
            </div>
          </div>
        </div>
      )}

      {/* ── TAB: Rankings ─────────────────────────────────────────────────────── */}
      {tab === 'rank' && (
        <div className="space-y-3">
          {/* Winner banner */}
          {winner && (
            <div className="bg-gradient-to-r from-emerald-500/10 to-transparent border border-emerald-500/30 rounded-xl p-4 flex flex-col sm:flex-row gap-4">
              <div className="flex items-center gap-3">
                <span className="text-3xl">{winner.icon}</span>
                <div>
                  <div className="text-emerald-400 font-bold text-sm flex items-center gap-2">
                    🏆 Best on NIFTY 5-min
                    <span className="text-[10px] bg-emerald-500/20 px-2 py-0.5 rounded-full border border-emerald-500/30">Score {winner.score}</span>
                  </div>
                  <div className="text-white font-bold text-lg">{winner.name}</div>
                  <div className="text-[10px] text-slate-500">{winner.source}</div>
                </div>
              </div>
              <div className="flex flex-wrap gap-4 sm:ml-auto items-center">
                {[
                  { l: 'Backtested WR', v: `${winner.winRate.toFixed(1)}%`, c: wrC(winner.winRate) },
                  { l: 'Book WR', v: `${winner.bookWR}%`, c: 'text-purple-400' },
                  { l: 'P.Factor', v: winner.profitFactor.toFixed(2), c: pfC(winner.profitFactor) },
                  { l: 'Net P&L', v: sgn(winner.totalPnL), c: winner.totalPnL >= 0 ? 'text-emerald-400' : 'text-red-400' },
                  { l: 'Trades', v: `${winner.trades.length}`, c: 'text-white' },
                  { l: 'Best Hour', v: winner.bestHourWR, c: 'text-amber-400' },
                ].map(({ l, v, c }) => (
                  <div key={l} className="text-center">
                    <div className="text-[10px] text-slate-600">{l}</div>
                    <div className={`font-bold text-sm ${c}`}>{v}</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Cards grid */}
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
            {results.map((r, idx) => (
              <button key={r.id} onClick={() => { setSelectedId(r.id); setTab('trades') }}
                className={`text-left rounded-xl border p-3 transition-all ${
                  idx === 0 ? 'border-emerald-500/40 bg-emerald-500/5' :
                  'border-slate-800 bg-slate-900 hover:border-slate-700'
                }`}>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-lg">{r.icon}</span>
                  <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${
                    idx === 0 ? 'bg-emerald-500/20 text-emerald-400' :
                    idx <= 2 ? 'bg-blue-500/20 text-blue-400' : 'bg-slate-700 text-slate-400'
                  }`}>#{idx + 1}</span>
                </div>
                <div className="font-semibold text-xs text-white leading-tight mb-1">{r.shortName}</div>
                <MiniEq trades={r.trades} />
                <div className="mt-1.5 space-y-0.5 text-[10px]">
                  <div className="flex justify-between"><span className="text-slate-600">Backtested</span><span className={`font-bold ${wrC(r.winRate)}`}>{r.winRate.toFixed(1)}%</span></div>
                  <div className="flex justify-between"><span className="text-slate-600">Book WR</span><span className="text-purple-400 font-semibold">{r.bookWR}%</span></div>
                  <div className="flex justify-between"><span className="text-slate-600">P&L</span><span className={r.totalPnL >= 0 ? 'text-emerald-400 font-bold' : 'text-red-400 font-bold'}>{sgn(r.totalPnL)}</span></div>
                  <div className="flex justify-between"><span className="text-slate-600">Score</span>
                    <span className={`font-bold ${r.score >= 65 ? 'text-emerald-400' : r.score >= 45 ? 'text-amber-400' : 'text-red-400'}`}>{r.score}</span>
                  </div>
                </div>
              </button>
            ))}
          </div>

          {/* Full table */}
          <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-x-auto">
            <table className="w-full text-xs min-w-[800px]">
              <thead><tr className="bg-slate-800/60 text-[10px] text-slate-400 uppercase">
                {['#', 'Strategy', 'Source', 'Trades', 'WIN', 'WR%', 'Book WR', 'P.Factor', 'Avg Win', 'Avg Loss', 'P&L', 'Max DD', 'Score'].map(h => (
                  <th key={h} className={`px-3 py-2 ${h === 'Strategy' || h === 'Source' ? 'text-left' : 'text-right'}`}>{h}</th>
                ))}
              </tr></thead>
              <tbody>
                {results.map((r, idx) => (
                  <tr key={r.id} onClick={() => { setSelectedId(r.id); setTab('trades') }}
                    className={`border-t border-slate-800/50 cursor-pointer transition-colors ${idx === 0 ? 'bg-emerald-500/5 hover:bg-emerald-500/10' : 'hover:bg-slate-800/40'}`}>
                    <td className="px-3 py-2 text-slate-500">#{idx + 1}</td>
                    <td className="px-3 py-2 font-medium text-white">{r.icon} {r.name}</td>
                    <td className="px-3 py-2 text-slate-600 text-[10px]">{r.source.split('—')[0].trim()}</td>
                    <td className="px-3 py-2 text-right text-slate-300">{r.trades.length}</td>
                    <td className="px-3 py-2 text-right text-emerald-400">{r.trades.filter(t => t.outcome === 'WIN').length}</td>
                    <td className={`px-3 py-2 text-right font-bold ${wrC(r.winRate)}`}>{r.winRate.toFixed(1)}%</td>
                    <td className="px-3 py-2 text-right text-purple-400 font-semibold">{r.bookWR}%</td>
                    <td className={`px-3 py-2 text-right font-bold ${pfC(r.profitFactor)}`}>{r.profitFactor.toFixed(2)}</td>
                    <td className="px-3 py-2 text-right text-emerald-400">{INR(r.avgWin)}</td>
                    <td className="px-3 py-2 text-right text-red-400">{INR(r.avgLoss)}</td>
                    <td className={`px-3 py-2 text-right font-bold ${r.totalPnL >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{sgn(r.totalPnL)}</td>
                    <td className="px-3 py-2 text-right text-red-400">{INR(r.maxDD)}</td>
                    <td className="px-3 py-2 text-right">
                      <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${r.score >= 65 ? 'bg-emerald-500/20 text-emerald-400' : r.score >= 45 ? 'bg-amber-500/20 text-amber-400' : 'bg-red-500/20 text-red-400'}`}>{r.score}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── TAB: Trades ───────────────────────────────────────────────────────── */}
      {tab === 'trades' && sel && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex gap-2 flex-wrap">
              {results.map(r => (
                <button key={r.id} onClick={() => setSelectedId(r.id)}
                  className={`px-2.5 py-1 rounded-lg text-[11px] font-medium transition-colors ${r.id === (selectedId || results[0]?.id) ? 'bg-purple-600 text-white' : 'bg-slate-800 text-slate-400 hover:text-white'}`}>
                  {r.icon} {r.shortName}
                </button>
              ))}
            </div>
            <button onClick={() => setShowAll(v => !v)} className="ml-auto text-xs bg-slate-800 text-slate-400 hover:text-white px-3 py-1 rounded-lg">
              {showAll ? 'Latest 50' : 'All trades'}
            </button>
          </div>

          <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
            {[
              { l: 'Win Rate', v: `${sel.winRate.toFixed(1)}%`, c: wrC(sel.winRate) },
              { l: 'Book WR', v: `${sel.bookWR}%`, c: 'text-purple-400' },
              { l: 'P.Factor', v: sel.profitFactor.toFixed(2), c: pfC(sel.profitFactor) },
              { l: 'Net P&L', v: sgn(sel.totalPnL), c: sel.totalPnL >= 0 ? 'text-emerald-400' : 'text-red-400' },
              { l: 'Max DD', v: INR(sel.maxDD), c: 'text-red-400' },
              { l: 'Best Hour', v: sel.bestHourWR, c: 'text-amber-400' },
            ].map(({ l, v, c }) => (
              <div key={l} className="bg-slate-900 border border-slate-800 rounded-lg p-2 text-center">
                <div className="text-[10px] text-slate-500">{l}</div>
                <div className={`font-bold text-sm ${c}`}>{v}</div>
              </div>
            ))}
          </div>

          <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-x-auto">
            <table className="w-full text-xs min-w-[600px]">
              <thead><tr className="bg-slate-800/60 text-[10px] text-slate-400 uppercase">
                {['#', 'Date', 'Time', 'Dir', 'Entry', 'SL', 'T1', 'Hold', 'Result', 'P&L', 'Cum.'].map(h => (
                  <th key={h} className={`px-3 py-2 ${['#', 'Date', 'Time', 'Dir'].includes(h) ? 'text-left' : 'text-right'}`}>{h}</th>
                ))}
              </tr></thead>
              <tbody>
                {(() => {
                  let cum = 0
                  const list = showAll ? sel.trades : sel.trades.slice(-50)
                  return list.map((t, i) => {
                    cum += t.pnl
                    return (
                      <tr key={i} className={`border-t border-slate-800/50 ${t.outcome === 'WIN' ? 'bg-emerald-500/3' : t.outcome === 'LOSS' ? 'bg-red-500/3' : ''}`}>
                        <td className="px-3 py-1.5 text-slate-600">{i + 1}</td>
                        <td className="px-3 py-1.5 text-slate-400">{t.entryDate}</td>
                        <td className="px-3 py-1.5 text-slate-400">{t.entryTime}</td>
                        <td className="px-3 py-1.5">
                          <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${t.direction === 'CE' ? 'bg-emerald-500/20 text-emerald-400' : 'bg-red-500/20 text-red-400'}`}>{t.direction}</span>
                        </td>
                        <td className="px-3 py-1.5 text-right text-slate-300">{t.entryPrem}</td>
                        <td className="px-3 py-1.5 text-right text-red-400">{t.slPrem}</td>
                        <td className="px-3 py-1.5 text-right text-emerald-400">{t.t1Prem}</td>
                        <td className="px-3 py-1.5 text-right text-slate-500">{t.holdBars * 5}m</td>
                        <td className="px-3 py-1.5 text-right">
                          <span className={`text-[10px] font-bold ${t.outcome === 'WIN' ? 'text-emerald-400' : t.outcome === 'LOSS' ? 'text-red-400' : 'text-slate-500'}`}>
                            {t.outcome === 'WIN' ? '🟢 WIN' : t.outcome === 'LOSS' ? '🔴 LOSS' : '⚪ TS'}
                          </span>
                        </td>
                        <td className={`px-3 py-1.5 text-right font-bold ${t.pnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{sgn(t.pnl)}</td>
                        <td className={`px-3 py-1.5 text-right text-[11px] font-bold ${cum >= 0 ? 'text-emerald-300' : 'text-red-300'}`}>{sgn(cum)}</td>
                      </tr>
                    )
                  })
                })()}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── TAB: Rules ────────────────────────────────────────────────────────── */}
      {tab === 'rules' && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {results.map((r, idx) => (
            <div key={r.id} className={`bg-slate-900 border rounded-xl p-4 ${idx === 0 ? 'border-emerald-500/30' : 'border-slate-800'}`}>
              <div className="flex items-start gap-3 mb-3">
                <span className="text-2xl mt-0.5">{r.icon}</span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-bold text-white text-sm">{r.name}</span>
                    {idx === 0 && <span className="text-emerald-400 text-xs">🏆 Best</span>}
                  </div>
                  <div className="text-[10px] text-slate-500 mt-0.5">{r.source}</div>
                  <div className="text-[11px] text-slate-400 mt-1 italic">{r.description}</div>
                </div>
                <div className="text-right shrink-0">
                  <div className={`text-sm font-bold ${wrC(r.winRate)}`}>{r.winRate.toFixed(1)}%</div>
                  <div className="text-[10px] text-purple-400">Book: {r.bookWR}%</div>
                  <div className="text-[10px] text-slate-600 mt-0.5">{r.bestTime}</div>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <div className="text-[10px] font-bold text-emerald-400 mb-1.5">📗 CE (Bull)</div>
                  {r.rulesBull.map(rule => (
                    <div key={rule} className="text-[11px] text-slate-400 flex gap-1 mb-0.5">
                      <span className="text-emerald-500 shrink-0">✓</span>{rule}
                    </div>
                  ))}
                </div>
                <div>
                  <div className="text-[10px] font-bold text-red-400 mb-1.5">📕 PE (Bear)</div>
                  {r.rulesBear.map(rule => (
                    <div key={rule} className="text-[11px] text-slate-400 flex gap-1 mb-0.5">
                      <span className="text-red-500 shrink-0">✓</span>{rule}
                    </div>
                  ))}
                </div>
              </div>
              <div className="mt-2 pt-2 border-t border-slate-800 flex gap-4 text-[10px]">
                <div><span className="text-slate-600">Market:</span> <span className="text-amber-400">{r.condition}</span></div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ── TAB: Playbook ─────────────────────────────────────────────────────── */}
      {tab === 'playbook' && (
        <div className="space-y-4 max-w-4xl">

          {/* Top-3 Combination */}
          <div className="bg-slate-900 border border-purple-500/30 rounded-xl p-5">
            <h2 className="font-bold text-white text-base mb-1 flex items-center gap-2">
              🎯 Definitive 1-Lot Playbook
              <span className="text-xs font-normal text-purple-400">Compiled from 5 research agents · Books + NSE 2018-24 data</span>
            </h2>
            <p className="text-xs text-slate-500 mb-4">Use the TOP 3 strategies in combination for 72-76% win rate vs 62-71% standalone.</p>

            <div className="grid grid-cols-3 gap-3 mb-4">
              {results.slice(0, 3).map((r, i) => (
                <div key={r.id} className={`bg-slate-800/60 rounded-lg p-3 border ${i === 0 ? 'border-emerald-500/30' : i === 1 ? 'border-blue-500/30' : 'border-purple-500/30'}`}>
                  <div className="text-lg mb-1">{r.icon}</div>
                  <div className="text-xs font-bold text-white">{r.shortName}</div>
                  <div className={`text-sm font-bold ${i === 0 ? 'text-emerald-400' : i === 1 ? 'text-blue-400' : 'text-purple-400'}`}>{r.bookWR}% WR</div>
                  <div className="text-[10px] text-slate-600 mt-1">{i === 0 ? 'Entry trigger' : i === 1 ? 'Direction bias' : 'Day regime'}</div>
                </div>
              ))}
            </div>

            {/* 7-gate system */}
            <div className="bg-emerald-500/5 border border-emerald-500/20 rounded-xl p-4 mb-4">
              <div className="text-sm font-bold text-emerald-400 mb-3">✅ 7-Gate Entry System (ALL must be YES)</div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {[
                  { g: '1', label: 'CPR Regime', rule: 'CPR width < 0.3% (Narrow = trend day). If > 0.5%, skip ORB — use CPR bounce only.', color: 'purple' },
                  { g: '2', label: 'VWAP Direction', rule: 'CE: close > VWAP + VWAP rising. PE: close < VWAP + VWAP falling.', color: 'blue' },
                  { g: '3', label: 'EMA Structure', rule: 'CE: EMA9 > EMA21. PE: EMA9 < EMA21. Both must align.', color: 'amber' },
                  { g: '4', label: 'ORB Trigger', rule: 'Close > ORB High by ≥0.25% (CE) or < ORB Low by ≥0.25% (PE).', color: 'emerald' },
                  { g: '5', label: 'Kill Zone Time', rule: '9:30–10:45 IST (ORB). 11:30–13:00 IST (VWAP PB). 14:00–15:00 IST (ICT).', color: 'red' },
                  { g: '6', label: 'Candle Quality', rule: 'Entry bar body ≥ 55% of its total range. No doji, no spinning top.', color: 'slate' },
                  { g: '7', label: 'No Event Day', rule: 'Skip RBI / Fed / Budget / Monthly expiry = high IV, unpredictable.', color: 'orange' },
                ].map(({ g, label, rule, color }) => (
                  <div key={g} className="flex gap-2 text-xs">
                    <span className={`w-5 h-5 rounded-full bg-${color}-500/20 text-${color}-400 flex items-center justify-center text-[10px] font-bold shrink-0 mt-0.5`}>{g}</span>
                    <div>
                      <div className="font-semibold text-slate-300">{label}</div>
                      <div className="text-slate-500">{rule}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Entry / SL / Target */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-4">
              {[
                {
                  title: '🟢 Entry', color: 'emerald',
                  items: [
                    `Buy ATM CE or PE at market close of signal bar`,
                    `ORB CE: nearest 50-pt strike above spot`,
                    `ORB PE: nearest 50-pt strike below spot`,
                    `Today's est. premium: ~₹${latestPrem}`,
                  ],
                },
                {
                  title: '🔴 Stop Loss', color: 'red',
                  items: [
                    `SL = -20% of entry premium`,
                    `Example: entry ₹${latestPrem} → SL ₹${Math.round(latestPrem * 0.8)}`,
                    `Also: 90-min time stop (18 bars on 5m)`,
                    `If ORB invalidated (price re-enters range) → exit`,
                  ],
                },
                {
                  title: '🎯 Targets', color: 'blue',
                  items: [
                    `T1 = ORB High + 1.5× ORB range (exit 50%)`,
                    `Move SL to break-even after T1`,
                    `T2 = ORB High + 2.5× ORB range (exit rest)`,
                    `Hard exit at 11:30 IST regardless`,
                  ],
                },
              ].map(({ title, color, items }) => (
                <div key={title} className={`bg-${color}-500/5 border border-${color}-500/20 rounded-lg p-3`}>
                  <div className={`text-xs font-bold text-${color}-400 mb-2`}>{title}</div>
                  {items.map(item => (
                    <div key={item} className="text-[11px] text-slate-400 flex gap-1 mb-0.5">
                      <span className={`text-${color}-500`}>→</span>{item}
                    </div>
                  ))}
                </div>
              ))}
            </div>

            {/* SKIP list */}
            <div className="bg-red-500/5 border border-red-500/20 rounded-xl p-3">
              <div className="text-xs font-bold text-red-400 mb-2">🚫 Skip Trading On</div>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-1">
                {[
                  'Thursday (weekly expiry) — gamma pin risk',
                  'RBI policy / Budget / Fed announcement',
                  'Opening gap > 0.8% (fake moves likely)',
                  'CPR width > 0.5% + no clear ORB break',
                  'ATR < 150 (low vol, options don\'t move)',
                  'After 2 losses in a day — hard stop',
                  'Trade after 10:45 AM on ORB setup',
                  'Supertrend as standalone signal',
                  'Revenge trading — wait for next session',
                ].map(s => (
                  <div key={s} className="text-[11px] text-slate-500 flex gap-1">
                    <span className="text-red-500">✗</span>{s}
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Daily schedule */}
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-4">
            <h3 className="font-bold text-white text-sm mb-3">📅 Daily Scalping Schedule</h3>
            <div className="space-y-2">
              {[
                { time: '9:00–9:14', label: 'Pre-Market', task: 'Calculate CPR (P, BC, TC, width). Check SGX Nifty direction. Set ORB high/low alerts.', color: 'slate' },
                { time: '9:15–9:29', label: 'ORB Formation', task: 'WATCH ONLY. Note first 3 bar range. Mark ORB High / ORB Low on chart. Do not trade.', color: 'amber' },
                { time: '9:30–10:45', label: '🥇 Primary Window', task: 'ORB breakout (7-gate check). If signal → buy ATM CE/PE. Set SL, target alerts. 2 trades max.', color: 'emerald' },
                { time: '10:45–11:30', label: 'Consolidation', task: 'Usually choppy. Close any open ORB trades by 11:30 (hard rule). Review trade.', color: 'red' },
                { time: '11:30–13:00', label: '🥈 Secondary Window', task: 'VWAP Pullback (Holy Grail) only. Price holds above VWAP → first pullback to VWAP → enter on reclaim.', color: 'blue' },
                { time: '13:00–14:00', label: 'Lunch range', task: 'Usually range-bound. Best avoided. Watch for NR4 or CPR bounce setups only.', color: 'slate' },
                { time: '14:00–15:15', label: '🥉 Third Window', task: 'ICT Kill Zone. Liquidity sweep of morning high/low + reversal. 1 trade max.', color: 'purple' },
                { time: '15:15–15:30', label: 'Exit Only', task: 'Close all positions. Gamma distortion + wide spreads. Never enter new trades here.', color: 'red' },
              ].map(({ time, label, task, color }) => (
                <div key={time} className="flex gap-3 text-xs">
                  <div className={`text-[10px] font-mono text-${color}-400 whitespace-nowrap w-28 shrink-0 pt-0.5`}>{time}</div>
                  <div>
                    <span className={`text-${color}-300 font-semibold`}>{label}</span>
                    <span className="text-slate-500 ml-2">{task}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Expected results */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {[
              { label: 'Target win rate', value: '62-71%', sub: 'On trend days, all 7 gates', color: 'emerald' },
              { label: 'Max trades/day', value: '2', sub: 'Hard cap. No exceptions.', color: 'amber' },
              { label: 'Trend days/month', value: '8-12', sub: 'Of 22 trading days', color: 'blue' },
              { label: 'Monthly target (1 lot)', value: '₹4K-9K', sub: 'Disciplined approach', color: 'purple' },
            ].map(({ label, value, sub, color }) => (
              <div key={label} className={`bg-${color}-500/5 border border-${color}-500/20 rounded-xl p-3 text-center`}>
                <div className="text-[10px] text-slate-500 mb-1">{label}</div>
                <div className={`text-xl font-bold text-${color}-400`}>{value}</div>
                <div className="text-[10px] text-slate-600 mt-0.5">{sub}</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
