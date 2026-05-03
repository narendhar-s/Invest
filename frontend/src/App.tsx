import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import Navbar from './components/Navbar'
import Dashboard from './pages/Dashboard'
import IndianMarket from './pages/IndianMarket'
import USMarket from './pages/USMarket'
import StockDetail from './pages/StockDetail'
import Portfolio from './pages/Portfolio'

export default function App() {
  return (
    <BrowserRouter>
      <div className="min-h-screen bg-dark-900 text-slate-200">
        <Navbar />
        <main className="pt-16">
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/india" element={<IndianMarket />} />
            <Route path="/us" element={<USMarket />} />
            <Route path="/portfolio" element={<Portfolio />} />
            <Route path="/stock/:symbol" element={<StockDetail />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </main>
      </div>
    </BrowserRouter>
  )
}
