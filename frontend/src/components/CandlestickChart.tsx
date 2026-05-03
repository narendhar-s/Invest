import { useEffect, useRef } from 'react'
import { createChart, CrosshairMode, LineStyle, type IChartApi, type ISeriesApi } from 'lightweight-charts'
import type { PriceBar, TechnicalIndicator, SRLevel } from '../types'

interface Props {
  bars: PriceBar[]
  indicators: TechnicalIndicator[]
  srLevels?: SRLevel[]
  height?: number
}

export default function CandlestickChart({ bars, indicators, srLevels = [], height = 480 }: Props) {
  const chartRef = useRef<HTMLDivElement>(null)
  const chartInstance = useRef<IChartApi | null>(null)

  useEffect(() => {
    if (!chartRef.current || bars.length === 0) return

    // Create chart
    const chart = createChart(chartRef.current, {
      width: chartRef.current.clientWidth,
      height,
      layout: {
        background: { color: '#0f1629' },
        textColor: '#94a3b8',
      },
      grid: {
        vertLines: { color: '#1a2540', style: LineStyle.Dotted },
        horzLines: { color: '#1a2540', style: LineStyle.Dotted },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: '#3b82f6', labelBackgroundColor: '#1d4ed8' },
        horzLine: { color: '#3b82f6', labelBackgroundColor: '#1d4ed8' },
      },
      rightPriceScale: {
        borderColor: '#1a2540',
      },
      timeScale: {
        borderColor: '#1a2540',
        timeVisible: true,
      },
    })

    chartInstance.current = chart

    // ── Candlestick series ────────────────────────────────────────────────
    const candleSeries = chart.addCandlestickSeries({
      upColor: '#10b981',
      downColor: '#ef4444',
      borderUpColor: '#10b981',
      borderDownColor: '#ef4444',
      wickUpColor: '#10b981',
      wickDownColor: '#ef4444',
    })

    const candleData = bars.map((b) => ({
      time: b.date.substring(0, 10) as any,
      open: b.open,
      high: b.high,
      low: b.low,
      close: b.close,
    }))
    candleSeries.setData(candleData)

    // ── Volume series ─────────────────────────────────────────────────────
    const volumeSeries = chart.addHistogramSeries({
      priceFormat: { type: 'volume' },
      priceScaleId: 'volume',
      color: '#1e40af',
    })
    chart.priceScale('volume').applyOptions({
      scaleMargins: { top: 0.8, bottom: 0 },
    })

    const volumeData = bars.map((b) => ({
      time: b.date.substring(0, 10) as any,
      value: b.volume,
      color: b.close >= b.open ? '#10b98133' : '#ef444433',
    }))
    volumeSeries.setData(volumeData)

    // ── Moving Average overlays ───────────────────────────────────────────
    const maColors = { sma20: '#f59e0b', sma50: '#3b82f6', sma200: '#a855f7' }

    const addMA = (key: keyof typeof maColors, seriesKey: keyof TechnicalIndicator) => {
      const maSeries = chart.addLineSeries({
        color: maColors[key],
        lineWidth: 1,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
      })
      const maData = indicators
        .filter((i) => i[seriesKey] != null)
        .map((i) => ({
          time: i.date.substring(0, 10) as any,
          value: i[seriesKey] as number,
        }))
      if (maData.length > 0) maSeries.setData(maData)
    }

    addMA('sma20', 'sma20')
    addMA('sma50', 'sma50')
    addMA('sma200', 'sma200')

    // ── Bollinger Bands ───────────────────────────────────────────────────
    const bbUpperSeries = chart.addLineSeries({
      color: '#64748b55',
      lineWidth: 1,
      lineStyle: LineStyle.Dashed,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    })
    const bbLowerSeries = chart.addLineSeries({
      color: '#64748b55',
      lineWidth: 1,
      lineStyle: LineStyle.Dashed,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    })

    const bbUpper = indicators.filter((i) => i.bb_upper != null).map((i) => ({
      time: i.date.substring(0, 10) as any, value: i.bb_upper!,
    }))
    const bbLower = indicators.filter((i) => i.bb_lower != null).map((i) => ({
      time: i.date.substring(0, 10) as any, value: i.bb_lower!,
    }))
    if (bbUpper.length) bbUpperSeries.setData(bbUpper)
    if (bbLower.length) bbLowerSeries.setData(bbLower)

    // ── Support & Resistance lines ────────────────────────────────────────
    for (const level of srLevels) {
      const lineColor =
        level.level_type === 'support' || level.level_type === 'accumulation' ? '#10b98160' :
        level.level_type === 'resistance' || level.level_type === 'supply' ? '#ef444460' :
        level.level_type === 'breakout' ? '#f59e0b60' : '#3b82f660'

      candleSeries.createPriceLine({
        price: level.price,
        color: lineColor,
        lineWidth: 1,
        lineStyle: LineStyle.Dotted,
        axisLabelVisible: true,
        title: `${level.level_type.toUpperCase()} (${level.strength.toFixed(0)})`,
      })
    }

    // ── Fit content ────────────────────────────────────────────────────────
    chart.timeScale().fitContent()

    // ── Responsive resize ─────────────────────────────────────────────────
    const handleResize = () => {
      if (chartRef.current) {
        chart.applyOptions({ width: chartRef.current.clientWidth })
      }
    }
    window.addEventListener('resize', handleResize)

    return () => {
      window.removeEventListener('resize', handleResize)
      chart.remove()
      chartInstance.current = null
    }
  }, [bars, indicators, srLevels, height])

  return (
    <div className="relative">
      <div ref={chartRef} className="w-full rounded-xl overflow-hidden" style={{ height }} />
      {/* Legend */}
      <div className="absolute top-3 left-3 flex flex-wrap gap-3 text-xs pointer-events-none">
        {[
          { color: '#f59e0b', label: 'SMA20' },
          { color: '#3b82f6', label: 'SMA50' },
          { color: '#a855f7', label: 'SMA200' },
          { color: '#64748b', label: 'BB Bands', dashed: true },
        ].map((item) => (
          <span key={item.label} className="flex items-center gap-1 bg-dark-800/80 px-2 py-0.5 rounded">
            <span
              className="inline-block w-5 h-0.5"
              style={{
                background: item.color,
                borderTop: item.dashed ? `1px dashed ${item.color}` : undefined,
              }}
            />
            <span className="text-slate-400">{item.label}</span>
          </span>
        ))}
      </div>
    </div>
  )
}
