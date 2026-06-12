/**
 * NiftyChart — Real-time NIFTY candlestick chart
 *
 * Data priority:
 *   1. Angel One SmartAPI WebSocket (/api/naren/v1/ao/ws) — true real-time ticks
 *   2. Polling /api/naren/v1/nifty/chart-data every 60 s — 15-min delayed fallback
 *
 * Overlays: EMA9 (amber) · EMA21 (cyan) · VWAP (blue)
 * Markers:  ▲ CE signal · ▼ PE signal
 */

import { useEffect, useRef, useCallback, useState } from 'react'
import { createChart, ColorType, CrosshairMode, LineStyle } from 'lightweight-charts'

export interface NiftyBar {
  date: string
  unix_time: number
  open: number; high: number; low: number; close: number
  volume: number
  ema9: number; ema21: number; vwap: number
  rsi: number; atr: number
  signal?: string
}

interface NiftyChartProps {
  bars?: NiftyBar[]
  height?: number
  signals?: Array<{ unix: number; dir: 'CE' | 'PE'; label?: string }>
  refreshMs?: number
  onBarsLoaded?: (bars: NiftyBar[]) => void
}

const C = {
  bg: '#0f172a', grid: '#1e293b', text: '#94a3b8',
  up: '#34d399', dn: '#f87171',
  ema9: '#f59e0b', ema21: '#22d3ee', vwap: '#60a5fa',
}

