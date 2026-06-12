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

const BASE_URL = '/api/naren/v1'

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

// ─── SIP Watchlist ────────────────────────────────────────────────────────────

export interface WatchlistStockData {
  symbol:             string
  name:               string
  sector:             string
  current_price:      number
  price_change:       number
  price_change_pct:   number
  // Fundamental
  pe_ratio:           number | null
  forward_pe:         number | null
  eps:                number | null
  eps_growth_pct:     number | null
  revenue_growth_pct: number | null
  debt_equity:        number | null
  roe_pct:            number | null
  roa_pct:            number | null
  market_cap_b:       number
  dividend_yield_pct: number | null
  price_to_book:      number | null
  profit_margin_pct:  number | null
  fundamental_score:  number
  fundamental_rating: string
  // Technical
  rsi:                number
  macd_hist:          number
  sma20:              number
  sma50:              number
  sma200:             number
  trend:              string
  tech_signal:        string
  tech_score:         number
  // SIP
  valuation_zone:     string
  sip_rating:         string
  key_thesis:         string[]
  sip_suggestion:     string
}

export interface GemStockData {
  symbol:             string
  name:               string
  sector:             string
  current_price:      number
  price_change:       number
  price_change_pct:   number
  upside_pct:         number
  expected_cagr_pct:  number
  pe_ratio:           number | null
  rsi:                number
  sma50:              number
  trend:              string
  why_undervalued:    string
  growth_catalysts:   string[]
  risks:              string[]
  sip_rationale:      string
  risk_level:         string
}

export interface WatchlistResponse {
  watchlist:        WatchlistStockData[]
  undervalued_gems: GemStockData[]
  generated_at:     string
}

export const getWatchlist = async (): Promise<WatchlistResponse> => {
  const { data } = await client.get('/watchlist')
  return data
}

// ─── Backtest ─────────────────────────────────────────────────────────────────

export const runBacktest = async (symbol: string, strategy = 'RSI_MACD'): Promise<BacktestResult> => {
  const { data } = await client.get(`/stocks/${encodeURIComponent(symbol)}/backtest`, { params: { strategy } })
  return data
}

// ─── Nifty Scalping Terminal ──────────────────────────────────────────────────

export interface OptionData {
  strike_price:        number
  expiry_date:         string
  open_interest:       number
  change_in_oi:        number
  total_traded_volume: number
  implied_volatility:  number
  last_price:          number
  change:              number
  bid:                 number
  ask:                 number
  underlying_value:    number
}

export interface OptionChainRow {
  strike_price: number
  is_atm:       boolean
  ce:           OptionData
  pe:           OptionData
}

export interface OptionChainData {
  symbol:            string
  spot_price:        number
  expiry_dates:      string[]
  selected_expiry:   string
  rows:              OptionChainRow[]
  total_ce_oi:       number
  total_pe_oi:       number
  pcr:               number
  max_pain_strike:   number
  atm_strike:        number
  iv_skew:           number
  market_sentiment:  string
  support_levels:    number[]
  resistance_levels: number[]
  timestamp:         string
  fetched_at:        string
}

export interface StrikeSuggestion {
  strike:          number
  option_type:     string
  expiry_date:     string
  expiry_type:     string
  ltp:             number
  delta:           number
  iv:              number
  theta:           number
  suggested_entry: number
  target:          number
  stop_loss:       number
  max_loss:        number
  max_profit:      number
  risk_reward:     number
  lot_size:        number
  risk_level:      string
  label:           string
  rationale:       string
  confidence:      number
}

export interface StrikeSuggestionReport {
  spot_price:       number
  direction:        string
  expiry:           string
  atm_strike:       number
  suggestions:      StrikeSuggestion[]
  max_pain_strike:  number
  pcr:              number
  market_sentiment: string
  generated_at:     string
}

export interface NiftyScalpSignal {
  strategy:         string
  direction:        string
  signal:           string
  entry_price:      number
  target:           number
  stop_loss:        number
  spot_entry:       number
  spot_target:      number
  spot_stop:        number
  points_target:    number
  points_stop:      number
  risk_reward:      number
  confidence:       number
  win_rate:         number
  profit_factor:    number
  timeframe:        string
  reasons:          string[]
  suggested_option: string
  generated_at:     string
}

