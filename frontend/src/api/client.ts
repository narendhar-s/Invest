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
  config.headers = config.headers ?? {}
  if (_portfolioToken && config.url?.startsWith('/portfolio')) {
    config.headers['Authorization'] = `Bearer ${_portfolioToken}`
  }
  // Force revalidation on every API call. Without this, a stale cached
  // index.html (served when an endpoint briefly 404'd) can mask a working
  // JSON endpoint, leaving dropdowns empty with no error.
  config.headers['Cache-Control'] = 'no-cache'
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

export interface AddStockResult {
  stock: Stock
  recommendations: Record<string, Recommendation>
  latest_indicator: import('../types').TechnicalIndicator | null
  fundamental: import('../types').Fundamental | null
  message: string
}

export const addStock = async (symbol: string, market?: string): Promise<AddStockResult> => {
  const { data } = await client.post('/stocks/add', { symbol, market })
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

// ─── Zerodha ──────────────────────────────────────────────────────────────────

export interface ZerodhaStatus {
  configured: boolean
  connected: boolean
  streaming: boolean
  token_date: string
}

export interface ZerodhaQuote {
  symbol: string
  last_price: number
  open: number
  high: number
  low: number
  close: number
  change: number
  change_pct: number
  volume: number
  timestamp: string
}

export const getZerodhaStatus = async (): Promise<ZerodhaStatus> => {
  const { data } = await client.get('/zerodha/status')
  return data
}

export const getZerodhaLoginUrl = async (): Promise<{ login_url: string; configured: boolean }> => {
  const { data } = await client.get('/zerodha/login-url')
  return data
}

export const zerodhaLogout = async (): Promise<void> => {
  await client.post('/zerodha/logout')
}

export const getZerodhaQuotes = async (): Promise<{ quotes: Record<string, ZerodhaQuote>; count: number }> => {
  const { data } = await client.get('/zerodha/quotes')
  return data
}

// ─── Live Strategy Trading ─────────────────────────────────────────────────────

export interface StrategyMeta {
  key:          string
  name:         string
  description:  string
  configurable?: boolean
}

// ─── Configurable strategies (strategy editor) ─────────────────────────────────

export type StrategyConfig = Record<string, string | number | boolean>

export interface StrategyConfigResponse {
  key:      string
  name:     string
  config:   StrategyConfig
  defaults: StrategyConfig
}

// ─── Strategy backtest ─────────────────────────────────────────────────────────

export interface BacktestTrade {
  entry_time:    number
  exit_time:     number
  direction:     string
  option_type?:  string
  option_action?: string
  strike?:       number
  entry:         number
  exit:          number
  exit_reason:   string
  pnl_points:    number
  win:           boolean
  reason:        string
}

export interface BacktestSummary {
  symbol:        string
  interval:      string
  strategy:      string
  trades:        BacktestTrade[]
  num_trades:    number
  wins:          number
  losses:        number
  win_rate:      number
  net_points:    number
  gross_win:     number
  gross_loss:    number
  profit_factor: number
  avg_points:    number
}

export interface BacktestRange {
  from?: string // YYYY-MM-DD
  to?: string   // YYYY-MM-DD
  days?: number // lookback shortcut
}

export const runStrategyBacktest = async (
  symbol: string,
  strategy: string,
  timeframe = '5m',
  range: BacktestRange = {},
): Promise<{ available: boolean; result?: BacktestSummary; error?: string }> => {
  const params: Record<string, string | number> = { symbol, strategy, timeframe }
  if (range.from) params.from = range.from
  if (range.to) params.to = range.to
  if (range.days) params.days = range.days
  const { data } = await client.get('/live/backtest', { params })
  return data
}

export const getStrategyConfig = async (key: string): Promise<StrategyConfigResponse> => {
  const { data } = await client.get(`/live/strategies/${encodeURIComponent(key)}/config`)
  return data
}

export const updateStrategyConfig = async (
  key: string,
  config: StrategyConfig,
): Promise<{ key: string; config: StrategyConfig }> => {
  const { data } = await client.put(`/live/strategies/${encodeURIComponent(key)}/config`, config)
  return data
}

export interface ModeMeta {
  key:  string
  name: string
}

export interface LiveStrategiesResponse {
  strategies:  StrategyMeta[]
  modes:       ModeMeta[]
  data_source: string
}

export interface LiveCall {
  symbol:      string
  direction:   string   // BUY / SELL
  strategy:    string
  price:       number
  target:      number
  stop_loss:   number
  confidence:  number
  reason:      string
  mode:        string
  status:      string   // SIGNAL / PAPER_FILLED / ORDER_PLACED / ORDER_REJECTED
  order_id?:   string
  quantity:    number
  paper_pnl?:  number
  error?:      string
  timestamp:   string
}

export interface LiveStatus {
  running:      boolean
  available?:   boolean
  strategy:     string
  strategies?:  string[]
  min_agree?:   number
  mode:         string
  timeframe:    string
  symbols:      string[]
  started_at?:  string
  paper_pnl:    number
  recent_calls: LiveCall[]
}

export const getLiveStrategies = async (): Promise<LiveStrategiesResponse> => {
  const { data } = await client.get('/live/strategies')
  return data
}

export const getLiveStatus = async (): Promise<LiveStatus> => {
  const { data } = await client.get('/live/status')
  return data
}

export const startLive = async (
  strategies: string[],
  minAgree: number,
  mode: string,
  timeframe: string,
  symbols?: string[],
): Promise<LiveStatus> => {
  const { data } = await client.post('/live/start', {
    strategies,
    min_agree: minAgree,
    mode,
    timeframe,
    symbols,
  })
  return data
}

export const stopLive = async (): Promise<void> => {
  await client.post('/live/stop')
}

// SSE stream of live calls. Returns the EventSource so the caller can close it.
export const openLiveCallsStream = (onCall: (c: LiveCall) => void): EventSource => {
  const es = new EventSource(`${BASE_URL}/live/calls`)
  es.onmessage = (ev) => {
    try { onCall(JSON.parse(ev.data) as LiveCall) } catch { /* ignore */ }
  }
  return es
}

// A persisted trade call as returned by the day-history endpoint.
export interface LiveCallRecord {
  id:          number
  called_at:   string
  symbol:      string
  direction:   string
  strategy:    string
  price:       number
  target:      number
  stop_loss:   number
  confidence:  number
  reason:      string
  mode:        string
  status:      string
  order_id?:   string
  quantity:    number
  paper_pnl?:  number
  error?:      string
}

export interface LiveCallsHistory {
  date:  string
  calls: LiveCallRecord[]
}

// Fetches the trade calls the engine emitted on a given day (YYYY-MM-DD).
// Omitting the date returns today's calls.
export const getLiveCallsHistory = async (date?: string): Promise<LiveCallsHistory> => {
  const { data } = await client.get('/live/calls/history', {
    params: date ? { date } : undefined,
  })
  return data
}

// ─── Live candles & candlestick patterns ─────────────────────────────────────

export interface LiveCandle {
  symbol: string
  interval: string
  start: string
  open: number
  high: number
  low: number
  close: number
  volume: number
  closed: boolean
}

export interface PatternMeta {
  key: string
  name: string
  direction: 'bullish' | 'bearish' | 'neutral'
}

export interface PatternHit {
  key: string
  name: string
  direction: 'bullish' | 'bearish' | 'neutral'
  index: number
  time: number  // unix seconds
  price: number
}

export interface CandleSnapshot {
  symbol: string
  interval: string
  candles: LiveCandle[]
  patterns: PatternHit[]
  current?: LiveCandle
}

export const getPatterns = async (): Promise<PatternMeta[]> => {
  const { data } = await client.get('/live/patterns')
  return data.patterns ?? []
}

export const getCandleSnapshot = async (symbol: string): Promise<CandleSnapshot> => {
  const { data } = await client.get('/live/snapshot', { params: { symbol } })
  return data
}

export interface OptionChainRow {
  strike: number
  call_oi: number
  put_oi: number
  call_chg_oi: number
  put_chg_oi: number
  call_ltp: number
  put_ltp: number
}

export interface OIAnalysis {
  underlying: string
  spot: number
  expiry: string
  pcr: number
  max_pain: number
  support: number
  resistance: number
  chg_support: number
  chg_resistance: number
  has_change: boolean
  total_call_oi: number
  total_put_oi: number
  bias: 'bullish' | 'bearish' | 'neutral'
  rows: OptionChainRow[]
  as_of: string
}

export interface OIResponse {
  available: boolean
  oi?: OIAnalysis
  error?: string
}

export const getLiveOI = async (symbol: string): Promise<OIResponse> => {
  const { data } = await client.get('/live/oi', { params: { symbol } })
  return data
}

export interface OIPulseRow {
  at: string
  unix: number
  spot: number
  pcr: number
  total_call_oi: number
  total_put_oi: number
  total_oi: number
  spot_chg: number
  pcr_chg: number
  call_oi_chg: number
  put_oi_chg: number
  total_oi_chg: number
  regime: string
  signal: 'BULLISH' | 'BEARISH' | 'NEUTRAL'
  score: number
}

export type TradeMode = 'option_buy' | 'option_sell' | 'futures_buy' | 'futures_sell'

export interface OITradeDecision {
  mode: TradeMode
  mode_label: string
  instrument: 'OPTION' | 'FUTURES'
  action: string
  option_type: string
  side: string
  moneyness: string
  strike: number
  atm_strike: number
  strike_step: number
  conviction: string
  confidence: number
  entry: string
  target_note: string
  stop_note: string
  // Risk:reward + position sizing (configurable).
  rr: number
  entry_price: number
  stop_price: number
  target_price: number
  max_lots: number
  lots: number
  qty: number
  total_cost: number
  // Live tradeable option leg (resolved via Kite); empty/zero when no trade.
  tradingsymbol: string
  option_exchange: string
  expiry: string
  lot_size: number
  premium: number
  cost_per_lot: number
  approx_delta: number
  rationale: string
  notes: string[]
}

export interface OIPulse {
  underlying: string
  spot: number
  expiry: string
  pcr: number
  max_pain: number
  support: number
  resistance: number
  bias: 'bullish' | 'bearish' | 'neutral'
  regime: string
  signal: 'BULLISH' | 'BEARISH' | 'NEUTRAL'
  verdict: string
  confidence: number
  score: number
  rules: string[]
  has_prev: boolean
  history: OIPulseRow[]
  decision: OITradeDecision | null
  decisions: OITradeDecision[]
  as_of: string
}

export interface OIPulseResponse {
  available: boolean
  pulse?: OIPulse
  error?: string
}

export const getOIPulse = async (
  symbol: string,
  modes?: TradeMode[],
  maxLots?: number,
  rr?: number,
): Promise<OIPulseResponse> => {
  const params: Record<string, string> = { symbol }
  if (modes && modes.length > 0) params.modes = modes.join(',')
  if (maxLots) params.lots = String(maxLots)
  if (rr) params.rr = String(rr)
  const { data } = await client.get('/live/oi/pulse', { params })
  return data
}

export interface ReplayCall {
  time: number // unix seconds
  direction: string
  price: number
  strategy: string
  reason: string
}

export interface HistorySnapshot {
  symbol: string
  interval: string
  candles: LiveCandle[]
  patterns: PatternHit[]
  calls: ReplayCall[]
  strategy: string
  replayed: boolean
  available?: boolean
  error?: string
}

export const getLiveHistory = async (
  symbol: string,
  timeframe?: string,
  strategy?: string,
  range: BacktestRange = {},
): Promise<HistorySnapshot> => {
  const params: Record<string, string | number | undefined> = { symbol, timeframe, strategy }
  if (range.from) params.from = range.from
  if (range.to) params.to = range.to
  if (range.days) params.days = range.days
  const { data } = await client.get('/live/history', { params })
  return data
}

// SSE stream of candles for one symbol. Returns the EventSource to close it.
export const openCandleStream = (
  symbol: string,
  onCandle: (c: LiveCandle) => void,
): EventSource => {
  const es = new EventSource(`${BASE_URL}/live/candles?symbol=${encodeURIComponent(symbol)}`)
  es.onmessage = (ev) => {
    try { onCandle(JSON.parse(ev.data) as LiveCandle) } catch { /* ignore */ }
  }
  return es
}

// Handle for a live candle WebSocket. `close()` stops auto-reconnect and tears
// down the socket. The stream pushes closed + in-progress candles tick-by-tick.
export interface CandleStream {
  close: () => void
}

// WebSocket stream of candles for one symbol. Preferred over SSE: lower latency,
// no proxy buffering, and it auto-reconnects with backoff if the socket drops.
export const openCandleSocket = (
  symbol: string,
  onCandle: (c: LiveCandle) => void,
): CandleStream => {
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
  const url = `${proto}://${window.location.host}${BASE_URL}/live/candles/ws?symbol=${encodeURIComponent(symbol)}`

  let ws: WebSocket | null = null
  let closed = false
  let retry = 0
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null

  const connect = () => {
    if (closed) return
    ws = new WebSocket(url)
    ws.onopen = () => { retry = 0 }
    ws.onmessage = (ev) => {
      try { onCandle(JSON.parse(ev.data) as LiveCandle) } catch { /* ignore */ }
    }
    ws.onclose = () => {
      if (closed) return
      // Exponential backoff capped at 10s.
      const delay = Math.min(10000, 500 * 2 ** retry)
      retry += 1
      reconnectTimer = setTimeout(connect, delay)
    }
    ws.onerror = () => { ws?.close() }
  }

  connect()

  return {
    close: () => {
      closed = true
      if (reconnectTimer) clearTimeout(reconnectTimer)
      ws?.close()
    },
  }
}
