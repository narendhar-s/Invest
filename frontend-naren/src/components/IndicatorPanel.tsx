import { useEffect, useRef } from 'react'
import { createChart, LineStyle } from 'lightweight-charts'
import type { TechnicalIndicator, PriceBar } from '../types'

interface Props {
  indicators: TechnicalIndicator[]
  bars: PriceBar[]
}

function RSIGauge({ value }: { value: number | null }) {
  if (value == null) return <span className="text-slate-500">—</span>
  const color = value < 30 ? 'text-emerald-400' : value > 70 ? 'text-red-400' : 'text-amber-400'
  const label = value < 30 ? 'Oversold' : value > 70 ? 'Overbought' : 'Neutral'
  return (
    <div className="flex items-center gap-3">
      <div className="flex-1 bg-dark-800 rounded-full h-2 relative overflow-hidden">
        <div className="absolute inset-0 flex">
          <div className="w-[30%] bg-emerald-500/20 border-r border-emerald-500/30" />
          <div className="w-[40%] bg-amber-500/10" />
          <div className="w-[30%] bg-red-500/20 border-l border-red-500/30" />
        </div>
        <div
          className="absolute top-0 h-2 w-1 bg-white rounded-full"
          style={{ left: `${value}%`, transform: 'translateX(-50%)' }}
        />
      </div>
      <span className={`font-mono text-sm font-semibold ${color}`}>{value.toFixed(1)}</span>
      <span className={`text-xs ${color}`}>{label}</span>
    </div>
  )
}

