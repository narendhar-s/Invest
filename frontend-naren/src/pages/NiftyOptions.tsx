import { useEffect, useState } from 'react'
import {
  getOptionsSignal,
  getOptionsBacktest,
  type OptionsSignal,
  type OptionsBacktestResult,
  type OptionsFactor,
} from '../api/client'
import LoadingSpinner from '../components/LoadingSpinner'

// ── helpers ───────────────────────────────────────────────────────────────────

function pct(n: number) { return (n >= 0 ? '+' : '') + n.toFixed(2) + '%' }

function factorColor(f: OptionsFactor, expectBull: boolean) {
  if (!f) return 'text-slate-500'
  const bull = f.status === 'BULL' || f.status === 'SPIKE'
  const bear = f.status === 'BEAR'
  if (expectBull) return bull ? 'text-emerald-400' : 'text-rose-400'
  return bear ? 'text-emerald-400' : 'text-rose-400'
}

function factorIcon(f: OptionsFactor, expectBull: boolean) {
  const bull = f.status === 'BULL' || f.status === 'SPIKE'
  const bear = f.status === 'BEAR'
  if (expectBull) return bull ? '✓' : '✗'
  return bear ? '✓' : '✗'
}

function signalBadge(signal: string) {
  if (signal === 'CE_BUY') return { label: 'BUY CALL (CE) ▲', bg: 'bg-emerald-500/20 border-emerald-500/40 text-emerald-300' }
  if (signal === 'PE_BUY') return { label: 'BUY PUT (PE) ▼',  bg: 'bg-rose-500/20    border-rose-500/40    text-rose-300' }
  return { label: 'WAIT — No Setup', bg: 'bg-slate-700/40 border-slate-600/40 text-slate-400' }
}

function wrColor(wr: number) {
  if (wr >= 80) return 'text-emerald-400'
  if (wr >= 70) return 'text-lime-400'
  if (wr >= 60) return 'text-amber-400'
  return 'text-rose-400'
}

// ── Factor Card ───────────────────────────────────────────────────────────────

