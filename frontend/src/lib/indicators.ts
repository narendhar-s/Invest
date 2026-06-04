import type { UTCTimestamp } from 'lightweight-charts'
import type { Bar } from './bar'

export type LinePoint = { time: UTCTimestamp; value: number }

// A single plotted series produced by an indicator. style 'histogram' draws as
// bars (e.g. MACD histogram); 'line' as a line. pane 'price' overlays the candle
// scale; 'lower' gets its own stacked band at the bottom.
export interface Plot {
  key: string
  data: LinePoint[]
  color: string
  style: 'line' | 'histogram'
  pane: 'price' | 'lower'
  group: string // lower-pane plots sharing a group share one stacked scale
  lineWidth?: 1 | 2 | 3 | 4
}

export interface IndicatorSpec {
  id: string
  kind: IndicatorKind
  params: number[]
  label: string
  pane: 'price' | 'lower'
}

export type IndicatorKind =
  | 'sma'
  | 'ema'
  | 'wma'
  | 'vwap'
  | 'rsi'
  | 'macd'
  | 'bb'
  | 'atr'
  | 'stoch'
  | 'cci'
  | 'roc'
  | 'obv'

// Catalog drives the help text / autocomplete and defines defaults + pane.
export const INDICATOR_CATALOG: {
  kind: IndicatorKind
  syntax: string
  desc: string
  pane: 'price' | 'lower'
  defaults: number[]
}[] = [
  { kind: 'sma', syntax: 'SMA(20)', desc: 'Simple moving average', pane: 'price', defaults: [20] },
  { kind: 'ema', syntax: 'EMA(50)', desc: 'Exponential moving average', pane: 'price', defaults: [50] },
  { kind: 'wma', syntax: 'WMA(20)', desc: 'Weighted moving average', pane: 'price', defaults: [20] },
  { kind: 'vwap', syntax: 'VWAP', desc: 'Volume-weighted average price (session)', pane: 'price', defaults: [] },
  { kind: 'bb', syntax: 'BB(20,2)', desc: 'Bollinger Bands (period, stdev)', pane: 'price', defaults: [20, 2] },
  { kind: 'rsi', syntax: 'RSI(14)', desc: 'Relative Strength Index', pane: 'lower', defaults: [14] },
  { kind: 'macd', syntax: 'MACD(12,26,9)', desc: 'Moving Avg Convergence/Divergence', pane: 'lower', defaults: [12, 26, 9] },
  { kind: 'atr', syntax: 'ATR(14)', desc: 'Average True Range', pane: 'lower', defaults: [14] },
  { kind: 'stoch', syntax: 'STOCH(14,3)', desc: 'Stochastic %K/%D', pane: 'lower', defaults: [14, 3] },
  { kind: 'cci', syntax: 'CCI(20)', desc: 'Commodity Channel Index', pane: 'lower', defaults: [20] },
  { kind: 'roc', syntax: 'ROC(12)', desc: 'Rate of change (%)', pane: 'lower', defaults: [12] },
  { kind: 'obv', syntax: 'OBV', desc: 'On-Balance Volume', pane: 'lower', defaults: [] },
]

const byKind = new Map(INDICATOR_CATALOG.map((c) => [c.kind, c]))

// parseIndicator turns "macd(12,26,9)" / "bb 20 2" / "vwap" into a spec.
export function parseIndicator(input: string, seq: number): IndicatorSpec | null {
  const m = input.trim().match(/^([a-z]+)\s*\(?\s*([\d.,\s]*)\)?$/i)
  if (!m) return null
  const kind = m[1].toLowerCase() as IndicatorKind
  const cat = byKind.get(kind)
  if (!cat) return null
  const nums = m[2]
    .split(/[\s,]+/)
    .filter(Boolean)
    .map(Number)
    .filter((n) => !Number.isNaN(n))
  const params = nums.length ? nums : cat.defaults
  if (params.some((p) => p < 1 || p > 1000)) return null
  const label = params.length ? `${kind.toUpperCase()}(${params.join(',')})` : kind.toUpperCase()
  return { id: `${kind}-${Date.now()}-${seq}`, kind, params, label, pane: cat.pane }
}

const PALETTE = ['#eab308', '#38bdf8', '#a78bfa', '#fb7185', '#34d399', '#f97316', '#22d3ee']

