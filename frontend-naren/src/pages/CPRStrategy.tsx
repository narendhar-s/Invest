import { useEffect, useState, useCallback } from 'react'
import axios from 'axios'
import LoadingSpinner from '../components/LoadingSpinner'
import type {
  CPRMultiTimeframeSignal,
  CPRBacktestResult,
  CPRTimeframeCard,
  CPRLevels,
  CPRSignal,
} from '../api/client'

// ─── helpers ─────────────────────────────────────────────────────────────────

function fmt(n: number, d = 1) {
  return n.toLocaleString('en-IN', { minimumFractionDigits: d, maximumFractionDigits: d })
}
function pct(n: number, d = 2) {
  return (n >= 0 ? '+' : '') + n.toFixed(d) + '%'
}
function abs(n: number) { return Math.abs(n) }

const BIAS_STYLE: Record<string, string> = {
  BULLISH: 'text-emerald-400',
  BEARISH: 'text-rose-400',
  NEUTRAL: 'text-slate-400',
}
const BIAS_BG: Record<string, string> = {
  BULLISH: 'bg-emerald-500/15 border-emerald-500/30',
  BEARISH: 'bg-rose-500/15 border-rose-500/30',
  NEUTRAL: 'bg-slate-700/30 border-slate-600/30',
}
const DIR_STYLE: Record<string, string> = {
  ABOVE_CPR: 'text-emerald-400',
  BELOW_CPR: 'text-rose-400',
  INSIDE_CPR: 'text-amber-400',
}
const DIR_LABEL: Record<string, string> = {
  ABOVE_CPR: '▲ Above CPR',
  BELOW_CPR: '▼ Below CPR',
  INSIDE_CPR: '↔ Inside CPR',
}

// ─── PriceZoneBar ─────────────────────────────────────────────────────────────

function PriceZoneBar({ lvl, spot }: { lvl: CPRLevels; spot: number }) {
  const lo = lvl.s2 * 0.999
  const hi = lvl.r2 * 1.001
  const range = hi - lo || 1
  const pos = (p: number) => `${Math.min(100, Math.max(0, ((p - lo) / range) * 100)).toFixed(1)}%`

  const lines = [
    { price: lvl.r2, label: 'R2', cls: 'border-rose-500 text-rose-400' },
    { price: lvl.r1, label: 'R1', cls: 'border-rose-400/60 text-rose-300' },
    { price: lvl.tc, label: 'TC', cls: 'border-orange-400 text-orange-300 font-bold' },
    { price: lvl.pivot, label: 'P', cls: 'border-slate-400 text-slate-200 font-bold' },
    { price: lvl.bc, label: 'BC', cls: 'border-sky-400 text-sky-300 font-bold' },
    { price: lvl.s1, label: 'S1', cls: 'border-emerald-400/60 text-emerald-300' },
    { price: lvl.s2, label: 'S2', cls: 'border-emerald-500 text-emerald-400' },
  ]

  return (
    <div className="relative h-48 w-full select-none">
      {/* Background track */}
      <div className="absolute inset-x-12 inset-y-0 bg-dark-800/50 rounded-lg border border-slate-700/30" />

      {/* CPR zone highlight */}
      <div
        className="absolute inset-x-12 bg-amber-400/10 border-y border-amber-400/40"
        style={{ bottom: pos(lvl.bc), top: `${100 - parseFloat(pos(lvl.tc))}%` }}
      />

      {/* Level lines */}
      {lines.map(l => (
        <div
          key={l.label}
          className="absolute inset-x-12 flex items-center"
          style={{ bottom: pos(l.price) }}
        >
          <div className={`w-full border-t ${l.cls.split(' ')[0]} opacity-60`} />
          <span className={`absolute -left-11 text-[10px] font-mono ${l.cls.split(' ').slice(1).join(' ')} w-9 text-right`}>
            {l.label}
          </span>
          <span className="absolute right-0 translate-x-full pl-1.5 text-[10px] font-mono text-slate-400 whitespace-nowrap">
            {fmt(l.price, 0)}
          </span>
        </div>
      ))}

      {/* Spot line */}
      <div
        className="absolute inset-x-12 z-10"
        style={{ bottom: pos(spot) }}
      >
        <div className="w-full border-t-2 border-white" />
        <span className="absolute -left-12 -translate-y-1/2 text-[10px] font-bold text-white bg-dark-950 px-1 rounded">
          SPOT
        </span>
        <span className="absolute right-0 translate-x-full -translate-y-1/2 pl-1.5 text-[10px] font-bold text-white font-mono whitespace-nowrap">
          {fmt(spot, 0)}
        </span>
      </div>
    </div>
  )
}

// ─── Timeframe Card ───────────────────────────────────────────────────────────

