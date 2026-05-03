package strategy

import (
	"fmt"
	"math"
	"sort"
	"time"

	"stockwise/internal/data"
	"stockwise/internal/storage"
	"stockwise/pkg/logger"

	"go.uber.org/zap"
)

// ScalpSignal represents a live intraday scalping signal.
type ScalpSignal struct {
	Symbol      string  `json:"symbol"`
	Name        string  `json:"name"`
	Timeframe   string  `json:"timeframe"` // 1m, 5m, 15m
	Direction   string  `json:"direction"` // BUY, SELL, NEUTRAL
	Strategy    string  `json:"strategy"`
	EntryPrice  float64 `json:"entry_price"`
	TargetPrice float64 `json:"target_price"`
	StopLoss    float64 `json:"stop_loss"`
	RiskReward  float64 `json:"risk_reward"`
	Confidence  float64 `json:"confidence"`
	Reason      string  `json:"reason"`
	GeneratedAt string  `json:"generated_at"`
}

// GetScalpingSignals fetches live intraday bars and generates scalping signals.
func (e *Engine) GetScalpingSignals(timeframe string) ([]ScalpSignal, error) {
	if timeframe == "" {
		timeframe = "5m"
	}

	// Target: NIFTY 50 stocks
	stocks, err := e.repo.GetStocksByMarket("NSE")
	if err != nil {
		return nil, err
	}

	yahoo := data.NewYahooClient()
	var signals []ScalpSignal

	for _, stock := range stocks {
		if stock.IsIndex {
			continue
		}
		bars, err := yahoo.FetchIntradayBars(stock.Symbol, timeframe)
		if err != nil || len(bars) < 30 {
			continue
		}

		srLevels, _ := e.repo.GetSRLevels(stock.ID)

		sigs := analyzeIntradayBars(stock, bars, srLevels, timeframe)
		signals = append(signals, sigs...)
	}

	// Sort by confidence descending
	sort.Slice(signals, func(i, j int) bool {
		return signals[i].Confidence > signals[j].Confidence
	})

	logger.Info("scalping signals generated",
		zap.String("timeframe", timeframe),
		zap.Int("signals", len(signals)))
	return signals, nil
}

// GetIndexScalpingSignals fetches live intraday signals for NIFTY/BANKNIFTY.
func (e *Engine) GetIndexScalpingSignals(timeframe string) ([]ScalpSignal, error) {
	if timeframe == "" {
		timeframe = "5m"
	}

	indexSymbols := map[string]string{
		"^NSEI":    "NIFTY 50",
		"^NSEBANK": "BANK NIFTY",
	}

	yahoo := data.NewYahooClient()
	var signals []ScalpSignal

	for sym, name := range indexSymbols {
		bars, err := yahoo.FetchIntradayBars(sym, timeframe)
		if err != nil || len(bars) < 30 {
			logger.Warn("scalping: no intraday data", zap.String("symbol", sym), zap.Error(err))
			continue
		}

		stock, err := e.repo.GetStockBySymbol(sym)
		if err != nil {
			stock = &storage.Stock{Symbol: sym, Name: name, Market: "NSE", IsIndex: true}
		}
		srLevels, _ := e.repo.GetSRLevels(stock.ID)

		sigs := analyzeIntradayBars(*stock, bars, srLevels, timeframe)
		for i := range sigs {
			sigs[i].Name = name
		}
		signals = append(signals, sigs...)
	}

	return signals, nil
}

