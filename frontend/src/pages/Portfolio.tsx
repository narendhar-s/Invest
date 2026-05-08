import { useEffect, useState, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { getPortfolio, buyMore, sellPartial, getUndervaluedStocks, unlockPortfolio, setPortfolioToken, getPortfolioToken, type HoldingMetrics, type PortfolioData, type SectorAlloc, type UndervaluedStock } from '../api/client'
import LoadingSpinner from '../components/LoadingSpinner'

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmt(n: number | null | undefined, dec = 2) {
  if (n == null || n === 0) return '—'
  return n.toLocaleString('en-IN', { minimumFractionDigits: dec, maximumFractionDigits: dec })
}

function fmtCurrency(n: number, currency: string) {
  if (n === 0) return '—'
  const prefix = currency === 'USD' ? '$' : '₹'
  return prefix + n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function pnlColor(v: number) {
  return v > 0 ? 'text-emerald-400' : v < 0 ? 'text-red-400' : 'text-slate-400'
}

// ── Zone config ───────────────────────────────────────────────────────────────

const ZONE_CONFIG: Record<string, { label: string; color: string; bg: string; border: string }> = {
  strong_accumulate:  { label: 'STRONG BUY ZONE', color: 'text-emerald-300', bg: 'bg-emerald-500/20', border: 'border-emerald-500/50' },
  partial_accumulate: { label: 'ACCUMULATE',      color: 'text-green-400',   bg: 'bg-green-500/15',   border: 'border-green-500/40' },
  hold:               { label: 'HOLD',             color: 'text-amber-400',   bg: 'bg-amber-500/10',   border: 'border-amber-500/30' },
  no_buy:             { label: 'NO BUY',           color: 'text-orange-400',  bg: 'bg-orange-500/10',  border: 'border-orange-500/30' },
  profit_booking:     { label: 'BOOK PROFITS',     color: 'text-blue-400',    bg: 'bg-blue-500/10',    border: 'border-blue-500/30' },
  stop_loss:          { label: 'STOP LOSS',        color: 'text-red-300',     bg: 'bg-red-500/20',     border: 'border-red-500/50' },
}

const ACTION_CONFIG: Record<string, { label: string; color: string }> = {
  ACCUMULATE: { label: 'ACCUMULATE', color: 'text-emerald-400' },
  HOLD:       { label: 'HOLD',       color: 'text-amber-400' },
  REDUCE:     { label: 'REDUCE',     color: 'text-orange-400' },
  EXIT:       { label: 'EXIT',       color: 'text-red-400' },
}

const RISK_CONFIG: Record<string, { color: string; bg: string }> = {
  LOW:      { color: 'text-emerald-400', bg: 'bg-emerald-500/10' },
  MODERATE: { color: 'text-amber-400',   bg: 'bg-amber-500/10' },
  HIGH:     { color: 'text-red-400',     bg: 'bg-red-500/10' },
}

// ── Sub-components ────────────────────────────────────────────────────────────

function ZoneBadge({ zone }: { zone: string }) {
  const cfg = ZONE_CONFIG[zone] ?? { label: zone, color: 'text-slate-400', bg: 'bg-slate-700', border: 'border-slate-600' }
  return (
    <span className={`text-xs font-bold px-2 py-0.5 rounded border ${cfg.bg} ${cfg.color} ${cfg.border} whitespace-nowrap`}>
      {cfg.label}
    </span>
  )
}

function ActionBadge({ action }: { action: string }) {
  const cfg = ACTION_CONFIG[action] ?? { label: action, color: 'text-slate-400' }
  return <span className={`text-xs font-bold ${cfg.color}`}>{cfg.label}</span>
}

function RiskBadge({ risk }: { risk: string }) {
  const cfg = RISK_CONFIG[risk] ?? { color: 'text-slate-400', bg: 'bg-slate-700' }
  return <span className={`text-xs font-semibold px-2 py-0.5 rounded ${cfg.bg} ${cfg.color}`}>{risk}</span>
}

function TrendBadge({ trend }: { trend: string }) {
  const color = trend === 'UP' ? 'text-emerald-400' : trend === 'DOWN' ? 'text-red-400' : 'text-slate-400'
  const icon = trend === 'UP' ? '▲' : trend === 'DOWN' ? '▼' : '→'
  return <span className={`text-xs font-mono ${color}`}>{icon} {trend || '—'}</span>
}

// ── Alert Banner ──────────────────────────────────────────────────────────────

function AlertBanner({ alerts }: { alerts: PortfolioData['alerts'] }) {
  if (!alerts || alerts.length === 0) return null
  const critical = alerts.filter(a => a.severity === 'critical')
  const warnings = alerts.filter(a => a.severity === 'warning')
  const infos = alerts.filter(a => a.severity === 'info')

  return (
    <div className="mb-6 space-y-2">
      {critical.map((a, i) => (
        <div key={i} className="bg-red-500/10 border border-red-500/40 rounded-xl p-3 flex items-start gap-3">
          <span className="text-red-400 text-lg">🔴</span>
          <div>
            <span className="text-red-400 font-bold text-sm">{a.symbol}</span>
            <span className="text-red-300 text-xs ml-2">{a.message}</span>
          </div>
        </div>
      ))}
      {warnings.map((a, i) => (
        <div key={i} className="bg-amber-500/10 border border-amber-500/40 rounded-xl p-3 flex items-start gap-3">
          <span className="text-amber-400 text-lg">⚠️</span>
          <div>
            <span className="text-amber-400 font-bold text-sm">{a.symbol}</span>
            <span className="text-amber-300 text-xs ml-2">{a.message}</span>
          </div>
        </div>
      ))}
      {infos.map((a, i) => (
        <div key={i} className="bg-blue-500/10 border border-blue-500/40 rounded-xl p-3 flex items-start gap-3">
          <span className="text-blue-400 text-lg">ℹ️</span>
          <div>
            <span className="text-blue-400 font-bold text-sm">{a.symbol}</span>
            <span className="text-blue-300 text-xs ml-2">{a.message}</span>
          </div>
        </div>
      ))}
    </div>
  )
}

// ── Sector Breakdown Bar ──────────────────────────────────────────────────────

function SectorBreakdown({ sectors, market }: { sectors: SectorAlloc[]; market: string }) {
  const mktSectors = sectors.filter(s => s.market === market)
  if (mktSectors.length === 0) return null

  const palette = [
    'bg-brand-500', 'bg-emerald-500', 'bg-amber-500', 'bg-blue-500',
    'bg-purple-500', 'bg-red-500', 'bg-pink-500', 'bg-cyan-500',
  ]

  return (
    <div>
      <h3 className="text-xs font-semibold text-slate-400 mb-2">{market} — Sector Allocation</h3>
      <div className="flex h-3 rounded-full overflow-hidden mb-3 gap-0.5">
        {mktSectors.map((s, i) => (
          <div
            key={s.sector}
            className={`${palette[i % palette.length]} transition-all`}
            style={{ width: `${s.allocation_pct}%` }}
            title={`${s.sector}: ${s.allocation_pct.toFixed(1)}%`}
          />
        ))}
      </div>
      <div className="flex flex-wrap gap-2">
        {mktSectors.map((s, i) => (
          <div key={s.sector} className="flex items-center gap-1.5">
            <div className={`w-2 h-2 rounded-full ${palette[i % palette.length]}`} />
            <span className="text-xs text-slate-400">{s.sector}</span>
            <span className="text-xs text-slate-500">{s.allocation_pct.toFixed(1)}%</span>
            <span className={`text-xs ${pnlColor(s.pnl_pct)}`}>({s.pnl_pct >= 0 ? '+' : ''}{s.pnl_pct.toFixed(1)}%)</span>
            {s.over_exposed && <span className="text-xs text-orange-400">⚠️</span>}
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Trade Modal (Buy More / Sell Partial) ─────────────────────────────────────

function TradeModal({
  h,
  mode,
  onClose,
  onDone,
}: {
  h: HoldingMetrics
  mode: 'buy' | 'sell'
  onClose: () => void
  onDone: () => void
}) {
  const cc = h.currency === 'USD' ? '$' : '₹'
  const [qty, setQty] = useState('')
  const [price, setPrice] = useState(h.current_price > 0 ? h.current_price.toFixed(2) : h.avg_buy_price.toFixed(2))
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const qtyNum = parseFloat(qty) || 0
  const priceNum = parseFloat(price) || 0

  // Preview calculation
  const newAvg = mode === 'buy' && qtyNum > 0
    ? (h.quantity * h.avg_buy_price + qtyNum * priceNum) / (h.quantity + qtyNum)
    : 0
  const newQty = mode === 'buy' ? h.quantity + qtyNum : h.quantity - qtyNum
  const realizedPnL = mode === 'sell' ? qtyNum * (priceNum - h.avg_buy_price) : 0

  const handleSubmit = async () => {
    if (qtyNum <= 0 || priceNum <= 0) { setError('Enter valid qty and price'); return }
    if (mode === 'sell' && qtyNum > h.quantity) { setError(`Cannot sell more than ${h.quantity}`); return }
    setLoading(true)
    setError('')
    try {
      if (mode === 'buy') {
        await buyMore(h.symbol, qtyNum, priceNum)
      } else {
        await sellPartial(h.symbol, qtyNum, priceNum)
      }
      onDone()
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Request failed')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-dark-800 border border-slate-700 rounded-2xl p-6 w-full max-w-sm shadow-2xl" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-5">
          <div>
            <h3 className="text-white font-bold">{mode === 'buy' ? 'Buy More' : 'Sell Partial'} — {h.symbol}</h3>
            <div className="text-xs text-slate-500 mt-0.5">
              Current: {h.quantity % 1 === 0 ? h.quantity : h.quantity.toFixed(4)} qty @ {cc}{fmt(h.avg_buy_price)} avg
            </div>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-white text-xl">✕</button>
        </div>

        <div className="space-y-4 mb-5">
          <div>
            <label className="text-xs text-slate-400 mb-1 block">
              {mode === 'buy' ? 'Quantity to buy' : 'Quantity to sell'}
            </label>
            <input
              type="number"
              value={qty}
              onChange={e => setQty(e.target.value)}
              placeholder="e.g. 10"
              className="w-full bg-dark-700 border border-slate-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-brand-500"
            />
          </div>
          <div>
            <label className="text-xs text-slate-400 mb-1 block">
              {mode === 'buy' ? 'Buy price' : 'Sell price'} ({cc})
            </label>
            <input
              type="number"
              value={price}
              onChange={e => setPrice(e.target.value)}
              className="w-full bg-dark-700 border border-slate-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-brand-500"
            />
          </div>
        </div>

        {/* Preview */}
        {qtyNum > 0 && priceNum > 0 && (
          <div className="bg-dark-700 rounded-xl p-4 mb-5 space-y-2 text-xs">
            <div className="text-slate-400 font-semibold mb-2">Preview</div>
            <div className="flex justify-between">
              <span className="text-slate-500">New quantity</span>
              <span className="text-white font-mono">{newQty % 1 === 0 ? newQty : newQty.toFixed(4)}</span>
            </div>
            {mode === 'buy' && (
              <div className="flex justify-between">
                <span className="text-slate-500">New avg buy price</span>
                <span className="text-amber-400 font-mono">{cc}{newAvg.toFixed(2)}</span>
              </div>
            )}
            {mode === 'sell' && (
              <div className="flex justify-between">
                <span className="text-slate-500">Realized P&L</span>
                <span className={`font-mono font-bold ${realizedPnL >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                  {realizedPnL >= 0 ? '+' : ''}{cc}{Math.abs(realizedPnL).toFixed(2)}
                </span>
              </div>
            )}
            {mode === 'buy' && (
              <div className="flex justify-between">
                <span className="text-slate-500">Additional investment</span>
                <span className="text-white font-mono">{cc}{(qtyNum * priceNum).toFixed(2)}</span>
              </div>
            )}
          </div>
        )}

        {error && <div className="text-red-400 text-xs mb-3">{error}</div>}

        <div className="flex gap-3">
          <button
            onClick={onClose}
            className="flex-1 py-2.5 rounded-lg border border-slate-700 text-slate-400 text-sm hover:text-slate-200"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={loading}
            className={`flex-1 py-2.5 rounded-lg text-white text-sm font-semibold disabled:opacity-50 ${
              mode === 'buy' ? 'bg-emerald-600 hover:bg-emerald-700' : 'bg-red-600 hover:bg-red-700'
            }`}
          >
            {loading ? '...' : mode === 'buy' ? 'Confirm Buy' : 'Confirm Sell'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Holding Detail Row ────────────────────────────────────────────────────────

function HoldingRow({ h, onNavigate, onRefresh }: { h: HoldingMetrics; onNavigate: (sym: string) => void; onRefresh: () => void }) {
  const [expanded, setExpanded] = useState(false)
  const [tradeModal, setTradeModal] = useState<'buy' | 'sell' | null>(null)
  const cc = h.currency === 'USD' ? '$' : '₹'
  const hasPrice = h.current_price > 0

  return (
    <>
      <tr
        className={`border-b border-slate-800/30 hover:bg-dark-700/50 cursor-pointer transition-colors ${h.zone === 'stop_loss' ? 'bg-red-500/5' : h.zone === 'strong_accumulate' ? 'bg-emerald-500/5' : ''}`}
        onClick={() => setExpanded(e => !e)}
      >
        {/* Symbol */}
        <td className="px-3 py-3">
          <div className="flex items-center gap-2">
            <span className="font-bold text-white text-sm">{h.symbol}</span>
            {h.has_alert && <span className="text-xs">🔔</span>}
          </div>
          <div className="text-xs text-slate-500 truncate max-w-[110px]">{h.display_name}</div>
        </td>
        {/* Sector */}
        <td className="px-3 py-3 text-xs text-slate-400 hidden lg:table-cell">{h.sector}</td>
        {/* Qty */}
        <td className="px-3 py-3 text-xs font-mono text-slate-300">{h.quantity % 1 === 0 ? h.quantity : h.quantity.toFixed(4)}</td>
        {/* Avg Buy */}
        <td className="px-3 py-3 text-xs font-mono text-slate-400">{cc}{fmt(h.avg_buy_price)}</td>
        {/* LTP */}
        <td className="px-3 py-3">
          <div className="text-sm font-mono font-bold text-white">{hasPrice ? cc + fmt(h.current_price) : '—'}</div>
          {h.last_bar_date && <div className="text-xs text-slate-600">{h.last_bar_date}</div>}
        </td>
        {/* P&L */}
        <td className="px-3 py-3">
          {hasPrice ? (
            <>
              <div className={`text-sm font-bold ${pnlColor(h.pnl_pct)}`}>{h.pnl_pct >= 0 ? '+' : ''}{h.pnl_pct.toFixed(2)}%</div>
              <div className={`text-xs font-mono ${pnlColor(h.pnl_abs)}`}>{h.pnl_abs >= 0 ? '+' : ''}{cc}{fmt(Math.abs(h.pnl_abs), 0)}</div>
            </>
          ) : <span className="text-slate-600 text-xs">—</span>}
        </td>
        {/* Invested */}
        <td className="px-3 py-3 text-xs font-mono text-slate-400 hidden xl:table-cell">{cc}{fmt(h.invested_value, 0)}</td>
        {/* Current Value */}
        <td className="px-3 py-3 text-xs font-mono text-slate-300 hidden xl:table-cell">{hasPrice ? cc + fmt(h.current_value, 0) : '—'}</td>
        {/* Weight */}
        <td className="px-3 py-3 hidden lg:table-cell">
          <div className="flex items-center gap-1.5">
            <div className="w-10 bg-dark-800 rounded-full h-1.5">
              <div className="bg-brand-500 h-1.5 rounded-full" style={{ width: `${Math.min(h.portfolio_weight, 100)}%` }} />
            </div>
            <span className="text-xs text-slate-500">{h.portfolio_weight.toFixed(1)}%</span>
          </div>
        </td>
        {/* Zone */}
        <td className="px-3 py-3"><ZoneBadge zone={h.zone} /></td>
        {/* Risk */}
        <td className="px-3 py-3 hidden md:table-cell"><RiskBadge risk={h.risk_level} /></td>
        {/* Action */}
        <td className="px-3 py-3"><ActionBadge action={h.action} /></td>
        {/* Expand */}
        <td className="px-3 py-3 text-slate-500 text-xs">{expanded ? '▲' : '▼'}</td>
      </tr>

      {expanded && (
        <tr className="bg-dark-800/40 border-b border-slate-800/30">
          <td colSpan={13} className="px-4 py-4">
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {/* Zone Analysis */}
              <div className="bg-dark-700 rounded-xl p-4">
                <div className="text-xs font-semibold text-slate-400 mb-2">Zone Analysis</div>
                <ZoneBadge zone={h.zone} />
                <div className="mt-2 text-xs text-slate-400 leading-relaxed">{h.zone_reason}</div>
                {h.zone_low > 0 && (
                  <div className="mt-2 flex gap-3 text-xs">
                    <span className="text-slate-500">Zone:</span>
                    <span className="text-emerald-400">{h.currency === 'USD' ? '$' : '₹'}{fmt(h.zone_low)} – {h.currency === 'USD' ? '$' : '₹'}{fmt(h.zone_high)}</span>
                  </div>
                )}
                {h.key_support > 0 && (
                  <div className="mt-1 flex gap-3 text-xs">
                    <span className="text-slate-500">Support:</span>
                    <span className="text-emerald-400">{h.currency === 'USD' ? '$' : '₹'}{fmt(h.key_support)}</span>
                    <span className="text-slate-500">Resistance:</span>
                    <span className="text-red-400">{h.currency === 'USD' ? '$' : '₹'}{fmt(h.key_resistance)}</span>
                  </div>
                )}
              </div>

              {/* Action */}
              <div className="bg-dark-700 rounded-xl p-4">
                <div className="text-xs font-semibold text-slate-400 mb-2">Action Engine</div>
                <div className="flex items-center gap-2 mb-2">
                  <ActionBadge action={h.action} />
                  <RiskBadge risk={h.risk_level} />
                </div>
                <div className="text-xs text-slate-400 leading-relaxed">{h.action_reason}</div>
              </div>

              {/* Technical Snapshot */}
              <div className="bg-dark-700 rounded-xl p-4">
                <div className="text-xs font-semibold text-slate-400 mb-2">Technical Snapshot</div>
                <div className="grid grid-cols-2 gap-2">
                  {[
                    { label: 'RSI', value: h.rsi > 0 ? h.rsi.toFixed(1) : '—', color: h.rsi < 35 ? 'text-emerald-400' : h.rsi > 65 ? 'text-red-400' : 'text-amber-400' },
                    { label: 'MACD Hist', value: h.macd_hist !== 0 ? h.macd_hist.toFixed(3) : '—', color: h.macd_hist > 0 ? 'text-emerald-400' : 'text-red-400' },
                    { label: 'Trend', value: h.trend || '—', color: h.trend === 'UP' ? 'text-emerald-400' : h.trend === 'DOWN' ? 'text-red-400' : 'text-amber-400' },
                    { label: 'Tech Score', value: h.technical_score > 0 ? h.technical_score.toFixed(0) + '/100' : '—', color: h.technical_score >= 65 ? 'text-emerald-400' : h.technical_score >= 45 ? 'text-amber-400' : 'text-red-400' },
                  ].map(item => (
                    <div key={item.label} className="bg-dark-800/60 rounded p-2">
                      <div className="text-xs text-slate-500">{item.label}</div>
                      <div className={`text-sm font-mono font-bold ${item.color}`}>{item.value}</div>
                    </div>
                  ))}
                </div>
                <button
                  className="mt-3 text-xs text-brand-400 hover:text-brand-300 underline"
                  onClick={(e) => { e.stopPropagation(); onNavigate(h.yf_symbol) }}
                >
                  View full chart & analysis →
                </button>
              </div>
            </div>

            {/* Buy / Sell buttons */}
            <div className="flex gap-3 mt-4 pt-4 border-t border-slate-800/40">
              <button
                onClick={(e) => { e.stopPropagation(); setTradeModal('buy') }}
                className="flex-1 py-2 bg-emerald-600/20 border border-emerald-500/40 text-emerald-400 rounded-lg text-xs font-bold hover:bg-emerald-600/30 transition-colors"
              >
                + Buy More
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); setTradeModal('sell') }}
                className="flex-1 py-2 bg-red-600/20 border border-red-500/40 text-red-400 rounded-lg text-xs font-bold hover:bg-red-600/30 transition-colors"
              >
                − Sell / Reduce
              </button>
            </div>
          </td>
        </tr>
      )}

      {tradeModal && (
        <TradeModal
          h={h}
          mode={tradeModal}
          onClose={() => setTradeModal(null)}
          onDone={() => { setTradeModal(null); onRefresh() }}
        />
      )}
    </>
  )
}

// ── Summary Card ──────────────────────────────────────────────────────────────

function SummaryCard({ label, value, sub, color = 'text-white', icon }: {
  label: string; value: string; sub?: string; color?: string; icon: string
}) {
  return (
    <div className="bg-dark-700 border border-slate-800/60 rounded-xl p-4">
      <div className="text-xl mb-1">{icon}</div>
      <div className={`text-2xl font-bold font-mono ${color}`}>{value}</div>
      {sub && <div className={`text-sm ${pnlColor(parseFloat(sub))}`}>{parseFloat(sub) >= 0 ? '+' : ''}{sub}</div>}
      <div className="text-xs text-slate-500 mt-1">{label}</div>
    </div>
  )
}

// ── Undervalued Stocks Section ────────────────────────────────────────────────

const ACTION_BADGE: Record<string, { label: string; color: string; bg: string }> = {
  ADD_MORE: { label: 'ADD MORE',  color: 'text-emerald-300', bg: 'bg-emerald-500/20' },
  NEW_BUY:  { label: 'NEW BUY',  color: 'text-blue-300',    bg: 'bg-blue-500/20' },
  WATCH:    { label: 'WATCH',    color: 'text-amber-300',   bg: 'bg-amber-500/15' },
}

function UndervaluedSection() {
  const [stocks, setStocks] = useState<UndervaluedStock[]>([])
  const [loading, setLoading] = useState(true)
  const [market, setMarket] = useState<'all' | 'NSE' | 'US'>('all')

  useEffect(() => {
    setLoading(true)
    getUndervaluedStocks(market === 'all' ? undefined : market)
      .then(d => setStocks(d.undervalued ?? []))
      .catch(() => setStocks([]))
      .finally(() => setLoading(false))
  }, [market])

  if (loading) return <LoadingSpinner size="sm" text="Scanning for undervalued stocks..." />

  return (
    <div>
      {/* Sub-filters */}
      <div className="flex items-center justify-between mb-4">
        <div className="text-sm text-slate-400">
          {stocks.length} undervalued stocks identified using P/E, P/B, EPS Growth, ROE and Technical filters
        </div>
        <div className="flex gap-1 bg-dark-800 rounded-xl p-1">
          {(['all', 'NSE', 'US'] as const).map(m => (
            <button key={m} onClick={() => setMarket(m)}
              className={`px-4 py-1.5 rounded-lg text-xs font-medium transition-all ${market === m ? 'bg-brand-600 text-white' : 'text-slate-400 hover:text-slate-200'}`}>
              {m === 'all' ? 'All' : m}
            </button>
          ))}
        </div>
      </div>

      {stocks.length === 0 ? (
        <div className="text-slate-500 text-sm py-12 text-center bg-dark-700 border border-slate-800/60 rounded-xl">
          No clearly undervalued stocks found at current prices. Market may be fairly/over-valued.
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {stocks.map(s => {
            const actionCfg = ACTION_BADGE[s.portfolio_action] ?? ACTION_BADGE.WATCH
            const cc = s.market === 'US' ? '$' : '₹'
            return (
              <div key={s.symbol} className={`bg-dark-700 border rounded-xl p-4 hover:border-slate-600 transition-colors ${s.in_portfolio ? 'border-emerald-700/50' : 'border-slate-800/60'}`}>
                {/* Header */}
                <div className="flex items-start justify-between mb-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-bold text-white text-sm">{s.symbol}</span>
                      {s.in_portfolio && <span className="text-xs text-emerald-500 bg-emerald-500/10 px-1.5 py-0.5 rounded border border-emerald-500/30">In Portfolio</span>}
                    </div>
                    <div className="text-xs text-slate-500 truncate max-w-[160px] mt-0.5">{s.name || s.symbol}</div>
                    <div className="text-xs text-slate-600">{s.sector} · {s.market}</div>
                  </div>
                  <span className={`text-xs font-bold px-2 py-0.5 rounded ${actionCfg.bg} ${actionCfg.color}`}>
                    {actionCfg.label}
                  </span>
                </div>

                {/* Price + upside */}
                <div className="flex items-center justify-between mb-3">
                  <div>
                    <div className="text-lg font-bold font-mono text-white">{cc}{s.current_price.toLocaleString()}</div>
                    <div className="text-xs text-slate-500">Current Price</div>
                  </div>
                  {s.fair_value_est > s.current_price && (
                    <div className="text-right">
                      <div className="text-sm font-bold text-emerald-400">+{s.upside_pct.toFixed(1)}%</div>
                      <div className="text-xs text-slate-500">Est. Upside</div>
                      <div className="text-xs text-slate-600 font-mono">{cc}{s.fair_value_est.toLocaleString()}</div>
                    </div>
                  )}
                </div>

                {/* Key metrics grid */}
                <div className="grid grid-cols-3 gap-1.5 mb-3">
                  {[
                    { label: 'P/E', value: s.pe_ratio > 0 ? s.pe_ratio.toFixed(1) : '—', color: s.pe_ratio > 0 && s.pe_ratio < 20 ? 'text-emerald-400' : 'text-slate-300' },
                    { label: 'P/B', value: s.price_to_book > 0 ? s.price_to_book.toFixed(1) : '—', color: s.price_to_book > 0 && s.price_to_book < 2 ? 'text-emerald-400' : 'text-slate-300' },
                    { label: 'ROE%', value: s.roe_pct > 0 ? s.roe_pct.toFixed(0)+'%' : '—', color: s.roe_pct >= 15 ? 'text-emerald-400' : 'text-slate-300' },
                    { label: 'EPS%', value: s.eps_growth_pct !== 0 ? (s.eps_growth_pct > 0 ? '+' : '') + s.eps_growth_pct.toFixed(0)+'%' : '—', color: s.eps_growth_pct > 10 ? 'text-emerald-400' : s.eps_growth_pct < 0 ? 'text-red-400' : 'text-slate-300' },
                    { label: 'D/E', value: s.debt_equity > 0 ? s.debt_equity.toFixed(2) : '—', color: s.debt_equity < 0.5 ? 'text-emerald-400' : s.debt_equity > 2 ? 'text-red-400' : 'text-slate-300' },
                    { label: 'RSI', value: s.rsi > 0 ? s.rsi.toFixed(0) : '—', color: s.rsi < 35 ? 'text-emerald-400' : s.rsi > 70 ? 'text-red-400' : 'text-amber-400' },
                  ].map(item => (
                    <div key={item.label} className="bg-dark-800/60 rounded p-1.5 text-center">
                      <div className="text-xs text-slate-500">{item.label}</div>
                      <div className={`text-xs font-mono font-bold ${item.color}`}>{item.value}</div>
                    </div>
                  ))}
                </div>

                {/* Value score */}
                <div className="mb-3">
                  <div className="flex justify-between text-xs mb-1">
                    <span className="text-slate-500">Value Score</span>
                    <span className={`font-bold ${s.value_score >= 70 ? 'text-emerald-400' : s.value_score >= 50 ? 'text-amber-400' : 'text-slate-400'}`}>
                      {s.value_score.toFixed(0)}/100
                    </span>
                  </div>
                  <div className="w-full bg-dark-800 rounded-full h-1.5">
                    <div
                      className={`h-1.5 rounded-full ${s.value_score >= 70 ? 'bg-emerald-500' : s.value_score >= 50 ? 'bg-amber-500' : 'bg-slate-600'}`}
                      style={{ width: `${Math.min(s.value_score, 100)}%` }}
                    />
                  </div>
                </div>

                {/* Why undervalued */}
                {s.reasons && s.reasons.length > 0 && (
                  <div className="text-xs text-slate-400 leading-relaxed border-t border-slate-800/40 pt-2">
                    {s.reasons.slice(0, 2).map((r, i) => (
                      <div key={i} className="flex items-start gap-1 mb-0.5">
                        <span className="text-emerald-500 mt-0.5 shrink-0">✓</span>
                        <span>{r}</span>
                      </div>
                    ))}
                    {s.reasons.length > 2 && (
                      <div className="text-slate-600 text-xs mt-1">+{s.reasons.length - 2} more reasons</div>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ── Main Portfolio Page ────────────────────────────────────────────────────────

type ViewTab = 'all' | 'india' | 'us' | 'alerts' | 'sectors' | 'undervalued'
type SortKey = 'pnl_pct' | 'invested_value' | 'portfolio_weight' | 'symbol' | 'zone'

export default function Portfolio() {
  const navigate = useNavigate()
  const [data, setData] = useState<PortfolioData | null>(null)
  const [loading, setLoading] = useState(false)
  const [tab, setTab] = useState<ViewTab>('all')
  const [sortKey, setSortKey] = useState<SortKey>('portfolio_weight')
  const [sortAsc, setSortAsc] = useState(false)

  // ── Auth state ────────────────────────────────────────────────────────────
  const [locked, setLocked] = useState(!getPortfolioToken())
  const [password, setPassword] = useState('')
  const [authError, setAuthError] = useState('')
  const [authLoading, setAuthLoading] = useState(false)

  const fetchPortfolio = () => {
    setLoading(true)
    getPortfolio()
      .then(setData)
      .catch((err) => {
        if (err?.response?.status === 401) {
          setPortfolioToken(null)
          setLocked(true)
        } else {
          console.error(err)
        }
      })
      .finally(() => setLoading(false))
  }

  // On mount: if already unlocked (returning to the page), fetch immediately
  useEffect(() => {
    if (!locked) fetchPortfolio()
  }, [])

  const handleUnlock = async (e: React.FormEvent) => {
    e.preventDefault()
    setAuthError('')
    setAuthLoading(true)
    try {
      const token = await unlockPortfolio(password)
      setPortfolioToken(token)
      // Fetch data while still showing the lock screen, then flip in one render
      const portfolioData = await getPortfolio()
      setData(portfolioData)
      setPassword('')
      setLocked(false)
    } catch (err: any) {
      setAuthError(err?.response?.data?.error ?? 'Incorrect password')
    } finally {
      setAuthLoading(false)
    }
  }

  const holdings = useMemo(() => {
    if (!data) return []
    let list = [...data.holdings]
    if (tab === 'india') list = list.filter(h => h.market === 'NSE')
    if (tab === 'us') list = list.filter(h => h.market === 'US')
    if (tab === 'alerts') list = list.filter(h => h.has_alert)

    list.sort((a, b) => {
      let va: number | string = a[sortKey as keyof HoldingMetrics] as number | string
      let vb: number | string = b[sortKey as keyof HoldingMetrics] as number | string
      if (typeof va === 'string' && typeof vb === 'string') {
        return sortAsc ? va.localeCompare(vb) : vb.localeCompare(va)
      }
      return sortAsc ? (va as number) - (vb as number) : (vb as number) - (va as number)
    })
    return list
  }, [data, tab, sortKey, sortAsc])

  if (locked) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-dark-900">
        <div className="w-full max-w-sm bg-dark-800 border border-slate-700/60 rounded-2xl p-8 shadow-2xl">
          <div className="flex flex-col items-center gap-3 mb-8">
            <div className="w-14 h-14 rounded-full bg-brand-600/20 border border-brand-600/40 flex items-center justify-center">
              <svg className="w-7 h-7 text-brand-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 10-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H6.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z" />
              </svg>
            </div>
            <div className="text-center">
              <h2 className="text-white font-semibold text-lg">Portfolio is locked</h2>
              <p className="text-slate-400 text-sm mt-1">Enter your password to view your holdings</p>
            </div>
          </div>
          <form onSubmit={handleUnlock} className="flex flex-col gap-4">
            <input
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder="Password"
              autoFocus
              className="w-full px-4 py-3 rounded-lg bg-dark-700 border border-slate-600/60 text-white placeholder-slate-500 focus:outline-none focus:border-brand-500/60 focus:ring-1 focus:ring-brand-500/30 text-sm"
            />
            {authError && (
              <p className="text-red-400 text-xs text-center">{authError}</p>
            )}
            <button
              type="submit"
              disabled={authLoading || !password}
              className="w-full py-3 rounded-lg bg-brand-600 hover:bg-brand-500 disabled:opacity-50 disabled:cursor-not-allowed text-white font-medium text-sm transition-colors"
            >
              {authLoading ? 'Loading…' : 'Unlock Portfolio'}
            </button>
          </form>
        </div>
      </div>
    )
  }

  if (loading) return <LoadingSpinner size="lg" text="Computing portfolio analysis..." />
  if (!data) return <div className="text-slate-400 text-center py-12">Failed to load portfolio</div>

  const { summary, sector_breakdown, alerts } = data
  const nseHoldings = data.holdings.filter(h => h.market === 'NSE')
  const usHoldings = data.holdings.filter(h => h.market === 'US')

  const handleSort = (key: SortKey) => {
    if (sortKey === key) setSortAsc(a => !a)
    else { setSortKey(key); setSortAsc(false) }
  }

  const SortTh = ({ label, k }: { label: string; k: SortKey }) => (
    <th
      className="px-3 py-3 text-left text-xs text-slate-500 cursor-pointer hover:text-slate-300 select-none whitespace-nowrap"
      onClick={() => handleSort(k)}
    >
      {label}{sortKey === k ? (sortAsc ? ' ▲' : ' ▼') : ''}
    </th>
  )

  return (
    <div className="max-w-screen-2xl mx-auto px-4 sm:px-6 py-8">
      {/* Header */}
      <div className="flex items-start justify-between mb-8">
        <div>
          <div className="flex items-center gap-3 mb-1">
            <h1 className="text-2xl font-bold text-white">My Portfolio</h1>
            <span className="text-xs bg-dark-700 border border-slate-700 px-2 py-0.5 rounded text-slate-400">
              {summary.holdings_count} positions
            </span>
          </div>
          <p className="text-slate-500 text-sm">
            Updated {new Date(data.generated_at).toLocaleString()} · {summary.gainers_count} gainers · {summary.losers_count} losers
          </p>
        </div>
        <button
          onClick={() => { setLoading(true); getPortfolio().then(setData).finally(() => setLoading(false)) }}
          className="text-xs text-brand-400 border border-brand-600/30 px-3 py-1.5 rounded-lg hover:bg-brand-600/10"
        >
          ↻ Refresh
        </button>
      </div>

      {/* Summary tiles — INR */}
      <div className="mb-3">
        <div className="text-xs font-semibold text-slate-500 mb-2 uppercase tracking-wide">India Portfolio (₹)</div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
          <SummaryCard icon="💼" label="Total Invested" value={'₹' + fmt(summary.total_invested_inr, 0)} color="text-white" />
          <SummaryCard icon="📊" label="Current Value" value={'₹' + fmt(summary.total_current_inr, 0)} color="text-white" />
          <SummaryCard
            icon={summary.total_pnl_inr >= 0 ? '📈' : '📉'}
            label="Total P&L"
            value={'₹' + (summary.total_pnl_inr >= 0 ? '+' : '') + fmt(summary.total_pnl_inr, 0)}
            sub={summary.total_pnl_pct.toFixed(2) + '%'}
            color={summary.total_pnl_inr >= 0 ? 'text-emerald-400' : 'text-red-400'}
          />
          <div className="bg-dark-700 border border-slate-800/60 rounded-xl p-4">
            <div className="text-xl mb-1">🏆</div>
            <div className="text-xs text-emerald-400 mb-1 truncate">{summary.best_performer || '—'}</div>
            <div className="text-xs text-red-400 truncate">{summary.worst_performer || '—'}</div>
            <div className="text-xs text-slate-500 mt-1">Best / Worst</div>
          </div>
        </div>
      </div>

      {/* Summary tiles — USD */}
      {summary.total_invested_usd > 0 && (
        <div className="mb-6">
          <div className="text-xs font-semibold text-slate-500 mb-2 uppercase tracking-wide">US Portfolio ($)</div>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            <SummaryCard icon="💼" label="Total Invested" value={'$' + fmt(summary.total_invested_usd, 2)} color="text-white" />
            <SummaryCard icon="📊" label="Current Value" value={'$' + fmt(summary.total_current_usd, 2)} color="text-white" />
            <SummaryCard
              icon={summary.total_pnl_usd >= 0 ? '📈' : '📉'}
              label="Total P&L"
              value={'$' + (summary.total_pnl_usd >= 0 ? '+' : '') + fmt(summary.total_pnl_usd, 2)}
              sub={summary.total_pnl_pct_usd.toFixed(2) + '%'}
              color={summary.total_pnl_usd >= 0 ? 'text-emerald-400' : 'text-red-400'}
            />
          </div>
        </div>
      )}

      {/* Alert Banners */}
      <AlertBanner alerts={alerts} />

      {/* Tabs */}
      <div className="flex gap-2 mb-5 flex-wrap">
        {([
          ['all',         `All (${data.holdings.length})`],
          ['india',       `India (${nseHoldings.length})`],
          ['us',          `US (${usHoldings.length})`],
          ['alerts',      `Alerts (${alerts?.length ?? 0})`],
          ['sectors',     'Sectors'],
          ['undervalued', 'Undervalued'],
        ] as [ViewTab, string][]).map(([t, label]) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-2 rounded-xl text-sm font-medium transition-all ${
              tab === t
                ? 'bg-brand-600 text-white'
                : 'bg-dark-700 text-slate-400 border border-slate-800/60 hover:text-slate-200'
            }`}
          >
            {label}
            {t === 'alerts' && (alerts?.length ?? 0) > 0 && (
              <span className="ml-1 w-4 h-4 bg-red-500 text-white text-xs rounded-full inline-flex items-center justify-center">
                {alerts.length}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Undervalued tab */}
      {tab === 'undervalued' && (
        <div className="bg-dark-700 border border-slate-800/60 rounded-xl p-6">
          <div className="flex items-center gap-3 mb-4">
            <span className="text-2xl">💎</span>
            <div>
              <h2 className="text-lg font-bold text-white">Undervalued Stocks</h2>
              <p className="text-xs text-slate-500">
                Stocks trading below estimated fair value — candidates for 5–10 year accumulation.
                Filter: P/E &lt; 25, P/B &lt; 2.5, ROE &gt; 10%, D/E &lt; 1.5, positive EPS growth.
              </p>
            </div>
          </div>
          <UndervaluedSection />
        </div>
      )}

      {/* Sector Breakdown tab */}
      {tab === 'sectors' && (
        <div className="space-y-6">
          <div className="bg-dark-700 border border-slate-800/60 rounded-xl p-6">
            <SectorBreakdown sectors={sector_breakdown} market="NSE" />
          </div>
          {summary.total_invested_usd > 0 && (
            <div className="bg-dark-700 border border-slate-800/60 rounded-xl p-6">
              <SectorBreakdown sectors={sector_breakdown} market="US" />
            </div>
          )}
          <div className="bg-dark-700 border border-slate-800/60 rounded-xl overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-slate-500 border-b border-slate-800/60">
                  {['Sector', 'Market', 'Stocks', 'Invested', 'Current Value', 'P&L %', 'Allocation %', 'Flag'].map(h => (
                    <th key={h} className="px-4 py-3 text-left">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sector_breakdown.map((s, i) => (
                  <tr key={i} className="border-b border-slate-800/20 hover:bg-dark-600/40">
                    <td className="px-4 py-3 font-semibold text-white">{s.sector}</td>
                    <td className="px-4 py-3 text-slate-400">{s.market}</td>
                    <td className="px-4 py-3 text-slate-300">{s.stock_count}</td>
                    <td className="px-4 py-3 font-mono text-slate-300">{s.market === 'US' ? '$' : '₹'}{fmt(s.invested_value, 0)}</td>
                    <td className="px-4 py-3 font-mono text-slate-300">{s.current_value > 0 ? (s.market === 'US' ? '$' : '₹') + fmt(s.current_value, 0) : '—'}</td>
                    <td className={`px-4 py-3 font-bold ${pnlColor(s.pnl_pct)}`}>{s.pnl_pct >= 0 ? '+' : ''}{s.pnl_pct.toFixed(2)}%</td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <div className="w-16 bg-dark-800 rounded-full h-1.5">
                          <div className="bg-brand-500 h-1.5 rounded-full" style={{ width: `${Math.min(s.allocation_pct, 100)}%` }} />
                        </div>
                        <span className="text-xs text-slate-400">{s.allocation_pct.toFixed(1)}%</span>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      {s.over_exposed && (
                        <span className="text-xs text-orange-400 bg-orange-500/10 border border-orange-500/30 px-2 py-0.5 rounded">⚠️ Over-exposed</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Holdings Table */}
      {tab !== 'sectors' && tab !== 'undervalued' && (
        <>
          {holdings.length === 0 ? (
            <div className="text-slate-500 text-sm py-12 text-center bg-dark-700 border border-slate-800/60 rounded-xl">
              No holdings in this view.
            </div>
          ) : (
            <div className="bg-dark-700 border border-slate-800/60 rounded-xl overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-sm min-w-[900px]">
                  <thead>
                    <tr className="text-xs text-slate-500 border-b border-slate-800/60">
                      <SortTh label="Symbol" k="symbol" />
                      <th className="px-3 py-3 text-left text-xs text-slate-500 hidden lg:table-cell">Sector</th>
                      <th className="px-3 py-3 text-left text-xs text-slate-500">Qty</th>
                      <th className="px-3 py-3 text-left text-xs text-slate-500">Avg Buy</th>
                      <th className="px-3 py-3 text-left text-xs text-slate-500">LTP</th>
                      <SortTh label="P&L %" k="pnl_pct" />
                      <SortTh label="Invested" k="invested_value" />
                      <th className="px-3 py-3 text-left text-xs text-slate-500 hidden xl:table-cell">Cur. Value</th>
                      <SortTh label="Weight" k="portfolio_weight" />
                      <SortTh label="Zone" k="zone" />
                      <th className="px-3 py-3 text-left text-xs text-slate-500 hidden md:table-cell">Risk</th>
                      <SortTh label="Action" k="zone" />
                      <th className="px-3 py-3 text-xs text-slate-500"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {holdings.map(h => (
                      <HoldingRow
                        key={h.symbol}
                        h={h}
                        onNavigate={(sym) => navigate(`/stock/${encodeURIComponent(sym)}`)}
                        onRefresh={() => { setLoading(true); getPortfolio().then(setData).finally(() => setLoading(false)) }}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Mini sector strip at bottom */}
          {(tab === 'all' || tab === 'india') && (
            <div className="mt-4 bg-dark-700 border border-slate-800/60 rounded-xl p-4">
              <SectorBreakdown sectors={sector_breakdown} market="NSE" />
            </div>
          )}
          {(tab === 'all' || tab === 'us') && summary.total_invested_usd > 0 && (
            <div className="mt-4 bg-dark-700 border border-slate-800/60 rounded-xl p-4">
              <SectorBreakdown sectors={sector_breakdown} market="US" />
            </div>
          )}
        </>
      )}
    </div>
  )
}