export default function NiftyChart({ bars: propBars, height = 520, signals = [], refreshMs = 60_000, onBarsLoaded }: NiftyChartProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef     = useRef<ReturnType<typeof createChart> | null>(null)
  const candleRef    = useRef<ReturnType<ReturnType<typeof createChart>['addCandlestickSeries']> | null>(null)
  const ema9Ref      = useRef<ReturnType<ReturnType<typeof createChart>['addLineSeries']> | null>(null)
  const ema21Ref     = useRef<ReturnType<ReturnType<typeof createChart>['addLineSeries']> | null>(null)
  const vwapRef      = useRef<ReturnType<ReturnType<typeof createChart>['addLineSeries']> | null>(null)
  const barsRef      = useRef<NiftyBar[]>([])
  const wsRef        = useRef<WebSocket | null>(null)
  const [source, setSource] = useState<'live' | 'delayed' | 'connecting'>('connecting')
  const [livePrice, setLivePrice] = useState<number | null>(null)

  // ── Apply bar array to chart series ─────────────────────────────────────
  const applyBars = useCallback((bars: NiftyBar[]) => {
    barsRef.current = bars
    if (!candleRef.current) return
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const t = (b: NiftyBar): any => b.unix_time
    candleRef.current.setData(bars.map(b => ({ time: t(b), open: b.open, high: b.high, low: b.low, close: b.close })))
    ema9Ref.current?.setData(bars.filter(b => b.ema9 > 0).map(b => ({ time: t(b), value: b.ema9 })))
    ema21Ref.current?.setData(bars.filter(b => b.ema21 > 0).map(b => ({ time: t(b), value: b.ema21 })))
    vwapRef.current?.setData(bars.filter(b => b.vwap > 0).map(b => ({ time: t(b), value: b.vwap })))
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const markers: any[] = []
    bars.forEach(b => {
      if (b.signal === 'CE' || b.signal === 'BUY')
        markers.push({ time: t(b), position: 'belowBar', color: '#34d399', shape: 'arrowUp', text: 'CE' })
      else if (b.signal === 'PE' || b.signal === 'SELL')
        markers.push({ time: t(b), position: 'aboveBar', color: '#f87171', shape: 'arrowDown', text: 'PE' })
    })
    signals.forEach(s => markers.push(s.dir === 'CE'
      ? { time: s.unix, position: 'belowBar', color: '#a78bfa', shape: 'circle', text: s.label ?? '▲' }
      : { time: s.unix, position: 'aboveBar', color: '#fb923c', shape: 'circle', text: s.label ?? '▼' }))
    markers.sort((a, b) => a.time - b.time)
    candleRef.current.setMarkers(markers)
    chartRef.current?.timeScale().fitContent()
  }, [signals])

  // ── Patch a single live candle (from WebSocket) ──────────────────────────
  const patchCandle = useCallback((bar: { time: number; open: number; high: number; low: number; close: number; volume: number }, isFinal: boolean) => {
    if (!candleRef.current) return
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    candleRef.current.update({ time: bar.time / 1000 as any, open: bar.open, high: bar.high, low: bar.low, close: bar.close })
    if (isFinal) {
      // Add to barsRef so history stays consistent
      const newBar: NiftyBar = {
        date: new Date(bar.time).toISOString().slice(0, 16).replace('T', ' '),
        unix_time: Math.floor(bar.time / 1000),
        open: bar.open, high: bar.high, low: bar.low, close: bar.close,
        volume: bar.volume, ema9: 0, ema21: 0, vwap: 0, rsi: 0, atr: 0,
      }
      barsRef.current = [...barsRef.current, newBar]
    }
  }, [])

  // ── Fetch data — Angel One primary, Yahoo fallback ───────────────────────
  const fetchAndApply = useCallback(async () => {
    try {
      // Try Angel One first
      const aoRes = await fetch('/api/naren/v1/ao/status')
      const aoStatus = await aoRes.json()
      if (aoStatus.enabled) {
        const res = await fetch('/api/naren/v1/ao/candles?timeframe=5m&days=30')
        if (res.ok) {
          const json = await res.json()
          const bars: NiftyBar[] = (json.bars ?? []).map((b: NiftyBar & { ema9?: number; ema21?: number; vwap?: number }) => ({
            ...b, ema9: b.ema9 ?? 0, ema21: b.ema21 ?? 0, vwap: b.vwap ?? 0, rsi: 0, atr: 0,
          }))
          if (bars.length > 0) {
            onBarsLoaded?.(bars)
            applyBars(bars)
            return
          }
        }
      }
    } catch { /* fall through */ }
    // Yahoo Finance fallback
    try {
      const res = await fetch('/api/naren/v1/nifty/chart-data?timeframe=5m&days=30')
      if (!res.ok) return
      const json = await res.json()
      const bars: NiftyBar[] = json.bars ?? []
      onBarsLoaded?.(bars)
      applyBars(bars)
    } catch { /* ignore */ }
  }, [applyBars, onBarsLoaded])

  // ── Try Angel One WebSocket ───────────────────────────────────────────────
  const connectAngelOne = useCallback(() => {
    // Check if Angel One is enabled first
    fetch('/api/naren/v1/ao/status')
      .then(r => r.json())
      .then(status => {
        if (!status.enabled) {
          setSource('delayed')
          return
        }

        setSource('connecting')
        const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws'
        const ws = new WebSocket(`${protocol}://${window.location.host}/api/naren/v1/ao/ws`)
        wsRef.current = ws

        ws.onopen = () => {
          setSource('live')
        }

        ws.onmessage = (e) => {
          try {
            const msg = JSON.parse(e.data)
            if (msg.type === 'history' && Array.isArray(msg.candles)) {
              const bars: NiftyBar[] = msg.candles.map((c: { time: number; open: number; high: number; low: number; close: number; volume: number }) => ({
                date: new Date(c.time).toISOString().slice(0, 16).replace('T', ' '),
                unix_time: Math.floor(c.time / 1000),
                open: c.open, high: c.high, low: c.low, close: c.close,
                volume: c.volume, ema9: 0, ema21: 0, vwap: 0, rsi: 0, atr: 0,
              }))
              if (bars.length > 0) {
                onBarsLoaded?.(bars)
                applyBars(bars)
              }
            } else if (msg.type === 'candle' && msg.token === '26000') {
              patchCandle(msg.bar, msg.final)
            } else if (msg.type === 'quote' && msg.token === '26000') {
              // Live quote — update current 5-min candle's close in real-time
              const nowSec = Math.floor(Date.now() / 1000)
              const barTime = Math.floor(nowSec / 300) * 300  // truncate to 5-min
              patchCandle({
                time: barTime * 1000,
                open: msg.open || msg.ltp,
                high: msg.high || msg.ltp,
                low: msg.low || msg.ltp,
                close: msg.ltp,
                volume: 0,
              }, false)
              setLivePrice(msg.ltp)
            }
          } catch { /* ignore */ }
        }

        ws.onclose = () => {
          setSource('delayed')
          wsRef.current = null
        }

        ws.onerror = () => {
          setSource('delayed')
        }
      })
      .catch(() => setSource('delayed'))
  }, [applyBars, onBarsLoaded, patchCandle])

  // ── Mount chart ──────────────────────────────────────────────────────────
  useEffect(() => {
    if (!containerRef.current) return
    const chart = createChart(containerRef.current, {
      width: containerRef.current.clientWidth,
      height,
      layout: { background: { type: ColorType.Solid, color: C.bg }, textColor: C.text, fontSize: 11 },
      grid: { vertLines: { color: C.grid, style: LineStyle.Dotted }, horzLines: { color: C.grid, style: LineStyle.Dotted } },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: C.grid },
      timeScale: { borderColor: C.grid, timeVisible: true, secondsVisible: false, rightOffset: 5 },
    })
    chartRef.current = chart

    candleRef.current = chart.addCandlestickSeries({
      upColor: C.up, downColor: C.dn, wickUpColor: C.up, wickDownColor: C.dn,
      borderUpColor: C.up, borderDownColor: C.dn,
    })
    ema9Ref.current  = chart.addLineSeries({ color: C.ema9,  lineWidth: 1, priceLineVisible: false, lastValueVisible: true, title: 'EMA9' })
    ema21Ref.current = chart.addLineSeries({ color: C.ema21, lineWidth: 1, priceLineVisible: false, lastValueVisible: true, title: 'EMA21' })
    vwapRef.current  = chart.addLineSeries({ color: C.vwap,  lineWidth: 2, priceLineVisible: false, lastValueVisible: true, title: 'VWAP' })

    const ro = new ResizeObserver(entries => { const w = entries[0]?.contentRect.width; if (w) chart.applyOptions({ width: w }) })
    ro.observe(containerRef.current)

    // Load initial data
    if (propBars?.length) applyBars(propBars)
    else fetchAndApply()

    // Try live WebSocket
    connectAngelOne()

    return () => {
      ro.disconnect()
      wsRef.current?.close()
      chart.remove()
      chartRef.current = null; candleRef.current = null
      ema9Ref.current = null; ema21Ref.current = null; vwapRef.current = null
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [height])

  // ── Polling fallback when on delayed mode ────────────────────────────────
  useEffect(() => {
    if (propBars || source === 'live') return
    const id = setInterval(fetchAndApply, refreshMs)
    return () => clearInterval(id)
  }, [propBars, source, fetchAndApply, refreshMs])

  useEffect(() => {
    if (barsRef.current.length > 0) applyBars(barsRef.current)
  }, [signals, applyBars])

  const sourceLabel = source === 'live' ? '🟢 Live · Angel One' : source === 'connecting' ? '🟡 Connecting…' : '🟠 Delayed · Yahoo'

  return (
    <div className="relative w-full rounded-xl overflow-hidden border border-slate-800 bg-slate-950">
      {/* Legend */}
      <div className="absolute top-2 left-2 z-10 flex items-center gap-3 text-[10px] font-mono bg-slate-950/80 px-2 py-1 rounded-md pointer-events-none">
        <span style={{ color: C.ema9  }}>── EMA9</span>
        <span style={{ color: C.ema21 }}>── EMA21</span>
        <span style={{ color: C.vwap  }}>── VWAP</span>
        <span className="text-emerald-400">▲ CE</span>
        <span className="text-red-400">▼ PE</span>
      </div>
      {/* Live price + source badge */}
      <div className="absolute top-2 right-2 z-10 flex items-center gap-2 pointer-events-none">
        {livePrice !== null && (
          <div className="bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 font-mono font-bold text-sm px-2.5 py-1 rounded-lg">
            ₹{livePrice.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </div>
        )}
        <div className="text-[10px] bg-slate-950/80 px-2 py-1 rounded-md text-slate-400">
          {sourceLabel}
        </div>
      </div>
      <div ref={containerRef} style={{ height }} />
    </div>
  )
}
