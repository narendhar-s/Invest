import { useState, useRef, useCallback } from 'react'

// ─── Types ────────────────────────────────────────────────────────────────────

interface Trade {
  symbol: string; qty: number; buy_value: number; sell_value: number
  pnl: number; pnl_pct: number; expiry: string; option_type: string
}

interface ExpiryBreakdown { expiry: string; pnl: number; legs: number; win_legs: number; loss_legs: number }

interface WinLoss {
  win_count: number; loss_count: number; win_rate: number
  total_wins: number; total_loss: number; avg_win: number; avg_loss: number; reward_risk: number
}

interface ChargeItem { name: string; amount: number; pct: number }

interface Improvement { priority: 'critical' | 'high' | 'medium'; title: string; detail: string }

interface Analysis {
  summary: {
    client_id: string; period: string; realized_pnl: number; unrealized_pnl: number
    total_charges: number; net_pnl: number; total_turnover: number
  }
  expiry_breakdown: ExpiryBreakdown[]
  ce_pnl: number; pe_pnl: number; ce_legs: number; pe_legs: number
  win_loss: WinLoss
  top_losers: Trade[]; top_winners: Trade[]
  large_positions: Trade[]
  charges: ChargeItem[]
  improvements: Improvement[]
  trades: Trade[]
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const fmt = (n: number) => new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(Math.abs(n))
const fmtPct = (n: number) => `${n > 0 ? '+' : ''}${n.toFixed(1)}%`
const pnlColor = (n: number) => n >= 0 ? 'text-emerald-400' : 'text-red-400'
const pnlSign = (n: number) => n >= 0 ? '+' : '-'

function PnlBadge({ value }: { value: number }) {
  const cls = value >= 0 ? 'bg-emerald-500/20 text-emerald-400' : 'bg-red-500/20 text-red-400'
  return (
    <span className={`px-2 py-0.5 rounded text-xs font-semibold ${cls}`}>
      {pnlSign(value)}₹{fmt(value)}
    </span>
  )
}

function PriorityBadge({ p }: { p: string }) {
  const map: Record<string, string> = {
    critical: 'bg-red-500/30 text-red-300 border border-red-500/50',
    high: 'bg-orange-500/20 text-orange-300 border border-orange-500/40',
    medium: 'bg-yellow-500/15 text-yellow-300 border border-yellow-500/30',
  }
  return <span className={`text-[10px] px-2 py-0.5 rounded-full font-bold uppercase tracking-wide ${map[p]}`}>{p}</span>
}

// ─── Upload Zone ──────────────────────────────────────────────────────────────

function UploadZone({ onFile }: { onFile: (f: File) => void }) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault(); setDragging(false)
    const file = e.dataTransfer.files[0]
    if (file?.name.endsWith('.xlsx')) onFile(file)
  }, [onFile])

  return (
    <div
      onDragOver={e => { e.preventDefault(); setDragging(true) }}
      onDragLeave={() => setDragging(false)}
      onDrop={handleDrop}
      onClick={() => inputRef.current?.click()}
      className={`border-2 border-dashed rounded-xl p-14 text-center cursor-pointer transition-all
        ${dragging ? 'border-blue-400 bg-blue-500/10' : 'border-slate-600 hover:border-slate-400 hover:bg-slate-800/50'}`}
    >
      <input ref={inputRef} type="file" accept=".xlsx" className="hidden"
        onChange={e => e.target.files?.[0] && onFile(e.target.files[0])} />
      <div className="text-5xl mb-4">📊</div>
      <p className="text-slate-200 text-lg font-semibold mb-1">Drop your Zerodha P&L file here</p>
      <p className="text-slate-400 text-sm">or click to browse · supports <span className="text-blue-400 font-mono">.xlsx</span> from Zerodha Console → P&L</p>
    </div>
  )
}

// ─── Summary Cards ────────────────────────────────────────────────────────────

