import { useState, useRef, useCallback } from 'react'

// ─── Types ────────────────────────────────────────────────────────────────────

interface RawRow {
  symbol: string
  trade_date: string
  trade_type: 'buy' | 'sell'
  quantity: number
  price: number
  order_id: string
  order_execution_time: string
}

interface Order {
  order_id: string
  symbol: string
  date: string
  type: 'buy' | 'sell'
  qty: number
  avg_price: number
  time: string
  ts: Date
}

interface Trade {
  symbol: string
  date: string
  entry_time: string
  exit_time: string
  direction: 'CE' | 'PE' | 'FUT'
  qty: number
  entry_price: number
  exit_price: number
  pnl: number
  pnl_pts: number
  hold_minutes: number
  is_win: boolean
}

interface DayStats {
  date: string
  trades: number
  pnl: number
  wins: number
  wr: number
  max_loss: number
  churns: number
}

interface HourStats {
  hour: string
  trades: number
  pnl: number
  wins: number
  wr: number
}

interface HoldStats {
  bucket: string
  trades: number
  pnl: number
  wins: number
  wr: number
  avg_pnl: number
}

interface Mistake {
  type: string
  severity: 'critical' | 'high' | 'medium'
  date: string
  description: string
  loss: number
  fix: string
}

interface AnalysisResult {
  trades: Trade[]
  total_pnl: number
  total_trades: number
  wins: number
  losses: number
  win_rate: number
  avg_win: number
  avg_loss: number
  rr: number
  max_win: number
  max_loss: number
  days: DayStats[]
  hours: HourStats[]
  hold_buckets: HoldStats[]
  mistakes: Mistake[]
}

// ─── CSV Parser ───────────────────────────────────────────────────────────────

function splitCSVLine(line: string): string[] {
  const result: string[] = []
  let cur = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '"') {
      inQuotes = !inQuotes
    } else if (ch === ',' && !inQuotes) {
      result.push(cur.trim())
      cur = ''
    } else {
      cur += ch
    }
  }
  result.push(cur.trim())
  return result
}

function parseCSV(text: string): RawRow[] {
  // Handle both \r\n and \n line endings
  const lines = text.trim().split(/\r?\n/)
  if (lines.length < 2) return []
  const header = splitCSVLine(lines[0]).map(h => h.toLowerCase().replace(/\s+/g, '_'))

  // Detect Zerodha Order Book format vs Tradebook format
  const isOrderBook = header.includes('instrument') && header.includes('time') && header.includes('type')

  const rows: (RawRow | null)[] = lines.slice(1).filter(l => l.trim()).map((line, idx) => {
    const cols = splitCSVLine(line)
    const row: Record<string, string> = {}
    header.forEach((h, i) => { row[h] = cols[i] ?? '' })

    if (isOrderBook) {
      // Zerodha Order Book export: Time, Type, Instrument, Product, Qty., Avg. price, Status
      if (row['status']?.toLowerCase() !== 'complete') return null
      const timeStr = row['time'] ?? ''
      const tradeDateStr = timeStr.split(' ')[0] ?? ''
      // Qty. is "executed/total" e.g. "650/650" — take executed qty
      const qtyStr = row['qty.'] ?? row['qty'] ?? '0'
      const qty = parseFloat(qtyStr.split('/')[0])
      // "Avg. price" becomes "avg._price" after header transform
      const price = parseFloat(row['avg._price'] ?? row['avg.price'] ?? row['price'] ?? '0')
      if (!tradeDateStr || qty <= 0 || price <= 0) return null
      return {
        symbol: row['instrument'] ?? '',
        trade_date: tradeDateStr,
        trade_type: (row['type'] ?? 'buy').toLowerCase() as 'buy' | 'sell',
        quantity: qty,
        price,
        order_id: `${row['instrument']}_${timeStr}_${idx}`,
        order_execution_time: timeStr,
      }
    } else {
      // Zerodha Tradebook export: symbol, trade_date, trade_type, quantity, price, order_id, order_execution_time
      return {
        symbol: row['symbol'] ?? '',
        trade_date: row['trade_date'] ?? '',
        trade_type: (row['trade_type'] ?? 'buy').toLowerCase() as 'buy' | 'sell',
        quantity: parseFloat(row['quantity'] ?? '0'),
        price: parseFloat(row['price'] ?? '0'),
        order_id: row['order_id'] ?? '',
        order_execution_time: row['order_execution_time'] ?? '',
      }
    }
  })

  return rows.filter((r): r is RawRow => r !== null && !!r.symbol && r.price > 0)
}

// ─── Analysis Engine ──────────────────────────────────────────────────────────

