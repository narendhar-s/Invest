import { useState, useRef, useEffect } from 'react'
import { Link, useLocation } from 'react-router-dom'

// ─── Nav structure ────────────────────────────────────────────────────────────

interface NavItem { to: string; label: string; desc?: string }
interface NavGroup { label: string; icon: string; items: NavItem[] }

const GROUPS: NavGroup[] = [
  {
    label: 'Kite', icon: '🪁',
    items: [
      { to: '/live',             label: '⚡ Live Terminal',   desc: '3-gate signals on chart · WebSocket prices · live P&L' },
      { to: '/kite-terminal',    label: 'Kite Terminal',    desc: 'Live signals · Paper trade · Backtest' },
      { to: '/challenge',        label: '🏆 90-Day Challenge', desc: 'PCR-filtered signals · real LTP · all trades in DB' },
      { to: '/scalp-challenge',  label: '⚡ 90-Day Scalp',     desc: 'EMA50/200 + Stochastic · 1-min · ATM CE/PE' },
      { to: '/smc-challenge',    label: '🎯 90-Day SMC',       desc: 'SMC + FVG + VWAP · 5-min / 15-min HTF · ATM CE/PE' },
      { to: '/strategy-compare', label: '📚 Book Strategies', desc: '7 famous book strategies · ranked backtest' },
      { to: '/kite-terminal?tab=signals',  label: '↳ Live Signals',    desc: 'Nifty 15m · regime · strategy' },
      { to: '/kite-terminal?tab=paper',    label: '↳ Paper Trade',     desc: 'Auto/manual · RR 1:2 · P&L' },
      { to: '/kite-terminal?tab=backtest', label: '↳ Backtest',        desc: 'BS-priced · 180-day history' },
    ],
  },
  {
    label: 'NIFTY', icon: '⚡',
    items: [
      { to: '/one-lot',       label: '1-Lot Strategy',   desc: 'Live signals · 5-gate entry' },
      { to: '/nifty-options', label: 'Options Setup',     desc: 'Power setup · 5-factor' },
      { to: '/nifty-smc',     label: 'SMC 87% WR',        desc: 'Smart Money Concepts' },
      { to: '/cpr',           label: 'CPR Strategy',      desc: 'Central Pivot Range' },
      { to: '/ict-smc',       label: 'ICT + SMC',         desc: 'Combined confluence' },
      { to: '/huddleston',    label: '🎯 ICT Huddleston',  desc: '7-pillar PD array model' },
      { to: '/expiry-day',    label: '🔥 Expiry Day',      desc: 'Live Iron Fly · ORB · Max Pain' },
      { to: '/smc-fvg-vwap',  label: '🔬 SMC+FVG+VWAP',  desc: '3-year options backtest' },
      { to: '/nifty-scalping',label: 'Nifty Scalp',        desc: '5-min momentum' },
      { to: '/strategy-lab',  label: '🧪 Strategy Lab',    desc: '5-strategy AI backtest' },
      { to: '/scalping-lab',  label: '📊 Scalping Lab',    desc: '10 book strategies · 5-min' },
    ],
  },
  {
    label: 'Analysis', icon: '🔍',
    items: [
      { to: '/trade-planner',   label: 'Trade Planner',   desc: 'Entry · SL · Targets calc' },
      { to: '/trade-analysis',  label: 'Trade Analysis',  desc: 'Analyse your tradebook' },
      { to: '/pnl-analysis',    label: '📈 P&L Analyser',  desc: 'Upload Zerodha xlsx · deep insights' },
      { to: '/trading-edge',    label: 'Trading Edge',    desc: 'WR improvement guide' },
      { to: '/india',           label: 'Scalp Terminal',  desc: '6 strategy dashboard' },
    ],
  },
  {
    label: 'Long-Term', icon: '🌍',
    items: [
      { to: '/fundamental',  label: '🔎 Screener',    desc: 'Warren Buffett analysis' },
      { to: '/us',           label: 'US Market',     desc: 'US stocks analysis' },
      { to: '/minervini',    label: 'Minervini SEPA',desc: 'Momentum growth stocks' },
      { to: '/longterm-sip', label: '3-Yr SIP',      desc: 'US growth SIP picks' },
      { to: '/portfolio',    label: 'Portfolio',      desc: 'Holdings & P&L' },
    ],
  },
  {
    label: 'Tools', icon: '🛠️',
    items: [
      { to: '/',         label: 'Dashboard',   desc: 'Market overview' },
      { to: '/backtest', label: 'Backtest',    desc: 'Strategy backtesting' },
    ],
  },
]

// ─── Dropdown component ───────────────────────────────────────────────────────

function NavDropdown({ group, onClose }: { group: NavGroup; onClose: () => void }) {
  const { pathname } = useLocation()
  const isActive = group.items.some(i => (i.to === '/' ? pathname === '/' : pathname.startsWith(i.to)))

  return (
    <div className="min-w-[200px]">
      <div className="text-[10px] font-bold text-slate-600 uppercase tracking-widest px-3 py-2 border-b border-slate-800">
        {group.icon} {group.label}
      </div>
      <div className="py-1">
        {group.items.map(item => {
          const active = item.to === '/' ? pathname === '/' : pathname.startsWith(item.to)
          return (
            <Link
              key={item.to}
              to={item.to}
              onClick={onClose}
              className={`flex flex-col px-3 py-2.5 transition-colors ${
                active
                  ? 'bg-brand-600/15 text-brand-400'
                  : 'text-slate-300 hover:bg-slate-800/60 hover:text-white'
              }`}
            >
              <span className="text-sm font-medium">{item.label}</span>
              {item.desc && <span className="text-[11px] text-slate-500 mt-0.5">{item.desc}</span>}
            </Link>
          )
        })}
      </div>
      {/* suppress unused warning */}
      {isActive && <span className="hidden" />}
    </div>
  )
}

