import { useNavigate } from 'react-router-dom'
import type { Recommendation } from '../types'
import RecommendationBadge from './RecommendationBadge'

interface Props {
  rec: Recommendation
}

function fmtNum(n: number | null | undefined, dec = 2) {
  if (n == null) return '—'
  return n.toLocaleString('en-IN', { minimumFractionDigits: dec, maximumFractionDigits: dec })
}

function fmtPct(n: number | null | undefined) {
  if (n == null) return '—'
  return `${n >= 0 ? '+' : ''}${n.toFixed(1)}%`
}

export default function StockCard({ rec }: Props) {
  const navigate = useNavigate()
  const stock = rec.stock

  const upside = rec.entry_price > 0
    ? ((rec.target_price - rec.entry_price) / rec.entry_price) * 100
    : null
  const downside = rec.entry_price > 0
    ? ((rec.stop_loss - rec.entry_price) / rec.entry_price) * 100
    : null

  return (
    <div
      className="stock-card bg-dark-700 border border-slate-800/60 rounded-xl p-4 cursor-pointer hover:border-brand-600/40"
      onClick={() => navigate(`/stock/${rec.stock?.symbol ?? ''}`)}
    >
      {/* Header */}
      <div className="flex items-start justify-between mb-3">
        <div>
          <div className="font-semibold text-white text-sm">{stock?.symbol ?? `Stock #${rec.stock_id}`}</div>
          <div className="text-xs text-slate-500 mt-0.5 truncate max-w-[140px]">{stock?.name ?? stock?.sector}</div>
        </div>
        <RecommendationBadge recType={rec.rec_type} confidence={rec.confidence} size="sm" />
      </div>

      {/* Prices */}
      <div className="grid grid-cols-3 gap-2 mb-3 text-center">
        <div>
          <div className="text-xs text-slate-500 mb-0.5">Entry</div>
          <div className="text-sm font-mono font-medium text-slate-300">{fmtNum(rec.entry_price)}</div>
        </div>
        <div>
          <div className="text-xs text-slate-500 mb-0.5">Target</div>
          <div className="text-sm font-mono font-medium text-emerald-400">{fmtNum(rec.target_price)}</div>
        </div>
        <div>
          <div className="text-xs text-slate-500 mb-0.5">Stop</div>
          <div className="text-sm font-mono font-medium text-red-400">{fmtNum(rec.stop_loss)}</div>
        </div>
      </div>

      {/* Upside / Downside */}
      <div className="flex items-center gap-3 mb-3 text-xs">
        <span className="text-emerald-400">▲ {fmtPct(upside)}</span>
        <span className="text-red-400">▼ {fmtPct(downside)}</span>
        <span className="ml-auto text-slate-500">RR: {fmtNum(rec.risk_reward, 1)}x</span>
      </div>

      {/* Scores */}
      <div className="space-y-1.5">
        <div className="flex items-center gap-2">
          <span className="text-xs text-slate-500 w-16">Tech</span>
          <div className="flex-1 bg-dark-800 rounded-full h-1.5">
            <div
              className="h-1.5 rounded-full bg-brand-500"
              style={{ width: `${rec.technical_score}%` }}
            />
          </div>
          <span className="text-xs font-mono text-slate-400 w-8">{rec.technical_score.toFixed(0)}</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-slate-500 w-16">Fund</span>
          <div className="flex-1 bg-dark-800 rounded-full h-1.5">
            <div
              className="h-1.5 rounded-full bg-purple-500"
              style={{ width: `${rec.fundamental_score}%` }}
            />
          </div>
          <span className="text-xs font-mono text-slate-400 w-8">{rec.fundamental_score.toFixed(0)}</span>
        </div>
      </div>

      {/* Footer */}
      <div className="mt-3 pt-3 border-t border-slate-800/60 flex items-center justify-between text-xs text-slate-500">
        <span className="capitalize">{rec.horizon} · {rec.risk_level} risk</span>
        <span>{new Date(rec.date).toLocaleDateString()}</span>
      </div>
    </div>
  )
}
