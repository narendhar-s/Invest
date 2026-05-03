import axios from 'axios'
import type {
  StockDetailData,
  Stock,
  Recommendation,
  IntradaySignal,
  InvestmentSignal,
  ScalpSignal,
  Trade,
  BacktestResult,
  PriceBar,
  TechnicalIndicator,
  SRLevel,
} from '../types'

const BASE_URL = '/api/v1'

const client = axios.create({ baseURL: BASE_URL, timeout: 30000 })

// ─── Dashboard ───────────────────────────────────────────────────────────────

export interface DashboardData {
  nse_intraday:  Recommendation[]
  nse_swing:     Recommendation[]
  nse_longterm:  Recommendation[]
  us_swing:      Recommendation[]
  us_longterm:   Recommendation[]
  top_picks:     Recommendation[]
  active_trades: number
  generated_at:  string
}

export const getDashboard = async (): Promise<DashboardData> => {
  const { data } = await client.get('/dashboard')
  return data
}

// ─── Stocks ──────────────────────────────────────────────────────────────────

export const getStocks = async (market?: string): Promise<{ stocks: Stock[]; total: number }> => {
  const { data } = await client.get('/stocks', { params: { market } })
  return data
}

export const getStockDetail = async (symbol: string): Promise<StockDetailData> => {
  const { data } = await client.get(`/stocks/${encodeURIComponent(symbol)}`)
  return data
}

export const getPriceHistory = async (symbol: string, days = 365): Promise<{ bars: PriceBar[] }> => {
  const { data } = await client.get(`/stocks/${encodeURIComponent(symbol)}/price-history`, { params: { days } })
  return data
}

export const getTechnicalIndicators = async (symbol: string): Promise<{ indicators: TechnicalIndicator[]; latest: TechnicalIndicator | null }> => {
  const { data } = await client.get(`/stocks/${encodeURIComponent(symbol)}/indicators`)
  return data
}

export const getSRLevels = async (symbol: string): Promise<{ levels: SRLevel[] }> => {
  const { data } = await client.get(`/stocks/${encodeURIComponent(symbol)}/sr-levels`)
  return data
}

// ─── Recommendations ─────────────────────────────────────────────────────────

export const getRecommendations = async (
  market?: string,
  horizon?: string,
  limit = 30,
): Promise<{ recommendations: Recommendation[] }> => {
  const { data } = await client.get('/recommendations', { params: { market, horizon, limit } })
  return data
}

// ─── Signals ─────────────────────────────────────────────────────────────────

export const getIntradaySignals = async (): Promise<{ signals: IntradaySignal[] }> => {
  const { data } = await client.get('/signals/intraday')
  return data
}

export const getInvestmentSignals = async (market?: string, horizon?: string): Promise<{ signals: InvestmentSignal[] }> => {
  const { data } = await client.get('/signals/investment', { params: { market, horizon } })
  return data
}

export const getIndexSignals = async (market?: string): Promise<{ signals: IndexSignalType[] }> => {
  const { data } = await client.get('/signals/index', { params: { market } })
  return data
}

export const getScalpingSignals = async (timeframe?: string, scope?: string): Promise<{ signals: ScalpSignal[] }> => {
  const { data } = await client.get('/signals/scalping', { params: { timeframe, scope } })
  return data
}

export interface IndexSignalType {
  symbol:     string
  name:       string
  direction:  string
  strategy:   string
  signal:     string
  close:      number
  rsi:        number
  macd_hist:  number
  trend:      string
  sma20:      number
  sma50:      number
  vwap:       number
  confidence: number
}

// ─── Trades ──────────────────────────────────────────────────────────────────

export const getTrades = async (market?: string): Promise<{ trades: Trade[] }> => {
  const { data } = await client.get('/trades', { params: { market } })
  return data
}

// ─── Portfolio ───────────────────────────────────────────────────────────────

export interface HoldingMetrics {
  symbol: string
  yf_symbol: string
  display_name: string
  market: string
  sector: string
  currency: string
  quantity: number
  avg_buy_price: number
  current_price: number
  invested_value: number
  current_value: number
  pnl_abs: number
  pnl_pct: number
  portfolio_weight: number
  rsi: number
  trend: string
  technical_score: number
  macd_hist: number
  volume_spike: boolean
  last_bar_date: string
  key_support: number
  key_resistance: number
  zone: string
  zone_low: number
  zone_high: number
  zone_reason: string
  risk_level: string
  action: string
  action_reason: string
  has_alert: boolean
  alert_message: string
}

export interface PortfolioSummary {
  total_invested_inr: number
  total_current_inr: number
  total_pnl_inr: number
  total_pnl_pct: number
  total_invested_usd: number
  total_current_usd: number
  total_pnl_usd: number
  total_pnl_pct_usd: number
  holdings_count: number
  gainers_count: number
  losers_count: number
  best_performer: string
  worst_performer: string
}

export interface SectorAlloc {
  sector: string
  market: string
  invested_value: number
  current_value: number
  allocation_pct: number
  pnl_pct: number
  stock_count: number
  over_exposed: boolean
}

export interface PortfolioAlert {
  symbol: string
  type: string
  message: string
  severity: string
}

export interface PortfolioData {
  holdings: HoldingMetrics[]
  summary: PortfolioSummary
  sector_breakdown: SectorAlloc[]
  alerts: PortfolioAlert[]
  generated_at: string
}

export const getPortfolio = async (): Promise<PortfolioData> => {
  const { data } = await client.get('/portfolio')
  return data
}

export const buyMore = async (symbol: string, newQty: number, newPrice: number) => {
  const { data } = await client.post(`/portfolio/holding/${encodeURIComponent(symbol)}/buy`, { new_qty: newQty, new_price: newPrice })
  return data
}

export const sellPartial = async (symbol: string, sellQty: number, sellPrice: number) => {
  const { data } = await client.post(`/portfolio/holding/${encodeURIComponent(symbol)}/sell`, { sell_qty: sellQty, sell_price: sellPrice })
  return data
}

export const upsertHolding = async (holding: Partial<HoldingMetrics> & { symbol: string; market: string; quantity: number; avg_buy_price: number }) => {
  const { data } = await client.post('/portfolio/holding', holding)
  return data
}

// ─── Backtest ─────────────────────────────────────────────────────────────────

export const runBacktest = async (symbol: string, strategy = 'RSI_MACD'): Promise<BacktestResult> => {
  const { data } = await client.get(`/stocks/${encodeURIComponent(symbol)}/backtest`, { params: { strategy } })
  return data
}
