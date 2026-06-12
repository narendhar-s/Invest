import { useEffect, useRef, useState } from 'react'
import { getOIPulse, type OIPulse as OIPulseData, type OIPulseRow, type TradeMode } from '../api/client'
import OIPanel from '../components/OIPanel'

// Trade modes the user can opt into. Each selected mode produces its own call.
const MODE_OPTIONS: { value: TradeMode; label: string; hint: string }[] = [
  { value: 'option_buy', label: 'Option Buy', hint: 'Buy CE/PE (defined risk = premium)' },
  { value: 'option_sell', label: 'Option Sell', hint: 'Write CE/PE at OI wall (theta)' },
  { value: 'futures_buy', label: 'Futures Buy', hint: 'Long the future (bullish only)' },
  { value: 'futures_sell', label: 'Futures Sell', hint: 'Short the future (bearish only)' },
]
const ALL_MODES: TradeMode[] = MODE_OPTIONS.map((m) => m.value)
const LOT_OPTIONS = [1, 2, 3, 4, 5, 10]
const RR_OPTIONS = [1, 1.5, 2, 2.5, 3]

// Underlyings with liquid option chains the pulse can read.
const QUICK_SYMBOLS = [
  { label: 'NIFTY 50', symbol: '^NSEI' },
  { label: 'BANKNIFTY', symbol: '^NSEBANK' },
  { label: 'FINNIFTY', symbol: 'FINNIFTY' },
  { label: 'SENSEX', symbol: 'SENSEX' },
]

const REGIME_LABEL: Record<string, string> = {
  long_buildup: 'Long Buildup',
  short_buildup: 'Short Buildup',
  short_covering: 'Short Covering',
  long_unwinding: 'Long Unwinding',
  flat: 'No Clear Regime',
}

const signalColor: Record<string, string> = {
  BULLISH: 'text-emerald-400',
  BEARISH: 'text-red-400',
  NEUTRAL: 'text-slate-300',
}

const signalBg: Record<string, string> = {
  BULLISH: 'bg-emerald-500/10 border-emerald-500/30',
  BEARISH: 'bg-red-500/10 border-red-500/30',
  NEUTRAL: 'bg-slate-700/20 border-slate-700/40',
}

const fmtOI = (n: number) => {
  const a = Math.abs(n)
  if (a >= 1e7) return (n / 1e7).toFixed(2) + 'Cr'
  if (a >= 1e5) return (n / 1e5).toFixed(2) + 'L'
  if (a >= 1e3) return (n / 1e3).toFixed(1) + 'K'
  return String(Math.round(n))
}
const fmtChg = (n: number) => (n > 0 ? '+' : '') + fmtOI(n)
const chgClass = (n: number) =>
  n > 0 ? 'text-emerald-400' : n < 0 ? 'text-red-400' : 'text-slate-500'

