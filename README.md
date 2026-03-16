# 📈 Stock Volatility Tracker

A real-time US stock & ETF alert app. Set conditions like "TSLA up 5%" or "SPY below $500" and get notified via **browser popup**, **email**, or **SMS text**.

## Features

- **Any US stock or ETF** — search by symbol or company name
- **6 alert types** — % up/down, price above/below, $ up/down
- **3 notification channels** — browser popup, email (Gmail), SMS (Twilio)
- **Live price updates** — Socket.io pushes prices every minute
- **Persistent alerts** — saved to `data.json`, survive restarts
- **Market state badges** — Pre-market / Regular / After-hours / Closed

## Quick Start

```bash
cd stock-tracker
npm install
node server.js
# → Open http://localhost:3000
```

## Email Setup (Gmail)

1. Enable **2-Step Verification** on your Google account
2. Go to [myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords)
3. Create an **App Password** (select "Mail" + "Other")
4. In the app: **Settings → Email** → enter your Gmail address and the App Password
5. Click **Send Test** to verify

## SMS Setup (Twilio)

1. Create a free account at [twilio.com](https://www.twilio.com/)
2. Get a phone number (free trial number works)
3. Copy your **Account SID**, **Auth Token**, and **Twilio phone number**
4. In the app: **Settings → SMS** → fill in your credentials and your phone number
5. Click **Send Test** to verify

## Optional: .env file

```bash
cp .env.example .env
# Edit .env with your credentials — they'll auto-load on startup
```

## Alert Conditions

| Condition | Example |
|-----------|---------|
| Rises ≥ X% from base | TSLA up 5% |
| Falls ≥ X% from base | TSLA down 5% |
| Price ≥ $X | NVDA above $150 |
| Price ≤ $X | SPY below $500 |
| Rises ≥ $X | AAPL up $10 |
| Falls ≥ $X | AAPL down $10 |

## Keyboard Shortcuts

- `Ctrl/Cmd + N` — open Add Alert dialog
- `Escape` — close dialog