export interface NiftyYearlyStats {
  year:          number
  trades:        number
  win_rate:      number
  net_pnl_pct:   number
  profit_factor: number
}

export interface NiftyStrategyCard {
  strategy_name:        string
  description:          string
  timeframe:            string
  win_rate:             number
  profit_factor:        number
  max_drawdown_pct:     number
  net_pnl_pct:          number
  sharpe_ratio:         number
  total_trades:         number
  avg_trades_per_month: number
  expectancy_pct:       number
  yearly_breakdown:     NiftyYearlyStats[]
  current_signal:       NiftyScalpSignal | null
  rules:                string[]
  best_for:             string
  risk_level:           string
}

export interface NiftyDashboard {
  spot_price:         number
  change:             number
  change_pct:         number
  vix:                number
  pcr:                number
  max_pain_strike:    number
  atm_strike:         number
  market_sentiment:   string
  trend_direction:    string
  strategies:         NiftyStrategyCard[]
  live_signals:       NiftyScalpSignal[]
  strike_suggestions: StrikeSuggestionReport | null
  option_chain:       OptionChainData | null
  generated_at:       string
}

export const getNiftyDashboard = async (expiry?: string, years?: number): Promise<NiftyDashboard> => {
  const { data } = await client.get('/nifty/dashboard', { params: { expiry, years } })
  return data
}

export const getNiftyOptionChain = async (expiry?: string): Promise<OptionChainData> => {
  const { data } = await client.get('/nifty/option-chain', { params: { expiry } })
  return data
}

export const getNiftyStrikeSuggestions = async (direction?: string, expiry?: string): Promise<StrikeSuggestionReport> => {
  const { data } = await client.get('/nifty/strike-suggestions', { params: { direction, expiry } })
  return data
}

export const getNiftyLiveSignals = async (timeframe?: '5m' | '15m' | 'daily'): Promise<{ signals: NiftyScalpSignal[]; count: number; timeframe: string; generated_at: string }> => {
  const { data } = await client.get('/nifty/live-signals', { params: { timeframe } })
  return data
}

export const getNiftyStrategyCards = async (years?: number): Promise<{ strategies: NiftyStrategyCard[]; count: number; period_years: number; generated_at: string }> => {
  const { data } = await client.get('/nifty/strategies', { params: { years } })
  return data
}

export interface NiftyChartBar {
  date:      string   // "YYYY-MM-DD" for daily, "YYYY-MM-DD HH:mm" for intraday
  unix_time: number   // Unix seconds — use as chart time for 5m/15m (0 for daily)
  open:      number
  high:      number
  low:       number
  close:     number
  volume:    number
  ema9:      number
  ema21:     number
  sma50:     number
  vwap:      number
  rsi:       number
  atr:       number
  signal:    string   // "BUY" | "SELL" | ""
  strategy:  string
  win_rate:  number   // strategy's historical win rate (e.g. 62.1)
}

export interface NiftyChartData {
  symbol:       string
  timeframe:    string  // "daily" | "5m" | "15m"
  bars:         NiftyChartBar[]
  total_bars:   number
  generated_at: string
}

export interface BTSTCriterion {
  label:  string
  value:  string
  met:    boolean
  weight: number
}

export interface NiftyBTSTSignal {
  date:           string
  spot_price:     number
  open:           number
  high:           number
  low:            number
  change:         number
  change_pct:     number
  signal:         string   // "BUY" | "AVOID" | "NEUTRAL"
  confidence:     number
  score:          number
  entry_price:    number
  target_price:   number
  stop_loss:      number
  risk_reward:    number
  ema9:           number
  ema21:          number
  sma50:          number
  rsi:            number
  atr:            number
  macd_hist:      number
  volume_ratio:   number
  close_position: number   // 0-100: % close within day range
  criteria:       BTSTCriterion[]
  strategy:       string
  market_status:  string   // "OPEN" | "CLOSED"
  entry_window:   string
  exit_window:    string
  generated_at:   string
  note:           string
}

export const getNiftyBTST = async (): Promise<NiftyBTSTSignal> => {
  const { data } = await client.get('/nifty/btst')
  if (data?.error) throw new Error(data.error)
  if (!data || typeof data !== 'object' || !data.signal) {
    throw new Error('BTST route not found — backend may need restart')
  }
  return data
}

