import { useEffect, useState } from 'react'
import {
  getICTSMCSignal, getICTSMCBacktest,
  type ICTSMCSignal, type ICTSMCBacktestResult,
  type ICTAnalysis, type ICTOrderBlock, type ICTLiquidityLevel,
} from '../api/client'
import ICTSMCChart from '../components/ICTSMCChart'

// ─── Helpers ──────────────────────────────────────────────────────────────────

const fmt = (n: number, d = 0) => n?.toLocaleString('en-IN', { maximumFractionDigits: d, minimumFractionDigits: d }) ?? '—'
const fmtPct = (n: number) => (n >= 0 ? '+' : '') + n?.toFixed(2) + '%'

function Badge({ label, color }: { label: string; color: string }) {
  return (
    <span className={`px-2 py-0.5 rounded text-xs font-bold tracking-wide ${color}`}>{label}</span>
  )
}

function StatCard({ label, value, sub, color = 'text-white' }: {
  label: string; value: string; sub?: string; color?: string
}) {
  return (
    <div className="bg-dark-800 border border-slate-800 rounded-xl p-4 flex flex-col gap-1">
      <div className="text-xs text-slate-500 uppercase tracking-wide">{label}</div>
      <div className={`text-2xl font-bold font-mono ${color}`}>{value}</div>
      {sub && <div className="text-xs text-slate-500">{sub}</div>}
    </div>
  )
}

function WinRateBar({ wr, label }: { wr: number; label: string }) {
  const color = wr >= 70 ? 'bg-emerald-500' : wr >= 55 ? 'bg-amber-500' : 'bg-red-500'
  return (
    <div className="space-y-1">
      <div className="flex justify-between text-xs">
        <span className="text-slate-400">{label}</span>
        <span className={`font-mono font-bold ${wr >= 70 ? 'text-emerald-400' : wr >= 55 ? 'text-amber-400' : 'text-red-400'}`}>{wr.toFixed(1)}%</span>
      </div>
      <div className="h-2 bg-slate-800 rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${Math.min(wr, 100)}%` }} />
      </div>
    </div>
  )
}

// ─── ICT Analysis Panel ───────────────────────────────────────────────────────

function OrderBlockCard({ ob, spot }: { ob: ICTOrderBlock; spot: number }) {
  const isBull = ob.type === 'BULL'
  const inZone = spot >= ob.low * 0.999 && spot <= ob.high * 1.001
  return (
    <div className={`rounded-lg border p-3 ${isBull
      ? 'border-emerald-700/40 bg-emerald-900/10'
      : 'border-red-700/40 bg-red-900/10'}`}>
      <div className="flex items-center justify-between mb-2">
        <span className={`text-xs font-bold uppercase ${isBull ? 'text-emerald-400' : 'text-red-400'}`}>
          {isBull ? '🟢' : '🔴'} {ob.type} Order Block
        </span>
        <div className="flex gap-1">
          {inZone && <Badge label="IN ZONE" color="bg-amber-500/20 text-amber-300 border border-amber-500/30" />}
          {ob.mitigated && <Badge label="MITIGATED" color="bg-slate-700 text-slate-400" />}
        </div>
      </div>
      <div className="grid grid-cols-3 gap-2 text-xs">
        <div><div className="text-slate-500">High</div><div className="font-mono text-white">{fmt(ob.high, 0)}</div></div>
        <div><div className="text-slate-500">Mid</div><div className="font-mono text-amber-300">{fmt(ob.mid, 0)}</div></div>
        <div><div className="text-slate-500">Low</div><div className="font-mono text-white">{fmt(ob.low, 0)}</div></div>
      </div>
      <div className="text-xs text-slate-500 mt-1">{ob.bars_ago} bars ago</div>
    </div>
  )
}