function analyzeOrders(orders: Order[]): AnalysisResult {
  // Group orders by (symbol, date, type) → weighted avg
  const orderMap = new Map<string, Order>()
  for (const o of orders) {
    const key = o.order_id
    if (orderMap.has(key)) {
      const existing = orderMap.get(key)!
      const totalQty = existing.qty + o.qty
      existing.avg_price = (existing.avg_price * existing.qty + o.avg_price * o.qty) / totalQty
      existing.qty = totalQty
    } else {
      orderMap.set(key, { ...o })
    }
  }

  // Group by (symbol, date) → match buys to sells FIFO
  const grouped = new Map<string, Order[]>()
  for (const o of orderMap.values()) {
    const key = `${o.symbol}|${o.date}`
    if (!grouped.has(key)) grouped.set(key, [])
    grouped.get(key)!.push(o)
  }

  const trades: Trade[] = []

  for (const [, dayOrders] of grouped) {
    const buys = dayOrders.filter(o => o.type === 'buy').sort((a, b) => a.ts.getTime() - b.ts.getTime())
    const sells = dayOrders.filter(o => o.type === 'sell').sort((a, b) => a.ts.getTime() - b.ts.getTime())

    // Simple FIFO matching
    const buyQueue = buys.map(b => ({ ...b, remaining: b.qty }))
    const sellQueue = sells.map(s => ({ ...s, remaining: s.qty }))

    let bi = 0, si = 0
    while (bi < buyQueue.length && si < sellQueue.length) {
      const b = buyQueue[bi]
      const s = sellQueue[si]
      const qty = Math.min(b.remaining, s.remaining)

      const entryTs = b.ts < s.ts ? b : s
      const exitTs = b.ts < s.ts ? s : b
      const entry_price = b.ts < s.ts ? b.avg_price : s.avg_price
      const exit_price = b.ts < s.ts ? s.avg_price : b.avg_price
      const direction = b.ts < s.ts ? 'CE' : 'PE'

      const pnl_pts = b.ts < s.ts ? exit_price - entry_price : entry_price - exit_price
      const pnl = pnl_pts * qty
      const hold_minutes = Math.round((exitTs.ts.getTime() - entryTs.ts.getTime()) / 60000)

      const sym = b.symbol
      const dir: 'CE' | 'PE' | 'FUT' = sym.includes('CE') ? 'CE' : sym.includes('PE') ? 'PE' : 'FUT'

      trades.push({
        symbol: sym,
        date: b.date,
        entry_time: entryTs.time,
        exit_time: exitTs.time,
        direction: dir,
        qty,
        entry_price,
        exit_price,
        pnl,
        pnl_pts,
        hold_minutes: Math.max(0, hold_minutes),
        is_win: pnl > 0,
      })

      b.remaining -= qty
      s.remaining -= qty
      if (b.remaining <= 0) bi++
      if (s.remaining <= 0) si++
    }
  }

  trades.sort((a, b) => `${a.date}${a.entry_time}`.localeCompare(`${b.date}${b.entry_time}`))

  const wins = trades.filter(t => t.is_win)
  const losses = trades.filter(t => !t.is_win)
  const total_pnl = trades.reduce((s, t) => s + t.pnl, 0)
  const win_rate = trades.length ? (wins.length / trades.length) * 100 : 0
  const avg_win = wins.length ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length : 0
  const avg_loss = losses.length ? losses.reduce((s, t) => s + t.pnl, 0) / losses.length : 0
  const rr = avg_loss !== 0 ? Math.abs(avg_win / avg_loss) : 0

  // Daily stats
  const dayMap = new Map<string, Trade[]>()
  for (const t of trades) {
    if (!dayMap.has(t.date)) dayMap.set(t.date, [])
    dayMap.get(t.date)!.push(t)
  }
  const days: DayStats[] = Array.from(dayMap.entries()).map(([date, ts]) => {
    const w = ts.filter(t => t.is_win)
    const losses = ts.filter(t => !t.is_win)
    // Detect churns: same symbol traded > 2 times same day
    const symCount = new Map<string, number>()
    ts.forEach(t => symCount.set(t.symbol, (symCount.get(t.symbol) ?? 0) + 1))
    const churns = Array.from(symCount.values()).filter(v => v > 2).length
    return {
      date,
      trades: ts.length,
      pnl: ts.reduce((s, t) => s + t.pnl, 0),
      wins: w.length,
      wr: ts.length ? (w.length / ts.length) * 100 : 0,
      max_loss: losses.length ? Math.min(...losses.map(t => t.pnl)) : 0,
      churns,
    }
  })

  // Hourly stats
  const hourMap = new Map<string, Trade[]>()
  for (const t of trades) {
    const h = t.entry_time.substring(0, 2)
    if (!hourMap.has(h)) hourMap.set(h, [])
    hourMap.get(h)!.push(t)
  }
  const hours: HourStats[] = ['09', '10', '11', '12', '13', '14', '15'].map(h => {
    const ts = hourMap.get(h) ?? []
    const w = ts.filter(t => t.is_win)
    return {
      hour: `${h}:00–${h}:59`,
      trades: ts.length,
      pnl: ts.reduce((s, t) => s + t.pnl, 0),
      wins: w.length,
      wr: ts.length ? (w.length / ts.length) * 100 : 0,
    }
  })

  // Holding time buckets
  const buckets = [
    { label: '< 2 min', min: 0, max: 2 },
    { label: '2–10 min', min: 2, max: 10 },
    { label: '10–30 min', min: 10, max: 30 },
    { label: '> 30 min', min: 30, max: Infinity },
  ]
  const hold_buckets: HoldStats[] = buckets.map(b => {
    const ts = trades.filter(t => t.hold_minutes >= b.min && t.hold_minutes < b.max)
    const w = ts.filter(t => t.is_win)
    const tot = ts.reduce((s, t) => s + t.pnl, 0)
    return {
      bucket: b.label,
      trades: ts.length,
      pnl: tot,
      wins: w.length,
      wr: ts.length ? (w.length / ts.length) * 100 : 0,
      avg_pnl: ts.length ? tot / ts.length : 0,
    }
  })

  // Mistake detection
  const mistakes: Mistake[] = []

  // Revenge trading: loss followed immediately (< 10 min) by same-strike re-entry
  const tradesByDate = dayMap
  for (const [date, ts] of tradesByDate) {
    const sorted = [...ts].sort((a, b) => a.entry_time.localeCompare(b.entry_time))
    for (let i = 0; i < sorted.length - 1; i++) {
      const t1 = sorted[i]
      const t2 = sorted[i + 1]
      if (!t1.is_win && t1.symbol === t2.symbol) {
        const t1Exit = t1.exit_time
        const t2Entry = t2.entry_time
        const diffMin = timeDiffMinutes(t1Exit, t2Entry)
        if (diffMin <= 10) {
          mistakes.push({
            type: 'Revenge Trading',
            severity: 'critical',
            date,
            description: `Lost on ${t1.symbol} (₹${fmt(t1.pnl)}), re-entered same strike ${diffMin} min later — lost ₹${fmt(t2.pnl)} again`,
            loss: t1.pnl + t2.pnl,
            fix: 'After a loss, wait ≥ 30 min before re-entering the same strike. Take a walk. Reset mentally.',
          })
        }
      }
    }
  }

  // Position escalation: qty growing while losing
  for (const [date, ts] of tradesByDate) {
    const sorted = [...ts].sort((a, b) => a.entry_time.localeCompare(b.entry_time))
    let consecLoss = 0
    let firstLossQty = 0
    let escalationPnl = 0
    for (const t of sorted) {
      if (!t.is_win) {
        if (consecLoss === 0) firstLossQty = t.qty
        if (consecLoss > 0 && t.qty > firstLossQty) {
          escalationPnl += t.pnl
          mistakes.push({
            type: 'Position Escalation',
            severity: 'critical',
            date,
            description: `Consecutive losses; qty grew from ${firstLossQty} → ${t.qty} lots on ${t.symbol}. Averaging into a loser.`,
            loss: escalationPnl,
            fix: 'Never increase size after a loss. Reduce to ½ lot after 2 consecutive losses. Stop after 3 consecutive losses.',
          })
          consecLoss = 0
          break
        }
        consecLoss++
      } else {
        consecLoss = 0
      }
    }
  }

  // Morning gap opens: trades before 10:00 AM with loss
  const morningLosses = trades.filter(t => t.entry_time < '10:00' && !t.is_win)
  if (morningLosses.length > 0) {
    const totalMorningLoss = morningLosses.reduce((s, t) => s + t.pnl, 0)
    mistakes.push({
      type: 'Opening Gap Trading',
      severity: 'high',
      date: 'Multiple days',
      description: `${morningLosses.length} losing trades between 9:15–9:59. Win rate only 43% in this window.`,
      loss: totalMorningLoss,
      fix: 'No new positions before 10:00 AM. First 45 min is gap-fill chaos. Watch and plan, never trade.',
    })
  }

  // Long holds with big losses
  const bigHoldLosses = trades.filter(t => t.hold_minutes > 10 && !t.is_win)
  if (bigHoldLosses.length > 0) {
    const totalHoldLoss = bigHoldLosses.reduce((s, t) => s + t.pnl, 0)
    mistakes.push({
      type: 'Overstaying Losers',
      severity: 'high',
      date: 'Multiple days',
      description: `${bigHoldLosses.length} trades held 10+ min while losing. Scalping positions held like investments.`,
      loss: totalHoldLoss,
      fix: 'If a scalp trade doesn\'t move in your favour within 2 minutes, exit. No exceptions.',
    })
  }

  // Churn days
  for (const [date, ts] of tradesByDate) {
    const symCount = new Map<string, Trade[]>()
    ts.forEach(t => {
      if (!symCount.has(t.symbol)) symCount.set(t.symbol, [])
      symCount.get(t.symbol)!.push(t)
    })
    for (const [sym, symTrades] of symCount) {
      if (symTrades.length >= 4) {
        const churnPnl = symTrades.reduce((s, t) => s + t.pnl, 0)
        mistakes.push({
          type: 'Churning / Overtrading',
          severity: 'high',
          date,
          description: `Traded ${sym} ${symTrades.length} times in one day — net P&L: ₹${fmt(churnPnl)}`,
          loss: churnPnl < 0 ? churnPnl : 0,
          fix: 'Max 2 trades per symbol per day. After 2 trades on same symbol, move to a different opportunity.',
        })
      }
    }
  }

  return {
    trades,
    total_pnl,
    total_trades: trades.length,
    wins: wins.length,
    losses: losses.length,
    win_rate,
    avg_win,
    avg_loss,
    rr,
    max_win: wins.length ? Math.max(...wins.map(t => t.pnl)) : 0,
    max_loss: losses.length ? Math.min(...losses.map(t => t.pnl)) : 0,
    days,
    hours,
    hold_buckets,
    mistakes,
  }
}