function SummaryCards({ s, wl }: { s: Analysis['summary']; wl: WinLoss }) {
  const cards = [
    { label: 'Net P&L', value: s.net_pnl, isRupee: true, sub: 'After charges' },
    { label: 'Gross P&L', value: s.realized_pnl, isRupee: true, sub: 'Before charges' },
    { label: 'Total Charges', value: -s.total_charges, isRupee: true, sub: `${(s.total_charges / Math.abs(s.realized_pnl) * 100).toFixed(0)}% of loss` },
    { label: 'Win Rate', value: null, display: `${wl.win_rate.toFixed(1)}%`, sub: `${wl.win_count}W / ${wl.loss_count}L` },
    { label: 'Reward:Risk', value: null, display: wl.reward_risk.toFixed(2), sub: wl.reward_risk < 0.5 ? '⚠ Below 0.5' : 'OK' },
    { label: 'Turnover', value: null, display: `₹${(s.total_turnover / 1e5).toFixed(1)}L`, sub: '1 month' },
  ]

  return (
    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
      {cards.map(c => (
        <div key={c.label} className="bg-slate-800/60 rounded-xl p-4 border border-slate-700/50">
          <p className="text-slate-400 text-xs mb-1">{c.label}</p>
          {c.isRupee ? (
            <p className={`text-xl font-bold ${pnlColor(c.value!)}`}>
              {pnlSign(c.value!)}₹{fmt(c.value!)}
            </p>
          ) : (
            <p className={`text-xl font-bold ${c.label === 'Reward:Risk' && wl.reward_risk < 0.5 ? 'text-red-400' : 'text-slate-100'}`}>
              {c.display}
            </p>
          )}
          <p className="text-slate-500 text-xs mt-0.5">{c.sub}</p>
        </div>
      ))}
    </div>
  )
}

// ─── Expiry Breakdown ─────────────────────────────────────────────────────────