// ─── Main Navbar ──────────────────────────────────────────────────────────────

export default function Navbar() {
  const { pathname } = useLocation()
  const [open, setOpen] = useState<string | null>(null)
  const [mobileOpen, setMobileOpen] = useState(false)
  const navRef = useRef<HTMLDivElement>(null)

  // Close dropdown when clicking outside
  useEffect(() => {
    function handler(e: MouseEvent) {
      if (navRef.current && !navRef.current.contains(e.target as Node)) {
        setOpen(null)
        setMobileOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  // Close on route change
  useEffect(() => { setOpen(null); setMobileOpen(false) }, [pathname])

  function groupActive(group: NavGroup) {
    return group.items.some(i => (i.to === '/' ? pathname === '/' : pathname.startsWith(i.to)))
  }

  return (
    <nav
      ref={navRef}
      className="fixed top-0 left-0 right-0 z-50 bg-slate-950/95 border-b border-slate-800/70 backdrop-blur-md"
    >
      <div className="max-w-screen-2xl mx-auto px-4 h-14 flex items-center gap-4">

        {/* Logo */}
        <Link to="/" className="flex items-center gap-2 flex-shrink-0" onClick={() => setOpen(null)}>
          <div className="w-7 h-7 bg-brand-600 rounded-lg flex items-center justify-center text-white font-bold text-xs">
            SW
          </div>
          <span className="font-semibold text-white text-base tracking-tight hidden sm:block">StockWise</span>
        </Link>

        {/* Back to the main Invest app (separate sub-app, so full-page link) */}
        <a
          href="/"
          className="hidden sm:flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-medium text-slate-400 border border-slate-800 hover:text-brand-400 hover:border-brand-500/30 hover:bg-brand-500/8 transition-colors"
        >
          ← Invest
        </a>

        {/* Quick link: 1-lot (most used) */}
        <Link
          to="/one-lot"
          className={`hidden lg:flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium border transition-colors ${
            pathname.startsWith('/one-lot')
              ? 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30'
              : 'text-slate-400 border-slate-800 hover:text-emerald-400 hover:border-emerald-500/30 hover:bg-emerald-500/8'
          }`}
        >
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
          1-Lot Live
        </Link>

        {/* Desktop dropdown groups */}
        <div className="hidden md:flex items-center gap-1 flex-1">
          {GROUPS.map(group => {
            const isOpen = open === group.label
            const isActive = groupActive(group)
            return (
              <div key={group.label} className="relative">
                <button
                  onClick={() => setOpen(isOpen ? null : group.label)}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                    isActive
                      ? 'text-brand-400 bg-brand-600/10'
                      : isOpen
                        ? 'text-slate-200 bg-slate-800/60'
                        : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/40'
                  }`}
                >
                  <span className="text-base leading-none">{group.icon}</span>
                  {group.label}
                  <svg
                    className={`w-3 h-3 transition-transform ${isOpen ? 'rotate-180' : ''}`}
                    viewBox="0 0 12 12" fill="currentColor"
                  >
                    <path d="M2 4l4 4 4-4" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" />
                  </svg>
                </button>

                {/* Dropdown panel */}
                {isOpen && (
                  <div className="absolute top-full left-0 mt-1.5 bg-slate-900 border border-slate-800 rounded-xl shadow-2xl shadow-black/40 overflow-hidden min-w-[220px]">
                    <NavDropdown group={group} onClose={() => setOpen(null)} />
                  </div>
                )}
              </div>
            )
          })}
        </div>

        {/* Right side status */}
        <div className="ml-auto flex items-center gap-3">
          <div className="hidden sm:flex items-center gap-1.5 text-xs text-slate-500">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
            Live
          </div>

          {/* Mobile hamburger */}
          <button
            className="md:hidden p-2 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800"
            onClick={() => setMobileOpen(v => !v)}
          >
            <div className="w-5 space-y-1">
              <span className={`block h-0.5 bg-current transition-all ${mobileOpen ? 'rotate-45 translate-y-1.5' : ''}`} />
              <span className={`block h-0.5 bg-current transition-all ${mobileOpen ? 'opacity-0' : ''}`} />
              <span className={`block h-0.5 bg-current transition-all ${mobileOpen ? '-rotate-45 -translate-y-1.5' : ''}`} />
            </div>
          </button>
        </div>
      </div>

      {/* Mobile menu */}
      {mobileOpen && (
        <div className="md:hidden bg-slate-950 border-t border-slate-800 max-h-[80vh] overflow-y-auto">
          {GROUPS.map(group => (
            <div key={group.label} className="border-b border-slate-800/60 last:border-0">
              <div className="text-[11px] font-bold text-slate-600 uppercase tracking-widest px-4 py-2 mt-1">
                {group.icon} {group.label}
              </div>
              {group.items.map(item => {
                const active = item.to === '/' ? pathname === '/' : pathname.startsWith(item.to)
                return (
                  <Link
                    key={item.to}
                    to={item.to}
                    onClick={() => setMobileOpen(false)}
                    className={`flex items-center gap-3 px-4 py-3 transition-colors ${
                      active ? 'bg-brand-600/10 text-brand-400' : 'text-slate-300 hover:bg-slate-800/60'
                    }`}
                  >
                    <span className="text-sm font-medium">{item.label}</span>
                    {item.desc && <span className="text-xs text-slate-600 ml-auto">{item.desc}</span>}
                  </Link>
                )
              })}
            </div>
          ))}
        </div>
      )}
    </nav>
  )
}
