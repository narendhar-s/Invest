import { useEffect, useRef, useState } from 'react'
import {
  getLiveStrategies,
  getLiveStatus,
  startLive,
  stopLive,
  openLiveCallsStream,
  getLiveCallsHistory,
  type StrategyMeta,
  type ModeMeta,
  type LiveCall,
  type LiveCallRecord,
  type LiveStatus,
  getZerodhaStatus,
  getZerodhaLoginUrl,
  type ZerodhaStatus,
  runStrategyBacktest,
  type BacktestSummary,
} from '../api/client'
import LiveChart from '../components/LiveChart'
import OIPanel from '../components/OIPanel'
import StrategyEditor from '../components/StrategyEditor'
import {
  showToast,
  playBeep,
  showDesktopNotification,
  requestNotificationPermission,
} from '../lib/notify'

const TIMEFRAMES = ['1m', '3m', '5m', '15m']

// Local YYYY-MM-DD for the date picker (avoids UTC off-by-one from toISOString).
const localDateStr = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

// Index symbols the engine can track (with OI / derivatives). Symbols use the
// app's Yahoo-style aliases resolved by the backend index registry.
const INDEX_QUICK_ADD = [
  { label: 'NIFTY 50', symbol: '^NSEI' },
  { label: 'BANKNIFTY', symbol: '^NSEBANK' },
  { label: 'FINNIFTY', symbol: 'FINNIFTY' },
  { label: 'SENSEX', symbol: 'SENSEX' },
]

// fmt safely formats a possibly-missing numeric field; returns '—' when the
// value isn't a finite number (replayed calls may omit target/stop/etc).
const fmt = (n: number | null | undefined, digits = 2) =>
  typeof n === 'number' && isFinite(n) ? n.toFixed(digits) : '—'

const statusColor = (s: string) => {
  switch (s) {
    case 'ORDER_PLACED': return 'text-emerald-400'
    case 'ORDER_REJECTED': return 'text-red-400'
    case 'PAPER_FILLED': return 'text-sky-400'
    default: return 'text-slate-300'
  }
}

