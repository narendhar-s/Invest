import { useEffect, useRef, useState, useCallback } from 'react'
import { createChart, ColorType, CrosshairMode, LineStyle } from 'lightweight-charts'
import type { IChartApi, ISeriesApi, SeriesMarker, Time, IPriceLine } from 'lightweight-charts'
import axios from 'axios'

// ─── Types ────────────────────────────────────────────────────────────────────

interface Bar { time: number; date: string; open: number; high: number; low: number; close: number; volume: number }
interface OBZone { start_time: number; high: number; low: number; mid: number; type: string; mitigated: boolean }
interface FVGZone { start_time: number; end_time: number; low: number; high: number; type: string; filled: boolean }
interface LiqLevel { price: number; type: string; swept: boolean; count: number }
interface LevelMarker { time: number; type: string; price: number; label: string }
interface ICTSMCSig {
  signal: string; combined_bias: string; confluence: number; confidence: number
  entry: number; stop_loss: number; target1: number; target2: number; risk_reward: number
}
interface EventsData {
  bars: Bar[]
  ob_zones: OBZone[] | null
  fvg_zones: FVGZone[] | null
  sweeps: LevelMarker[] | null
  liq_levels: LiqLevel[] | null
  ote_low: number; ote_high: number
  swing_high: number; swing_low: number; equilibrium: number
  signal: ICTSMCSig
  generated_at: string
}

const f0 = (n: number) => Math.round(n || 0).toLocaleString('en-IN')

const COLORS = {
  bullOB: '#10b981', bearOB: '#ef4444',
  bullFVG: '#06b6d4', bearFVG: '#f59e0b',
  OTE: '#a78bfa', equilib: '#475569',
  BSL: '#34d399', SSL: '#f87171',
  entry: '#06b6d4', sl: '#ef4444', t1: '#86efac', t2: '#10b981',
}

type TF = '5m' | '15m' | 'daily'

// ─── Main Chart ───────────────────────────────────────────────────────────────