function ICTPanel({ ict, spot }: { ict: ICTAnalysis; spot: number }) {
  const bsl = ict.liq_levels?.filter(l => l.type === 'BSL') ?? []
  const ssl = ict.liq_levels?.filter(l => l.type === 'SSL') ?? []

  return (
    <div className="space-y-4">
      {/* Structure */}
      <div className="bg-dark-800 border border-slate-800 rounded-xl p-4 space-y-3">
        <div className="text-sm font-semibold text-slate-300">Market Structure (ICT)</div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div className="text-center">
            <div className="text-xs text-slate-500 mb-1">HTF Bias</div>
            <Badge label={ict.bias}
              color={ict.bias === 'BULL' ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
                : ict.bias === 'BEAR' ? 'bg-red-500/20 text-red-300 border border-red-500/30'
                : 'bg-slate-700 text-slate-400'} />
          </div>
          <div className="text-center">
            <div className="text-xs text-slate-500 mb-1">CHoCH</div>
            <Badge label={ict.choch ? `YES (${ict.choch_dir})` : 'NO'}
              color={ict.choch ? 'bg-amber-500/20 text-amber-300 border border-amber-500/30' : 'bg-slate-700 text-slate-400'} />
          </div>
          <div className="text-center">
            <div className="text-xs text-slate-500 mb-1">MSS</div>
            <Badge label={ict.mss ? 'CONFIRMED' : 'PENDING'}
              color={ict.mss ? 'bg-fuchsia-500/20 text-fuchsia-300 border border-fuchsia-500/30' : 'bg-slate-700 text-slate-400'} />
          </div>
          <div className="text-center">
            <div className="text-xs text-slate-500 mb-1">Zone</div>
            <Badge label={ict.in_premium ? 'PREMIUM' : ict.in_discount ? 'DISCOUNT' : 'EQUIL.'}
              color={ict.in_discount ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
                : ict.in_premium ? 'bg-red-500/20 text-red-300 border border-red-500/30'
                : 'bg-slate-700 text-slate-400'} />
          </div>
        </div>
      </div>

      {/* OTE Zone */}
      <div className="bg-dark-800 border border-slate-800 rounded-xl p-4">
        <div className="flex items-center justify-between mb-3">
          <div className="text-sm font-semibold text-slate-300">OTE Zone (61.8–79% Fib)</div>
          {ict.in_ote && <Badge label="PRICE IN OTE" color="bg-amber-500/20 text-amber-300 border border-amber-500/30" />}
        </div>
        <div className="grid grid-cols-3 gap-4 text-sm">
          <div><div className="text-xs text-slate-500">OTE Low</div><div className="font-mono text-emerald-400">{fmt(ict.ote_low, 0)}</div></div>
          <div><div className="text-xs text-slate-500">Equilibrium</div><div className="font-mono text-slate-300">{fmt(ict.equilibrium, 0)}</div></div>
          <div><div className="text-xs text-slate-500">OTE High</div><div className="font-mono text-red-400">{fmt(ict.ote_high, 0)}</div></div>
        </div>
        <div className="text-xs text-slate-500 mt-2">
          Swing: {fmt(ict.swing_low, 0)} — {fmt(ict.swing_high, 0)}
        </div>
      </div>

      {/* Order Blocks */}
      <div className="bg-dark-800 border border-slate-800 rounded-xl p-4 space-y-3">
        <div className="text-sm font-semibold text-slate-300">Order Blocks</div>
        {ict.bull_ob && <OrderBlockCard ob={ict.bull_ob} spot={spot} />}
        {ict.bear_ob && <OrderBlockCard ob={ict.bear_ob} spot={spot} />}
        {!ict.bull_ob && !ict.bear_ob && (
          <div className="text-xs text-slate-500">No active order blocks detected</div>
        )}
      </div>

      {/* Liquidity */}
      {(bsl.length > 0 || ssl.length > 0) && (
        <div className="bg-dark-800 border border-slate-800 rounded-xl p-4">
          <div className="text-sm font-semibold text-slate-300 mb-3">Liquidity Levels</div>
          <div className="space-y-2">
            {bsl.map((l, i) => (
              <LiqRow key={`bsl-${i}`} level={l} />
            ))}
            {ssl.map((l, i) => (
              <LiqRow key={`ssl-${i}`} level={l} />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function LiqRow({ level }: { level: ICTLiquidityLevel }) {
  const isBSL = level.type === 'BSL'
  return (
    <div className={`flex items-center justify-between p-2 rounded-lg ${isBSL ? 'bg-emerald-900/10 border border-emerald-800/30' : 'bg-red-900/10 border border-red-800/30'}`}>
      <div className="flex items-center gap-2">
        <span className={`text-xs font-bold ${isBSL ? 'text-emerald-400' : 'text-red-400'}`}>{level.type}</span>
        <span className="text-xs text-slate-400">Equal {isBSL ? 'Highs' : 'Lows'} ({level.count}×)</span>
      </div>
      <div className="flex items-center gap-2">
        <span className="font-mono text-sm text-slate-200">{fmt(level.price, 0)}</span>
        {level.swept && <Badge label="SWEPT" color="bg-slate-700 text-slate-400" />}
      </div>
    </div>
  )
}

// ─── Live Signal Panel ────────────────────────────────────────────────────────

function LiveSignalPanel({ sig }: { sig: ICTSMCSignal }) {
  const isBuy = sig.signal === 'CE_BUY'
  const isSell = sig.signal === 'PE_BUY'
  const isWait = sig.signal === 'WAIT'

  const signalColor = isBuy ? 'text-emerald-400' : isSell ? 'text-red-400' : 'text-amber-400'
  const signalBg = isBuy ? 'bg-emerald-500/10 border-emerald-600/40' : isSell ? 'bg-red-500/10 border-red-600/40' : 'bg-amber-500/10 border-amber-600/40'
  const biasColor = sig.combined_bias === 'BULL' ? 'text-emerald-400' : sig.combined_bias === 'BEAR' ? 'text-red-400' : 'text-slate-400'

  return (
    <div className="space-y-4">
      {/* Signal Header */}
      <div className={`border rounded-2xl p-5 ${signalBg}`}>
        <div className="flex items-center justify-between mb-4">
          <div>
            <div className="text-xs text-slate-500 uppercase tracking-widest mb-1">Live ICT+SMC Signal</div>
            <div className={`text-3xl font-black ${signalColor}`}>
              {isWait ? '⏳ WAIT' : isBuy ? '🟢 CE BUY' : '🔴 PE BUY'}
            </div>
            <div className="text-xs text-slate-400 mt-1">
              Combined Bias: <span className={`font-bold ${biasColor}`}>{sig.combined_bias}</span>
            </div>
          </div>
          <div className="text-right">
            <div className="text-xs text-slate-500">Spot Price</div>
            <div className="text-2xl font-mono font-bold text-white">{fmt(sig.spot_price, 0)}</div>
            <div className="text-xs text-slate-500">Confluence</div>
            <div className="text-lg font-mono font-bold text-amber-400">{sig.confluence}/10</div>
          </div>
        </div>

        {/* Confidence bar */}
        <div className="space-y-1">
          <div className="flex justify-between text-xs text-slate-500">
            <span>Signal Confidence</span>
            <span className={signalColor}>{sig.confidence}%</span>
          </div>
          <div className="h-2 bg-dark-900/60 rounded-full overflow-hidden">
            <div className={`h-full rounded-full ${isBuy ? 'bg-emerald-500' : isSell ? 'bg-red-500' : 'bg-amber-500'}`}
              style={{ width: `${sig.confidence}%` }} />
          </div>
        </div>
      </div>

      {/* Trade Levels */}
      {!isWait && (
        <div className="bg-dark-800 border border-slate-800 rounded-xl p-4">
          <div className="text-sm font-semibold text-slate-300 mb-3">Trade Setup</div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div className="bg-slate-900/60 rounded-lg p-3 text-center">
              <div className="text-xs text-slate-500 mb-1">Entry</div>
              <div className="text-lg font-mono font-bold text-white">{fmt(sig.entry, 0)}</div>
            </div>
            <div className="bg-emerald-900/20 border border-emerald-800/30 rounded-lg p-3 text-center">
              <div className="text-xs text-slate-500 mb-1">Target 1</div>
              <div className="text-lg font-mono font-bold text-emerald-400">{fmt(sig.target1, 0)}</div>
              <div className="text-xs text-emerald-600">1.5R</div>
            </div>
            <div className="bg-emerald-900/20 border border-emerald-800/30 rounded-lg p-3 text-center">
              <div className="text-xs text-slate-500 mb-1">Target 2</div>
              <div className="text-lg font-mono font-bold text-emerald-300">{fmt(sig.target2, 0)}</div>
              <div className="text-xs text-emerald-600">3R</div>
            </div>
            <div className="bg-red-900/20 border border-red-800/30 rounded-lg p-3 text-center">
              <div className="text-xs text-slate-500 mb-1">Stop Loss</div>
              <div className="text-lg font-mono font-bold text-red-400">{fmt(sig.stop_loss, 0)}</div>
              <div className="text-xs text-red-600">R:R {sig.risk_reward}x</div>
            </div>
          </div>
        </div>
      )}

      {/* FVG Zone */}
      {sig.smc_fvg_low > 0 && (
        <div className="bg-dark-800 border border-slate-800 rounded-xl p-4">
          <div className="text-sm font-semibold text-slate-300 mb-2">SMC Fair Value Gap</div>
          <div className="flex items-center gap-4 text-sm">
            <div><span className="text-slate-500">Low: </span><span className="font-mono text-red-400">{fmt(sig.smc_fvg_low, 0)}</span></div>
            <div className="text-slate-600">→</div>
            <div><span className="text-slate-500">High: </span><span className="font-mono text-emerald-400">{fmt(sig.smc_fvg_high, 0)}</span></div>
            <div><span className="text-slate-500">Mid: </span><span className="font-mono text-amber-400">{fmt((sig.smc_fvg_low + sig.smc_fvg_high) / 2, 0)}</span></div>
            {sig.smc_sweep_type && (
              <Badge label={`${sig.smc_sweep_type} SWEPT`} color="bg-fuchsia-500/20 text-fuchsia-300 border border-fuchsia-500/30" />
            )}
          </div>
        </div>
      )}

      {/* Risk Management */}
      {sig.risk && sig.risk.account_size > 0 && (
        <div className="bg-dark-800 border border-slate-800 rounded-xl p-4">
          <div className="text-sm font-semibold text-slate-300 mb-3">Risk Management (₹1L account)</div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
            <div><div className="text-xs text-slate-500">Suggested Lots</div><div className="font-mono font-bold text-white">{sig.risk.suggested_lots}</div></div>
            <div><div className="text-xs text-slate-500">Max Loss</div><div className="font-mono font-bold text-red-400">₹{fmt(sig.risk.max_loss_inr, 0)}</div></div>
            <div><div className="text-xs text-slate-500">Target Gain</div><div className="font-mono font-bold text-emerald-400">₹{fmt(sig.risk.target_gain_inr, 0)}</div></div>
            <div><div className="text-xs text-slate-500">Stop Pts</div><div className="font-mono font-bold text-slate-300">{sig.risk.stop_distance_pts} pts</div></div>
          </div>
        </div>
      )}

      {/* Reasoning */}
      <div className="bg-dark-800 border border-slate-800 rounded-xl p-4">
        <div className="text-sm font-semibold text-slate-300 mb-3">Signal Analysis</div>
        <ul className="space-y-1.5">
          {sig.reasoning?.map((r, i) => (
            <li key={i} className={`text-xs flex items-start gap-2 ${r.startsWith('✓') ? 'text-emerald-400' : r.startsWith('⚠') ? 'text-amber-400' : 'text-slate-400'}`}>
              <span className="mt-0.5 flex-shrink-0">•</span>
              <span>{r}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}

// ─── Backtest Panel ───────────────────────────────────────────────────────────

function BacktestPanel({ bt, years, setYears }: {
  bt: ICTSMCBacktestResult
  years: number
  setYears: (y: number) => void
}) {
  const wrColor = bt.win_rate >= 70 ? 'text-emerald-400' : bt.win_rate >= 55 ? 'text-amber-400' : 'text-red-400'

  return (
    <div className="space-y-4">
      {/* Year selector */}
      <div className="flex gap-2">
        {[1, 2, 3, 5].map(y => (
          <button key={y} onClick={() => setYears(y)}
            className={`px-3 py-1 rounded-lg text-sm font-medium transition-colors ${years === y ? 'bg-brand-600 text-white' : 'bg-dark-800 text-slate-400 hover:text-white'}`}>
            {y}Y
          </button>
        ))}
      </div>

      {/* Summary stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <StatCard label="Win Rate" value={`${bt.win_rate?.toFixed(1)}%`} sub={`${bt.winning_trades}W / ${bt.losing_trades}L`} color={wrColor} />
        <StatCard label="Profit Factor" value={bt.profit_factor?.toFixed(2) ?? '—'} sub="Win $ / Loss $" color={bt.profit_factor >= 2 ? 'text-emerald-400' : 'text-amber-400'} />
        <StatCard label="Total Return" value={fmtPct(bt.total_return_pct)} sub={`${bt.total_trades} trades`} color={bt.total_return_pct >= 0 ? 'text-emerald-400' : 'text-red-400'} />
        <StatCard label="Max Drawdown" value={`${bt.max_drawdown_pct?.toFixed(1)}%`} sub="Peak-to-trough" color="text-red-400" />
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        <StatCard label="Avg Win" value={`+${bt.avg_win_pct?.toFixed(2)}%`} color="text-emerald-400" />
        <StatCard label="Avg Loss" value={`-${bt.avg_loss_pct?.toFixed(2)}%`} color="text-red-400" />
        <StatCard label="Sharpe Ratio" value={bt.sharpe_ratio?.toFixed(2) ?? '—'} color={bt.sharpe_ratio >= 1.5 ? 'text-emerald-400' : 'text-amber-400'} />
      </div>

      {/* Sub-strategy breakdown */}
      <div className="bg-dark-800 border border-slate-800 rounded-xl p-4 space-y-4">
        <div className="text-sm font-semibold text-slate-300">Strategy Breakdown</div>
        {[
          { label: '🔷 Combined ICT+SMC (A+ Setups)', stats: bt.combined_a_plus },
          { label: '🟦 ICT Order Block Only', stats: bt.ict_ob_only },
          { label: '🟪 SMC FVG Only', stats: bt.smc_fvg_only },
        ].map(({ label, stats }) => (
          <div key={label} className="space-y-2">
            <div className="flex items-center justify-between text-xs">
              <span className="text-slate-300">{label}</span>
              <span className="text-slate-500">{stats?.trades ?? 0} trades | {fmtPct(stats?.net_pnl_pct ?? 0)} net</span>
            </div>
            <WinRateBar wr={stats?.win_rate ?? 0} label={`Win Rate: ${(stats?.wins ?? 0)}/${(stats?.trades ?? 0)}`} />
          </div>
        ))}
      </div>

      {/* Trade log */}
      {bt.trades && bt.trades.length > 0 && (
        <div className="bg-dark-800 border border-slate-800 rounded-xl p-4">
          <div className="text-sm font-semibold text-slate-300 mb-3">Recent Trades</div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-slate-500 border-b border-slate-800">
                  <th className="text-left py-2 pr-4">Date</th>
                  <th className="text-left py-2 pr-4">Dir</th>
                  <th className="text-left py-2 pr-4">Setup</th>
                  <th className="text-right py-2 pr-4">Entry</th>
                  <th className="text-right py-2 pr-4">PnL %</th>
                  <th className="text-right py-2 pr-4">Conf.</th>
                  <th className="text-right py-2">Result</th>
                </tr>
              </thead>
              <tbody>
                {bt.trades.slice(-30).reverse().map((t, i) => (
                  <tr key={i} className="border-b border-slate-800/40 hover:bg-slate-800/30">
                    <td className="py-1.5 pr-4 text-slate-400">{t.entry_date}</td>
                    <td className="py-1.5 pr-4">
                      <span className={`font-bold ${t.direction === 'CE' ? 'text-emerald-400' : 'text-red-400'}`}>{t.direction}</span>
                    </td>
                    <td className="py-1.5 pr-4 text-slate-400">{t.setup}</td>
                    <td className="py-1.5 pr-4 text-right font-mono text-slate-300">{fmt(t.entry, 0)}</td>
                    <td className={`py-1.5 pr-4 text-right font-mono font-bold ${t.pnl_pct >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                      {fmtPct(t.pnl_pct)}
                    </td>
                    <td className="py-1.5 pr-4 text-right text-amber-400">{t.confluence}</td>
                    <td className="py-1.5 text-right">
                      <Badge label={t.result}
                        color={t.result === 'WIN' ? 'bg-emerald-500/20 text-emerald-300'
                          : t.result === 'LOSS' ? 'bg-red-500/20 text-red-300'
                          : 'bg-slate-700 text-slate-400'} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Education Panel ──────────────────────────────────────────────────────────

function EducationPanel() {
  return (
    <div className="space-y-6">
      {/* ICT Concepts */}
      <div className="bg-dark-800 border border-slate-800 rounded-xl p-5">
        <div className="text-base font-bold text-white mb-4">📐 ICT (Inner Circle Trader) Concepts</div>
        <div className="grid sm:grid-cols-2 gap-4">
          {[
            { title: 'Order Block (OB)', icon: '📦', desc: 'The last opposing candle before a strong impulse move. Price returns to these zones where institutions placed orders. Bull OB = last bearish candle before rally. Bear OB = last bullish candle before selloff.' },
            { title: 'CHoCH — Change of Character', icon: '🔄', desc: 'First structural break against the prevailing trend. In an uptrend: a break below the last swing low is CHoCH bearish. Signals potential reversal before MSS confirmation.' },
            { title: 'MSS — Market Structure Shift', icon: '🏗️', desc: 'Confirmed reversal after CHoCH. Requires at least 2 consecutive closes in the new direction. Strong evidence of institutional order flow shifting sides.' },
            { title: 'OTE Zone (61.8–79% Fib)', icon: '🎯', desc: 'Optimal Trade Entry = the Fibonacci retracement zone between 61.8% and 79% of the last significant swing. This is where institutions scale into positions. Price in OTE = high-probability entry.' },
            { title: 'Premium / Discount', icon: '⚖️', desc: 'The 50% mark of a swing range is the equilibrium. Above 50% = Premium (sell zone, not ideal for longs). Below 50% = Discount (buy zone, ideal for longs). Trade with HTF bias in correct zone.' },
            { title: 'Liquidity (BSL / SSL)', icon: '💧', desc: 'Equal highs = Buy-Side Liquidity (BSL). Equal lows = Sell-Side Liquidity (SSL). Price hunts these levels (stop-hunt) before reversing. A swept SSL in a bullish trend = buy signal.' },
          ].map(c => (
            <div key={c.title} className="bg-dark-900/60 rounded-lg p-3">
              <div className="text-sm font-semibold text-slate-200 mb-1">{c.icon} {c.title}</div>
              <div className="text-xs text-slate-400 leading-relaxed">{c.desc}</div>
            </div>
          ))}
        </div>
      </div>

      {/* SMC Concepts */}
      <div className="bg-dark-800 border border-slate-800 rounded-xl p-5">
        <div className="text-base font-bold text-white mb-4">🔷 SMC (Smart Money Concepts)</div>
        <div className="grid sm:grid-cols-3 gap-4">
          {[
            { title: 'HTF Market Structure', icon: '📊', desc: 'Higher Highs + Higher Lows = BULL. Lower Highs + Lower Lows = BEAR. Only trade in direction of HTF bias.' },
            { title: 'Liquidity Sweep', icon: '🌊', desc: 'Price wicks beyond 12-bar high/low then closes back inside — smart money absorbed retail stops. Sweep LOW in uptrend = buy. Sweep HIGH in downtrend = sell.' },
            { title: 'Fair Value Gap (FVG)', icon: '📉', desc: '3-candle imbalance: when candle[i-2].high < candle[i].low (bull FVG) or candle[i-2].low > candle[i].high (bear FVG). Price returns to fill the gap — ideal entry zone.' },
          ].map(c => (
            <div key={c.title} className="bg-dark-900/60 rounded-lg p-3">
              <div className="text-sm font-semibold text-slate-200 mb-1">{c.icon} {c.title}</div>
              <div className="text-xs text-slate-400 leading-relaxed">{c.desc}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Combined Strategy Rules */}
      <div className="bg-dark-800 border border-slate-800 rounded-xl p-5">
        <div className="text-base font-bold text-white mb-4">⚡ Combined ICT+SMC Entry Rules</div>
        <div className="space-y-3">
          {[
            { step: '1', label: 'Confirm HTF Bias', detail: 'Both ICT structure and SMC bias must agree. ICT looks at HH/HL/LH/LL swings; SMC uses its own 80-bar bias calculation. Conflict = WAIT.', color: 'text-blue-400' },
            { step: '2', label: 'Find CHoCH / MSS', detail: 'CHoCH shows first reversal signal. MSS (2+ closes in new direction after CHoCH) confirms. Together they add 2 points to confluence score — boosting signal quality.', color: 'text-fuchsia-400' },
            { step: '3', label: 'Locate Order Block', detail: 'Find the last opposing candle before a strong impulse (≥0.7% move in 2 bars). Price retesting the OB zone is the trigger. OB must not be mitigated (price traded through it).', color: 'text-amber-400' },
            { step: '4', label: 'Check OTE + Zone', detail: 'Is price in the 61.8–79% Fibonacci retracement OTE zone? Is it in Discount (for longs) or Premium (for shorts)? These add 2 more confluence points.', color: 'text-emerald-400' },
            { step: '5', label: 'SMC FVG Confluence', detail: 'If the SMC Fair Value Gap overlaps with the OB zone — this is an A+ setup. Price inside FVG adds 2 confluence points. FVG+OB overlap = highest probability entry.', color: 'text-cyan-400' },
            { step: '6', label: 'Liquidity Sweep', detail: 'Bonus confluence: if a liquidity sweep occurred in the aligned direction (SSL swept in bullish trade), smart money repositioned — adds 1 more point.', color: 'text-orange-400' },
            { step: '7', label: 'Entry & Risk', detail: 'Entry at OB/FVG overlap mid. Stop below OB low (for longs) + 10pt buffer. T1 = 1.5R, T2 = 3R. Risk max 1% of account. Confluence ≥4 required to trade.', color: 'text-red-400' },
          ].map(r => (
            <div key={r.step} className="flex gap-3">
              <div className={`w-6 h-6 rounded-full bg-dark-900 flex items-center justify-center text-xs font-bold ${r.color} flex-shrink-0 mt-0.5`}>{r.step}</div>
              <div>
                <div className={`text-sm font-semibold ${r.color}`}>{r.label}</div>
                <div className="text-xs text-slate-400 leading-relaxed">{r.detail}</div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Confluence Scoring */}
      <div className="bg-dark-800 border border-slate-800 rounded-xl p-5">
        <div className="text-base font-bold text-white mb-4">🎯 Confluence Score Guide</div>
        <div className="space-y-2">
          {[
            { range: '8–10', grade: 'A+', label: 'OB + FVG + CHoCH + MSS + Sweep + Both Biases', color: 'text-emerald-400', badge: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30' },
            { range: '6–7', grade: 'A', label: 'OB + FVG + Both Biases (or OB + MSS + Zone)', color: 'text-emerald-300', badge: 'bg-emerald-500/10 text-emerald-400 border-emerald-600/30' },
            { range: '4–5', grade: 'B', label: 'Single framework + OB or FVG trigger', color: 'text-amber-400', badge: 'bg-amber-500/20 text-amber-300 border-amber-500/30' },
            { range: '< 4', grade: 'WAIT', label: 'Insufficient confluence — stay out', color: 'text-slate-400', badge: 'bg-slate-700 text-slate-400 border-slate-600' },
          ].map(g => (
            <div key={g.range} className="flex items-center gap-3 p-2 rounded-lg bg-dark-900/50">
              <Badge label={g.grade} color={`border ${g.badge}`} />
              <span className="text-xs text-slate-500">Score {g.range}:</span>
              <span className={`text-xs ${g.color}`}>{g.label}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

// ─── Main Page ────────────────────────────────────────────────────────────────

const TABS = ['Signal', 'Chart', 'ICT Analysis', 'Backtest', 'How to Use'] as const
type Tab = typeof TABS[number]

export default function ICTSMCStrategy() {
  const [tab, setTab] = useState<Tab>('Signal')
  const [signal, setSignal] = useState<ICTSMCSignal | null>(null)
  const [btResult, setBtResult] = useState<ICTSMCBacktestResult | null>(null)
  const [years, setYears] = useState(3)
  const [loadingSig, setLoadingSig] = useState(true)
  const [loadingBt, setLoadingBt] = useState(false)
  const [sigError, setSigError] = useState('')
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null)

  const fetchSignal = async () => {
    setLoadingSig(true)
    setSigError('')
    try {
      const s = await getICTSMCSignal()
      setSignal(s)
      setLastRefresh(new Date())
    } catch (e: unknown) {
      setSigError(e instanceof Error ? e.message : 'Failed to fetch signal')
    } finally {
      setLoadingSig(false)
    }
  }

  const fetchBacktest = async () => {
    setLoadingBt(true)
    try {
      const { result } = await getICTSMCBacktest(years)
      setBtResult(result)
    } catch { /* silent */ }
    finally { setLoadingBt(false) }
  }

  useEffect(() => { fetchSignal() }, [])
  useEffect(() => {
    if (tab === 'Backtest') fetchBacktest()
  }, [tab, years])

  // Auto-refresh signal every 60s
  useEffect(() => {
    const id = setInterval(fetchSignal, 60_000)
    return () => clearInterval(id)
  }, [])

  const sigColor = signal?.signal === 'CE_BUY' ? 'bg-emerald-500/10 border-emerald-600/30'
    : signal?.signal === 'PE_BUY' ? 'bg-red-500/10 border-red-600/30'
    : 'bg-amber-500/10 border-amber-600/30'

  return (
    <div className="min-h-screen bg-dark-950 text-slate-200 pb-12">
      {/* Header */}
      <div className="bg-dark-900 border-b border-slate-800/60 px-4 py-5">
        <div className="max-w-6xl mx-auto">
          <div className="flex items-start justify-between">
            <div>
              <h1 className="text-2xl font-black text-white tracking-tight">
                ⚡ ICT + SMC Strategy
              </h1>
              <p className="text-sm text-slate-400 mt-0.5">
                Inner Circle Trader + Smart Money Concepts — Combined for Nifty 50
              </p>
            </div>
            <div className="text-right">
              {signal && !loadingSig && (
                <div className={`px-3 py-1.5 rounded-lg border text-sm font-bold ${sigColor}`}>
                  {signal.signal === 'CE_BUY' ? '🟢 CE BUY' : signal.signal === 'PE_BUY' ? '🔴 PE BUY' : '⏳ WAIT'}
                </div>
              )}
              {lastRefresh && (
                <div className="text-xs text-slate-600 mt-1">
                  Updated {lastRefresh.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}
                </div>
              )}
            </div>
          </div>

          {/* Quick Stats Bar */}
          {signal && (
            <div className="flex flex-wrap gap-4 mt-4 text-sm">
              <div><span className="text-slate-500">Spot: </span><span className="font-mono font-bold text-white">{fmt(signal.spot_price, 0)}</span></div>
              <div><span className="text-slate-500">Combined Bias: </span>
                <span className={`font-bold ${signal.combined_bias === 'BULL' ? 'text-emerald-400' : signal.combined_bias === 'BEAR' ? 'text-red-400' : 'text-slate-400'}`}>
                  {signal.combined_bias}
                </span>
              </div>
              <div><span className="text-slate-500">Confluence: </span><span className="font-bold text-amber-400">{signal.confluence}/10</span></div>
              <div><span className="text-slate-500">ICT Bias: </span>
                <span className={`font-bold ${signal.ict?.bias === 'BULL' ? 'text-emerald-400' : signal.ict?.bias === 'BEAR' ? 'text-red-400' : 'text-slate-400'}`}>
                  {signal.ict?.bias}
                </span>
              </div>
              <div><span className="text-slate-500">SMC Bias: </span>
                <span className={`font-bold ${signal.smc_bias === 'BULL' ? 'text-emerald-400' : signal.smc_bias === 'BEAR' ? 'text-red-400' : 'text-slate-400'}`}>
                  {signal.smc_bias}
                </span>
              </div>
              {signal.ict?.choch && <Badge label={`CHoCH ${signal.ict.choch_dir}`} color="bg-amber-500/20 text-amber-300 border border-amber-500/30" />}
              {signal.ict?.mss && <Badge label="MSS ✓" color="bg-fuchsia-500/20 text-fuchsia-300 border border-fuchsia-500/30" />}
            </div>
          )}
        </div>
      </div>

      {/* Tabs */}
      <div className="max-w-6xl mx-auto px-4">
        <div className="flex gap-1 mt-4 mb-6 border-b border-slate-800">
          {TABS.map(t => (
            <button key={t} onClick={() => setTab(t)}
              className={`px-4 py-2.5 text-sm font-medium rounded-t-lg transition-colors ${tab === t
                ? 'text-white border-b-2 border-brand-500 bg-dark-800/40'
                : 'text-slate-400 hover:text-slate-200'}`}>
              {t}
            </button>
          ))}
          <button onClick={fetchSignal} className="ml-auto px-3 py-2 text-xs text-slate-500 hover:text-slate-300 transition-colors">
            {loadingSig ? '⟳ Loading…' : '⟳ Refresh'}
          </button>
        </div>

        {/* Signal Tab */}
        {tab === 'Signal' && (
          loadingSig ? (
            <div className="text-center py-20 text-slate-500">Loading live signal…</div>
          ) : sigError ? (
            <div className="text-center py-20 text-red-400">{sigError}</div>
          ) : signal ? (
            <LiveSignalPanel sig={signal} />
          ) : null
        )}

        {/* Chart Tab */}
        {tab === 'Chart' && <ICTSMCChart />}

        {/* ICT Analysis Tab */}
        {tab === 'ICT Analysis' && signal && (
          <ICTPanel ict={signal.ict} spot={signal.spot_price} />
        )}

        {/* Backtest Tab */}
        {tab === 'Backtest' && (
          loadingBt ? (
            <div className="text-center py-20 text-slate-500">Running backtest…</div>
          ) : btResult ? (
            <BacktestPanel bt={btResult} years={years} setYears={y => setYears(y)} />
          ) : null
        )}

        {/* Education Tab */}
        {tab === 'How to Use' && <EducationPanel />}
      </div>
    </div>
  )
}