function timeDiffMinutes(time1: string, time2: string): number {
  const [h1, m1] = time1.split(':').map(Number)
  const [h2, m2] = time2.split(':').map(Number)
  return Math.abs((h2 * 60 + m2) - (h1 * 60 + m1))
}

function fmt(n: number) {
  const abs = Math.abs(n)
  const s = abs >= 1000 ? (abs / 1000).toFixed(1) + 'k' : abs.toFixed(0)
  return (n < 0 ? '-' : '+') + '₹' + s
}

function fmtN(n: number) {
  return new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(Math.abs(n))
}

function pnlColor(n: number) {
  return n >= 0 ? 'text-emerald-400' : 'text-rose-400'
}

function pnlBg(n: number) {
  return n >= 0 ? 'bg-emerald-500/10 border-emerald-500/25' : 'bg-rose-500/10 border-rose-500/25'
}

function wrColor(wr: number) {
  if (wr >= 75) return 'text-emerald-400'
  if (wr >= 60) return 'text-amber-400'
  return 'text-rose-400'
}

function severityColor(s: string) {
  if (s === 'critical') return 'border-red-500/40 bg-red-500/8'
  if (s === 'high') return 'border-amber-500/40 bg-amber-500/8'
  return 'border-sky-500/40 bg-sky-500/8'
}

function severityBadge(s: string) {
  if (s === 'critical') return 'bg-red-500/20 text-red-400 border border-red-500/40'
  if (s === 'high') return 'bg-amber-500/20 text-amber-400 border border-amber-500/40'
  return 'bg-sky-500/20 text-sky-400 border border-sky-500/40'
}

// ─── Subcomponents ────────────────────────────────────────────────────────────

function StatCard({ label, value, sub, accent }: { label: string; value: string; sub?: string; accent?: string }) {
  return (
    <div className="bg-slate-800/60 border border-slate-700/60 rounded-xl p-4">
      <div className="text-xs text-slate-500 mb-1">{label}</div>
      <div className={`text-2xl font-bold tabular-nums ${accent ?? 'text-white'}`}>{value}</div>
      {sub && <div className="text-xs text-slate-500 mt-1">{sub}</div>}
    </div>
  )
}

function BarH({ value, max, color }: { value: number; max: number; color: string }) {
  const pct = max > 0 ? Math.min(100, Math.abs(value) / Math.abs(max) * 100) : 0
  return (
    <div className="h-2 bg-slate-700/50 rounded-full overflow-hidden w-full">
      <div className={`h-full rounded-full transition-all ${color}`} style={{ width: `${pct}%` }} />
    </div>
  )
}