function FactorRow({ f, expectBull, idx }: { f: OptionsFactor; expectBull: boolean; idx: number }) {
  const names = ['Supertrend (7,3)', 'EMA 9 / 21', 'VWAP', 'RSI (14)', 'Volume']
  const descs = [
    'Trend direction filter',
    'Short-term momentum',
    'Session price anchor',
    'Momentum strength',
    'Confirms breakout',
  ]
  const ok = expectBull
    ? (f.status === 'BULL' || f.status === 'SPIKE')
    : (f.status === 'BEAR')
  return (
    <div className={`flex items-center justify-between p-3 rounded-lg border ${ok ? 'border-emerald-500/25 bg-emerald-500/5' : 'border-rose-500/25 bg-rose-500/5'}`}>
      <div className="flex items-center gap-3">
        <div className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold ${ok ? 'bg-emerald-500/20 text-emerald-400' : 'bg-rose-500/20 text-rose-400'}`}>
          {idx + 1}
        </div>
        <div>
          <div className="text-sm font-semibold text-slate-200">{names[idx]}</div>
          <div className="text-xs text-slate-500">{descs[idx]}</div>
        </div>
      </div>
      <div className="text-right">
        <div className={`text-sm font-mono font-bold ${factorColor(f, expectBull)}`}>
          {factorIcon(f, expectBull)} {f.status}
        </div>
        <div className="text-xs text-slate-500 font-mono">{f.value}</div>
      </div>
    </div>
  )
}

// ── Confidence Meter ──────────────────────────────────────────────────────────

function ConfidenceMeter({ value }: { value: number }) {
  const color = value >= 90 ? 'bg-emerald-500' : value >= 75 ? 'bg-lime-500' : value >= 60 ? 'bg-amber-500' : 'bg-rose-500'
  return (
    <div className="w-full bg-slate-800 rounded-full h-2.5">
      <div className={`h-2.5 rounded-full transition-all duration-700 ${color}`} style={{ width: `${value}%` }} />
    </div>
  )
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function NiftyOptions() {
  const [signal, setSignal]   = useState<OptionsSignal | null>(null)
  const [backtest, setBacktest] = useState<OptionsBacktestResult | null>(null)
  const [years, setYears]     = useState(3)
  const [loading, setLoading] = useState(true)
  const [btLoading, setBtLoading] = useState(false)
  const [activeTab, setActiveTab] = useState<'signal' | 'backtest' | 'setup'>('signal')

  useEffect(() => {
    setLoading(true)
    getOptionsSignal()
      .then(setSignal)
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    setBtLoading(true)
    getOptionsBacktest(years)
      .then(d => setBacktest(d.result))
      .finally(() => setBtLoading(false))
  }, [years])

  const expectBull = signal?.signal === 'CE_BUY'
  const badge = signalBadge(signal?.signal ?? 'WAIT')

  return (
    <div className="min-h-screen bg-dark-950 text-slate-100 p-4 md:p-6">
      {/* Header */}
      <div className="mb-6">
        <div className="flex items-center gap-3 mb-1">
          <div className="w-2 h-8 bg-violet-500 rounded-full" />
          <h1 className="text-2xl font-bold text-white">Nifty Options Power Setup</h1>
          <span className="px-2 py-0.5 rounded text-xs bg-violet-500/20 text-violet-300 border border-violet-500/30 font-mono">5-FACTOR</span>
        </div>
        <p className="text-slate-400 text-sm ml-5">
          Supertrend + EMA + VWAP + RSI + Volume confluence · ATM CE/PE · 80%+ win-rate backtest
        </p>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 mb-6 bg-dark-900 rounded-lg p-1 w-fit">
        {(['signal', 'backtest', 'setup'] as const).map(t => (
          <button
            key={t}
            onClick={() => setActiveTab(t)}
            className={`px-4 py-1.5 rounded text-sm font-medium capitalize transition-all ${
              activeTab === t ? 'bg-violet-600 text-white' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            {t === 'signal' ? '⚡ Live Signal' : t === 'backtest' ? '📊 Backtest' : '📋 Setup Guide'}
          </button>
        ))}
      </div>

      {/* ── LIVE SIGNAL TAB ── */}
      {activeTab === 'signal' && (
        loading ? <LoadingSpinner /> : signal ? (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">

            {/* Signal Card */}
            <div className="bg-dark-900 rounded-xl border border-dark-700 p-5">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-sm font-semibold text-slate-400 uppercase tracking-wider">Current Signal</h2>
                <span className="text-xs text-slate-500 font-mono">{new Date(signal.generated_at).toLocaleTimeString()}</span>
              </div>
              <div className={`rounded-xl border px-5 py-4 mb-4 text-center ${badge.bg}`}>
                <div className="text-2xl font-black tracking-wide">{badge.label}</div>
                <div className="text-sm mt-1 opacity-70">Strike: {signal.strike} · Expiry: {signal.expiry}</div>
              </div>

              <ConfidenceMeter value={signal.confidence} />
              <div className="flex justify-between text-xs mt-1 mb-4">
                <span className="text-slate-500">Confidence</span>
                <span className={`font-bold font-mono ${signal.confidence >= 85 ? 'text-emerald-400' : 'text-amber-400'}`}>{signal.confidence}%</span>
              </div>

              {signal.signal !== 'WAIT' && (
                <div className="grid grid-cols-3 gap-3">
                  <div className="bg-dark-800 rounded-lg p-3 text-center">
                    <div className="text-[10px] text-slate-500 uppercase mb-1">Entry</div>
                    <div className="text-sm font-bold text-slate-200 font-mono">{signal.entry.toFixed(0)}</div>
                  </div>
                  <div className="bg-emerald-500/10 rounded-lg p-3 text-center border border-emerald-500/20">
                    <div className="text-[10px] text-slate-500 uppercase mb-1">Target</div>
                    <div className="text-sm font-bold text-emerald-400 font-mono">{signal.target.toFixed(0)}</div>
                  </div>
                  <div className="bg-rose-500/10 rounded-lg p-3 text-center border border-rose-500/20">
                    <div className="text-[10px] text-slate-500 uppercase mb-1">Stop Loss</div>
                    <div className="text-sm font-bold text-rose-400 font-mono">{signal.stop_loss.toFixed(0)}</div>
                  </div>
                </div>
              )}
              {signal.signal !== 'WAIT' && (
                <div className="mt-3 text-center text-xs text-slate-500">
                  Risk:Reward = <span className="text-amber-400 font-mono font-bold">1 : {signal.risk_reward.toFixed(1)}</span>
                </div>
              )}
            </div>

            {/* 5 Factors */}
            <div className="bg-dark-900 rounded-xl border border-dark-700 p-5">
              <h2 className="text-sm font-semibold text-slate-400 uppercase tracking-wider mb-4">5-Factor Confluence</h2>
              <div className="space-y-2">
                {signal.factors?.map((f, i) => (
                  <FactorRow key={i} f={f} expectBull={expectBull} idx={i} />
                ))}
              </div>
              <div className="mt-4 p-3 rounded-lg bg-dark-800 border border-dark-600">
                <div className="text-xs text-slate-500 mb-1">Confluence Score</div>
                <div className="flex gap-1">
                  {signal.factors?.map((f, i) => {
                    const ok = expectBull
                      ? (f.status === 'BULL' || f.status === 'SPIKE')
                      : (f.status === 'BEAR')
                    return (
                      <div key={i} className={`flex-1 h-2 rounded-full ${ok ? 'bg-emerald-500' : 'bg-rose-500/40'}`} />
                    )
                  })}
                </div>
                <div className="text-xs text-slate-400 mt-1">
                  {signal.factors?.filter(f => f.ok).length ?? 0} / 5 factors confirmed
                </div>
              </div>
            </div>

            {/* Rules reminder */}
            <div className="lg:col-span-2 bg-dark-900 rounded-xl border border-dark-700 p-5">
              <h2 className="text-sm font-semibold text-slate-400 uppercase tracking-wider mb-3">Trade Rules</h2>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-sm">
                <div>
                  <div className="text-emerald-400 font-semibold mb-2">Entry</div>
                  <ul className="text-slate-400 space-y-1 text-xs">
                    <li>• All 5 factors must align</li>
                    <li>• Trade only 9:30 AM – 2:00 PM</li>
                    <li>• Buy ATM strike (nearest ₹50)</li>
                    <li>• Avoid Friday expiry chaos</li>
                  </ul>
                </div>
                <div>
                  <div className="text-amber-400 font-semibold mb-2">Exit</div>
                  <ul className="text-slate-400 space-y-1 text-xs">
                    <li>• Target: +0.8% Nifty move</li>
                    <li>• Stop: -0.4% Nifty move</li>
                    <li>• Force exit at 2:45 PM</li>
                    <li>• Max 2 trades per day</li>
                  </ul>
                </div>
                <div>
                  <div className="text-rose-400 font-semibold mb-2">Avoid</div>
                  <ul className="text-slate-400 space-y-1 text-xs">
                    <li>• RBI / Fed event days</li>
                    <li>• Weekly expiry (Thursday PM)</li>
                    <li>{'• Gap open > 0.5%'}</li>
                    <li>• VIX above 20</li>
                  </ul>
                </div>
              </div>
            </div>
          </div>
        ) : <div className="text-slate-400">Failed to load signal.</div>
      )}

      {/* ── BACKTEST TAB ── */}
      {activeTab === 'backtest' && (
        <div>
          <div className="flex items-center gap-3 mb-5">
            <span className="text-sm text-slate-400">Period:</span>
            {[1, 2, 3, 5].map(y => (
              <button
                key={y}
                onClick={() => setYears(y)}
                className={`px-3 py-1 rounded text-sm font-medium transition-all ${
                  years === y ? 'bg-violet-600 text-white' : 'bg-dark-800 text-slate-400 hover:text-slate-200'
                }`}
              >
                {y}Y
              </button>
            ))}
          </div>

          {btLoading ? <LoadingSpinner /> : backtest ? (
            <div className="space-y-6">
              {/* Summary stats */}
              <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 gap-3">
                {[
                  { label: 'Win Rate',      value: backtest.win_rate.toFixed(1) + '%',    color: wrColor(backtest.win_rate) },
                  { label: 'Total Trades',  value: String(backtest.total_trades),          color: 'text-slate-200' },
                  { label: 'Profit Factor', value: backtest.profit_factor.toFixed(2) + 'x', color: backtest.profit_factor >= 2 ? 'text-emerald-400' : backtest.profit_factor >= 1.3 ? 'text-amber-400' : 'text-rose-400' },
                  { label: 'Avg Win',       value: pct(backtest.avg_win_pct),             color: 'text-emerald-400' },
                  { label: 'Avg Loss',      value: '-' + backtest.avg_loss_pct.toFixed(2) + '%', color: 'text-rose-400' },
                  { label: 'Max Drawdown',  value: '-' + backtest.max_drawdown_pct.toFixed(1) + '%', color: 'text-rose-400' },
                  { label: 'Total Return',  value: pct(backtest.total_return_pct),        color: backtest.total_return_pct > 0 ? 'text-emerald-400' : 'text-rose-400' },
                  { label: 'Winning',       value: String(backtest.winning_trades),        color: 'text-emerald-400' },
                  { label: 'Losing',        value: String(backtest.losing_trades),         color: 'text-rose-400' },
                ].map(m => (
                  <div key={m.label} className="bg-dark-900 rounded-xl border border-dark-700 p-3 text-center">
                    <div className="text-[10px] text-slate-500 uppercase tracking-wide mb-1">{m.label}</div>
                    <div className={`text-lg font-bold font-mono ${m.color}`}>{m.value}</div>
                  </div>
                ))}
              </div>

              {/* Win Rate visual */}
              <div className="bg-dark-900 rounded-xl border border-dark-700 p-5">
                <div className="flex items-center justify-between mb-3">
                  <span className="text-sm text-slate-400">Win Rate</span>
                  <span className={`text-2xl font-black font-mono ${wrColor(backtest.win_rate)}`}>{backtest.win_rate.toFixed(1)}%</span>
                </div>
                <div className="w-full bg-dark-800 rounded-full h-4 overflow-hidden">
                  <div
                    className={`h-4 rounded-full transition-all duration-700 ${backtest.win_rate >= 80 ? 'bg-emerald-500' : backtest.win_rate >= 70 ? 'bg-lime-500' : 'bg-amber-500'}`}
                    style={{ width: `${backtest.win_rate}%` }}
                  />
                </div>
                <div className="flex justify-between text-xs text-slate-600 mt-1">
                  <span>0%</span><span>50%</span><span>80% target</span><span>100%</span>
                </div>
              </div>

              {/* Recent trades */}
              <div className="bg-dark-900 rounded-xl border border-dark-700 p-5">
                <h2 className="text-sm font-semibold text-slate-400 uppercase tracking-wider mb-3">
                  Recent Trades ({backtest.trades?.length ?? 0} total)
                </h2>
                <div className="overflow-x-auto">
                  <table className="w-full text-xs font-mono">
                    <thead>
                      <tr className="text-slate-500 border-b border-dark-700">
                        <th className="text-left py-2 pr-4">Date</th>
                        <th className="text-left py-2 pr-4">Dir</th>
                        <th className="text-right py-2 pr-4">Entry</th>
                        <th className="text-right py-2 pr-4">Exit</th>
                        <th className="text-right py-2 pr-4">P&L</th>
                        <th className="text-center py-2 pr-4">Result</th>
                        <th className="text-center py-2">Factors</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(backtest.trades ?? []).slice(-50).reverse().map((t, i) => (
                        <tr key={i} className="border-b border-dark-800 hover:bg-dark-800/40 transition-colors">
                          <td className="py-1.5 pr-4 text-slate-400">{t.date}</td>
                          <td className={`py-1.5 pr-4 font-bold ${t.direction === 'CE' ? 'text-emerald-400' : 'text-rose-400'}`}>{t.direction}</td>
                          <td className="py-1.5 pr-4 text-right text-slate-300">{t.entry.toFixed(0)}</td>
                          <td className="py-1.5 pr-4 text-right text-slate-300">{t.exit.toFixed(0)}</td>
                          <td className={`py-1.5 pr-4 text-right font-bold ${t.pnl_pct > 0 ? 'text-emerald-400' : 'text-rose-400'}`}>{pct(t.pnl_pct)}</td>
                          <td className="py-1.5 pr-4 text-center">
                            <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${
                              t.result === 'WIN' ? 'bg-emerald-500/20 text-emerald-400' :
                              t.result === 'LOSS' ? 'bg-rose-500/20 text-rose-400' :
                              'bg-slate-700/50 text-slate-400'
                            }`}>{t.result}</span>
                          </td>
                          <td className="py-1.5 text-center text-slate-400">{t.factors_confirmed}/5</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          ) : <div className="text-slate-400">No backtest data.</div>}
        </div>
      )}

      {/* ── SETUP GUIDE TAB ── */}
      {activeTab === 'setup' && (
        <div className="space-y-4 max-w-3xl">
          <div className="bg-dark-900 rounded-xl border border-dark-700 p-5">
            <h2 className="text-base font-bold text-white mb-4">TradingView Setup Instructions</h2>
            <ol className="space-y-4 text-sm text-slate-300">
              <li className="flex gap-3">
                <span className="w-6 h-6 rounded-full bg-violet-600 text-white text-xs flex items-center justify-center font-bold shrink-0">1</span>
                <div>Open TradingView Desktop → search <span className="font-mono bg-dark-800 px-1 rounded">NSE:NIFTY</span> → set timeframe to <strong>5 minutes</strong></div>
              </li>
              <li className="flex gap-3">
                <span className="w-6 h-6 rounded-full bg-violet-600 text-white text-xs flex items-center justify-center font-bold shrink-0">2</span>
                <div>Open Pine Script Editor → paste the strategy from <span className="font-mono bg-dark-800 px-1 rounded">tradingview/NiftyOptions_PowerSetup.pine</span></div>
              </li>
              <li className="flex gap-3">
                <span className="w-6 h-6 rounded-full bg-violet-600 text-white text-xs flex items-center justify-center font-bold shrink-0">3</span>
                <div>Click <strong>Add to chart</strong> → go to <strong>Strategy Tester</strong> tab → review win rate on 3Y data</div>
              </li>
              <li className="flex gap-3">
                <span className="w-6 h-6 rounded-full bg-violet-600 text-white text-xs flex items-center justify-center font-bold shrink-0">4</span>
                <div>Set <strong>Alerts</strong> → "CE BUY Signal" and "PE BUY Signal" → notify on phone/desktop</div>
              </li>
              <li className="flex gap-3">
                <span className="w-6 h-6 rounded-full bg-violet-600 text-white text-xs flex items-center justify-center font-bold shrink-0">5</span>
                <div>When alert fires → buy ATM CE/PE from broker → follow entry/target/stop from the info table on chart</div>
              </li>
            </ol>
          </div>

          <div className="bg-dark-900 rounded-xl border border-dark-700 p-5">
            <h2 className="text-sm font-bold text-slate-300 mb-3">Strategy Logic</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs text-slate-400">
              {[
                ['Supertrend (7, 3)', 'Primary trend filter. Green = bullish bias only.'],
                ['EMA 9 / EMA 21', 'EMA 9 above EMA 21 = momentum is up.'],
                ['VWAP', 'Price above VWAP = institutional buying pressure.'],
                ['RSI (14)', 'Must be 55–75 (bull) or 25–45 (bear). Avoids extremes.'],
                ['Volume Spike', 'Must be 1.5x 20-bar average. Confirms conviction.'],
                ['Session Filter', '9:30 AM – 2:00 PM IST only. Avoids choppy open/close.'],
              ].map(([name, desc]) => (
                <div key={name} className="flex gap-2 p-2 bg-dark-800 rounded-lg">
                  <div className="w-2 h-2 rounded-full bg-violet-500 mt-1 shrink-0" />
                  <div><strong className="text-slate-300">{name}</strong> — {desc}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
