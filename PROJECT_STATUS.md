# 📊 Stock-Tracker Project Status

**Last Updated:** 2026-03-16 (Session 3)
**Project Status:** 🚧 **In Development** (Bug Fixes & Enhancements)

---

## 🎯 Current Focus
Implementing **6 major UX/feature redesigns** to improve dashboard usability and data density. See PLAN.md for full details.

---

## ✨ Features

| # | Feature | Status | Notes |
|---|---------|--------|-------|
| 1 | **Real-time price updates** | ✅ Done | Socket.io, ~1min refresh |
| 2 | **6 alert types** (%, price, $) | ✅ Done | percent_up/down, price_above/below, dollar_up/down |
| 3 | **Email notifications** (Gmail) | ✅ Done | App password required |
| 4 | **SMS notifications** (Twilio) | ✅ Done | Requires Twilio account |
| 5 | **Browser popups** | ✅ Done | In-app notifications |
| 6 | **Persistent alerts** | ✅ Done | Saved to data.json, survives restarts |
| 7 | **Stock/ETF search** | ✅ Done | By symbol or company name |
| 8 | **Market state badges** | ✅ Done | Pre/Regular/After-hours/Closed |
| 9 | **Dashboard redesign** (Requirement 1) | 🚧 In Progress | Tiny cards (4x5+ layout, 20+ visible) |
| 10 | **Hover popup** (Requirement 2) | ❌ Todo | Rich details: chart, news, earnings |
| 11 | **Click modal enhancement** (Requirement 3) | ❌ Todo | 15 articles + key highlights |
| 12 | **Alert modal improvements** (Requirement 4) | ❌ Todo | Remove earnings_before, default "down 5%" |
| 13 | **Earnings section** (Requirement 5) | ❌ Todo | Dedicated alert row + API data |
| 14 | **Double-width alert modal** (Requirement 6) | ❌ Todo | Left=alerts, Right=stock overview |
| 15 | **Profile API endpoint** | ❌ Todo | `/api/stock/:symbol/profile` + caching |
| 16 | **Crypto hover popup** | ✅ Done | Same rich popup as stocks (price, perf bars, stats, sparkline) |
| 17 | **Crypto Edit mode** | ✅ Done | Hide individual coins, saved to localStorage |
| 18 | **Crypto Detailed Table - ROI columns** | ✅ Done | 1H, 24H, 7D, 30D, ~6M, 1Y + chart period toggle |
| 19 | **Crypto chart period toggle** | ✅ Done | 1D/7D/30D/90D/1Y — lazy loads via CoinGecko |
| 20 | **Remove Simple List** | ✅ Done | Removed from crypto view |
| 21 | **Stock layout reorder** | ✅ Done | Header → 5 Indexes → Cards |
| 22 | **Stock hover popup position fix** | ✅ Done | position:fixed at top of viewport, no more cut-off |
| 23 | **Stock Detailed Table - 2Y/3Y ROI** | ✅ Done | Added 2Y and 3Y performance columns |
| 24 | **Stock chart period toggle** | ✅ Done | 1D/5D/1M/3M/1Y/2Y/3Y in detailed table |
| 25 | **Crypto Compact Grid** | ✅ Done | Tiny cards (icon+symbol+price+change), pinned coins first |
| 26 | **Crypto News Section** | ✅ Done | CoinDesk/CoinTelegraph/Decrypt RSS, shown below compact view |
| 27 | **Mute Alerts button** | ✅ Done | Left sidebar toggle 🔔/🔕, persists to localStorage |
| 28 | **Stock Detailed Table hover** | ✅ Done | Hover popup on rows (same as crypto table), with perf bar |
| 29 | **Pin coins to top** | ✅ Done | Edit mode shows 📌 pin button, pinned shown first in compact |

---

## 🐛 Known Bugs

