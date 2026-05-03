package technical

import (
	"math"
	"sort"

	"stockwise/internal/storage"
)

// SRAnalyzer identifies support and resistance levels from price history.
type SRAnalyzer struct{}

func NewSRAnalyzer() *SRAnalyzer {
	return &SRAnalyzer{}
}

// Identify finds all significant S/R levels from the price bar series.
func (sr *SRAnalyzer) Identify(stockID uint, bars []storage.PriceBar) []storage.SupportResistanceLevel {
	if len(bars) < 20 {
		return nil
	}

	var levels []storage.SupportResistanceLevel

	// Method 1: Pivot Points (using last 20 daily bars as reference)
	pivotLevels := sr.computePivotLevels(stockID, bars)
	levels = append(levels, pivotLevels...)

	// Method 2: Historical price clustering
	clusterLevels := sr.computeClusterLevels(stockID, bars)
	levels = append(levels, clusterLevels...)

	// Method 3: Volume-weighted significant levels
	volumeLevels := sr.computeVolumeWeightedLevels(stockID, bars)
	levels = append(levels, volumeLevels...)

	// Deduplicate levels that are within 0.5% of each other
	levels = sr.deduplicate(levels, 0.005)

	// Classify each level as support or resistance based on current price
	if len(bars) > 0 {
		currentPrice := bars[len(bars)-1].Close
		for i := range levels {
			levels[i] = sr.classify(levels[i], currentPrice, bars)
		}
	}

	return levels
}

// computePivotLevels computes standard pivot point levels.
func (sr *SRAnalyzer) computePivotLevels(stockID uint, bars []storage.PriceBar) []storage.SupportResistanceLevel {
	// Use last week's OHLC
	n := len(bars)
	if n < 5 {
		return nil
	}

	// Weekly pivot: last 5 bars
	weekSlice := bars[n-5:]
	high, low, closePrice := 0.0, math.MaxFloat64, 0.0
	for _, b := range weekSlice {
		if b.High > high {
			high = b.High
		}
		if b.Low < low {
			low = b.Low
		}
		closePrice = b.Close
	}

	pp := (high + low + closePrice) / 3

	r1 := 2*pp - low
	r2 := pp + (high - low)
	r3 := high + 2*(pp-low)

	s1 := 2*pp - high
	s2 := pp - (high - low)
	s3 := low - 2*(high-pp)

	levels := []storage.SupportResistanceLevel{
		{StockID: stockID, Price: pp, LevelType: "pivot", Strength: 70, Timeframe: "weekly", Touches: 1},
		{StockID: stockID, Price: r1, LevelType: "resistance", Strength: 60, Timeframe: "weekly", Touches: 1},
		{StockID: stockID, Price: r2, LevelType: "resistance", Strength: 55, Timeframe: "weekly", Touches: 1},
		{StockID: stockID, Price: r3, LevelType: "resistance", Strength: 45, Timeframe: "weekly", Touches: 1},
		{StockID: stockID, Price: s1, LevelType: "support", Strength: 60, Timeframe: "weekly", Touches: 1},
		{StockID: stockID, Price: s2, LevelType: "support", Strength: 55, Timeframe: "weekly", Touches: 1},
		{StockID: stockID, Price: s3, LevelType: "support", Strength: 45, Timeframe: "weekly", Touches: 1},
	}

	return levels
}

// computeClusterLevels finds price levels where reversals frequently occur.
func (sr *SRAnalyzer) computeClusterLevels(stockID uint, bars []storage.PriceBar) []storage.SupportResistanceLevel {
	if len(bars) < 20 {
		return nil
	}

	// Find local highs and lows (pivot points in the price series)
	pivotHighs := sr.findPivotHighs(bars, 5)
	pivotLows := sr.findPivotLows(bars, 5)

	allPivots := append(pivotHighs, pivotLows...)

	// Cluster nearby price levels
	clusters := sr.clusterPrices(allPivots, 0.01) // 1% tolerance

	var levels []storage.SupportResistanceLevel
	for price, count := range clusters {
		if count < 2 {
			continue // Require at least 2 touches for validity
		}
		strength := math.Min(float64(count)*20, 100)
		levels = append(levels, storage.SupportResistanceLevel{
			StockID:   stockID,
			Price:     price,
			LevelType: "cluster",
			Strength:  strength,
			Timeframe: "daily",
			Touches:   count,
			IsActive:  true,
		})
	}

	return levels
}