// ─── News Flags ──────────────────────────────────────────────────────────────

export interface NewsFlag {
  symbol:     string
  name:       string
  sector:     string
  flag:       'GREEN' | 'RED' | 'NEUTRAL'
  headline:   string
  summary:    string
  source:     string
  url:        string
  impact:     'HIGH' | 'MEDIUM' | 'LOW'
  category:   'Stock' | 'Sector'
  fetched_at: string
}

export interface NewsFlagsResponse {
  green_flags:  NewsFlag[]
  red_flags:    NewsFlag[]
  green_count:  number
  red_count:    number
  last_update:  string
}

export const getNewsFlags = async (): Promise<NewsFlagsResponse> => {
  const { data } = await client.get('/news/flags')
  return data
}

// ─── Tomorrow Picks ───────────────────────────────────────────────────────────

export interface TomorrowPick {
  symbol:            string
  name:              string
  sector:            string
  best_strategy:     string
  win_rate:          number
  profit_factor:     number
  net_pnl_pct:       number
  total_trades:      number
  avg_win_pct:       number
  avg_loss_pct:      number
  max_drawdown_pct:  number
  trade_probability: number
  direction:         'BUY' | 'SELL' | 'NEUTRAL'
  last_close:        number
  data_points:       number
  entry_price:       number
  target_price:      number
  stop_loss:         number
  target_pct:        number
  stop_pct:          number
  risk_reward:       number
  expected_pnl:      number
  // today-specific
  today_open:        number
  today_high:        number
  today_low:         number
  today_close:       number
  today_status:      'TARGET_HIT' | 'SL_HIT' | 'OPEN' | 'NO_SIGNAL'
  today_pnl_pct:     number
  signal_date:       string
  // option strike suggestions
  options?:          StrikeSuggestionReport
}

export interface TomorrowPicksResponse {
  picks:        TomorrowPick[]
  count:        number
  period_years: number
  generated_at: string
}

export const getTomorrowPicks = async (years = 3): Promise<TomorrowPicksResponse> => {
  const { data } = await client.get('/nifty/tomorrow-picks', { params: { years } })
  return data
}

export const getTodayPicks = async (years = 3): Promise<TomorrowPicksResponse> => {
  const { data } = await client.get('/nifty/today-picks', { params: { years } })
  return data
}

// ─── Options Power Setup ─────────────────────────────────────────────────────

export interface OptionsFactor {
  name:   string
  status: string // BULL | BEAR | NEUTRAL | SPIKE | WEAK
  value:  string
  ok:     boolean
}

export interface OptionsSignal {
  signal:       string   // CE_BUY | PE_BUY | WAIT
  confidence:   number
  factors:      OptionsFactor[]
  entry:        number
  target:       number
  stop_loss:    number
  risk_reward:  number
  strike:       number
  expiry:       string
  generated_at: string
}

export interface OptionsTrade {
  date:               string
  direction:          string
  entry:              number
  exit:               number
  pnl_pct:            number
  result:             string
  factors_confirmed:  number
}

export interface OptionsBacktestResult {
  total_trades:   number
  winning_trades: number
  losing_trades:  number
  win_rate:       number
  profit_factor:  number
  avg_win_pct:    number
  avg_loss_pct:   number
  max_drawdown_pct: number
  total_return_pct: number
  trades:         OptionsTrade[]
}

export const getOptionsSignal = async (): Promise<OptionsSignal> => {
  const { data } = await client.get('/nifty/options-signal')
  return data
}

export const getOptionsBacktest = async (years = 3): Promise<{ result: OptionsBacktestResult; period_years: number; generated_at: string }> => {
  const { data } = await client.get('/nifty/options-backtest', { params: { years } })
  return data
}

// ─── CPR (Central Pivot Range) Strategy ──────────────────────────────────────

export interface CPRLevels {
  pivot:     number
  tc:        number
  bc:        number
  r1:        number
  r2:        number
  r3:        number
  s1:        number
  s2:        number
  s3:        number
  width:     number
  is_narrow: boolean
  is_wide:   boolean
  day_type:  string // "TREND" | "RANGE" | "MODERATE"
}