export default function OIPulse() {
  const [symbol, setSymbol] = useState('^NSEI')
  const [input, setInput] = useState('')
  const [pulse, setPulse] = useState<OIPulseData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [updatedAt, setUpdatedAt] = useState('')
  const [modes, setModes] = useState<TradeMode[]>(ALL_MODES)
  const [modeMenuOpen, setModeMenuOpen] = useState(false)
  const [maxLots, setMaxLots] = useState(2)
  const [rr, setRR] = useState(2)
  // Keep latest controls available to the polling closure without retriggering it.
  const modesRef = useRef(modes)
  modesRef.current = modes
  const lotsRef = useRef(maxLots)
  lotsRef.current = maxLots
  const rrRef = useRef(rr)
  rrRef.current = rr

  const toggleMode = (m: TradeMode) =>
    setModes((prev) => (prev.includes(m) ? prev.filter((x) => x !== m) : [...prev, m]))

  useEffect(() => {
    if (!symbol) return
    let cancelled = false
    const load = async () => {
      setLoading(true)
      try {
        const res = await getOIPulse(symbol, modesRef.current, lotsRef.current, rrRef.current)
        if (cancelled) return
        if (res.available && res.pulse) {
          setPulse(res.pulse)
          setError(null)
          setUpdatedAt(res.pulse.as_of)
        } else {
          setPulse(null)
          setError(res.error || 'OI Pulse unavailable for this symbol')
        }
      } catch {
        if (!cancelled) setError('Failed to load OI Pulse (is Zerodha connected?)')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    const id = setInterval(load, 60000) // refresh every minute
    return () => { cancelled = true; clearInterval(id) }
  }, [symbol, modes, maxLots, rr])

  const submitSymbol = (e: React.FormEvent) => {
    e.preventDefault()
    const s = input.trim()
    if (s) { setSymbol(s); setInput('') }
  }

  const recent = pulse?.history ? [...pulse.history].reverse() : [] // latest first

  return (
    <div className="max-w-screen-2xl mx-auto px-4 pt-20 pb-12">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 mb-5">
        <div>
          <h1 className="text-2xl font-bold text-white tracking-tight">⚡ OI Pulse</h1>
          <p className="text-sm text-slate-500 mt-0.5">
            Minute-by-minute option open-interest read on likely market movement.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {QUICK_SYMBOLS.map((q) => (
            <button
              key={q.symbol}
              onClick={() => setSymbol(q.symbol)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                symbol === q.symbol
                  ? 'bg-brand-600/20 text-brand-400 border-brand-600/30'
                  : 'text-slate-400 border-slate-800 hover:text-slate-200 hover:bg-slate-800/60'
              }`}
            >
              {q.label}
            </button>
          ))}
          <form onSubmit={submitSymbol}>
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="symbol…"
              className="w-28 px-2 py-1.5 rounded-lg bg-dark-800 border border-slate-800 text-xs text-slate-200 placeholder-slate-600 focus:outline-none focus:border-brand-600/50"
            />
          </form>

          {/* Trade-mode multi-select */}
          <div className="relative">
            <button
              type="button"
              onClick={() => setModeMenuOpen((o) => !o)}
              className="px-3 py-1.5 rounded-lg text-xs font-medium border border-slate-800 text-slate-300 hover:bg-slate-800/60 flex items-center gap-2"
            >
              <span>🎛️ Trade modes</span>
              <span className="text-brand-400 font-semibold">{modes.length}/{ALL_MODES.length}</span>
              <span className="text-slate-500">▾</span>
            </button>
            {modeMenuOpen && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setModeMenuOpen(false)} />
                <div className="absolute right-0 mt-2 w-64 z-50 bg-dark-800 border border-slate-700 rounded-xl shadow-xl p-2">
                  <div className="px-2 py-1 text-[11px] uppercase tracking-wide text-slate-500">
                    Generate calls for
                  </div>
                  {MODE_OPTIONS.map((m) => {
                    const on = modes.includes(m.value)
                    return (
                      <button
                        key={m.value}
                        type="button"
                        onClick={() => toggleMode(m.value)}
                        className="w-full flex items-start gap-2 px-2 py-1.5 rounded-lg hover:bg-slate-800/60 text-left"
                      >
                        <span
                          className={`mt-0.5 w-4 h-4 rounded border flex items-center justify-center text-[10px] ${
                            on ? 'bg-brand-600 border-brand-600 text-white' : 'border-slate-600 text-transparent'
                          }`}
                        >
                          ✓
                        </span>
                        <span>
                          <span className="block text-xs text-slate-200">{m.label}</span>
                          <span className="block text-[11px] text-slate-500">{m.hint}</span>
                        </span>
                      </button>
                    )
                  })}
                  <div className="flex items-center justify-between px-2 pt-2 mt-1 border-t border-slate-800">
                    <button
                      type="button"
                      onClick={() => setModes(ALL_MODES)}
                      className="text-[11px] text-brand-400 hover:text-brand-300"
                    >
                      Select all
                    </button>
                    <button
                      type="button"
                      onClick={() => setModes([])}
                      className="text-[11px] text-slate-500 hover:text-slate-300"
                    >
                      Clear
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>

          {/* Max lots */}
          <label className="flex items-center gap-1.5 text-xs text-slate-400">
            <span title="Live trade uses at most this many lots">Max lots</span>
            <select
              value={maxLots}
              onChange={(e) => setMaxLots(Number(e.target.value))}
              className="px-2 py-1.5 rounded-lg bg-dark-800 border border-slate-800 text-xs text-slate-200 focus:outline-none focus:border-brand-600/50"
            >
              {LOT_OPTIONS.map((n) => (
                <option key={n} value={n}>{n}</option>
              ))}
            </select>
          </label>

          {/* Risk:reward */}
          <label className="flex items-center gap-1.5 text-xs text-slate-400">
            <span title="Reward-to-risk multiple for the target">R:R</span>
            <select
              value={rr}
              onChange={(e) => setRR(Number(e.target.value))}
              className="px-2 py-1.5 rounded-lg bg-dark-800 border border-slate-800 text-xs text-slate-200 focus:outline-none focus:border-brand-600/50"
            >
              {RR_OPTIONS.map((n) => (
                <option key={n} value={n}>1:{n}</option>
              ))}
            </select>
          </label>
        </div>
      </div>

      {error && !pulse && (
        <div className="bg-dark-800 border border-slate-800 rounded-xl p-6 text-sm text-slate-400">
          {error}
        </div>
      )}

      {!pulse && !error && (
        <div className="bg-dark-800 border border-slate-800 rounded-xl p-6 text-sm text-slate-500">
          {loading ? 'Reading the chain…' : 'No pulse yet.'}
        </div>
      )}

      {pulse && (
        <>
          {/* Verdict banner */}
          <div className={`rounded-xl border p-5 mb-5 ${signalBg[pulse.signal] ?? signalBg.NEUTRAL}`}>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="flex items-center gap-3">
                  <span className={`text-xl font-bold ${signalColor[pulse.signal]}`}>{pulse.signal}</span>
                  <span className="text-sm text-slate-400">
                    {REGIME_LABEL[pulse.regime] ?? pulse.regime}
                  </span>
                  <span className="text-xs text-slate-500">conf {pulse.confidence}%</span>
                </div>
                <p className="text-sm text-slate-300 mt-1">{pulse.verdict}</p>
              </div>
              <div className="text-right text-xs text-slate-500">
                <div>{pulse.underlying} · exp {pulse.expiry}</div>
                <div>updated {updatedAt} IST {loading && '· …'}</div>
              </div>
            </div>
            {/* Confidence bar */}
            <div className="mt-3 h-1.5 bg-slate-800 rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full ${
                  pulse.signal === 'BULLISH' ? 'bg-emerald-500' : pulse.signal === 'BEARISH' ? 'bg-red-500' : 'bg-slate-500'
                }`}
                style={{ width: `${pulse.confidence}%` }}
              />
            </div>
          </div>

          {/* Trade-call cards — one per selected mode */}
          {(() => {
            const decisions = pulse.decisions && pulse.decisions.length
              ? pulse.decisions
              : pulse.decision ? [pulse.decision] : []
            if (decisions.length === 0) {
              return (
                <div className="rounded-xl border border-slate-800 bg-dark-800 p-5 mb-5 text-sm text-slate-500">
                  No trade modes selected — pick one or more in “🎛️ Trade modes”.
                </div>
              )
            }
            return (
              <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 mb-5">
                {decisions.map((d) => {
                  const active = d.action !== 'WAIT' && d.action !== 'NO TRADE'
                  const isOption = d.instrument === 'OPTION'
                  // Bullish-leaning legs (buy CE / sell PE / long fut) → green, else red.
                  const bullishLeg =
                    (isOption && d.option_type === 'CE' && d.side === 'BUY') ||
                    (isOption && d.option_type === 'PE' && d.side === 'SELL') ||
                    (!isOption && d.side === 'BUY')
                  const bearishLeg =
                    (isOption && d.option_type === 'PE' && d.side === 'BUY') ||
                    (isOption && d.option_type === 'CE' && d.side === 'SELL') ||
                    (!isOption && d.side === 'SELL')
                  const callColor = !active ? 'text-slate-400' : bullishLeg ? 'text-emerald-400' : bearishLeg ? 'text-red-400' : 'text-slate-300'
                  const callBg = !active
                    ? 'bg-slate-700/20 border-slate-700/40'
                    : bullishLeg
                      ? 'bg-emerald-500/10 border-emerald-500/30'
                      : bearishLeg
                        ? 'bg-red-500/10 border-red-500/30'
                        : 'bg-slate-700/20 border-slate-700/40'
                  return (
                    <div key={d.mode} className={`rounded-xl border p-4 ${callBg}`}>
                      <div className="flex items-center justify-between gap-2 mb-2">
                        <div className="flex items-center gap-2">
                          <span className="text-[11px] uppercase tracking-wide px-2 py-0.5 rounded bg-dark-900/50 text-slate-400 border border-slate-700/50">
                            {d.mode_label}
                          </span>
                          <span className={`text-lg font-bold ${callColor}`}>{d.action}</span>
                        </div>
                        {active && (
                          <span className="text-[11px] text-slate-400">
                            {d.conviction}{isOption ? ` · ${d.moneyness}` : ''}
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-slate-300">{d.rationale}</p>

                      {active && (
                        <div className="mt-3 space-y-3">
                          {/* R:R levels + position sizing strip */}
                          <div className="flex flex-wrap items-stretch gap-2">
                            {d.target_price > 0 && (
                              <div className="flex-1 min-w-[140px] bg-dark-900/40 rounded-lg p-2 border border-slate-800/60">
                                <div className="text-[10px] text-slate-500 uppercase tracking-wide mb-1">
                                  R:R 1:{d.rr} (on {pulse.underlying})
                                </div>
                                <div className="flex items-center justify-between text-xs">
                                  <span className="text-slate-300">{Math.round(d.entry_price)}</span>
                                  <span className="text-red-400">SL {Math.round(d.stop_price)}</span>
                                  <span className="text-emerald-400">TGT {Math.round(d.target_price)}</span>
                                </div>
                              </div>
                            )}
                            <div className="flex-1 min-w-[140px] bg-dark-900/40 rounded-lg p-2 border border-slate-800/60">
                              <div className="text-[10px] text-slate-500 uppercase tracking-wide mb-1">
                                Sizing (cap {d.max_lots} lots)
                              </div>
                              <div className="flex items-center justify-between text-xs">
                                <span className="text-slate-300">{d.lots} lot{d.lots === 1 ? '' : 's'}</span>
                                <span className="text-slate-400">{d.qty > 0 ? `${d.qty} qty` : '— qty'}</span>
                                <span className="text-slate-200">
                                  {d.total_cost > 0
                                    ? `₹${Math.round(d.total_cost).toLocaleString('en-IN')}${d.side === 'SELL' ? ' cr' : ''}`
                                    : '—'}
                                </span>
                              </div>
                            </div>
                          </div>

                          {/* Index view — entry/target/stop on the underlying */}
                          <div className="bg-dark-900/40 rounded-lg p-3 border border-slate-800/60">
                            <div className="text-[11px] text-slate-400 uppercase tracking-wide mb-2">
                              📈 Index view ({pulse.underlying})
                            </div>
                            <div className="space-y-1.5">
                              <div>
                                <span className="text-[11px] text-slate-500 uppercase">Entry · </span>
                                <span className="text-xs text-slate-300">{d.entry}</span>
                              </div>
                              <div>
                                <span className="text-[11px] text-slate-500 uppercase">Target · </span>
                                <span className="text-xs text-emerald-400">{d.target_note}</span>
                              </div>
                              <div>
                                <span className="text-[11px] text-slate-500 uppercase">Stop · </span>
                                <span className="text-xs text-red-400">{d.stop_note}</span>
                              </div>
                            </div>
                          </div>

                          {/* Option contract — only for option modes */}
                          {isOption && (
                            <div className={`rounded-lg p-3 border ${callBg}`}>
                              <div className="text-[11px] text-slate-400 uppercase tracking-wide mb-2">
                                🎯 Option contract — {d.side} {d.option_type}
                              </div>
                              {d.tradingsymbol ? (
                                <div className="space-y-2">
                                  <div>
                                    <div className={`text-sm font-semibold ${callColor}`}>{d.tradingsymbol}</div>
                                    <div className="text-[11px] text-slate-500 mt-0.5">
                                      {d.option_exchange} · {d.moneyness} · exp {d.expiry}
                                    </div>
                                  </div>
                                  <div className="grid grid-cols-3 gap-2">
                                    <div>
                                      <div className="text-[11px] text-slate-500 uppercase">Premium</div>
                                      <div className="text-xs text-slate-200 mt-0.5">
                                        {d.premium > 0 ? `₹${d.premium.toFixed(2)}` : '—'}
                                      </div>
                                    </div>
                                    <div>
                                      <div className="text-[11px] text-slate-500 uppercase">Lot</div>
                                      <div className="text-xs text-slate-200 mt-0.5">{d.lot_size || '—'}</div>
                                    </div>
                                    <div>
                                      <div className="text-[11px] text-slate-500 uppercase">{d.side === 'SELL' ? 'Credit/lot' : 'Per lot'}</div>
                                      <div className="text-xs text-slate-200 mt-0.5">
                                        {d.cost_per_lot > 0 ? `₹${Math.round(d.cost_per_lot).toLocaleString('en-IN')}` : '—'}
                                      </div>
                                    </div>
                                  </div>
                                  {d.approx_delta > 0 && (
                                    <div className="text-[11px] text-slate-500">
                                      ~{d.approx_delta.toFixed(2)} delta — premium moves ≈ ₹{d.approx_delta.toFixed(2)} per 1-pt index move.
                                    </div>
                                  )}
                                </div>
                              ) : (
                                <div className="text-xs text-slate-500">
                                  Contract not resolved (Kite chain unavailable). Strike {d.strike} {d.moneyness} {d.option_type}.
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      )}

                      {(d.notes?.length ?? 0) > 0 && (
                        <ul className="mt-3 space-y-1.5">
                          {d.notes!.map((nt, i) => (
                            <li key={i} className="text-[11px] text-slate-400 flex gap-2">
                              <span className="text-brand-400 mt-0.5">•</span>
                              <span>{nt}</span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  )
                })}
              </div>
            )
          })()}

          {/* Key levels strip */}
          <div className="grid grid-cols-2 md:grid-cols-6 gap-3 mb-5">
            {[
              { k: 'Spot', v: pulse.spot ? pulse.spot.toFixed(2) : '—', c: 'text-slate-200' },
              { k: 'PCR', v: pulse.pcr.toFixed(2), c: signalColor[pulse.signal] },
              { k: 'Max Pain', v: pulse.max_pain || '—', c: 'text-slate-200' },
              { k: 'Support', v: pulse.support || '—', c: 'text-emerald-400' },
              { k: 'Resistance', v: pulse.resistance || '—', c: 'text-red-400' },
              { k: 'Chain Bias', v: pulse.bias.toUpperCase(), c: signalColor[pulse.bias.toUpperCase()] ?? 'text-slate-300' },
            ].map((x) => (
              <div key={x.k} className="bg-dark-800 border border-slate-800 rounded-lg p-3">
                <div className="text-[11px] text-slate-500 uppercase tracking-wide">{x.k}</div>
                <div className={`text-base font-semibold mt-0.5 ${x.c}`}>{x.v}</div>
              </div>
            ))}
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
            {/* Rules behind the read */}
            <div className="bg-dark-800 border border-slate-800 rounded-xl p-4">
              <h2 className="text-sm font-semibold text-slate-200 mb-3">Rules fired this minute</h2>
              {(pulse.rules?.length ?? 0) === 0 ? (
                <p className="text-xs text-slate-500">No rules yet.</p>
              ) : (
                <ul className="space-y-2">
                  {pulse.rules.map((r, i) => (
                    <li key={i} className="text-xs text-slate-300 flex gap-2">
                      <span className="text-brand-400 mt-0.5">▸</span>
                      <span>{r}</span>
                    </li>
                  ))}
                </ul>
              )}
              {!pulse.has_prev && (
                <p className="text-[11px] text-slate-500 mt-3">
                  Deltas and regime appear from the next minute's reading once a baseline is set.
                </p>
              )}
            </div>

            {/* Per-minute pulse history */}
            <div className="bg-dark-800 border border-slate-800 rounded-xl p-4">
              <h2 className="text-sm font-semibold text-slate-200 mb-3">Per-minute pulse</h2>
              {recent.length === 0 ? (
                <p className="text-xs text-slate-500">Collecting readings…</p>
              ) : (
                <div className="overflow-x-auto max-h-80 overflow-y-auto">
                  <table className="w-full text-xs">
                    <thead className="text-slate-500 sticky top-0 bg-dark-800">
                      <tr>
                        <th className="text-left py-1 px-2">Time</th>
                        <th className="text-right py-1 px-2">Spot</th>
                        <th className="text-right py-1 px-2">ΔSpot</th>
                        <th className="text-right py-1 px-2">PCR</th>
                        <th className="text-right py-1 px-2">ΔCall OI</th>
                        <th className="text-right py-1 px-2">ΔPut OI</th>
                        <th className="text-left py-1 px-2">Regime</th>
                      </tr>
                    </thead>
                    <tbody>
                      {recent.map((r: OIPulseRow) => (
                        <tr key={r.unix} className="border-t border-slate-800/60">
                          <td className="text-left py-1 px-2 text-slate-400">{r.at}</td>
                          <td className="text-right py-1 px-2 text-slate-300">{r.spot ? r.spot.toFixed(1) : '—'}</td>
                          <td className={`text-right py-1 px-2 ${chgClass(r.spot_chg)}`}>
                            {r.spot_chg ? (r.spot_chg > 0 ? '+' : '') + r.spot_chg.toFixed(1) : '0'}
                          </td>
                          <td className="text-right py-1 px-2 text-slate-300">{r.pcr.toFixed(2)}</td>
                          <td className={`text-right py-1 px-2 ${chgClass(r.call_oi_chg)}`}>{fmtChg(r.call_oi_chg)}</td>
                          <td className={`text-right py-1 px-2 ${chgClass(r.put_oi_chg)}`}>{fmtChg(r.put_oi_chg)}</td>
                          <td className={`text-left py-1 px-2 ${signalColor[r.signal]}`}>
                            {REGIME_LABEL[r.regime] ?? r.regime}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>

          {/* Full option chain reuse */}
          <div className="mt-5">
            <OIPanel symbol={symbol} running={true} />
          </div>

          {/* Legend */}
          <div className="mt-5 bg-dark-800/60 border border-slate-800 rounded-xl p-4 text-[11px] text-slate-500 leading-relaxed">
            <span className="text-slate-400 font-medium">How to read it: </span>
            Price ↑ &amp; OI ↑ = <span className="text-emerald-400">Long Buildup</span> (bullish) ·
            Price ↓ &amp; OI ↑ = <span className="text-red-400">Short Buildup</span> (bearish) ·
            Price ↑ &amp; OI ↓ = <span className="text-emerald-400">Short Covering</span> (bullish bounce) ·
            Price ↓ &amp; OI ↓ = <span className="text-red-400">Long Unwinding</span> (bearish fade).
            Rising PCR favours support (put writing); falling PCR favours resistance (call writing).
          </div>
        </>
      )}
    </div>
  )
}