// computeIndicator returns one or more plots for the (time-sorted) bars.
export function computeIndicator(bars: Bar[], spec: IndicatorSpec, seq: number): Plot[] {
  const c = bars.map((b) => b.close)
  const color = PALETTE[seq % PALETTE.length]
  const mk = (vals: number[], suffix = '', col = color, style: Plot['style'] = 'line', lineWidth: Plot['lineWidth'] = 1): Plot => ({
    key: spec.id + suffix,
    data: zip(bars, vals),
    color: col,
    style,
    pane: spec.pane,
    group: spec.id,
    lineWidth,
  })

  switch (spec.kind) {
    case 'sma':
      return [mk(sma(c, spec.params[0]))]
    case 'ema':
      return [mk(ema(c, spec.params[0]))]
    case 'wma':
      return [mk(wma(c, spec.params[0]))]
    case 'vwap':
      return [mk(vwap(bars))]
    case 'roc':
      return [mk(roc(c, spec.params[0]))]
    case 'obv':
      return [mk(obv(bars))]
    case 'rsi':
      return [mk(rsi(c, spec.params[0]))]
    case 'atr':
      return [mk(atr(bars, spec.params[0]))]
    case 'cci':
      return [mk(cci(bars, spec.params[0]))]
    case 'bb': {
      const [mid, up, lo] = bollinger(c, spec.params[0], spec.params[1] ?? 2)
      return [
        mk(up, '-u', '#94a3b8'),
        mk(mid, '-m', color),
        mk(lo, '-l', '#94a3b8'),
      ]
    }
    case 'macd': {
      const [line, signal, hist] = macd(c, spec.params[0], spec.params[1], spec.params[2])
      return [
        mk(line, '-line', '#38bdf8'),
        mk(signal, '-sig', '#f97316'),
        mk(hist, '-hist', '#64748b', 'histogram'),
      ]
    }
    case 'stoch': {
      const [k, d] = stoch(bars, spec.params[0], spec.params[1] ?? 3)
      return [mk(k, '-k', '#38bdf8'), mk(d, '-d', '#f97316')]
    }
  }
}

function zip(bars: Bar[], vals: number[]): LinePoint[] {
  const out: LinePoint[] = []
  for (let i = 0; i < bars.length; i++) {
    if (Number.isFinite(vals[i])) out.push({ time: bars[i].time, value: vals[i] })
  }
  return out
}

// ── math ──────────────────────────────────────────────────────────────────
export function sma(v: number[], n: number): number[] {
  const out = new Array(v.length).fill(NaN)
  let sum = 0
  for (let i = 0; i < v.length; i++) {
    sum += v[i]
    if (i >= n) sum -= v[i - n]
    if (i >= n - 1) out[i] = sum / n
  }
  return out
}

export function ema(v: number[], n: number): number[] {
  const out = new Array(v.length).fill(NaN)
  const k = 2 / (n + 1)
  let prev = NaN
  for (let i = 0; i < v.length; i++) {
    if (i < n - 1) continue
    if (Number.isNaN(prev)) {
      let s = 0
      for (let j = i - n + 1; j <= i; j++) s += v[j]
      prev = s / n
    } else {
      prev = v[i] * k + prev * (1 - k)
    }
    out[i] = prev
  }
  return out
}

function wma(v: number[], n: number): number[] {
  const out = new Array(v.length).fill(NaN)
  const denom = (n * (n + 1)) / 2
  for (let i = n - 1; i < v.length; i++) {
    let s = 0
    for (let j = 0; j < n; j++) s += v[i - j] * (n - j)
    out[i] = s / denom
  }
  return out
}

function vwap(bars: Bar[]): number[] {
  // Session VWAP: cumulative reset when the calendar day changes.
  const out = new Array(bars.length).fill(NaN)
  let cumPV = 0
  let cumV = 0
  let day = -1
  for (let i = 0; i < bars.length; i++) {
    const d = Math.floor((bars[i].time as number) / 86400)
    if (d !== day) {
      day = d
      cumPV = 0
      cumV = 0
    }
    const tp = (bars[i].high + bars[i].low + bars[i].close) / 3
    const vol = bars[i].volume || 0
    cumPV += tp * vol
    cumV += vol
    out[i] = cumV > 0 ? cumPV / cumV : tp
  }
  return out
}

export function rsi(v: number[], n: number): number[] {
  const out = new Array(v.length).fill(NaN)
  if (v.length <= n) return out
  let gain = 0
  let loss = 0
  for (let i = 1; i <= n; i++) {
    const d = v[i] - v[i - 1]
    if (d >= 0) gain += d
    else loss -= d
  }
  let avgG = gain / n
  let avgL = loss / n
  out[n] = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL)
  for (let i = n + 1; i < v.length; i++) {
    const d = v[i] - v[i - 1]
    avgG = (avgG * (n - 1) + (d > 0 ? d : 0)) / n
    avgL = (avgL * (n - 1) + (d < 0 ? -d : 0)) / n
    out[i] = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL)
  }
  return out
}