function ExpiryTable({ data }: { data: ExpiryBreakdown[] }) {
  const max = Math.max(...data.map(d => Math.abs(d.pnl)))
  return (
    <div className="bg-slate-800/60 rounded-xl border border-slate-700/50 overflow-hidden">
      <div className="px-5 py-3 border-b border-slate-700/50">
        <h3 className="text-sm font-semibold text-slate-200">P&L by Expiry</h3>
      </div>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-slate-400 text-xs border-b border-slate-700/40">
            <th className="text-left px-5 py-2">Expiry</th>
            <th className="text-right px-3 py-2">P&L</th>
            <th className="text-right px-3 py-2">Legs</th>
            <th className="text-right px-3 py-2">Win/Loss</th>
            <th className="px-5 py-2">Bar</th>
          </tr>
        </thead>
        <tbody>
          {data.map(d => (
            <tr key={d.expiry} className="border-b border-slate-700/20 hover:bg-slate-700/20">
              <td className="px-5 py-2.5 font-mono text-xs text-slate-300">{d.expiry}</td>
              <td className={`px-3 py-2.5 text-right font-semibold ${pnlColor(d.pnl)}`}>
                {pnlSign(d.pnl)}₹{fmt(d.pnl)}
              </td>
              <td className="px-3 py-2.5 text-right text-slate-400">{d.legs}</td>
              <td className="px-3 py-2.5 text-right">
                <span className="text-emerald-400">{d.win_legs}W</span>
                <span className="text-slate-500"> / </span>
                <span className="text-red-400">{d.loss_legs}L</span>
              </td>
              <td className="px-5 py-2.5 w-32">
                <div className="h-2 rounded-full bg-slate-700 overflow-hidden">
                  <div
                    className={`h-full rounded-full ${d.pnl >= 0 ? 'bg-emerald-500' : 'bg-red-500'}`}
                    style={{ width: `${Math.min(100, Math.abs(d.pnl) / max * 100)}%` }}
                  />
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ─── CE vs PE ─────────────────────────────────────────────────────────────────

function CEPEPanel({ cePnL, pePnL, ceLegs, peLegs }: { cePnL: number; pePnL: number; ceLegs: number; peLegs: number }) {
  const total = Math.abs(cePnL) + Math.abs(pePnL)
  const cePct = total > 0 ? Math.abs(cePnL) / total * 100 : 50
  return (
    <div className="bg-slate-800/60 rounded-xl border border-slate-700/50 p-5">
      <h3 className="text-sm font-semibold text-slate-200 mb-4">CE vs PE P&L Split</h3>
      <div className="flex gap-6 mb-4">
        <div>
          <p className="text-xs text-slate-400 mb-1">Calls (CE) · {ceLegs} legs</p>
          <p className={`text-2xl font-bold ${pnlColor(cePnL)}`}>{pnlSign(cePnL)}₹{fmt(cePnL)}</p>
        </div>
        <div>
          <p className="text-xs text-slate-400 mb-1">Puts (PE) · {peLegs} legs</p>
          <p className={`text-2xl font-bold ${pnlColor(pePnL)}`}>{pnlSign(pePnL)}₹{fmt(pePnL)}</p>
        </div>
      </div>
      <div className="h-3 rounded-full overflow-hidden flex">
        <div className="bg-red-500 h-full" style={{ width: `${cePct}%` }} title={`CE: ₹${fmt(cePnL)}`} />
        <div className="bg-orange-400 h-full" style={{ width: `${100 - cePct}%` }} title={`PE: ₹${fmt(pePnL)}`} />
      </div>
      <div className="flex justify-between mt-1 text-xs text-slate-500">
        <span>CE {cePct.toFixed(0)}%</span>
        <span>PE {(100 - cePct).toFixed(0)}%</span>
      </div>
    </div>
  )
}

// ─── Win/Loss Stats ───────────────────────────────────────────────────────────

function WinLossPanel({ wl }: { wl: WinLoss }) {
  const beWR = wl.reward_risk > 0 ? 1 / (1 + wl.reward_risk) * 100 : 0
  return (
    <div className="bg-slate-800/60 rounded-xl border border-slate-700/50 p-5">
      <h3 className="text-sm font-semibold text-slate-200 mb-4">Win/Loss Statistics</h3>
      <div className="grid grid-cols-2 gap-3 text-sm">
        {[
          ['Win Rate', `${wl.win_rate.toFixed(1)}%`, wl.win_rate > 60],
          ['Reward:Risk', wl.reward_risk.toFixed(2), wl.reward_risk >= 0.5],
          ['Avg Win', `+₹${fmt(wl.avg_win)}`, true],
          ['Avg Loss', `-₹${fmt(Math.abs(wl.avg_loss))}`, false],
          ['Total Wins', `+₹${fmt(wl.total_wins)}`, true],
          ['Total Loss', `-₹${fmt(Math.abs(wl.total_loss))}`, false],
        ].map(([k, v, good]) => (
          <div key={k as string} className="bg-slate-700/40 rounded-lg p-3">
            <p className="text-slate-400 text-xs">{k}</p>
            <p className={`font-bold text-base ${good ? 'text-emerald-400' : 'text-red-400'}`}>{v}</p>
          </div>
        ))}
      </div>
      {beWR > wl.win_rate && (
        <div className="mt-3 bg-red-500/10 border border-red-500/30 rounded-lg p-3 text-xs text-red-300">
          ⚠ Breakeven win rate is <strong>{beWR.toFixed(1)}%</strong> — you need {(beWR - wl.win_rate).toFixed(1)}% more wins to break even
        </div>
      )}
    </div>
  )
}

// ─── Trade Table ──────────────────────────────────────────────────────────────

function TradeTable({ trades, title }: { trades: Trade[]; title: string }) {
  return (
    <div className="bg-slate-800/60 rounded-xl border border-slate-700/50 overflow-hidden">
      <div className="px-5 py-3 border-b border-slate-700/50">
        <h3 className="text-sm font-semibold text-slate-200">{title}</h3>
      </div>
      <table className="w-full text-xs">
        <thead>
          <tr className="text-slate-400 border-b border-slate-700/40">
            <th className="text-left px-5 py-2">Symbol</th>
            <th className="text-right px-3 py-2">Qty</th>
            <th className="text-right px-3 py-2">Buy ₹</th>
            <th className="text-right px-5 py-2">P&L</th>
          </tr>
        </thead>
        <tbody>
          {trades.map(t => (
            <tr key={t.symbol} className="border-b border-slate-700/20 hover:bg-slate-700/20">
              <td className="px-5 py-2.5">
                <span className="font-mono text-slate-300">{t.symbol}</span>
                <span className={`ml-2 text-[10px] px-1.5 py-0.5 rounded font-bold ${t.option_type === 'CE' ? 'bg-blue-500/20 text-blue-400' : 'bg-purple-500/20 text-purple-400'}`}>
                  {t.option_type}
                </span>
              </td>
              <td className="px-3 py-2.5 text-right text-slate-400">{t.qty.toLocaleString()}</td>
              <td className="px-3 py-2.5 text-right text-slate-400">₹{fmt(t.buy_value)}</td>
              <td className={`px-5 py-2.5 text-right font-semibold ${pnlColor(t.pnl)}`}>
                {pnlSign(t.pnl)}₹{fmt(t.pnl)}
                <span className="ml-1 text-slate-500">({fmtPct(t.pnl_pct)})</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ─── Charges ──────────────────────────────────────────────────────────────────

function ChargesPanel({ charges, total }: { charges: ChargeItem[]; total: number }) {
  return (
    <div className="bg-slate-800/60 rounded-xl border border-slate-700/50 p-5">
      <h3 className="text-sm font-semibold text-slate-200 mb-3">
        Charges Breakdown
        <span className="ml-2 text-red-400 font-bold">-₹{fmt(total)}</span>
      </h3>
      <div className="space-y-2">
        {charges.map(c => (
          <div key={c.name}>
            <div className="flex justify-between text-xs mb-1">
              <span className="text-slate-300">{c.name}</span>
              <span className="text-red-400 font-semibold">₹{fmt(c.amount)} ({c.pct.toFixed(1)}%)</span>
            </div>
            <div className="h-1.5 bg-slate-700 rounded-full overflow-hidden">
              <div className="h-full bg-red-500/60 rounded-full" style={{ width: `${c.pct}%` }} />
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

// ─── Improvements ─────────────────────────────────────────────────────────────

function ImprovementsPanel({ items }: { items: Improvement[] }) {
  const [expanded, setExpanded] = useState<number | null>(0)
  return (
    <div className="bg-slate-800/60 rounded-xl border border-slate-700/50 overflow-hidden">
      <div className="px-5 py-3 border-b border-slate-700/50">
        <h3 className="text-sm font-semibold text-slate-200">What To Do — Ranked by Priority</h3>
      </div>
      <div className="divide-y divide-slate-700/30">
        {items.map((item, i) => (
          <div key={i} className="cursor-pointer" onClick={() => setExpanded(expanded === i ? null : i)}>
            <div className="flex items-center gap-3 px-5 py-3 hover:bg-slate-700/20">
              <span className="text-slate-400 text-xs w-5">{i + 1}</span>
              <PriorityBadge p={item.priority} />
              <p className="text-slate-200 text-sm flex-1">{item.title}</p>
              <span className="text-slate-500 text-xs">{expanded === i ? '▲' : '▼'}</span>
            </div>
            {expanded === i && (
              <div className="px-5 pb-3 pt-1">
                <p className="text-slate-400 text-xs leading-relaxed ml-8">{item.detail}</p>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

// ─── All Trades Table ─────────────────────────────────────────────────────────

function AllTradesTable({ trades }: { trades: Trade[] }) {
  const [filter, setFilter] = useState<'all' | 'CE' | 'PE'>('all')
  const [expiry, setExpiry] = useState('all')
  const expiries = [...new Set(trades.map(t => t.expiry))].sort()
  const filtered = trades.filter(t =>
    (filter === 'all' || t.option_type === filter) &&
    (expiry === 'all' || t.expiry === expiry)
  )

  return (
    <div className="bg-slate-800/60 rounded-xl border border-slate-700/50 overflow-hidden">
      <div className="px-5 py-3 border-b border-slate-700/50 flex flex-wrap gap-3 items-center">
        <h3 className="text-sm font-semibold text-slate-200 mr-2">All Trades ({filtered.length})</h3>
        <div className="flex gap-1">
          {(['all', 'CE', 'PE'] as const).map(f => (
            <button key={f} onClick={() => setFilter(f)}
              className={`px-3 py-1 rounded text-xs font-medium transition-colors ${filter === f ? 'bg-blue-600 text-white' : 'bg-slate-700 text-slate-300 hover:bg-slate-600'}`}>
              {f}
            </button>
          ))}
        </div>
        <select value={expiry} onChange={e => setExpiry(e.target.value)}
          className="bg-slate-700 text-slate-300 text-xs px-2 py-1 rounded border border-slate-600">
          <option value="all">All Expiries</option>
          {expiries.map(e => <option key={e} value={e}>{e}</option>)}
        </select>
      </div>
      <div className="overflow-x-auto max-h-80 overflow-y-auto">
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-slate-800">
            <tr className="text-slate-400 border-b border-slate-700/40">
              <th className="text-left px-5 py-2">Symbol</th>
              <th className="text-right px-3 py-2">Qty</th>
              <th className="text-right px-3 py-2">Buy ₹</th>
              <th className="text-right px-3 py-2">Sell ₹</th>
              <th className="text-right px-5 py-2">P&L</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map(t => (
              <tr key={t.symbol} className="border-b border-slate-700/20 hover:bg-slate-700/20">
                <td className="px-5 py-2">
                  <span className="font-mono text-slate-300">{t.symbol}</span>
                  <span className={`ml-2 text-[10px] px-1 py-0.5 rounded ${t.option_type === 'CE' ? 'bg-blue-500/20 text-blue-400' : 'bg-purple-500/20 text-purple-400'}`}>
                    {t.option_type}
                  </span>
                </td>
                <td className="px-3 py-2 text-right text-slate-400">{t.qty.toLocaleString()}</td>
                <td className="px-3 py-2 text-right text-slate-400">₹{fmt(t.buy_value)}</td>
                <td className="px-3 py-2 text-right text-slate-400">₹{fmt(t.sell_value)}</td>
                <td className={`px-5 py-2 text-right font-semibold ${pnlColor(t.pnl)}`}>
                  {pnlSign(t.pnl)}₹{fmt(t.pnl)}
                  <span className="ml-1 text-slate-500">({fmtPct(t.pnl_pct)})</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function PnlAnalysis() {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [data, setData] = useState<Analysis | null>(null)
  const [fileName, setFileName] = useState('')

  const handleFile = async (file: File) => {
    setFileName(file.name)
    setError(null)
    setLoading(true)
    try {
      const form = new FormData()
      form.append('file', file)
      const res = await fetch('/api/naren/v1/pnl/analyze', { method: 'POST', body: form })
      if (!res.ok) {
        const err = await res.json()
        throw new Error(err.error || 'Analysis failed')
      }
      setData(await res.json())
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Unknown error')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="max-w-7xl mx-auto px-4 py-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-100">P&L Analyser</h1>
          <p className="text-slate-400 text-sm mt-0.5">Upload Zerodha Console → P&L → Download .xlsx</p>
        </div>
        {data && (
          <button onClick={() => { setData(null); setFileName('') }}
            className="px-4 py-1.5 bg-slate-700 hover:bg-slate-600 text-slate-300 text-sm rounded-lg transition-colors">
            Analyse Another File
          </button>
        )}
      </div>

      {/* Upload */}
      {!data && !loading && <UploadZone onFile={handleFile} />}

      {/* Loading */}
      {loading && (
        <div className="flex flex-col items-center py-20 gap-4">
          <div className="w-10 h-10 border-4 border-blue-500 border-t-transparent rounded-full animate-spin" />
          <p className="text-slate-400 text-sm">Analysing <span className="text-blue-400">{fileName}</span>…</p>
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="bg-red-500/10 border border-red-500/30 rounded-xl p-5 text-red-300 text-sm">
          <strong>Error:</strong> {error}
        </div>
      )}

      {/* Dashboard */}
      {data && (
        <div className="space-y-5">
          {/* Period Banner */}
          <div className="bg-slate-800/40 rounded-xl px-5 py-3 flex items-center gap-4 border border-slate-700/40 text-xs text-slate-400">
            <span>📁 <strong className="text-slate-200">{fileName}</strong></span>
            <span className="text-slate-600">·</span>
            <span>Client: <strong className="text-slate-300">{data.summary.client_id}</strong></span>
            <span className="text-slate-600">·</span>
            <span>{data.summary.period}</span>
          </div>

          <SummaryCards s={data.summary} wl={data.win_loss} />

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
            <div className="lg:col-span-2">
              <ExpiryTable data={data.expiry_breakdown} />
            </div>
            <div className="space-y-4">
              <CEPEPanel cePnL={data.ce_pnl} pePnL={data.pe_pnl} ceLegs={data.ce_legs} peLegs={data.pe_legs} />
              <WinLossPanel wl={data.win_loss} />
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
            <TradeTable trades={data.top_losers} title="Top 5 Losers" />
            <TradeTable trades={data.top_winners} title="Top 5 Winners" />
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
            <TradeTable trades={data.large_positions} title="Largest Positions by Capital" />
            <ChargesPanel charges={data.charges} total={data.summary.total_charges} />
          </div>

          <ImprovementsPanel items={data.improvements} />

          <AllTradesTable trades={data.trades} />
        </div>
      )}
    </div>
  )
}