export default function IndicatorPanel({ indicators, bars }: Props) {
  const rsiRef = useRef<HTMLDivElement>(null)
  const macdRef = useRef<HTMLDivElement>(null)

  const latest = indicators.length > 0 ? indicators[indicators.length - 1] : null

  useEffect(() => {
    if (!rsiRef.current || indicators.length === 0) return

    const rsiChart = createChart(rsiRef.current, {
      width: rsiRef.current.clientWidth,
      height: 120,
      layout: { background: { color: '#0f1629' }, textColor: '#94a3b8' },
      grid: {
        vertLines: { color: '#1a254015' },
        horzLines: { color: '#1a254030' },
      },
      rightPriceScale: { borderColor: '#1a2540', scaleMargins: { top: 0.1, bottom: 0.1 } },
      timeScale: { borderColor: '#1a2540', visible: false },
    })

    const rsiSeries = rsiChart.addLineSeries({ color: '#f59e0b', lineWidth: 1, priceLineVisible: false })
    const overbought = rsiChart.addLineSeries({
      color: '#ef444450', lineWidth: 1, lineStyle: LineStyle.Dashed, priceLineVisible: false, lastValueVisible: false,
    })
    const oversold = rsiChart.addLineSeries({
      color: '#10b98150', lineWidth: 1, lineStyle: LineStyle.Dashed, priceLineVisible: false, lastValueVisible: false,
    })

    const rsiData = indicators.filter((i) => i.rsi != null).map((i) => ({ time: i.date.substring(0, 10) as any, value: i.rsi! }))
    if (rsiData.length > 0) {
      rsiSeries.setData(rsiData)
      overbought.setData(rsiData.map((d) => ({ time: d.time, value: 70 })))
      oversold.setData(rsiData.map((d) => ({ time: d.time, value: 30 })))
    }
    rsiChart.timeScale().fitContent()

    const resize = () => { if (rsiRef.current) rsiChart.applyOptions({ width: rsiRef.current.clientWidth }) }
    window.addEventListener('resize', resize)
    return () => { window.removeEventListener('resize', resize); rsiChart.remove() }
  }, [indicators])

  useEffect(() => {
    if (!macdRef.current || indicators.length === 0) return

    const macdChart = createChart(macdRef.current, {
      width: macdRef.current.clientWidth,
      height: 120,
      layout: { background: { color: '#0f1629' }, textColor: '#94a3b8' },
      grid: {
        vertLines: { color: '#1a254015' },
        horzLines: { color: '#1a254030' },
      },
      rightPriceScale: { borderColor: '#1a2540' },
      timeScale: { borderColor: '#1a2540', timeVisible: true },
    })

    const macdLine = macdChart.addLineSeries({ color: '#3b82f6', lineWidth: 1, priceLineVisible: false, title: 'MACD' })
    const signalLine = macdChart.addLineSeries({ color: '#f59e0b', lineWidth: 1, priceLineVisible: false, title: 'Signal' })
    const histSeries = macdChart.addHistogramSeries({ priceLineVisible: false, title: 'Hist' })

    const macdData = indicators.filter((i) => i.macd_line != null).map((i) => ({ time: i.date.substring(0, 10) as any, value: i.macd_line! }))
    const signalData = indicators.filter((i) => i.signal_line != null).map((i) => ({ time: i.date.substring(0, 10) as any, value: i.signal_line! }))
    const histData = indicators.filter((i) => i.macd_hist != null).map((i) => ({
      time: i.date.substring(0, 10) as any,
      value: i.macd_hist!,
      color: i.macd_hist! >= 0 ? '#10b98150' : '#ef444450',
    }))

    if (macdData.length) macdLine.setData(macdData)
    if (signalData.length) signalLine.setData(signalData)
    if (histData.length) histSeries.setData(histData)
    macdChart.timeScale().fitContent()

    const resize = () => { if (macdRef.current) macdChart.applyOptions({ width: macdRef.current.clientWidth }) }
    window.addEventListener('resize', resize)
    return () => { window.removeEventListener('resize', resize); macdChart.remove() }
  }, [indicators])

  if (!latest) return null

  return (
    <div className="space-y-4">
      {/* Key Values Grid */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          { label: 'RSI (14)', value: latest.rsi?.toFixed(1) ?? '—', color: latest.rsi != null ? (latest.rsi < 30 ? 'text-emerald-400' : latest.rsi > 70 ? 'text-red-400' : 'text-amber-400') : 'text-slate-500' },
          { label: 'MACD Hist', value: latest.macd_hist?.toFixed(3) ?? '—', color: latest.macd_hist != null ? (latest.macd_hist > 0 ? 'text-emerald-400' : 'text-red-400') : 'text-slate-500' },
          { label: 'Trend', value: latest.trend_direction || '—', color: latest.trend_direction === 'UP' ? 'text-emerald-400' : latest.trend_direction === 'DOWN' ? 'text-red-400' : 'text-amber-400' },
          { label: 'Tech Score', value: latest.technical_score.toFixed(0), color: latest.technical_score > 60 ? 'text-emerald-400' : latest.technical_score < 40 ? 'text-red-400' : 'text-amber-400' },
          { label: 'BB Width', value: latest.bb_width?.toFixed(2) ?? '—', color: 'text-slate-300' },
          { label: 'Rel Volume', value: latest.relative_volume?.toFixed(2) ?? '—', color: latest.volume_spike ? 'text-emerald-400' : 'text-slate-300' },
          { label: 'SMA20', value: latest.sma20?.toFixed(2) ?? '—', color: 'text-amber-400' },
          { label: 'SMA200', value: latest.sma200?.toFixed(2) ?? '—', color: 'text-purple-400' },
        ].map((item) => (
          <div key={item.label} className="bg-dark-700 border border-slate-800/60 rounded-lg p-3">
            <div className="text-xs text-slate-500 mb-1">{item.label}</div>
            <div className={`font-mono text-sm font-semibold ${item.color}`}>{item.value}</div>
          </div>
        ))}
      </div>

      {/* RSI Chart */}
      <div className="bg-dark-700 border border-slate-800/60 rounded-xl p-3">
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs font-medium text-slate-400">RSI (14)</span>
          <RSIGauge value={latest.rsi ?? null} />
        </div>
        <div ref={rsiRef} className="w-full rounded-lg overflow-hidden" />
      </div>

      {/* MACD Chart */}
      <div className="bg-dark-700 border border-slate-800/60 rounded-xl p-3">
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs font-medium text-slate-400">MACD (12, 26, 9)</span>
          {latest.macd_hist != null && (
            <span className={`text-xs font-mono ${latest.macd_hist > 0 ? 'text-emerald-400' : 'text-red-400'}`}>
              {latest.macd_hist > 0 ? '▲ Bullish' : '▼ Bearish'}
            </span>
          )}
        </div>
        <div ref={macdRef} className="w-full rounded-lg overflow-hidden" />
      </div>
    </div>
  )
}
