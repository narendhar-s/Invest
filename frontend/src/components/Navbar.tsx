import { useState, useEffect } from 'react'
import { Link, useLocation } from 'react-router-dom'
import ZerodhaConnect from './ZerodhaConnect'

const links = [
  { to: '/', label: 'Watchlist' },
  { to: '/dashboard', label: 'Dashboard' },
  { to: '/india', label: 'India (NSE)' },
  { to: '/us', label: 'US Market' },
  { to: '/longterm-sip', label: '🇺🇸 3-Yr SIP' },
  { to: '/portfolio', label: 'Portfolio' },
  { to: '/trade', label: '🛒 Trade' },
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
  const [open, setOpen] = useState(false)

  // Close the mobile menu whenever the route changes.
  useEffect(() => { setOpen(false) }, [pathname])

  const isActive = (to: string) => (to === '/' ? pathname === '/' : pathname.startsWith(to))
  const isNarenActive = (href: string) =>
    typeof window !== 'undefined' &&
    window.location.pathname.startsWith('/naren') &&
    window.location.pathname.startsWith(href.replace(/\/$/, ''))

  return (
    <nav className="fixed top-0 left-0 right-0 z-50 bg-dark-800 border-b border-slate-800/60 backdrop-blur-sm">
      <div className="max-w-screen-2xl mx-auto px-4 h-16 flex items-center justify-between gap-2">
        {/* Logo */}
        <Link to="/" className="flex items-center gap-2 shrink-0" onClick={() => setOpen(false)}>
          <div className="w-8 h-8 bg-brand-600 rounded-lg flex items-center justify-center text-white font-bold text-sm">
            SW
          </div>
          <span className="font-semibold text-white text-lg tracking-tight">StockWise</span>
          <span className="text-xs text-slate-500 ml-1 hidden xl:block">AI Analysis Platform</span>
        </Link>

        {/* Desktop navigation (lg and up) */}
        <div className="hidden lg:flex items-center gap-1 overflow-x-auto">
          {links.map((link) => (
            <Link
              key={link.to}
              to={link.to}
              className={`px-3 py-2 rounded-lg text-sm font-medium transition-colors whitespace-nowrap ${
                isActive(link.to)
                  ? 'bg-brand-600/20 text-brand-400 border border-brand-600/30'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
              }`}
            >
              {link.label}
            </Link>
          ))}

          <span className="mx-1 h-6 w-px bg-slate-700/70 shrink-0" aria-hidden="true" />

          {narenLinks.map((link) => (
            <a
              key={link.href}
              href={link.href}
              className={`px-3 py-2 rounded-lg text-sm font-medium transition-colors whitespace-nowrap ${
                isNarenActive(link.href)
                  ? 'bg-emerald-600/20 text-emerald-400 border border-emerald-600/30'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
              }`}
            >
              {link.label}
            </a>
          ))}
        </div>

        {/* Right side: Zerodha (hidden on small) + hamburger */}
        <div className="flex items-center gap-3 shrink-0">
          <div className="hidden lg:flex items-center gap-3">
            <ZerodhaConnect />
            <div className="flex items-center gap-2 text-xs text-slate-500">
              <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span>
              Live
            </div>
          </div>

          {/* Hamburger — visible below lg */}
          <button
            onClick={() => setOpen(o => !o)}
            aria-label="Toggle menu"
            aria-expanded={open}
            className="lg:hidden inline-flex items-center justify-center w-10 h-10 rounded-lg text-slate-300 hover:bg-slate-800/60"
          >
            {open ? (
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
            ) : (
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M3 12h18M3 6h18M3 18h18" /></svg>
            )}
          </button>
        </div>
      </div>

      {/* Mobile dropdown panel */}
      {open && (
        <div className="lg:hidden border-t border-slate-800/60 bg-dark-800 max-h-[calc(100vh-4rem)] overflow-y-auto">
          <div className="px-4 py-3">
            <div className="mb-3 flex items-center justify-between">
              <ZerodhaConnect />
              <div className="flex items-center gap-2 text-xs text-slate-500">
                <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span>
                Live
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2">
              {links.map((link) => (
                <Link
                  key={link.to}
                  to={link.to}
                  className={`px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                    isActive(link.to)
                      ? 'bg-brand-600/20 text-brand-400 border border-brand-600/30'
                      : 'text-slate-300 bg-dark-700/60 hover:bg-slate-800'
                  }`}
                >
                  {link.label}
                </Link>
              ))}
            </div>

            <p className="text-[11px] uppercase tracking-wide text-slate-600 mt-4 mb-2">Naren Suite</p>
            <div className="grid grid-cols-2 gap-2">
              {narenLinks.map((link) => (
                <a
                  key={link.href}
                  href={link.href}
                  className="px-3 py-2.5 rounded-lg text-sm font-medium text-slate-300 bg-dark-700/60 hover:bg-slate-800 transition-colors"
                >
                  {link.label}
                </a>
              ))}
            </div>
          </div>
        </div>
      )}
    </nav>
  )
}
