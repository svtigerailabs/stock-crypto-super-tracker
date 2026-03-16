# Stock Tracker Redesign Plan

## Changes Overview (6 user requirements)

### 1. Dashboard: Tiny boxes, 4x5+ layout (20+ visible)
- Make each card MUCH smaller: just symbol + price + change% on ONE line
- Grid stays 4 columns but cards are ~50px tall (down from ~70px)
- Remove alert dots from compact card to save space
- Remove the quick-picks bar to save vertical space
- 20+ boxes should fit without scrolling on a typical screen

### 2. Hover popup: Rich details + chart + news headlines + earnings
- When hovering a box, show a large popup (~420px wide) with:
  - Symbol, name, price, change
  - **Mini sparkline chart** (1-month, SVG-based, no library needed)
  - Key stats grid: Open, High, Low, Volume, 52w High, 52w Low, Market Cap, P/E, etc.
  - **Top 3 news headlines** (fetched from news API)
  - **Next earnings date + last earnings results** (last 4 quarters actual vs estimate)
  - Active alerts list with pause/delete buttons
  - "+ Add Alert" button
- Data is lazy-loaded on hover (cached after first load)

### 3. Click popup: Full news + price impact analysis
- Clicking a card opens the news modal (already exists)
- Enhance it to show MORE news (15 articles) and add a header section with:
  - Current price + day change
  - Key highlights: analyst target, recommendation, earnings date
  - Then the full news list below

### 4. Alert modal: Default first row to "Falls by 5%", remove "days before earnings" from dropdown
- Remove `earnings_before` from the 6 condition dropdowns
- Set row 1 default: type = `percent_down`, value = `5`
- Keep the other 5 rows as "— skip —"

### 5. Earnings section: Separate line at bottom of alert modal
- Below the 6 condition rows, add a dedicated "Earnings Alert" section:
  - Show: "Last Earnings: [date] — EPS: $0.50 (est: $0.45)" (fetched from API)
  - Show: "Next Earnings: [date]"
  - Checkbox: "Alert me before next earnings"
  - Input: "Days before" defaulting to 7, editable
- This replaces the earnings_before option in the dropdowns

### 6. Double-width alert modal: Left = alerts, Right = stock overview
- Make the modal ~1100px wide (double current ~560px)
- **Left panel**: Symbol search + condition rows + notify options (what we have now)
- **Right panel**: Rich stock data snapshot fetched from Yahoo Finance:
  - Price header with sparkline chart
  - Key Statistics table: Market Cap, P/E, EPS, 52w Range, Beta, Volume
  - Financial Health: Revenue, Margins, Cash, Debt, ROE
  - Analyst section: Target Price range, Recommendation (Buy/Hold/Sell bar), # of analysts
  - Last 4 quarters earnings chart (actual vs estimate)
  - Top 3 news headlines
- Right panel loads after symbol selection, shows a loading spinner until ready

## Backend Changes (server.js)

### New endpoint: `GET /api/stock/:symbol/profile`
Returns a comprehensive profile object combining data from:
- `quoteSummary` modules: `price,summaryDetail,defaultKeyStatistics,financialData,calendarEvents,earnings,recommendationTrend`
- Chart API: 1-month daily close prices for sparkline

Response shape:
```json
{
  "marketCap": "1.50T",
  "pe": "369.34",
  "forwardPE": "141.93",
  "eps": "1.08",
  "forwardEps": "2.81",
  "week52Low": 214.25,
  "week52High": 498.83,
  "beta": 1.93,
  "avgVolume": "65.52M",
  "fiftyDayAvg": 426.27,
  "twoHundredDayAvg": 392.37,
  "revenue": "94.83B",
  "revenueGrowth": "-3.10%",
  "grossMargins": "18.03%",
  "operatingMargins": "4.70%",
  "profitMargins": "4.00%",
  "returnOnEquity": "4.93%",
  "totalCash": "44.06B",
  "totalDebt": "14.72B",
  "debtToEquity": "17.76%",
  "currentRatio": 2.16,
  "freeCashflow": "3.73B",
  "targetMeanPrice": 421.61,
  "targetHighPrice": 600.00,
  "targetLowPrice": 125.00,
  "recommendationKey": "buy",
  "numberOfAnalysts": 41,
  "recommendationTrend": { "strongBuy": 4, "buy": 17, "hold": 17, "sell": 6, "strongSell": 2 },
  "earningsDate": "2026-04-21",
  "earningsAvgEstimate": 0.40,
  "earningsQuarterly": [
    { "date": "1Q2025", "actual": 0.27, "estimate": 0.41 },
    { "date": "2Q2025", "actual": 0.40, "estimate": 0.40 },
    ...
  ],
  "sparkline": [425.21, 428.27, 417.07, ...],  // 1-month daily closes
  "topNews": [{ "title": "...", "publisher": "...", "link": "..." }, ...]  // top 3
}
```

Cache this data for 30 minutes per symbol.

## File Changes

1. **server.js** — Add `yfProfile()` function and `/api/stock/:symbol/profile` route
2. **index.html** — Restructure alert modal to double-width with left/right panels; add earnings section
3. **app.js** — Major rewrite of: `buildStockCard()` (tiny cards), hover popup (rich data), `selectSymbol()` (load profile for right panel), `buildConditionRows()` (remove earnings, set default), earnings section logic, news modal enhancement
4. **styles.css** — New styles for: tiny cards, rich hover popup, double-width modal, right panel data display, sparkline, earnings bar chart, recommendation bar

## Implementation Order
1. Backend: Add `/api/stock/:symbol/profile` endpoint
2. CSS: All new styles
3. HTML: Restructured modal
4. JS: All frontend logic changes
5. Test end-to-end