func analyzeIntradayBars(stock storage.Stock, bars []data.ChartBar, srLevels []storage.SupportResistanceLevel, timeframe string) []ScalpSignal {
	if len(bars) < 30 {
		return nil
	}

	var signals []ScalpSignal
	n := len(bars)
	latest := bars[n-1]
	prev := bars[n-2]
	close := latest.Close

	// Use the last completed candle for direction checks.
	// bars[n-1] is the still-forming candle; bars[n-2] is the last closed candle.
	confirmed := prev // last fully closed candle
	confirmedGreen := confirmed.Close > confirmed.Open
	confirmedBodyPct := math.Abs(confirmed.Close-confirmed.Open) / confirmed.Open * 100

	// Compute intraday indicators
	rsi := computeRSI(bars, 14)
	sma20 := computeSMA(bars, 20)
	sma9 := computeSMA(bars, 9)
	ema9 := computeEMA(bars, 9)
	atr := computeATR(bars, 14)
	vwap := computeVWAP(bars)
	avgVol := avgVolume(bars, 20)
	latestVol := float64(latest.Volume)
	volSpike := latestVol > avgVol*1.5

	// Trend from SMA
	trend := "SIDEWAYS"
	if sma9 > sma20 && close > sma20 {
		trend = "UP"
	} else if sma9 < sma20 && close < sma20 {
		trend = "DOWN"
	}

	name := stock.Name
	if name == "" {
		name = stock.Symbol
	}

	now := time.Now().Format(time.RFC3339)

	// ── Strategy 1: VWAP + EMA Confluence ────────────────────────────────
	if vwap > 0 {
		vwapDist := (close - vwap) / vwap
		if vwapDist >= -0.003 && vwapDist <= 0.003 && (trend == "UP" || trend == "SIDEWAYS") && rsi > 40 && rsi < 65 {
			target := close + atr*2.0
			sl := vwap - atr*0.5
			rr := safeRR(close, target, sl)
			if rr >= 1.5 {
				signals = append(signals, ScalpSignal{
					Symbol:      stock.Symbol,
					Name:        name,
					Timeframe:   timeframe,
					Direction:   "BUY",
					Strategy:    "VWAP Bounce",
					EntryPrice:  r2(close),
					TargetPrice: r2(target),
					StopLoss:    r2(sl),
					RiskReward:  r2(rr),
					Confidence:  70,
					Reason:      fmt.Sprintf("Price at VWAP (%.2f) with uptrend. RSI %.0f healthy. EMA9 (%.2f) > SMA20 (%.2f). Volume %s. Entry near VWAP for low-risk long.", vwap, rsi, ema9, sma20, volLabel(volSpike)),
					GeneratedAt: now,
				})
			}
		}
		if vwapDist >= -0.003 && vwapDist <= 0.003 && trend == "DOWN" && rsi > 55 {
			target := close - atr*2.0
			sl := vwap + atr*0.5
			rr := safeRR(close, target, sl)
			if rr >= 1.5 {
				signals = append(signals, ScalpSignal{
					Symbol:      stock.Symbol,
					Name:        name,
					Timeframe:   timeframe,
					Direction:   "SELL",
					Strategy:    "VWAP Rejection",
					EntryPrice:  r2(close),
					TargetPrice: r2(target),
					StopLoss:    r2(sl),
					RiskReward:  r2(rr),
					Confidence:  65,
					Reason:      fmt.Sprintf("Price rejected at VWAP (%.2f) in downtrend. RSI %.0f elevated. Short opportunity with VWAP as resistance.", vwap, rsi),
					GeneratedAt: now,
				})
			}
		}
		// Downtrend SELL: RSI bouncing in 35-55 range near VWAP — "sell the bounce"
		// confirmedGreen = last closed candle was green (small bounce = ideal short entry near VWAP resistance)
		if vwapDist >= -0.005 && vwapDist <= 0.002 && trend == "DOWN" && rsi > 35 && rsi < 55 && confirmedGreen {
			target := close - atr*2.0
			sl := vwap + atr*0.3
			rr := safeRR(close, target, sl)
			if rr >= 1.5 {
				signals = append(signals, ScalpSignal{
					Symbol:      stock.Symbol,
					Name:        name,
					Timeframe:   timeframe,
					Direction:   "SELL",
					Strategy:    "Downtrend Bounce SELL",
					EntryPrice:  r2(close),
					TargetPrice: r2(target),
					StopLoss:    r2(sl),
					RiskReward:  r2(rr),
					Confidence:  63,
					Reason:      fmt.Sprintf("Downtrend intact. RSI %.0f bouncing near VWAP (%.2f) — sell-the-bounce setup. Price below VWAP acts as resistance.", rsi, vwap),
					GeneratedAt: now,
				})
			}
		}
	}

	// ── Strategy 1b: EMA9 Pullback BUY ───────────────────────────────────
	// Uptrend with small candle (red or tiny green) near EMA9 — buy the dip
	if trend == "UP" && rsi > 40 && rsi < 68 {
		emaDist := (close - ema9) / ema9
		if emaDist >= -0.005 && emaDist <= 0.005 && confirmedBodyPct < 0.5 {
			target := close + atr*2.0
			sl := math.Min(latest.Low, prev.Low) - atr*0.2
			rr := safeRR(close, target, sl)
			if rr >= 1.5 {
				signals = append(signals, ScalpSignal{
					Symbol:      stock.Symbol,
					Name:        name,
					Timeframe:   timeframe,
					Direction:   "BUY",
					Strategy:    "EMA9 Pullback",
					EntryPrice:  r2(close),
					TargetPrice: r2(target),
					StopLoss:    r2(sl),
					RiskReward:  r2(rr),
					Confidence:  67,
					Reason:      fmt.Sprintf("Uptrend intact. Small pullback (%.2f%% body) to EMA9 (%.2f). RSI %.0f healthy — buy the dip in trend.", confirmedBodyPct, ema9, rsi),
					GeneratedAt: now,
				})
			}
		}
	}

	// ── Strategy 1c: VWAP Extended SELL ──────────────────────────────────
	// Price far above VWAP (>0.7%) with elevated RSI — mean reversion short
	// Fires on both green (sell into momentum) and red candles
	if vwap > 0 {
		vwapDistExtended := (close - vwap) / vwap
		if vwapDistExtended > 0.007 && rsi > 55 {
			target := vwap + (close-vwap)*0.3 // partial reversion toward VWAP
			sl := latest.High + atr*0.3
			rr := safeRR(close, target, sl)
			if rr >= 1.5 {
				candleLabel := "bearish candle"
				if confirmedGreen {
					candleLabel = "selling into green momentum candle"
				}
				signals = append(signals, ScalpSignal{
					Symbol:      stock.Symbol,
					Name:        name,
					Timeframe:   timeframe,
					Direction:   "SELL",
					Strategy:    "VWAP Extended SELL",
					EntryPrice:  r2(close),
					TargetPrice: r2(target),
					StopLoss:    r2(sl),
					RiskReward:  r2(rr),
					Confidence:  64,
					Reason:      fmt.Sprintf("Price %.2f%% extended above VWAP (%.2f). RSI %.0f elevated — %s. Mean reversion expected.", vwapDistExtended*100, vwap, rsi, candleLabel),
					GeneratedAt: now,
				})
			}
		}
	}

	// ── Strategy 2: EMA Crossover + Volume ────────────────────────────────
	prevEma9 := computeEMAAtBar(bars[:n-1], 9)
	prevSma20 := computeSMAAtBar(bars[:n-1], 20)
	if prevEma9 <= prevSma20 && ema9 > sma20 && volSpike && rsi > 45 && rsi < 70 {
		target := close + atr*2.5
		sl := math.Min(latest.Low, prev.Low) - atr*0.3
		rr := safeRR(close, target, sl)
		if rr >= 1.8 {
			signals = append(signals, ScalpSignal{
				Symbol:      stock.Symbol,
				Name:        name,
				Timeframe:   timeframe,
				Direction:   "BUY",
				Strategy:    "EMA Crossover",
				EntryPrice:  r2(close),
				TargetPrice: r2(target),
				StopLoss:    r2(sl),
				RiskReward:  r2(rr),
				Confidence:  75,
				Reason:      fmt.Sprintf("Bullish EMA9/SMA20 crossover confirmed with %.0f%% volume spike. RSI %.0f supports momentum. Fresh trend reversal.", (latestVol/avgVol-1)*100, rsi),
				GeneratedAt: now,
			})
		}
	}
	if prevEma9 >= prevSma20 && ema9 < sma20 && volSpike && rsi > 35 {
		target := close - atr*2.5
		sl := math.Max(latest.High, prev.High) + atr*0.3
		rr := safeRR(close, target, sl)
		if rr >= 1.8 {
			signals = append(signals, ScalpSignal{
				Symbol:      stock.Symbol,
				Name:        name,
				Timeframe:   timeframe,
				Direction:   "SELL",
				Strategy:    "EMA Crossover",
				EntryPrice:  r2(close),
				TargetPrice: r2(target),
				StopLoss:    r2(sl),
				RiskReward:  r2(rr),
				Confidence:  72,
				Reason:      fmt.Sprintf("Bearish EMA9/SMA20 crossover with volume spike. RSI %.0f dropping. Trend reversal to downside.", rsi),
				GeneratedAt: now,
			})
		}
	}

	// ── Strategy 3: RSI Reversal ──────────────────────────────────────────
	prevRSI := computeRSIAtBar(bars[:n-1], 14)
	// Fire on any bar where RSI is oversold AND last closed candle is green
	if rsi < 30 && confirmedGreen {
		target := close + atr*2.0
		sl := latest.Low - atr*0.3
		rr := safeRR(close, target, sl)
		if rr >= 1.5 {
			label := "RSI Oversold Bounce"
			if prevRSI >= 30 {
				label = "RSI Oversold Entry"
			}
			signals = append(signals, ScalpSignal{
				Symbol:      stock.Symbol,
				Name:        name,
				Timeframe:   timeframe,
				Direction:   "BUY",
				Strategy:    label,
				EntryPrice:  r2(close),
				TargetPrice: r2(target),
				StopLoss:    r2(sl),
				RiskReward:  r2(rr),
				Confidence:  68,
				Reason:      fmt.Sprintf("RSI at %.0f (oversold zone) with bullish closed candle. Mean reversion expected. Target: VWAP/SMA20 area.", rsi),
				GeneratedAt: now,
			})
		}
	}
	// Extreme oversold exhaustion — fires when RSI < 25 even on small red candles
	// (small body = selling exhaustion, not strong continuation)
	if rsi < 25 && trend != "UP" && (confirmedGreen || confirmedBodyPct < 0.3) {
		target := close + atr*2.5
		sl := latest.Low - atr*0.5
		rr := safeRR(close, target, sl)
		if rr >= 1.5 {
			signals = append(signals, ScalpSignal{
				Symbol:      stock.Symbol,
				Name:        name,
				Timeframe:   timeframe,
				Direction:   "BUY",
				Strategy:    "Extreme Oversold Recovery",
				EntryPrice:  r2(close),
				TargetPrice: r2(target),
				StopLoss:    r2(sl),
				RiskReward:  r2(rr),
				Confidence:  72,
				Reason:      fmt.Sprintf("RSI at extreme oversold %.0f. Selling exhaustion detected (small body %.1f%%). Sharp mean-reversion bounce expected.", rsi, confirmedBodyPct),
				GeneratedAt: now,
			})
		}
	}
	// Fire on bearish closed candle OR extreme RSI (>78) regardless of candle color
	if rsi > 70 && (!confirmedGreen || rsi > 78) {
		target := close - atr*2.0
		sl := latest.High + atr*0.3
		rr := safeRR(close, target, sl)
		if rr >= 1.5 {
			label := "RSI Overbought Reversal"
			if prevRSI <= 70 {
				label = "RSI Overbought Entry"
			}
			reason := fmt.Sprintf("RSI at %.0f (overbought zone) with bearish closed candle. Expect pullback to VWAP/SMA area.", rsi)
			if confirmedGreen && rsi > 78 {
				reason = fmt.Sprintf("RSI at extreme %.0f — selling into green momentum candle. Reversal likely from extreme overbought.", rsi)
			}
			signals = append(signals, ScalpSignal{
				Symbol:      stock.Symbol,
				Name:        name,
				Timeframe:   timeframe,
				Direction:   "SELL",
				Strategy:    label,
				EntryPrice:  r2(close),
				TargetPrice: r2(target),
				StopLoss:    r2(sl),
				RiskReward:  r2(rr),
				Confidence:  68,
				Reason:      reason,
				GeneratedAt: now,
			})
		}
	}
	// Near-oversold BUY: RSI 30-38 in downtrend with green closed candle — early bounce entry
	if rsi >= 30 && rsi < 38 && trend == "DOWN" && confirmedGreen {
		target := close + atr*1.5
		sl := latest.Low - atr*0.3
		rr := safeRR(close, target, sl)
		if rr >= 1.5 {
			signals = append(signals, ScalpSignal{
				Symbol:      stock.Symbol,
				Name:        name,
				Timeframe:   timeframe,
				Direction:   "BUY",
				Strategy:    "Near Oversold Bounce",
				EntryPrice:  r2(close),
				TargetPrice: r2(target),
				StopLoss:    r2(sl),
				RiskReward:  r2(rr),
				Confidence:  60,
				Reason:      fmt.Sprintf("RSI at %.0f approaching oversold in downtrend. Green closed candle signals early bounce. Quick scalp to EMA9.", rsi),
				GeneratedAt: now,
			})
		}
	}
	_ = prevRSI

	// ── Strategy 4: Support/Resistance Breakout ───────────────────────────
	for _, level := range srLevels {
		if !level.IsActive {
			continue
		}
		dist := (close - level.Price) / level.Price

		if level.LevelType == "resistance" && dist > 0 && dist < 0.005 && volSpike && rsi > 50 && rsi < 75 {
			target := level.Price + atr*3.0
			sl := level.Price - atr*0.5
			rr := safeRR(close, target, sl)
			if rr >= 2.0 {
				signals = append(signals, ScalpSignal{
					Symbol:      stock.Symbol,
					Name:        name,
					Timeframe:   timeframe,
					Direction:   "BUY",
					Strategy:    "Resistance Breakout",
					EntryPrice:  r2(close),
					TargetPrice: r2(target),
					StopLoss:    r2(sl),
					RiskReward:  r2(rr),
					Confidence:  74,
					Reason:      fmt.Sprintf("Breakout above resistance %.2f with volume surge (%.0f%% above avg). RSI %.0f supports momentum. Converted resistance to support.", level.Price, (latestVol/avgVol-1)*100, rsi),
					GeneratedAt: now,
				})
				break
			}
		}

		if level.LevelType == "support" && dist < 0 && dist > -0.005 && volSpike && rsi < 45 {
			target := level.Price - atr*3.0
			sl := level.Price + atr*0.5
			rr := safeRR(close, target, sl)
			if rr >= 2.0 {
				signals = append(signals, ScalpSignal{
					Symbol:      stock.Symbol,
					Name:        name,
					Timeframe:   timeframe,
					Direction:   "SELL",
					Strategy:    "Support Breakdown",
					EntryPrice:  r2(close),
					TargetPrice: r2(target),
					StopLoss:    r2(sl),
					RiskReward:  r2(rr),
					Confidence:  70,
					Reason:      fmt.Sprintf("Breakdown below support %.2f with heavy volume. RSI %.0f weak. Panic selling likely.", level.Price, rsi),
					GeneratedAt: now,
				})
				break
			}
		}
	}

	// ── Strategy 5: Momentum Candle ───────────────────────────────────────
	// Use last closed candle for momentum check
	if confirmedBodyPct > 0.5 && volSpike {
		if confirmedGreen && rsi > 50 && rsi < 75 && trend != "DOWN" {
			target := close + atr*1.5
			sl := latest.Low - atr*0.2
			rr := safeRR(close, target, sl)
			if rr >= 1.5 {
				signals = append(signals, ScalpSignal{
					Symbol:      stock.Symbol,
					Name:        name,
					Timeframe:   timeframe,
					Direction:   "BUY",
					Strategy:    "Momentum Candle",
					EntryPrice:  r2(close),
					TargetPrice: r2(target),
					StopLoss:    r2(sl),
					RiskReward:  r2(rr),
					Confidence:  62,
					Reason:      fmt.Sprintf("Strong bullish candle (%.1f%% body) with %.0fx avg volume. Institutional buying momentum. Quick scalp opportunity.", confirmedBodyPct, latestVol/avgVol),
					GeneratedAt: now,
				})
			}
		}
	}

	return signals
}