export interface CPRSignal {
  symbol:       string
  date:         string
  spot_price:   number
  levels:       CPRLevels
  mode:         string    // "NARROW_BREAKOUT" | "WIDE_RANGE" | "CPR_BOUNCE" | "WAIT"
  direction:    string    // "BUY" | "SELL" | "WAIT"
  signal:       string
  entry_zone:   string
  target_1:     number
  target_2:     number
  stop_loss:    number
  risk_reward:  number
  confidence:   number
  win_rate:     number
  reasons:      string[]
  caution:      string
  generated_at: string
}

export interface CPRTimeframeCard {
  timeframe:      string  // "Daily" | "Weekly" | "Monthly"
  period_desc:    string
  levels:         CPRLevels
  spot_price:     number
  direction:      string  // "ABOVE_CPR" | "BELOW_CPR" | "INSIDE_CPR"
  bias:           string  // "BULLISH" | "BEARISH" | "NEUTRAL"
  spot_vs_tc:     number  // % vs TC
  spot_vs_bc:     number  // % vs BC
  is_virgin_cpr:  boolean
  virgin_note:    string
}

export interface CPRMultiTimeframeSignal {
  symbol:       string
  spot_price:   number
  daily:        CPRTimeframeCard
  weekly:       CPRTimeframeCard
  monthly:      CPRTimeframeCard
  overall_bias: string
  live_signal:  CPRSignal | null
  generated_at: string
}

export interface CPRModeStats {
  trades:      number
  wins:        number
  win_rate:    number
  net_pnl_pct: number
}

export interface CPRBacktestResult {
  strategy_name:    string
  symbol:           string
  period:           string
  total_trades:     number
  winning_trades:   number
  losing_trades:    number
  win_rate:         number
  profit_factor:    number
  avg_win_pct:      number
  avg_loss_pct:     number
  net_pnl_pct:      number
  max_drawdown_pct: number
  sharpe_ratio:     number
  narrow_breakout:  CPRModeStats
  wide_range:       CPRModeStats
  cpr_bounce:       CPRModeStats
  yearly_breakdown: Array<{ year: number; win_rate: number; trades: number; net_pnl_pct: number; profit_factor: number }>
}

export const getCPRSignal = async (): Promise<CPRSignal> => {
  const { data } = await client.get('/nifty/cpr-signal')
  return data
}

export const getCPRMultiTimeframe = async (): Promise<CPRMultiTimeframeSignal> => {
  const { data } = await client.get('/nifty/cpr-multi')
  return data
}

export const getCPRBacktest = async (years = 3): Promise<{ result: CPRBacktestResult; period_years: number; generated_at: string }> => {
  const { data } = await client.get('/nifty/cpr-backtest', { params: { years } })
  return data
}

// ─── Shared Risk Management Type ─────────────────────────────────────────────

export interface RiskManagement {
  account_size:         number
  risk_per_trade_pct:   number
  risk_amount_inr:      number
  daily_loss_limit_pct: number
  daily_loss_limit_inr: number
  max_trades_per_day:   number
  stop_distance_pts:    number
  target_distance_pts:  number
  option_delta:         number
  lot_size:             number
  est_sl_premium_pts:   number
  suggested_lots:       number
  max_loss_inr:         number
  target_gain_inr:      number
  notes:                string[]
}

// ─── ICT + SMC Combined Strategy ─────────────────────────────────────────────

export interface ICTOrderBlock {
  index:     number
  high:      number
  low:       number
  mid:       number
  type:      string  // "BULL" | "BEAR"
  mitigated: boolean
  bars_ago:  number
}

export interface ICTLiquidityLevel {
  price: number
  type:  string  // "BSL" | "SSL"
  swept: boolean
  count: number
}

export interface ICTAnalysis {
  bias:        string
  choch:       boolean
  choch_dir:   string
  mss:         boolean
  bull_ob:     ICTOrderBlock | null
  bear_ob:     ICTOrderBlock | null
  swing_high:  number
  swing_low:   number
  ote_low:     number
  ote_high:    number
  in_ote:      boolean
  equilibrium: number
  in_premium:  boolean
  in_discount: boolean
  liq_levels:  ICTLiquidityLevel[]
}

