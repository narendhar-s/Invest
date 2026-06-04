import { useEffect, useMemo, useRef, useState } from 'react'
import {
  createChart,
  ColorType,
  CrosshairMode,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
  type SeriesMarker,
  type Time,
} from 'lightweight-charts'
import {
  getCandleSnapshot,
  getLiveHistory,
  getPatterns,
  openCandleSocket,
  type CandleStream,
  type LiveCandle,
  type PatternHit,
  type PatternMeta,
  type ReplayCall,
  type BacktestRange,
} from '../api/client'
import ChartDrawLayer from './chart/ChartDrawLayer'
import ChartOverlay, { type OverlayShape } from './chart/ChartOverlay'
import type { Bar } from '../lib/bar'
import { computeIndicator, parseIndicator, INDICATOR_CATALOG, type IndicatorSpec, type Plot } from '../lib/indicators'
import { computeSMC, type SmcFeature } from '../lib/smc'
import { runScript } from '../lib/script'

type Props = {
  symbol: string
  running?: boolean
  // history mode: load last-session candles + replay a strategy (read-only,
  // no live SSE stream). Used after market close / when the engine is stopped.
  history?: boolean
  timeframe?: string
  strategy?: string
  // Date window for history mode; pulled from Kite when set so the chart draws
  // the exact selected span. Empty = seed source's most-recent candles.
  range?: BacktestRange
}

const toTime = (iso: string): UTCTimestamp =>
  Math.floor(new Date(iso).getTime() / 1000) as UTCTimestamp

const toBar = (c: LiveCandle): Bar => ({
  time: toTime(c.start),
  open: c.open,
  high: c.high,
  low: c.low,
  close: c.close,
  volume: c.volume ?? 0,
})

const markerColor = (dir: string) =>
  dir === 'bullish' ? '#34d399' : dir === 'bearish' ? '#f87171' : '#94a3b8'

const SMC_FEATURES: { key: SmcFeature; label: string }[] = [
  { key: 'swings', label: 'Swing points (HH/HL/LH/LL)' },
  { key: 'structure', label: 'Structure (BOS / CHoCH)' },
  { key: 'liquidity', label: 'Liquidity + EQH/EQL' },
  { key: 'orderblocks', label: 'Order blocks + FVG' },
]

const SCRIPT_PLACEHOLDER = `// formula or JS. examples:
//   sma(close,20)-sma(close,50)
//   plot(ema(close,9),{color:'#f97316'})
//   hline(close[close.length-1],{dashed:true})
plot(sma(close,20),{color:'#38bdf8'})`

type PlotSeries = ISeriesApi<'Line'> | ISeriesApi<'Histogram'>

