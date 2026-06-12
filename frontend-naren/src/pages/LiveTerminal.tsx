import { useState, useEffect, useRef, useCallback, useMemo } from 'react'

// ─── Types ────────────────────────────────────────────────────────────────────

interface FilterResult { pass: boolean; value: string; reason: string }
interface FilterState {
  tech_signal: FilterResult; pcr_filter: FilterResult
  real_ltp: FilterResult; all_passed: boolean
}
interface LiveOptionState {
  trading_symbol: string; strike: number; option_type: string; expiry: string
  entry_premium: number; current_premium: number; premium_change: number
  pnl: number; pnl_pct: number; sl_premium: number; target_premium: number
  price_history: number[]; entry_spot: number; dte: number
}
interface OpenTrade {
  id: string; strategy: string; direction: string; regime: string
  signal_basis: string[]; mode: string
  trading_symbol: string; expiry: string; strike: number; option_type: string
  lots: number; qty: number; dte: number
  entry_time: string; entry_spot: number; entry_premium: number
  entry_iv: number; entry_pcr: number; entry_oi: number
  entry_snapshot: { pcr: number; call_oi: number; put_oi: number; iv: number; atm_call_ltp: number; atm_put_ltp: number }
}
interface ChainStrike { Strike: number; CELTP: number; PELTP: number; CEOI: number; PEOI: number }
interface ChainSnap {
  Spot: number; ATM: number; Strikes: ChainStrike[]
  TotalCallOI: number; TotalPutOI: number; PCR: number
  ATMCallLTP: number; ATMPutLTP: number
}
interface Signal {
  strategy: string; direction: string; regime: string; confidence: number
  reasoning: string[]; indicators: {
    spot: number; ema9: number; ema21: number; atr14: number
    trend_strength: number; or_high: number; or_low: number; day_change_pct: number
  }
}
interface LiveState {
  spot: number; signal?: Signal; chain?: ChainSnap; filters: FilterState
  open_option?: LiveOptionState; open_trade?: OpenTrade
  active?: { initial_capital: number; lots: number; risk_per_trade: number; target_per_trade: number }
  day_number: number; total_pnl: number; today_pnl: number; win_rate: number
  last_error: string; ticker_live: boolean
}
interface ChartBar {
  time: string; open: number; high: number; low: number; close: number; volume: number
  ema9: number; ema21: number; strategy: string; direction: string
  regime: string; confidence: number; is_signal: boolean; pcr_pass: boolean; is_entry: boolean
  is_position_entry: boolean  // marks the actual open trade entry bar
  entry_premium: number       // option premium at entry (for chart annotation)
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const fmt  = (n: number) => new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(Math.abs(n))
const fmtF = (n: number, d = 1) => (n ?? 0).toFixed(d)
const sgn  = (n: number) => n >= 0 ? '+' : '-'
const pc   = (n: number) => n >= 0 ? 'text-emerald-400' : 'text-red-400'

const STRAT: Record<string, string> = {
  DIRECTIONAL_CE: 'Buy CE', DIRECTIONAL_PE: 'Buy PE',
  ORB_CE: 'ORB CE', ORB_PE: 'ORB PE', SUPERTREND: 'SuperTrend',
  EMA_CROSS: 'EMA Cross', ATR_MOMENTUM: 'ATR Break', VWAP: 'VWAP',
  IRON_CONDOR: 'Iron Condor', IRON_FLY: 'Iron Fly', SHORT_STRADDLE: 'Straddle',
  NO_TRADE: 'No Trade',
}

// ─── SECTION A — Open Position Card (shows WHY the trade was taken) ──────────

function OpenPositionCard({ opt, trade, active }: {
  opt: LiveOptionState; trade?: OpenTrade; active: any
}) {
  const riskAmt   = active?.risk_per_trade ?? 5000
  const targetAmt = active?.target_per_trade ?? 10000
  const pct       = Math.max(0, Math.min(100,
    ((opt.pnl - (-riskAmt)) / (targetAmt - (-riskAmt))) * 100
  ))
  const col  = opt.pnl >= 0 ? '#34d399' : '#f87171'
  const hist = opt.price_history || []
  const spark = useMemo(() => {
    if (hist.length < 2) return ''
    const w = 300, h = 50, pad = 4
    const minV = Math.min(...hist), maxV = Math.max(...hist), range = maxV - minV || 1
    return hist.map((v, i) =>
      `${i === 0 ? 'M' : 'L'}${pad + (i/(hist.length-1))*(w-2*pad)},${h-pad-((v-minV)/range)*(h-2*pad)}`
    ).join(' ')
  }, [hist])

  const entryTime = trade?.entry_time ? new Date(trade.entry_time).toLocaleString('en-IN', {
    day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit'
  }) : '—'

  return (
    <div className="bg-slate-900 border-2 border-blue-500/50 rounded-2xl overflow-hidden">
      {/* Header — what was entered */}
      <div className="bg-blue-500/10 px-5 py-3 border-b border-blue-500/30 flex items-center justify-between">
        <div>
          <span className="text-xs text-blue-300 font-semibold uppercase tracking-wide">
            ● Active Paper Position
          </span>
          <div className="flex items-center gap-3 mt-0.5">
            <span className="text-xl font-bold text-slate-100 font-mono">{opt.trading_symbol}</span>
            <span className={`text-xs px-2 py-0.5 rounded font-bold ${
              trade?.direction === 'BULLISH' ? 'bg-emerald-500/20 text-emerald-300'
              : 'bg-red-500/20 text-red-300'}`}>
              {trade?.direction}
            </span>
            <span className="text-xs text-slate-400">{STRAT[trade?.strategy ?? ''] || trade?.strategy}</span>
          </div>
        </div>
        <div className="text-right">
          {opt.current_premium === 0 ? (
            <p className="text-slate-400 animate-pulse">Fetching live price…</p>
          ) : (
            <>
              <p className={`text-3xl font-bold ${pc(opt.pnl)}`}>{sgn(opt.pnl)}₹{fmt(opt.pnl)}</p>
              <p className={`text-xs ${pc(opt.pnl_pct)}`}>{sgn(opt.pnl_pct)}{fmtF(Math.abs(opt.pnl_pct))}% of risk</p>
            </>
          )}
        </div>
      </div>

      <div className="p-5 grid grid-cols-1 lg:grid-cols-2 gap-5">
        {/* Left: price + gauge */}
        <div className="space-y-4">
          {/* SL ↔ Target gauge */}
          <div>
            <div className="flex justify-between text-[10px] mb-1">
              <span className="text-red-400">SL ₹{opt.sl_premium.toFixed(1)}</span>
              <span className="text-slate-400">Entry ₹{opt.entry_premium.toFixed(1)}</span>
              <span className="text-emerald-400">Target ₹{opt.target_premium.toFixed(1)}</span>
            </div>
            <div className="relative h-3 bg-gradient-to-r from-red-500/40 via-slate-700 to-emerald-500/40 rounded-full">
              <div className="absolute top-1/2 -translate-y-1/2 w-2.5 h-5 rounded shadow-lg transition-all duration-300"
                style={{ left: `calc(${pct}% - 5px)`, background: col }} />
            </div>
          </div>

          {/* Price grid */}
          <div className="grid grid-cols-3 gap-2 text-xs">
            <div className="bg-slate-800 rounded-lg p-2.5 text-center">
              <p className="text-slate-500 text-[10px]">Entry ₹</p>
              <p className="font-mono font-bold text-slate-200">₹{opt.entry_premium.toFixed(1)}</p>
              <p className="text-[10px] text-slate-500">@ {entryTime}</p>
            </div>
            <div className={`rounded-lg p-2.5 text-center border ${
              opt.current_premium === 0 ? 'bg-slate-800 border-slate-700'
              : opt.premium_change >= 0 ? 'bg-emerald-500/10 border-emerald-500/40'
              : 'bg-red-500/10 border-red-500/40'}`}>
              <p className="text-slate-500 text-[10px]">Current LTP</p>
              {opt.current_premium === 0
                ? <p className="text-slate-400 animate-pulse font-semibold">…</p>
                : <>
                    <p className={`font-mono font-bold text-base ${pc(opt.premium_change)}`}>₹{opt.current_premium.toFixed(1)}</p>
                    <p className={`text-[10px] ${pc(opt.premium_change)}`}>{sgn(opt.premium_change)}₹{Math.abs(opt.premium_change).toFixed(1)}</p>
                  </>}
            </div>
            <div className="bg-slate-800 rounded-lg p-2.5 text-center">
              <p className="text-slate-500 text-[10px]">DTE · Qty</p>
              <p className="font-bold text-slate-200">{opt.dte}d</p>
              <p className="text-[10px] text-slate-500">{trade?.qty ?? 150} qty</p>
            </div>
          </div>

          {/* Sparkline */}
          {spark ? (
            <div>
              <p className="text-[10px] text-slate-500 mb-1">Live price history ({hist.length} WebSocket ticks)</p>
              <div className="bg-slate-800 rounded-lg overflow-hidden">
                <svg width="100%" height="50" viewBox="0 0 300 50" preserveAspectRatio="none">
                  <path d={spark} fill="none" stroke={col} strokeWidth="1.5"/>
                  {hist.length > 0 && (() => {
                    const minV = Math.min(...hist), maxV = Math.max(...hist), range = maxV - minV || 1
                    const cy = 50 - 4 - ((hist[hist.length-1]-minV)/range)*42
                    return <circle cx={296} cy={cy} r="3" fill={col}/>
                  })()}
                </svg>
              </div>
            </div>
          ) : (
            <div className="text-xs text-blue-400 text-center py-2 bg-slate-800 rounded-lg">
              ⚡ Waiting for WebSocket ticks — sparkline appears on first price update
            </div>
          )}
        </div>

        {/* Right: WHY the trade was taken */}
        <div className="space-y-3">
          <div className="bg-slate-800/60 rounded-xl p-4 border border-slate-700/50">
            <p className="text-xs font-semibold text-slate-300 uppercase tracking-wide mb-3">
              Why This Trade Was Entered
            </p>

            {/* Signal basis */}
            {trade?.signal_basis?.length ? (
              <div className="mb-3">
                <p className="text-[10px] text-slate-500 mb-1.5">Signal Logic</p>
                {trade.signal_basis.map((r, i) => (
                  <div key={i} className="flex gap-2 text-xs text-slate-300 mb-1">
                    <span className="text-blue-400 shrink-0 mt-0.5">›</span>{r}
                  </div>
                ))}
              </div>
            ) : null}

            {/* Entry indicators */}
            <div className="grid grid-cols-2 gap-1.5 text-xs">
              {[
                ['Entry Spot',   opt.entry_spot?.toFixed(0)],
                ['Entry Time',   entryTime],
                ['Entry IV',     `${trade?.entry_iv?.toFixed(1)}%`],
                ['Entry PCR',    trade?.entry_pcr?.toFixed(3)],
                ['Strategy',     STRAT[trade?.strategy ?? ''] || trade?.strategy],
                ['Direction',    trade?.direction],
              ].map(([k, v]) => (
                <div key={k} className="bg-slate-700/40 rounded p-1.5">
                  <p className="text-slate-500 text-[9px]">{k}</p>
                  <p className="text-slate-200 font-semibold text-[11px]">{v}</p>
                </div>
              ))}
            </div>

            {/* PCR at entry */}
            {trade?.entry_snapshot && (
              <div className="mt-3 pt-3 border-t border-slate-700/40">
                <p className="text-[10px] text-slate-500 mb-1.5">Option Chain at Entry</p>
                <div className="grid grid-cols-3 gap-1.5 text-[10px]">
                  {[
                    ['ATM CE', `₹${trade.entry_snapshot.atm_call_ltp?.toFixed(1)}`],
                    ['ATM PE', `₹${trade.entry_snapshot.atm_put_ltp?.toFixed(1)}`],
                    ['PCR',    trade.entry_snapshot.pcr?.toFixed(3)],
                  ].map(([k, v]) => (
                    <div key={k} className="text-center">
                      <p className="text-slate-500">{k}</p>
                      <p className="text-slate-300 font-semibold">{v}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* 3 gates passed at entry */}
          <div className="bg-emerald-500/8 border border-emerald-500/25 rounded-xl p-3 text-xs">
            <p className="text-emerald-300 font-semibold mb-2">✅ All 3 gates passed at entry time</p>
            <div className="space-y-1 text-slate-400">
              <p><span className="text-slate-300">①</span> 15m signal fired · {STRAT[trade?.strategy??'']||trade?.strategy} · {trade?.direction}</p>
              <p><span className="text-slate-300">②</span> PCR {trade?.entry_pcr?.toFixed(3)} — contrarian bias aligned</p>
              <p><span className="text-slate-300">③</span> Real Kite LTP: ₹{opt.entry_premium.toFixed(1)} at fill</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── SECTION B — Next Trade Gates (shown when no position is open) ───────────

function NextTradeGates({ filters, hasPosition }: { filters: FilterState; hasPosition: boolean }) {
  const gates = [
    { label: '①  15m Technical', key: 'tech_signal', f: filters.tech_signal,
      desc: 'EMA9/21 + ATR + ORB + SuperTrend · confidence ≥ 55%' },
    { label: '②  PCR Contrarian', key: 'pcr_filter', f: filters.pcr_filter,
      desc: 'PCR >1.2 = bullish · PCR <0.8 = bearish · contrarian interpretation' },
    { label: '③  Real Kite LTP', key: 'real_ltp', f: filters.real_ltp,
      desc: 'Actual NSE option price at fill time — no Black-Scholes' },
  ]
  return (
    <div className={`bg-slate-800/70 rounded-xl border rounded-xl overflow-hidden ${
      hasPosition ? 'border-slate-700/30 opacity-60' : 'border-slate-700/50'}`}>
      <div className="px-5 py-3 border-b border-slate-700/50 flex items-center justify-between bg-slate-800/40">
        <div>
          <h3 className="text-sm font-semibold text-slate-200">
            {hasPosition ? '🔒 Next Trade Gates (locked — position is open)' : 'Entry Gates for Next Trade'}
          </h3>
          <p className="text-[10px] text-slate-500 mt-0.5">
            {hasPosition
              ? 'No new trade will be entered until current position is closed'
              : 'All 3 must pass simultaneously to trigger a paper trade'}
          </p>
        </div>
        {!hasPosition && (
          <div className={`text-xs font-bold px-3 py-1 rounded-full ${
            filters.all_passed
              ? 'bg-emerald-500/20 text-emerald-300 animate-pulse border border-emerald-500/40'
              : 'bg-slate-700 text-slate-400'}`}>
            {filters.all_passed ? '✅ SIGNAL READY' : '⏳ Waiting…'}
          </div>
        )}
      </div>

      <div className="p-4 space-y-2">
        {gates.map(g => (
          <div key={g.key} className={`flex items-start gap-3 p-3 rounded-lg border transition-all ${
            hasPosition ? 'bg-slate-800/40 border-slate-700/20'
            : g.f.pass ? 'bg-emerald-500/8 border-emerald-500/30'
            : 'bg-slate-700/30 border-slate-600/20'}`}>
            <span className={`text-lg mt-0.5 ${!hasPosition && g.f.pass ? 'text-emerald-400' : 'text-slate-600'}`}>
              {!hasPosition && g.f.pass ? '✅' : '⬜'}
            </span>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-sm font-semibold text-slate-200">{g.label}</span>
                <span className={`text-xs font-mono px-2 py-0.5 rounded ${
                  !hasPosition && g.f.pass
                    ? 'bg-emerald-500/15 text-emerald-300'
                    : 'bg-slate-700 text-slate-400'}`}>
                  {g.f.value}
                </span>
              </div>
              <p className="text-xs text-slate-500 mt-0.5">{g.f.reason}</p>
              <p className="text-[10px] text-slate-600 mt-0.5">{g.desc}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

// ─── PCR Gauge ────────────────────────────────────────────────────────────────

function PCRGauge({ chain }: { chain?: ChainSnap }) {
  if (!chain) return (
    <div className="bg-slate-800/60 rounded-xl border border-slate-700/50 p-4 text-center text-slate-500 text-xs">
      PCR unavailable (market closed or no OI data yet)
    </div>
  )
  const pcr  = chain.PCR || 0
  const pct  = Math.min(100, Math.max(0, (pcr / 2) * 100))
  const bias = pcr > 1.3 ? 'STRONG BULLISH' : pcr > 1.1 ? 'MILDLY BULLISH' :
               pcr < 0.7 ? 'STRONG BEARISH' : pcr < 0.85 ? 'MILDLY BEARISH' : 'NEUTRAL'
  const bCol = bias.includes('BULLISH') ? '#34d399' : bias.includes('BEARISH') ? '#f87171' : '#94a3b8'

  return (
    <div className="bg-slate-800/70 rounded-xl border border-slate-700/50 p-4">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-sm font-semibold text-slate-200">Live PCR</h3>
        <span className="text-xs text-slate-400">Put OI ÷ Call OI</span>
      </div>
      <div className="relative h-3.5 bg-gradient-to-r from-red-500/30 via-slate-700 to-emerald-500/30 rounded-full mb-1.5">
        <div className="absolute top-0 bottom-0 w-0.5 bg-slate-500/50" style={{ left: '50%' }} />
        <div className="absolute top-1/2 -translate-y-1/2 w-3.5 h-3.5 rounded-full shadow-lg border-2 border-slate-900 transition-all"
          style={{ left: `calc(${pct}% - 7px)`, background: bCol }} />
      </div>
      <div className="flex justify-between text-[9px] text-slate-600 mb-3">
        <span>Bearish (0)</span><span>1.0</span><span>Bullish (2+)</span>
      </div>
      <div className="flex items-center gap-3">
        <div className="bg-slate-700/50 rounded-lg px-3 py-2 text-center">
          <p className="text-[10px] text-slate-500">PCR</p>
          <p className="font-bold text-slate-100 text-lg">{fmtF(pcr, 3)}</p>
        </div>
        <div>
          <p className="font-bold text-sm" style={{ color: bCol }}>{bias}</p>
          <p className="text-[10px] text-slate-500 mt-0.5">
            {bias.includes('BULLISH') ? 'Extreme put buying → market likely to bounce (contrarian)' :
             bias.includes('BEARISH') ? 'Extreme call buying → market likely to fall (contrarian)' :
             'Balanced OI — no directional PCR edge'}
          </p>
        </div>
      </div>
      <div className="mt-3 grid grid-cols-4 gap-1.5 text-[10px]">
        {[
          ['Call OI', ((chain.TotalCallOI||0)/1e7).toFixed(1)+'Cr', 'text-blue-300'],
          ['Put OI',  ((chain.TotalPutOI||0)/1e7).toFixed(1)+'Cr',  'text-purple-300'],
          ['ATM CE', `₹${fmtF(chain.ATMCallLTP)}`, 'text-blue-300'],
          ['ATM PE', `₹${fmtF(chain.ATMPutLTP)}`,  'text-purple-300'],
        ].map(([k, v, c]) => (
          <div key={k} className="bg-slate-700/40 rounded p-1.5 text-center">
            <p className="text-slate-500">{k}</p>
            <p className={`font-semibold ${c}`}>{v}</p>
          </div>
        ))}
      </div>
    </div>
  )
}

// ─── Current Market Signal card ───────────────────────────────────────────────

function CurrentSignalCard({ sig, spot, hasPosition }: { sig?: Signal; spot: number; hasPosition: boolean }) {
  const isNoTrade = !sig || sig.strategy === 'NO_TRADE'
  return (
    <div className="bg-slate-800/70 rounded-xl border border-slate-700/50 p-4">
      <div className="flex items-center justify-between gap-2 mb-3 flex-wrap">
        <h3 className="text-sm font-semibold text-slate-200">Current Market Signal</h3>
        {hasPosition && (
          <span className="text-[10px] bg-amber-500/15 text-amber-300 border border-amber-500/30 px-2 py-0.5 rounded-full">
            Monitoring · No new entry while position is open
          </span>
        )}
      </div>

      {/* Explain "No Trade" when position is open — critical for clarity */}
      {hasPosition && isNoTrade && (
        <div className="mb-3 bg-blue-500/10 border border-blue-500/25 rounded-lg px-3 py-2.5">
          <p className="text-blue-300 text-xs font-semibold mb-1">ℹ️ "No Trade" ≠ No Position</p>
          <p className="text-slate-400 text-[11px] leading-relaxed">
            The <strong className="text-slate-300">current signal</strong> says no new setup is forming right now
            (market is range-bound). This is <strong className="text-slate-300">separate</strong> from your
            open position which was entered earlier when all 3 gates passed.
            Your position stays open until SL, target, or EOD.
          </p>
        </div>
      )}

      {!sig ? (
        <div className="text-center py-3 text-slate-400 text-sm">
          <p className="text-xl mb-2">📡</p>
          <p>Waiting for signal — analysis runs every 2 min</p>
        </div>
      ) : (
        <>
          <div className="flex items-center gap-3 mb-3 flex-wrap">
            <span className="text-lg font-bold text-slate-100">{STRAT[sig.strategy] || sig.strategy}</span>
            <span className={`text-xs px-2 py-0.5 rounded font-bold border ${
              sig.direction === 'BULLISH' ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30'
              : sig.direction === 'BEARISH' ? 'bg-red-500/15 text-red-300 border-red-500/30'
              : 'bg-slate-700 text-slate-300 border-slate-600'}`}>{sig.direction}</span>
            <span className="text-xs text-slate-400">{sig.regime?.replace(/_/g, ' ')}</span>
          </div>

          <div className="flex justify-between text-xs mb-1">
            <span className="text-slate-400">Confidence</span>
            <span className={`font-bold ${sig.confidence >= 65 ? 'text-emerald-400' : sig.confidence >= 50 ? 'text-yellow-400' : 'text-red-400'}`}>
              {sig.confidence}%
            </span>
          </div>
          <div className="h-1.5 bg-slate-700 rounded-full mb-3 overflow-hidden">
            <div className={`h-full rounded-full ${sig.confidence >= 65 ? 'bg-emerald-500' : sig.confidence >= 50 ? 'bg-yellow-500' : 'bg-red-500'}`}
              style={{ width: `${sig.confidence}%` }} />
          </div>

          <div className="grid grid-cols-4 gap-1 text-[10px] mb-3">
            {[
              ['Spot', spot?.toFixed(0)],
              ['EMA9', sig.indicators?.ema9?.toFixed(0)],
              ['EMA21', sig.indicators?.ema21?.toFixed(0)],
              ['ATR', sig.indicators?.atr14?.toFixed(0)],
              ['Trend', `${sig.indicators?.trend_strength?.toFixed(0)}/100`],
              ['VWAP', sig.indicators?.or_high > 0 ? `H:${sig.indicators.or_high.toFixed(0)}` : '—'],
              ['OR L', sig.indicators?.or_low > 0 ? sig.indicators.or_low.toFixed(0) : '—'],
              ['Day%', `${(sig.indicators?.day_change_pct ?? 0) >= 0 ? '+' : ''}${sig.indicators?.day_change_pct?.toFixed(2)}%`],
            ].map(([k, v]) => (
              <div key={k} className="bg-slate-700/40 rounded p-1 text-center">
                <p className="text-slate-500">{k}</p>
                <p className="text-slate-200 font-semibold">{v}</p>
              </div>
            ))}
          </div>

          {sig.reasoning?.map((r, i) => (
            <p key={i} className="text-xs text-slate-400 flex gap-1.5 mb-0.5">
              <span className="text-blue-400 shrink-0">›</span>{r}
            </p>
          ))}
        </>
      )}
    </div>
  )
}

// ─── Live Chart ───────────────────────────────────────────────────────────────

function LiveChart({ bars }: { bars: ChartBar[] }) {
  const ref    = useRef<HTMLDivElement>(null)
  const [w, setW] = useState(900)
  const [hover, setHover] = useState<number | null>(null)

  useEffect(() => {
    if (!ref.current) return
    const obs = new ResizeObserver(e => setW(e[0].contentRect.width))
    obs.observe(ref.current)
    return () => obs.disconnect()
  }, [])

  const visible = Math.max(30, Math.min(bars.length, Math.floor(w / 12)))
  const slice   = bars.slice(-visible)
  const PAD_L = 4, PAD_R = 56, PAD_T = 28, PAD_B = 28
  const pw = w - PAD_L - PAD_R, ph = 280
  const bw = pw / Math.max(slice.length, 1), cw = Math.max(2, bw * 0.72)
  const prices = slice.flatMap(b => [b.high, b.low, b.ema9, b.ema21].filter(v => v > 0))
  const pMin = Math.min(...prices) * 0.9998, pMax = Math.max(...prices) * 1.0002, pRange = pMax - pMin || 1
  const cx = (i: number) => PAD_L + (i + 0.5) * bw
  const cy = (p: number) => PAD_T + (1 - (p - pMin) / pRange) * ph
  const ema9L  = slice.map((b,i) => b.ema9  > 0 ? `${i===0?'M':'L'}${cx(i).toFixed(1)},${cy(b.ema9).toFixed(1)}`  : '').filter(Boolean).join(' ')
  const ema21L = slice.map((b,i) => b.ema21 > 0 ? `${i===0?'M':'L'}${cx(i).toFixed(1)},${cy(b.ema21).toFixed(1)}` : '').filter(Boolean).join(' ')
  const step = [5,10,20,25,50,100,200].find(s => ph / (pRange/s) > 25) || 50
  const gridPs: number[] = []
  for (let p = Math.ceil(pMin/step)*step; p <= pMax; p += step) gridPs.push(p)
  const hovBar = hover !== null ? slice[hover] : null

  return (
    <div ref={ref} className="bg-slate-900 rounded-xl border border-slate-700/50 overflow-hidden">
      <div className="px-4 py-2.5 border-b border-slate-700/50 flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-4 text-xs">
          <span className="text-slate-200 font-semibold">NIFTY 15m · Signal Overlay</span>
          <span className="flex gap-1 items-center"><span className="w-4 h-0.5 bg-blue-400 inline-block"/>EMA9</span>
          <span className="flex gap-1 items-center"><span className="w-4 h-0.5 bg-orange-400 inline-block"/>EMA21</span>
          <span className="text-emerald-300 text-[10px]">▲ CE signal (all gates pass)</span>
          <span className="text-red-300 text-[10px]">▼ PE signal (all gates pass)</span>
          <span className="text-yellow-400 text-[10px]">◆ PCR failed</span>
        </div>
        {hovBar && (
          <span className="text-[10px] font-mono text-slate-400">
            {new Date(hovBar.time).toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit'})}
            &nbsp;O:{hovBar.open} H:{hovBar.high} L:{hovBar.low} C:{hovBar.close}
            {hovBar.is_signal && ` · ${hovBar.direction} ${hovBar.confidence}% ${hovBar.pcr_pass ? '' : '· PCR✗'}`}
          </span>
        )}
      </div>

      <svg width={w} height={ph+PAD_T+PAD_B} style={{ display:'block' }}
        onMouseMove={e => {
          const rect = e.currentTarget.getBoundingClientRect()
          const idx  = Math.floor((e.clientX - rect.left - PAD_L) / bw)
          setHover(idx >= 0 && idx < slice.length ? idx : null)
        }}
        onMouseLeave={() => setHover(null)}>
        <rect x={0} y={0} width={w} height={ph+PAD_T+PAD_B} fill="#0f172a"/>
        {gridPs.map(p => {
          const y = cy(p); if (y < PAD_T || y > PAD_T+ph) return null
          return <g key={p}><line x1={PAD_L} y1={y} x2={PAD_L+pw} y2={y} stroke="#1e293b" strokeWidth="1"/>
            <text x={PAD_L+pw+4} y={y+4} fill="#64748b" fontSize="10" fontFamily="monospace">{p}</text></g>
        })}
        {ema21L && <path d={ema21L} fill="none" stroke="#f97316" strokeWidth="1.5" strokeOpacity="0.9"/>}
        {ema9L  && <path d={ema9L}  fill="none" stroke="#60a5fa" strokeWidth="1.5" strokeOpacity="0.9"/>}
        {slice.map((b, i) => {
          const x = cx(i), bull = b.close >= b.open, col = bull ? '#22c55e' : '#ef4444'
          const bt = cy(Math.max(b.open,b.close)), bbot = cy(Math.min(b.open,b.close))
          const bh = Math.max(1, bbot - bt)
          const bgCol = b.is_position_entry ? '#3b82f6'  // blue for actual trade entry
            : b.is_entry ? (b.direction==='BULLISH'?'#22c55e':'#ef4444')
            : b.is_signal ? '#f59e0b' : ''
          return (
            <g key={i}>
              {bgCol && <rect x={x-cw/2-1} y={PAD_T} width={cw+2} height={ph} fill={bgCol} fillOpacity={b.is_position_entry?0.18:0.07}/>}
              <line x1={x} y1={cy(b.high)} x2={x} y2={cy(b.low)} stroke={col} strokeWidth="1"/>
              <rect x={x-cw/2} y={bt} width={cw} height={bh} fill={col} fillOpacity="0.9" rx="0.5"/>

              {/* Actual position entry marker — gold star/pin */}
              {b.is_position_entry && (
                <g>
                  <line x1={x} y1={PAD_T+4} x2={x} y2={PAD_T+ph} stroke="#3b82f6" strokeWidth="1.5" strokeDasharray="4 3" strokeOpacity="0.8"/>
                  <polygon points={`${x},${PAD_T+16} ${x-9},${PAD_T+28} ${x+9},${PAD_T+28}`} fill="#3b82f6"/>
                  <text x={x} y={PAD_T+42} textAnchor="middle" fill="#93c5fd" fontSize="8" fontFamily="monospace" fontWeight="bold">
                    ENTRY ₹{b.entry_premium.toFixed(0)}
                  </text>
                </g>
              )}

              {/* Signal arrows for potential entries */}
              {b.is_signal && !b.is_position_entry && (
                b.direction === 'BULLISH'
                  ? <polygon points={`${x},${cy(b.low)+22} ${x-7},${cy(b.low)+35} ${x+7},${cy(b.low)+35}`}
                      fill={b.pcr_pass?'#34d399':'#facc15'} opacity={b.is_entry?1:0.45}/>
                  : <polygon points={`${x},${cy(b.high)-22} ${x-7},${cy(b.high)-35} ${x+7},${cy(b.high)-35}`}
                      fill={b.pcr_pass?'#f87171':'#facc15'} opacity={b.is_entry?1:0.45}/>
              )}
              {b.is_entry && !b.is_position_entry && (
                <text x={x} y={b.direction==='BULLISH'?cy(b.low)+48:cy(b.high)-38} textAnchor="middle"
                  fill={b.direction==='BULLISH'?'#86efac':'#fca5a5'} fontSize="9" fontFamily="monospace">
                  {b.confidence}%
                </text>
              )}
            </g>
          )
        })}
        {hover !== null && <line x1={cx(hover)} y1={PAD_T} x2={cx(hover)} y2={PAD_T+ph} stroke="#64748b" strokeWidth="1" strokeDasharray="3 3"/>}
      </svg>

      <div className="px-4 py-2 border-t border-slate-800 text-[10px] text-slate-500 flex gap-4">
        <span className="text-blue-400">▼ blue pin = actual open position entry</span>
        <span className="text-emerald-400">▲/▼ solid = all 3 gates pass</span>
        <span className="text-yellow-400">◆ yellow = PCR rejected</span>
      </div>
    </div>
  )
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function LiveTerminal() {
  const [state,     setState]     = useState<LiveState | null>(null)
  const [chartBars, setChartBars] = useState<ChartBar[]>([])
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null)
  const [error,      setError]      = useState('')
  const sseRef = useRef<EventSource | null>(null)

  const fetchChart = useCallback(async () => {
    try {
      const r = await fetch('/api/naren/v1/live/chart-data')
      if (r.ok) { const d = await r.json(); setChartBars(d.bars || []) }
    } catch { /* ignore */ }
  }, [])

  const connectSSE = useCallback(() => {
    sseRef.current?.close()
    const sse = new EventSource('/api/naren/v1/live/stream')
    sse.onmessage = e => {
      try { setState(JSON.parse(e.data)); setLastUpdate(new Date()); setError('') }
      catch { /* ignore */ }
    }
    sse.onerror = () => setError('SSE disconnected — reconnecting…')
    sseRef.current = sse
  }, [])

  useEffect(() => {
    connectSSE()
    fetchChart()
    const id = setInterval(fetchChart, 60_000)
    return () => { sseRef.current?.close(); clearInterval(id) }
  }, [connectSSE, fetchChart])

  const hasPosition  = !!(state?.open_option && state?.open_trade)
  const hasChallenge = !!state?.active

  return (
    <div className="max-w-7xl mx-auto px-4 py-5 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-100">⚡ Live Paper Trade Terminal</h1>
          <p className="text-slate-400 text-sm mt-0.5">
            Real-time NIFTY 15m · 3-gate signal logic visualised · WebSocket option prices
          </p>
        </div>
        <div className="flex items-center gap-3">
          {lastUpdate && <span className="text-[10px] text-slate-500">
            {lastUpdate.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
          </span>}
          <div className={`flex items-center gap-2 px-3 py-1.5 rounded-xl text-xs font-medium border ${
            state?.ticker_live
              ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300'
              : 'bg-slate-700 border-slate-600 text-slate-400'}`}>
            <span className={`w-2 h-2 rounded-full ${state?.ticker_live ? 'bg-emerald-400 animate-pulse' : 'bg-slate-500'}`}/>
            {state?.ticker_live ? 'WebSocket Live' : 'Not connected'}
          </div>
          {hasPosition && (
            <div className="px-3 py-1.5 bg-blue-500/15 border border-blue-500/40 rounded-xl text-xs text-blue-300 font-semibold">
              📌 Position Open
            </div>
          )}
        </div>
      </div>

      {error && <div className="bg-yellow-500/10 border border-yellow-500/30 rounded-xl px-4 py-2 text-yellow-300 text-xs">⚠ {error}</div>}

      {!hasChallenge && (
        <div className="bg-slate-800/60 border border-slate-700/50 rounded-xl p-8 text-center">
          <p className="text-2xl mb-3">🏆</p>
          <p className="text-slate-300 font-semibold mb-1">No active challenge</p>
          <p className="text-slate-500 text-sm">Start a 90-Day Challenge to enable live paper trading.</p>
          <a href="/challenge" className="inline-block mt-3 px-5 py-2 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-500">→ Start Challenge</a>
        </div>
      )}

      {hasChallenge && (
        <>
          {/* Stats bar */}
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
            {[
              { label: 'NIFTY',       value: state?.spot?.toFixed(2) ?? '—',                                          color: 'text-slate-100' },
              { label: 'Today P&L',   value: `${sgn(state?.today_pnl??0)}₹${fmt(state?.today_pnl??0)}`,               color: pc(state?.today_pnl??0) },
              { label: 'Total P&L',   value: `${sgn(state?.total_pnl??0)}₹${fmt(state?.total_pnl??0)}`,               color: pc(state?.total_pnl??0) },
              { label: 'Win Rate',    value: `${fmtF(state?.win_rate??0, 0)}%`,                                        color: (state?.win_rate??0) >= 55 ? 'text-emerald-400' : 'text-yellow-400' },
              { label: 'Challenge',   value: `Day ${state?.day_number ?? 0} / 90`,                                    color: 'text-blue-300' },
            ].map(c => (
              <div key={c.label} className="bg-slate-800/70 rounded-xl p-3 border border-slate-700/50">
                <p className="text-slate-500 text-[10px]">{c.label}</p>
                <p className={`text-base font-bold ${c.color}`}>{c.value}</p>
              </div>
            ))}
          </div>

          {/* ══ SECTION A: Open Position (WHY the trade was taken) ══ */}
          {hasPosition && state.open_option && state.open_trade && (
            <OpenPositionCard opt={state.open_option} trade={state.open_trade} active={state.active} />
          )}

          {/* Chart with signal overlay */}
          <LiveChart bars={chartBars} />

          {/* ══ SECTION B: Current market signal + PCR + Next entry gates ══ */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <NextTradeGates filters={state?.filters ?? {
              tech_signal: { pass: false, value: '—', reason: 'Loading…' },
              pcr_filter:  { pass: false, value: '—', reason: 'Loading…' },
              real_ltp:    { pass: false, value: '—', reason: 'Loading…' },
              all_passed:  false,
            }} hasPosition={hasPosition} />
            <CurrentSignalCard sig={state?.signal} spot={state?.spot ?? 0} hasPosition={hasPosition} />
            <PCRGauge chain={state?.chain} />
          </div>
        </>
      )}
    </div>
  )
}