export interface ICTSMCSignal {
  symbol:        string
  spot_price:    number
  ict:           ICTAnalysis
  smc_bias:      string
  smc_fvg_low:   number
  smc_fvg_high:  number
  smc_sweep_type: string
  combined_bias: string
  signal:        string
  confluence:    number
  entry:         number
  stop_loss:     number
  target1:       number
  target2:       number
  risk_reward:   number
  confidence:    number
  reasoning:     string[]
  risk:          RiskManagement
  generated_at:  string
}

export interface ICTSMCSubStats {
  trades:      number
  wins:        number
  win_rate:    number
  net_pnl_pct: number
}

export interface ICTSMCTrade {
  entry_date:  string
  exit_date:   string
  direction:   string
  entry:       number
  exit:        number
  pnl_pct:     number
  result:      string
  setup:       string
  confluence:  number
}

export interface ICTSMCBacktestResult {
  total_trades:    number
  winning_trades:  number
  losing_trades:   number
  win_rate:        number
  profit_factor:   number
  avg_win_pct:     number
  avg_loss_pct:    number
  max_drawdown_pct: number
  total_return_pct: number
  sharpe_ratio:    number
  ict_ob_only:     ICTSMCSubStats
  smc_fvg_only:    ICTSMCSubStats
  combined_a_plus: ICTSMCSubStats
  trades:          ICTSMCTrade[]
}

export const getICTSMCSignal = async (): Promise<ICTSMCSignal> => {
  const { data } = await client.get('/nifty/ict-smc-signal')
  return data
}

export const getICTSMCBacktest = async (years = 3): Promise<{ result: ICTSMCBacktestResult; period_years: number; generated_at: string }> => {
  const { data } = await client.get('/nifty/ict-smc-backtest', { params: { years } })
  return data
}

// ─── SMC + FVG + VWAP Multi-Timeframe Backtest ───────────────────────────────

export interface SMCFVGVWAPTrade {
  date: string
  direction: string
  option_type: string
  spot_entry: number
  spot_target: number
  spot_stop: number
  spot_exit: number
  spot_pnl_pct: number
  option_pnl_pct: number
  exit_reason: string
  fvg_low: number
  fvg_high: number
  fvg_mid: number
  vwap_level: number
  htf_bias: string
  atr: number
  confluence: number
  is_win: boolean
}

export interface SMCFVGVWAPDirectionStats {
  trades: number
  wins: number
  win_rate: number
  avg_pnl_pct: number
}

export interface SMCFVGVWAPYearlyResult {
  year: number
  trades: number
  win_rate: number
  option_net_pnl_pct: number
  profit_factor: number
  max_drawdown_pct: number
}

export interface SMCFVGVWAPBacktestResult {
  symbol: string
  symbol_name: string
  period_years: number
  generated_at: string
  total_bars: number
  total_trades: number
  winning_trades: number
  losing_trades: number
  win_rate: number
  avg_win_pct: number
  avg_loss_pct: number
  profit_factor: number
  max_drawdown_pct: number
  sharpe_ratio: number
  option_net_pnl_pct: number
  best_trade_pct: number
  worst_trade_pct: number
  avg_trades_per_month: number
  avg_confluence: number
  by_exit_reason: Record<string, number>
  by_direction: Record<string, SMCFVGVWAPDirectionStats>
  yearly_breakdown: SMCFVGVWAPYearlyResult[]
  recent_trades: SMCFVGVWAPTrade[]
  strategy_description: string
  recommendation: string
}

export const getSMCFVGVWAPBacktest = async (years = 3): Promise<SMCFVGVWAPBacktestResult> => {
  const { data } = await client.get('/nifty/smc-fvg-vwap-backtest', { params: { years } })
  return data
}

export const getNiftyChartData = async (
  days = 365,
  strategy = 'Triple Trend Momentum',
  timeframe = 'daily',
  symbol = '^NSEI',
): Promise<NiftyChartData> => {
  if (timeframe === '5m' || timeframe === '15m') {
    const { data } = await client.get('/nifty/chart-data', { params: { timeframe, strategy, symbol } })
    return data
  }
  const { data } = await client.get('/nifty/chart-data', { params: { days, strategy, symbol } })
  return data
}
