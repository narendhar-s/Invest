/**
 * TVChart — TradingView Advanced Chart Widget (free embed)
 * Shows live NIFTY 5-min candles with real indicators from TradingView.
 * No API key required. Uses official TradingView embed script.
 */

import { useEffect, useRef } from 'react'

interface TVChartProps {
  symbol?: string
  interval?: string   // '1' | '3' | '5' | '15' | '30' | '60' | 'D'
  height?: number
  studies?: string[]  // TradingView study IDs
  theme?: 'dark' | 'light'
  showToolbar?: boolean
}

declare global {
  interface Window {
    TradingView?: {
      widget: new (config: Record<string, unknown>) => unknown
    }
  }
}

export default function TVChart({
  symbol = 'NSE:NIFTY50',
  interval = '5',
  height = 520,
  studies = [
    'Volume@tv-basicstudies',
    'VWAP@tv-basicstudies',
    'MAExp@tv-basicstudies',       // EMA
    'RSI@tv-basicstudies',
    'ATR@tv-basicstudies',
  ],
  theme = 'dark',
  showToolbar = true,
}: TVChartProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const widgetRef = useRef<unknown>(null)
  const scriptRef = useRef<HTMLScriptElement | null>(null)

  useEffect(() => {
    const containerId = `tv_chart_${Math.random().toString(36).slice(2, 9)}`
    if (containerRef.current) {
      containerRef.current.id = containerId
    }

    function createWidget() {
      if (!containerRef.current || !window.TradingView) return
      widgetRef.current = new window.TradingView.widget({
        autosize: true,
        symbol,
        interval,
        timezone: 'Asia/Kolkata',
        theme,
        style: '1',                   // candlestick
        locale: 'en',
        toolbar_bg: theme === 'dark' ? '#0f172a' : '#f1f3f6',
        enable_publishing: false,
        hide_top_toolbar: !showToolbar,
        hide_legend: false,
        allow_symbol_change: true,
        save_image: false,
        container_id: containerId,
        studies,
        overrides: {
          // Dark background matching our Tailwind theme
          'paneProperties.background': '#0f172a',
          'paneProperties.backgroundType': 'solid',
          'paneProperties.vertGridProperties.color': '#1e293b',
          'paneProperties.horzGridProperties.color': '#1e293b',
          'symbolWatermarkProperties.transparency': 90,
          'scalesProperties.textColor': '#94a3b8',
          'mainSeriesProperties.candleStyle.upColor': '#34d399',
          'mainSeriesProperties.candleStyle.downColor': '#f87171',
          'mainSeriesProperties.candleStyle.wickUpColor': '#34d399',
          'mainSeriesProperties.candleStyle.wickDownColor': '#f87171',
          'mainSeriesProperties.candleStyle.borderUpColor': '#34d399',
          'mainSeriesProperties.candleStyle.borderDownColor': '#f87171',
        },
        studies_overrides: {
          'volume.volume.color.0': '#f8717150',
          'volume.volume.color.1': '#34d39950',
          'vwap.plot.color': '#60a5fa',
          'vwap.plot.linewidth': 2,
          'moving average exponential.plot.color': '#f59e0b',
          'RSI.RSI.color': '#a78bfa',
        },
        loading_screen: {
          backgroundColor: '#0f172a',
          foregroundColor: '#7c3aed',
        },
        custom_css_url: '',
        withdateranges: true,
        hide_side_toolbar: false,
        details: true,
        hotlist: false,
        calendar: false,
      })
    }

    // Load or reuse the TradingView script
    if (window.TradingView) {
      createWidget()
    } else {
      const existing = document.querySelector('script[src*="tradingview.com/tv.js"]')
      if (existing) {
        existing.addEventListener('load', createWidget)
      } else {
        const script = document.createElement('script')
        script.src = 'https://s3.tradingview.com/tv.js'
        script.async = true
        script.onload = createWidget
        document.head.appendChild(script)
        scriptRef.current = script
      }
    }

    return () => {
      // Cleanup container contents on unmount (widget cleans itself)
      if (containerRef.current) {
        containerRef.current.innerHTML = ''
      }
    }
  }, [symbol, interval, theme, showToolbar])   // re-mount when key props change

  return (
    <div
      ref={containerRef}
      style={{ height }}
      className="w-full rounded-xl overflow-hidden border border-slate-800 bg-slate-950"
    />
  )
}