export default function ICTSMCChart() {
  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<HTMLDivElement>(null)
  const chart = useRef<IChartApi | null>(null)
  const candles = useRef<ISeriesApi<'Candlestick'> | null>(null)
  const priceLines = useRef<IPriceLine[]>([])
  const [chartReady, setChartReady] = useState(false)

  const [data, setData] = useState<EventsData | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [tf, setTf] = useState<TF>('daily')
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null)
  const [showExample, setShowExample] = useState(false)

  const [overlays, setOverlays] = useState({ ob: true, fvg: true, ote: true, liq: true, signal: true })
  const toggleOverlay = (k: keyof typeof overlays) => setOverlays(p => ({ ...p, [k]: !p[k] }))

  // ── Fetch live data ──────────────────────────────────────────────────────────
  const fetch = useCallback(async (timeframe: TF) => {
    setLoading(true)
    setError('')
    try {
      const { data: d } = await axios.get<EventsData>(
        `/api/naren/v1/nifty/ict-smc-events?bars=120&timeframe=${timeframe}`
      )
      setData(d)
      setLastUpdate(new Date())
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load chart data')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!showExample) fetch(tf)
  }, [tf, showExample, fetch])

  // Auto-refresh every 30s in live mode
  useEffect(() => {
    if (showExample) return
    const id = setInterval(() => fetch(tf), 30_000)
    return () => clearInterval(id)
  }, [tf, showExample, fetch])

  // ── Init chart ───────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!chartRef.current) return
    const el = chartRef.current

    chart.current = createChart(el, {
      layout: {
        background: { type: ColorType.Solid, color: '#0a0f1e' },
        textColor: '#94a3b8',
      },
      grid: {
        vertLines: { color: '#1e293b' },
        horzLines: { color: '#1e293b' },
      },
      crosshair: { mode: CrosshairMode.Normal },
      width: el.clientWidth || 900,
      height: 480,
      timeScale: { timeVisible: true, secondsVisible: false, borderColor: '#334155' },
      rightPriceScale: { borderColor: '#334155' },
    })

    candles.current = chart.current.addCandlestickSeries({
      upColor: '#10b981', downColor: '#ef4444',
      borderUpColor: '#10b981', borderDownColor: '#ef4444',
      wickUpColor: '#10b981', wickDownColor: '#ef4444',
    })

    const onResize = () => {
      if (chart.current && el) chart.current.applyOptions({ width: el.clientWidth })
    }
    window.addEventListener('resize', onResize)

    // Short delay so the container has painted
    const tid = setTimeout(() => { onResize(); setChartReady(true) }, 60)

    return () => {
      clearTimeout(tid)
      window.removeEventListener('resize', onResize)
      chart.current?.remove()
      chart.current = null
      candles.current = null
    }
  }, [])

  // ── Draw overlays whenever data / settings change ────────────────────────────
  useEffect(() => {
    if (!chartReady || !candles.current || !chart.current) return

    const bars = showExample ? EXAMPLE_BARS : data?.bars
    if (!bars || bars.length === 0) return

    // ── Candles
    candles.current.setData(
      bars.map(b => ({ time: b.time as Time, open: b.open, high: b.high, low: b.low, close: b.close }))
    )

    // ── Clear old price lines
    for (const pl of priceLines.current) {
      try { candles.current.removePriceLine(pl) } catch { /* ignore */ }
    }
    priceLines.current = []

    const addLine = (
      price: number,
      color: string,
      title: string,
      style: LineStyle = LineStyle.Dashed,
      width: 1 | 2 | 3 | 4 = 1,
    ) => {
      if (!price || !candles.current) return
      const pl = candles.current.createPriceLine({
        price, color, lineWidth: width, lineStyle: style, axisLabelVisible: true, title,
      })
      priceLines.current.push(pl)
    }

    const sig  = showExample ? EXAMPLE_SIGNAL : data?.signal
    const obZones  = showExample ? EXAMPLE_OB_ZONES  : (data?.ob_zones  ?? [])
    const fvgZones = showExample ? EXAMPLE_FVG_ZONES : (data?.fvg_zones ?? [])
    const liqLvls  = showExample ? EXAMPLE_LIQ       : (data?.liq_levels ?? [])
    const sweepSrc = showExample ? EXAMPLE_SWEEPS    : (data?.sweeps ?? [])
    const oteHigh  = showExample ? EXAMPLE_OTE.high  : (data?.ote_high ?? 0)
    const oteLow   = showExample ? EXAMPLE_OTE.low   : (data?.ote_low  ?? 0)
    const equil    = showExample ? EXAMPLE_OTE.equil : (data?.equilibrium ?? 0)

    // ── Order Blocks
    if (overlays.ob) {
      for (const z of obZones) {
        if (z.mitigated) continue
        const c = z.type === 'BULL' ? COLORS.bullOB : COLORS.bearOB
        addLine(z.high, c, z.type === 'BULL' ? '🟢 OB Hi' : '🔴 OB Hi', LineStyle.Solid, 2)
        addLine(z.low,  c, z.type === 'BULL' ? '🟢 OB Lo' : '🔴 OB Lo', LineStyle.Dashed, 1)
        addLine(z.mid,  c + '80', '  OB Mid', LineStyle.Dotted, 1)
      }
    }

    // ── FVG Zones
    if (overlays.fvg) {
      for (const z of (fvgZones).filter(z => !z.filled).slice(-5)) {
        const c = z.type === 'BULL' ? COLORS.bullFVG : COLORS.bearFVG
        addLine(z.high, c, `◈ ${z.type} FVG`, LineStyle.Dashed, 1)
        addLine(z.low,  c, `◈ ${z.type} FVG`, LineStyle.Dotted, 1)
      }
    }

    // ── OTE Band
    if (overlays.ote && oteHigh > 0) {
      addLine(oteHigh, COLORS.OTE, '79% Fib', LineStyle.Dashed, 1)
      addLine(oteLow,  COLORS.OTE, '61.8% Fib', LineStyle.Dashed, 1)
      addLine(equil, COLORS.equilib, '50% Equil', LineStyle.Dotted, 1)
    }

    // ── Liquidity Levels
    if (overlays.liq) {
      for (const l of liqLvls) {
        const c     = l.type === 'BSL' ? COLORS.BSL : COLORS.SSL
        const style = l.swept ? LineStyle.Solid : LineStyle.Dotted
        addLine(l.price, c, `${l.type}×${l.count}${l.swept ? '✓' : ''}`, style, l.swept ? 2 : 1)
      }
    }

    // ── Signal Levels
    if (overlays.signal && sig && sig.signal !== 'WAIT') {
      const last = bars[bars.length - 1]
      const entry = sig.entry || last?.close || 0
      if (entry)         addLine(entry,         COLORS.entry, '⚡ ENTRY',  LineStyle.Solid,  3)
      if (sig.stop_loss) addLine(sig.stop_loss, COLORS.sl,   '✕ SL',      LineStyle.Dashed, 2)
      if (sig.target1)   addLine(sig.target1,   COLORS.t1,   'T1 +1.5R',  LineStyle.Dashed, 1)
      if (sig.target2)   addLine(sig.target2,   COLORS.t2,   'T2 +3R',    LineStyle.Dashed, 2)
    }

    // ── Markers
    const markers: SeriesMarker<Time>[] = []
    for (const s of sweepSrc.slice(-15)) {
      const bullish = s.type === 'SWEEP_LOW' || s.type === 'CHOCH_BULL' || s.type === 'MSS_BULL'
      markers.push({
        time: s.time as Time,
        position: bullish ? 'belowBar' : 'aboveBar',
        color:    bullish ? '#10b981' : '#ef4444',
        shape:    bullish ? 'arrowUp' : 'arrowDown',
        text:     s.label,
        size:     s.type.startsWith('MSS') ? 2 : 1,
      })
    }
    if (!showExample && sig && sig.signal !== 'WAIT') {
      const last = bars[bars.length - 1]
      if (last) {
        const buy = sig.signal === 'CE_BUY'
        markers.push({
          time: last.time as Time,
          position: buy ? 'belowBar' : 'aboveBar',
          color:    buy ? '#10b981' : '#ef4444',
          shape:    buy ? 'arrowUp' : 'arrowDown',
          text:     `${buy ? '⚡CE' : '⚡PE'} ${sig.confluence}/10`,
          size: 2,
        })
      }
    }
    candles.current.setMarkers(markers)
    chart.current.timeScale().fitContent()

  }, [chartReady, data, overlays, showExample])

  // ─── Render ──────────────────────────────────────────────────────────────────
  const sig  = showExample ? EXAMPLE_SIGNAL : data?.signal
  const last = showExample
    ? EXAMPLE_BARS[EXAMPLE_BARS.length - 1]
    : (data?.bars ?? [])[data?.bars.length ?? 0 - 1]

  const sigBorder = sig?.signal === 'CE_BUY'
    ? 'border-emerald-600/40 bg-emerald-900/10'
    : sig?.signal === 'PE_BUY'
    ? 'border-red-600/40 bg-red-900/10'
    : 'border-slate-700 bg-dark-800/40'

  const sigColor = sig?.signal === 'CE_BUY' ? 'text-emerald-400'
    : sig?.signal === 'PE_BUY' ? 'text-red-400' : 'text-amber-400'

  return (
    <div ref={containerRef} className="bg-dark-900 rounded-xl border border-slate-800 p-4 space-y-3">

      {/* ── Top Controls ── */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-bold text-white">
          {showExample ? '📚 Example Chart' : '📡 Live ICT+SMC Chart'}
        </span>

        {/* Timeframe (live only) */}
        {!showExample && (
          <div className="flex bg-dark-800 rounded-lg p-0.5 gap-0.5">
            {(['daily', '15m', '5m'] as TF[]).map(t => (
              <button key={t} onClick={() => setTf(t)}
                className={`px-3 py-1 text-xs font-bold rounded-md transition-all ${
                  tf === t ? 'bg-brand-600 text-white' : 'text-slate-400 hover:text-white'}`}>
                {t === 'daily' ? 'Daily' : t}
              </button>
            ))}
          </div>
        )}

        {/* Overlay toggles */}
        <div className="flex flex-wrap gap-1">
          {([
            { k: 'ob',     label: 'OB',      on: 'bg-emerald-700' },
            { k: 'fvg',    label: 'FVG',     on: 'bg-cyan-700' },
            { k: 'ote',    label: 'OTE',     on: 'bg-purple-700' },
            { k: 'liq',    label: 'Liq',     on: 'bg-slate-600' },
            { k: 'signal', label: 'Levels',  on: 'bg-blue-700' },
          ] as const).map(o => (
            <button key={o.k} onClick={() => toggleOverlay(o.k)}
              className={`px-2 py-0.5 rounded text-xs font-medium transition-all ${
                overlays[o.k] ? `${o.on} text-white` : 'bg-dark-800 text-slate-500'}`}>
              {o.label}
            </button>
          ))}
        </div>

        {/* Example / Live toggle */}
        <button onClick={() => setShowExample(p => !p)}
          className={`px-3 py-1 rounded-lg text-xs font-bold ml-1 transition-all ${
            showExample ? 'bg-amber-600 text-white' : 'bg-dark-800 text-slate-400 hover:text-white'}`}>
          {showExample ? '📚 Example' : '📚 Show Example'}
        </button>

        <div className="ml-auto flex items-center gap-2">
          {lastUpdate && !showExample && (
            <span className="text-xs text-slate-600">{lastUpdate.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}</span>
          )}
          {!showExample && (
            <button onClick={() => fetch(tf)} disabled={loading}
              className={`px-3 py-1.5 text-xs font-bold rounded-lg ${
                loading ? 'bg-slate-700 text-slate-400 cursor-wait' : 'bg-fuchsia-600 hover:bg-fuchsia-500 text-white'}`}>
              {loading ? '⟳ Loading…' : '↺ Refresh'}
            </button>
          )}
        </div>
      </div>

      {/* ── Legend ── */}
      <div className="flex flex-wrap gap-3 text-xs text-slate-500">
        <span><span className="text-emerald-500 font-bold">——</span> Bull OB</span>
        <span><span className="text-red-500 font-bold">——</span> Bear OB</span>
        <span><span className="text-cyan-500 font-bold">- -</span> Bull FVG</span>
        <span><span className="text-amber-500 font-bold">- -</span> Bear FVG</span>
        <span><span className="text-purple-400 font-bold">- -</span> OTE 61.8–79%</span>
        <span><span className="text-emerald-400">···</span> BSL</span>
        <span><span className="text-red-400">···</span> SSL</span>
        <span><span className="text-cyan-400 font-bold">——</span> Entry</span>
      </div>

      {/* ── Signal Banner ── */}
      {sig && (
        <div className={`rounded-xl border p-3 ${sigBorder}`}>
          <div className="flex flex-wrap items-center gap-4 text-sm">
            <div>
              <div className="text-xs text-slate-500">Signal</div>
              <div className={`text-xl font-black ${sigColor}`}>
                {sig.signal === 'WAIT' ? '⏳ WAIT' : sig.signal === 'CE_BUY' ? '🟢 CE BUY' : '🔴 PE BUY'}
              </div>
            </div>
            <div><div className="text-xs text-slate-500">Confluence</div><div className="font-bold text-amber-400">{sig.confluence}/10</div></div>
            <div><div className="text-xs text-slate-500">Confidence</div><div className="font-bold text-white">{sig.confidence}%</div></div>
            {sig.entry > 0 && <>
              <div><div className="text-xs text-slate-500">Entry</div><div className="font-mono font-bold text-cyan-400">{f0(sig.entry)}</div></div>
              <div><div className="text-xs text-slate-500">SL</div><div className="font-mono font-bold text-red-400">{f0(sig.stop_loss)}</div></div>
              <div><div className="text-xs text-slate-500">T1</div><div className="font-mono font-bold text-emerald-400">{f0(sig.target1)}</div></div>
              <div><div className="text-xs text-slate-500">T2</div><div className="font-mono font-bold text-emerald-300">{f0(sig.target2)}</div></div>
              <div><div className="text-xs text-slate-500">R:R</div><div className="font-mono font-bold text-slate-200">{sig.risk_reward}x</div></div>
            </>}
            {last && <div className="ml-auto"><div className="text-xs text-slate-500">Last</div><div className="font-mono font-bold text-white">{f0(last.close)}</div></div>}
          </div>
        </div>
      )}

      {/* ── Loading / Error ── */}
      {loading && (
        <div className="flex items-center justify-center gap-2 py-4 text-slate-400 text-sm">
          <span className="animate-spin text-lg">⟳</span> Loading chart data…
        </div>
      )}
      {error && !loading && (
        <div className="text-red-400 text-sm py-2 px-3 bg-red-900/10 border border-red-800/30 rounded-lg">
          {error} — <button onClick={() => fetch(tf)} className="underline">retry</button>
        </div>
      )}

      {/* ── Chart Canvas ── */}
      <div ref={chartRef} className="w-full rounded-lg overflow-hidden" style={{ minHeight: 480 }} />

      {/* ── Example Annotations ── */}
      {showExample && <ExampleAnnotations />}

      {/* ── Live Stats Footer ── */}
      {!showExample && data && !loading && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
          {[
            { label: 'Order Blocks', val: `${(data.ob_zones ?? []).filter(z => !z.mitigated).length} active`, color: 'text-emerald-400' },
            { label: 'FVG Zones',    val: `${(data.fvg_zones ?? []).filter(z => !z.filled).length} open`,    color: 'text-cyan-400' },
            { label: 'Liq Levels',  val: `${(data.liq_levels ?? []).length} detected`,                       color: 'text-purple-400' },
            { label: 'Markers',     val: `${(data.sweeps ?? []).length} events`,                              color: 'text-amber-400' },
          ].map(s => (
            <div key={s.label} className="bg-dark-800 border border-slate-800 rounded-lg p-2 text-center">
              <div className="text-slate-500">{s.label}</div>
              <div className={`font-bold ${s.color}`}>{s.val}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── Example Annotations ──────────────────────────────────────────────────────

function ExampleAnnotations() {
  return (
    <div className="bg-dark-800 border border-slate-700 rounded-xl p-4 space-y-4">
      <div className="text-sm font-bold text-white">📚 Annotated Example — How to Read ICT+SMC</div>
      <div className="grid sm:grid-cols-2 gap-3">
        {ANNOTATIONS.map(a => (
          <div key={a.id} className={`rounded-lg p-3 border ${a.border}`}>
            <div className={`text-xs font-bold mb-1 ${a.color}`}>{a.id} {a.label}</div>
            <div className="text-xs text-slate-400 leading-relaxed">{a.desc}</div>
          </div>
        ))}
      </div>
      <div className="bg-dark-900 rounded-lg p-3 border border-slate-700">
        <div className="text-xs font-bold text-amber-300 mb-2">⚡ Full Trade Walkthrough</div>
        <ol className="space-y-1.5">
          {TRADE_STEPS.map((s, i) => (
            <li key={i} className="text-xs text-slate-400 flex gap-2">
              <span className="text-amber-400 font-bold flex-shrink-0">{i + 1}.</span><span>{s}</span>
            </li>
          ))}
        </ol>
      </div>
    </div>
  )
}

const ANNOTATIONS = [
  { id: '①', label: 'SSL — Sell-Side Liquidity', border: 'border-red-800/40', color: 'text-red-400',
    desc: 'Equal lows cluster (red dotted lines). Retail stop losses parked below here. Smart money hunts these before reversing.' },
  { id: '②', label: 'Liquidity Sweep ▲', border: 'border-amber-800/40', color: 'text-amber-400',
    desc: 'Price wicks below SSL then closes back above — stops are taken, smart money absorbs sells and goes long.' },
  { id: '③', label: 'Bull Order Block', border: 'border-emerald-800/40', color: 'text-emerald-400',
    desc: 'Last red candle before the bullish impulse (green solid lines). Institutional buy orders placed here. Key retest zone.' },
  { id: '④', label: 'Fair Value Gap (FVG)', border: 'border-cyan-800/40', color: 'text-cyan-400',
    desc: 'Gap between candle[i-2].high and candle[i].low (cyan dashed). Untraded imbalance — price always returns to fill it.' },
  { id: '⑤', label: 'CHoCH → MSS', border: 'border-fuchsia-800/40', color: 'text-fuchsia-400',
    desc: 'Change of Character: broke above last swing high. MSS (arrow): 2+ bullish closes confirm trend shift.' },
  { id: '⑥', label: 'OTE Zone (61.8–79%)', border: 'border-purple-800/40', color: 'text-purple-400',
    desc: 'Fibonacci retracement of the up-move (purple dashed). Institutions scale into longs here — best risk/reward zone.' },
  { id: '⑦', label: 'A+ Entry: OB ∩ FVG', border: 'border-cyan-800/40', color: 'text-cyan-400',
    desc: 'OB zone and FVG overlap in OTE = A+ setup. Cyan solid line = entry at OB mid. Confluence score 8+/10.' },
  { id: '⑧', label: 'SL + Targets', border: 'border-slate-700', color: 'text-slate-300',
    desc: 'SL: 10 pts below OB Low (red). T1: 1.5R (light green). T2: 3R (green). R:R = 1:3.' },
]

const TRADE_STEPS = [
  'HTF Bias = BULL — Higher Highs + Higher Lows confirmed on daily structure',
  'Spot SSL cluster at 23,400 (equal lows × 2) — retail stops sitting below',
  'Bar ② wicks below SSL to 23,360, closes at 23,415 → SWEEP_LOW marker ▲',
  'Bar ③: last bearish candle [23,380–23,450] before impulse = Bull OB',
  'Bars ⑨–⑩: strong 3-bar impulse creates FVG gap [23,450–23,460]',
  'Bar ⑪: closes above previous swing high 23,570 → CHoCH BULL + MSS ✓',
  'Pullback into OTE zone [23,418–23,452] — 61.8%–79% Fib of the up-move',
  'Bar ⑭ enters OB zone AND FVG zone — both overlap inside OTE → Confluence 8/10',
  'Entry: 23,432 (OB mid) | SL: 23,370 (OB low −10) | T1: 23,525 | T2: 23,618 | R:R 3:1',
]

// ─── Static Example Data ──────────────────────────────────────────────────────

const BASE_T = 1748323800
const B = (i: number) => BASE_T + i * 300

const EXAMPLE_BARS: Bar[] = [
  { time: B(0),  date: '', open: 23520, high: 23530, low: 23490, close: 23495, volume: 12000 },
  { time: B(1),  date: '', open: 23495, high: 23510, low: 23460, close: 23465, volume: 15000 },
  { time: B(2),  date: '', open: 23465, high: 23480, low: 23440, close: 23445, volume: 14000 },
  { time: B(3),  date: '', open: 23445, high: 23460, low: 23400, close: 23408, volume: 18000 },
  { time: B(4),  date: '', open: 23408, high: 23450, low: 23405, close: 23440, volume: 11000 },
  { time: B(5),  date: '', open: 23440, high: 23455, low: 23398, close: 23403, volume: 17000 },
  { time: B(6),  date: '', open: 23403, high: 23430, low: 23402, close: 23420, volume: 13000 },
  { time: B(7),  date: '', open: 23420, high: 23425, low: 23360, close: 23415, volume: 25000 },
  { time: B(8),  date: '', open: 23415, high: 23450, low: 23380, close: 23388, volume: 16000 },
  { time: B(9),  date: '', open: 23460, high: 23510, low: 23455, close: 23505, volume: 30000 },
  { time: B(10), date: '', open: 23505, high: 23550, low: 23500, close: 23545, volume: 28000 },
  { time: B(11), date: '', open: 23545, high: 23580, low: 23540, close: 23570, volume: 22000 },
  { time: B(12), date: '', open: 23570, high: 23575, low: 23490, close: 23500, volume: 18000 },
  { time: B(13), date: '', open: 23500, high: 23510, low: 23435, close: 23445, volume: 20000 },
  { time: B(14), date: '', open: 23445, high: 23460, low: 23420, close: 23432, volume: 22000 },
  { time: B(15), date: '', open: 23432, high: 23470, low: 23425, close: 23462, volume: 19000 },
  { time: B(16), date: '', open: 23462, high: 23520, low: 23458, close: 23512, volume: 24000 },
  { time: B(17), date: '', open: 23512, high: 23555, low: 23508, close: 23548, volume: 21000 },
  { time: B(18), date: '', open: 23548, high: 23615, low: 23542, close: 23608, volume: 26000 },
]

const EXAMPLE_OB_ZONES: OBZone[] = [
  { start_time: B(8), high: 23450, low: 23380, mid: 23415, type: 'BULL', mitigated: false },
]
const EXAMPLE_FVG_ZONES: FVGZone[] = [
  { start_time: B(8), end_time: B(18), low: 23450, high: 23460, type: 'BULL', filled: false },
]
const EXAMPLE_SWEEPS: LevelMarker[] = [
  { time: B(7),  type: 'SWEEP_LOW',  price: 23360, label: '② SWEEP ▲' },
  { time: B(11), type: 'CHOCH_BULL', price: 23570, label: '⑤ MSS ✓' },
  { time: B(14), type: 'SWEEP_LOW',  price: 23420, label: '⑦ Entry' },
]
const EXAMPLE_LIQ: LiqLevel[] = [
  { price: 23400, type: 'SSL', swept: true,  count: 2 },
  { price: 23575, type: 'BSL', swept: false, count: 2 },
]
const EXAMPLE_OTE  = { low: 23418, high: 23452, equil: 23485 }
const EXAMPLE_SIGNAL: ICTSMCSig = {
  signal: 'CE_BUY', combined_bias: 'BULL', confluence: 8, confidence: 87,
  entry: 23432, stop_loss: 23370, target1: 23525, target2: 23618, risk_reward: 3.0,
}
