import type { Bar } from './bar'

// Smart-Money-Concepts geometry computed from candles. All coordinates are in
// chart-native units (unix-seconds time, price) so the overlay can map them to
// pixels each frame.

export type SmcFeature = 'swings' | 'liquidity' | 'structure' | 'orderblocks'

export interface SmcBox {
  t1: number
  t2: number // right edge (extended to last bar)
  p1: number
  p2: number
  color: string
  label: string
}

export interface SmcLine {
  t1: number
  t2: number
  price: number
  color: string
  label: string
  dashed?: boolean
}

export interface SmcMarker {
  time: number
  price: number
  text: string
  color: string
  above: boolean
}

export interface SmcResult {
  boxes: SmcBox[]
  lines: SmcLine[]
  markers: SmcMarker[]
}

const C = {
  bull: '#34d399',
  bear: '#f87171',
  bos: '#38bdf8',
  choch: '#a78bfa',
  liq: '#eab308',
  swing: '#94a3b8',
}

interface Swing {
  i: number
  time: number
  price: number
  type: 'high' | 'low'
}

// detectSwings finds fractal swing highs/lows with the given lookback on each
// side (L=2 → a 5-bar fractal).
function detectSwings(bars: Bar[], L: number): Swing[] {
  const out: Swing[] = []
  for (let i = L; i < bars.length - L; i++) {
    let isHigh = true
    let isLow = true
    for (let j = i - L; j <= i + L; j++) {
      if (j === i) continue
      if (bars[j].high >= bars[i].high) isHigh = false
      if (bars[j].low <= bars[i].low) isLow = false
    }
    if (isHigh) out.push({ i, time: bars[i].time as number, price: bars[i].high, type: 'high' })
    if (isLow) out.push({ i, time: bars[i].time as number, price: bars[i].low, type: 'low' })
  }
  return out
}