| Bug | Severity | Status | Last Checked |
|-----|----------|--------|--------------|
| Economic Calendar stuck "Loading..." | High | ✅ Fixed 2026-03-23 | loadEconCalendar now sets _econCalLoaded=true even on failure |
| Crypto News broken links (CDATA) | High | ✅ Fixed 2026-03-23 | parseCryptoRSS now strips CDATA wrappers from link tags |
| TV Maps/Screener/Heatmap black | High | ✅ Fixed 2026-03-23 | Added explicit container height before widget injection |
| Fundamentals data always "—" | High | ✅ Fixed 2026-03-23 | Added v7 quote API fallback when quoteSummary crumb fails |
| Crypto news shows irrelevant articles | Medium | ✅ Fixed 2026-03-23 | Added crypto keyword filter to Google News RSS results |

---

## 📋 Session Notes

### Recent Sessions
- **2026-03-23 (Session 4)**: Bug audit fixes. Fixed 5 major bugs: economic calendar stuck loading, CDATA broken crypto news links, TV widget black screens (Maps/Screener/Heatmap), fundamentals data never loading (added v7 API fallback), crypto news irrelevant articles. Also set bypass permissions globally.
- **2026-03-16 (Session 3)**: Completed final batch of features (rows 25-29). Crypto Compact Grid, live news from 3 sources, mute button, stock table hover popups, pin coins. All verified live ✅.
- **2026-03-15 (Session 2)**: Applied 7 bug fixes across Crypto + Stock dashboards. See feature list rows 16-24 for details.
- **2026-03-15 (Session 1)**: Project recovery + workspace setup. Created PROJECT_STATUS.md dashboard and memory system.

### Decisions Made
- Using memory + dashboard approach instead of reloading massive JSONL file
- Implementing 6 requirements from PLAN.md in phases

---

## 🔧 Tech Stack

| Component | Technology |
|-----------|------------|
| **Backend** | Node.js (ES Modules), Express |
| **Real-time** | Socket.io |
| **Frontend** | Vanilla JS, HTML5, CSS3 |
| **Data APIs** | Yahoo Finance (v8/v10), CoinGecko |
| **Notifications** | Browser API, Gmail (App Password), Twilio |
| **Storage** | JSON file (data.json) |

---

## 📁 Key Files

```
stock-tracker/
├── server.js           # Express + Socket.io backend
├── public/
│   ├── index.html      # UI structure (needs redesign)
│   ├── app.js          # Frontend logic (~100KB)
│   └── styles.css      # Styling (~64KB)
├── data.json           # Persistent alerts storage
├── package.json        # Dependencies
├── PLAN.md             # Detailed redesign plan (6 requirements)
├── README.md           # User documentation
└── PROJECT_STATUS.md   # This file (updated each session)
```

---

## 🚀 Next Steps (Priority Order)

1. **Add `/api/stock/:symbol/profile` endpoint** (server.js)
   - Fetch: quoteSummary, chart (1-month sparkline), top 3 news
   - Response: price, stats, financial data, earnings, analyst info
   - Add 30-min caching

2. **CSS overhaul** (styles.css)
   - Tiny cards (~50px tall, 1-line: symbol+price+change%)
   - Rich hover popup styles
   - Double-width modal layout
   - Sparkline + earnings chart styles

3. **HTML restructure** (index.html)
   - Reduce card size, remove quick-picks bar
   - Double-width alert modal with left/right panels
   - Earnings section below alert rows
   - Hover popup container

4. **JavaScript rewrite** (app.js)
   - `buildStockCard()` — tiny cards
   - `buildHoverPopup()` — new rich popup
   - `selectSymbol()` — load profile data
   - Earnings alert logic
   - News modal enhancement (15 articles)

5. **Testing & debugging**
   - End-to-end test all 6 requirements
   - Fix responsive layout issues
   - Test on mobile/tablet

---

## 💡 Notes for Future Sessions

- **Memory files** auto-persist context (check `~/.claude/memory/`)
- **PLAN.md** has complete implementation specs
- **No need to reload JSONL** — use this dashboard + memory for quick context
- **Code is in `.claude/launch.json`** for quick server startup

---

**How to run:**
```bash
cd stock-tracker
node server.js          # Starts on http://localhost:3000
```