function TimeframeCard({ card, accent }: { card: CPRTimeframeCard; accent: string }) {
  const lvl = card.levels
  return (
    <div className={`bg-dark-900 rounded-xl border ${accent} p-4 flex flex-col gap-3`}>
      {/* Header */}
      <div className="flex items-start justify-between gap-2">
        <div>
          <span className="text-sm font-bold text-white">{card.timeframe} CPR</span>
          <span className="ml-2 text-[11px] text-slate-500">{card.period_desc}</span>
          {card.is_virgin_cpr && (
            <span className="ml-2 px-1.5 py-0.5 rounded text-[10px] font-bold bg-fuchsia-500/20 text-fuchsia-300 border border-fuchsia-500/40 animate-pulse">
              🔮 VIRGIN
            </span>
          )}
        </div>
        <div className="flex flex-col items-end gap-1 shrink-0">
          <span className={`text-xs font-bold ${DIR_STYLE[card.direction] ?? 'text-slate-400'}`}>
            {DIR_LABEL[card.direction] ?? card.direction}
          </span>
          <span className={`text-[11px] font-semibold px-2 py-0.5 rounded border ${BIAS_BG[card.bias] ?? ''} ${BIAS_STYLE[card.bias] ?? ''}`}>
            {card.bias}
          </span>
        </div>
      </div>

      {/* Width badge + spot deltas */}
      <div className="flex items-center gap-2 flex-wrap">
        <span className={`text-[11px] px-2 py-0.5 rounded font-mono font-semibold border ${
          lvl.is_narrow
            ? 'bg-purple-500/15 text-purple-300 border-purple-500/30'
            : lvl.is_wide
              ? 'bg-amber-500/15 text-amber-300 border-amber-500/30'
              : 'bg-slate-700/40 text-slate-400 border-slate-600/30'
        }`}>
          {lvl.day_type} · {(lvl.width * 100).toFixed(2)}%
        </span>
        <span className="text-[10px] text-slate-500">
          vs TC <span className={card.spot_vs_tc >= 0 ? 'text-emerald-400' : 'text-rose-400'}>{pct(card.spot_vs_tc)}</span>
        </span>
        <span className="text-[10px] text-slate-500">
          vs BC <span className={card.spot_vs_bc >= 0 ? 'text-emerald-400' : 'text-rose-400'}>{pct(card.spot_vs_bc)}</span>
        </span>
      </div>

      {/* Virgin CPR alert */}
      {card.is_virgin_cpr && (
        <div className="px-3 py-2 rounded-lg bg-fuchsia-500/10 border border-fuchsia-500/25 text-[11px] text-fuchsia-300 leading-snug">
          🔮 <strong>Virgin CPR</strong> — {card.virgin_note}
        </div>
      )}

      {/* Price zone visual */}
      <PriceZoneBar lvl={lvl} spot={card.spot_price} />

      {/* Level grid */}
      <div className="grid grid-cols-4 gap-1 text-center text-[10px]">
        {[
          { lbl: 'R2', val: lvl.r2, c: 'text-rose-400' },
          { lbl: 'R1', val: lvl.r1, c: 'text-rose-300' },
          { lbl: 'TC', val: lvl.tc, c: 'text-orange-300 font-bold' },
          { lbl: 'Pivot', val: lvl.pivot, c: 'text-slate-100 font-bold' },
          { lbl: 'BC', val: lvl.bc, c: 'text-sky-300 font-bold' },
          { lbl: 'S1', val: lvl.s1, c: 'text-emerald-300' },
          { lbl: 'S2', val: lvl.s2, c: 'text-emerald-400' },
        ].map(l => (
          <div key={l.lbl} className="bg-dark-800/70 rounded px-1 py-1.5">
            <div className="text-slate-600 text-[9px] uppercase">{l.lbl}</div>
            <div className={`font-mono font-semibold ${l.c}`}>{fmt(l.val, 0)}</div>
          </div>
        ))}
      </div>
    </div>
  )
}

// ─── Live Signal Panel ────────────────────────────────────────────────────────

function LiveSignalPanel({ sig }: { sig: CPRSignal }) {
  const isAction = sig.direction === 'BUY' || sig.direction === 'SELL'
  const modeLabel: Record<string, string> = {
    NARROW_BREAKOUT: '⚡ Narrow CPR Breakout',
    CPR_BOUNCE:      '↩ CPR Bounce',
    WIDE_RANGE:      '↔ Wide CPR Range Trade',
    WAIT:            '⏳ Wait — Inside CPR',
  }
  const modeColor: Record<string, string> = {
    NARROW_BREAKOUT: 'bg-purple-500/15 border-purple-500/30 text-purple-300',
    CPR_BOUNCE:      'bg-sky-500/15 border-sky-500/30 text-sky-300',
    WIDE_RANGE:      'bg-amber-500/15 border-amber-500/30 text-amber-300',
    WAIT:            'bg-slate-700/40 border-slate-600/30 text-slate-400',
  }
  const dirBorder = sig.direction === 'BUY'
    ? 'border-emerald-500/40'
    : sig.direction === 'SELL'
      ? 'border-rose-500/40'
      : 'border-slate-700/40'

  return (
    <div className={`bg-dark-900 rounded-xl border ${dirBorder} p-5`}>
      <h3 className="text-xs font-semibold text-slate-500 uppercase mb-3">Live Trade Setup — Daily CPR</h3>
      <div className="flex items-center gap-3 mb-4 flex-wrap">
        <span className={`px-3 py-1 rounded border text-xs font-semibold ${modeColor[sig.mode] ?? modeColor.WAIT}`}>
          {modeLabel[sig.mode] ?? sig.mode}
        </span>
        <span className={`px-5 py-2 rounded border text-base font-black ${
          sig.direction === 'BUY'
            ? 'bg-emerald-500/20 border-emerald-500/40 text-emerald-300'
            : sig.direction === 'SELL'
              ? 'bg-rose-500/20 border-rose-500/40 text-rose-300'
              : 'bg-slate-700/40 border-slate-600/30 text-slate-400'
        }`}>
          {sig.direction === 'BUY' ? '▲ BUY' : sig.direction === 'SELL' ? '▼ SELL' : '— WAIT'}
        </span>
        <div className="flex gap-4 text-sm ml-auto">
          <span><span className="text-slate-500 text-xs">WR </span><span className="font-bold text-amber-400">{sig.win_rate.toFixed(1)}%</span></span>
          <span><span className="text-slate-500 text-xs">Conf </span><span className="font-bold text-emerald-400">{sig.confidence.toFixed(0)}%</span></span>
          <span><span className="text-slate-500 text-xs">R:R </span><span className="font-bold text-sky-400">{sig.risk_reward.toFixed(2)}</span></span>
        </div>
      </div>

      {isAction && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
          {[
            { label: 'Entry Zone', val: sig.entry_zone, mono: false },
            { label: 'Target 1',   val: fmt(sig.target_1, 0), mono: true },
            { label: 'Target 2',   val: fmt(sig.target_2, 0), mono: true },
            { label: 'Stop Loss',  val: fmt(sig.stop_loss, 0), mono: true },
          ].map(item => (
            <div key={item.label} className="bg-dark-800/60 rounded-lg p-3 text-center">
              <div className="text-[10px] text-slate-500 uppercase mb-1">{item.label}</div>
              <div className={`text-sm font-bold text-slate-100 ${item.mono ? 'font-mono' : ''} leading-snug`}>{item.val}</div>
            </div>
          ))}
        </div>
      )}

      {sig.reasons.length > 0 && (
        <ul className="space-y-1">
          {sig.reasons.map((r, i) => (
            <li key={i} className="flex items-start gap-2 text-xs text-slate-400">
              <span className="text-emerald-500 mt-0.5 shrink-0">✓</span>{r}
            </li>
          ))}
        </ul>
      )}

      {sig.caution && (
        <div className="mt-3 px-3 py-2 rounded-lg bg-fuchsia-500/10 border border-fuchsia-500/25 text-xs text-fuchsia-300">
          🔮 <strong>Virgin CPR Alert:</strong> {sig.caution}
        </div>
      )}
    </div>
  )
}

// ─── Backtest Panel ───────────────────────────────────────────────────────────