export function computeSMC(
  bars: Bar[],
  features: Set<SmcFeature>,
  lookback = 2,
): SmcResult {
  const res: SmcResult = { boxes: [], lines: [], markers: [] }
  if (bars.length < lookback * 2 + 3) return res
  const lastTime = bars[bars.length - 1].time as number
  const swings = detectSwings(bars, lookback)

  // ── swing point labels (HH/HL/LH/LL) ──────────────────────────────────
  if (features.has('swings')) {
    let prevHigh = NaN
    let prevLow = NaN
    for (const s of swings.slice(-20)) {
      if (s.type === 'high') {
        const txt = Number.isNaN(prevHigh) ? 'H' : s.price > prevHigh ? 'HH' : 'LH'
        res.markers.push({ time: s.time, price: s.price, text: txt, color: C.swing, above: true })
        prevHigh = s.price
      } else {
        const txt = Number.isNaN(prevLow) ? 'L' : s.price < prevLow ? 'LL' : 'HL'
        res.markers.push({ time: s.time, price: s.price, text: txt, color: C.swing, above: false })
        prevLow = s.price
      }
    }
  }

  // ── liquidity: recent swing levels + equal highs/lows ──────────────────
  if (features.has('liquidity')) {
    const highs = swings.filter((s) => s.type === 'high').slice(-6)
    const lows = swings.filter((s) => s.type === 'low').slice(-6)
    for (const h of highs) {
      res.lines.push({ t1: h.time, t2: lastTime, price: h.price, color: C.liq, label: 'BSL', dashed: true })
    }
    for (const l of lows) {
      res.lines.push({ t1: l.time, t2: lastTime, price: l.price, color: C.liq, label: 'SSL', dashed: true })
    }
    // Equal highs / lows: consecutive same-type swings within tolerance.
    const tol = 0.001 // 0.1%
    const eq = (a: Swing, b: Swing) => Math.abs(a.price - b.price) / b.price < tol
    const hi = swings.filter((s) => s.type === 'high')
    const lo = swings.filter((s) => s.type === 'low')
    for (let i = 1; i < hi.length; i++) {
      if (eq(hi[i], hi[i - 1])) {
        res.lines.push({ t1: hi[i - 1].time, t2: hi[i].time, price: hi[i].price, color: C.bear, label: 'EQH' })
      }
    }
    for (let i = 1; i < lo.length; i++) {
      if (eq(lo[i], lo[i - 1])) {
        res.lines.push({ t1: lo[i - 1].time, t2: lo[i].time, price: lo[i].price, color: C.bull, label: 'EQL' })
      }
    }
  }

  // ── market structure: BOS / CHoCH + (optionally) order blocks ──────────
  const wantStructure = features.has('structure')
  const wantOB = features.has('orderblocks')
  if (wantStructure || wantOB) {
    // Walk bars; track the most recent unbroken swing high/low and trend.
    let trend: 'up' | 'down' | null = null
    let lastSwingHigh: Swing | null = null
    let lastSwingLow: Swing | null = null
    const swingAt = new Map<number, Swing[]>()
    for (const s of swings) {
      const arr = swingAt.get(s.i) ?? []
      arr.push(s)
      swingAt.set(s.i, arr)
    }

    for (let i = 0; i < bars.length; i++) {
      // register swings confirmed at this index
      const here = swingAt.get(i)
      if (here) {
        for (const s of here) {
          if (s.type === 'high') lastSwingHigh = s
          else lastSwingLow = s
        }
      }
      const close = bars[i].close
      // bullish break
      if (lastSwingHigh && close > lastSwingHigh.price && i > lastSwingHigh.i) {
        const isChoch = trend === 'down'
        if (wantStructure) {
          res.lines.push({
            t1: lastSwingHigh.time,
            t2: bars[i].time as number,
            price: lastSwingHigh.price,
            color: isChoch ? C.choch : C.bos,
            label: isChoch ? 'CHoCH' : 'BOS',
          })
        }
        if (wantOB) {
          const ob = lastDownCandle(bars, i)
          if (ob >= 0) {
            res.boxes.push({
              t1: bars[ob].time as number,
              t2: lastTime,
              p1: bars[ob].low,
              p2: bars[ob].high,
              color: C.bull,
              label: 'Bull OB',
            })
          }
        }
        trend = 'up'
        lastSwingHigh = null
      }
      // bearish break
      if (lastSwingLow && close < lastSwingLow.price && i > lastSwingLow.i) {
        const isChoch = trend === 'up'
        if (wantStructure) {
          res.lines.push({
            t1: lastSwingLow.time,
            t2: bars[i].time as number,
            price: lastSwingLow.price,
            color: isChoch ? C.choch : C.bos,
            label: isChoch ? 'CHoCH' : 'BOS',
          })
        }
        if (wantOB) {
          const ob = lastUpCandle(bars, i)
          if (ob >= 0) {
            res.boxes.push({
              t1: bars[ob].time as number,
              t2: lastTime,
              p1: bars[ob].low,
              p2: bars[ob].high,
              color: C.bear,
              label: 'Bear OB',
            })
          }
        }
        trend = 'down'
        lastSwingLow = null
      }
    }
    // keep only the most recent few structure lines / OBs to reduce clutter
    res.lines = trimTail(res.lines, wantStructure ? 30 : res.lines.length)
    res.boxes = res.boxes.slice(-6)
  }

  // ── fair value gaps (3-candle imbalance) ───────────────────────────────
  if (wantOB) {
    const fvgs: SmcBox[] = []
    for (let i = 2; i < bars.length; i++) {
      const a = bars[i - 2]
      const c = bars[i]
      if (a.high < c.low) {
        fvgs.push({ t1: a.time as number, t2: lastTime, p1: a.high, p2: c.low, color: 'rgba(52,211,153,0.5)', label: 'FVG' })
      } else if (a.low > c.high) {
        fvgs.push({ t1: a.time as number, t2: lastTime, p1: c.high, p2: a.low, color: 'rgba(248,113,113,0.5)', label: 'FVG' })
      }
    }
    res.boxes.push(...fvgs.slice(-10))
  }

  return res
}

function lastDownCandle(bars: Bar[], before: number): number {
  for (let j = before - 1; j >= 0 && j > before - 12; j--) {
    if (bars[j].close < bars[j].open) return j
  }
  return -1
}

function lastUpCandle(bars: Bar[], before: number): number {
  for (let j = before - 1; j >= 0 && j > before - 12; j--) {
    if (bars[j].close > bars[j].open) return j
  }
  return -1
}

function trimTail<T>(arr: T[], n: number): T[] {
  return arr.length > n ? arr.slice(arr.length - n) : arr
}
