import { Link, useLocation } from 'react-router-dom'
import ZerodhaConnect from './ZerodhaConnect'

const links = [
  { to: '/', label: 'Watchlist' },
  { to: '/dashboard', label: 'Dashboard' },
  { to: '/india', label: 'India (NSE)' },
  { to: '/us', label: 'US Market' },
  { to: '/longterm-sip', label: '🇺🇸 3-Yr SIP' },
  { to: '/portfolio', label: 'Portfolio' },
  { to: '/backtest', label: '📊 Backtest' },
  { to: '/live', label: '⚡ Live' },
  { to: '/oi-pulse', label: '🫀 OI Pulse' },
]

// NarenInvestment feature set — served as a separate sub-app under /naren, so
// these are full-page links (<a>), not client-side <Link>s. The Naren sub-app
// has its own detailed navigation once you land there.
const narenLinks = [
  { href: '/naren/one-lot', label: '⚡ 1-Lot' },
  { href: '/naren/kite-terminal', label: '🪁 Kite' },
  { href: '/naren/challenge', label: '🏆 Challenge' },
  { href: '/naren/scalp-challenge', label: '⚡ Scalp' },
  { href: '/naren/fundamental', label: '🔎 Screener' },
  { href: '/naren/', label: '🚀 Naren Suite' },
]

export default function Navbar() {
  const { pathname } = useLocation()

  return (
    <nav className="fixed top-0 left-0 right-0 z-50 bg-dark-800 border-b border-slate-800/60 backdrop-blur-sm">
      <div className="max-w-screen-2xl mx-auto px-4 h-16 flex items-center justify-between">
        {/* Logo */}
        <Link to="/" className="flex items-center gap-2">
          <div className="w-8 h-8 bg-brand-600 rounded-lg flex items-center justify-center text-white font-bold text-sm">
            SW
          </div>
          <span className="font-semibold text-white text-lg tracking-tight">StockWise</span>
          <span className="text-xs text-slate-500 ml-1 hidden sm:block">AI Analysis Platform</span>
        </Link>

        {/* Navigation */}
        <div className="flex items-center gap-1">
          {links.map((link) => {
            const active = link.to === '/'
              ? pathname === '/'
              : pathname.startsWith(link.to)
            return (
              <Link
                key={link.to}
                to={link.to}
                className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                  active
                    ? 'bg-brand-600/20 text-brand-400 border border-brand-600/30'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
                }`}
              >
                {link.label}
              </Link>
            )
          })}

          {/* Divider before NarenInvestment tabs */}
          <span className="mx-1 h-6 w-px bg-slate-700/70" aria-hidden="true" />

          {/* NarenInvestment tabs (separate sub-app under /naren) */}
          {narenLinks.map((link) => {
            const active = typeof window !== 'undefined' && window.location.pathname.startsWith(link.href.replace(/\/$/, '')) && window.location.pathname.startsWith('/naren')
            return (
              <a
                key={link.href}
                href={link.href}
                className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                  active
                    ? 'bg-emerald-600/20 text-emerald-400 border border-emerald-600/30'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
                }`}
              >
                {link.label}
              </a>
            )
          })}
        </div>

        {/* Right side */}
        <div className="flex items-center gap-3">
          <ZerodhaConnect />
          <div className="flex items-center gap-2 text-xs text-slate-500">
            <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span>
            Live
          </div>
        </div>
      </div>
    </nav>
  )
}
