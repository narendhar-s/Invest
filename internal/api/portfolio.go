package api

import (
	"net/http"

	"github.com/gin-gonic/gin"

	"stockwise/internal/portfolio"
	"stockwise/internal/storage"
)

// ─── Portfolio ────────────────────────────────────────────────────────────────

// GetPortfolio returns all portfolio holdings with live P&L and zone analysis.
func (h *Handler) GetPortfolio(c *gin.Context) {
	eng := portfolio.NewEngine(h.repo)
	data, err := eng.Compute()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, data)
}

// UpsertPortfolioHolding adds or updates a holding (buy / position update).
func (h *Handler) UpsertPortfolioHolding(c *gin.Context) {
	var req struct {
		Symbol      string  `json:"symbol" binding:"required"`
		YFSymbol    string  `json:"yf_symbol"`
		DisplayName string  `json:"display_name"`
		Market      string  `json:"market" binding:"required"`
		Sector      string  `json:"sector"`
		Currency    string  `json:"currency"`
		Quantity    float64 `json:"quantity" binding:"required"`
		AvgBuyPrice float64 `json:"avg_buy_price" binding:"required"`
		Notes       string  `json:"notes"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	holding := &storage.PortfolioHolding{
		Symbol:      req.Symbol,
		YFSymbol:    req.YFSymbol,
		DisplayName: req.DisplayName,
		Market:      req.Market,
		Sector:      req.Sector,
		Currency:    req.Currency,
		Quantity:    req.Quantity,
		AvgBuyPrice: req.AvgBuyPrice,
		Notes:       req.Notes,
	}
	if holding.Currency == "" {
		if req.Market == "NSE" {
			holding.Currency = "INR"
		} else {
			holding.Currency = "USD"
		}
	}
	if holding.YFSymbol == "" {
		holding.YFSymbol = req.Symbol
	}

	if err := h.repo.UpsertPortfolioHolding(holding); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"status": "ok", "symbol": req.Symbol})
}

// DeletePortfolioHolding removes a holding (full exit).
func (h *Handler) DeletePortfolioHolding(c *gin.Context) {
	symbol := c.Param("symbol")
	if symbol == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "symbol required"})
		return
	}
	if err := h.repo.DeletePortfolioHolding(symbol); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"status": "deleted", "symbol": symbol})
}

// BuyMore handles weighted average recalculation when buying more of an existing position.
func (h *Handler) BuyMore(c *gin.Context) {
	symbol := c.Param("symbol")
	var req struct {
		NewQty   float64 `json:"new_qty" binding:"required"`
		NewPrice float64 `json:"new_price" binding:"required"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	existing, err := h.repo.GetPortfolioHoldingBySymbol(symbol)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "holding not found"})
		return
	}

	// Weighted average: new_avg = (old_value + new_value) / total_qty
	totalQty := existing.Quantity + req.NewQty
	newAvg := (existing.Quantity*existing.AvgBuyPrice + req.NewQty*req.NewPrice) / totalQty

	existing.Quantity = totalQty
	existing.AvgBuyPrice = newAvg

	if err := h.repo.UpsertPortfolioHolding(existing); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"status":        "updated",
		"symbol":        symbol,
		"new_quantity":  totalQty,
		"new_avg_price": newAvg,
	})
}

// SellPartial handles partial sell — reduces quantity.
func (h *Handler) SellPartial(c *gin.Context) {
	symbol := c.Param("symbol")
	var req struct {
		SellQty   float64 `json:"sell_qty" binding:"required"`
		SellPrice float64 `json:"sell_price"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	existing, err := h.repo.GetPortfolioHoldingBySymbol(symbol)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "holding not found"})
		return
	}

	newQty := existing.Quantity - req.SellQty
	if newQty <= 0 {
		// Full exit
		if err := h.repo.DeletePortfolioHolding(symbol); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		realizedPnL := req.SellQty * (req.SellPrice - existing.AvgBuyPrice)
		c.JSON(http.StatusOK, gin.H{"status": "fully_exited", "realized_pnl": realizedPnL})
		return
	}

	existing.Quantity = newQty
	if err := h.repo.UpsertPortfolioHolding(existing); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	realizedPnL := req.SellQty * (req.SellPrice - existing.AvgBuyPrice)
	c.JSON(http.StatusOK, gin.H{
		"status":       "partially_sold",
		"symbol":       symbol,
		"new_quantity": newQty,
		"realized_pnl": realizedPnL,
	})
}

// PortfolioStockDetail returns the YF symbol for a portfolio holding so the frontend
// can redirect to the full stock detail page.
func (h *Handler) PortfolioStockDetail(c *gin.Context) {
	symbol := c.Param("symbol")
	holding, err := h.repo.GetPortfolioHoldingBySymbol(symbol)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "holding not found"})
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"holding":   holding,
		"yf_symbol": holding.YFSymbol,
	})
}
