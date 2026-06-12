import { useEffect, useRef, useState } from 'react'
import { createChart, ColorType, CrosshairMode, LineStyle } from 'lightweight-charts'
import type { IChartApi, ISeriesApi, SeriesMarker, Time, IPriceLine } from 'lightweight-charts'
import axios from 'axios'

interface SMCBar { time: number; date: string; open: number; high: number; low: number; close: number; volume: number }
interface SMCMarker { time: number; type: string; price: number }
interface SMCFVGZone { start_time: number; end_time: number; low: number; high: number; type: string; filled: boolean }
interface SMCSignal {
  signal: string; htf_bias: string; sweep_type: string; sweep_price: number
  entry: number; stop_loss: number; target: number; risk_reward: number
}
interface SMCEventsData {
  bars: SMCBar[]; swings: SMCMarker[]; sweeps: SMCMarker[]; fvgs: SMCFVGZone[]
  signal: SMCSignal; generated_at: string
}

const fmtINR = (n: number) => '₹' + Math.round(n || 0).toLocaleString('en-IN')

export default function SMCChart() {
  const chartRef = useRef<HTMLDivElement>(null)
  const chart = useRef<IChartApi | null>(null)
  const candleSeries = useRef<ISeriesApi<'Candlestick'> | null>(null)
  const priceLines = useRef<IPriceLine[]>([])

  const [data, setData] = useState<SMCEventsData | null>(null)
  const [loading, setLoading] = useState(false)
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null)
  const [autoRefresh, setAutoRefresh] = useState(true)
  const [timeframe, setTimeframe] = useState<'5m' | '15m'>('5m')
  const [account, setAccount] = useState(100000)
  const [riskPct, setRiskPct] = useState(1.0)

  const fetchEvents = async (tf: '5m' | '15m' = timeframe) => {
    setLoading(true)
    try {
      const r = await axios.get(`/api/naren/v1/nifty/smc-events?bars=120&timeframe=${tf}`)
      setData(r.data); setLastUpdate(new Date())
    } finally { setLoading(false) }
  }

  useEffect(() => { fetchEvents(timeframe) /* eslint-disable-next-line */ }, [timeframe])
  useEffect(() => {
    if (!autoRefresh) return
    const id = setInterval(() => fetchEvents(timeframe), 30000)
    return () => clearInterval(id)
    // eslint-disable-next-line
  }, [autoRefresh, timeframe])

  // ── Compute R:R levels — three modes ──────────────────────────────────────
  const last = data?.bars[data.bars.length - 1]
  let mode: 'active' | 'preview' | 'default' = 'default'
  let dir = 'CE'
  let entry = 0, sl = 0, tp = 0

  if (data && data.signal.signal !== 'WAIT' && data.signal.entry > 0) {
    mode = 'active'
    entry = data.signal.entry; sl = data.signal.stop_loss; tp = data.signal.target
    dir = data.signal.signal === 'CE_BUY' ? 'CE' : 'PE'
  } else if (data && data.signal.sweep_type && last) {
    mode = 'preview'
    entry = last.close
    if (data.signal.sweep_type === 'LOW') {
      sl = data.signal.sweep_price - 10
      tp = entry + (entry - sl) * 3
      dir = 'CE'
    } else {
      sl = data.signal.sweep_price + 10
      tp = entry - (sl - entry) * 3
      dir = 'PE'
    }
  } else if (last) {
    mode = 'default'
    entry = last.close
    sl = entry - 10
    tp = entry + 30
    dir = 'CE (default reference)'
  }

  const riskPts = Math.abs(entry - sl)
  const rwdPts  = Math.abs(tp - entry)
  const rr      = riskPts > 0 ? rwdPts / riskPts : 0
  const riskINR = account * riskPct / 100
  const delta = 0.5, lotSize = 50
  const slPremium = riskPts * delta * lotSize
  let lots = slPremium > 0 ? Math.floor(riskINR / slPremium) : 1
  if (lots < 1) lots = 1
  const maxLoss = riskPts * delta * lotSize * lots
  const tgtGain = rwdPts * delta * lotSize * lots

  // ── Initialize chart ──────────────────────────────────────────────────────
  useEffect(() => {
    if (!chartRef.current) return
    chart.current = createChart(chartRef.current, {
      layout: { background: { type: ColorType.Solid, color: '#0f172a' }, textColor: '#94a3b8' },
      grid: { vertLines: { color: '#1e293b' }, horzLines: { color: '#1e293b' } },
      crosshair: { mode: CrosshairMode.Normal },
      width: chartRef.current.clientWidth,
      height: 480,
      timeScale: { timeVisible: true, secondsVisible: false, borderColor: '#334155' },
      rightPriceScale: { borderColor: '#334155' },
    })
    candleSeries.current = chart.current.addCandlestickSeries({
      upColor: '#10b981', downColor: '#ef4444',
      borderUpColor: '#10b981', borderDownColor: '#ef4444',
      wickUpColor: '#10b981', wickDownColor: '#ef4444',
    })
    const resize = () => {
      if (chart.current && chartRef.current) chart.current.applyOptions({ width: chartRef.current.clientWidth })
    }
    window.addEventListener('resize', resize)
    return () => { window.removeEventListener('resize', resize); chart.current?.remove() }
  }, [])

  // ── Update chart on data change ───────────────────────────────────────────
  useEffect(() => {
    if (!data || !candleSeries.current || !chart.current) return
    candleSeries.current.setData(data.bars.map(b => ({
      time: b.time as Time, open: b.open, high: b.high, low: b.low, close: b.close,
    })))

    // Markers
    const markers: SeriesMarker<Time>[] = []
    for (const sw of data.sweeps.slice(-15)) {
      markers.push({
        time: sw.time as Time,
        position: sw.type === 'HIGH' ? 'aboveBar' : 'belowBar',
        color: sw.type === 'HIGH' ? '#ef4444' : '#10b981',
        shape: sw.type === 'HIGH' ? 'arrowDown' : 'arrowUp',
        text: 'SWEEP',
      })
    }
    if (data.signal.signal === 'CE_BUY' && last) {
      markers.push({ time: last.time as Time, position: 'belowBar', color: '#10b981', shape: 'arrowUp',   text: '⚡ BUY CE 1:3' })
    } else if (data.signal.signal === 'PE_BUY' && last) {
      markers.push({ time: last.time as Time, position: 'aboveBar', color: '#ef4444', shape: 'arrowDown', text: '⚡ BUY PE 1:3' })
    }
    candleSeries.current.setMarkers(markers)

    // Clear old price lines
    for (const pl of priceLines.current) {
      candleSeries.current.removePriceLine(pl)
    }
    priceLines.current = []

    // Always draw Entry / SL / TP — mode determines style
    if (entry > 0 && candleSeries.current) {
      const isActive = mode === 'active'
      const lineWidth = isActive ? 3 : 2
      const styleTPSL = isActive ? LineStyle.Dashed : LineStyle.Dotted
      priceLines.current.push(candleSeries.current.createPriceLine({
        price: entry, color: '#06b6d4', lineWidth: 2,
        lineStyle: LineStyle.Solid, axisLabelVisible: true,
        title: `ENTRY ${mode==='active'?'⚡':mode==='preview'?'👀':'•'}`,
      }))
      priceLines.current.push(candleSeries.current.createPriceLine({
        price: sl, color: '#ef4444', lineWidth: lineWidth,
        lineStyle: styleTPSL, axisLabelVisible: true, title: `SL -1R`,
      }))
      priceLines.current.push(candleSeries.current.createPriceLine({
        price: tp, color: '#10b981', lineWidth: lineWidth,
        lineStyle: styleTPSL, axisLabelVisible: true, title: `TP +${rr.toFixed(1)}R`,
      }))
    }
    chart.current.timeScale().fitContent()
    // eslint-disable-next-line
  }, [data])

  const modeCfg = {
    active:  { bg: 'bg-emerald-500/15 border-emerald-500/40', text: 'text-emerald-300', label: '⚡ ACTIVE TRADE' },
    preview: { bg: 'bg-yellow-500/15 border-yellow-500/40',   text: 'text-yellow-300',  label: '👀 PREVIEW (sweep done, FVG forming)' },
    default: { bg: 'bg-slate-700/40 border-slate-600/40',     text: 'text-slate-300',   label: '— REFERENCE (no setup yet)' },
  }[mode]

  return (
    <div className="bg-dark-900 rounded-xl border border-dark-700 p-4">
      {/* Header & controls */}
      <div className="flex flex-wrap items-center gap-3 mb-3">
        <h2 className="text-base font-bold text-white">📈 Live Chart — SMC + R:R</h2>
        <div className="flex bg-dark-800 rounded p-0.5">
          {(['5m', '15m'] as const).map(tf => (
            <button key={tf} onClick={() => setTimeframe(tf)}
              className={`px-3 py-1 text-xs font-bold rounded transition-all ${
                timeframe === tf ? 'bg-fuchsia-600 text-white' : 'text-slate-400 hover:text-slate-200'}`}>
              {tf}
            </button>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-2">
          <span className="text-xs text-slate-500">
            {lastUpdate ? `Updated ${lastUpdate.toLocaleTimeString()}` : '—'}
          </span>
          <button onClick={() => fetchEvents()} disabled={loading}
            className={`px-3 py-1.5 text-sm font-bold rounded transition-all ${
              loading ? 'bg-slate-700 text-slate-400 cursor-wait'
                      : 'bg-fuchsia-600 hover:bg-fuchsia-500 text-white shadow-lg shadow-fuchsia-500/30'}`}>
            {loading ? '⟳ Loading' : '🔄 FETCH LIVE'}
          </button>
          <label className="inline-flex items-center gap-1 cursor-pointer text-xs">
            <input type="checkbox" checked={autoRefresh} onChange={e => setAutoRefresh(e.target.checked)} className="accent-fuchsia-500"/>
            <span className="text-slate-400">Auto 30s</span>
          </label>
        </div>
      </div>

      {/* ════════════════ R:R BANNER — ALWAYS VISIBLE ════════════════ */}
      <div className={`rounded-xl border-2 ${modeCfg.bg} p-4 mb-3`}>
        <div className="flex items-center justify-between mb-3">
          <div className={`text-xs font-bold ${modeCfg.text}`}>{modeCfg.label}</div>
          <div className="text-xs text-slate-400">Direction: <span className={dir.startsWith('CE')?'text-emerald-400':'text-rose-400'}>{dir}</span></div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-4 gap-3 mb-3">
          {/* Big R:R */}
          <div className="bg-dark-800 rounded-lg p-3 text-center border border-yellow-500/30">
            <div className="text-[10px] text-slate-500 uppercase">Risk : Reward</div>
            <div className="text-3xl font-black font-mono text-yellow-300">1 : {rr.toFixed(1)}</div>
          </div>
          <Cell label="Entry"  val={entry.toFixed(2)} color="text-cyan-400" />
          <Cell label="Stop Loss" val={sl.toFixed(2) + `  (${riskPts.toFixed(1)} pts)`} color="text-rose-400" />
          <Cell label="Target" val={tp.toFixed(2) + `  (${rwdPts.toFixed(1)} pts)`} color="text-emerald-400" />
        </div>

        {/* Visual R:R bar */}
        <div className="bg-dark-800 rounded p-2">
          <div className="text-[10px] text-slate-500 uppercase mb-1.5 text-center">Risk-Reward Proportion</div>
          <div className="flex gap-0.5 h-10 mb-1">
            <div className="bg-rose-500 rounded-l flex items-center justify-center text-xs font-bold text-white"
              style={{ width: `${(riskPts/(riskPts+rwdPts))*100}%` }}>
              {riskPts.toFixed(1)} pts (-1R)
            </div>
            <div className="bg-emerald-500 rounded-r flex items-center justify-center text-xs font-bold text-white"
              style={{ width: `${(rwdPts/(riskPts+rwdPts))*100}%` }}>
              +{rwdPts.toFixed(1)} pts (+{(rwdPts/Math.max(riskPts,0.01)).toFixed(1)}R)
            </div>
          </div>
        </div>
      </div>

      {/* Summary stats */}
      <div className="grid grid-cols-2 md:grid-cols-6 gap-2 mb-3">
        <Stat label="Last Price" val={last ? last.close.toFixed(2) : '—'} color="text-slate-100" />
        <Stat label="HTF Bias" val={data?.signal.htf_bias ?? '—'}
              color={data?.signal.htf_bias === 'BULL' ? 'text-emerald-400'
                   : data?.signal.htf_bias === 'BEAR' ? 'text-rose-400' : 'text-slate-400'} />
        <Stat label="Sweeps" val={String(data?.sweeps.length ?? 0)} color="text-yellow-400" />
        <Stat label="Bull FVGs" val={String(data?.fvgs.filter(f => !f.filled && f.type === 'BULL').length ?? 0)} color="text-emerald-400" />
        <Stat label="Bear FVGs" val={String(data?.fvgs.filter(f => !f.filled && f.type === 'BEAR').length ?? 0)} color="text-rose-400" />
        <Stat label="Timeframe" val={timeframe} color="text-fuchsia-400" />
      </div>

      {/* Chart */}
      <div ref={chartRef} className="w-full" />

      {/* Position sizing (always live) */}
      <div className="mt-3 grid grid-cols-2 md:grid-cols-6 gap-2">
        <RiskCard label="Account" val={fmtINR(account)} color="text-slate-200" editable
          onClick={() => { const v = prompt('Account size (₹)', String(account)); if (v && +v > 0) setAccount(+v) }}/>
        <RiskCard label="Risk %" val={`${riskPct}%`} color="text-amber-400" editable
          onClick={() => { const v = prompt('Risk per trade (%)', String(riskPct)); if (v && +v > 0 && +v < 5) setRiskPct(+v) }}/>
        <RiskCard label="Risk ₹" val={fmtINR(riskINR)} color="text-amber-400" />
        <RiskCard label="Lots to Buy" val={String(lots)} color="text-fuchsia-300" big />
        <RiskCard label="Max Loss" val={fmtINR(maxLoss)} color="text-rose-400" />
        <RiskCard label="Target Gain" val={fmtINR(tgtGain)} color="text-emerald-400" />
      </div>

      {/* FVG list */}
      {data && data.fvgs.filter(f => !f.filled).length > 0 && (
        <div className="mt-3 p-3 bg-dark-800 rounded-lg">
          <div className="text-xs text-slate-400 mb-2">🎯 Open FVG Zones (price magnets)</div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
            {data.fvgs.filter(f => !f.filled).slice(-8).map((f, i) => (
              <div key={i} className={`px-2 py-1.5 rounded text-xs font-mono ${
                f.type === 'BULL' ? 'bg-emerald-500/10 border border-emerald-500/30 text-emerald-300'
                                  : 'bg-rose-500/10 border border-rose-500/30 text-rose-300'}`}>
                <div className="text-[10px] opacity-70">{f.type}</div>
                <div>{f.low.toFixed(0)} – {f.high.toFixed(0)}</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function Cell({ label, val, color }: { label: string; val: string; color: string }) {
  return (
    <div className="bg-dark-800 rounded-lg p-3 text-center">
      <div className="text-[10px] text-slate-500 uppercase">{label}</div>
      <div className={`text-base font-bold font-mono ${color}`}>{val}</div>
    </div>
  )
}

function Stat({ label, val, color }: { label: string; val: string; color: string }) {
  return (
    <div className="bg-dark-800 rounded p-2 text-center border border-dark-700">
      <div className="text-[9px] text-slate-500 uppercase tracking-wide">{label}</div>
      <div className={`text-sm font-bold font-mono ${color}`}>{val}</div>
    </div>
  )
}

function RiskCard({ label, val, color, big, editable, onClick }: {label:string;val:string;color:string;big?:boolean;editable?:boolean;onClick?:()=>void}) {
  return (
    <div onClick={onClick}
      className={`bg-dark-800 rounded p-2 text-center border border-dark-700 ${editable ? 'cursor-pointer hover:border-fuchsia-500/50' : ''}`}>
      <div className="text-[9px] text-slate-500 uppercase tracking-wide">
        {label} {editable && <span className="text-fuchsia-400">✎</span>}
      </div>
      <div className={`${big ? 'text-lg' : 'text-sm'} font-bold font-mono ${color}`}>{val}</div>
    </div>
  )
}