export default function LiveTrading() {
  const [strategies, setStrategies] = useState<StrategyMeta[]>([])
  const [modes, setModes] = useState<ModeMeta[]>([])
  const [dataSource, setDataSource] = useState('')

  // Multi-strategy consensus: pick several strategies; a call only fires when at
  // least `minAgree` of them agree on the same symbol + direction in a candle.
  const [liveStrategies, setLiveStrategies] = useState<string[]>([])
  const [minAgree, setMinAgree] = useState(1)
  const [stratMenuOpen, setStratMenuOpen] = useState(false)
  // Strategy whose config editor modal is open (null = closed).
  const [editingStrategy, setEditingStrategy] = useState<string | null>(null)
  // Backtest result for the replay strategy + symbol (null = not run).
  const [backtest, setBacktest] = useState<BacktestSummary | null>(null)
  const [backtestErr, setBacktestErr] = useState('')
  const [backtesting, setBacktesting] = useState(false)
  // Backtest data window. 'recent' uses the seed source's latest candles;
  // 'days' uses a lookback; 'range' uses explicit from/to dates (Kite history).
  const [btMode, setBtMode] = useState<'recent' | 'days' | 'range'>('recent')
  const [btDays, setBtDays] = useState(5)
  const [btFrom, setBtFrom] = useState('')
  const [btTo, setBtTo] = useState('')
  // Range committed on the last Backtest run — drives the history chart so it
  // draws the same candles the backtest scored.
  const [appliedRange, setAppliedRange] = useState<{ from?: string; to?: string; days?: number }>({})
  // Historical replay uses a single strategy (separate from the live consensus).
  const [replayStrategy, setReplayStrategy] = useState('')
  const [mode, setMode] = useState('signal')
  const [timeframe, setTimeframe] = useState('5m')
  const [symbolsText, setSymbolsText] = useState('')

  const [status, setStatus] = useState<LiveStatus | null>(null)
  const [calls, setCalls] = useState<LiveCall[]>([])
  const [historyDate, setHistoryDate] = useState(localDateStr())
  const [historyCalls, setHistoryCalls] = useState<LiveCallRecord[]>([])
  const [historyLoading, setHistoryLoading] = useState(false)
  // When true the feed shows persisted calls for historyDate; when false it
  // shows the live SSE feed for the running session.
  const [showHistory, setShowHistory] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [chartSymbol, setChartSymbol] = useState('')
  const [historySymbol, setHistorySymbol] = useState('')
  const [zerodha, setZerodha] = useState<ZerodhaStatus | null>(null)
  const [notify, setNotify] = useState(true)
  const [desktopNotify, setDesktopNotify] = useState(false)
  const notifyRef = useRef(true)
  const desktopRef = useRef(false)
  const mountTimeRef = useRef(Date.now())
  const esRef = useRef<EventSource | null>(null)

  // Keep refs in sync so the SSE callback (set up once) reads current values.
  useEffect(() => { notifyRef.current = notify }, [notify])
  useEffect(() => { desktopRef.current = desktopNotify }, [desktopNotify])

  const toggleDesktop = async () => {
    if (!desktopNotify) {
      const ok = await requestNotificationPermission()
      setDesktopNotify(ok)
      if (!ok) setError('Desktop notifications were blocked in the browser.')
    } else {
      setDesktopNotify(false)
    }
  }

  const announce = (c: LiveCall) => {
    // Skip replayed history: only announce calls newer than page load.
    if (new Date(c.timestamp).getTime() < mountTimeRef.current - 2000) return
    if (!notifyRef.current) return
    const kind = c.direction === 'BUY' ? 'buy' : c.direction === 'SELL' ? 'sell' : 'neutral'
    const title = `${c.direction} ${c.symbol} @ ${fmt(c.price)}`
    const body = `${c.strategy} · ${c.reason}`
    showToast(title, body, kind)
    playBeep(c.direction !== 'SELL')
    if (desktopRef.current) showDesktopNotification(title, body)
  }

  // Poll Zerodha connection state so we can prompt for the daily login.
  useEffect(() => {
    const load = () => getZerodhaStatus().then(setZerodha).catch(() => {})
    load()
    const id = setInterval(load, 30000)
    return () => clearInterval(id)
  }, [])

  const handleConnectZerodha = async () => {
    try {
      const { login_url, configured } = await getZerodhaLoginUrl()
      if (!configured) {
        setError('Zerodha not configured — add ZERODHA_API_KEY / ZERODHA_API_SECRET to .env and restart the backend.')
        return
      }
      window.location.href = login_url
    } catch {
      setError('Could not start Zerodha login.')
    }
  }

  // addSymbol appends a symbol to the comma-separated input if not present.
  const addSymbol = (sym: string) => {
    setSymbolsText((prev) => {
      const list = prev.split(',').map((s) => s.trim()).filter(Boolean)
      if (list.includes(sym)) return prev
      return [...list, sym].join(', ')
    })
  }

  // Symbols available to chart = whatever the engine is currently running.
  const chartSymbols = status?.symbols ?? []
  useEffect(() => {
    if (chartSymbols.length && !chartSymbols.includes(chartSymbol)) {
      setChartSymbol(chartSymbols[0])
    }
  }, [chartSymbols, chartSymbol])

  // Load strategy + mode metadata and current status once.
  useEffect(() => {
    getLiveStrategies()
      .then((r) => {
        const strats = r.strategies ?? []
        const md = r.modes ?? []
        setStrategies(strats)
        setModes(md)
        setDataSource(r.data_source ?? '')
        if (strats.length > 0) {
          setLiveStrategies((cur) => (cur.length ? cur : [strats[0].key]))
        }
      })
      .catch(() => setError('Could not load strategies — is the backend running?'))
    getLiveStatus().then(setStatus).catch(() => {})
  }, [])

  // Open the SSE stream once on mount; it replays recent calls automatically.
  // On each paper fill, refresh status immediately so paper_pnl stays current.
  useEffect(() => {
    const es = openLiveCallsStream((c) => {
      setCalls((prev) => [c, ...prev].slice(0, 200))
      announce(c)
      if (c.status === 'PAPER_FILLED') {
        getLiveStatus().then(setStatus).catch(() => {})
      }
    })
    esRef.current = es
    return () => es.close()
  }, [])

  // Poll status every 5 s while the engine is running so paper_pnl (and other
  // fields) stay up-to-date even between fills.
  useEffect(() => {
    if (!status?.running) return
    const id = setInterval(() => {
      getLiveStatus().then(setStatus).catch(() => {})
    }, 5000)
    return () => clearInterval(id)
  }, [status?.running])

  // Load persisted calls for the selected day whenever history view is active
  // or the chosen date changes.
  useEffect(() => {
    if (!showHistory) return
    let cancelled = false
    setHistoryLoading(true)
    getLiveCallsHistory(historyDate)
      .then((res) => { if (!cancelled) setHistoryCalls(res.calls ?? []) })
      .catch(() => { if (!cancelled) setHistoryCalls([]) })
      .finally(() => { if (!cancelled) setHistoryLoading(false) })
    return () => { cancelled = true }
  }, [showHistory, historyDate])

  // Run a quick historical backtest of the replay strategy over the symbol.
  const handleBacktest = async () => {
    if (!historySymbol || !replayStrategy) {
      setBacktestErr('Enter a symbol and pick a strategy first.')
      return
    }
    if (btMode === 'range' && (!btFrom || !btTo)) {
      setBacktestErr('Pick both a From and To date for a custom range.')
      return
    }
    const range =
      btMode === 'days'
        ? { days: btDays }
        : btMode === 'range'
          ? { from: btFrom, to: btTo }
          : {}
    setAppliedRange(range)
    setBacktesting(true)
    setBacktestErr('')
    setBacktest(null)
    try {
      const r = await runStrategyBacktest(historySymbol, replayStrategy, timeframe, range)
      if (r.available && r.result) setBacktest(r.result)
      else setBacktestErr(r.error ?? 'Backtest unavailable.')
    } catch {
      setBacktestErr('Backtest request failed.')
    } finally {
      setBacktesting(false)
    }
  }

  // Toggle a strategy in/out of the live consensus selection.
  const toggleStrategy = (key: string) => {
    setLiveStrategies((cur) =>
      cur.includes(key) ? cur.filter((k) => k !== key) : [...cur, key],
    )
  }

  // Keep the consensus threshold within [1, number of selected strategies].
  useEffect(() => {
    const n = liveStrategies.length
    setMinAgree((m) => Math.min(Math.max(1, m), Math.max(1, n)))
  }, [liveStrategies])

  const handleStart = async () => {
    setError(''); setBusy(true)
    try {
      const symbols = symbolsText.split(',').map((s) => s.trim()).filter(Boolean)
      const st = await startLive(
        liveStrategies,
        minAgree,
        mode,
        timeframe,
        symbols.length ? symbols : undefined,
      )
      setStatus(st)
      setCalls([])
    } catch (e: any) {
      setError(e?.response?.data?.error || 'Failed to start the live engine')
    } finally {
      setBusy(false)
    }
  }

  const handleStop = async () => {
    setBusy(true)
    try {
      await stopLive()
      const st = await getLiveStatus()
      setStatus(st)
    } finally {
      setBusy(false)
    }
  }

  const running = status?.running
  const selectedNames = (strategies ?? [])
    .filter((s) => liveStrategies.includes(s.key))
    .map((s) => s.name)
  const replayMeta = (strategies ?? []).find((s) => s.key === replayStrategy)

  return (
    <div className="max-w-screen-2xl mx-auto px-4 py-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold text-white">Live Strategy Trading</h1>
          <p className="text-sm text-slate-400">
            Streams live candles from Zerodha and fires the chosen strategy on each closed candle.
          </p>
        </div>
        <span className="text-xs px-3 py-1 rounded-full bg-slate-800 text-slate-300 border border-slate-700">
          Data source: <span className="text-brand-400 font-medium">{dataSource || '…'}</span>
        </span>
      </div>

      {/* Zerodha connection banner */}
      {zerodha && !zerodha.connected && (
        <div className="mb-6 px-4 py-3 rounded-lg bg-amber-900/25 border border-amber-700/50 text-sm text-amber-200 flex items-center justify-between gap-4">
          <span>
            {zerodha.configured
              ? 'Zerodha is not connected for today — live candles and orders need a fresh daily login.'
              : 'Zerodha API key not set. Add ZERODHA_API_KEY / ZERODHA_API_SECRET to .env and restart the backend.'}
          </span>
          {zerodha.configured && (
            <button
              onClick={handleConnectZerodha}
              className="shrink-0 bg-[#387ED1]/20 hover:bg-[#387ED1]/30 border border-[#387ED1]/40 text-[#7BB8F0] rounded-lg px-3 py-1.5 text-xs font-medium"
            >
              🔗 Connect Zerodha
            </button>
          )}
        </div>
      )}
      {zerodha?.connected && (
        <div className="mb-6 text-xs text-emerald-400/80">
          ● Zerodha connected{zerodha.token_date ? ` · token ${zerodha.token_date}` : ''}
          {zerodha.streaming ? ' · streaming' : ''}
        </div>
      )}

      {/* Controls */}
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-4 mb-6">
        <div className="relative">
          <label className="block text-xs text-slate-400 mb-1">
            Strategies ({liveStrategies.length} selected)
          </label>
          <button
            type="button"
            disabled={running}
            onClick={() => setStratMenuOpen((o) => !o)}
            className="w-full text-left bg-dark-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 disabled:opacity-50 flex items-center justify-between gap-2"
          >
            <span className="truncate">
              {selectedNames.length ? selectedNames.join(', ') : 'Select strategies…'}
            </span>
            <span className="text-slate-500">▾</span>
          </button>
          {stratMenuOpen && !running && (
            <div className="absolute z-20 mt-1 w-full bg-dark-800 border border-slate-700 rounded-lg shadow-xl max-h-72 overflow-auto">
              {strategies.map((s) => {
                const checked = liveStrategies.includes(s.key)
                return (
                  <div
                    key={s.key}
                    className="w-full px-3 py-2 text-sm hover:bg-slate-700/50 flex items-start gap-2"
                  >
                    <button
                      type="button"
                      onClick={() => toggleStrategy(s.key)}
                      className="flex flex-1 items-start gap-2 text-left"
                    >
                      <span className={`mt-0.5 ${checked ? 'text-brand-400' : 'text-slate-600'}`}>
                        {checked ? '☑' : '☐'}
                      </span>
                      <span>
                        <span className="text-slate-200">{s.name}</span>
                        {s.description && (
                          <span className="block text-[11px] text-slate-500">{s.description}</span>
                        )}
                      </span>
                    </button>
                    {s.configurable && (
                      <button
                        type="button"
                        title="Edit strategy config"
                        onClick={(e) => {
                          e.stopPropagation()
                          setEditingStrategy(s.key)
                          setStratMenuOpen(false)
                        }}
                        className="mt-0.5 shrink-0 text-slate-400 hover:text-brand-300"
                      >
                        ⚙
                      </button>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>

        <div>
          <label className="block text-xs text-slate-400 mb-1">
            Consensus (min agree)
          </label>
          <select
            value={minAgree}
            onChange={(e) => setMinAgree(Number(e.target.value))}
            disabled={running || liveStrategies.length === 0}
            className="w-full bg-dark-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 disabled:opacity-50"
            title="A call fires only when at least this many selected strategies agree on the same symbol + direction"
          >
            {Array.from({ length: Math.max(1, liveStrategies.length) }, (_, i) => i + 1).map((n) => (
              <option key={n} value={n}>
                {n} of {Math.max(1, liveStrategies.length)}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="block text-xs text-slate-400 mb-1">Mode</label>
          <select
            value={mode}
            onChange={(e) => setMode(e.target.value)}
            disabled={running}
            className="w-full bg-dark-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 disabled:opacity-50"
          >
            {modes.map((m) => (
              <option key={m.key} value={m.key}>{m.name}</option>
            ))}
          </select>
        </div>

        <div>
          <label className="block text-xs text-slate-400 mb-1">Timeframe</label>
          <select
            value={timeframe}
            onChange={(e) => setTimeframe(e.target.value)}
            disabled={running}
            className="w-full bg-dark-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 disabled:opacity-50"
          >
            {TIMEFRAMES.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
        </div>

        <div className="flex items-end">
          {running ? (
            <button
              onClick={handleStop}
              disabled={busy}
              className="w-full bg-red-600/80 hover:bg-red-600 text-white rounded-lg px-4 py-2 text-sm font-medium disabled:opacity-50"
            >
              Stop
            </button>
          ) : (
            <button
              onClick={handleStart}
              disabled={busy || liveStrategies.length === 0}
              className="w-full bg-brand-600 hover:bg-brand-500 text-white rounded-lg px-4 py-2 text-sm font-medium disabled:opacity-50"
            >
              Start
            </button>
          )}
        </div>
      </div>

      {/* Symbols input */}
      <div className="mb-6">
        <label className="block text-xs text-slate-400 mb-1">
          Symbols (comma-separated, Yahoo format — blank = all configured NSE symbols)
        </label>
        <input
          value={symbolsText}
          onChange={(e) => setSymbolsText(e.target.value)}
          disabled={running}
          placeholder="RELIANCE.NS, TCS.NS, INFY.NS"
          className="w-full bg-dark-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 disabled:opacity-50"
        />
        <div className="flex flex-wrap items-center gap-1.5 mt-2">
          <span className="text-[11px] text-slate-500">Add index:</span>
          {INDEX_QUICK_ADD.map((idx) => (
            <button
              key={idx.symbol}
              type="button"
              disabled={running}
              onClick={() => addSymbol(idx.symbol)}
              className="px-2 py-0.5 rounded-md text-[11px] bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-300 disabled:opacity-50"
              title={`Track ${idx.label} (with OI / derivatives)`}
            >
              {idx.label}
            </button>
          ))}
        </div>
      </div>

      {selectedNames.length > 0 && (
        <p className="text-sm text-slate-400 mb-4">
          Consensus: a call fires when at least <b className="text-slate-200">{minAgree}</b> of{' '}
          <b className="text-slate-200">{selectedNames.length}</b> selected strategies (
          {selectedNames.join(', ')}) agree on the same symbol and direction within a candle.
        </p>
      )}

      {mode === 'live' && (
        <div className="mb-4 px-4 py-3 rounded-lg bg-red-900/30 border border-red-700/50 text-sm text-red-300">
          Live mode places <b>real orders</b> on your Zerodha account (MIS / market). Use with caution.
        </div>
      )}

      {error && (
        <div className="mb-4 px-4 py-3 rounded-lg bg-red-900/30 border border-red-700/50 text-sm text-red-300">
          {error}
        </div>
      )}

      {/* Status bar */}
      <div className="flex flex-wrap items-center gap-4 mb-4 text-sm">
        <span className={`px-3 py-1 rounded-full ${running ? 'bg-emerald-600/20 text-emerald-400' : 'bg-slate-800 text-slate-400'}`}>
          {running ? '● Running' : '○ Stopped'}
        </span>
        {status?.mode === 'paper' && (
          <span className="text-slate-300">
            Paper P&L:{' '}
            <span className={(status.paper_pnl ?? 0) >= 0 ? 'text-emerald-400' : 'text-red-400'}>
              ₹{fmt(status.paper_pnl)}
            </span>
          </span>
        )}
        {running && status?.symbols && (
          <span className="text-slate-500">{status.symbols.length} symbols · {status.timeframe}</span>
        )}
        {running && status?.strategies && status.strategies.length > 0 && (
          <span className="text-slate-500">
            {status.strategies.length} strategies · consensus {status.min_agree ?? 1}/{status.strategies.length}
          </span>
        )}

        <div className="ml-auto flex items-center gap-3">
          <label className="flex items-center gap-1.5 text-slate-400 cursor-pointer">
            <input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} className="accent-brand-500" />
            🔔 Alerts + sound
          </label>
          <button
            onClick={toggleDesktop}
            className={`px-2 py-1 rounded-lg text-xs border ${desktopNotify ? 'bg-emerald-600/20 text-emerald-400 border-emerald-700/40' : 'bg-slate-800 text-slate-400 border-slate-700'}`}
          >
            {desktopNotify ? '🖥 Desktop on' : '🖥 Enable desktop'}
          </button>
        </div>
      </div>

      {/* Live chart + pattern picker */}
      {running && chartSymbols.length > 0 && (
        <div className="mb-6">
          <div className="flex items-center gap-2 mb-3">
            <label className="text-xs text-slate-400">Chart symbol</label>
            <select
              value={chartSymbol}
              onChange={(e) => setChartSymbol(e.target.value)}
              className="bg-dark-800 border border-slate-700 rounded-lg px-3 py-1.5 text-sm text-slate-200"
            >
              {chartSymbols.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </div>
          {chartSymbol && <LiveChart symbol={chartSymbol} running={running} />}
          {chartSymbol && (
            <div className="mt-4">
              <OIPanel symbol={chartSymbol} running={running} />
            </div>
          )}
        </div>
      )}

      {/* Historical replay — always available, independent of engine state */}
      {(
        <div className="mb-6 border-t border-slate-800 pt-6">
          <div className="flex flex-wrap items-center gap-2 mb-3">
            <span className="text-xs text-amber-400/80">Historical replay — view last session &amp; replay a strategy</span>
            <input
              value={historySymbol}
              onChange={(e) => setHistorySymbol(e.target.value.trim())}
              placeholder="Symbol (e.g. RELIANCE.NS or ^NSEI)"
              className="bg-dark-800 border border-slate-700 rounded-lg px-3 py-1.5 text-sm text-slate-200 w-64"
            />
            <select
              value={replayStrategy}
              onChange={(e) => setReplayStrategy(e.target.value)}
              className="bg-dark-800 border border-slate-700 rounded-lg px-3 py-1.5 text-sm text-slate-200"
              title="Strategy to replay over the last session"
            >
              <option value="">Patterns only (no replay)</option>
              {strategies.map((s) => (
                <option key={s.key} value={s.key}>{s.name}</option>
              ))}
            </select>
            <select
              value={timeframe}
              onChange={(e) => setTimeframe(e.target.value)}
              className="bg-dark-800 border border-slate-700 rounded-lg px-3 py-1.5 text-sm text-slate-200"
              title="Candle timeframe"
            >
              {TIMEFRAMES.map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
            <span className="text-xs text-slate-500">
              {replayStrategy ? `replaying ${replayMeta?.name ?? replayStrategy} · ${timeframe}` : `patterns only · ${timeframe}`}
            </span>
            <select
              value={btMode}
              onChange={(e) => setBtMode(e.target.value as 'recent' | 'days' | 'range')}
              className="bg-dark-800 border border-slate-700 rounded-lg px-3 py-1.5 text-sm text-slate-200"
              title="Historical data window for the backtest"
            >
              <option value="recent">Recent (auto)</option>
              <option value="days">Last N days</option>
              <option value="range">Custom range</option>
            </select>
            {btMode === 'days' && (
              <select
                value={btDays}
                onChange={(e) => setBtDays(Number(e.target.value))}
                className="bg-dark-800 border border-slate-700 rounded-lg px-3 py-1.5 text-sm text-slate-200"
                title="Lookback (trading sessions pulled from Zerodha)"
              >
                {[1, 3, 5, 10, 15, 30, 60, 90, 120, 180].map((d) => (
                  <option key={d} value={d}>{d}d</option>
                ))}
              </select>
            )}
            {btMode === 'range' && (
              <>
                <input
                  type="date"
                  value={btFrom}
                  onChange={(e) => setBtFrom(e.target.value)}
                  className="bg-dark-800 border border-slate-700 rounded-lg px-2 py-1.5 text-sm text-slate-200"
                  title="From date (fetched from Zerodha Kite history)"
                />
                <span className="text-xs text-slate-500">→</span>
                <input
                  type="date"
                  value={btTo}
                  onChange={(e) => setBtTo(e.target.value)}
                  className="bg-dark-800 border border-slate-700 rounded-lg px-2 py-1.5 text-sm text-slate-200"
                  title="To date (fetched from Zerodha Kite history)"
                />
              </>
            )}
            <button
              onClick={handleBacktest}
              disabled={backtesting || !historySymbol || !replayStrategy}
              className="bg-amber-600/80 hover:bg-amber-600 text-white rounded-lg px-3 py-1.5 text-sm font-medium disabled:opacity-50"
              title="Backtest the selected strategy over the chosen window"
            >
              {backtesting ? 'Backtesting…' : 'Backtest'}
            </button>
            {running ? (
              <button
                onClick={handleStop}
                disabled={busy}
                className="ml-auto bg-red-600/80 hover:bg-red-600 text-white rounded-lg px-4 py-1.5 text-sm font-medium disabled:opacity-50"
                title="Stop the live engine"
              >
                ■ Stop engine
              </button>
            ) : (
              <button
                onClick={handleStart}
                disabled={busy || liveStrategies.length === 0}
                className="ml-auto bg-brand-600 hover:bg-brand-500 text-white rounded-lg px-4 py-1.5 text-sm font-medium disabled:opacity-50"
                title={liveStrategies.length ? 'Start the live engine with the selected strategies' : 'Select strategies first (top controls)'}
              >
                ▶ Start engine
              </button>
            )}
          </div>

          {backtestErr && <div className="mb-3 text-sm text-red-400">{backtestErr}</div>}
          {backtest && (
            <div className="mb-4 rounded-xl border border-slate-800 bg-dark-800 p-4">
              <div className="mb-3 flex flex-wrap items-baseline gap-x-6 gap-y-1 text-sm">
                <span className="font-semibold text-white">
                  Backtest · {backtest.strategy} · {backtest.symbol} · {backtest.interval}
                </span>
                <span className="text-slate-400">Trades: <b className="text-slate-200">{backtest.num_trades}</b></span>
                <span className="text-slate-400">Win rate: <b className="text-slate-200">{backtest.win_rate.toFixed(1)}%</b></span>
                <span className="text-slate-400">
                  Net points: <b className={backtest.net_points >= 0 ? 'text-emerald-400' : 'text-red-400'}>{backtest.net_points.toFixed(1)}</b>
                </span>
                <span className="text-slate-400">Profit factor: <b className="text-slate-200">{backtest.profit_factor.toFixed(2)}</b></span>
                <span className="text-slate-400">Avg/trade: <b className="text-slate-200">{backtest.avg_points.toFixed(1)}</b></span>
              </div>
              <p className="mb-2 text-[11px] text-slate-500">
                P&amp;L in underlying points (directional proxy). Each signal exits at its target or stop, else at session close.
              </p>
              {(backtest.trades?.length ?? 0) === 0 && (
                <p className="text-sm text-slate-400">
                  No trades — the strategy produced no signals over this session. Try a different symbol/timeframe, or relax the strategy config.
                </p>
              )}
              {(backtest.trades?.length ?? 0) > 0 && (
                <div className="max-h-64 overflow-auto">
                  <table className="w-full text-xs">
                    <thead className="text-slate-500">
                      <tr className="text-left">
                        <th className="px-2 py-1">Entry</th>
                        <th className="px-2 py-1">Dir</th>
                        <th className="px-2 py-1">Leg</th>
                        <th className="px-2 py-1">In</th>
                        <th className="px-2 py-1">Out</th>
                        <th className="px-2 py-1">Exit</th>
                        <th className="px-2 py-1">Points</th>
                      </tr>
                    </thead>
                    <tbody>
                      {backtest.trades.map((t, idx) => (
                        <tr key={idx} className="border-t border-slate-800">
                          <td className="px-2 py-1 text-slate-400">{new Date(t.entry_time * 1000).toLocaleString()}</td>
                          <td className="px-2 py-1">{t.direction}</td>
                          <td className="px-2 py-1 text-slate-300">
                            {t.option_type ? `${t.option_action} ${t.strike} ${t.option_type}` : '—'}
                          </td>
                          <td className="px-2 py-1">{fmt(t.entry)}</td>
                          <td className="px-2 py-1">{fmt(t.exit)}</td>
                          <td className="px-2 py-1 text-slate-400">{t.exit_reason}</td>
                          <td className={`px-2 py-1 font-medium ${t.pnl_points >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                            {t.pnl_points.toFixed(1)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {historySymbol && (
            <LiveChart
              symbol={historySymbol}
              running={false}
              history
              timeframe={timeframe}
              strategy={replayStrategy}
              range={appliedRange}
            />
          )}
        </div>
      )}

      {/* Calls feed */}
      {(() => {
        // Newest-first rows from either the live SSE feed or the persisted
        // day history. Both shapes share the same display fields; history rows
        // carry called_at instead of timestamp.
        type Row = {
          ts: string; symbol: string; direction: string; price: number
          target: number; stop_loss: number; confidence: number
          status: string; reason: string; error?: string; paper_pnl?: number
        }
        const rows: Row[] = showHistory
          ? [...historyCalls]
              .reverse()
              .map((c) => ({
                ts: c.called_at, symbol: c.symbol, direction: c.direction,
                price: c.price, target: c.target, stop_loss: c.stop_loss,
                confidence: c.confidence, status: c.status, reason: c.reason,
                error: c.error, paper_pnl: c.paper_pnl,
              }))
          : calls.map((c) => ({
              ts: c.timestamp, symbol: c.symbol, direction: c.direction,
              price: c.price, target: c.target, stop_loss: c.stop_loss,
              confidence: c.confidence, status: c.status, reason: c.reason,
              error: c.error, paper_pnl: c.paper_pnl,
            }))
        return (
          <div className="bg-dark-800 border border-slate-800 rounded-xl overflow-hidden">
            <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-slate-800 bg-slate-800/30">
              <div className="inline-flex rounded-lg overflow-hidden border border-slate-700">
                <button
                  className={`px-3 py-1.5 text-xs font-medium ${!showHistory ? 'bg-sky-600 text-white' : 'text-slate-400 hover:text-slate-200'}`}
                  onClick={() => setShowHistory(false)}
                >
                  Live feed
                </button>
                <button
                  className={`px-3 py-1.5 text-xs font-medium ${showHistory ? 'bg-sky-600 text-white' : 'text-slate-400 hover:text-slate-200'}`}
                  onClick={() => setShowHistory(true)}
                >
                  By day
                </button>
              </div>
              {showHistory && (
                <div className="flex items-center gap-2 text-xs text-slate-400">
                  {historyLoading && <span>Loading…</span>}
                  <span>{rows.length} call{rows.length === 1 ? '' : 's'}</span>
                  <input
                    type="date"
                    value={historyDate}
                    max={localDateStr()}
                    onChange={(e) => setHistoryDate(e.target.value)}
                    className="bg-dark-900 border border-slate-700 rounded px-2 py-1 text-slate-200"
                  />
                </div>
              )}
            </div>
            <table className="w-full text-sm">
              <thead className="bg-slate-800/50 text-slate-400 text-xs uppercase">
                <tr>
                  <th className="text-left px-4 py-3">Time</th>
                  <th className="text-left px-4 py-3">Symbol</th>
                  <th className="text-left px-4 py-3">Side</th>
                  <th className="text-right px-4 py-3">Price</th>
                  <th className="text-right px-4 py-3">Target</th>
                  <th className="text-right px-4 py-3">Stop</th>
                  <th className="text-right px-4 py-3">Conf</th>
                  <th className="text-left px-4 py-3">Status</th>
                  {status?.mode === 'paper' && <th className="text-right px-4 py-3">P&amp;L</th>}
                  <th className="text-left px-4 py-3">Reason</th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 ? (
                  <tr>
                    <td colSpan={status?.mode === 'paper' ? 10 : 9} className="px-4 py-10 text-center text-slate-500">
                      {showHistory
                        ? 'No calls recorded on this day.'
                        : 'No calls yet. Start the engine — calls appear as candles close.'}
                    </td>
                  </tr>
                ) : (
                  rows.map((c, i) => (
                    <tr key={`${c.ts}-${c.symbol}-${i}`} className="border-t border-slate-800/60">
                      <td className="px-4 py-2 text-slate-500">{new Date(c.ts).toLocaleTimeString()}</td>
                      <td className="px-4 py-2 text-slate-200 font-medium">{c.symbol}</td>
                      <td className={`px-4 py-2 font-medium ${c.direction === 'BUY' ? 'text-emerald-400' : 'text-red-400'}`}>
                        {c.direction}
                      </td>
                      <td className="px-4 py-2 text-right text-slate-300">{fmt(c.price)}</td>
                      <td className="px-4 py-2 text-right text-slate-400">{fmt(c.target)}</td>
                      <td className="px-4 py-2 text-right text-slate-400">{fmt(c.stop_loss)}</td>
                      <td className="px-4 py-2 text-right text-slate-400">{fmt(c.confidence, 0)}%</td>
                      <td className={`px-4 py-2 ${statusColor(c.status)}`}>
                        {c.status}
                        {c.error ? <span className="text-red-400/70 ml-1">({c.error})</span> : ''}
                      </td>
                      {status?.mode === 'paper' && (
                        <td className={`px-4 py-2 text-right font-medium ${
                          c.paper_pnl == null || c.paper_pnl === 0
                            ? 'text-slate-500'
                            : c.paper_pnl > 0 ? 'text-emerald-400' : 'text-red-400'
                        }`}>
                          {c.paper_pnl != null && c.paper_pnl !== 0 ? `₹${fmt(c.paper_pnl)}` : '—'}
                        </td>
                      )}
                      <td className="px-4 py-2 text-slate-500">{c.reason}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        )
      })()}

      {editingStrategy && (
        <StrategyEditor
          strategyKey={editingStrategy}
          onClose={() => setEditingStrategy(null)}
        />
      )}
    </div>
  )
}