// ── Intraday indicator helpers ────────────────────────────────────────────────

func computeRSI(bars []data.ChartBar, period int) float64 {
	return computeRSIAtBar(bars, period)
}

func computeRSIAtBar(bars []data.ChartBar, period int) float64 {
	if len(bars) < period+1 {
		return 50
	}
	gains, losses := 0.0, 0.0
	for i := len(bars) - period; i < len(bars); i++ {
		change := bars[i].Close - bars[i-1].Close
		if change > 0 {
			gains += change
		} else {
			losses -= change
		}
	}
	if losses == 0 {
		return 100
	}
	rs := (gains / float64(period)) / (losses / float64(period))
	return 100 - 100/(1+rs)
}

func computeSMA(bars []data.ChartBar, period int) float64 {
	return computeSMAAtBar(bars, period)
}

func computeSMAAtBar(bars []data.ChartBar, period int) float64 {
	if len(bars) < period {
		return 0
	}
	sum := 0.0
	for i := len(bars) - period; i < len(bars); i++ {
		sum += bars[i].Close
	}
	return sum / float64(period)
}

func computeEMA(bars []data.ChartBar, period int) float64 {
	return computeEMAAtBar(bars, period)
}

func computeEMAAtBar(bars []data.ChartBar, period int) float64 {
	if len(bars) < period {
		return 0
	}
	multiplier := 2.0 / float64(period+1)
	ema := bars[0].Close
	for i := 1; i < len(bars); i++ {
		ema = (bars[i].Close-ema)*multiplier + ema
	}
	return ema
}