function BacktestPanel({ bt }: { bt: CPRBacktestResult }) {
  const modes = [
    { key: 'narrow_breakout', label: '⚡ Narrow Breakout', data: bt.narrow_breakout, color: 'border-purple-500/30 bg-purple-500/5' },
    { key: 'cpr_bounce',      label: '↩ CPR Bounce',       data: bt.cpr_bounce,      color: 'border-sky-500/30 bg-sky-500/5' },
    { key: 'wide_range',      label: '↔ Wide Range',       data: bt.wide_range,      color: 'border-amber-500/30 bg-amber-500/5' },
  ] as const

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3">
        {[
          { label: 'Win Rate',      val: `${bt.win_rate.toFixed(1)}%`,    color: 'text-emerald-400' },
          { label: 'Profit Factor', val: bt.profit_factor.toFixed(2),     color: 'text-amber-400' },
          { label: 'Net PnL',       val: pct(bt.net_pnl_pct),            color: bt.net_pnl_pct >= 0 ? 'text-emerald-400' : 'text-rose-400' },
          { label: 'Sharpe',        val: bt.sharpe_ratio.toFixed(2),      color: 'text-sky-400' },
          { label: 'Total Trades',  val: String(bt.total_trades),         color: 'text-slate-200' },
          { label: 'Avg Win',       val: pct(bt.avg_win_pct),            color: 'text-emerald-400' },
          { label: 'Max Drawdown',  val: `-${bt.max_drawdown_pct.toFixed(2)}%`, color: 'text-rose-400' },
        ].map(s => (
          <div key={s.label} className="bg-dark-900 rounded-xl border border-slate-700/40 p-3 text-center">
            <div className="text-[10px] text-slate-500 uppercase mb-1">{s.label}</div>
            <div className={`text-lg font-bold font-mono ${s.color}`}>{s.val}</div>
          </div>
        ))}
      </div>

      <div>
        <h3 className="text-sm font-semibold text-slate-400 uppercase mb-3">Win Rate by Mode</h3>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          {modes.map(m => (
            <div key={m.key} className={`rounded-xl border ${m.color} p-4`}>
              <div className="text-sm font-semibold text-slate-200 mb-3">{m.label}</div>
              <div className="grid grid-cols-2 gap-2 text-center mb-3">
                {[
                  { lbl: 'Win Rate', val: `${m.data.win_rate.toFixed(1)}%`, c: m.data.win_rate >= 60 ? 'text-emerald-400' : m.data.win_rate >= 50 ? 'text-amber-400' : 'text-rose-400', big: true },
                  { lbl: 'Trades',   val: String(m.data.trades),             c: 'text-slate-200', big: true },
                  { lbl: 'Wins',     val: String(m.data.wins),               c: 'text-emerald-400', big: false },
                  { lbl: 'Net PnL',  val: pct(m.data.net_pnl_pct),         c: m.data.net_pnl_pct >= 0 ? 'text-emerald-400' : 'text-rose-400', big: false },
                ].map(s => (
                  <div key={s.lbl} className="bg-dark-800/60 rounded p-2">
                    <div className="text-[9px] text-slate-500 uppercase mb-0.5">{s.lbl}</div>
                    <div className={`font-mono font-bold ${s.big ? 'text-xl' : 'text-base'} ${s.c}`}>{s.val}</div>
                  </div>
                ))}
              </div>
              <div className="h-1.5 rounded-full bg-slate-700/60 overflow-hidden">
                <div
                  className={`h-full rounded-full ${m.data.win_rate >= 60 ? 'bg-emerald-500' : m.data.win_rate >= 50 ? 'bg-amber-500' : 'bg-rose-500'}`}
                  style={{ width: `${Math.min(m.data.win_rate, 100)}%` }}
                />
              </div>
            </div>
          ))}
        </div>
      </div>

      {bt.yearly_breakdown.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold text-slate-400 uppercase mb-3">Year-by-Year</h3>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-700/40 text-[11px] text-slate-500 uppercase">
                  <th className="py-2 text-left">Year</th>
                  <th className="py-2 text-right">Trades</th>
                  <th className="py-2 text-right">Win Rate</th>
                  <th className="py-2 text-right">Net PnL</th>
                  <th className="py-2 text-right">Profit Factor</th>
                  <th className="py-2 pl-4 text-left">WR</th>
                </tr>
              </thead>
              <tbody>
                {bt.yearly_breakdown.map(y => (
                  <tr key={y.year} className="border-b border-slate-800/40 hover:bg-slate-800/20">
                    <td className="py-2 font-bold text-slate-200">{y.year}</td>
                    <td className="py-2 text-right font-mono text-slate-400">{y.trades}</td>
                    <td className={`py-2 text-right font-mono font-bold ${y.win_rate >= 60 ? 'text-emerald-400' : y.win_rate >= 50 ? 'text-amber-400' : 'text-rose-400'}`}>
                      {y.win_rate.toFixed(1)}%
                    </td>
                    <td className={`py-2 text-right font-mono ${y.net_pnl_pct >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>{pct(y.net_pnl_pct)}</td>
                    <td className="py-2 text-right font-mono text-sky-400">{y.profit_factor.toFixed(2)}</td>
                    <td className="py-2 pl-4">
                      <div className="h-1.5 w-20 rounded-full bg-slate-700/60 overflow-hidden">
                        <div className={`h-full rounded-full ${y.win_rate >= 60 ? 'bg-emerald-500' : 'bg-amber-500'}`} style={{ width: `${y.win_rate}%` }} />
                      </div>
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

// ─── How to Trade Guide ───────────────────────────────────────────────────────

function HowToTradePanel() {
  const steps = [
    {
      num: '01', time: 'Pre-Market (8:45–9:15 AM)',
      title: 'Calculate & Classify the CPR',
      color: 'border-slate-600/40 bg-slate-800/20',
      items: [
        { label: 'Calculate levels', detail: "Use yesterday's High, Low, Close → Pivot = (H+L+C)/3, R1 = 2P−L, S1 = 2P−H, TC = (P+R1)/2, BC = (P+S1)/2" },
        { label: 'Measure CPR Width', detail: 'Width = (TC−BC)/P × 100. Width < 0.3% → Trending day. Width > 0.5% → Range day. In-between → Moderate.' },
        { label: 'Check for Virgin CPR', detail: "Did yesterday's price ever touch today's CPR zone? If NO → Virgin CPR (strong magnet). Mark it before market opens." },
        { label: 'Note weekly/monthly CPR', detail: "If today's Daily CPR is near the Weekly or Monthly CPR zone, that's a confluence level — treat it as 2× strength support/resistance." },
      ],
    },
    {
      num: '02', time: '9:15–9:30 AM (Opening)',
      title: 'Read the Opening & Set Bias',
      color: 'border-amber-500/20 bg-amber-500/5',
      items: [
        { label: 'Gap up above TC', detail: 'Strong bull day. Bias = LONG only. Buy the first pullback to TC — this is your entry. Stop below BC. Target R1, R2.' },
        { label: 'Gap down below BC', detail: 'Strong bear day. Bias = SHORT only. Sell the first rally back to BC — this is your entry. Stop above TC. Target S1, S2.' },
        { label: 'Opens inside CPR', detail: 'Choppy open. WAIT. Watch which side of TC/BC price closes in the first 15-min candle. Trade the breakout of whichever side prints first with volume.' },
        { label: 'Opens at Pivot', detail: 'Indecision. Wait for first 30-min bar to close. If above TC → go long. If below BC → go short. Stay flat if still inside CPR.' },
      ],
    },
    {
      num: '03', time: '9:30–11:00 AM',
      title: 'Entry Setups by Mode',
      color: 'border-purple-500/20 bg-purple-500/5',
      items: [
        { label: '⚡ Narrow CPR Breakout', detail: 'Width < 0.3%. Wait for clean break + close above TC (BUY) or below BC (SELL). Volume must be ≥ 1.2× 20-day average. Enter at close of breakout candle. SL = opposite CPR boundary. T1 = R1 (long) / S1 (short). T2 = R2 / S2.' },
        { label: '↩ CPR Bounce', detail: 'Price was above CPR for 3+ bars, now pulls back to touch TC. If the pullback bar closes green (hammer/doji) near TC → BUY. RSI 40–65. SL = below BC. T1 = R1. Same logic inverted for shorts at BC.' },
        { label: '↔ Wide CPR Range', detail: 'Width > 0.5%. Sell at TC/R1 zone when RSI > 55. Buy at BC/S1 zone when RSI < 45. Target the Pivot (middle). Keep size small — range days can flip on news.' },
        { label: '🔮 Virgin CPR', detail: 'Price approaching an untested CPR zone (any timeframe). Reduce size on first test — expect a spike and reverse. After the first reaction, the zone becomes "tested" and normal rules apply.' },
      ],
    },
    {
      num: '04', time: '11:00 AM–1:30 PM',
      title: 'Managing the Trade',
      color: 'border-sky-500/20 bg-sky-500/5',
      items: [
        { label: 'Trail stop to entry', detail: 'Once T1 is hit, move stop to breakeven. Let T2 run. Never let a winner turn into a loser on CPR setups.' },
        { label: 'Re-entry on pullback', detail: "If you missed the initial breakout and price pulls back to TC (in an uptrend) and bounces → second entry. This is the 'CPR Bounce' mode. Same target/stop rules apply." },
        { label: 'Avoid choppy CPR zone', detail: 'If price keeps oscillating between TC and BC for more than 3 bars after entry signal → it is a range day disguised as trend. Exit and wait for a clear break.' },
        { label: 'Watch for Pivot rejection', detail: 'In range trades, price often stalls at the Pivot (midpoint). On a wide CPR day, partial exit at Pivot is sensible before targeting the opposite boundary.' },
      ],
    },
    {
      num: '05', time: '1:30–3:30 PM',
      title: 'End-of-Day Rules',
      color: 'border-emerald-500/20 bg-emerald-500/5',
      items: [
        { label: 'No new entries after 1:30 PM', detail: 'New breakout setups initiated after 1:30 PM carry overnight risk and reduced follow-through. Square off or trail stops only.' },
        { label: 'Note closing price vs CPR', detail: "Where Nifty closes relative to today's CPR tells you tomorrow's bias. Close > TC → tomorrow opens bullish. Close < BC → tomorrow opens bearish. Close inside CPR → tomorrow is uncertain." },
        { label: 'Virgin CPR carry-forward', detail: "If today's CPR was never tested (Virgin remains), it carries over as a high-priority level for tomorrow. Mark it on your chart before the next session." },
        { label: 'Weekly/Monthly CPR on expiry days', detail: 'On Thursday (weekly expiry), price gravitates toward max pain AND monthly CPR Pivot. If they align within 50 pts, that strike is the strongest magnet of the week.' },
      ],
    },
  ]

  return (
    <div className="space-y-4">
      {steps.map(s => (
        <div key={s.num} className={`rounded-xl border ${s.color} p-5`}>
          <div className="flex items-center gap-3 mb-4">
            <span className="text-2xl font-black text-slate-600 font-mono leading-none">{s.num}</span>
            <div>
              <div className="text-base font-bold text-white">{s.title}</div>
              <div className="text-xs text-slate-500">{s.time}</div>
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {s.items.map(item => (
              <div key={item.label} className="bg-dark-900/70 rounded-lg p-3">
                <div className="text-xs font-semibold text-slate-200 mb-1">{item.label}</div>
                <div className="text-xs text-slate-400 leading-relaxed">{item.detail}</div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

// ─── Virgin CPR Deep-Dive ─────────────────────────────────────────────────────

function VirginCPRPanel() {
  const scenarios = [
    {
      title: 'Daily Virgin CPR — Bullish Setup',
      icon: '🟢',
      condition: "Yesterday's CPR zone (TC/BC) was NEVER tested by price. Today opens or trades above the CPR zone.",
      entry: 'When price first dips to touch TC from above — buy the first bounce candle (hammer/engulfing). Alternatively wait for a 15-min close back above TC after the first touch.',
      stop: 'Below BC — if price falls through the entire CPR zone, the virgin setup has failed.',
      target: 'T1 = R1, T2 = R2. On a virgin + narrow CPR day, R2 is easily achievable.',
      note: 'Virgin CPR bounces have ~68% WR because the zone has pent-up supply/demand. First touch = strongest reaction.',
    },
    {
      title: 'Daily Virgin CPR — Bearish Setup',
      icon: '🔴',
      condition: "Yesterday's CPR zone was NEVER tested. Today opens or trades below the CPR zone.",
      entry: 'When price first rallies to touch BC from below — sell the first rejection candle (shooting star/bearish engulfing) at BC.',
      stop: 'Above TC — if price breaks back above TC, the virgin bearish setup is invalidated.',
      target: 'T1 = S1, T2 = S2.',
      note: 'Do not short into a virgin CPR on gap-down opens with strong institutional buying — false signals are more common on news days.',
    },
    {
      title: 'Weekly Virgin CPR',
      icon: '📅',
      condition: "Last week's price never tested the weekly CPR zone. This week's price is approaching it.",
      entry: 'Trade is valid for the first 2 days of the new week only. If the CPR zone is tested by Wednesday without a clear reaction, the virgin quality is diminished.',
      stop: 'Place stop 0.3% beyond the opposite boundary (TC or BC) of the weekly CPR.',
      target: 'Weekly R1/S1 levels.',
      note: 'Weekly virgin CPR setups that align with the Daily CPR zone (within 50 pts) are the highest-conviction setups — two untested magnets at the same price = institutional interest.',
    },
    {
      title: 'Monthly Virgin CPR',
      icon: '🗓️',
      condition: "Last month's H/L/C generated a CPR zone that was never traded through during that month.",
      entry: 'Use only as a filter for daily trades — if price is near monthly CPR TC from above, bias is bullish and CPR Bounce longs have extra validity.',
      stop: 'Monthly CPR is used as a bias filter, not as a trade entry level by itself. Keep daily trade stops.',
      target: 'Monthly R1/R2 — but use daily exits to protect profits.',
      note: 'Monthly virgin CPRs near round numbers (e.g. 24000, 25000) coinciding with max pain strikes are the strongest institutional magnets of all.',
    },
  ]

  const faqs = [
    { q: 'How long does Virgin CPR stay active?', a: "A Virgin CPR stays active until price actually enters the TC/BC zone. Once the zone is traded through on ANY timeframe bar (high ≥ BC and low ≤ TC simultaneously), it's no longer virgin. Check at the close of each candle." },
    { q: 'What if price gaps straight through the Virgin CPR?', a: "Gap-through is still a 'test'. The virgin quality is lost. However, the CPR now acts as a tested support/resistance in the normal way. If price gaps above a virgin CPR zone, that zone becomes future support on any pullback." },
    { q: 'Can I trade a Virgin CPR in the middle of the day?', a: "Yes, but with reduced size. The strongest virgin CPR reactions happen at market open (9:15–9:45 AM). Mid-session touches (11 AM–1 PM) still work but expect slower, less clean bounces." },
    { q: 'How do I mark a Virgin CPR on TradingView?', a: "Draw a horizontal box from TC to BC price levels. Color it differently from your regular CPR (e.g. magenta/fuchsia). Once price tests the zone, delete the box. The virgin indicator above updates automatically using the last 5 days' data." },
    { q: 'What is a Virgin CPR stack?', a: "When Daily + Weekly CPR zones overlap (within 50 pts) AND both are virgin — this is a 'CPR Stack'. Price has a very high probability (historically 75%+) of reversing sharply at a stack. Trade with 1.5× normal size, tight stops." },
  ]

  return (
    <div className="space-y-6">
      {/* What is Virgin CPR */}
      <div className="bg-dark-900 rounded-xl border border-fuchsia-500/30 p-5">
        <div className="flex items-center gap-3 mb-3">
          <span className="text-2xl">🔮</span>
          <h3 className="text-base font-bold text-white">What is Virgin CPR?</h3>
        </div>
        <p className="text-sm text-slate-400 leading-relaxed mb-3">
          A <strong className="text-fuchsia-300">Virgin CPR</strong> is a CPR zone (between BC and TC) that was
          computed from a prior period (day/week/month) but was <em>never touched or traded through</em> during
          that period. It represents an <strong className="text-slate-200">untested price zone</strong> with pent-up
          institutional orders sitting inside it — both pending buys (limit orders from bulls who missed the move)
          and pending sells (trapped longs trying to exit).
        </p>
        <p className="text-sm text-slate-400 leading-relaxed mb-3">
          Because both sides have unfilled interest at a virgin zone, the <em>first time</em> price approaches it,
          the reaction is typically sharp and decisive. Scalpers use this as one of the highest-probability
          single-level setups in the CPR playbook.
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mt-4">
          {[
            { label: 'Typical bounce %', val: '0.4–0.8%', color: 'text-emerald-400' },
            { label: 'First-touch WR', val: '~68%', color: 'text-amber-400' },
            { label: 'Fails when', val: 'News / gap-through', color: 'text-rose-400' },
          ].map(s => (
            <div key={s.label} className="bg-dark-800/60 rounded-lg p-3 text-center">
              <div className="text-[10px] text-slate-500 uppercase mb-1">{s.label}</div>
              <div className={`font-bold text-sm ${s.color}`}>{s.val}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Scenarios */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {scenarios.map(s => (
          <div key={s.title} className="bg-dark-900 rounded-xl border border-fuchsia-500/20 p-4">
            <div className="flex items-center gap-2 mb-3">
              <span className="text-lg">{s.icon}</span>
              <h4 className="text-sm font-bold text-slate-200">{s.title}</h4>
            </div>
            <div className="space-y-2.5 text-xs">
              <div>
                <span className="text-slate-500 font-semibold uppercase text-[10px]">Condition</span>
                <p className="text-slate-400 mt-0.5">{s.condition}</p>
              </div>
              <div>
                <span className="text-emerald-500 font-semibold uppercase text-[10px]">Entry</span>
                <p className="text-slate-400 mt-0.5">{s.entry}</p>
              </div>
              <div>
                <span className="text-rose-500 font-semibold uppercase text-[10px]">Stop Loss</span>
                <p className="text-slate-400 mt-0.5">{s.stop}</p>
              </div>
              <div>
                <span className="text-amber-500 font-semibold uppercase text-[10px]">Target</span>
                <p className="text-slate-400 mt-0.5">{s.target}</p>
              </div>
              <div className="px-2 py-1.5 rounded bg-fuchsia-500/10 border border-fuchsia-500/20 text-fuchsia-300">
                💡 {s.note}
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Around all CPR levels — Virgin across R1/R2/S1/S2 */}
      <div className="bg-dark-900 rounded-xl border border-slate-700/40 p-5">
        <h3 className="text-sm font-bold text-white mb-4">Virgin CPR Around All Levels — Where to Take Trades</h3>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-slate-700/40 text-[10px] text-slate-500 uppercase">
                <th className="py-2 text-left">Level</th>
                <th className="py-2 text-left">What it is</th>
                <th className="py-2 text-left">Buy Setup (Virgin)</th>
                <th className="py-2 text-left">Sell Setup (Virgin)</th>
                <th className="py-2 text-left">Stop</th>
              </tr>
            </thead>
            <tbody className="text-slate-400">
              {[
                {
                  level: 'TC (CPR Top)', lc: 'text-orange-300',
                  what: 'Upper boundary of CPR zone. Acts as resistance from above, support from below.',
                  buy: 'Bounce long when price is above TC in uptrend and pulls back to touch TC (CPR Bounce mode)',
                  sell: 'Short when price is below TC and rallies back into TC with rejection candle',
                  stop: 'BC (for longs) / above TC+ATR (for shorts)',
                },
                {
                  level: 'BC (CPR Bottom)', lc: 'text-sky-300',
                  what: 'Lower boundary of CPR zone. Acts as support from above, resistance from below.',
                  buy: 'Bounce long when price is above BC and touches it from above with oversold RSI',
                  sell: 'Short when price breaks below BC and rallies back to BC as resistance (Virgin BC rejection)',
                  stop: 'TC (for longs) / below BC-ATR (for shorts)',
                },
                {
                  level: 'Pivot (P)', lc: 'text-slate-200',
                  what: 'Mid-point of the day. Price crossing Pivot changes intraday bias.',
                  buy: 'Buy dip to Pivot in strong uptrend (when price is above R1). Pivot = pullback target.',
                  sell: 'Sell rally to Pivot in strong downtrend (when price is below S1). Pivot = dead-cat target.',
                  stop: 'CPR Zone (BC for longs, TC for shorts)',
                },
                {
                  level: 'R1', lc: 'text-rose-300',
                  what: 'First resistance above Pivot. Acts as target for CPR breakout longs.',
                  buy: 'Virgin R1 — price never reached R1. Buy breakout above R1 with volume (continuation). SL = Pivot.',
                  sell: 'Sell rejection at R1 when RSI > 70. Fade the first touch of virgin R1.',
                  stop: 'Pivot (for shorts) / R1-ATR (for longs)',
                },
                {
                  level: 'R2', lc: 'text-rose-400',
                  what: 'Extended resistance. Only reached on strong trending days (narrow CPR).',
                  buy: 'Very rare — buy breakout above R2 only on extremely narrow CPR + gap-up days. Trail stop at R1.',
                  sell: 'Strong fade at R2 — most powerful intraday sell point. RSI usually 75+. First touch of virgin R2 = high-WR short.',
                  stop: 'R1+10 pts (for shorts from R2)',
                },
                {
                  level: 'S1', lc: 'text-emerald-300',
                  what: 'First support below Pivot. Acts as target for CPR breakdown shorts.',
                  buy: 'Virgin S1 — fade the first test of S1. Buy hammer/doji at S1 when RSI < 35.',
                  sell: 'Breakdown below S1 with volume → short continuation. SL = Pivot.',
                  stop: 'Pivot (for longs from S1) / S1-ATR (for breakdown shorts)',
                },
                {
                  level: 'S2', lc: 'text-emerald-400',
                  what: 'Extended support. Only reached on strong bear days (narrow CPR).',
                  buy: 'Strongest intraday buy zone. RSI usually < 25. Virgin S2 first touch = high-WR long. Partial exit at S1, full at Pivot.',
                  sell: 'Very rare — only short below S2 on black swan / circuit-breaker days.',
                  stop: 'S1 (for longs from S2)',
                },
              ].map(row => (
                <tr key={row.level} className="border-b border-slate-800/30 hover:bg-slate-800/10">
                  <td className={`py-2 pr-2 font-mono font-bold ${row.lc} whitespace-nowrap`}>{row.level}</td>
                  <td className="py-2 pr-3 text-slate-500 max-w-[140px]">{row.what}</td>
                  <td className="py-2 pr-3 text-emerald-400/80 max-w-[180px]">{row.buy}</td>
                  <td className="py-2 pr-3 text-rose-400/80 max-w-[180px]">{row.sell}</td>
                  <td className="py-2 text-slate-500 max-w-[120px]">{row.stop}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* FAQ */}
      <div className="bg-dark-900 rounded-xl border border-slate-700/40 p-5">
        <h3 className="text-sm font-semibold text-slate-400 uppercase mb-4">Virgin CPR — Common Questions</h3>
        <div className="space-y-4">
          {faqs.map(f => (
            <div key={f.q}>
              <div className="text-xs font-semibold text-slate-200 mb-1">Q: {f.q}</div>
              <div className="text-xs text-slate-400 leading-relaxed pl-3 border-l border-slate-700">A: {f.a}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

// ─── Main Page ────────────────────────────────────────────────────────────────

type Tab = 'signal' | 'backtest' | 'howto' | 'virgin' | 'rules'

export default function CPRStrategy() {
  const [multi, setMulti] = useState<CPRMultiTimeframeSignal | null>(null)
  const [bt, setBt] = useState<CPRBacktestResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [btLoading, setBtLoading] = useState(false)
  const [tab, setTab] = useState<Tab>('signal')
  const [btYears, setBtYears] = useState(3)
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null)
  const [autoRefresh, setAutoRefresh] = useState(true)

  const fetchMulti = useCallback(() => {
    axios.get('/api/naren/v1/nifty/cpr-multi')
      .then(r => { setMulti(r.data); setLastUpdate(new Date()) })
      .catch(() => {})
  }, [])

  const fetchBt = useCallback((years: number) => {
    setBtLoading(true)
    axios.get(`/api/naren/v1/nifty/cpr-backtest?years=${years}`)
      .then(r => setBt(r.data.result))
      .catch(() => {})
      .finally(() => setBtLoading(false))
  }, [])

  useEffect(() => {
    setLoading(true)
    Promise.all([
      axios.get('/api/naren/v1/nifty/cpr-multi').then(r => r.data),
      axios.get(`/api/naren/v1/nifty/cpr-backtest?years=${btYears}`).then(r => r.data.result),
    ]).then(([m, b]) => {
      setMulti(m); setBt(b); setLastUpdate(new Date())
    }).catch(() => {}).finally(() => setLoading(false))
    // eslint-disable-next-line
  }, [])

  useEffect(() => {
    if (!autoRefresh) return
    const id = setInterval(fetchMulti, 60000)
    return () => clearInterval(id)
  }, [autoRefresh, fetchMulti])

  useEffect(() => {
    if (!loading) fetchBt(btYears)
    // eslint-disable-next-line
  }, [btYears])

  const overallBias = multi?.overall_bias ?? 'NEUTRAL'
  const virginCount = [multi?.daily, multi?.weekly, multi?.monthly].filter(c => c?.is_virgin_cpr).length

  // count virgin timeframes for badge
  void abs  // suppress unused warning

  return (
    <div className="min-h-screen bg-dark-950 text-slate-100 p-4 md:p-6">
      {/* ── Header ── */}
      <div className="mb-6 flex flex-wrap items-center gap-3">
        <div className="w-2 h-8 bg-amber-500 rounded-full" />
        <h1 className="text-2xl font-bold text-white">CPR Strategy</h1>
        <span className="px-2 py-0.5 rounded text-xs bg-amber-500/20 text-amber-300 border border-amber-500/30 font-mono font-bold">
          Central Pivot Range
        </span>
        {multi && (
          <span className={`px-3 py-1 rounded border text-sm font-bold ${BIAS_BG[overallBias]} ${BIAS_STYLE[overallBias]}`}>
            Multi-TF: {overallBias === 'BULLISH' ? '▲' : overallBias === 'BEARISH' ? '▼' : '—'} {overallBias}
          </span>
        )}
        {virginCount > 0 && (
          <span className="px-2 py-1 rounded border bg-fuchsia-500/20 text-fuchsia-300 border-fuchsia-500/40 text-xs font-bold animate-pulse">
            🔮 {virginCount} Virgin CPR{virginCount > 1 ? 's' : ''} Active
          </span>
        )}
        <span className="text-xs text-slate-500 ml-auto flex items-center gap-2">
          {lastUpdate ? `${lastUpdate.toLocaleTimeString()}` : '—'}
          <button onClick={fetchMulti} className="px-2 py-1 text-xs bg-dark-800 rounded hover:bg-dark-700">↻</button>
          <label className="inline-flex items-center gap-1 cursor-pointer">
            <input type="checkbox" checked={autoRefresh} onChange={e => setAutoRefresh(e.target.checked)} className="accent-amber-500" />
            <span className="text-slate-400">Auto</span>
          </label>
        </span>
      </div>

      {loading ? <LoadingSpinner /> : (
        <>
          {/* ── Tabs ── */}
          <div className="flex gap-1 mb-6 bg-dark-900 rounded-lg p-1 w-fit flex-wrap">
            {([
              ['signal',   '📍 Multi-TF Signal'],
              ['backtest', '📊 Backtest & Win Rate'],
              ['howto',    '🎓 How to Trade'],
              ['virgin',   '🔮 Virgin CPR'],
              ['rules',    '📋 Quick Rules'],
            ] as [Tab, string][]).map(([t, label]) => (
              <button key={t} onClick={() => setTab(t)}
                className={`px-4 py-1.5 rounded text-sm font-medium transition-all ${
                  tab === t ? 'bg-amber-600 text-white' : 'text-slate-400 hover:text-slate-200'
                }`}>
                {label}
              </button>
            ))}
          </div>

          {/* ── SIGNAL TAB ── */}
          {tab === 'signal' && multi && (
            <div className="space-y-6">
              {/* Summary row */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                {[
                  { label: 'Spot Price',   val: fmt(multi.spot_price, 0), color: 'text-white' },
                  { label: 'Daily Bias',   val: multi.daily.bias,         color: BIAS_STYLE[multi.daily.bias] },
                  { label: 'Weekly Bias',  val: multi.weekly.bias,        color: BIAS_STYLE[multi.weekly.bias] },
                  { label: 'Monthly Bias', val: multi.monthly.bias,       color: BIAS_STYLE[multi.monthly.bias] },
                ].map(s => (
                  <div key={s.label} className="bg-dark-900 rounded-xl border border-slate-700/40 p-4 text-center">
                    <div className="text-[10px] text-slate-500 uppercase mb-1">{s.label}</div>
                    <div className={`text-xl font-black ${s.color}`}>{s.val}</div>
                  </div>
                ))}
              </div>

              {/* 3 Timeframe cards */}
              <div>
                <h2 className="text-xs font-semibold text-slate-500 uppercase mb-3">CPR Levels — All Timeframes</h2>
                <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
                  <TimeframeCard card={multi.daily}   accent="border-amber-500/30" />
                  <TimeframeCard card={multi.weekly}  accent="border-sky-500/30" />
                  <TimeframeCard card={multi.monthly} accent="border-purple-500/30" />
                </div>
              </div>

              {/* Live signal */}
              {multi.live_signal && (
                <div>
                  <h2 className="text-xs font-semibold text-slate-500 uppercase mb-3">Live Trade Setup</h2>
                  <LiveSignalPanel sig={multi.live_signal} />
                </div>
              )}

              {/* Quick reference table */}
              <div className="bg-dark-900 rounded-xl border border-slate-700/40 p-5 overflow-x-auto">
                <h3 className="text-xs font-semibold text-slate-500 uppercase mb-3">All Levels — Quick Reference</h3>
                <table className="w-full text-xs font-mono">
                  <thead>
                    <tr className="border-b border-slate-700/40 text-[10px] text-slate-500 uppercase">
                      <th className="py-2 text-left">Level</th>
                      <th className="py-2 text-right">Daily</th>
                      <th className="py-2 text-right">Weekly</th>
                      <th className="py-2 text-right">Monthly</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(
                      ['r2','r1','tc','pivot','bc','s1','s2'] as (keyof CPRLevels)[]
                    ).map(key => {
                      const labels: Record<string, string> = {
                        r2: 'R2 (Resistance 2)', r1: 'R1 (Resistance 1)',
                        tc: 'TC — CPR Top', pivot: 'Pivot (P)',
                        bc: 'BC — CPR Bottom', s1: 'S1 (Support 1)', s2: 'S2 (Support 2)',
                      }
                      const colors: Record<string, string> = {
                        r2: 'text-rose-400', r1: 'text-rose-300',
                        tc: 'text-orange-300 font-bold', pivot: 'text-slate-100 font-bold',
                        bc: 'text-sky-300 font-bold', s1: 'text-emerald-300', s2: 'text-emerald-400',
                      }
                      return (
                        <tr key={key} className="border-b border-slate-800/30 hover:bg-slate-800/10">
                          <td className={`py-1.5 pr-4 ${colors[key]}`}>{labels[key]}</td>
                          <td className={`py-1.5 text-right ${colors[key]}`}>{fmt(multi.daily.levels[key] as number, 0)}</td>
                          <td className={`py-1.5 text-right ${colors[key]}`}>{fmt(multi.weekly.levels[key] as number, 0)}</td>
                          <td className={`py-1.5 text-right ${colors[key]}`}>{fmt(multi.monthly.levels[key] as number, 0)}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* ── BACKTEST TAB ── */}
          {tab === 'backtest' && (
            <div className="space-y-6">
              <div className="flex items-center gap-3">
                <span className="text-sm text-slate-400">Period:</span>
                {[1, 2, 3, 5].map(y => (
                  <button key={y} onClick={() => setBtYears(y)}
                    className={`px-3 py-1 rounded text-sm font-medium transition-all ${
                      btYears === y ? 'bg-amber-600 text-white' : 'bg-dark-800 text-slate-400 hover:text-slate-200'
                    }`}>
                    {y}yr
                  </button>
                ))}
              </div>
              {btLoading ? <LoadingSpinner /> : bt
                ? <BacktestPanel bt={bt} />
                : <p className="text-slate-500 text-sm">No data. Try a different period.</p>
              }
            </div>
          )}

          {/* ── HOW TO TRADE TAB ── */}
          {tab === 'howto' && <HowToTradePanel />}

          {/* ── VIRGIN CPR TAB ── */}
          {tab === 'virgin' && <VirginCPRPanel />}

          {/* ── QUICK RULES TAB ── */}
          {tab === 'rules' && (
            <div className="space-y-5">
              {/* CPR Width cheat-sheet */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                {[
                  { type: 'NARROW CPR', cond: 'Width < 0.3%', predict: 'Strong trend day', dos: ['Trade breakout above TC (BUY) or below BC (SELL)', 'Volume must be ≥ 1.2× average', 'Target R2/S2, stop at opposite boundary', 'Enter at breakout candle close, not on open'], bg: 'border-purple-500/30 bg-purple-500/5' },
                  { type: 'MODERATE CPR', cond: 'Width 0.3–0.5%', predict: 'Mixed / wait for clarity', dos: ['Wait for 9:30–9:45 AM confirmation candle', 'Trade CPR Bounce only (not breakout)', 'Smaller size, tighter stops', 'Follow the 1st 15-min candle direction'], bg: 'border-slate-600/30 bg-slate-800/20' },
                  { type: 'WIDE CPR', cond: 'Width > 0.5%', predict: 'Range / mean-reversion day', dos: ['Buy at BC/S1, target Pivot. Sell at TC/R1, target Pivot', 'RSI must confirm (< 45 for buy, > 55 for sell)', 'Exit at Pivot — do not hold for full target', 'AVOID on budget/RBI policy/event days'], bg: 'border-amber-500/30 bg-amber-500/5' },
                ].map(s => (
                  <div key={s.type} className={`rounded-xl border ${s.bg} p-4`}>
                    <div className="text-sm font-bold text-slate-200 mb-0.5">{s.type}</div>
                    <div className="text-[11px] text-slate-500 mb-1">{s.cond}</div>
                    <div className="text-xs text-slate-400 mb-3 font-medium">{s.predict}</div>
                    <ul className="space-y-1">
                      {s.dos.map((d, i) => <li key={i} className="flex gap-1.5 text-xs text-slate-400"><span className="text-amber-500">›</span>{d}</li>)}
                    </ul>
                  </div>
                ))}
              </div>

              {/* Golden rules */}
              <div className="bg-dark-900 rounded-xl border border-amber-500/20 p-5">
                <h3 className="text-sm font-bold text-amber-400 mb-4">⚡ Golden Rules of CPR Trading</h3>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {[
                    { rule: 'Never fight the first 15-min candle', detail: 'The 15-min opening candle direction tells you the session bias. A bullish first candle + price above TC = longs only all day.' },
                    { rule: 'CPR is a zone, not a line', detail: 'TC and BC are boundaries. Price spending time between them is choppy. Entries are only at the outer edges — at TC from above or BC from below.' },
                    { rule: 'Volume confirms CPR breaks', detail: 'A breakout above TC on low volume is a trap. Always check volume ≥ 1.2× 20-day avg before entering a Narrow CPR breakout trade.' },
                    { rule: 'Stop goes at the ZONE, not the line', detail: 'For a long above TC, the stop is below BC (the full zone), not just below TC. A valid breakout should not re-enter the zone.' },
                    { rule: "Virgin CPR first touch = best price", detail: 'The first time price enters a virgin CPR zone, expect a sharp reversal. Size up on first-touch, reduce size on subsequent tests.' },
                    { rule: 'Multi-TF alignment doubles win rate', detail: 'When Daily CPR and Weekly CPR both show bullish bias (price above both CPR zones), your long trades have 2× the conviction. Trade full size only on alignment.' },
                    { rule: 'Wide CPR days — exit at Pivot', detail: 'On range days, the Pivot is a natural midpoint magnet. Greed at R1/S1 on wide CPR days often turns winners into losers. Take the Pivot exit.' },
                    { rule: 'Never hold CPR trades overnight', detail: 'CPR levels reset daily. A position that was valid against today\'s CPR becomes undefined risk against tomorrow\'s new levels. Day-trade only.' },
                  ].map(g => (
                    <div key={g.rule} className="bg-dark-800/50 rounded-lg p-3">
                      <div className="text-xs font-semibold text-slate-200 mb-1">• {g.rule}</div>
                      <div className="text-xs text-slate-400">{g.detail}</div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Common mistakes */}
              <div className="bg-dark-900 rounded-xl border border-rose-500/20 p-5">
                <h3 className="text-sm font-bold text-rose-400 mb-4">🚫 Common Mistakes to Avoid</h3>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {[
                    'Trading inside the CPR zone — this is the "noise zone", not the setup zone',
                    'Entering Narrow CPR breakout without volume confirmation (trap breakouts)',
                    'Using daily CPR rules on a weekly CPR chart (timeframe mismatch)',
                    'Moving stop to breakeven too early on wide CPR range trades before Pivot is reached',
                    'Assuming Virgin CPR means automatic reversal — news can blast straight through any level',
                    'Taking new entries after 1:30 PM IST on CPR breakout setups',
                    'Trading Wide CPR range when VIX > 20 (high-volatility days invalidate range assumptions)',
                    'Ignoring Weekly/Monthly CPR when Daily CPR is near them — highest confluence levels get ignored',
                  ].map((m, i) => (
                    <div key={i} className="flex gap-2 text-xs text-slate-400">
                      <span className="text-rose-500 shrink-0 mt-0.5">✗</span>
                      {m}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}
