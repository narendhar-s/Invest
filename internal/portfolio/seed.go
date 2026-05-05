package portfolio

import "stockwise/internal/storage"

// DefaultHoldings is the user's actual portfolio seeded on startup.
// Update quantities/avg prices here as the portfolio changes.
var DefaultHoldings = []storage.PortfolioHolding{
	// ── India (NSE) ──────────────────────────────────────────────────────────
	{Symbol: "CIPLA", YFSymbol: "CIPLA.NS", DisplayName: "Cipla Ltd", Market: "NSE", Sector: "Healthcare", Currency: "INR", Quantity: 17, AvgBuyPrice: 1412.91},
	{Symbol: "DRREDDY", YFSymbol: "DRREDDY.NS", DisplayName: "Dr. Reddy's Laboratories", Market: "NSE", Sector: "Healthcare", Currency: "INR", Quantity: 117, AvgBuyPrice: 1289.96},
	{Symbol: "EXIDEIND", YFSymbol: "EXIDEIND.NS", DisplayName: "Exide Industries", Market: "NSE", Sector: "Auto Ancillary", Currency: "INR", Quantity: 152, AvgBuyPrice: 304.84},
	{Symbol: "HDFCBANK", YFSymbol: "HDFCBANK.NS", DisplayName: "HDFC Bank", Market: "NSE", Sector: "Financial Services", Currency: "INR", Quantity: 1, AvgBuyPrice: 947.05},
	{Symbol: "IDFCFIRSTB", YFSymbol: "IDFCFIRSTB.NS", DisplayName: "IDFC First Bank", Market: "NSE", Sector: "Financial Services", Currency: "INR", Quantity: 1403, AvgBuyPrice: 68.14},
	{Symbol: "INDUSINDBK", YFSymbol: "INDUSINDBK.NS", DisplayName: "IndusInd Bank", Market: "NSE", Sector: "Financial Services", Currency: "INR", Quantity: 25, AvgBuyPrice: 814.49},
	{Symbol: "INFY", YFSymbol: "INFY.NS", DisplayName: "Infosys Ltd", Market: "NSE", Sector: "Technology", Currency: "INR", Quantity: 9, AvgBuyPrice: 1363.69},
	{Symbol: "ITBEES", YFSymbol: "ITBEES.NS", DisplayName: "Nippon India ETF IT", Market: "NSE", Sector: "Technology ETF", Currency: "INR", Quantity: 8, AvgBuyPrice: 47.81},
	{Symbol: "ITC", YFSymbol: "ITC.NS", DisplayName: "ITC Ltd", Market: "NSE", Sector: "Consumer Staples", Currency: "INR", Quantity: 481, AvgBuyPrice: 358.61},
	{Symbol: "ITCHOTELS", YFSymbol: "ITCHOTELS.NS", DisplayName: "ITC Hotels Ltd", Market: "NSE", Sector: "Hospitality", Currency: "INR", Quantity: 40, AvgBuyPrice: 480.41},
	{Symbol: "JIOFIN", YFSymbol: "JIOFIN.NS", DisplayName: "Jio Financial Services", Market: "NSE", Sector: "Financial Services", Currency: "INR", Quantity: 89, AvgBuyPrice: 284.82},
	{Symbol: "KTKBANK", YFSymbol: "KTKBANK.NS", DisplayName: "Karnataka Bank", Market: "NSE", Sector: "Financial Services", Currency: "INR", Quantity: 1325, AvgBuyPrice: 213.76},
	{Symbol: "MANAPPURAM", YFSymbol: "MANAPPURAM.NS", DisplayName: "Manappuram Finance", Market: "NSE", Sector: "Financial Services", Currency: "INR", Quantity: 1230, AvgBuyPrice: 171.14},
	{Symbol: "NATCOPHARM", YFSymbol: "NATCOPHARM.NS", DisplayName: "Natco Pharma", Market: "NSE", Sector: "Healthcare", Currency: "INR", Quantity: 250, AvgBuyPrice: 957.00},
	{Symbol: "SAIL", YFSymbol: "SAIL.NS", DisplayName: "Steel Authority of India", Market: "NSE", Sector: "Metals & Mining", Currency: "INR", Quantity: 511, AvgBuyPrice: 113.67},
	{Symbol: "SOUTHBANK", YFSymbol: "SOUTHBANK.NS", DisplayName: "South Indian Bank", Market: "NSE", Sector: "Financial Services", Currency: "INR", Quantity: 2783, AvgBuyPrice: 26.37},
	{Symbol: "TATACHEM", YFSymbol: "TATACHEM.NS", DisplayName: "Tata Chemicals", Market: "NSE", Sector: "Chemicals", Currency: "INR", Quantity: 50, AvgBuyPrice: 937.40},
	{Symbol: "TATAPOWER", YFSymbol: "TATAPOWER.NS", DisplayName: "Tata Power Company", Market: "NSE", Sector: "Utilities", Currency: "INR", Quantity: 352, AvgBuyPrice: 265.54},
	{Symbol: "TCS_PORT", YFSymbol: "TCS.NS", DisplayName: "Tata Consultancy Services", Market: "NSE", Sector: "Technology", Currency: "INR", Quantity: 2, AvgBuyPrice: 2726.65},
	{Symbol: "TMCV", YFSymbol: "TMCV.NS", DisplayName: "Tata Motors CV", Market: "NSE", Sector: "Automotive", Currency: "INR", Quantity: 259, AvgBuyPrice: 280.78},
	{Symbol: "TMPV", YFSymbol: "TMPV.NS", DisplayName: "Tata Motors PV", Market: "NSE", Sector: "Automotive", Currency: "INR", Quantity: 255, AvgBuyPrice: 489.62},
	{Symbol: "WIPRO_PORT", YFSymbol: "WIPRO.NS", DisplayName: "Wipro Ltd", Market: "NSE", Sector: "Technology", Currency: "INR", Quantity: 46, AvgBuyPrice: 209.79},
	{Symbol: "ZYDUSLIFE", YFSymbol: "ZYDUSLIFE.NS", DisplayName: "Zydus Lifesciences", Market: "NSE", Sector: "Healthcare", Currency: "INR", Quantity: 18, AvgBuyPrice: 900.01},
	{Symbol: "ICICI_NIFTY_NEXT50", YFSymbol: "ICICINXT50.NS", DisplayName: "ICICI Pru Nifty Next 50 ETF", Market: "NSE", Sector: "Index Fund", Currency: "INR", Quantity: 1904.636, AvgBuyPrice: 63.53},

	// ── Index Funds & ETFs (NSE) ─────────────────────────────────────────────
	// ICICI Nifty Next 50 ETF — already above as ICICI_NIFTY_NEXT50

	// Parag Parikh Flexi Cap Fund — Direct Plan (NAV-based mutual fund, no live price feed)
	// Tracked as PPFAS.BO on Yahoo Finance (BSE listed; may have limited data)
	{Symbol: "PPFCF", YFSymbol: "0P0000XVDK.BO", DisplayName: "Parag Parikh Flexi Cap Fund (Direct)", Market: "NSE", Sector: "Flexi Cap Fund", Currency: "INR", Quantity: 100, AvgBuyPrice: 80.00, Notes: "Mutual Fund — NAV updates daily. Long-term 5-10yr horizon. Diversified equity + foreign equity (Google, Microsoft, Amazon). Review quarterly."},

	// ── US ──────────────────────────────────────────────────────────────────
	{Symbol: "QQQ", YFSymbol: "QQQ", DisplayName: "Invesco QQQ Trust (NASDAQ ETF)", Market: "US", Sector: "Tech ETF", Currency: "USD", Quantity: 0.794268499, AvgBuyPrice: 615.47},
	{Symbol: "NOVO_NORDISK", YFSymbol: "NVO", DisplayName: "Novo Nordisk A/S", Market: "US", Sector: "Healthcare", Currency: "USD", Quantity: 5.450616849, AvgBuyPrice: 44.26},
	{Symbol: "VOO", YFSymbol: "VOO", DisplayName: "Vanguard S&P 500 ETF", Market: "US", Sector: "Broad Market ETF", Currency: "USD", Quantity: 0.33087232, AvgBuyPrice: 624.95},
	{Symbol: "GOOGL_PORT", YFSymbol: "GOOGL", DisplayName: "Alphabet Inc (Google)", Market: "US", Sector: "Communication Services", Currency: "USD", Quantity: 0.604472842, AvgBuyPrice: 324.18},
}
