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

// ─── Portfolio auth token (in-memory only, never persisted) ──────────────────

let _portfolioToken: string | null = null

export const setPortfolioToken = (token: string | null) => { _portfolioToken = token }
export const getPortfolioToken = () => _portfolioToken

client.interceptors.request.use(config => {
  if (_portfolioToken && config.url?.startsWith('/portfolio')) {
    config.headers = config.headers ?? {}
    config.headers['Authorization'] = `Bearer ${_portfolioToken}`
  }
  return config
})

export const unlockPortfolio = async (password: string): Promise<string> => {
  const { data } = await client.post('/auth/unlock', { password })
  return data.token
}

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

// ─── Undervalued Stocks ───────────────────────────────────────────────────────

export interface UndervaluedStock {
  symbol:           string
  name:             string
  market:           string
  sector:           string
  current_price:    number
  fair_value_est:   number
  upside_pct:       number
  pe_ratio:         number
  price_to_book:    number
  eps_growth_pct:   number
  roe_pct:          number
  debt_equity:      number
  dividend_yield_pct: number
  fundamental_score: number
  technical_score:  number
  rsi:              number
  trend:            string
  value_score:      number
  reasons:          string[]
  in_portfolio:     boolean
  portfolio_action: string  // ADD_MORE | NEW_BUY | WATCH
}

export interface UndervaluedData {
  undervalued:  UndervaluedStock[]
  count:        number
  market:       string
  generated_at: string
}

export const getUndervaluedStocks = async (market?: string): Promise<UndervaluedData> => {
  const { data } = await client.get('/signals/undervalued', { params: { market } })
  return data
}

// ─── BTST Signals ─────────────────────────────────────────────────────────────

export interface BTSTSignal {
  symbol:          string
  name:            string
  market:          string
  sector:          string
  entry_price:     number
  target_price:    number
  stop_loss:       number
  risk_reward:     number
  confidence:      number
  strategy:        string
  reasons:         string[]
  rsi:             number
  trend:           string
  volume_ratio:    number
  technical_score: number
  exit_time:       string
  generated_at:    string
}

export interface BTSTData {
  signals:      BTSTSignal[]
  count:        number
  market:       string
  generated_at: string
  note:         string
}

export const getBTSTSignals = async (): Promise<BTSTData> => {
  const { data } = await client.get('/signals/btst')
  return data
}

// ─── Scalping Backtest ────────────────────────────────────────────────────────

export interface ScalpBacktestTrade {
  date:         string
  direction:    string
  entry_price:  number
  exit_price:   number
  pnl_pct:      number
  is_win:       boolean
  exit_reason:  string
}

export interface YearlyResult {
  year:          number
  trades:        number
  win_rate:      number
  net_pnl_pct:   number
  profit_factor: number
}

export interface ScalpStrategyResult {
  strategy_name:       string
  description:         string
  symbol:              string
  period_years:        number
  total_trades:        number
  winning_trades:      number
  losing_trades:       number
  win_rate:            number
  avg_win_pct:         number
  avg_loss_pct:        number
  profit_factor:       number
  max_drawdown_pct:    number
  net_pnl_pct:         number
  sharpe_ratio:        number
  expectancy_pct:      number
  best_trade_pct:      number
  worst_trade_pct:     number
  avg_trades_per_month: number
  yearly_breakdown:    YearlyResult[]
  recent_trades:       ScalpBacktestTrade[]
}

export interface BacktestSummary {
  best_win_rate_strategy:    string
  best_win_rate_value:       number
  best_profit_factor_strategy: string
  best_profit_factor_value:  number
  best_net_pnl_strategy:     string
  best_net_pnl_value:        number
  overall_win_rate:          number
  total_signals:             number
  recommendation:            string
}

export interface ScalpBacktestReport {
  symbol:       string
  symbol_name:  string
  generated_at: string
  period_years: number
  data_points:  number
  strategies:   ScalpStrategyResult[]
  summary:      BacktestSummary
}

export const getScalpingBacktest = async (symbol = '^NSEI', years = 5): Promise<ScalpBacktestReport> => {
  const { data } = await client.get('/backtest/scalping', { params: { symbol, years } })
  return data
}

// ─── Long-Term US SIP Picks ───────────────────────────────────────────────────

export interface LongTermUSPick {
  symbol:              string
  name:                string
  sector:              string
  growth_sector:       string
  growth_sector_label: string
  current_price:       number
  target_3yr_low:      number
  target_3yr_high:     number
  expected_cagr_pct:   number

  overall_sip_score:   number
  fund_score:          number
  tech_score:          number
  valuation_score:     number
  growth_score:        number
  sip_bonus:           number

  pe_ratio:            number
  forward_pe:          number
  price_to_book:       number
  eps_growth_pct:      number
  revenue_growth_pct:  number
  roe_pct:             number
  roa_pct:             number
  debt_equity:         number
  profit_margin_pct:   number
  dividend_yield_pct:  number

  rsi:                 number
  trend:               string
  above_sma200:        boolean
  ma_trend:            string   // BULLISH | BEARISH | NEUTRAL
  tech_entry:          string   // GOOD | FAIR | WAIT

  sip_rating:          string   // EXCELLENT | GOOD | FAIR | SPECULATIVE
  risk_profile:        string   // CONSERVATIVE | MODERATE | AGGRESSIVE
  monthly_sip_pct:     number
  valuation_zone:      string   // UNDERVALUED | FAIR | SLIGHTLY_HIGH | OVERVALUED

  thesis:              string[]
  risks:               string[]
  best_buy_zone:       string
  generated_at:        string
}

export interface SIPSectorItem {
  growth_sector: string
  label:         string
  count:         number
  avg_score:     number
  avg_cagr_pct:  number
  alloc_pct:     number
}

export interface LongTermUSReport {
  picks:            LongTermUSPick[]
  sector_summary:   SIPSectorItem[]
  total_picks:      number
  avg_expected_cagr_pct: number
  sip_methodology:  string
  generated_at:     string
}

export const getLongTermUSPicks = async (): Promise<LongTermUSReport> => {
  const { data } = await client.get('/signals/longterm-us')
  return data
}

// ─── Backtest ─────────────────────────────────────────────────────────────────

export const runBacktest = async (symbol: string, strategy = 'RSI_MACD'): Promise<BacktestResult> => {
  const { data } = await client.get(`/stocks/${encodeURIComponent(symbol)}/backtest`, { params: { strategy } })
  return data
}