// computeVolumeWeightedLevels finds high-volume price areas (HVN = high volume nodes).
func (sr *SRAnalyzer) computeVolumeWeightedLevels(stockID uint, bars []storage.PriceBar) []storage.SupportResistanceLevel {
	if len(bars) < 20 {
		return nil
	}

	// Create a volume profile: bucket prices into 50 levels
	minPrice, maxPrice := math.MaxFloat64, 0.0
	for _, b := range bars {
		if b.Low < minPrice {
			minPrice = b.Low
		}
		if b.High > maxPrice {
			maxPrice = b.High
		}
	}

	if maxPrice <= minPrice {
		return nil
	}

	buckets := 50
	bucketSize := (maxPrice - minPrice) / float64(buckets)
	volumeProfile := make([]int64, buckets)
	priceAtBucket := make([]float64, buckets)

	for i := range priceAtBucket {
		priceAtBucket[i] = minPrice + float64(i)*bucketSize + bucketSize/2
	}

	for _, b := range bars {
		typPrice := (b.High + b.Low + b.Close) / 3
		idx := int((typPrice - minPrice) / bucketSize)
		if idx >= buckets {
			idx = buckets - 1
		}
		if idx < 0 {
			idx = 0
		}
		volumeProfile[idx] += b.Volume
	}

	// Find high-volume nodes (HVN) and low-volume nodes (LVN)
	avgVolume := int64(0)
	for _, v := range volumeProfile {
		avgVolume += v
	}
	avgVolume /= int64(buckets)

	var levels []storage.SupportResistanceLevel
	for i, vol := range volumeProfile {
		if vol > avgVolume*2 { // High Volume Node = potential support/resistance
			levels = append(levels, storage.SupportResistanceLevel{
				StockID:   stockID,
				Price:     priceAtBucket[i],
				LevelType: "accumulation",
				Strength:  math.Min(float64(vol)/float64(avgVolume)*30, 100),
				Timeframe: "daily",
				Touches:   int(vol / avgVolume),
				IsActive:  true,
			})
		}
	}

	return levels
}

// findPivotHighs finds local maxima in the price series.
func (sr *SRAnalyzer) findPivotHighs(bars []storage.PriceBar, lookback int) []float64 {
	var pivots []float64
	for i := lookback; i < len(bars)-lookback; i++ {
		isPivot := true
		for j := i - lookback; j <= i+lookback; j++ {
			if j != i && bars[j].High >= bars[i].High {
				isPivot = false
				break
			}
		}
		if isPivot {
			pivots = append(pivots, bars[i].High)
		}
	}
	return pivots
}

// findPivotLows finds local minima in the price series.
func (sr *SRAnalyzer) findPivotLows(bars []storage.PriceBar, lookback int) []float64 {
	var pivots []float64
	for i := lookback; i < len(bars)-lookback; i++ {
		isPivot := true
		for j := i - lookback; j <= i+lookback; j++ {
			if j != i && bars[j].Low <= bars[i].Low {
				isPivot = false
				break
			}
		}
		if isPivot {
			pivots = append(pivots, bars[i].Low)
		}
	}
	return pivots
}

// clusterPrices groups nearby prices and returns (representative price → count).
func (sr *SRAnalyzer) clusterPrices(prices []float64, tolerance float64) map[float64]int {
	sort.Float64s(prices)
	clusters := make(map[float64]int)

	for _, p := range prices {
		merged := false
		for centroid := range clusters {
			if math.Abs(p-centroid)/centroid < tolerance {
				// Merge into existing cluster with weighted average
				n := float64(clusters[centroid])
				newCentroid := (centroid*n + p) / (n + 1)
				count := clusters[centroid] + 1
				delete(clusters, centroid)
				clusters[newCentroid] = count
				merged = true
				break
			}
		}
		if !merged {
			clusters[p] = 1
		}
	}
	return clusters
}

// classify determines if a level is support, resistance, or breakout zone.
func (sr *SRAnalyzer) classify(level storage.SupportResistanceLevel, currentPrice float64, bars []storage.PriceBar) storage.SupportResistanceLevel {
	if level.LevelType == "accumulation" || level.LevelType == "pivot" {
		return level
	}

	priceDiff := (currentPrice - level.Price) / currentPrice

	if priceDiff > 0.02 { // price is well above → it's support
		level.LevelType = "support"
	} else if priceDiff < -0.02 { // price is well below → it's resistance
		level.LevelType = "resistance"
	} else { // price is near the level → breakout zone
		level.LevelType = "breakout"
		level.Strength = math.Min(level.Strength+10, 100) // bonus strength for near-level
	}

	// Check if it's a supply zone (high volume at level + price declined after)
	for i := 1; i < len(bars)-1; i++ {
		barPrice := (bars[i].High + bars[i].Low) / 2
		if math.Abs(barPrice-level.Price)/level.Price < 0.01 {
			if bars[i].Volume > 0 && i+3 < len(bars) {
				if bars[i+3].Close < bars[i].Close {
					level.LevelType = "supply"
				}
			}
		}
	}

	level.IsActive = true
	return level
}

// deduplicate removes levels that are within pctThreshold of each other.
func (sr *SRAnalyzer) deduplicate(levels []storage.SupportResistanceLevel, pctThreshold float64) []storage.SupportResistanceLevel {
	if len(levels) == 0 {
		return levels
	}

	sort.Slice(levels, func(i, j int) bool {
		return levels[i].Price < levels[j].Price
	})

	result := []storage.SupportResistanceLevel{levels[0]}
	for i := 1; i < len(levels); i++ {
		last := result[len(result)-1]
		if math.Abs(levels[i].Price-last.Price)/last.Price < pctThreshold {
			// Keep the one with higher strength
			if levels[i].Strength > last.Strength {
				result[len(result)-1] = levels[i]
			}
		} else {
			result = append(result, levels[i])
		}
	}
	return result
}
