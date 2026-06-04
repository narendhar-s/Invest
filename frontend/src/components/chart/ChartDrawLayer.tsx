import { useEffect, useRef, useState } from 'react'
import type { IChartApi, ISeriesApi, Time } from 'lightweight-charts'

// Drawing tools, mirroring the common TradingView set.
export type DrawTool =
  | 'cursor'
  | 'trendline'
  | 'ray'
  | 'hline'
  | 'vline'
  | 'rect'
  | 'fib'

// An anchor is stored in chart-native units (unix-seconds time + price) so the
// drawing stays pinned to the data when the user pans or zooms.
interface Anchor {
  time: number
  price: number
}

interface Drawing {
  id: string
  tool: DrawTool
  a: Anchor
  b: Anchor
  color: string
}

const TOOLS: { key: DrawTool; label: string; title: string }[] = [
  { key: 'cursor', label: '⊹', title: 'Cursor (pan/zoom)' },
  { key: 'trendline', label: '╱', title: 'Trend line' },
  { key: 'ray', label: '➚', title: 'Ray (extends right)' },
  { key: 'hline', label: '─', title: 'Horizontal line' },
  { key: 'vline', label: '│', title: 'Vertical line' },
  { key: 'rect', label: '▭', title: 'Rectangle' },
  { key: 'fib', label: 'Fib', title: 'Fibonacci retracement' },
]

const COLORS = ['#eab308', '#38bdf8', '#a78bfa', '#fb7185', '#34d399', '#e2e8f0']

const FIB_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1]

const storeKey = (symbol: string) => `chartdraw:${symbol}`

function load(symbol: string): Drawing[] {
  try {
    const raw = localStorage.getItem(storeKey(symbol))
    return raw ? (JSON.parse(raw) as Drawing[]) : []
  } catch {
    return []
  }
}

function persist(symbol: string, d: Drawing[]) {
  try {
    localStorage.setItem(storeKey(symbol), JSON.stringify(d))
  } catch {
    /* quota / private mode — ignore */
  }
}

type Props = {
  chart: IChartApi
  series: ISeriesApi<'Candlestick'>
  symbol: string
}

