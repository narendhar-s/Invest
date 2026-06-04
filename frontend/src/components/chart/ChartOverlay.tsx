import { useEffect, useRef } from 'react'
import type { IChartApi, ISeriesApi, Time } from 'lightweight-charts'

// Unified shape drawn by computed overlays (SMC) and user scripts. All
// coordinates are chart-native (unix-seconds time, price).
export interface OverlayShape {
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

type Props = {
  chart: IChartApi
  series: ISeriesApi<'Candlestick'>
  // Read by the render loop each frame so live recomputes show without
  // re-subscribing. Mutate shapesRef.current to update.
  shapesRef: React.MutableRefObject<OverlayShape[]>
}

// ChartOverlay is a transparent, non-interactive canvas that paints computed
// shapes (SMC zones/lines/labels, script drawings) on top of the chart,
// re-projecting them to pixels every frame so they track pan/zoom.
export default function ChartOverlay({ chart, series, shapesRef }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    let raf = 0
    const ts = chart.timeScale()

    const xOf = (t?: number) => (t == null ? null : ts.timeToCoordinate(t as Time))
    const yOf = (p?: number) => (p == null ? null : series.priceToCoordinate(p))

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
          ctx.font = '10px ui-sans-serif, system-ui'
          for (const s of shapesRef.current) draw(ctx, s, w, h, xOf, yOf)
        }
      }
      raf = requestAnimationFrame(render)
    }
    raf = requestAnimationFrame(render)
    return () => cancelAnimationFrame(raf)
  }, [chart, series, shapesRef])

  return <canvas ref={canvasRef} className="absolute inset-0 z-[5]" style={{ pointerEvents: 'none' }} />
}

function draw(
  ctx: CanvasRenderingContext2D,
  s: OverlayShape,
  w: number,
  h: number,
  xOf: (t?: number) => number | null,
  yOf: (p?: number) => number | null,
) {
  ctx.strokeStyle = s.color
  ctx.fillStyle = s.color
  ctx.lineWidth = 1.25
  if (s.dashed) ctx.setLineDash([4, 3])
  else ctx.setLineDash([])

  if (s.kind === 'hline') {
    const y = yOf(s.price)
    if (y == null) return
    ctx.beginPath()
    ctx.moveTo(0, y)
    ctx.lineTo(w, y)
    ctx.stroke()
    if (s.text) ctx.fillText(s.text, 4, y - 3)
    return
  }

  if (s.kind === 'line') {
    const x1 = xOf(s.t1)
    const y1 = yOf(s.p1)
    const x2 = xOf(s.t2)
    const y2 = yOf(s.p2)
    if (x1 == null || y1 == null || x2 == null || y2 == null) return
    ctx.beginPath()
    ctx.moveTo(x1, y1)
    ctx.lineTo(x2, y2)
    ctx.stroke()
    if (s.text) ctx.fillText(s.text, x2 + 3, y2 - 3)
    return
  }

  if (s.kind === 'box') {
    let x1 = xOf(s.t1)
    let x2 = xOf(s.t2)
    const y1 = yOf(s.p1)
    const y2 = yOf(s.p2)
    if (y1 == null || y2 == null) return
    // If an edge is off-screen, clamp to the canvas so zones stay visible.
    if (x1 == null) x1 = 0
    if (x2 == null) x2 = w
    const x = Math.min(x1, x2)
    const y = Math.min(y1, y2)
    const bw = Math.abs(x2 - x1)
    const bh = Math.abs(y2 - y1)
    ctx.globalAlpha = 0.15
    ctx.fillRect(x, y, bw, bh)
    ctx.globalAlpha = 1
    ctx.setLineDash([])
    ctx.strokeRect(x, y, bw, bh)
    if (s.text) ctx.fillText(s.text, x + 3, y + 11)
    return
  }

  if (s.kind === 'marker') {
    const x = xOf(s.time)
    const y = yOf(s.price)
    if (x == null || y == null) return
    const dir = s.above ? -1 : 1
    ctx.beginPath()
    ctx.moveTo(x, y + dir * 4)
    ctx.lineTo(x - 4, y + dir * 11)
    ctx.lineTo(x + 4, y + dir * 11)
    ctx.closePath()
    ctx.fill()
    if (s.text) {
      ctx.textAlign = 'center'
      ctx.fillText(s.text, x, y + dir * 16 + (s.above ? 0 : 6))
      ctx.textAlign = 'left'
    }
    return
  }

  if (s.kind === 'label') {
    const x = xOf(s.time)
    const y = yOf(s.price)
    if (x == null || y == null) return
    ctx.fillText(s.text ?? '', x + 3, y - 3)
  }
}