function trueRange(bars: Bar[]): number[] {
  const tr = new Array(bars.length).fill(NaN)
  for (let i = 0; i < bars.length; i++) {
    if (i === 0) {
      tr[i] = bars[i].high - bars[i].low
      continue
    }
    const pc = bars[i - 1].close
    tr[i] = Math.max(bars[i].high - bars[i].low, Math.abs(bars[i].high - pc), Math.abs(bars[i].low - pc))
  }
  return tr
}

export function atr(bars: Bar[], n: number): number[] {
  const tr = trueRange(bars)
  const out = new Array(bars.length).fill(NaN)
  let prev = NaN
  for (let i = 0; i < bars.length; i++) {
    if (i < n) continue
    if (Number.isNaN(prev)) {
      let s = 0
      for (let j = i - n + 1; j <= i; j++) s += tr[j]
      prev = s / n
    } else {
      prev = (prev * (n - 1) + tr[i]) / n
    }
    out[i] = prev
  }
  return out
}

function stdev(v: number[], n: number, mean: number[]): number[] {
  const out = new Array(v.length).fill(NaN)
  for (let i = n - 1; i < v.length; i++) {
    let s = 0
    for (let j = i - n + 1; j <= i; j++) {
      const d = v[j] - mean[i]
      s += d * d
    }
    out[i] = Math.sqrt(s / n)
  }
  return out
}

function bollinger(v: number[], n: number, mult: number): [number[], number[], number[]] {
  const mid = sma(v, n)
  const sd = stdev(v, n, mid)
  const up = mid.map((m, i) => m + mult * sd[i])
  const lo = mid.map((m, i) => m - mult * sd[i])
  return [mid, up, lo]
}

function macd(v: number[], fast: number, slow: number, sig: number): [number[], number[], number[]] {
  const ef = ema(v, fast)
  const es = ema(v, slow)
  const line = v.map((_, i) => ef[i] - es[i])
  const lineClean = line.map((x) => (Number.isFinite(x) ? x : NaN))
  const compact = lineClean.filter((x) => Number.isFinite(x))
  const sigCompact = ema(compact, sig)
  // re-expand signal to original index space
  const signal = new Array(v.length).fill(NaN)
  let k = 0
  for (let i = 0; i < v.length; i++) {
    if (Number.isFinite(lineClean[i])) {
      signal[i] = sigCompact[k]
      k++
    }
  }
  const hist = line.map((x, i) => x - signal[i])
  return [line, signal, hist]
}

function stoch(bars: Bar[], n: number, d: number): [number[], number[]] {
  const k = new Array(bars.length).fill(NaN)
  for (let i = n - 1; i < bars.length; i++) {
    let hh = -Infinity
    let ll = Infinity
    for (let j = i - n + 1; j <= i; j++) {
      hh = Math.max(hh, bars[j].high)
      ll = Math.min(ll, bars[j].low)
    }
    k[i] = hh === ll ? 50 : ((bars[i].close - ll) / (hh - ll)) * 100
  }
  const dl = sma(k.map((x) => (Number.isFinite(x) ? x : 0)), d).map((x, i) =>
    Number.isFinite(k[i]) ? x : NaN,
  )
  return [k, dl]
}

function cci(bars: Bar[], n: number): number[] {
  const tp = bars.map((b) => (b.high + b.low + b.close) / 3)
  const ma = sma(tp, n)
  const out = new Array(bars.length).fill(NaN)
  for (let i = n - 1; i < bars.length; i++) {
    let md = 0
    for (let j = i - n + 1; j <= i; j++) md += Math.abs(tp[j] - ma[i])
    md /= n
    out[i] = md === 0 ? 0 : (tp[i] - ma[i]) / (0.015 * md)
  }
  return out
}

function roc(v: number[], n: number): number[] {
  const out = new Array(v.length).fill(NaN)
  for (let i = n; i < v.length; i++) {
    out[i] = v[i - n] === 0 ? 0 : ((v[i] - v[i - n]) / v[i - n]) * 100
  }
  return out
}

function obv(bars: Bar[]): number[] {
  const out = new Array(bars.length).fill(NaN)
  let acc = 0
  for (let i = 0; i < bars.length; i++) {
    if (i > 0) {
      if (bars[i].close > bars[i - 1].close) acc += bars[i].volume
      else if (bars[i].close < bars[i - 1].close) acc -= bars[i].volume
    }
    out[i] = acc
  }
  return out
}
