export interface Stock {
  id: number
  symbol: string
  name: string
  market: string
  sector: string
  exchange: string
  currency: string
  is_index: boolean
}

export interface PriceBar {
  id: number
  stock_id: number
  date: string
  open: number
  high: number
  low: number
  close: number
  adj_close: number
  volume: number
}

export interface TechnicalIndicator {
  id: number
  stock_id: number
  date: string
  sma20: number | null
  sma50: number | null
  sma200: number | null
  ema20: number | null
  ema50: number | null
  rsi: number | null
  macd_line: number | null
  signal_line: number | null
  macd_hist: number | null
  bb_upper: number | null
  bb_middle: number | null
  bb_lower: number | null
  bb_width: number | null
  vwap: number | null
  relative_volume: number | null
  volume_spike: boolean
  trend_direction: string
  trend_strength: number | null
  technical_score: number
}

export interface Fundamental {
  id: number
  stock_id: number
  pe_ratio: number | null
  forward_pe: number | null
  eps: number | null
  eps_growth: number | null
  revenue_growth: number | null
  debt_equity: number | null
  roe: number | null
  roa: number | null
  market_cap: number | null
  dividend_yield: number | null
  price_to_book: number | null
  profit_margin: number | null
  fundamental_score: number
  sector_rank: number
  updated_at: string
}

export interface SRLevel {
  id: number
  stock_id: number
  level_type: 'support' | 'resistance' | 'breakout' | 'accumulation' | 'supply' | 'pivot'
  price: number
  strength: number
  timeframe: string
  touches: number
  is_active: boolean
}

export interface Recommendation {
  id: number
  stock_id: number
  date: string
  rec_type: 'strong_buy' | 'buy' | 'hold' | 'sell' | 'strong_sell'
  confidence: number
  risk_level: string
  horizon: string
  entry_price: number
  target_price: number
  stop_loss: number
  risk_reward: number
  technical_factors: string
  fundamental_factors: string
  summary: string
  technical_score: number
  fundamental_score: number
  stock?: Stock
}

export interface Trade {
  id: number
  stock_id: number
  strategy: string
  entry_price: number
  entry_time: string
  exit_price: number | null
  exit_time: string | null
  quantity: number
  pnl: number | null
  pnl_pct: number | null
  target_price: number
  stop_loss: number
  status: 'active' | 'closed' | 'sl_hit' | 'target_hit'
  stock?: Stock
}

export interface IntradaySignal {
  symbol: string
  strategy: string
  direction: string
  entry_price: number
  target_price: number
  stop_loss: number
  risk_reward: number
  confidence: number
  reason: string
  generated_at: string
}

export interface InvestmentSignal {
  symbol: string
  strategy: string
  horizon: string
  direction: string
  entry_price: number
  target_price: number
  stop_loss: number
  risk_reward: number
  confidence: number
  reason: string
}

export interface DashboardData {
  nse_recommendations: Recommendation[]
  us_recommendations: Recommendation[]
  active_trades: number
  generated_at: string
}

export interface StockDetailData {
  stock: Stock
  price_history: PriceBar[]
  indicators: TechnicalIndicator[]
  latest_indicator: TechnicalIndicator | null
  fundamental: Fundamental | null
  sr_levels: SRLevel[]
  recommendation: Recommendation | null
  recommendations_by_horizon: Record<string, Recommendation> | null
  recommendation_history: Recommendation[]
}

export interface ScalpSignal {
  symbol: string
  name: string
  timeframe: string
  direction: string
  strategy: string
  entry_price: number
  target_price: number
  stop_loss: number
  risk_reward: number
  confidence: number
  reason: string
  generated_at: string
}

export interface BacktestTrade {
  EntryDate: string
  ExitDate: string
  EntryPrice: number
  ExitPrice: number
  Quantity: number
  PnL: number
  PnLPct: number
  IsWin: boolean
}

export interface BacktestResult {
  strategy: string
  symbol: string
  total_trades: number
  win_rate: number
  profit_factor: number
  max_drawdown: number
  net_pnl: number
  net_pnl_pct: number
  sharpe_ratio: number
  avg_win: number
  avg_loss: number
  trades?: BacktestTrade[]
}
