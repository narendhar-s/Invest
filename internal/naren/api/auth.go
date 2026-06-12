package api

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
)

func (h *Handler) UnlockPortfolio(c *gin.Context) {
	var req struct {
		Password string `json:"password"`
	}
	if err := c.ShouldBindJSON(&req); err != nil || req.Password == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "password required"})
		return
	}
	if h.cfg.Auth.PortfolioPassword == "" || req.Password != h.cfg.Auth.PortfolioPassword {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "incorrect password"})
		return
	}
	expiry := time.Now().Add(24 * time.Hour).Unix()
	c.JSON(http.StatusOK, gin.H{"token": makeToken(h.cfg.Auth.JWTSecret, expiry)})
}

func (h *Handler) PortfolioAuthMiddleware() gin.HandlerFunc {
	return func(c *gin.Context) {
		// If no password is configured, allow everything (dev mode)
		if h.cfg.Auth.PortfolioPassword == "" {
			c.Next()
			return
		}
		token := strings.TrimPrefix(c.GetHeader("Authorization"), "Bearer ")
		if !validToken(h.cfg.Auth.JWTSecret, token) {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "unauthorized"})
			return
		}
		c.Next()
	}
}

func makeToken(secret string, expiry int64) string {
	payload := strconv.FormatInt(expiry, 16)
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(payload))
	return payload + "." + hex.EncodeToString(mac.Sum(nil))
}

func validToken(secret, token string) bool {
	parts := strings.SplitN(token, ".", 2)
	if len(parts) != 2 {
		return false
	}
	expiry, err := strconv.ParseInt(parts[0], 16, 64)
	if err != nil || time.Now().Unix() > expiry {
		return false
	}
	expected := makeToken(secret, expiry)
	expectedParts := strings.SplitN(expected, ".", 2)
	return hmac.Equal([]byte(parts[1]), []byte(expectedParts[1]))
}