// LiveChart renders a TradingView-style candlestick chart for one symbol with
// pattern markers, drawing tools, a multi-indicator library, SMC overlays and a
// custom draw-script box.
export default function LiveChart({ symbol, running, history, timeframe, strategy, range }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null)
  const barsRef = useRef<Map<number, Bar>>(new Map())

  const [patternCatalog, setPatternCatalog] = useState<PatternMeta[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [patterns, setPatterns] = useState<PatternHit[]>([])
  const [replayCalls, setReplayCalls] = useState<ReplayCall[]>([])
  const [historyError, setHistoryError] = useState<string | null>(null)
  const [chartReady, setChartReady] = useState(false)

  // Indicators, SMC overlays and custom draw script.
  const [indicators, setIndicators] = useState<IndicatorSpec[]>([])
  const [indicatorInput, setIndicatorInput] = useState('')
  const [indicatorError, setIndicatorError] = useState<string | null>(null)
  const [smcFeatures, setSmcFeatures] = useState<Set<SmcFeature>>(new Set())
  const [scriptCode, setScriptCode] = useState('')
  const [scriptError, setScriptError] = useState<string | null>(null)

  // Line/histogram series keyed by plot key, plus a render-time recompute hook
  // and the overlay-shape buffer the non-interactive canvas reads each frame.
  const plotSeriesRef = useRef<Map<string, PlotSeries>>(new Map())
  const plotMetaRef = useRef<Map<string, { style: Plot['style']; scaleId: string }>>(new Map())
  const recomputeRef = useRef<() => void>(() => {})
  const overlayShapesRef = useRef<OverlayShape[]>([])

  // Load the pattern catalog once.
  useEffect(() => {
    getPatterns().then(setPatternCatalog).catch(() => {})
  }, [])

  // Build the chart once.
  useEffect(() => {
    if (!containerRef.current) return
    const chart = createChart(containerRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        textColor: '#94a3b8',
      },
      grid: {
        vertLines: { color: 'rgba(148,163,184,0.08)' },
        horzLines: { color: 'rgba(148,163,184,0.08)' },
      },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: 'rgba(148,163,184,0.2)' },
      timeScale: { borderColor: 'rgba(148,163,184,0.2)', timeVisible: true, secondsVisible: false },
      autoSize: true,
    })
    const series = chart.addCandlestickSeries({
      upColor: '#34d399',
      downColor: '#f87171',
      borderUpColor: '#34d399',
      borderDownColor: '#f87171',
      wickUpColor: '#34d399',
      wickDownColor: '#f87171',
    })
    chartRef.current = chart
    seriesRef.current = series
    setChartReady(true)
    return () => {
      chart.remove()
      chartRef.current = null
      seriesRef.current = null
      plotSeriesRef.current.clear()
      plotMetaRef.current.clear()
      setChartReady(false)
    }
  }, [])

  const pushBar = (c: LiveCandle) => {
    const bar = toBar(c)
    barsRef.current.set(bar.time as number, bar)
    seriesRef.current?.update(bar)
    recomputeRef.current()
  }

  const sortedBars = (): Bar[] =>
    Array.from(barsRef.current.values()).sort((a, b) => (a.time as number) - (b.time as number))

  // Load data whenever the symbol/mode changes.
  useEffect(() => {
    if (!symbol) return
    let stream: CandleStream | null = null
    let cancelled = false
    barsRef.current = new Map()
    setReplayCalls([])
    setHistoryError(null)

    if (history) {
      getLiveHistory(symbol, timeframe, strategy, range)
        .then((snap) => {
          if (cancelled) return
          if (snap.available === false) {
            setHistoryError(snap.error || 'No historical data')
            return
          }
          const bars = (snap.candles ?? []).map(toBar)
          bars.forEach((b) => barsRef.current.set(b.time as number, b))
          seriesRef.current?.setData(sortedBars())
          setPatterns(snap.patterns ?? [])
          setReplayCalls(snap.calls ?? [])
          recomputeRef.current()
          chartRef.current?.timeScale().fitContent()
        })
        .catch(() => { if (!cancelled) setHistoryError('Failed to load history') })
      return () => { cancelled = true }
    }

    getCandleSnapshot(symbol)
      .then((snap) => {
        if (cancelled) return
        const bars = snap.candles.map(toBar)
        bars.forEach((b) => barsRef.current.set(b.time as number, b))
        seriesRef.current?.setData(sortedBars())
        if (snap.current) pushBar(snap.current)
        setPatterns(snap.patterns ?? [])
        recomputeRef.current()
        chartRef.current?.timeScale().fitContent()
      })
      .catch(() => {})

    stream = openCandleSocket(symbol, (c) => {
      if (cancelled) return
      pushBar(c)
    })

    return () => {
      cancelled = true
      stream?.close()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol, running, history, timeframe, strategy, range?.from, range?.to, range?.days])

  // Master recompute pipeline. Rebuilt whenever the indicator/SMC/script inputs
  // change; also invoked on every live bar via recomputeRef. It (1) computes all
  // indicator + script plots and reconciles their line/histogram series,
  // (2) stacks lower-pane scales, and (3) refreshes the SMC + script overlay
  // shapes that the non-interactive canvas paints.
  useEffect(() => {
    const chart = chartRef.current
    if (!chart || !chartReady) return

    const recompute = () => {
      const bars = sortedBars()
      const series = plotSeriesRef.current
      const meta = plotMetaRef.current

      const indPlots = indicators.flatMap((s, i) => computeIndicator(bars, s, i))
      const scriptRes = runScript(scriptCode, bars, 'scr')
      const plots: Plot[] = [...indPlots, ...scriptRes.plots]

      // Stable order of lower-pane groups → stacked bands at the bottom.
      const lowerGroups: string[] = []
      for (const p of plots) {
        if (p.pane === 'lower' && !lowerGroups.includes(p.group)) lowerGroups.push(p.group)
      }
      const scaleFor = (p: Plot) => (p.pane === 'price' ? 'right' : `lp_${p.group}`)

      // Remove series whose plot disappeared.
      const wanted = new Set(plots.map((p) => p.key))
      for (const [key, s] of series) {
        if (!wanted.has(key)) {
          chart.removeSeries(s)
          series.delete(key)
          meta.delete(key)
        }
      }

      // Add / update series.
      for (const p of plots) {
        const scaleId = scaleFor(p)
        const existing = meta.get(p.key)
        if (existing && (existing.style !== p.style || existing.scaleId !== scaleId)) {
          const old = series.get(p.key)
          if (old) chart.removeSeries(old)
          series.delete(p.key)
          meta.delete(p.key)
        }
        let s = series.get(p.key)
        if (!s) {
          s =
            p.style === 'histogram'
              ? chart.addHistogramSeries({ color: p.color, priceScaleId: scaleId, priceLineVisible: false, lastValueVisible: false })
              : chart.addLineSeries({
                  color: p.color,
                  lineWidth: p.lineWidth ?? 1,
                  priceScaleId: scaleId,
                  priceLineVisible: false,
                  lastValueVisible: p.pane === 'price',
                })
          series.set(p.key, s)
          meta.set(p.key, { style: p.style, scaleId })
        }
        s.setData(p.data)
      }

      // Stack the lower-pane scales and shrink the price scale to make room.
      const nLower = lowerGroups.length
      if (nLower === 0) {
        chart.priceScale('right').applyOptions({ scaleMargins: { top: 0.1, bottom: 0.1 } })
      } else {
        const bottomTotal = Math.min(0.55, nLower * 0.18)
        const band = bottomTotal / nLower
        chart.priceScale('right').applyOptions({ scaleMargins: { top: 0.06, bottom: bottomTotal + 0.03 } })
        lowerGroups.forEach((g, i) => {
          // i=0 is the band just under price; last is the very bottom.
          const top = 1 - bottomTotal + i * band
          const bottom = (nLower - 1 - i) * band
          chart.priceScale(`lp_${g}`).applyOptions({ scaleMargins: { top, bottom } })
        })
      }

      // Build overlay shapes: SMC geometry + script drawings.
      const shapes: OverlayShape[] = []
      if (smcFeatures.size) {
        const smc = computeSMC(bars, smcFeatures)
        for (const b of smc.boxes) shapes.push({ kind: 'box', t1: b.t1, t2: b.t2, p1: b.p1, p2: b.p2, color: b.color, text: b.label })
        for (const l of smc.lines) shapes.push({ kind: 'line', t1: l.t1, t2: l.t2, p1: l.price, p2: l.price, color: l.color, text: l.label, dashed: l.dashed })
        for (const m of smc.markers) shapes.push({ kind: 'marker', time: m.time, price: m.price, text: m.text, color: m.color, above: m.above })
      }
      shapes.push(...(scriptRes.shapes as OverlayShape[]))
      overlayShapesRef.current = shapes
    }

    recomputeRef.current = recompute
    recompute()
  }, [indicators, smcFeatures, scriptCode, chartReady])

  // Validate the script (for UI feedback) when it changes.
  useEffect(() => {
    if (!scriptCode.trim()) {
      setScriptError(null)
      return
    }
    const res = runScript(scriptCode, sortedBars(), 'scr')
    setScriptError(res.error ?? null)
  }, [scriptCode])

  const addIndicator = () => {
    const spec = parseIndicator(indicatorInput, indicators.length + Date.now() % 1000)
    if (!spec) {
      setIndicatorError('Unknown. Try SMA(20), MACD(12,26,9), BB(20,2)…')
      return
    }
    setIndicatorError(null)
    setIndicatorInput('')
    setIndicators((prev) => [...prev, spec])
  }

  const removeIndicator = (id: string) =>
    setIndicators((prev) => prev.filter((i) => i.id !== id))

  const toggleSmc = (key: SmcFeature) =>
    setSmcFeatures((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  // Recompute markers whenever the detected patterns or selection change.
  const markers = useMemo<SeriesMarker<Time>[]>(() => {
    const patternMarkers = patterns
      .filter((p) => selected.has(p.key))
      .map((p) => ({
        time: p.time as UTCTimestamp,
        position: (p.direction === 'bearish' ? 'aboveBar' : 'belowBar') as 'aboveBar' | 'belowBar',
        color: markerColor(p.direction),
        shape: (p.direction === 'bearish' ? 'arrowDown' : 'arrowUp') as 'arrowDown' | 'arrowUp',
        text: p.name,
      }))

    const callMarkers = replayCalls.map((c) => {
      const buy = c.direction.toUpperCase() === 'BUY'
      return {
        time: c.time as UTCTimestamp,
        position: (buy ? 'belowBar' : 'aboveBar') as 'aboveBar' | 'belowBar',
        color: buy ? '#34d399' : '#f87171',
        shape: (buy ? 'arrowUp' : 'arrowDown') as 'arrowDown' | 'arrowUp',
        text: c.direction.toUpperCase(),
      }
    })

    return [...patternMarkers, ...callMarkers].sort((a, b) => (a.time as number) - (b.time as number))
  }, [patterns, selected, replayCalls])

  useEffect(() => {
    seriesRef.current?.setMarkers(markers)
  }, [markers])

  const toggle = (key: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const hitCount = useMemo(() => {
    const m = new Map<string, number>()
    patterns.forEach((p) => m.set(p.key, (m.get(p.key) ?? 0) + 1))
    return m
  }, [patterns])

  return (
    <div className="grid grid-cols-1 lg:grid-cols-4 gap-4">
      <div className="lg:col-span-3 bg-dark-800 border border-slate-800 rounded-xl p-3">
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-medium text-slate-200">
            {symbol || 'Select a symbol'}
            {history && <span className="ml-2 text-xs text-amber-400/80">last session (read-only)</span>}
          </h3>
          <span className="text-xs text-slate-500">{markers.length} markers</span>
        </div>
        {historyError && (
          <div className="mb-2 text-xs text-slate-500">{historyError}</div>
        )}
        <div className="relative w-full h-[460px]">
          <div ref={containerRef} className="absolute inset-0" />
          {chartReady && chartRef.current && seriesRef.current && (
            <>
              <ChartOverlay chart={chartRef.current} series={seriesRef.current} shapesRef={overlayShapesRef} />
              <ChartDrawLayer chart={chartRef.current} series={seriesRef.current} symbol={symbol} />
            </>
          )}
        </div>
      </div>

      <div className="space-y-4">
        {/* Indicators */}
        <div className="bg-dark-800 border border-slate-800 rounded-xl p-3">
          <h3 className="text-sm font-medium text-slate-200 mb-2">Indicators</h3>
          <div className="flex gap-1.5">
            <input
              value={indicatorInput}
              onChange={(e) => setIndicatorInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') addIndicator() }}
              placeholder="SMA(20)"
              className="flex-1 min-w-0 bg-dark-900 border border-slate-700 rounded-lg px-2 py-1 text-sm text-slate-200 placeholder-slate-600 focus:outline-none focus:border-brand-500"
            />
            <button
              onClick={addIndicator}
              className="px-2.5 py-1 rounded-lg bg-brand-500/20 text-brand-300 text-sm hover:bg-brand-500/30"
            >
              Add
            </button>
          </div>
          {indicatorError && <p className="text-xs text-red-400/80 mt-1">{indicatorError}</p>}
          <div className="mt-2 flex flex-wrap gap-1">
            {INDICATOR_CATALOG.map((c) => (
              <button
                key={c.kind}
                title={c.desc}
                onClick={() => setIndicatorInput(c.syntax)}
                className="text-[11px] px-1.5 py-0.5 rounded bg-slate-800/70 text-slate-400 hover:text-slate-200"
              >
                {c.syntax}
              </button>
            ))}
          </div>
          <div className="mt-2 space-y-1">
            {indicators.map((i) => (
              <div key={i.id} className="flex items-center justify-between gap-2 px-2 py-1 rounded-lg bg-slate-800/50 text-sm">
                <span className="text-slate-300">{i.label}</span>
                <button onClick={() => removeIndicator(i.id)} className="text-xs text-slate-500 hover:text-red-400">remove</button>
              </div>
            ))}
            {indicators.length === 0 && <p className="text-xs text-slate-600">No indicators added.</p>}
          </div>
        </div>

        {/* Smart Money Concepts */}
        <div className="bg-dark-800 border border-slate-800 rounded-xl p-3">
          <h3 className="text-sm font-medium text-slate-200 mb-2">Smart Money Concepts</h3>
          <div className="space-y-1">
            {SMC_FEATURES.map((f) => (
              <label key={f.key} className="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-slate-800/60 cursor-pointer text-sm">
                <input type="checkbox" checked={smcFeatures.has(f.key)} onChange={() => toggleSmc(f.key)} className="accent-brand-500" />
                <span className="text-slate-300">{f.label}</span>
              </label>
            ))}
          </div>
        </div>

        {/* Custom draw script */}
        <div className="bg-dark-800 border border-slate-800 rounded-xl p-3">
          <h3 className="text-sm font-medium text-slate-200 mb-1">Draw script</h3>
          <p className="text-xs text-slate-500 mb-2">
            Formula or JS. Vars: <code className="text-slate-400">open/high/low/close/volume/time</code>; fns:{' '}
            <code className="text-slate-400">sma,ema,rsi,atr,highest,lowest</code>; draw:{' '}
            <code className="text-slate-400">plot,line,hline,box,marker,label</code>.
          </p>
          <textarea
            value={scriptCode}
            onChange={(e) => setScriptCode(e.target.value)}
            placeholder={SCRIPT_PLACEHOLDER}
            spellCheck={false}
            rows={6}
            className="w-full bg-dark-900 border border-slate-700 rounded-lg px-2 py-1.5 text-xs font-mono text-slate-200 placeholder-slate-600 focus:outline-none focus:border-brand-500"
          />
          {scriptError ? (
            <p className="text-xs text-red-400/80 mt-1">⚠ {scriptError}</p>
          ) : (
            scriptCode.trim() && <p className="text-xs text-emerald-400/70 mt-1">running</p>
          )}
          {scriptCode && (
            <button onClick={() => setScriptCode('')} className="text-xs text-slate-500 hover:text-red-400 mt-1">clear script</button>
          )}
        </div>

        {/* Pattern picker */}
        <div className="bg-dark-800 border border-slate-800 rounded-xl p-3">
          <h3 className="text-sm font-medium text-slate-200 mb-2">Patterns</h3>
          <p className="text-xs text-slate-500 mb-3">Toggle which patterns draw on the chart.</p>
          <div className="space-y-1 max-h-[320px] overflow-y-auto pr-1">
            {patternCatalog.map((p) => {
              const count = hitCount.get(p.key) ?? 0
              return (
                <label key={p.key} className="flex items-center justify-between gap-2 px-2 py-1.5 rounded-lg hover:bg-slate-800/60 cursor-pointer text-sm">
                  <span className="flex items-center gap-2">
                    <input type="checkbox" checked={selected.has(p.key)} onChange={() => toggle(p.key)} className="accent-brand-500" />
                    <span style={{ color: markerColor(p.direction) }}>{p.name}</span>
                  </span>
                  {count > 0 && <span className="text-xs text-slate-500 bg-slate-800 rounded-full px-2">{count}</span>}
                </label>
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}
