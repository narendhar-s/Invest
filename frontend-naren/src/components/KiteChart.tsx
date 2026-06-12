import { useMemo, useRef, useState, useEffect } from 'react'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ChartBar {
  time: string
  open: number; high: number; low: number; close: number; volume: number
  ema9: number; ema21: number
  strategy?: string; regime?: string
  is_entry?: boolean; is_exit?: boolean; entry_dir?: string
}

export interface TradeMarker {
  entry_time: string; exit_time: string
  direction: string; pnl: number; strike: number
  option_type: string; expiry_label: string
  entry_premium: number; exit_premium: number; price_source: string
}

interface Props {
  bars: ChartBar[]
  trades?: TradeMarker[]
  height?: number
  title?: string
  showVolume?: boolean
}

// ─── Constants ────────────────────────────────────────────────────────────────

const PAD_L = 4, PAD_R = 64, PAD_T = 24, PAD_B = 32

// ─── Helpers ──────────────────────────────────────────────────────────────────

const fmtTime = (iso: string) => {
  const d = new Date(iso)
  const h = d.getHours().toString().padStart(2, '0')
  const m = d.getMinutes().toString().padStart(2, '0')
  const day = d.getDate().toString().padStart(2, '0')
  const mon = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getMonth()]
  return `${day} ${mon} ${h}:${m}`
}

const fmtDate = (iso: string) => {
  const d = new Date(iso)
  return `${d.getDate()} ${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getMonth()]}`
}

// ─── KiteChart ────────────────────────────────────────────────────────────────