// ChartDrawLayer renders a floating tool palette plus a transparent canvas that
// sits on top of a lightweight-charts instance, letting the user draw trend
// lines, rays, levels, rectangles and fib retracements. Drawings are anchored in
// data coordinates and persisted per-symbol in localStorage.
export default function ChartDrawLayer({ chart, series, symbol }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [tool, setTool] = useState<DrawTool>('cursor')
  const [color, setColor] = useState(COLORS[0])
  const [drawings, setDrawings] = useState<Drawing[]>(() => load(symbol))

  // Refs the rAF render loop reads without re-subscribing.
  const drawingsRef = useRef<Drawing[]>(drawings)
  const draftRef = useRef<Drawing | null>(null)
  const colorRef = useRef(color)
  drawingsRef.current = drawings
  colorRef.current = color

  // Reload drawings when the symbol changes.
  useEffect(() => {
    setDrawings(load(symbol))
    draftRef.current = null
  }, [symbol])

  // Persist on every change.
  useEffect(() => {
    persist(symbol, drawings)
  }, [symbol, drawings])

  // ── coordinate helpers ──────────────────────────────────────────────────
  const anchorToXY = (a: Anchor): { x: number; y: number } | null => {
    const x = chart.timeScale().timeToCoordinate(a.time as Time)
    const y = series.priceToCoordinate(a.price)
    if (x == null || y == null) return null
    return { x, y }
  }

  const xyToAnchor = (x: number, y: number): Anchor | null => {
    const t = chart.timeScale().coordinateToTime(x)
    const p = series.coordinateToPrice(y)
    if (t == null || p == null) return null
    return { time: t as number, price: p as number }
  }

  // ── render loop ─────────────────────────────────────────────────────────
  useEffect(() => {
    let raf = 0
    const render = () => {
      const cv = canvasRef.current
      const parent = cv?.parentElement
      if (cv && parent) {
        const w = parent.clientWidth
        const h = parent.clientHeight
        const dpr = window.devicePixelRatio || 1
        if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
          cv.width = Math.round(w * dpr)
          cv.height = Math.round(h * dpr)
          cv.style.width = `${w}px`
          cv.style.height = `${h}px`
        }
        const ctx = cv.getContext('2d')
        if (ctx) {
          ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
          ctx.clearRect(0, 0, w, h)
          const all = draftRef.current
            ? [...drawingsRef.current, draftRef.current]
            : drawingsRef.current
          for (const d of all) drawOne(ctx, d, w, h)
        }
      }
      raf = requestAnimationFrame(render)
    }
    raf = requestAnimationFrame(render)
    return () => cancelAnimationFrame(raf)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chart, series])

  const drawOne = (
    ctx: CanvasRenderingContext2D,
    d: Drawing,
    w: number,
    h: number,
  ) => {
    ctx.lineWidth = 1.5
    ctx.strokeStyle = d.color
    ctx.fillStyle = d.color
    ctx.font = '10px ui-sans-serif, system-ui'

    if (d.tool === 'hline') {
      const p = series.priceToCoordinate(d.a.price)
      if (p == null) return
      ctx.beginPath()
      ctx.moveTo(0, p)
      ctx.lineTo(w, p)
      ctx.stroke()
      ctx.fillText(d.a.price.toFixed(2), 4, p - 3)
      return
    }

    if (d.tool === 'vline') {
      const x = chart.timeScale().timeToCoordinate(d.a.time as Time)
      if (x == null) return
      ctx.beginPath()
      ctx.moveTo(x, 0)
      ctx.lineTo(x, h)
      ctx.stroke()
      return
    }

    const a = anchorToXY(d.a)
    const b = anchorToXY(d.b)
    if (!a || !b) return

    if (d.tool === 'trendline') {
      ctx.beginPath()
      ctx.moveTo(a.x, a.y)
      ctx.lineTo(b.x, b.y)
      ctx.stroke()
      return
    }

    if (d.tool === 'ray') {
      const dx = b.x - a.x
      const dy = b.y - a.y
      // Extend toward the right edge of the canvas.
      const t = dx === 0 ? h : (w - a.x) / dx
      const ex = a.x + dx * t
      const ey = a.y + dy * t
      ctx.beginPath()
      ctx.moveTo(a.x, a.y)
      ctx.lineTo(ex, ey)
      ctx.stroke()
      return
    }

    if (d.tool === 'rect') {
      const x = Math.min(a.x, b.x)
      const y = Math.min(a.y, b.y)
      const rw = Math.abs(b.x - a.x)
      const rh = Math.abs(b.y - a.y)
      ctx.globalAlpha = 0.12
      ctx.fillRect(x, y, rw, rh)
      ctx.globalAlpha = 1
      ctx.strokeRect(x, y, rw, rh)
      return
    }

    if (d.tool === 'fib') {
      const x0 = Math.min(a.x, b.x)
      const x1 = Math.max(a.x, b.x)
      // price levels: a.price = 0, b.price = 1
      for (const lvl of FIB_LEVELS) {
        const price = d.a.price + (d.b.price - d.a.price) * lvl
        const y = series.priceToCoordinate(price)
        if (y == null) continue
        ctx.globalAlpha = 0.7
        ctx.beginPath()
        ctx.moveTo(x0, y)
        ctx.lineTo(x1, y)
        ctx.stroke()
        ctx.globalAlpha = 1
        ctx.fillText(`${(lvl * 100).toFixed(1)}%  ${price.toFixed(2)}`, x1 + 4, y - 2)
      }
    }
  }

  // ── pointer handling ────────────────────────────────────────────────────
  const localXY = (e: React.PointerEvent) => {
    const rect = canvasRef.current!.getBoundingClientRect()
    return { x: e.clientX - rect.left, y: e.clientY - rect.top }
  }

  const commit = (d: Drawing) => setDrawings((prev) => [...prev, d])

  const onPointerDown = (e: React.PointerEvent) => {
    if (tool === 'cursor') return
    const { x, y } = localXY(e)
    const a = xyToAnchor(x, y)
    if (!a) return
    canvasRef.current?.setPointerCapture(e.pointerId)
    const id = `d-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
    if (tool === 'hline' || tool === 'vline') {
      commit({ id, tool, a, b: a, color: colorRef.current })
      return
    }
    draftRef.current = { id, tool, a, b: a, color: colorRef.current }
  }

  const onPointerMove = (e: React.PointerEvent) => {
    if (!draftRef.current) return
    const { x, y } = localXY(e)
    const b = xyToAnchor(x, y)
    if (b) draftRef.current = { ...draftRef.current, b }
  }

  const onPointerUp = (e: React.PointerEvent) => {
    canvasRef.current?.releasePointerCapture?.(e.pointerId)
    const d = draftRef.current
    draftRef.current = null
    if (!d) return
    const ap = anchorToXY(d.a)
    const bp = anchorToXY(d.b)
    if (ap && bp && Math.hypot(bp.x - ap.x, bp.y - ap.y) < 4) return // ignore stray clicks
    commit(d)
  }

  const undo = () => setDrawings((prev) => prev.slice(0, -1))
  const clear = () => setDrawings([])

  return (
    <>
      {/* floating tool palette */}
      <div className="absolute top-2 left-2 z-20 flex items-center gap-1 rounded-lg border border-slate-700 bg-dark-900/90 px-1.5 py-1 backdrop-blur">
        {TOOLS.map((t) => (
          <button
            key={t.key}
            title={t.title}
            onClick={() => setTool(t.key)}
            className={`h-6 min-w-6 px-1 rounded text-xs font-medium ${
              tool === t.key
                ? 'bg-brand-500/30 text-brand-300'
                : 'text-slate-400 hover:bg-slate-800'
            }`}
          >
            {t.label}
          </button>
        ))}
        <span className="mx-1 h-4 w-px bg-slate-700" />
        {COLORS.map((c) => (
          <button
            key={c}
            title={c}
            onClick={() => setColor(c)}
            className={`h-4 w-4 rounded-full border ${
              color === c ? 'border-white' : 'border-transparent'
            }`}
            style={{ background: c }}
          />
        ))}
        <span className="mx-1 h-4 w-px bg-slate-700" />
        <button
          onClick={undo}
          title="Undo last"
          className="h-6 px-1.5 rounded text-xs text-slate-400 hover:bg-slate-800"
        >
          undo
        </button>
        <button
          onClick={clear}
          title="Clear all"
          className="h-6 px-1.5 rounded text-xs text-red-400/80 hover:bg-slate-800"
        >
          clear
        </button>
      </div>

      <canvas
        ref={canvasRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        className="absolute inset-0 z-10"
        style={{ pointerEvents: tool === 'cursor' ? 'none' : 'auto', cursor: 'crosshair' }}
      />
    </>
  )
}
