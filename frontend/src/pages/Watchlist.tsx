import { useEffect, useMemo, useState } from 'react'

// ─── Types & storage ─────────────────────────────────────────────────────────

type Market = 'NSE' | 'US'

interface WatchItem {
  symbol: string       // raw user input, e.g. "AAPL" or "RELIANCE.NS"
  market: Market
  note?: string
  addedAt: string      // ISO date
}

const STORAGE_KEY = 'stockwise.watchlist.v1'

const loadList = (): WatchItem[] => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

const saveList = (items: WatchItem[]) => {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(items))
}

// Normalise a symbol to the form the Go backend expects in config.yaml.
//   AAPL          -> AAPL          (US)
//   reliance      -> RELIANCE.NS   (NSE; auto-suffix)
//   RELIANCE.NS   -> RELIANCE.NS   (NSE)
const normaliseSymbol = (raw: string, market: Market): string => {
  const s = raw.trim().toUpperCase()
  if (!s) return ''
  if (market === 'NSE') {
    return s.endsWith('.NS') ? s : `${s}.NS`
  }
  // US: strip any accidental .NS
  return s.replace(/\.NS$/, '')
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function Watchlist() {
  const [items, setItems] = useState<WatchItem[]>(loadList)
  const [symbol, setSymbol] = useState('')
  const [market, setMarket] = useState<Market>('NSE')
  const [note, setNote] = useState('')
  const [filter, setFilter] = useState<'ALL' | Market>('ALL')
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    saveList(items)
  }, [items])

  const visible = useMemo(
    () => (filter === 'ALL' ? items : items.filter((i) => i.market === filter)),
    [items, filter],
  )

  const counts = useMemo(
    () => ({
      total: items.length,
      nse: items.filter((i) => i.market === 'NSE').length,
      us: items.filter((i) => i.market === 'US').length,
    }),
    [items],
  )

  const addItem = () => {
    const sym = normaliseSymbol(symbol, market)
    if (!sym) return
    if (items.some((i) => i.symbol === sym && i.market === market)) {
      // already exists — just clear input
      setSymbol('')
      setNote('')
      return
    }
    setItems([
      { symbol: sym, market, note: note.trim() || undefined, addedAt: new Date().toISOString() },
      ...items,
    ])
    setSymbol('')
    setNote('')
  }

  const removeItem = (sym: string, mkt: Market) => {
    setItems(items.filter((i) => !(i.symbol === sym && i.market === mkt)))
  }

  const clearAll = () => {
    if (confirm('Clear the entire watchlist?')) setItems([])
  }

  // Build a YAML snippet the user can paste under markets.nse.symbols /
  // markets.us.symbols in config.yaml when the backend is ready.
  const yamlSnippet = useMemo(() => {
    const nse = items.filter((i) => i.market === 'NSE').map((i) => `      - ${i.symbol}`)
    const us = items.filter((i) => i.market === 'US').map((i) => `      - ${i.symbol}`)
    const out: string[] = []
    if (nse.length) {
      out.push('markets:')
      out.push('  nse:')
      out.push('    symbols:')
      out.push(...nse)
    }
    if (us.length) {
      if (!nse.length) out.push('markets:')
      out.push('  us:')
      out.push('    symbols:')
      out.push(...us)
    }
    return out.join('\n')
  }, [items])

  const copyYaml = async () => {
    try {
      await navigator.clipboard.writeText(yamlSnippet)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* clipboard blocked — fall through */
    }
  }

  const exportJson = () => {
    const blob = new Blob([JSON.stringify(items, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'watchlist.json'
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="max-w-screen-xl mx-auto px-4 py-8">
      {/* Header */}
      <div className="mb-6 flex items-end justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-white">Watchlist</h1>
          <p className="text-sm text-slate-400 mt-1">
            Offline mode — saved in your browser. Backend is not required.
          </p>
        </div>
        <div className="flex items-center gap-2 text-xs">
          <span className="px-2 py-1 rounded bg-slate-800 text-slate-300">
            Total: <span className="text-white font-semibold">{counts.total}</span>
          </span>
          <span className="px-2 py-1 rounded bg-slate-800 text-slate-300">
            NSE: <span className="text-white font-semibold">{counts.nse}</span>
          </span>
          <span className="px-2 py-1 rounded bg-slate-800 text-slate-300">
            US: <span className="text-white font-semibold">{counts.us}</span>
          </span>
        </div>
      </div>

      {/* Add form */}
      <div className="bg-dark-800 border border-slate-800 rounded-xl p-4 mb-6">
        <div className="grid grid-cols-1 sm:grid-cols-12 gap-3">
          <div className="sm:col-span-3">
            <label className="block text-xs text-slate-400 mb-1">Market</label>
            <div className="flex gap-1 bg-slate-900 rounded-lg p-1">
              {(['NSE', 'US'] as Market[]).map((m) => (
                <button
                  key={m}
                  onClick={() => setMarket(m)}
                  className={`flex-1 px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                    market === m
                      ? 'bg-brand-600/20 text-brand-400 border border-brand-600/30'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {m}
                </button>
              ))}
            </div>
          </div>
          <div className="sm:col-span-4">
            <label className="block text-xs text-slate-400 mb-1">Symbol</label>
            <input
              value={symbol}
              onChange={(e) => setSymbol(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && addItem()}
              placeholder={market === 'NSE' ? 'e.g. RELIANCE or RELIANCE.NS' : 'e.g. AAPL'}
              className="w-full bg-slate-900 border border-slate-700 rounded-md px-3 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-brand-600"
            />
          </div>
          <div className="sm:col-span-4">
            <label className="block text-xs text-slate-400 mb-1">Note (optional)</label>
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && addItem()}
              placeholder="why are you watching this?"
              className="w-full bg-slate-900 border border-slate-700 rounded-md px-3 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-brand-600"
            />
          </div>
          <div className="sm:col-span-1 flex items-end">
            <button
              onClick={addItem}
              disabled={!symbol.trim()}
              className="w-full bg-brand-600 hover:bg-brand-700 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-medium px-3 py-2 rounded-md transition-colors"
            >
              Add
            </button>
          </div>
        </div>
      </div>

      {/* Filter bar */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex gap-1 bg-slate-900 rounded-lg p-1">
          {(['ALL', 'NSE', 'US'] as const).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                filter === f
                  ? 'bg-brand-600/20 text-brand-400'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              {f}
            </button>
          ))}
        </div>
        <div className="flex gap-2">
          <button
            onClick={exportJson}
            disabled={!items.length}
            className="text-xs px-3 py-1.5 rounded-md bg-slate-800 text-slate-300 hover:bg-slate-700 disabled:opacity-40"
          >
            Export JSON
          </button>
          <button
            onClick={clearAll}
            disabled={!items.length}
            className="text-xs px-3 py-1.5 rounded-md bg-rose-900/40 text-rose-300 hover:bg-rose-900/60 disabled:opacity-40"
          >
            Clear all
          </button>
        </div>
      </div>

      {/* Table */}
      <div className="bg-dark-800 border border-slate-800 rounded-xl overflow-hidden">
        {visible.length === 0 ? (
          <div className="text-center py-16 text-slate-500 text-sm">
            No symbols yet. Add your first ticker above.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-slate-900/60 text-slate-400 text-xs uppercase tracking-wider">
              <tr>
                <th className="text-left px-4 py-3">Symbol</th>
                <th className="text-left px-4 py-3">Market</th>
                <th className="text-left px-4 py-3">Note</th>
                <th className="text-left px-4 py-3">Added</th>
                <th className="text-right px-4 py-3 w-20">Actions</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((it) => (
                <tr
                  key={`${it.market}:${it.symbol}`}
                  className="border-t border-slate-800/60 hover:bg-slate-900/40"
                >
                  <td className="px-4 py-3 font-mono text-white">{it.symbol}</td>
                  <td className="px-4 py-3">
                    <span
                      className={`px-2 py-0.5 rounded text-xs font-medium ${
                        it.market === 'NSE'
                          ? 'bg-amber-900/40 text-amber-300'
                          : 'bg-sky-900/40 text-sky-300'
                      }`}
                    >
                      {it.market}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-slate-300">{it.note ?? <span className="text-slate-600">—</span>}</td>
                  <td className="px-4 py-3 text-slate-500 text-xs">
                    {new Date(it.addedAt).toLocaleString()}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button
                      onClick={() => removeItem(it.symbol, it.market)}
                      className="text-xs text-rose-400 hover:text-rose-300"
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Sync helper */}
      {items.length > 0 && (
        <div className="mt-6 bg-dark-800 border border-slate-800 rounded-xl p-4">
          <div className="flex items-center justify-between mb-2">
            <h2 className="text-sm font-semibold text-white">When the backend is ready</h2>
            <button
              onClick={copyYaml}
              className="text-xs px-3 py-1.5 rounded-md bg-brand-600/20 text-brand-300 hover:bg-brand-600/30 border border-brand-600/30"
            >
              {copied ? 'Copied!' : 'Copy YAML'}
            </button>
          </div>
          <p className="text-xs text-slate-400 mb-2">
            Paste this under the matching section of <span className="font-mono text-slate-300">config.yaml</span>:
          </p>
          <pre className="bg-slate-950 border border-slate-800 rounded-md p-3 text-xs text-slate-300 font-mono overflow-x-auto">
{yamlSnippet}
          </pre>
        </div>
      )}
    </div>
  )
}