export default function KiteChart({ bars, trades = [], height = 420, title, showVolume = true }: Props) {
  const svgRef   = useRef<SVGSVGElement>(null)
  const [svgW,   setSvgW]   = useState(900)
  const [hover,  setHover]  = useState<{ x: number; y: number; bar: ChartBar } | null>(null)
  const [viewStart, setViewStart] = useState(0) // index of first visible bar
  const [isDragging, setIsDragging] = useState(false)
  const [dragStartX, setDragStartX] = useState(0)
  const [dragStartView, setDragStartView] = useState(0)

  // Resize observer
  useEffect(() => {
    if (!svgRef.current) return
    const obs = new ResizeObserver(e => setSvgW(e[0].contentRect.width || 900))
    obs.observe(svgRef.current)
    return () => obs.disconnect()
  }, [])

  // Visible bars count based on width
  const visibleCount = Math.max(30, Math.min(bars.length, Math.floor((svgW - PAD_L - PAD_R) / 9)))

  // Init viewStart to show latest bars
  useEffect(() => {
    setViewStart(Math.max(0, bars.length - visibleCount))
  }, [bars.length, visibleCount])

  const visibleBars = bars.slice(viewStart, viewStart + visibleCount)

  // Volume pane height
  const volH = showVolume && visibleBars.some(b => b.volume > 0) ? Math.round(height * 0.15) : 0
  const chartH = height - volH

  // Price scale
  const prices = visibleBars.flatMap(b => [b.high, b.low, b.ema9, b.ema21].filter(v => v > 0))
  const pMin = Math.min(...prices) * 0.9995
  const pMax = Math.max(...prices) * 1.0005
  const pRange = pMax - pMin || 1

  const pw  = svgW - PAD_L - PAD_R
  const ph  = chartH - PAD_T - PAD_B
  const barW = pw / Math.max(visibleBars.length, 1)
  const candleW = Math.max(2, barW * 0.7)

  const px = (i: number) => PAD_L + (i + 0.5) * barW
  const py = (p: number) => PAD_T + (1 - (p - pMin) / pRange) * ph

  // Volume scale
  const volumes = visibleBars.map(b => b.volume).filter(v => v > 0)
  const vMax = volumes.length ? Math.max(...volumes) : 1
  const volPY = (v: number) => chartH + volH - Math.round((v / vMax) * volH * 0.9)

  // Price grid lines
  const gridLines = useMemo(() => {
    const range = pMax - pMin
    const step = [5,10,20,25,50,100,200,250,500].find(s => ph / (range / s) > 30) || 50
    const start = Math.ceil(pMin / step) * step
    const lines: number[] = []
    for (let p = start; p <= pMax; p += step) lines.push(p)
    return lines
  }, [pMin, pMax, ph])

  // Day separators
  const daySeps = useMemo(() => {
    const seps: number[] = []
    for (let i = 1; i < visibleBars.length; i++) {
      const prev = new Date(visibleBars[i-1].time)
      const curr = new Date(visibleBars[i].time)
      if (prev.getDate() !== curr.getDate()) seps.push(i)
    }
    return seps
  }, [visibleBars])

  // Map trade entry/exit times to bar indices
  const tradeBarMap = useMemo(() => {
    const entries: Map<string, TradeMarker> = new Map()
    const exits:   Map<string, TradeMarker> = new Map()
    for (const t of trades) {
      entries.set(t.entry_time, t)
      exits.set(t.exit_time, t)
    }
    return { entries, exits }
  }, [trades])

  // Scroll/drag
  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault()
    const delta = e.deltaY > 0 ? 3 : -3
    setViewStart(v => Math.max(0, Math.min(bars.length - visibleCount, v + delta)))
  }

  const onMouseDown = (e: React.MouseEvent) => {
    setIsDragging(true); setDragStartX(e.clientX); setDragStartView(viewStart)
  }
  const onMouseMove = (e: React.MouseEvent) => {
    if (isDragging) {
      const dx = Math.round((dragStartX - e.clientX) / barW)
      setViewStart(Math.max(0, Math.min(bars.length - visibleCount, dragStartView + dx)))
    }
    // Hover
    const rect = svgRef.current?.getBoundingClientRect()
    if (!rect) return
    const x = e.clientX - rect.left - PAD_L
    const idx = Math.floor(x / barW)
    if (idx >= 0 && idx < visibleBars.length) {
      setHover({ x: px(idx), y: e.clientY - rect.top, bar: visibleBars[idx] })
    } else {
      setHover(null)
    }
  }
  const onMouseUp = () => setIsDragging(false)
  const onMouseLeave = () => { setIsDragging(false); setHover(null) }

  if (!bars.length) return (
    <div className="flex items-center justify-center bg-slate-900 rounded-xl border border-slate-700/50" style={{ height }}>
      <p className="text-slate-500 text-sm">No chart data</p>
    </div>
  )

  return (
    <div className="bg-slate-900 rounded-xl border border-slate-700/50 overflow-hidden select-none">
      {title && (
        <div className="px-4 py-2.5 border-b border-slate-700/50 flex items-center justify-between">
          <span className="text-sm font-semibold text-slate-200">{title}</span>
          <div className="flex items-center gap-4 text-xs text-slate-500">
            <span className="flex items-center gap-1"><span className="w-5 h-0.5 bg-blue-400 inline-block" /> EMA9</span>
            <span className="flex items-center gap-1"><span className="w-5 h-0.5 bg-orange-400 inline-block" /> EMA21</span>
            {trades.length > 0 && <><span className="text-emerald-400">▲ Buy</span><span className="text-red-400">▼ Sell/Exit</span></>}
          </div>
        </div>
      )}
      <svg
        ref={svgRef} width="100%" height={height}
        style={{ display: 'block', cursor: isDragging ? 'grabbing' : 'crosshair' }}
        onWheel={onWheel} onMouseDown={onMouseDown} onMouseMove={onMouseMove}
        onMouseUp={onMouseUp} onMouseLeave={onMouseLeave}
      >
        {/* Background */}
        <rect x={0} y={0} width={svgW} height={height} fill="#0f172a" />
        <rect x={PAD_L} y={PAD_T} width={pw} height={ph} fill="#0f172a" />

        {/* Grid lines */}
        {gridLines.map(p => {
          const y = py(p)
          if (y < PAD_T || y > PAD_T + ph) return null
          return (
            <g key={p}>
              <line x1={PAD_L} y1={y} x2={PAD_L + pw} y2={y} stroke="#1e293b" strokeWidth="1" />
              <text x={PAD_L + pw + 4} y={y + 4} fill="#64748b" fontSize="10" fontFamily="monospace">{p}</text>
            </g>
          )
        })}

        {/* Day separators */}
        {daySeps.map(i => {
          const x = PAD_L + i * barW
          return (
            <g key={i}>
              <line x1={x} y1={PAD_T} x2={x} y2={PAD_T + ph + volH} stroke="#334155" strokeWidth="1" strokeDasharray="3 3" />
              <text x={x + 2} y={PAD_T - 4} fill="#475569" fontSize="9" fontFamily="monospace">
                {fmtDate(visibleBars[i]?.time || '')}
              </text>
            </g>
          )
        })}

        {/* EMA21 */}
        {visibleBars.length > 1 && (
          <polyline
            points={visibleBars.map((b, i) => b.ema21 > 0 ? `${px(i)},${py(b.ema21)}` : '').filter(Boolean).join(' ')}
            fill="none" stroke="#f97316" strokeWidth="1.5" strokeOpacity="0.9" />
        )}
        {/* EMA9 */}
        {visibleBars.length > 1 && (
          <polyline
            points={visibleBars.map((b, i) => b.ema9 > 0 ? `${px(i)},${py(b.ema9)}` : '').filter(Boolean).join(' ')}
            fill="none" stroke="#60a5fa" strokeWidth="1.5" strokeOpacity="0.9" />
        )}

        {/* Candles */}
        {visibleBars.map((b, i) => {
          const xc = px(i)
          const isGreen = b.close >= b.open
          const col = isGreen ? '#22c55e' : '#ef4444'
          const bodyTop = py(Math.max(b.open, b.close))
          const bodyBot = py(Math.min(b.open, b.close))
          const bodyH   = Math.max(1, bodyBot - bodyTop)
          const x0 = xc - candleW / 2

          const tradeEntry = tradeBarMap.entries.get(b.time)
          const tradeExit  = tradeBarMap.exits.get(b.time)

          return (
            <g key={i}>
              {/* Wick */}
              <line x1={xc} y1={py(b.high)} x2={xc} y2={py(b.low)} stroke={col} strokeWidth="1" />
              {/* Body */}
              <rect x={x0} y={bodyTop} width={candleW} height={bodyH}
                fill={isGreen ? col : col} fillOpacity="0.85" rx="0.5" />
              {/* Signal background highlight */}
              {b.is_entry && (
                <rect x={x0 - 2} y={PAD_T} width={candleW + 4} height={ph}
                  fill={b.entry_dir === 'BULLISH' ? '#22c55e' : b.entry_dir === 'BEARISH' ? '#ef4444' : '#a78bfa'}
                  fillOpacity="0.07" />
              )}
              {/* Entry arrow */}
              {tradeEntry && (
                <g>
                  {tradeEntry.direction === 'BULLISH' ? (
                    <polygon points={`${xc},${py(b.low) + 22} ${xc - 6},${py(b.low) + 34} ${xc + 6},${py(b.low) + 34}`}
                      fill="#22c55e" />
                  ) : tradeEntry.direction === 'BEARISH' ? (
                    <polygon points={`${xc},${py(b.high) - 22} ${xc - 6},${py(b.high) - 34} ${xc + 6},${py(b.high) - 34}`}
                      fill="#ef4444" />
                  ) : (
                    <polygon points={`${xc},${py(b.low) + 22} ${xc - 6},${py(b.low) + 34} ${xc + 6},${py(b.low) + 34}`}
                      fill="#a78bfa" />
                  )}
                  <text x={xc} y={py(b.low) + 46} textAnchor="middle" fill="#94a3b8" fontSize="8" fontFamily="monospace">
                    ₹{tradeEntry.entry_premium?.toFixed(0)}
                  </text>
                </g>
              )}
              {/* Exit mark */}
              {tradeExit && (
                <g>
                  <line x1={xc - 5} y1={py(b.high) - 20} x2={xc + 5} y2={py(b.high) - 10}
                    stroke={tradeExit.pnl >= 0 ? '#22c55e' : '#ef4444'} strokeWidth="2" />
                  <line x1={xc + 5} y1={py(b.high) - 20} x2={xc - 5} y2={py(b.high) - 10}
                    stroke={tradeExit.pnl >= 0 ? '#22c55e' : '#ef4444'} strokeWidth="2" />
                  <text x={xc} y={py(b.high) - 22} textAnchor="middle"
                    fill={tradeExit.pnl >= 0 ? '#22c55e' : '#ef4444'} fontSize="8" fontFamily="monospace">
                    {tradeExit.pnl >= 0 ? '+' : ''}₹{tradeExit.pnl?.toFixed(0)}
                  </text>
                </g>
              )}
            </g>
          )
        })}

        {/* Volume bars */}
        {volH > 0 && visibleBars.map((b, i) => {
          if (!b.volume) return null
          const xc = px(i)
          const x0 = xc - candleW / 2
          const vh = chartH + volH - volPY(b.volume)
          const isGreen = b.close >= b.open
          return (
            <rect key={i} x={x0} y={volPY(b.volume)} width={candleW} height={vh}
              fill={isGreen ? '#22c55e' : '#ef4444'} fillOpacity="0.4" />
          )
        })}

        {/* Hover crosshair */}
        {hover && (
          <>
            <line x1={hover.x} y1={PAD_T} x2={hover.x} y2={PAD_T + ph + volH}
              stroke="#64748b" strokeWidth="1" strokeDasharray="3 3" />
            <line x1={PAD_L} y1={hover.y} x2={PAD_L + pw} y2={hover.y}
              stroke="#64748b" strokeWidth="1" strokeDasharray="3 3" />
          </>
        )}
      </svg>

      {/* Hover tooltip */}
      {hover && (
        <div className="px-4 py-2 border-t border-slate-700/50 flex flex-wrap items-center gap-4 text-xs font-mono text-slate-300 bg-slate-900">
          <span className="text-slate-400">{fmtTime(hover.bar.time)}</span>
          <span>O <span className="text-slate-200">{hover.bar.open}</span></span>
          <span>H <span className="text-emerald-400">{hover.bar.high}</span></span>
          <span>L <span className="text-red-400">{hover.bar.low}</span></span>
          <span>C <span className={hover.bar.close >= hover.bar.open ? 'text-emerald-400' : 'text-red-400'}>
            {hover.bar.close}
          </span></span>
          <span>EMA9 <span className="text-blue-400">{hover.bar.ema9}</span></span>
          <span>EMA21 <span className="text-orange-400">{hover.bar.ema21}</span></span>
          {hover.bar.strategy && hover.bar.strategy !== 'NO_TRADE' && (
            <span className="text-purple-400">{hover.bar.strategy.replace(/_/g,' ')}</span>
          )}
        </div>
      )}

      {/* Scroll hint */}
      <div className="px-4 py-1 text-[10px] text-slate-600 border-t border-slate-800 flex items-center justify-between">
        <span>Scroll to pan · {visibleBars.length} of {bars.length} bars</span>
        <span>
          {bars.length > 0 && `${fmtTime(bars[viewStart]?.time || '')} → ${fmtTime(bars[Math.min(viewStart + visibleCount - 1, bars.length - 1)]?.time || '')}`}
        </span>
      </div>
    </div>
  )
}
