import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import Navbar from './components/Navbar'
import ErrorBoundary from './components/ErrorBoundary'
import Dashboard from './pages/Dashboard'
import IndianMarket from './pages/IndianMarket'
import USMarket from './pages/USMarket'
import StockDetail from './pages/StockDetail'
import Portfolio from './pages/Portfolio'
import BacktestDashboard from './pages/BacktestDashboard'
import LongTermSIP from './pages/LongTermSIP'
import Watchlist from './pages/Watchlist'
import LiveTrading from './pages/LiveTrading'
import OIPulse from './pages/OIPulse'

export default function App() {
  return (
    <BrowserRouter>
      <div className="min-h-screen bg-dark-900 text-slate-200">
        <Navbar />
        <main className="pt-16">
          <ErrorBoundary>
          <Routes>
            {/* Offline-friendly home until backend/DB is ready */}
            <Route path="/" element={<Watchlist />} />
            <Route path="/watchlist" element={<Watchlist />} />
            <Route path="/dashboard" element={<Dashboard />} />
            <Route path="/india" element={<IndianMarket />} />
            <Route path="/us" element={<USMarket />} />
            <Route path="/portfolio" element={<Portfolio />} />
            <Route path="/stock/:symbol" element={<StockDetail />} />
            <Route path="/backtest" element={<BacktestDashboard />} />
            <Route path="/longterm-sip" element={<LongTermSIP />} />
            <Route path="/live" element={<LiveTrading />} />
            <Route path="/oi-pulse" element={<OIPulse />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
          </ErrorBoundary>
        </main>
      </div>
    </BrowserRouter>
  )
}
