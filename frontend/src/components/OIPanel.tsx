import { useEffect, useState } from 'react'
import { getLiveOI, type OIAnalysis } from '../api/client'

interface Props {
  symbol: string
  running: boolean
}

const biasColor: Record<string, string> = {
  bullish: 'text-emerald-400',
  bearish: 'text-red-400',
  neutral: 'text-slate-300',
}

const fmtOI = (n: number) => {
  if (n >= 1e7) return (n / 1e7).toFixed(2) + 'Cr'
  if (n >= 1e5) return (n / 1e5).toFixed(2) + 'L'
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K'
  return String(n)
}

// fmtChg formats a signed OI change with a leading +/- and abbreviated units.
const fmtChg = (n: number) => {
  if (!n) return '0'
  const sign = n > 0 ? '+' : '-'
  return sign + fmtOI(Math.abs(n))
}

// Color a change: rising put OI (support building) and rising call OI
// (resistance building) are the meaningful signals.
const chgColor = (n: number) =>
  n > 0 ? 'text-slate-200' : n < 0 ? 'text-slate-500' : 'text-slate-600'

// OIPanel shows option-chain open-interest analysis (PCR, max-pain,
// support/resistance, bias) for the selected symbol. Refreshes every 60s.
export default function OIPanel({ symbol, running }: Props) {
  const [oi, setOi] = useState<OIAnalysis | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!symbol || !running) return
    let cancelled = false
    const load = async () => {
      setLoading(true)
      try {
        const res = await getLiveOI(symbol)
        if (cancelled) return
        if (res.available && res.oi) {
          setOi(res.oi)
          setError(null)
        } else {
          setOi(null)
          setError(res.error || 'OI unavailable for this symbol')
        }
      } catch {
        if (!cancelled) setError('Failed to load OI')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    const id = setInterval(load, 60000)
    return () => { cancelled = true; clearInterval(id) }
  }, [symbol, running])

  if (!symbol || !running) return null

  if (error && !oi) {
    return (
      <div className="bg-dark-800 border border-slate-800 rounded-xl p-4 text-xs text-slate-500">
        Open Interest — {error}
      </div>
    )
  }

  if (!oi) {
    return (
      <div className="bg-dark-800 border border-slate-800 rounded-xl p-4 text-xs text-slate-500">
        {loading ? 'Loading open interest…' : 'No OI data'}
      </div>
    )
  }

  const maxRowOI = Math.max(1, ...oi.rows.map((r) => Math.max(r.call_oi, r.put_oi)))

  return (
    <div className="bg-dark-800 border border-slate-800 rounded-xl p-4">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 mb-3">
        <div className="text-sm font-semibold text-slate-200">
          {oi.underlying} OI <span className="text-xs text-slate-500">· exp {oi.expiry}</span>
        </div>
        <div className="text-xs text-slate-400">
          Bias <span className={`font-semibold ${biasColor[oi.bias] ?? 'text-slate-300'}`}>{oi.bias.toUpperCase()}</span>
        </div>
        <div className="text-xs text-slate-400">PCR <span className="text-slate-200 font-medium">{oi.pcr.toFixed(2)}</span></div>
        <div className="text-xs text-slate-400">Max pain <span className="text-slate-200 font-medium">{oi.max_pain}</span></div>
        <div className="text-xs text-slate-400">Support <span className="text-emerald-400 font-medium">{oi.support}</span></div>
        <div className="text-xs text-slate-400">Resistance <span className="text-red-400 font-medium">{oi.resistance}</span></div>
        {oi.spot > 0 && <div className="text-xs text-slate-400">Spot <span className="text-slate-200 font-medium">{oi.spot.toFixed(2)}</span></div>}
      </div>

      {/* Support / Resistance — OI-based vs change-based (fresh OI buildup) */}
      <div className="mb-4 overflow-x-auto">
        <table className="text-xs border border-slate-800 rounded-lg">
          <thead>
            <tr className="text-slate-500">
              <th className="text-left py-1.5 px-3">Level</th>
              <th className="text-right py-1.5 px-3">By total OI</th>
              <th className="text-right py-1.5 px-3">By OI change</th>
            </tr>
          </thead>
          <tbody>
            <tr className="border-t border-slate-800/60">
              <td className="text-left py-1.5 px-3 text-red-400 font-medium">Resistance</td>
              <td className="text-right py-1.5 px-3 text-slate-300">{oi.resistance || '—'}</td>
              <td className="text-right py-1.5 px-3 text-red-400 font-semibold">
                {oi.has_change ? (oi.chg_resistance || '—') : '—'}
              </td>
            </tr>
            <tr className="border-t border-slate-800/60">
              <td className="text-left py-1.5 px-3 text-emerald-400 font-medium">Support</td>
              <td className="text-right py-1.5 px-3 text-slate-300">{oi.support || '—'}</td>
              <td className="text-right py-1.5 px-3 text-emerald-400 font-semibold">
                {oi.has_change ? (oi.chg_support || '—') : '—'}
              </td>
            </tr>
            <tr className="border-t border-slate-800/60">
              <td className="text-left py-1.5 px-3 text-slate-400 font-medium">Max pain</td>
              <td className="text-right py-1.5 px-3 text-slate-300" colSpan={2}>{oi.max_pain || '—'}</td>
            </tr>
          </tbody>
        </table>
        {!oi.has_change && (
          <p className="text-[11px] text-slate-500 mt-1">
            Change-based levels appear after the next minute's OI update.
          </p>
        )}
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-slate-500">
              <th className="text-right py-1 px-2">Call Chg</th>
              <th className="text-right py-1 px-2">Call OI</th>
              <th className="text-center py-1 px-2">Strike</th>
              <th className="text-left py-1 px-2">Put OI</th>
              <th className="text-left py-1 px-2">Put Chg</th>
            </tr>
          </thead>
          <tbody>
            {oi.rows.map((r) => {
              const isSupport = r.strike === oi.support
              const isResistance = r.strike === oi.resistance
              return (
                <tr key={r.strike} className="border-t border-slate-800/60">
                  <td className={`text-right py-0.5 px-2 ${chgColor(r.call_chg_oi)}`}>
                    {oi.has_change ? fmtChg(r.call_chg_oi) : '—'}
                  </td>
                  <td className="text-right py-0.5 px-2">
                    <div className="flex items-center justify-end gap-1.5">
                      <span className="text-slate-300">{fmtOI(r.call_oi)}</span>
                      <span className="inline-block h-2 bg-red-500/40 rounded-sm" style={{ width: `${(r.call_oi / maxRowOI) * 60}px` }} />
                    </div>
                  </td>
                  <td className={`text-center py-0.5 px-2 font-medium ${isSupport ? 'text-emerald-400' : isResistance ? 'text-red-400' : 'text-slate-400'}`}>
                    {r.strike}
                  </td>
                  <td className="text-left py-0.5 px-2">
                    <div className="flex items-center gap-1.5">
                      <span className="inline-block h-2 bg-emerald-500/40 rounded-sm" style={{ width: `${(r.put_oi / maxRowOI) * 60}px` }} />
                      <span className="text-slate-300">{fmtOI(r.put_oi)}</span>
                    </div>
                  </td>
                  <td className={`text-left py-0.5 px-2 ${chgColor(r.put_chg_oi)}`}>
                    {oi.has_change ? fmtChg(r.put_chg_oi) : '—'}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
