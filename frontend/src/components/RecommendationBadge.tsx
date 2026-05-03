import type { Recommendation } from '../types'

interface Props {
  recType: Recommendation['rec_type']
  confidence?: number
  size?: 'sm' | 'md' | 'lg'
}

const config = {
  strong_buy: { label: 'STRONG BUY', bg: 'bg-emerald-500/20', text: 'text-emerald-400', border: 'border-emerald-500/40', glow: 'glow-green' },
  buy:        { label: 'BUY',         bg: 'bg-green-500/15',  text: 'text-green-400',   border: 'border-green-500/30',   glow: 'glow-green' },
  hold:       { label: 'HOLD',        bg: 'bg-amber-500/15',  text: 'text-amber-400',   border: 'border-amber-500/30',   glow: 'glow-yellow' },
  sell:       { label: 'SELL',        bg: 'bg-red-500/15',    text: 'text-red-400',     border: 'border-red-500/30',     glow: 'glow-red' },
  strong_sell:{ label: 'STRONG SELL', bg: 'bg-red-500/25',    text: 'text-red-300',     border: 'border-red-500/50',     glow: 'glow-red' },
}

const padding = { sm: 'px-2 py-0.5 text-xs', md: 'px-3 py-1 text-xs', lg: 'px-4 py-1.5 text-sm' }

export default function RecommendationBadge({ recType, confidence, size = 'md' }: Props) {
  const c = config[recType] ?? config.hold
  return (
    <span className={`inline-flex items-center gap-1.5 font-semibold rounded-full border ${c.bg} ${c.text} ${c.border} ${c.glow} ${padding[size]}`}>
      {c.label}
      {confidence !== undefined && (
        <span className="opacity-70 font-normal">{confidence.toFixed(0)}%</span>
      )}
    </span>
  )
}
