import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import Navbar from './components/Navbar'
import Dashboard from './pages/Dashboard'
import ScalpingTerminal from './pages/ScalpingTerminal'
import USMarket from './pages/USMarket'
import StockDetail from './pages/StockDetail'
import Portfolio from './pages/Portfolio'
import BacktestDashboard from './pages/BacktestDashboard'
import LongTermSIP from './pages/LongTermSIP'
import NiftyScalping from './pages/NiftyScalping'
import NiftyOptions from './pages/NiftyOptions'
import NiftySMC from './pages/NiftySMC'
import Minervini from './pages/Minervini'
import CPRStrategy from './pages/CPRStrategy'
import ICTSMCStrategy from './pages/ICTSMCStrategy'
import TradeAnalysis from './pages/TradeAnalysis'
import TradingEdge from './pages/TradingEdge'
import TradePlanner from './pages/TradePlanner'
import OneLotStrategy from './pages/OneLotStrategy'
import StrategyLab from './pages/StrategyLab'
import ScalpingLab from './pages/ScalpingLab'
import FundamentalDashboard from './pages/FundamentalDashboard'
import HuddlestonStrategy from './pages/HuddlestonStrategy'
import SMCFVGVWAPBacktest from './pages/SMCFVGVWAPBacktest'
import ExpiryDay from './pages/ExpiryDay'
import PnlAnalysis from './pages/PnlAnalysis'
import KiteTerminal from './pages/KiteTerminal'
import ChallengeDashboard from './pages/ChallengeDashboard'
import ScalpChallengeDashboard from './pages/ScalpChallengeDashboard'
import LiveTerminal from './pages/LiveTerminal'
import StrategyCompare from './pages/StrategyCompare'

export default function App() {
  return (
    <BrowserRouter basename="/naren">
      <div className="min-h-screen bg-dark-900 text-slate-200">
        <Navbar />
        <main className="pt-14">
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/india" element={<ScalpingTerminal />} />
            <Route path="/us" element={<USMarket />} />
            <Route path="/portfolio" element={<Portfolio />} />
            <Route path="/stock/:symbol" element={<StockDetail />} />
            <Route path="/backtest" element={<BacktestDashboard />} />
            <Route path="/longterm-sip" element={<LongTermSIP />} />
            <Route path="/nifty-scalping" element={<NiftyScalping />} />
            <Route path="/nifty-options" element={<NiftyOptions />} />
            <Route path="/nifty-smc" element={<NiftySMC />} />
            <Route path="/minervini" element={<Minervini />} />
            <Route path="/cpr" element={<CPRStrategy />} />
            <Route path="/ict-smc" element={<ICTSMCStrategy />} />
            <Route path="/trade-analysis" element={<TradeAnalysis />} />
            <Route path="/trading-edge" element={<TradingEdge />} />
            <Route path="/trade-planner" element={<TradePlanner />} />
            <Route path="/one-lot" element={<OneLotStrategy />} />
            <Route path="/strategy-lab" element={<StrategyLab />} />
            <Route path="/scalping-lab" element={<ScalpingLab />} />
            <Route path="/fundamental" element={<FundamentalDashboard />} />
            <Route path="/huddleston" element={<HuddlestonStrategy />} />
            <Route path="/smc-fvg-vwap" element={<SMCFVGVWAPBacktest />} />
            <Route path="/expiry-day" element={<ExpiryDay />} />
            <Route path="/pnl-analysis" element={<PnlAnalysis />} />
            <Route path="/kite-terminal" element={<KiteTerminal />} />
            <Route path="/challenge" element={<ChallengeDashboard />} />
            <Route path="/scalp-challenge" element={<ScalpChallengeDashboard />} />
            <Route path="/live" element={<LiveTerminal />} />
            <Route path="/strategy-compare" element={<StrategyCompare />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </main>
      </div>
    </BrowserRouter>
  )
}
