import type { UTCTimestamp } from 'lightweight-charts'
import type { Bar } from './bar'
import type { Plot, LinePoint } from './indicators'
import { sma, ema, rsi, atr } from './indicators'

// Shapes a script can draw onto the overlay canvas.
export interface ScriptShape {
  kind: 'line' | 'hline' | 'box' | 'marker' | 'label'
  t1?: number
  p1?: number
  t2?: number
  p2?: number
  price?: number
  time?: number
  text?: string
  color: string
  dashed?: boolean
  above?: boolean
}

export interface ScriptResult {
  plots: Plot[]
  shapes: ScriptShape[]
  error?: string
}

const PALETTE = ['#eab308', '#38bdf8', '#a78bfa', '#fb7185', '#34d399', '#f97316']

// runScript evaluates a user expression or JS snippet against the bars.
//
// Two modes, auto-detected:
//   • formula  — a single expression like `sma(close,20)-sma(close,50)` is
//                wrapped in plot(...) and drawn as a line.
//   • script   — multi-line JS with access to a small draw API.
//
// Available in scope:
//   bars, open, high, low, close, volume, time   (arrays, index-aligned)
//   sma, ema, rsi, atr, highest, lowest, Math
//   plot(values, {color,width,pane})             -> line on price (or 'lower') pane
//   line(t1,p1,t2,p2,{color,dashed})
//   hline(price,{color,dashed})
//   box(t1,p1,t2,p2,{color})
//   marker(time,price,text,{color,above})
//   label(time,price,text,{color,above})
//
// NOTE: scripts run in the user's own browser via Function(); they are not a
// hardened sandbox. They only run code the user typed themselves.
export function runScript(code: string, bars: Bar[], id: string): ScriptResult {
  const plots: Plot[] = []
  const shapes: ScriptShape[] = []
  if (!code.trim() || bars.length === 0) return { plots, shapes }

  const open = bars.map((b) => b.open)
  const high = bars.map((b) => b.high)
  const low = bars.map((b) => b.low)
  const close = bars.map((b) => b.close)
  const volume = bars.map((b) => b.volume)
  const time = bars.map((b) => b.time as number)

  const highest = (v: number[], n: number) =>
    v.map((_, i) => (i < n - 1 ? NaN : Math.max(...v.slice(i - n + 1, i + 1))))
  const lowest = (v: number[], n: number) =>
    v.map((_, i) => (i < n - 1 ? NaN : Math.min(...v.slice(i - n + 1, i + 1))))

  let plotSeq = 0
  const toPoints = (vals: unknown): LinePoint[] => {
    const arr = vals as Array<number | { time: number; value: number }>
    if (!Array.isArray(arr)) return []
    const out: LinePoint[] = []
    if (arr.length && typeof arr[0] === 'object') {
      for (const p of arr as { time: number; value: number }[]) {
        if (Number.isFinite(p.value)) out.push({ time: p.time as UTCTimestamp, value: p.value })
      }
      return out
    }
    const nums = arr as number[]
    for (let i = 0; i < Math.min(nums.length, bars.length); i++) {
      if (Number.isFinite(nums[i])) out.push({ time: bars[i].time, value: nums[i] })
    }
    return out
  }

  const plot = (vals: unknown, opts: { color?: string; width?: 1 | 2 | 3 | 4; pane?: 'price' | 'lower' } = {}) => {
    plots.push({
      key: `${id}-p${plotSeq}`,
      data: toPoints(vals),
      color: opts.color ?? PALETTE[plotSeq % PALETTE.length],
      style: 'line',
      pane: opts.pane ?? 'price',
      group: `${id}-p${plotSeq}`,
      lineWidth: opts.width ?? 1,
    })
    plotSeq++
  }

  const line = (t1: number, p1: number, t2: number, p2: number, o: { color?: string; dashed?: boolean } = {}) =>
    shapes.push({ kind: 'line', t1, p1, t2, p2, color: o.color ?? '#eab308', dashed: o.dashed })
  const hline = (price: number, o: { color?: string; dashed?: boolean } = {}) =>
    shapes.push({ kind: 'hline', price, color: o.color ?? '#eab308', dashed: o.dashed })
  const box = (t1: number, p1: number, t2: number, p2: number, o: { color?: string } = {}) =>
    shapes.push({ kind: 'box', t1, p1, t2, p2, color: o.color ?? 'rgba(56,189,248,0.4)' })
  const marker = (t: number, price: number, text: string, o: { color?: string; above?: boolean } = {}) =>
    shapes.push({ kind: 'marker', time: t, price, text, color: o.color ?? '#38bdf8', above: o.above ?? true })
  const label = (t: number, price: number, text: string, o: { color?: string; above?: boolean } = {}) =>
    shapes.push({ kind: 'label', time: t, price, text, color: o.color ?? '#e2e8f0', above: o.above ?? true })

  const trimmed = code.trim()
  const isFormula = !/[;\n]/.test(trimmed) && !/\b(plot|line|hline|box|marker|label)\s*\(/.test(trimmed)
  const body = isFormula ? `plot(${trimmed})` : trimmed

  const names = [
    'bars', 'open', 'high', 'low', 'close', 'volume', 'time',
    'sma', 'ema', 'rsi', 'atr', 'highest', 'lowest',
    'plot', 'line', 'hline', 'box', 'marker', 'label',
  ]
  const values = [
    bars, open, high, low, close, volume, time,
    sma, ema, rsi, atr, highest, lowest,
    plot, line, hline, box, marker, label,
  ]

  try {
    // eslint-disable-next-line no-new-func
    const fn = new Function(...names, `"use strict";\n${body}`)
    fn(...values)
  } catch (e) {
    return { plots, shapes, error: e instanceof Error ? e.message : String(e) }
  }
  // guard against runaway output
  return { plots: plots.slice(0, 8), shapes: shapes.slice(0, 500) }
}
