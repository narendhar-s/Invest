import { useEffect, useState } from 'react'
import {
  getZerodhaStatus,
  getZerodhaLoginUrl,
  getZerodhaLtp,
  placeZerodhaOrder,
  type ZerodhaStatus,
  type OrderTicket,
  type OrderResult,
} from '../api/client'

type Segment = 'EQUITY' | 'OPTION'

const fmt = (n: number | null | undefined, d = 2) =>
  typeof n === 'number' && isFinite(n) ? n.toLocaleString('en-IN', { minimumFractionDigits: d, maximumFractionDigits: d }) : '—'

export default function Trade() {
  const [status, setStatus] = useState<ZerodhaStatus | null>(null)

  // Order ticket state
  const [segment, setSegment] = useState<Segment>('EQUITY')
  const [side, setSide] = useState<'BUY' | 'SELL'>('BUY')
  const [symbol, setSymbol] = useState('')
  const [qty, setQty] = useState<number>(1)
  const [product, setProduct] = useState<'MIS' | 'CNC' | 'NRML'>('MIS')
  const [orderType, setOrderType] = useState<'MARKET' | 'LIMIT'>('MARKET')
  const [price, setPrice] = useState<number>(0)

  // LTP preview + flow
  const [ltp, setLtp] = useState<number | null>(null)
  const [ltpChangePct, setLtpChangePct] = useState<number | null>(null)
  const [ltpLoading, setLtpLoading] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [placing, setPlacing] = useState(false)
  const [result, setResult] = useState<OrderResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  const exchange: OrderTicket['exchange'] = segment === 'EQUITY' ? 'NSE' : 'NFO'

  useEffect(() => {
    getZerodhaStatus().then(setStatus).catch(() => setStatus(null))
  }, [])

  // Keep product valid for the chosen segment.
  useEffect(() => {
    if (segment === 'EQUITY' && product === 'NRML') setProduct('MIS')
    if (segment === 'OPTION' && product === 'CNC') setProduct('NRML')
    setLtp(null)
    setLtpChangePct(null)
  }, [segment]) // eslint-disable-line react-hooks/exhaustive-deps

  const connectZerodha = async () => {
    const { login_url, configured } = await getZerodhaLoginUrl()
    if (!configured) { setError('Zerodha not configured on the server.'); return }
    window.location.href = login_url
  }

  const fetchLtp = async () => {
    if (!symbol.trim()) { setError('Enter a symbol first.'); return }
    setLtpLoading(true); setError(null)
    try {
      const r = await getZerodhaLtp(symbol.trim(), exchange)
      setLtp(r.last_price)
      setLtpChangePct(r.change_pct)
      if (orderType === 'LIMIT' && !price) setPrice(Number(r.last_price.toFixed(2)))
    } catch (e: any) {
      setError(e?.response?.data?.error || 'Could not fetch LTP.')
      setLtp(null)
    } finally {
      setLtpLoading(false)
    }
  }

  const submit = async () => {
    setPlacing(true); setError(null); setResult(null)
    try {
      const r = await placeZerodhaOrder({
        symbol: symbol.trim(),
        exchange,
        transaction_type: side,
        quantity: qty,
        product,
        order_type: orderType,
        ...(orderType === 'LIMIT' ? { price } : {}),
      })
      setResult(r)
      setConfirming(false)
    } catch (e: any) {
      setError(e?.response?.data?.error || 'Order failed.')
      setConfirming(false)
    } finally {
      setPlacing(false)
    }
  }

  const refPrice = orderType === 'LIMIT' && price > 0 ? price : ltp
  const estValue = refPrice && qty ? refPrice * qty : null
  const products: Array<'MIS' | 'CNC' | 'NRML'> = segment === 'EQUITY' ? ['MIS', 'CNC'] : ['MIS', 'NRML']

  // ── Not connected / not configured gates ─────────────────────────────────
  if (status && !status.configured) {
    return (
      <Shell>
        <Banner tone="amber">Zerodha is not configured on the server. Add your API key & secret in <code>config.yaml</code>, then restart.</Banner>
      </Shell>
    )
  }
  if (status && !status.connected) {
    return (
      <Shell>
        <div className="text-center py-10">
          <div className="text-4xl mb-3">🔗</div>
          <h2 className="text-lg font-semibold text-white mb-1">Connect your Zerodha account</h2>
          <p className="text-slate-400 text-sm mb-5">Log in with Zerodha to place orders from here.</p>
          <button onClick={connectZerodha}
            className="bg-[#387ED1] hover:bg-[#2f6fb8] text-white font-medium rounded-lg px-5 py-2.5 text-sm">
            Connect Zerodha
          </button>
          {error && <p className="text-red-400 text-sm mt-4">{error}</p>}
        </div>
      </Shell>
    )
  }

  const liveOff = status && status.live_trading === false

  return (
    <Shell>
      {liveOff && (
        <Banner tone="amber">
          Live trading is <b>disabled</b> on the server. Set <code>zerodha.live_trading_enabled: true</code> in <code>config.yaml</code> and restart to place real orders.
        </Banner>
      )}

      {result && (
        <Banner tone="emerald">
          ✅ Order placed — ID <b className="font-mono">{result.order_id}</b> ({result.transaction_type} {result.quantity} {result.symbol}). Track it in your Zerodha app / Kite orders.
        </Banner>
      )}
      {error && !confirming && <Banner tone="red">{error}</Banner>}

      {/* BUY / SELL */}
      <div className="grid grid-cols-2 gap-2 mb-4">
        {(['BUY', 'SELL'] as const).map(s => (
          <button key={s} onClick={() => setSide(s)}
            className={`py-2.5 rounded-lg text-sm font-semibold transition-colors ${
              side === s
                ? s === 'BUY' ? 'bg-emerald-600 text-white' : 'bg-red-600 text-white'
                : 'bg-dark-700 text-slate-400 hover:text-slate-200'
            }`}>
            {s}
          </button>
        ))}
      </div>

      {/* Segment */}
      <Field label="Segment">
        <div className="grid grid-cols-2 gap-2">
          {(['EQUITY', 'OPTION'] as const).map(s => (
            <button key={s} onClick={() => setSegment(s)}
              className={`py-2 rounded-lg text-sm font-medium border transition-colors ${
                segment === s ? 'border-brand-600 bg-brand-600/20 text-brand-400' : 'border-slate-700 text-slate-400 hover:text-slate-200'
              }`}>
              {s === 'EQUITY' ? 'Equity (NSE)' : 'Option (NFO)'}
            </button>
          ))}
        </div>
      </Field>

      {/* Symbol */}
      <Field label={segment === 'EQUITY' ? 'Symbol (e.g. RELIANCE.NS)' : 'Option tradingsymbol (e.g. NIFTY25JUN24500CE)'}>
        <div className="flex gap-2">
          <input
            value={symbol}
            onChange={e => { setSymbol(e.target.value.toUpperCase()); setLtp(null) }}
            placeholder={segment === 'EQUITY' ? 'RELIANCE.NS' : 'NIFTY25JUN24500CE'}
            className="flex-1 bg-dark-700 border border-slate-700 rounded-lg px-3 py-2.5 text-sm text-white font-mono placeholder:text-slate-600 focus:border-brand-600 outline-none"
          />
          <button onClick={fetchLtp} disabled={ltpLoading}
            className="shrink-0 bg-dark-600 hover:bg-dark-500 border border-slate-700 text-slate-200 rounded-lg px-3 text-xs font-medium disabled:opacity-50">
            {ltpLoading ? '…' : 'LTP'}
          </button>
        </div>
        {ltp != null && (
          <p className="mt-1.5 text-xs text-slate-400">
            LTP <span className="text-white font-mono">₹{fmt(ltp)}</span>
            {ltpChangePct != null && (
              <span className={ltpChangePct >= 0 ? 'text-emerald-400 ml-2' : 'text-red-400 ml-2'}>
                {ltpChangePct >= 0 ? '+' : ''}{fmt(ltpChangePct)}%
              </span>
            )}
          </p>
        )}
      </Field>

      {/* Qty + Product */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field label={segment === 'OPTION' ? 'Quantity (lots × lot size)' : 'Quantity'}>
          <input type="number" min={1} value={qty}
            onChange={e => setQty(Math.max(1, parseInt(e.target.value || '0', 10)))}
            className="w-full bg-dark-700 border border-slate-700 rounded-lg px-3 py-2.5 text-sm text-white focus:border-brand-600 outline-none" />
        </Field>
        <Field label="Product">
          <div className="grid grid-cols-2 gap-2">
            {products.map(p => (
              <button key={p} onClick={() => setProduct(p)}
                className={`py-2.5 rounded-lg text-sm font-medium border transition-colors ${
                  product === p ? 'border-brand-600 bg-brand-600/20 text-brand-400' : 'border-slate-700 text-slate-400 hover:text-slate-200'
                }`}>
                {p}
              </button>
            ))}
          </div>
        </Field>
      </div>

      {/* Order type + price */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field label="Order type">
          <div className="grid grid-cols-2 gap-2">
            {(['MARKET', 'LIMIT'] as const).map(o => (
              <button key={o} onClick={() => setOrderType(o)}
                className={`py-2.5 rounded-lg text-sm font-medium border transition-colors ${
                  orderType === o ? 'border-brand-600 bg-brand-600/20 text-brand-400' : 'border-slate-700 text-slate-400 hover:text-slate-200'
                }`}>
                {o}
              </button>
            ))}
          </div>
        </Field>
        <Field label="Limit price">
          <input type="number" min={0} step="0.05" value={price || ''}
            disabled={orderType !== 'LIMIT'}
            onChange={e => setPrice(parseFloat(e.target.value || '0'))}
            placeholder={orderType === 'LIMIT' ? '0.00' : 'Market'}
            className="w-full bg-dark-700 border border-slate-700 rounded-lg px-3 py-2.5 text-sm text-white focus:border-brand-600 outline-none disabled:opacity-40" />
        </Field>
      </div>

      {/* Estimate */}
      <div className="flex items-center justify-between mt-4 mb-1 text-sm">
        <span className="text-slate-400">Est. value</span>
        <span className="text-white font-mono">{estValue != null ? `₹${fmt(estValue)}` : '—'}</span>
      </div>
      {segment === 'OPTION' && orderType === 'MARKET' && (
        <p className="text-[11px] text-slate-500 mb-2">F&O market orders are auto-converted to a protective limit near LTP (Zerodha rule).</p>
      )}

      {/* Place */}
      <button
        disabled={!!liveOff || !symbol.trim() || qty < 1}
        onClick={() => { setError(null); setResult(null); setConfirming(true) }}
        className={`w-full mt-2 py-3 rounded-lg text-sm font-semibold transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
          side === 'BUY' ? 'bg-emerald-600 hover:bg-emerald-500 text-white' : 'bg-red-600 hover:bg-red-500 text-white'
        }`}>
        {side} {symbol ? symbol : ''} {qty > 0 ? `× ${qty}` : ''}
      </button>

      {/* Confirm modal */}
      {confirming && (
        <div className="fixed inset-0 z-[60] bg-black/60 flex items-end sm:items-center justify-center p-0 sm:p-4">
          <div className="bg-dark-800 border border-slate-700 w-full sm:max-w-sm rounded-t-2xl sm:rounded-2xl p-5">
            <h3 className="text-base font-semibold text-white mb-1">Confirm real order</h3>
            <p className="text-xs text-slate-400 mb-4">This places a live order on your Zerodha account.</p>
            <dl className="text-sm space-y-1.5 mb-5">
              <Row k="Action" v={<span className={side === 'BUY' ? 'text-emerald-400' : 'text-red-400'}>{side}</span>} />
              <Row k="Symbol" v={<span className="font-mono">{symbol}</span>} />
              <Row k="Segment / Exch" v={`${segment} · ${exchange}`} />
              <Row k="Quantity" v={String(qty)} />
              <Row k="Product" v={product} />
              <Row k="Type" v={orderType === 'LIMIT' ? `LIMIT @ ₹${fmt(price)}` : 'MARKET'} />
              {estValue != null && <Row k="Est. value" v={`₹${fmt(estValue)}`} />}
            </dl>
            {error && <p className="text-red-400 text-xs mb-3">{error}</p>}
            <div className="grid grid-cols-2 gap-2">
              <button onClick={() => setConfirming(false)} disabled={placing}
                className="py-2.5 rounded-lg text-sm font-medium bg-dark-700 text-slate-300 hover:text-white">Cancel</button>
              <button onClick={submit} disabled={placing}
                className={`py-2.5 rounded-lg text-sm font-semibold text-white ${side === 'BUY' ? 'bg-emerald-600 hover:bg-emerald-500' : 'bg-red-600 hover:bg-red-500'} disabled:opacity-60`}>
                {placing ? 'Placing…' : `Confirm ${side}`}
              </button>
            </div>
          </div>
        </div>
      )}
    </Shell>
  )
}

// ── Small presentational helpers ────────────────────────────────────────────
function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="max-w-lg mx-auto px-4 py-5 sm:py-8">
      <h1 className="text-xl font-bold text-white mb-1">Trade</h1>
      <p className="text-slate-500 text-sm mb-5">Place real equity & option orders via Zerodha.</p>
      <div className="bg-dark-800 border border-slate-800 rounded-2xl p-4 sm:p-5">{children}</div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mb-3">
      <label className="block text-xs font-medium text-slate-400 mb-1.5">{label}</label>
      {children}
    </div>
  )
}

function Banner({ tone, children }: { tone: 'amber' | 'red' | 'emerald'; children: React.ReactNode }) {
  const map = {
    amber: 'bg-amber-500/10 border-amber-500/30 text-amber-300',
    red: 'bg-red-500/10 border-red-500/30 text-red-300',
    emerald: 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300',
  }
  return <div className={`border rounded-lg px-3 py-2.5 text-sm mb-4 ${map[tone]}`}>{children}</div>
}

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between">
      <dt className="text-slate-400">{k}</dt>
      <dd className="text-white">{v}</dd>
    </div>
  )
}