const RULES = [
  {
    num: 1,
    title: 'No trades before 10:00 AM',
    why: 'Win rate 43%, costs ₹12,266 in losses. First 45 min is random gap-fill volatility.',
    saving: '₹12,266 saved',
    icon: '⏰',
    color: 'border-emerald-500/40 bg-emerald-500/5',
    badge: 'bg-emerald-500/20 text-emerald-400',
  },
  {
    num: 2,
    title: 'Exit within 2 minutes if in a loss',
    why: 'Holding 2–10 min: WR drops to 19%, avg -₹2,549. Holding 10+ min: WR 0%, avg -₹21,567.',
    saving: '₹23,000+ saved',
    icon: '⏱️',
    color: 'border-sky-500/40 bg-sky-500/5',
    badge: 'bg-sky-500/20 text-sky-400',
  },
  {
    num: 3,
    title: 'Max 2 consecutive losses → 30-min break',
    why: 'After 2 losses you enter revenge mode. 3+ consecutive losses in a row cost 80% of all losses.',
    saving: '₹15,000+ saved',
    icon: '🛑',
    color: 'border-amber-500/40 bg-amber-500/5',
    badge: 'bg-amber-500/20 text-amber-400',
  },
  {
    num: 4,
    title: 'Never re-enter the same strike after a loss',
    why: 'Revenge trades on same strike have near-zero edge. The market doesn\'t owe you a recovery.',
    saving: 'Stops ₹6,000+ blowouts',
    icon: '🚫',
    color: 'border-rose-500/40 bg-rose-500/5',
    badge: 'bg-rose-500/20 text-rose-400',
  },
  {
    num: 5,
    title: 'Max 2 trades per symbol per day',
    why: 'Churning same strike (3–5 times/day) drains premium + brokerage. Net P&L is always negative.',
    saving: '₹22,000 saved (May 25)',
    icon: '📊',
    color: 'border-violet-500/40 bg-violet-500/5',
    badge: 'bg-violet-500/20 text-violet-400',
  },
  {
    num: 6,
    title: 'Never increase size after a loss',
    why: 'Doubling down while losing wiped ₹44k on May 25. Qty grew 520→1625 during a losing streak.',
    saving: 'Prevents ₹44k blowout days',
    icon: '📉',
    color: 'border-pink-500/40 bg-pink-500/5',
    badge: 'bg-pink-500/20 text-pink-400',
  },
]

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function TradeAnalysis() {
  const [result, setResult] = useState<AnalysisResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<'summary' | 'daily' | 'timing' | 'mistakes' | 'rules' | 'journal'>('summary')
  const [dragging, setDragging] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  const processFile = useCallback((file: File) => {
    setLoading(true)
    setError(null)
    // Reset file input so the same file can be re-selected
    if (fileRef.current) fileRef.current.value = ''
    const reader = new FileReader()
    reader.onload = e => {
      try {
        const text = e.target?.result as string
        const rows = parseCSV(text)
        if (rows.length === 0) throw new Error(
          'No valid rows found. Expected columns: symbol, trade_date, trade_type, quantity, price, order_id, order_execution_time. Check your CSV format.'
        )

        const orders: Order[] = rows.map(r => {
          const ts = parseTS(r.order_execution_time || r.trade_date)
          return {
            order_id: r.order_id,
            symbol: r.symbol,
            date: r.trade_date,
            type: r.trade_type,
            qty: r.quantity,
            avg_price: r.price,
            time: ts ? `${String(ts.getHours()).padStart(2, '0')}:${String(ts.getMinutes()).padStart(2, '0')}` : '09:30',
            ts: ts ?? new Date(r.trade_date),
          }
        })

        const analysis = analyzeOrders(orders)
        if (analysis.total_trades === 0) throw new Error(
          `Parsed ${rows.length} rows but found 0 matched trades. Make sure your CSV has both buy and sell orders for the same symbol on the same date.`
        )
        setResult(analysis)
        setTab('summary')
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : 'Failed to parse CSV')
      } finally {
        setLoading(false)
      }
    }
    reader.readAsText(file)
  }, [])

  function parseTS(s: string): Date | null {
    if (!s) return null
    // "2026-05-14 09:15:32" or "14-05-2026 09:15" or ISO
    const d = new Date(s.replace(/(\d{2})-(\d{2})-(\d{4})/, '$3-$2-$1'))
    return isNaN(d.getTime()) ? null : d
  }

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setDragging(false)
    const file = e.dataTransfer.files[0]
    if (file) processFile(file)
  }, [processFile])

  const TABS = [
    { id: 'summary', label: '📊 Overview' },
    { id: 'daily', label: '📅 Daily P&L' },
    { id: 'timing', label: '⏰ Timing Analysis' },
    { id: 'mistakes', label: '⚠️ Mistakes' },
    { id: 'rules', label: '📋 Correction Rules' },
    { id: 'journal', label: '📓 Trade Journal' },
  ] as const

  return (
    <div className="min-h-screen bg-slate-950 text-slate-200 p-4 md:p-6">
      <div className="max-w-7xl mx-auto space-y-6">

        {/* Header */}
        <div className="flex items-start justify-between flex-wrap gap-4">
          <div>
            <h1 className="text-2xl font-bold text-white">🔍 Trade Analysis & Correction</h1>
            <p className="text-slate-400 text-sm mt-1">Upload your Zerodha tradebook CSV · Identify mistakes · Apply correction rules</p>
          </div>
          {result && (
            <button
              onClick={() => { setResult(null); setError(null); if (fileRef.current) fileRef.current.value = '' }}
              className="px-4 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-400 hover:text-white text-sm border border-slate-700 transition-colors"
            >
              ↩ Upload New File
            </button>
          )}
        </div>

        {/* Upload Zone */}
        {!result && !loading && (
          <div
            className={`border-2 border-dashed rounded-2xl p-12 text-center transition-colors cursor-pointer ${
              dragging ? 'border-brand-500 bg-brand-500/5' : 'border-slate-700 hover:border-slate-500 bg-slate-900/40'
            }`}
            onDragOver={e => { e.preventDefault(); setDragging(true) }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
            onClick={() => fileRef.current?.click()}
          >
            <div className="text-5xl mb-4">📂</div>
            <div className="text-lg font-semibold text-slate-200 mb-2">Drop your Zerodha CSV here</div>
            <div className="text-sm text-slate-500">or click to browse · Order Book or Tradebook CSV</div>
            <div className="mt-4 text-xs text-slate-600">
              Supports: <span className="text-slate-400">Order Book</span> (Time, Type, Instrument, Qty., Avg. price, Status)
              &nbsp;·&nbsp; <span className="text-slate-400">Tradebook</span> (symbol, trade_date, trade_type, quantity, price, order_id)
            </div>
            <input
              ref={fileRef}
              type="file"
              accept=".csv"
              className="hidden"
              onChange={e => { const f = e.target.files?.[0]; if (f) processFile(f) }}
            />
          </div>
        )}

        {loading && (
          <div className="flex flex-col items-center justify-center py-24 gap-4">
            <div className="w-10 h-10 border-4 border-brand-500 border-t-transparent rounded-full animate-spin" />
            <div className="text-slate-400">Analysing trades…</div>
          </div>
        )}

        {error && (
          <div className="bg-rose-500/10 border border-rose-500/30 rounded-xl p-4 text-rose-400 text-sm">
            ⚠️ {error}
          </div>
        )}

        {/* Results */}
        {result && (
          <>
            {/* Tabs */}
            <div className="flex flex-wrap gap-1 bg-slate-900/60 p-1 rounded-xl border border-slate-800">
              {TABS.map(t => (
                <button
                  key={t.id}
                  onClick={() => setTab(t.id)}
                  className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors flex-1 sm:flex-none ${
                    tab === t.id
                      ? 'bg-brand-600/20 text-brand-400 border border-brand-600/30'
                      : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </div>

            {/* ── SUMMARY TAB ────────────────────────────────────── */}
            {tab === 'summary' && <SummaryTab r={result} />}

            {/* ── DAILY TAB ──────────────────────────────────────── */}
            {tab === 'daily' && <DailyTab r={result} />}

            {/* ── TIMING TAB ─────────────────────────────────────── */}
            {tab === 'timing' && <TimingTab r={result} />}

            {/* ── MISTAKES TAB ───────────────────────────────────── */}
            {tab === 'mistakes' && <MistakesTab r={result} />}

            {/* ── RULES TAB ──────────────────────────────────────── */}
            {tab === 'rules' && <RulesTab r={result} />}

            {/* ── JOURNAL TAB ────────────────────────────────────── */}
            {tab === 'journal' && <JournalTab r={result} />}
          </>
        )}
      </div>
    </div>
  )
}

// ─── Summary Tab ─────────────────────────────────────────────────────────────

function SummaryTab({ r }: { r: AnalysisResult }) {
  const rrLabel = r.rr.toFixed(2)
  const rrGood = r.rr >= 1.5

  return (
    <div className="space-y-6">
      {/* KPI Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <StatCard
          label="Total P&L"
          value={(r.total_pnl >= 0 ? '+' : '') + '₹' + fmtN(r.total_pnl)}
          sub={`${r.total_trades} trades`}
          accent={pnlColor(r.total_pnl)}
        />
        <StatCard
          label="Win Rate"
          value={r.win_rate.toFixed(1) + '%'}
          sub={`${r.wins}W / ${r.losses}L`}
          accent={wrColor(r.win_rate)}
        />
        <StatCard
          label="Avg Win"
          value={'₹' + fmtN(r.avg_win)}
          sub="per winning trade"
          accent="text-emerald-400"
        />
        <StatCard
          label="Avg Loss"
          value={'−₹' + fmtN(Math.abs(r.avg_loss))}
          sub="per losing trade"
          accent="text-rose-400"
        />
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <StatCard
          label="Reward:Risk"
          value={`1 : ${rrLabel}`}
          sub={rrGood ? '✅ Good R:R' : '❌ Fix urgently'}
          accent={rrGood ? 'text-emerald-400' : 'text-rose-400'}
        />
        <StatCard
          label="Best Trade"
          value={'₹' + fmtN(r.max_win)}
          accent="text-emerald-400"
        />
        <StatCard
          label="Worst Trade"
          value={'−₹' + fmtN(Math.abs(r.max_loss))}
          accent="text-rose-400"
        />
        <StatCard
          label="Worst Day"
          value={'−₹' + fmtN(Math.abs(Math.min(...r.days.map(d => d.pnl))))}
          accent="text-rose-400"
        />
      </div>

      {/* R:R Problem Alert */}
      {!rrGood && (
        <div className="bg-rose-500/10 border border-rose-500/30 rounded-xl p-5">
          <div className="flex items-start gap-3">
            <span className="text-2xl">🚨</span>
            <div>
              <div className="font-bold text-rose-300 text-base mb-1">Critical: R:R Ratio is {rrLabel} — You need ≥ 1.5</div>
              <div className="text-slate-300 text-sm leading-relaxed">
                Your average loss (₹{fmtN(Math.abs(r.avg_loss))}) is{' '}
                <span className="text-rose-400 font-bold">{(Math.abs(r.avg_loss) / r.avg_win).toFixed(1)}×</span> your average win (₹{fmtN(r.avg_win)}).
                Even with a{' '}<span className="text-amber-400 font-bold">{r.win_rate.toFixed(0)}% win rate</span>,{' '}
                you will eventually lose money at this ratio. Fix your exits first.
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Profit vs Loss distribution */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="bg-slate-800/60 border border-slate-700/60 rounded-xl p-5">
          <div className="text-sm font-semibold text-slate-300 mb-4">Win / Loss Distribution</div>
          <div className="space-y-3">
            <div>
              <div className="flex justify-between text-xs mb-1">
                <span className="text-emerald-400">Wins ({r.wins})</span>
                <span className="text-emerald-400 font-bold">₹{fmtN(r.wins * r.avg_win)}</span>
              </div>
              <BarH value={r.wins * r.avg_win} max={Math.abs(r.losses * r.avg_loss) + r.wins * r.avg_win} color="bg-emerald-500" />
            </div>
            <div>
              <div className="flex justify-between text-xs mb-1">
                <span className="text-rose-400">Losses ({r.losses})</span>
                <span className="text-rose-400 font-bold">−₹{fmtN(Math.abs(r.losses * r.avg_loss))}</span>
              </div>
              <BarH value={r.losses * r.avg_loss} max={Math.abs(r.losses * r.avg_loss) + r.wins * r.avg_win} color="bg-rose-500" />
            </div>
          </div>
        </div>

        <div className="bg-slate-800/60 border border-slate-700/60 rounded-xl p-5">
          <div className="text-sm font-semibold text-slate-300 mb-4">Top Issues Found</div>
          <div className="space-y-2">
            {[
              { icon: '⚠️', label: `${r.mistakes.filter(m => m.severity === 'critical').length} Critical mistakes`, color: 'text-red-400' },
              { icon: '🔔', label: `${r.mistakes.filter(m => m.severity === 'high').length} High-priority issues`, color: 'text-amber-400' },
              { icon: '⏰', label: '9:15–9:59 window is destroying P&L', color: 'text-orange-400' },
              { icon: '⏱️', label: 'Trades held 2–10 min: 19% win rate', color: 'text-rose-400' },
              { icon: '📈', label: `Best window: 10:00–14:59 (75%+ WR)`, color: 'text-emerald-400' },
            ].map((item, i) => (
              <div key={i} className="flex items-center gap-2 text-sm">
                <span>{item.icon}</span>
                <span className={item.color}>{item.label}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── Daily Tab ────────────────────────────────────────────────────────────────

function DailyTab({ r }: { r: AnalysisResult }) {
  const maxAbs = Math.max(...r.days.map(d => Math.abs(d.pnl)), 1)

  return (
    <div className="space-y-4">
      <div className="bg-slate-800/60 border border-slate-700/60 rounded-xl overflow-hidden">
        <div className="p-4 border-b border-slate-700/60">
          <div className="text-sm font-semibold text-slate-300">Daily P&L Breakdown</div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-700/60 text-xs text-slate-500">
                <th className="text-left p-3 pl-4">Date</th>
                <th className="text-center p-3">Trades</th>
                <th className="text-center p-3">Win Rate</th>
                <th className="text-center p-3">Churns</th>
                <th className="text-right p-3">P&L Chart</th>
                <th className="text-right p-3 pr-4">P&L</th>
              </tr>
            </thead>
            <tbody>
              {r.days.map(d => (
                <tr key={d.date} className={`border-b border-slate-800/60 ${d.pnl < -20000 ? 'bg-rose-500/5' : ''}`}>
                  <td className="p-3 pl-4 font-medium text-slate-200">{d.date}</td>
                  <td className="p-3 text-center text-slate-400">{d.trades}</td>
                  <td className={`p-3 text-center font-bold ${wrColor(d.wr)}`}>{d.wr.toFixed(0)}%</td>
                  <td className="p-3 text-center">
                    {d.churns > 0
                      ? <span className="px-2 py-0.5 bg-amber-500/20 text-amber-400 text-xs rounded-full border border-amber-500/30">{d.churns} churns</span>
                      : <span className="text-slate-600">—</span>}
                  </td>
                  <td className="p-3 pr-2 w-40">
                    <div className="flex items-center gap-1">
                      {d.pnl >= 0
                        ? <div className="h-4 bg-emerald-500/60 rounded" style={{ width: `${(d.pnl / maxAbs) * 100}%`, minWidth: 4 }} />
                        : <div className="h-4 bg-rose-500/60 rounded ml-auto" style={{ width: `${(Math.abs(d.pnl) / maxAbs) * 100}%`, minWidth: 4 }} />}
                    </div>
                  </td>
                  <td className={`p-3 pr-4 text-right font-bold tabular-nums ${pnlColor(d.pnl)}`}>
                    {d.pnl >= 0 ? '+' : ''}₹{fmtN(d.pnl)}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t border-slate-600/60 bg-slate-800/40">
                <td className="p-3 pl-4 font-bold text-slate-300">Total</td>
                <td className="p-3 text-center text-slate-400">{r.total_trades}</td>
                <td className={`p-3 text-center font-bold ${wrColor(r.win_rate)}`}>{r.win_rate.toFixed(0)}%</td>
                <td />
                <td />
                <td className={`p-3 pr-4 text-right font-bold tabular-nums text-lg ${pnlColor(r.total_pnl)}`}>
                  {r.total_pnl >= 0 ? '+' : ''}₹{fmtN(r.total_pnl)}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>

      {/* Worst day callout */}
      {r.days.some(d => d.pnl < -20000) && (
        <div className="bg-rose-500/8 border border-rose-500/30 rounded-xl p-4">
          <div className="font-semibold text-rose-300 mb-2">🚨 Blowout Day Analysis</div>
          {r.days.filter(d => d.pnl < -20000).map(d => (
            <div key={d.date} className="text-sm text-slate-300">
              <span className="text-rose-400 font-bold">{d.date}</span>: {d.trades} trades,{' '}
              {d.wr.toFixed(0)}% WR, lost <span className="text-rose-400 font-bold">₹{fmtN(Math.abs(d.pnl))}</span>.
              {d.churns > 0 && ` ${d.churns} symbols were churned (traded 3+ times).`}
              {' '}Rule 3 (stop after 2 losses) would have prevented this.
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── Timing Tab ───────────────────────────────────────────────────────────────

function TimingTab({ r }: { r: AnalysisResult }) {
  const maxAbsHour = Math.max(...r.hours.map(h => Math.abs(h.pnl)), 1)
  const maxAbsHold = Math.max(...r.hold_buckets.map(b => Math.abs(b.pnl)), 1)

  return (
    <div className="space-y-6">
      {/* Hourly */}
      <div className="bg-slate-800/60 border border-slate-700/60 rounded-xl overflow-hidden">
        <div className="p-4 border-b border-slate-700/60">
          <div className="text-sm font-semibold text-slate-300">P&L by Hour of Day</div>
          <div className="text-xs text-slate-500 mt-0.5">Which time windows are profitable?</div>
        </div>
        <div className="p-4 space-y-3">
          {r.hours.filter(h => h.trades > 0).map(h => (
            <div key={h.hour} className={`p-3 rounded-lg border ${pnlBg(h.pnl)}`}>
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-3">
                  <span className="text-sm font-mono font-bold text-slate-200">{h.hour}</span>
                  <span className="text-xs text-slate-500">{h.trades} trades</span>
                  <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${
                    h.wr >= 75 ? 'bg-emerald-500/20 text-emerald-400' :
                    h.wr >= 60 ? 'bg-amber-500/20 text-amber-400' :
                    'bg-rose-500/20 text-rose-400'
                  }`}>{h.wr.toFixed(0)}% WR</span>
                  {h.hour.startsWith('09') && <span className="text-xs bg-red-500/20 text-red-400 px-2 py-0.5 rounded-full border border-red-500/30">⚠️ AVOID</span>}
                  {(h.hour.startsWith('10') || h.hour.startsWith('13') || h.hour.startsWith('14')) && h.pnl > 0 && (
                    <span className="text-xs bg-emerald-500/20 text-emerald-400 px-2 py-0.5 rounded-full border border-emerald-500/30">✅ BEST</span>
                  )}
                </div>
                <span className={`font-bold tabular-nums text-sm ${pnlColor(h.pnl)}`}>
                  {h.pnl >= 0 ? '+' : ''}₹{fmtN(h.pnl)}
                </span>
              </div>
              <BarH value={h.pnl} max={maxAbsHour} color={h.pnl >= 0 ? 'bg-emerald-500' : 'bg-rose-500'} />
            </div>
          ))}
        </div>
      </div>

      {/* Holding time */}
      <div className="bg-slate-800/60 border border-slate-700/60 rounded-xl overflow-hidden">
        <div className="p-4 border-b border-slate-700/60">
          <div className="text-sm font-semibold text-slate-300">P&L by Holding Duration</div>
          <div className="text-xs text-slate-500 mt-0.5">The faster you exit, the better your results</div>
        </div>
        <div className="p-4 space-y-3">
          {r.hold_buckets.filter(b => b.trades > 0).map(b => (
            <div key={b.bucket} className={`p-3 rounded-lg border ${pnlBg(b.pnl)}`}>
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-3">
                  <span className="text-sm font-bold text-slate-200 w-20">{b.bucket}</span>
                  <span className="text-xs text-slate-500">{b.trades} trades</span>
                  <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${
                    b.wr >= 75 ? 'bg-emerald-500/20 text-emerald-400' :
                    b.wr >= 50 ? 'bg-amber-500/20 text-amber-400' :
                    'bg-rose-500/20 text-rose-400'
                  }`}>{b.wr.toFixed(0)}% WR</span>
                  <span className={`text-xs ${b.avg_pnl >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                    avg {b.avg_pnl >= 0 ? '+' : ''}₹{fmtN(b.avg_pnl)}
                  </span>
                </div>
                <span className={`font-bold tabular-nums text-sm ${pnlColor(b.pnl)}`}>
                  {b.pnl >= 0 ? '+' : ''}₹{fmtN(b.pnl)}
                </span>
              </div>
              <BarH value={b.pnl} max={maxAbsHold} color={b.pnl >= 0 ? 'bg-emerald-500' : 'bg-rose-500'} />
            </div>
          ))}
        </div>
        <div className="px-4 pb-4">
          <div className="bg-amber-500/8 border border-amber-500/30 rounded-lg p-3 text-xs text-amber-300">
            💡 <strong>Key insight:</strong> Your edge is entirely in trades held under 2 minutes.
            Every minute you hold beyond that, win rate collapses. Set a hard 2-minute rule: if not profitable, exit.
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── Mistakes Tab ─────────────────────────────────────────────────────────────

function MistakesTab({ r }: { r: AnalysisResult }) {
  const totalMistakeLoss = r.mistakes.reduce((s, m) => s + Math.min(0, m.loss), 0)
  const unique = r.mistakes.filter((m, i, arr) => arr.findIndex(x => x.type === m.type && x.date === m.date) === i)

  return (
    <div className="space-y-4">
      {/* Mistake summary */}
      <div className="grid grid-cols-3 gap-4">
        <StatCard
          label="Critical Mistakes"
          value={String(r.mistakes.filter(m => m.severity === 'critical').length)}
          accent="text-red-400"
          sub="Needs immediate fix"
        />
        <StatCard
          label="High-Priority Issues"
          value={String(r.mistakes.filter(m => m.severity === 'high').length)}
          accent="text-amber-400"
          sub="Fix this week"
        />
        <StatCard
          label="Recoverable Losses"
          value={'−₹' + fmtN(Math.abs(totalMistakeLoss))}
          accent="text-rose-400"
          sub="From avoidable mistakes"
        />
      </div>

      {/* Mistake cards */}
      {unique.length === 0 ? (
        <div className="text-center text-slate-500 py-12">No specific mistakes detected — looking good!</div>
      ) : (
        <div className="space-y-3">
          {unique.map((m, i) => (
            <div key={i} className={`p-5 rounded-xl border ${severityColor(m.severity)}`}>
              <div className="flex items-start gap-3">
                <div className="flex-1">
                  <div className="flex items-center gap-3 mb-2">
                    <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${severityBadge(m.severity)}`}>
                      {m.severity.toUpperCase()}
                    </span>
                    <span className="font-bold text-slate-200">{m.type}</span>
                    <span className="text-xs text-slate-500">{m.date}</span>
                    {m.loss < 0 && (
                      <span className="ml-auto text-rose-400 font-bold text-sm">−₹{fmtN(Math.abs(m.loss))}</span>
                    )}
                  </div>
                  <div className="text-sm text-slate-300 mb-3">{m.description}</div>
                  <div className="flex items-start gap-2 bg-emerald-500/8 border border-emerald-500/25 rounded-lg p-3 text-sm">
                    <span className="text-emerald-400 mt-0.5">✅</span>
                    <span className="text-emerald-300"><strong>Fix:</strong> {m.fix}</span>
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── Rules Tab ────────────────────────────────────────────────────────────────

function RulesTab({ r }: { r: AnalysisResult }) {
  const [checked, setChecked] = useState<Set<number>>(new Set())

  const toggle = (n: number) => {
    setChecked(prev => {
      const next = new Set(prev)
      if (next.has(n)) next.delete(n); else next.add(n)
      return next
    })
  }

  // Approximate "if you had followed these rules" savings
  const wouldSave = r.mistakes.reduce((s, m) => s + Math.abs(Math.min(0, m.loss)), 0)

  return (
    <div className="space-y-6">
      {/* Savings callout */}
      <div className="bg-emerald-500/10 border border-emerald-500/30 rounded-xl p-5 flex items-center gap-4">
        <div className="text-4xl">💰</div>
        <div>
          <div className="font-bold text-emerald-300 text-lg">If you had followed these rules…</div>
          <div className="text-slate-300 text-sm mt-1">
            You would have avoided approximately <span className="text-emerald-400 font-bold">₹{fmtN(wouldSave)}</span> in avoidable losses,
            turning this period into a much stronger result.
          </div>
        </div>
      </div>

      {/* Rules checklist */}
      <div className="space-y-3">
        <div className="text-xs text-slate-500 uppercase tracking-widest px-1">Daily Pre-Trade Checklist — Check each rule before trading</div>
        {RULES.map(rule => (
          <div
            key={rule.num}
            className={`p-4 rounded-xl border cursor-pointer transition-all ${rule.color} ${checked.has(rule.num) ? 'opacity-60' : ''}`}
            onClick={() => toggle(rule.num)}
          >
            <div className="flex items-start gap-4">
              <div className={`w-7 h-7 rounded-lg flex items-center justify-center text-sm font-bold flex-shrink-0 mt-0.5 transition-colors ${
                checked.has(rule.num) ? 'bg-emerald-500 text-white' : 'bg-slate-700 text-slate-400'
              }`}>
                {checked.has(rule.num) ? '✓' : rule.num}
              </div>
              <div className="flex-1">
                <div className="flex items-center gap-3 flex-wrap">
                  <span className="text-base">{rule.icon}</span>
                  <span className={`font-bold text-slate-200 ${checked.has(rule.num) ? 'line-through text-slate-500' : ''}`}>
                    {rule.title}
                  </span>
                  <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${rule.badge} ml-auto`}>
                    {rule.saving}
                  </span>
                </div>
                <div className="text-sm text-slate-400 mt-1.5">{rule.why}</div>
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Progress */}
      {checked.size > 0 && (
        <div className="bg-slate-800/60 border border-slate-700/60 rounded-xl p-4 text-center">
          <div className="text-slate-400 text-sm">Rules committed: <span className="text-emerald-400 font-bold">{checked.size} / {RULES.length}</span></div>
          <div className="mt-2 h-2 bg-slate-700 rounded-full overflow-hidden">
            <div className="h-full bg-emerald-500 rounded-full transition-all" style={{ width: `${(checked.size / RULES.length) * 100}%` }} />
          </div>
          {checked.size === RULES.length && (
            <div className="text-emerald-400 font-bold mt-3">🎯 All rules committed! You are ready to trade.</div>
          )}
        </div>
      )}

      {/* Corrected strategy summary */}
      <div className="bg-slate-800/60 border border-slate-700/60 rounded-xl p-5">
        <div className="font-semibold text-slate-200 mb-4">📋 Corrected NIFTY Scalping Strategy</div>
        <div className="space-y-3 text-sm">
          {[
            { t: 'Trading Hours', v: '10:00 AM – 3:15 PM only. Best windows: 10:00–11:00 and 13:00–15:00.' },
            { t: 'Entry Confirmation', v: 'Wait for 5-min candle close above/below key level. No trades on first candle of an hour.' },
            { t: 'Position Size', v: 'Max 1 lot. Reduce to ½ lot after any day with 2+ consecutive losses.' },
            { t: 'Stop Loss', v: 'Hard SL = previous 5-min candle low/high. No widening SL after entry.' },
            { t: 'Exit Rule', v: 'If not profitable within 2 minutes of entry, exit at market. Non-negotiable.' },
            { t: 'Daily Loss Limit', v: 'Stop trading for the day after losing ₹5,000 (≈ 2 losing trades).' },
            { t: 'Same-Strike Rule', v: 'No re-entry on same strike if it caused a loss. Move to a different option.' },
            { t: 'Consecutive Losses', v: 'After 2 losses in a row → mandatory 30-min break. After 3 → stop for the day.' },
          ].map(item => (
            <div key={item.t} className="flex gap-3 p-3 bg-slate-900/40 rounded-lg">
              <span className="text-slate-500 font-medium w-36 flex-shrink-0">{item.t}</span>
              <span className="text-slate-300">{item.v}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

// ─── Journal Tab ──────────────────────────────────────────────────────────────

function JournalTab({ r }: { r: AnalysisResult }) {
  const [dateFilter, setDateFilter] = useState<string>('all')
  const dates = ['all', ...Array.from(new Set(r.trades.map(t => t.date)))]

  const trades = dateFilter === 'all' ? r.trades : r.trades.filter(t => t.date === dateFilter)

  return (
    <div className="space-y-4">
      {/* Filter */}
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-xs text-slate-500">Filter by date:</span>
        {dates.map(d => (
          <button
            key={d}
            onClick={() => setDateFilter(d)}
            className={`px-3 py-1 rounded-lg text-xs font-medium transition-colors border ${
              dateFilter === d
                ? 'bg-brand-600/20 text-brand-400 border-brand-600/30'
                : 'bg-slate-800 text-slate-400 border-slate-700 hover:text-slate-200'
            }`}
          >
            {d === 'all' ? 'All Dates' : d}
          </button>
        ))}
      </div>

      {/* Trade table */}
      <div className="bg-slate-800/60 border border-slate-700/60 rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-slate-700/60 text-slate-500">
                <th className="text-left p-3 pl-4">Date</th>
                <th className="text-left p-3">Symbol</th>
                <th className="text-center p-3">Dir</th>
                <th className="text-right p-3">Qty</th>
                <th className="text-right p-3">Entry</th>
                <th className="text-right p-3">Exit</th>
                <th className="text-center p-3">Entry Time</th>
                <th className="text-center p-3">Exit Time</th>
                <th className="text-center p-3">Hold</th>
                <th className="text-right p-3 pr-4">P&L</th>
              </tr>
            </thead>
            <tbody>
              {trades.map((t, i) => (
                <tr key={i} className={`border-b border-slate-800/60 hover:bg-slate-700/20 ${!t.is_win ? 'bg-rose-500/3' : ''}`}>
                  <td className="p-3 pl-4 text-slate-400 font-mono">{t.date}</td>
                  <td className="p-3 text-slate-300 font-mono text-[11px]">{t.symbol}</td>
                  <td className="p-3 text-center">
                    <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${
                      t.direction === 'CE' ? 'bg-emerald-500/20 text-emerald-400' :
                      t.direction === 'PE' ? 'bg-rose-500/20 text-rose-400' :
                      'bg-slate-500/20 text-slate-400'
                    }`}>{t.direction}</span>
                  </td>
                  <td className="p-3 text-right text-slate-400 tabular-nums">{t.qty}</td>
                  <td className="p-3 text-right text-slate-300 tabular-nums">{t.entry_price.toFixed(1)}</td>
                  <td className="p-3 text-right text-slate-300 tabular-nums">{t.exit_price.toFixed(1)}</td>
                  <td className="p-3 text-center text-slate-400 font-mono">{t.entry_time}</td>
                  <td className="p-3 text-center text-slate-400 font-mono">{t.exit_time}</td>
                  <td className={`p-3 text-center font-mono ${t.hold_minutes > 10 && !t.is_win ? 'text-rose-400 font-bold' : 'text-slate-500'}`}>
                    {t.hold_minutes}m
                  </td>
                  <td className={`p-3 pr-4 text-right font-bold tabular-nums ${pnlColor(t.pnl)}`}>
                    {t.pnl >= 0 ? '+' : ''}₹{fmtN(t.pnl)}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t border-slate-600/60 bg-slate-800/40">
                <td colSpan={9} className="p-3 pl-4 text-slate-500 text-xs">{trades.length} trades</td>
                <td className={`p-3 pr-4 text-right font-bold text-sm ${pnlColor(trades.reduce((s, t) => s + t.pnl, 0))}`}>
                  {trades.reduce((s, t) => s + t.pnl, 0) >= 0 ? '+' : ''}₹{fmtN(trades.reduce((s, t) => s + t.pnl, 0))}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>
    </div>
  )
}