func computeATR(bars []data.ChartBar, period int) float64 {
	if len(bars) < period+1 {
		r := bars[len(bars)-1].High - bars[len(bars)-1].Low
		if r < bars[len(bars)-1].Close*0.003 {
			r = bars[len(bars)-1].Close * 0.003
		}
		return r
	}
	sum := 0.0
	for i := len(bars) - period; i < len(bars); i++ {
		tr := bars[i].High - bars[i].Low
		if i > 0 {
			tr = math.Max(tr, math.Abs(bars[i].High-bars[i-1].Close))
			tr = math.Max(tr, math.Abs(bars[i].Low-bars[i-1].Close))
		}
		sum += tr
	}
	return sum / float64(period)
}

func computeVWAP(bars []data.ChartBar) float64 {
	// Use last trading session bars only
	if len(bars) == 0 {
		return 0
	}
	// Find last session start (when date changes)
	sessionStart := 0
	lastDate := bars[len(bars)-1].Time.Truncate(24 * time.Hour)
	for i := len(bars) - 1; i >= 0; i-- {
		if bars[i].Time.Truncate(24*time.Hour) != lastDate {
			sessionStart = i + 1
			break
		}
	}
	if sessionStart >= len(bars) {
		sessionStart = 0
	}

	cumVol := 0.0
	cumTP := 0.0
	for i := sessionStart; i < len(bars); i++ {
		tp := (bars[i].High + bars[i].Low + bars[i].Close) / 3
		vol := float64(bars[i].Volume)
		cumTP += tp * vol
		cumVol += vol
	}
	if cumVol > 0 {
		return cumTP / cumVol
	}

	// Fallback for indices (no volume): use session typical-price average
	sessionBars := bars[sessionStart:]
	if len(sessionBars) == 0 {
		return 0
	}
	sum := 0.0
	for _, b := range sessionBars {
		sum += (b.High + b.Low + b.Close) / 3
	}
	return sum / float64(len(sessionBars))
}

func avgVolume(bars []data.ChartBar, period int) float64 {
	if len(bars) < period {
		period = len(bars)
	}
	sum := 0.0
	for i := len(bars) - period; i < len(bars); i++ {
		sum += float64(bars[i].Volume)
	}
	if period == 0 {
		return 1
	}
	avg := sum / float64(period)
	if avg == 0 {
		return 1
	}
	return avg
}

func safeRR(entry, target, sl float64) float64 {
	risk := math.Abs(entry - sl)
	if risk == 0 {
		return 0
	}
	return math.Abs(target-entry) / risk
}

func r2(v float64) float64 {
	return math.Round(v*100) / 100
}

func volLabel(spike bool) string {
	if spike {
		return "elevated (volume spike)"
	}
	return "normal"
}
