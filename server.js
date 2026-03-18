import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { v4 as uuidv4 } from 'uuid';
import cron from 'node-cron';
import nodemailer from 'nodemailer';
import twilio from 'twilio';
import fs from 'fs';
import http from 'http';
import { Server } from 'socket.io';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json());
app.use(express.static(join(__dirname, 'public')));

// ─── YAHOO FINANCE HELPERS ───────────────────────────────────────────────────

const YF_UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' };
const YF_HEADERS = { ...YF_UA, 'Accept': 'application/json' };

// ── Crumb-based auth (needed for quoteSummary/earnings) ──
let yfCrumb = null;
let yfCookies = '';
let yfCrumbFetchedAt = 0;
const CRUMB_TTL = 60 * 60 * 1000; // 1 hour

async function ensureCrumb() {
  if (yfCrumb && (Date.now() - yfCrumbFetchedAt) < CRUMB_TTL) return;
  try {
    // Step 1: get cookies (UA only, no Accept: json)
    const initRes = await fetch('https://fc.yahoo.com/crumb', {
      headers: YF_UA, redirect: 'manual',
    });
    const setCookies = initRes.headers.getSetCookie?.() || [];
    yfCookies = setCookies.map(c => c.split(';')[0]).join('; ');

    // Step 2: get crumb (UA + cookie, no Accept: json)
    const crumbRes = await fetch('https://query2.finance.yahoo.com/v1/test/getcrumb', {
      headers: { ...YF_UA, Cookie: yfCookies },
    });
    const text = await crumbRes.text();
    // Validate it's a real crumb (not an error JSON)
    if (text && !text.includes('{')) {
      yfCrumb = text;
      yfCrumbFetchedAt = Date.now();
      console.log('✅ Yahoo Finance crumb acquired');
    } else {
      console.warn('⚠️  Crumb response invalid:', text.slice(0, 60));
    }
  } catch (e) {
    console.error('Crumb fetch error:', e.message);
  }
}

// ── Helpers ──
function fmtMktCap(n) {
  if (!n || typeof n !== 'number') return null;
  if (n >= 1e12) return `$${(n / 1e12).toFixed(2)}T`;
  if (n >= 1e9)  return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6)  return `$${(n / 1e6).toFixed(2)}M`;
  return `$${n.toLocaleString()}`;
}

// ── Stock quote (v8 chart — no auth needed) ──
async function yfQuote(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1d&includePrePost=true`;
  const res = await fetch(url, { headers: YF_HEADERS });
  if (!res.ok) throw new Error(`Yahoo Finance HTTP ${res.status} for ${symbol}`);
  const json = await res.json();
  const result = json.chart?.result?.[0];
  if (!result) throw new Error(`No data for ${symbol}`);
  const meta = result.meta;

  const prev = meta.chartPreviousClose || meta.previousClose || meta.regularMarketPrice;
  const price = meta.regularMarketPrice;
  const change = price - prev;
  const changePct = (change / prev) * 100;
  const instrument = (meta.instrumentType || '').toUpperCase();
  const quoteType = instrument === 'ETF' ? 'ETF' : instrument === 'EQUITY' ? 'EQUITY' : instrument || 'EQUITY';

  return {
    symbol: meta.symbol || symbol, name: meta.longName || meta.shortName || symbol,
    price, previousClose: prev, change, changePercent: changePct,
    open: meta.regularMarketOpen || price, high: meta.regularMarketDayHigh || price,
    low: meta.regularMarketDayLow || price, volume: meta.regularMarketVolume || 0,
    marketState: meta.marketState || detectMarketState(meta),
    type: quoteType, currency: meta.currency || 'USD',
  };
}

function detectMarketState(meta) {
  const now = Math.floor(Date.now() / 1000);
  const pre = meta.currentTradingPeriod?.pre;
  const regular = meta.currentTradingPeriod?.regular;
  const post = meta.currentTradingPeriod?.post;
  if (!regular) return 'CLOSED';
  if (now >= regular.start && now <= regular.end) return 'REGULAR';
  if (pre && now >= pre.start && now <= pre.end) return 'PRE';
  if (post && now >= post.start && now <= post.end) return 'POST';
  return 'CLOSED';
}

// ── Search ──
async function yfSearch(query) {
  const url = `https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(query)}&quotesCount=10&newsCount=0`;
  const res = await fetch(url, { headers: YF_HEADERS });
  if (!res.ok) throw new Error(`Search HTTP ${res.status}`);
  const json = await res.json();
  return (json.quotes || [])
    .filter(q => ['EQUITY', 'ETF', 'MUTUALFUND'].includes((q.quoteType || '').toUpperCase()))
    .slice(0, 8)
    .map(q => ({
      symbol: q.symbol, name: q.shortname || q.longname || q.symbol,
      type: (q.quoteType || 'EQUITY').toUpperCase(), exchange: q.exchDisp || q.exchange || '',
    }));
}

// ── News ──
async function yfNews(symbol) {
  const url = `https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(symbol)}&quotesCount=0&newsCount=15`;
  const res = await fetch(url, { headers: YF_HEADERS });
  if (!res.ok) throw new Error(`News HTTP ${res.status}`);
  const json = await res.json();
  return (json.news || []).map(n => ({
    title: n.title, publisher: n.publisher, link: n.link,
    publishedAt: n.providerPublishTime ? new Date(n.providerPublishTime * 1000).toISOString() : null,
    thumbnail: n.thumbnail?.resolutions?.[0]?.url || null,
  }));
}

// ── Earnings date (requires crumb auth) ──
const earningsCache = {}; // { symbol: { date: Date|null, fetchedAt } }
const EARNINGS_CACHE_TTL = 12 * 60 * 60 * 1000; // 12 hours

async function yfEarningsDate(symbol) {
  const cached = earningsCache[symbol];
  if (cached && (Date.now() - cached.fetchedAt) < EARNINGS_CACHE_TTL) return cached.date;

  await ensureCrumb();
  if (!yfCrumb) { earningsCache[symbol] = { date: null, fetchedAt: Date.now() }; return null; }

  try {
    const url = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=calendarEvents&crumb=${encodeURIComponent(yfCrumb)}`;
    const res = await fetch(url, { headers: { ...YF_UA, Cookie: yfCookies } });
    if (!res.ok) {
      if (res.status === 401) { yfCrumb = null; yfCrumbFetchedAt = 0; } // force refresh
      earningsCache[symbol] = { date: null, fetchedAt: Date.now() };
      return null;
    }
    const json = await res.json();
    const arr = json.quoteSummary?.result?.[0]?.calendarEvents?.earnings?.earningsDate;
    const date = arr?.length ? new Date(arr[0].raw * 1000) : null;
    earningsCache[symbol] = { date, fetchedAt: Date.now() };
    return date;
  } catch (e) {
    console.error(`Earnings fetch error for ${symbol}:`, e.message);
    earningsCache[symbol] = { date: null, fetchedAt: Date.now() };
    return null;
  }
}

// ── Rich profile (quoteSummary + sparkline) ──
const profileCache = {};
const PROFILE_CACHE_TTL = 30 * 60 * 1000; // 30 min

async function yfProfile(symbol) {
  const cached = profileCache[symbol];
  if (cached && (Date.now() - cached._fetchedAt) < PROFILE_CACHE_TTL) return cached;

  await ensureCrumb();

  const result = {};

  // 1) quoteSummary (crumb-protected)
  if (yfCrumb) {
    try {
      const modules = 'price,summaryDetail,defaultKeyStatistics,financialData,calendarEvents,earnings,recommendationTrend';
      const url = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=${modules}&crumb=${encodeURIComponent(yfCrumb)}`;
      const res = await fetch(url, { headers: { ...YF_UA, Cookie: yfCookies } });
      if (res.ok) {
        const json = await res.json();
        const r = json.quoteSummary?.result?.[0] || {};
        const p = r.price || {}, sd = r.summaryDetail || {}, ks = r.defaultKeyStatistics || {};
        const fd = r.financialData || {}, ce = r.calendarEvents || {}, ea = r.earnings || {};
        const rt = r.recommendationTrend || {};

        Object.assign(result, {
          marketCap: p.marketCap?.fmt || sd.marketCap?.fmt || null,
          exchangeName: p.exchangeName || null,
          trailingPE: sd.trailingPE?.fmt || null,
          forwardPE: sd.forwardPE?.fmt || null,
          eps: ks.trailingEps?.fmt || null,
          forwardEps: ks.forwardEps?.fmt || null,
          week52Low: sd.fiftyTwoWeekLow?.raw ?? null,
          week52High: sd.fiftyTwoWeekHigh?.raw ?? null,
          beta: sd.beta?.fmt || null,
          avgVolume: sd.averageVolume?.fmt || null,
          fiftyDayAvg: sd.fiftyDayAverage?.raw ?? null,
          twoHundredDayAvg: sd.twoHundredDayAverage?.raw ?? null,
          dividendYield: sd.dividendYield?.fmt || null,
          revenue: fd.totalRevenue?.fmt || null,
          revenueGrowth: fd.revenueGrowth?.fmt || null,
          grossMargins: fd.grossMargins?.fmt || null,
          operatingMargins: fd.operatingMargins?.fmt || null,
          profitMargins: ks.profitMargins?.fmt || null,
          returnOnEquity: fd.returnOnEquity?.fmt || null,
          totalCash: fd.totalCash?.fmt || null,
          totalDebt: fd.totalDebt?.fmt || null,
          debtToEquity: fd.debtToEquity?.fmt || null,
          currentRatio: fd.currentRatio?.fmt || null,
          freeCashflow: fd.freeCashflow?.fmt || null,
          targetMeanPrice: fd.targetMeanPrice?.raw ?? null,
          targetHighPrice: fd.targetHighPrice?.raw ?? null,
          targetLowPrice: fd.targetLowPrice?.raw ?? null,
          recommendationKey: fd.recommendationKey || null,
          numberOfAnalysts: fd.numberOfAnalystOpinions?.raw ?? null,
          priceToBook: ks.priceToBook?.fmt || null,
          shortPercentOfFloat: ks.shortPercentOfFloat?.fmt || null,
          sharesOutstanding: ks.sharesOutstanding?.fmt || null,
          earningsDate: ce.earnings?.earningsDate?.[0]?.raw ? new Date(ce.earnings.earningsDate[0].raw * 1000).toISOString().split('T')[0] : null,
          earningsAvgEst: ce.earnings?.earningsAverage?.fmt || null,
          earningsLowEst: ce.earnings?.earningsLow?.raw ?? null,
          earningsHighEst: ce.earnings?.earningsHigh?.raw ?? null,
          earningsAvgEstRaw: ce.earnings?.earningsAverage?.raw ?? null,
          currentQuarterEstimate: ea.earningsChart?.currentQuarterEstimate?.raw ?? null,
          currentQuarterEstimateDate: ea.earningsChart?.currentQuarterEstimateDate || null,
          earningsQuarterly: (ea.earningsChart?.quarterly || []).map(q => ({
            date: q.date, actual: q.actual?.raw ?? null, estimate: q.estimate?.raw ?? null,
          })),
          recommendationTrend: (rt.trend || []).length ? {
            strongBuy: rt.trend[0].strongBuy, buy: rt.trend[0].buy,
            hold: rt.trend[0].hold, sell: rt.trend[0].sell, strongSell: rt.trend[0].strongSell,
          } : null,
        });

        // Also update earningsCache while we're at it
        const earningsArr = ce.earnings?.earningsDate;
        const earningsDateObj = earningsArr?.length ? new Date(earningsArr[0].raw * 1000) : null;
        earningsCache[symbol] = { date: earningsDateObj, fetchedAt: Date.now() };
      } else if (res.status === 401) {
        yfCrumb = null; yfCrumbFetchedAt = 0;
      }
    } catch (e) { console.error(`Profile quoteSummary error for ${symbol}:`, e.message); }
  }

  // 2) Sparkline (1-month chart, no auth needed)
  try {
    const chartUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1mo`;
    const chartRes = await fetch(chartUrl, { headers: YF_HEADERS });
    if (chartRes.ok) {
      const chartJson = await chartRes.json();
      const closes = chartJson.chart?.result?.[0]?.indicators?.quote?.[0]?.close || [];
      result.sparkline = closes.filter(c => c !== null).map(c => +c.toFixed(2));
    }
  } catch (e) { console.error(`Profile sparkline error for ${symbol}:`, e.message); }

  // 3) All news (up to 15)
  try {
    const news = await yfNews(symbol);
    result.topNews = news;
  } catch (e) { result.topNews = []; }

  // 4) Multi-timeframe performance (price change %)
  try {
    const perfRanges = { '1D': '1d', '7D': '5d', '1M': '1mo', '3M': '3mo', 'YTD': 'ytd', '1Y': '1y', '2Y': '2y', '3Y': '3y', '5Y': '5y', '10Y': '10y' };
    const perfResults = {};
    for (const [label, range] of Object.entries(perfRanges)) {
      try {
        const interval = range === '1d' ? '5m' : '1d';
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval}&range=${range}`;
        const r = await fetch(url, { headers: YF_HEADERS, signal: AbortSignal.timeout(5000) });
        if (r.ok) {
          const j = await r.json();
          const meta = j.chart?.result?.[0]?.meta;
          if (meta) {
            const prev = meta.chartPreviousClose || meta.previousClose;
            const cur = meta.regularMarketPrice;
            if (prev && cur) perfResults[label] = ((cur - prev) / prev) * 100;
            else perfResults[label] = null;
            // Grab marketCap from chart meta as fallback (available in some responses)
            if (!result.marketCap && meta.marketCap) result.marketCap = fmtMktCap(meta.marketCap);
          }
        }
      } catch { perfResults[label] = null; }
    }
    // Inception: fetch max range, compute first-price → current return + extract IPO date
    try {
      const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1mo&range=max`, { headers: YF_HEADERS, signal: AbortSignal.timeout(8000) });
      if (r.ok) {
        const j = await r.json();
        const res0 = j.chart?.result?.[0];
        const closes = res0?.indicators?.quote?.[0]?.close?.filter(v => v != null) || [];
        const meta = res0?.meta || {};
        const cur = meta.regularMarketPrice;
        const firstPrice = closes[0];
        if (firstPrice && cur) perfResults['Inception'] = ((cur - firstPrice) / firstPrice) * 100;
        else perfResults['Inception'] = null;
        if (meta.firstTradeDate) {
          const d = new Date(meta.firstTradeDate * 1000);
          result.ipoDate = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
        }
      }
    } catch { perfResults['Inception'] = null; }
    result._perf = perfResults;
  } catch { /* skip */ }

  // 5) marketCap fallback: v7 quote API (no crumb, returns marketCap directly)
  if (!result.marketCap || !result.trailingPE || !result.week52Low) {
    try {
      const fields = 'marketCap,trailingPE,epsTrailingTwelveMonths,fiftyTwoWeekLow,fiftyTwoWeekHigh,forwardPE,bookValue,priceToBook';
      const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(symbol)}&fields=${fields}&formatted=false`;
      const r = await fetch(url, { headers: YF_HEADERS, signal: AbortSignal.timeout(6000) });
      if (r.ok) {
        const j = await r.json();
        const q = j.quoteResponse?.result?.[0] || {};
        if (!result.marketCap && q.marketCap) result.marketCap = fmtMktCap(q.marketCap);
        if (!result.trailingPE && q.trailingPE) result.trailingPE = q.trailingPE.toFixed(2);
        if (!result.eps && q.epsTrailingTwelveMonths) result.eps = '$' + q.epsTrailingTwelveMonths.toFixed(2);
        if (!result.week52Low && q.fiftyTwoWeekLow) result.week52Low = q.fiftyTwoWeekLow;
        if (!result.week52High && q.fiftyTwoWeekHigh) result.week52High = q.fiftyTwoWeekHigh;
        if (!result.forwardPE && q.forwardPE) result.forwardPE = q.forwardPE.toFixed(2);
        if (!result.priceToBook && q.priceToBook) result.priceToBook = q.priceToBook.toFixed(2);
      }
    } catch { /* skip */ }
  }
  // 5b) final fallback for marketCap via quoteSummary
  if (!result.marketCap) {
    try {
      const url = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=summaryDetail,price&formatted=true`;
      const r = await fetch(url, { headers: YF_HEADERS, signal: AbortSignal.timeout(5000) });
      if (r.ok) {
        const j = await r.json();
        const r2 = j.quoteSummary?.result?.[0] || {};
        const mc = r2.price?.marketCap?.fmt || r2.summaryDetail?.marketCap?.fmt || null;
        if (mc) result.marketCap = mc;
        else {
          const mcRaw = r2.price?.marketCap?.raw || r2.summaryDetail?.marketCap?.raw;
          if (mcRaw) result.marketCap = fmtMktCap(mcRaw);
        }
      }
    } catch { /* skip */ }
  }

  result._fetchedAt = Date.now();
  profileCache[symbol] = result;
  return result;
}

// ── Market Sector ETFs — 6 groups × 15 each ──
const SECTOR_ETFS = [
  // 1) US Sectors — 15 major sectors / market segments
  { symbol: 'XLK',     name: 'Technology',           group: 'US Sectors',     emoji: '💻' },
  { symbol: 'XLF',     name: 'Financials',            group: 'US Sectors',     emoji: '🏦' },
  { symbol: 'XLV',     name: 'Health Care',           group: 'US Sectors',     emoji: '⚕️' },
  { symbol: 'XLY',     name: 'Consumer Discret.',     group: 'US Sectors',     emoji: '🛍️' },
  { symbol: 'XLP',     name: 'Consumer Staples',      group: 'US Sectors',     emoji: '🛒' },
  { symbol: 'XLE',     name: 'Energy',                group: 'US Sectors',     emoji: '⛽' },
  { symbol: 'XLI',     name: 'Industrials',           group: 'US Sectors',     emoji: '🏭' },
  { symbol: 'XLB',     name: 'Materials',             group: 'US Sectors',     emoji: '🪨' },
  { symbol: 'XLRE',    name: 'Real Estate',           group: 'US Sectors',     emoji: '🏢' },
  { symbol: 'XLU',     name: 'Utilities',             group: 'US Sectors',     emoji: '💡' },
  { symbol: 'XLC',     name: 'Comm. Services',        group: 'US Sectors',     emoji: '📡' },
  { symbol: 'XHB',     name: 'Homebuilders',          group: 'US Sectors',     emoji: '🏠' },
  { symbol: 'SPY',     name: 'S&P 500',               group: 'US Sectors',     emoji: '📈' },
  { symbol: 'IWM',     name: 'Russell 2000',          group: 'US Sectors',     emoji: '📊' },
  { symbol: 'VTI',     name: 'Total Market',          group: 'US Sectors',     emoji: '🌐' },
  // 2) Tech Sectors — hardware, software, data center, AI, defense, space
  { symbol: 'QQQ',     name: 'Nasdaq 100',            group: 'Tech Sectors',   emoji: '🖥️' },
  { symbol: 'SOXX',    name: 'Semiconductors',        group: 'Tech Sectors',   emoji: '⚡' },
  { symbol: 'SMH',     name: 'Semicon. (VanEck)',     group: 'Tech Sectors',   emoji: '🔬' },
  { symbol: 'IGV',     name: 'Software',              group: 'Tech Sectors',   emoji: '📦' },
  { symbol: 'WCLD',    name: 'Cloud Computing',       group: 'Tech Sectors',   emoji: '☁️' },
  { symbol: 'CIBR',    name: 'Cybersecurity',         group: 'Tech Sectors',   emoji: '🛡️' },
  { symbol: 'BOTZ',    name: 'Robotics & AI',         group: 'Tech Sectors',   emoji: '🤖' },
  { symbol: 'AIQ',     name: 'AI & Big Data',         group: 'Tech Sectors',   emoji: '🧠' },
  { symbol: 'ARKK',    name: 'Disruptive Innovation', group: 'Tech Sectors',   emoji: '🚀' },
  { symbol: 'ITA',     name: 'Aerospace & Defense',   group: 'Tech Sectors',   emoji: '✈️' },
  { symbol: 'DRIV',    name: 'EV & Autonomous',       group: 'Tech Sectors',   emoji: '🚗' },
  { symbol: 'UFO',     name: 'Space Exploration',     group: 'Tech Sectors',   emoji: '🛸' },
  { symbol: 'VGT',     name: 'Technology (Vang.)',    group: 'Tech Sectors',   emoji: '💡' },
  { symbol: 'FTEC',    name: 'Technology (Fidelity)', group: 'Tech Sectors',   emoji: '🔧' },
  { symbol: 'HACK',    name: 'Cybersecurity (ETFMG)', group: 'Tech Sectors',   emoji: '🔐' },
  // 3) International — developed & emerging markets
  { symbol: 'EFA',     name: 'Dev. Mkts (EAFE)',      group: 'International',  emoji: '🌍' },
  { symbol: 'EEM',     name: 'Emerging Mkts (iSh)',   group: 'International',  emoji: '🌏' },
  { symbol: 'VEA',     name: 'Dev. ex-US (Vang.)',    group: 'International',  emoji: '🌐' },
  { symbol: 'VWO',     name: 'Emrg. Mkts (Vang.)',   group: 'International',  emoji: '🌎' },
  { symbol: 'FXI',     name: 'China Large Cap',       group: 'International',  emoji: '🇨🇳' },
  { symbol: 'MCHI',    name: 'MSCI China',            group: 'International',  emoji: '🇨🇳' },
  { symbol: 'EWJ',     name: 'Japan',                 group: 'International',  emoji: '🇯🇵' },
  { symbol: 'EWG',     name: 'Germany',               group: 'International',  emoji: '🇩🇪' },
  { symbol: 'EWU',     name: 'UK',                    group: 'International',  emoji: '🇬🇧' },
  { symbol: 'EWZ',     name: 'Brazil',                group: 'International',  emoji: '🇧🇷' },
  { symbol: 'EWT',     name: 'Taiwan',                group: 'International',  emoji: '🇹🇼' },
  { symbol: 'EWY',     name: 'South Korea',           group: 'International',  emoji: '🇰🇷' },
  { symbol: 'INDA',    name: 'India',                 group: 'International',  emoji: '🇮🇳' },
  { symbol: 'EWC',     name: 'Canada',                group: 'International',  emoji: '🇨🇦' },
  { symbol: 'IEMG',    name: 'Emrg. Mkts (Core)',     group: 'International',  emoji: '🗺️' },
  // 4) Commodities — gold, silver, copper, oil, gas, agriculture
  { symbol: 'GLD',     name: 'Gold',                  group: 'Commodities',    emoji: '🥇' },
  { symbol: 'IAU',     name: 'Gold (iShares)',         group: 'Commodities',    emoji: '🥇' },
  { symbol: 'SLV',     name: 'Silver',                group: 'Commodities',    emoji: '🥈' },
  { symbol: 'PPLT',    name: 'Platinum',              group: 'Commodities',    emoji: '🔷' },
  { symbol: 'CPER',    name: 'Copper',                group: 'Commodities',    emoji: '🟤' },
  { symbol: 'GDX',     name: 'Gold Miners',           group: 'Commodities',    emoji: '⛏️' },
  { symbol: 'USO',     name: 'Oil (WTI)',              group: 'Commodities',    emoji: '🛢️' },
  { symbol: 'BNO',     name: 'Brent Oil',             group: 'Commodities',    emoji: '🛢️' },
  { symbol: 'UNG',     name: 'Natural Gas',           group: 'Commodities',    emoji: '🔥' },
  { symbol: 'DBA',     name: 'Agriculture',           group: 'Commodities',    emoji: '🌾' },
  { symbol: 'WEAT',    name: 'Wheat',                 group: 'Commodities',    emoji: '🌾' },
  { symbol: 'PDBC',    name: 'Broad Commodities',     group: 'Commodities',    emoji: '📦' },
  { symbol: 'GDXJ',    name: 'Junior Gold Miners',    group: 'Commodities',    emoji: '⛏️' },
  { symbol: 'DBB',     name: 'Base Metals',           group: 'Commodities',    emoji: '🔩' },
  { symbol: 'XOP',     name: 'Oil & Gas E&P',         group: 'Commodities',    emoji: '🏗️' },
  // 5) Crypto — 15 major assets (Yahoo Finance tickers)
  { symbol: 'BTC-USD', name: 'Bitcoin',               group: 'Crypto',         emoji: '₿' },
  { symbol: 'ETH-USD', name: 'Ethereum',              group: 'Crypto',         emoji: '⟠' },
  { symbol: 'BNB-USD', name: 'BNB',                   group: 'Crypto',         emoji: '🔶' },
  { symbol: 'XRP-USD', name: 'XRP',                   group: 'Crypto',         emoji: '💧' },
  { symbol: 'SOL-USD', name: 'Solana',                group: 'Crypto',         emoji: '◎' },
  { symbol: 'ADA-USD', name: 'Cardano',               group: 'Crypto',         emoji: '🔵' },
  { symbol: 'AVAX-USD',name: 'Avalanche',             group: 'Crypto',         emoji: '🔺' },
  { symbol: 'DOGE-USD',name: 'Dogecoin',              group: 'Crypto',         emoji: '🐕' },
  { symbol: 'DOT-USD', name: 'Polkadot',              group: 'Crypto',         emoji: '⚫' },
  { symbol: 'LINK-USD',name: 'Chainlink',             group: 'Crypto',         emoji: '🔗' },
  { symbol: 'LTC-USD', name: 'Litecoin',              group: 'Crypto',         emoji: '🌕' },
  { symbol: 'BCH-USD', name: 'Bitcoin Cash',          group: 'Crypto',         emoji: '💚' },
  { symbol: 'UNI-USD', name: 'Uniswap',               group: 'Crypto',         emoji: '🦄' },
  { symbol: 'ATOM-USD',name: 'Cosmos',                group: 'Crypto',         emoji: '⚛️' },
  { symbol: 'NEAR-USD',name: 'NEAR Protocol',         group: 'Crypto',         emoji: '🟣' },
  // 6) Fixed Income — 15 bond ETFs
  { symbol: 'AGG',     name: 'US Total Bond',         group: 'Fixed Income',   emoji: '🏛️' },
  { symbol: 'BND',     name: 'Total Bond (Vang.)',    group: 'Fixed Income',   emoji: '🏛️' },
  { symbol: 'TLT',     name: 'Long Bond (20Y+)',      group: 'Fixed Income',   emoji: '📋' },
  { symbol: 'IEF',     name: 'Mid Bond (7-10Y)',      group: 'Fixed Income',   emoji: '📋' },
  { symbol: 'SHY',     name: 'Short Bond (1-3Y)',     group: 'Fixed Income',   emoji: '📋' },
  { symbol: 'HYG',     name: 'High Yield Corp.',      group: 'Fixed Income',   emoji: '⚡' },
  { symbol: 'LQD',     name: 'Inv. Grade Corp.',      group: 'Fixed Income',   emoji: '💼' },
  { symbol: 'VCIT',    name: 'Corp. Intermediate',    group: 'Fixed Income',   emoji: '💼' },
  { symbol: 'MUB',     name: 'Muni Bonds',            group: 'Fixed Income',   emoji: '🏙️' },
  { symbol: 'TIP',     name: 'TIPS (Inflation)',       group: 'Fixed Income',   emoji: '📈' },
  { symbol: 'EMB',     name: 'Emrg. Mkt Bonds',      group: 'Fixed Income',   emoji: '🌏' },
  { symbol: 'BNDX',    name: 'Intl Bond (Vang.)',     group: 'Fixed Income',   emoji: '🌍' },
  { symbol: 'GOVT',    name: 'US Treasury All-Term',  group: 'Fixed Income',   emoji: '🏛️' },
  { symbol: 'VCSH',    name: 'Short Corp. Bond',      group: 'Fixed Income',   emoji: '📊' },
  { symbol: 'FLOT',    name: 'Floating Rate Bond',    group: 'Fixed Income',   emoji: '🌊' },
];

const sectorCache = { data: null, fetchedAt: 0 };
const SECTOR_CACHE_TTL = 12 * 60 * 60 * 1000; // 12 hours — update 2× per day

// ── Alternative ETFs per group (shown in customize dropdown) ──
const SECTOR_AVAILABLE = {
  'US Sectors': [
    { symbol: 'SPY',  name: 'S&P 500 ETF',        emoji: '📈' },
    { symbol: 'DIA',  name: 'Dow Jones ETF',       emoji: '🏛️' },
    { symbol: 'IWM',  name: 'Russell 2000',        emoji: '📊' },
    { symbol: 'MDY',  name: 'S&P Mid-Cap 400',     emoji: '📊' },
    { symbol: 'IJR',  name: 'S&P Small-Cap 600',   emoji: '📊' },
    { symbol: 'VTI',  name: 'Total Stock Market',  emoji: '🌐' },
    { symbol: 'SCHD', name: 'Dividend Equity',     emoji: '💰' },
    { symbol: 'HDV',  name: 'High Dividend',       emoji: '💵' },
    { symbol: 'VNQ',  name: 'REITs (Vanguard)',    emoji: '🏢' },
    { symbol: 'AMLP', name: 'MLP Pipeline',        emoji: '🔧' },
    { symbol: 'SCHB', name: 'Broad US Market',     emoji: '🌐' },
    { symbol: 'QUAL', name: 'Quality Factor',      emoji: '⭐' },
    { symbol: 'MTUM', name: 'Momentum Factor',     emoji: '🚀' },
    { symbol: 'VLUE', name: 'Value Factor',        emoji: '💎' },
    { symbol: 'SIZE', name: 'Size Factor',         emoji: '📐' },
  ],
  'Tech Sectors': [
    { symbol: 'HACK', name: 'Cybersecurity (PureFunds)', emoji: '🛡️' },
    { symbol: 'CLOU', name: 'Cloud Computing',    emoji: '☁️' },
    { symbol: 'ROBO', name: 'Robotics (ROBO)',    emoji: '🤖' },
    { symbol: 'SKYY', name: 'Cloud Computing (FI)',emoji: '🌥️' },
    { symbol: 'FTEC', name: 'Technology (Fidelity)',emoji: '💻' },
    { symbol: 'VGT',  name: 'Technology (Vang.)', emoji: '🖥️' },
    { symbol: 'ESPO', name: 'Video Games/eSports',emoji: '🎮' },
    { symbol: 'HERO', name: 'Online Gaming',      emoji: '🎮' },
    { symbol: 'IRBO', name: 'Robotics & AI (iSh)',emoji: '🦾' },
    { symbol: 'KWEB', name: 'China Internet',     emoji: '🌐' },
    { symbol: 'PSCT', name: 'Small Cap Tech',     emoji: '🔬' },
    { symbol: 'DTEC', name: 'Disruptive Tech',    emoji: '⚡' },
    { symbol: 'MSTR', name: 'MicroStrategy (BTC)',emoji: '₿' },
    { symbol: 'SOXS', name: 'Semiconductor Bear',emoji: '📉' },
    { symbol: 'FNGS', name: 'FANG+',             emoji: '🦷' },
  ],
  'International': [
    { symbol: 'INDA', name: 'India',              emoji: '🇮🇳' },
    { symbol: 'EWA',  name: 'Australia',          emoji: '🇦🇺' },
    { symbol: 'EWC',  name: 'Canada',             emoji: '🇨🇦' },
    { symbol: 'EWH',  name: 'Hong Kong',          emoji: '🇭🇰' },
    { symbol: 'EWS',  name: 'Singapore',          emoji: '🇸🇬' },
    { symbol: 'EWP',  name: 'Spain',              emoji: '🇪🇸' },
    { symbol: 'EWQ',  name: 'France',             emoji: '🇫🇷' },
    { symbol: 'IEMG', name: 'Emrg. Mkts (iSh Core)', emoji: '🌏' },
    { symbol: 'VXUS', name: 'Total Intl Stock',   emoji: '🌐' },
    { symbol: 'ACWI', name: 'All Country World',  emoji: '🌍' },
    { symbol: 'ACWX', name: 'All Cntry Ex-US',   emoji: '🌎' },
    { symbol: 'DFE',  name: 'Europe SmallCap Div',emoji: '🇪🇺' },
    { symbol: 'RODM', name: 'Dev. Mkts Quality',  emoji: '🌐' },
    { symbol: 'EEMV', name: 'EM Low Volatility',  emoji: '📊' },
    { symbol: 'ARGT', name: 'Argentina',          emoji: '🇦🇷' },
  ],
  'Commodities': [
    { symbol: 'GDXJ', name: 'Junior Gold Miners', emoji: '⛏️' },
    { symbol: 'CORN', name: 'Corn',               emoji: '🌽' },
    { symbol: 'SOYB', name: 'Soybeans',           emoji: '🫘' },
    { symbol: 'SIVR', name: 'Silver (Aberdeen)',  emoji: '🥈' },
    { symbol: 'PALL', name: 'Palladium',          emoji: '⚪' },
    { symbol: 'DBB',  name: 'Base Metals',        emoji: '🔩' },
    { symbol: 'COPX', name: 'Copper Miners',      emoji: '🟤' },
    { symbol: 'XOP',  name: 'Oil & Gas E&P',      emoji: '⛽' },
    { symbol: 'FCG',  name: 'Natural Gas Cos.',   emoji: '🔥' },
    { symbol: 'NIB',  name: 'Cocoa',              emoji: '🍫' },
    { symbol: 'JJG',  name: 'Grains',             emoji: '🌾' },
    { symbol: 'DIRT', name: 'Soil (Fertilizer)',  emoji: '🪴' },
    { symbol: 'DBP',  name: 'Precious Metals',    emoji: '💰' },
    { symbol: 'REMX', name: 'Rare Earth Metals',  emoji: '🔮' },
    { symbol: 'GUNR', name: 'Global Natl Resources',emoji: '🌿' },
  ],
  'Crypto': [
    { symbol: 'MATIC-USD', name: 'Polygon',       emoji: '🔷' },
    { symbol: 'UNI-USD',   name: 'Uniswap',       emoji: '🦄' },
    { symbol: 'ATOM-USD',  name: 'Cosmos',        emoji: '⚛️' },
    { symbol: 'NEAR-USD',  name: 'NEAR Protocol', emoji: '🟣' },
    { symbol: 'FIL-USD',   name: 'Filecoin',      emoji: '📁' },
    { symbol: 'TRX-USD',   name: 'TRON',          emoji: '🔴' },
    { symbol: 'ICP-USD',   name: 'Internet Computer',emoji: '💠' },
    { symbol: 'ALGO-USD',  name: 'Algorand',      emoji: '♾️' },
    { symbol: 'VET-USD',   name: 'VeChain',       emoji: '✅' },
    { symbol: 'HBAR-USD',  name: 'Hedera',        emoji: '🔗' },
    { symbol: 'EGLD-USD',  name: 'MultiversX',    emoji: '🌐' },
    { symbol: 'THETA-USD', name: 'Theta Network', emoji: '🎥' },
    { symbol: 'MANA-USD',  name: 'Decentraland',  emoji: '🏙️' },
    { symbol: 'SAND-USD',  name: 'The Sandbox',   emoji: '🏝️' },
    { symbol: 'APE-USD',   name: 'ApeCoin',       emoji: '🦍' },
  ],
  'Fixed Income': [
    { symbol: 'GOVT', name: 'US Treasury All-Term',emoji: '🏛️' },
    { symbol: 'FLOT', name: 'Floating Rate Bond', emoji: '🌊' },
    { symbol: 'VCSH', name: 'Short Corp. Bond',   emoji: '📋' },
    { symbol: 'VGSH', name: 'Short-Term Treasury',emoji: '📋' },
    { symbol: 'BSV',  name: 'Short-Term Bond (Vang.)',emoji: '📊' },
    { symbol: 'GSY',  name: 'Ultra-Short Income', emoji: '💰' },
    { symbol: 'JPST', name: 'Ultra-Short Income (JPM)',emoji: '💵' },
    { symbol: 'BIL',  name: '1-3 Month T-Bill',   emoji: '💴' },
    { symbol: 'SPTS', name: 'Short TIPS',         emoji: '📈' },
    { symbol: 'IGSB', name: 'Short-Term Corp.',   emoji: '🏢' },
    { symbol: 'FALN', name: 'Fallen Angels',      emoji: '😈' },
    { symbol: 'HYS',  name: 'Short High Yield',   emoji: '⚡' },
    { symbol: 'NEAR', name: 'Near-Term Rate ETF', emoji: '🌊' },
    { symbol: 'SPAB', name: 'US Aggregate Bond',  emoji: '🏛️' },
    { symbol: 'VGIT', name: 'Mid-Term Treasury',  emoji: '📋' },
  ],
};

async function fetchOneSectorPerf(etf) {
  // Fetch all periods IN PARALLEL for speed
  const PERIOD_RANGES = [
    ['1D','1d','5m'], ['1W','5d','1d'], ['1M','1mo','1d'], ['3M','3mo','1d'],
    ['YTD','ytd','1d'], ['1Y','1y','1d'], ['2Y','2y','1d'], ['5Y','5y','1wk'], ['10Y','10y','1mo'],
  ];
  let price = null, change = null, changePct = null;

  const pairs = await Promise.all(PERIOD_RANGES.map(async ([label, range, interval]) => {
    try {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(etf.symbol)}?interval=${interval}&range=${range}`;
      const r = await fetch(url, { headers: YF_HEADERS, signal: AbortSignal.timeout(8000) });
      if (r.ok) {
        const j = await r.json();
        const meta = j.chart?.result?.[0]?.meta;
        if (meta) {
          const prev = meta.chartPreviousClose || meta.previousClose;
          const cur = meta.regularMarketPrice;
          if (prev && cur) {
            const pct = +((cur - prev) / prev * 100).toFixed(2);
            if (label === '1D') { price = cur; change = +(cur - prev).toFixed(2); changePct = pct; }
            return [label, pct];
          }
        }
      }
    } catch {}
    return [label, null];
  }));

  const perf = Object.fromEntries(pairs);
  return { ...etf, perf, price, change, changePct };
}

async function fetchSectorData() {
  if (sectorCache.data && (Date.now() - sectorCache.fetchedAt) < SECTOR_CACHE_TTL) {
    return sectorCache.data;
  }
  // Batch 10 ETFs at a time (each fetches all periods in parallel internally)
  const BATCH = 10;
  const results = [];
  for (let i = 0; i < SECTOR_ETFS.length; i += BATCH) {
    const batch = SECTOR_ETFS.slice(i, i + BATCH);
    const batchRes = await Promise.all(batch.map(fetchOneSectorPerf));
    results.push(...batchRes);
    if (i + BATCH < SECTOR_ETFS.length) await new Promise(r => setTimeout(r, 150));
  }
  sectorCache.data = results;
  sectorCache.fetchedAt = Date.now();
  return results;
}

// ── Market Index (Dow, S&P, Nasdaq, Gold, BTC) ──
const MARKET_INDEX_SYMBOLS = [
  { symbol: '^DJI',    name: 'Dow 30',   shortName: 'Dow 30'  },
  { symbol: '^GSPC',   name: 'S&P 500',  shortName: 'S&P 500' },
  { symbol: '^IXIC',   name: 'Nasdaq',   shortName: 'Nasdaq'  },
  { symbol: 'GC=F',    name: 'Gold',     shortName: 'Gold'    },
  { symbol: 'BTC-USD', name: 'Bitcoin',  shortName: 'BTC'     },
];

const marketIndexCache = { data: null, fetchedAt: 0 };
const MARKET_INDEX_TTL = 30 * 1000; // 30 seconds

async function fetchMarketIndex() {
  if (marketIndexCache.data && (Date.now() - marketIndexCache.fetchedAt) < MARKET_INDEX_TTL) return marketIndexCache.data;

  // Fetch futures for pre-market indicators (Dow→YM=F, S&P→ES=F, Nasdaq→NQ=F)
  const FUTURES_MAP = { '^DJI': 'YM=F', '^GSPC': 'ES=F', '^IXIC': 'NQ=F' };
  const futuresResults = {};
  await Promise.allSettled(
    Object.entries(FUTURES_MAP).map(async ([idx, fut]) => {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(fut)}?interval=5m&range=1d&includePrePost=true`;
      const res = await fetch(url, { headers: YF_HEADERS, signal: AbortSignal.timeout(6000) });
      if (!res.ok) return;
      const json = await res.json();
      const meta = json.chart?.result?.[0]?.meta;
      if (!meta) return;
      const prev = meta.chartPreviousClose || meta.previousClose;
      const futPrice = meta.regularMarketPrice;
      const futChg = futPrice - prev;
      const futChgPct = (futChg / prev) * 100;
      futuresResults[idx] = { price: futPrice, change: futChg, changePct: futChgPct, symbol: fut, marketState: meta.marketState };
    })
  );

  const results = await Promise.allSettled(
    MARKET_INDEX_SYMBOLS.map(async ({ symbol, name, shortName }) => {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=5m&range=1d&includePrePost=true`;
      const res = await fetch(url, { headers: YF_HEADERS, signal: AbortSignal.timeout(6000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const r = json.chart?.result?.[0];
      if (!r) throw new Error('No data');
      const meta = r.meta;
      const closes = (r.indicators?.quote?.[0]?.close || []).filter(c => c !== null);
      const prev = meta.chartPreviousClose || meta.previousClose;
      const price = meta.regularMarketPrice;
      const change = price - prev;
      const changePct = (change / prev) * 100;
      const marketState = meta.marketState || 'CLOSED';

      // Try Yahoo Finance pre/post market prices directly
      let prePost = null;
      if (meta.preMarketPrice && meta.preMarketPrice !== price) {
        const pp = meta.preMarketPrice;
        const ppChg = pp - prev;
        prePost = { type: 'Pre-Mkt', price: pp, change: ppChg, changePct: (ppChg / prev) * 100, source: 'yahoo' };
      } else if (meta.postMarketPrice && meta.postMarketPrice !== price) {
        const pp = meta.postMarketPrice;
        const ppChg = pp - prev;
        prePost = { type: 'After-Hrs', price: pp, change: ppChg, changePct: (ppChg / prev) * 100, source: 'yahoo' };
      }

      // Fallback: use futures for Dow/S&P/Nasdaq when no direct pre/post data
      const futures = (!prePost && futuresResults[symbol]) ? futuresResults[symbol] : null;

      return { symbol, name, shortName, price, change, changePct, sparkline: closes.map(c => +c.toFixed(4)), marketState, prePost, futures };
    })
  );

  const data = results.map((r, i) => r.status === 'fulfilled' ? r.value : { ...MARKET_INDEX_SYMBOLS[i], price: null, change: null, changePct: null, sparkline: [], marketState: 'CLOSED' });
  marketIndexCache.data = data;
  marketIndexCache.fetchedAt = Date.now();
  return data;
}

// ── Chart data (any time period) ──
const chartCache = {};
const CHART_RANGES = { '1d':'5m', '7d':'15m', '5d':'15m', '1mo':'1d', '3mo':'1d', 'ytd':'1d', '1y':'1d', '2y':'1wk', '3y':'1wk', '5y':'1wk', '10y':'1mo', 'max':'1mo' };

async function yfChart(symbol, range, interval) {
  const key = `${symbol}:${range}`;
  const ttl = range === '1d' ? 2 * 60 * 1000 : 15 * 60 * 1000;
  const cached = chartCache[key];
  if (cached && (Date.now() - cached._fetchedAt) < ttl) return cached;

  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval}&range=${range}&includePrePost=false`;
  const res = await fetch(url, { headers: YF_HEADERS });
  if (!res.ok) throw new Error(`Chart HTTP ${res.status}`);
  const json = await res.json();
  const r = json.chart?.result?.[0];
  if (!r) throw new Error('No chart data');
  const ts = r.timestamp || [];
  const q = r.indicators?.quote?.[0] || {};
  const meta = r.meta || {};
  const result = {
    symbol: meta.symbol || symbol,
    currency: meta.currency || 'USD',
    previousClose: meta.chartPreviousClose || meta.previousClose,
    regularMarketPrice: meta.regularMarketPrice,
    dataPoints: ts.map((t, i) => ({
      timestamp: t, close: q.close?.[i] ?? null, high: q.high?.[i] ?? null,
      low: q.low?.[i] ?? null, volume: q.volume?.[i] ?? null,
    })).filter(d => d.close !== null),
    _fetchedAt: Date.now(),
  };
  chartCache[key] = result;
  return result;
}

// ── Quarterly financial statements ──
const financialsCache = {};
const FINANCIALS_CACHE_TTL = 60 * 60 * 1000; // 1 hour

async function yfFinancials(symbol) {
  const cached = financialsCache[symbol];
  if (cached && (Date.now() - cached._fetchedAt) < FINANCIALS_CACHE_TTL) return cached;

  await ensureCrumb();
  if (!yfCrumb) throw new Error('No crumb available');

  const modules = 'incomeStatementHistoryQuarterly,balanceSheetHistoryQuarterly,cashflowStatementHistoryQuarterly';
  const url = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=${modules}&crumb=${encodeURIComponent(yfCrumb)}`;
  const res = await fetch(url, { headers: { ...YF_UA, Cookie: yfCookies } });
  if (!res.ok) {
    if (res.status === 401) { yfCrumb = null; yfCrumbFetchedAt = 0; }
    throw new Error(`Financials HTTP ${res.status}`);
  }
  const json = await res.json();
  const r = json.quoteSummary?.result?.[0] || {};
  const is = r.incomeStatementHistoryQuarterly?.incomeStatementHistory || [];
  const bs = r.balanceSheetHistoryQuarterly?.balanceSheetStatements || [];
  const cf = r.cashflowStatementHistoryQuarterly?.cashflowStatements || [];

  // Separate each statement type for tabbed display
  const income = is.map(stmt => ({
    endDate: stmt.endDate?.fmt || null,
    revenue: stmt.totalRevenue?.raw ?? null,
    costOfRevenue: stmt.costOfRevenue?.raw ?? null,
    grossProfit: stmt.grossProfit?.raw ?? null,
    researchDevelopment: stmt.researchDevelopment?.raw ?? null,
    sellingGeneralAdmin: stmt.sellingGeneralAdministrative?.raw ?? null,
    operatingExpense: stmt.totalOperatingExpenses?.raw ?? null,
    operatingIncome: stmt.operatingIncome?.raw ?? null,
    interestExpense: stmt.interestExpense?.raw ?? null,
    incomeBeforeTax: stmt.incomeBeforeTax?.raw ?? null,
    incomeTaxExpense: stmt.incomeTaxExpense?.raw ?? null,
    netIncome: stmt.netIncome?.raw ?? null,
    eps: stmt.dilutedEPS?.raw ?? null,
    ebitda: stmt.ebitda?.raw ?? null,
  }));

  const balance = bs.map(stmt => ({
    endDate: stmt.endDate?.fmt || null,
    cash: stmt.cash?.raw ?? null,
    shortTermInvestments: stmt.shortTermInvestments?.raw ?? null,
    netReceivables: stmt.netReceivables?.raw ?? null,
    inventory: stmt.inventory?.raw ?? null,
    totalCurrentAssets: stmt.totalCurrentAssets?.raw ?? null,
    propertyPlantEquipment: stmt.propertyPlantEquipment?.raw ?? null,
    goodwill: stmt.goodWill?.raw ?? null,
    intangibleAssets: stmt.intangibleAssets?.raw ?? null,
    totalAssets: stmt.totalAssets?.raw ?? null,
    accountsPayable: stmt.accountsPayable?.raw ?? null,
    shortLongTermDebt: stmt.shortLongTermDebt?.raw ?? null,
    totalCurrentLiabilities: stmt.totalCurrentLiabilities?.raw ?? null,
    longTermDebt: stmt.longTermDebt?.raw ?? null,
    totalLiabilities: stmt.totalLiab?.raw ?? null,
    totalEquity: stmt.totalStockholderEquity?.raw ?? null,
  }));

  const cashflow = cf.map(stmt => ({
    endDate: stmt.endDate?.fmt || null,
    netIncome: stmt.netIncome?.raw ?? null,
    depreciation: stmt.depreciation?.raw ?? null,
    operatingCashflow: stmt.totalCashFromOperatingActivities?.raw ?? null,
    capitalExpenditure: stmt.capitalExpenditures?.raw ?? null,
    investments: stmt.investments?.raw ?? null,
    investingCashflow: stmt.totalCashflowsFromInvestingActivities?.raw ?? null,
    dividendsPaid: stmt.dividendsPaid?.raw ?? null,
    netBorrowings: stmt.netBorrowings?.raw ?? null,
    financingCashflow: stmt.totalCashFromFinancingActivities?.raw ?? null,
    changeInCash: stmt.changeInCash?.raw ?? null,
    freeCashflow: stmt.totalCashFromOperatingActivities?.raw != null && stmt.capitalExpenditures?.raw != null
      ? (stmt.totalCashFromOperatingActivities.raw + stmt.capitalExpenditures.raw) : null,
  }));

  // Also keep legacy 'quarterly' for backward compat
  const quarterly = is.map((stmt, i) => {
    const bsStmt = bs[i] || {};
    const cfStmt = cf[i] || {};
    return {
      endDate: stmt.endDate?.fmt || null,
      revenue: stmt.totalRevenue?.raw ?? null,
      costOfRevenue: stmt.costOfRevenue?.raw ?? null,
      grossProfit: stmt.grossProfit?.raw ?? null,
      operatingIncome: stmt.operatingIncome?.raw ?? null,
      netIncome: stmt.netIncome?.raw ?? null,
      eps: stmt.dilutedEPS?.raw ?? null,
      ebitda: stmt.ebitda?.raw ?? null,
      totalAssets: bsStmt.totalAssets?.raw ?? null,
      totalLiabilities: bsStmt.totalLiab?.raw ?? null,
      totalEquity: bsStmt.totalStockholderEquity?.raw ?? null,
      cash: bsStmt.cash?.raw ?? null,
      operatingCashflow: cfStmt.totalCashFromOperatingActivities?.raw ?? null,
      capitalExpenditure: cfStmt.capitalExpenditures?.raw ?? null,
    };
  });

  const result = { quarterly, income, balance, cashflow, _fetchedAt: Date.now() };
  financialsCache[symbol] = result;
  return result;
}

// ── HTML entity decoding for RSS titles ──
function decodeHtmlEntities(str) {
  if (!str) return '';
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, '/')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/<[^>]+>/g, ''); // strip any remaining HTML tags
}

// ── RSS news parsing (CNBC, Bloomberg) ──
const rssCache = { data: null, fetchedAt: 0 };
const RSS_CACHE_TTL = 20 * 60 * 1000; // 20 min (background refresh keeps it fresh)

function parseRSS(xml, sourceName) {
  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/gi;
  let match;
  while ((match = itemRegex.exec(xml)) !== null) {
    const block = match[1];
    const titleRaw = block.match(/<title>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>/)?.[1]?.trim() || '';
    const title = decodeHtmlEntities(titleRaw);
    const link = block.match(/<link>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/link>/)?.[1]?.trim() || '';
    const pubDate = block.match(/<pubDate>(.*?)<\/pubDate>/)?.[1]?.trim() || '';
    const desc = block.match(/<description>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>/)?.[1]?.trim() || '';
    if (title && link) {
      items.push({
        title, link, source: sourceName, publisher: sourceName,
        publishedAt: pubDate ? new Date(pubDate).toISOString() : null,
        description: decodeHtmlEntities(desc).slice(0, 200),
        thumbnail: null,
      });
    }
  }
  return items;
}

// ── News priority scoring ──
const GEO_KEYWORDS = ['war','invasion','sanction','tariff','trade war','geopolitical','nato','ukraine','china','taiwan','russia','middle east','iran','israel','north korea','election','president','congress','senate','legislation','fed','federal reserve','interest rate','powell','inflation','recession','gdp','unemployment','debt ceiling','default','supply chain','opec','oil price','energy crisis'];
const MARKET_KEYWORDS = ['earnings','beat','miss','guidance','forecast','merger','acquisition','ipo','bankruptcy','layoffs','downgrade','upgrade','buyback','dividend','revenue','profit','loss','short squeeze','rate hike','rate cut','quantitative','stimulus','bailout','ceo','cfo','quarterly'];
const URGENCY_KEYWORDS = ['breaking','alert','urgent','emergency','crash','surge','soars','plunges','collapses','halted','suspended','investigation','indicted','fraud','crisis','record high','record low'];

function scoreNewsPriority(item, watchedSymbols) {
  let score = 0;
  const text = (item.title + ' ' + (item.description || '')).toLowerCase();
  const categories = [];

  // Recency (max 50 pts)
  if (item.publishedAt) {
    const ageHours = (Date.now() - new Date(item.publishedAt).getTime()) / 3600000;
    if (ageHours < 0.5) score += 50;
    else if (ageHours < 1) score += 40;
    else if (ageHours < 3) score += 30;
    else if (ageHours < 6) score += 20;
    else if (ageHours < 24) score += 10;
  }

  // Urgency keywords (max 30 pts)
  const urgencyMatches = URGENCY_KEYWORDS.filter(kw => text.includes(kw)).length;
  if (urgencyMatches > 0) { score += Math.min(30, urgencyMatches * 10); categories.push('breaking'); }

  // Geopolitical (max 25 pts)
  const geoMatches = GEO_KEYWORDS.filter(kw => text.includes(kw)).length;
  if (geoMatches > 0) { score += Math.min(25, geoMatches * 8); categories.push('geo'); }

  // Market impact (max 20 pts)
  const mktMatches = MARKET_KEYWORDS.filter(kw => text.includes(kw)).length;
  if (mktMatches > 0) { score += Math.min(20, mktMatches * 5); categories.push('market'); }

  // Watched stocks mentioned (max 40 pts)
  const watchedMatch = watchedSymbols.find(s => text.includes(s.toLowerCase()) || text.includes(s.toLowerCase() + ' '));
  if (watchedMatch) { score += 40; categories.push('portfolio'); item.relatedSymbol = watchedMatch; }

  return { ...item, priority: score, categories };
}

// ── X/Twitter via Nitter RSS (free mirror) ──
const xNewsCache = { data: null, fetchedAt: 0, handles: '' };
const X_NEWS_TTL = 10 * 60 * 1000;
const NITTER_INSTANCES = ['nitter.privacydev.net', 'nitter.poast.org', 'nitter.nl'];

async function fetchXNews(handles) {
  if (!handles || !handles.length) return [];
  const handleKey = handles.join(',');
  if (xNewsCache.data && xNewsCache.handles === handleKey && (Date.now() - xNewsCache.fetchedAt) < X_NEWS_TTL) return xNewsCache.data;

  const items = [];
  for (const handle of handles.slice(0, 5)) {
    const cleanHandle = handle.replace('@', '');
    for (const instance of NITTER_INSTANCES) {
      try {
        const res = await fetch(`https://${instance}/${cleanHandle}/rss`, { headers: { ...YF_UA, 'Accept': 'application/rss+xml, application/xml, text/xml' }, signal: AbortSignal.timeout(5000) });
        if (res.ok) {
          const xml = await res.text();
          const parsed = parseRSS(xml, `X:@${cleanHandle}`);
          items.push(...parsed.slice(0, 5));
          break;
        }
      } catch { /* try next instance */ }
    }
  }
  xNewsCache.data = items;
  xNewsCache.fetchedAt = Date.now();
  xNewsCache.handles = handleKey;
  return items;
}

async function fetchRSSNews() {
  // Return fresh cache if still valid
  if (rssCache.data?.length && (Date.now() - rssCache.fetchedAt) < RSS_CACHE_TTL) return rssCache.data;

  // ── TIER 1: Google News RSS — served via Google CDN, works from ANY cloud IP ──
  // These are the ONLY sources that reliably work from cloud/VPS servers.
  // Traditional financial sites (Yahoo Finance, Bloomberg, CNBC, Reuters, etc.)
  // block datacenter IPs — Google News does not.
  const googleFeeds = [
    { url: 'https://news.google.com/rss/search?q=stock+market+S%26P+500+nasdaq&hl=en-US&gl=US&ceid=US:en', name: 'Google News' },
    { url: 'https://news.google.com/rss/search?q=dow+jones+wall+street+stocks&hl=en-US&gl=US&ceid=US:en', name: 'Google News' },
    { url: 'https://news.google.com/rss/search?q=Federal+Reserve+interest+rates+inflation+CPI&hl=en-US&gl=US&ceid=US:en', name: 'Google News' },
    { url: 'https://news.google.com/rss/search?q=earnings+report+quarterly+results+revenue&hl=en-US&gl=US&ceid=US:en', name: 'Google News' },
    { url: 'https://news.google.com/rss/search?q=investing+markets+economy+recession+GDP&hl=en-US&gl=US&ceid=US:en', name: 'Google News' },
    { url: 'https://news.google.com/rss/search?q=IPO+merger+acquisition+corporate+finance&hl=en-US&gl=US&ceid=US:en', name: 'Google News' },
    { url: 'https://news.google.com/rss/search?q=trading+options+ETF+bonds+treasury&hl=en-US&gl=US&ceid=US:en', name: 'Google News' },
    { url: 'https://news.google.com/rss/search?q=Nasdaq+Apple+Tesla+Microsoft+Amazon+Nvidia&hl=en-US&gl=US&ceid=US:en', name: 'Google News' },
  ];

  // ── TIER 2: Traditional financial feeds (may work if server IP not blocked) ──
  const fallbackFeeds = [
    { url: 'https://feeds.content.dowjones.io/public/rss/mw_realtimeheadlines', name: 'MarketWatch' },
    { url: 'https://www.cnbc.com/id/10001147/device/rss/rss.html', name: 'CNBC' },
    { url: 'https://feeds.reuters.com/reuters/businessNews', name: 'Reuters' },
    { url: 'https://www.benzinga.com/feed', name: 'Benzinga' },
    { url: 'https://feeds.a.dj.com/rss/RSSMarketsMain.xml', name: 'WSJ Markets' },
    { url: 'https://www.fool.com/a/feeds/foolwatch', name: 'Motley Fool' },
  ];

  let allItems = [];

  // Fetch Tier 1 first — these must succeed
  await Promise.allSettled(googleFeeds.map(async feed => {
    try {
      const res = await fetch(feed.url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)' },
        signal: AbortSignal.timeout(10000),
      });
      if (res.ok) {
        const xml = await res.text();
        const parsed = parseRSS(xml, feed.name);
        if (parsed.length) allItems.push(...parsed);
      }
    } catch (e) { /* silent */ }
  }));

  // Fetch Tier 2 in parallel if Tier 1 gave < 20 articles
  if (allItems.length < 20) {
    await Promise.allSettled(fallbackFeeds.map(async feed => {
      try {
        const res = await fetch(feed.url, { headers: YF_UA, signal: AbortSignal.timeout(6000) });
        if (res.ok) {
          const xml = await res.text();
          const parsed = parseRSS(xml, feed.name);
          if (parsed.length) allItems.push(...parsed);
        }
      } catch (e) { /* silent */ }
    }));
  }

  // Deduplicate by title and sort newest first
  const seen = new Set();
  allItems = allItems.filter(a => {
    if (!a.title) return false;
    const key = a.title.slice(0, 60);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  allItems.sort((a, b) => new Date(b.publishedAt || 0) - new Date(a.publishedAt || 0));
  const fresh = allItems.slice(0, 100);

  if (fresh.length > 0) {
    rssCache.data = fresh;
    rssCache.fetchedAt = Date.now();
    console.log(`RSS news: fetched ${fresh.length} articles (Google News primary)`);
  } else if (rssCache.data?.length) {
    console.warn(`RSS news: all feeds failed, returning stale cache (${rssCache.data.length} articles)`);
  } else {
    console.error('RSS news: all feeds failed and no stale cache available');
  }

  return rssCache.data || [];
}

// ── Aggregated latest news ──
const latestNewsCache = { data: null, fetchedAt: 0 };
const LATEST_NEWS_TTL = 5 * 60 * 1000;

async function fetchLatestNews(watchedSymbols = [], xHandles = [], forceRefresh = false) {
  if (!forceRefresh && latestNewsCache.data && (Date.now() - latestNewsCache.fetchedAt) < LATEST_NEWS_TTL) {
    // Re-score with current watched symbols
    return latestNewsCache.data.map(n => scoreNewsPriority(n, watchedSymbols));
  }

  const allNews = [];

  // Yahoo Finance news per symbol (limit 6 per symbol)
  await Promise.allSettled(watchedSymbols.slice(0, 12).map(async sym => {
    try {
      const news = await yfNews(sym);
      news.slice(0, 6).forEach(n => { n.source = 'Yahoo Finance'; allNews.push(n); });
    } catch { /* skip */ }
  }));

  // RSS feeds (CNBC, Bloomberg, Reuters, MarketWatch, Yahoo)
  try {
    const rss = await fetchRSSNews();
    allNews.push(...rss);
  } catch { /* skip */ }

  // X/Twitter via Nitter RSS (user-configured handles)
  if (xHandles && xHandles.length) {
    try {
      const xNews = await fetchXNews(xHandles);
      allNews.push(...xNews);
    } catch { /* skip */ }
  }

  // Deduplicate by title key
  const seen = new Set();
  const unique = allNews.filter(n => {
    const key = n.title.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 40);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Score and sort by priority, then recency
  const scored = unique.map(n => scoreNewsPriority(n, watchedSymbols));
  scored.sort((a, b) => (b.priority - a.priority) || (new Date(b.publishedAt || 0) - new Date(a.publishedAt || 0)));

  const result = scored.slice(0, 150);
  if (result.length > 0) {
    latestNewsCache.data = result;
    latestNewsCache.fetchedAt = Date.now();
    console.log(`Latest news: fetched ${result.length} articles`);
  } else if (latestNewsCache.data?.length) {
    console.warn('Latest news: all sources failed, returning stale cache');
  }
  return latestNewsCache.data || [];
}

// ─── CRYPTO (Coinpaprika free API — no key needed, cloud-friendly) ───────────
const cryptoCache = { data: null, fetchedAt: 0 };
const CRYPTO_CACHE_TTL = 2 * 60 * 1000; // 2 min

async function fetchCryptoData() {
  if (cryptoCache.data && (Date.now() - cryptoCache.fetchedAt) < CRYPTO_CACHE_TTL) return cryptoCache.data;

  try {
    const url = 'https://api.coinpaprika.com/v1/tickers?limit=200&quotes=USD';
    const res = await fetch(url, {
      headers: { 'Accept': 'application/json', 'User-Agent': 'StockCryptoSuperTracker/1.0' },
      signal: AbortSignal.timeout(10000)
    });
    if (!res.ok) throw new Error(`Coinpaprika HTTP ${res.status}`);
    const data = await res.json();
    const result = data.map(c => {
      const q = c.quotes?.USD || {};
      const athPct = (q.price && q.ath_price) ? ((q.price - q.ath_price) / q.ath_price * 100) : null;
      return {
        id: c.id,
        symbol: c.symbol.toUpperCase(),
        name: c.name,
        image: `https://static.coinpaprika.com/coin/${c.id}/logo.png`,
        price: q.price,
        change1h: q.percent_change_1h ?? null,
        change24h: q.percent_change_24h ?? null,
        change7d: q.percent_change_7d ?? null,
        change30d: q.percent_change_30d ?? null,
        change200d: q.percent_change_200d ?? null, // Coinpaprika provides this when available
        change1y: q.percent_change_1y ?? null,
        marketCap: q.market_cap,
        volume24h: q.volume_24h,
        rank: c.rank,
        sparkline: [],
        high24h: null,
        low24h: null,
        ath: q.ath_price ?? null,
        athChangePercent: athPct,
      };
    });
    cryptoCache.data = result;
    cryptoCache.fetchedAt = Date.now();
    return result;
  } catch (e) {
    console.error('Crypto fetch error:', e.message);
    return cryptoCache.data || [];
  }
}

// ─── DATA STORE ───────────────────────────────────────────────────────────────

let alerts = [];
let settings = {
  emailEnabled: false, emailAddress: '',
  emailFrom: process.env.EMAIL_FROM || '', emailPassword: process.env.EMAIL_PASSWORD || '',
  smsEnabled: false, phoneNumber: '',
  twilioAccountSid: process.env.TWILIO_ACCOUNT_SID || '',
  twilioAuthToken: process.env.TWILIO_AUTH_TOKEN || '',
  twilioPhoneNumber: process.env.TWILIO_PHONE_NUMBER || '',
  checkIntervalMinutes: 1,
  xHandles: [],
  dashboardOrder: [],
};
let stockCache = {};
let notificationHistory = [];
const DATA_FILE = join(__dirname, 'data.json');

if (fs.existsSync(DATA_FILE)) {
  try {
    const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    alerts = data.alerts || [];
    settings = { ...settings, ...data.settings };
    notificationHistory = data.notificationHistory || [];
    console.log(`✅ Loaded ${alerts.length} alert(s) from storage`);
  } catch (e) { console.error('⚠️  Error loading data:', e.message); }
}

// Seed default watchlist on very first run (no alerts yet)
if (alerts.length === 0) {
  const DEFAULT_STOCKS = ['TSLA','NVDA','AVGO','PLTR','GOOGL','AAPL','AMZN','MSTR','BTC-USD','GLXY'];
  DEFAULT_STOCKS.forEach((sym, i) => {
    alerts.push({
      id: `default_${i}_${Date.now()}`,
      symbol: sym,
      conditionType: 'percent_down',
      conditionValue: 10,
      isActive: true,
      notifyPopup: true,
      notifyEmail: false,
      notifySms: false,
      repeatAlert: true,
      createdAt: new Date().toISOString(),
    });
  });
  try {
    const data = fs.existsSync(DATA_FILE) ? JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')) : {};
    fs.writeFileSync(DATA_FILE, JSON.stringify({ ...data, alerts }, null, 2));
    console.log(`🌱 Seeded ${DEFAULT_STOCKS.length} default watchlist symbols`);
  } catch (e) { console.error('Error seeding defaults:', e.message); }
}

function saveData() {
  try { fs.writeFileSync(DATA_FILE, JSON.stringify({ alerts, settings, notificationHistory }, null, 2)); }
  catch (e) { console.error('Error saving data:', e.message); }
}

// ─── STOCK ROUTES ─────────────────────────────────────────────────────────────

app.get('/api/stock/:symbol', async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  try {
    const data = await yfQuote(symbol);
    stockCache[symbol] = { ...data, lastUpdated: Date.now() };
    res.json(data);
  } catch (error) {
    res.status(400).json({ error: `Could not find symbol: ${symbol}` });
  }
});

app.get('/api/search/:query', async (req, res) => {
  try { res.json(await yfSearch(req.params.query)); }
  catch { res.status(400).json({ error: 'Search failed' }); }
});

app.get('/api/stock/:symbol/news', async (req, res) => {
  try { res.json(await yfNews(req.params.symbol.toUpperCase())); }
  catch (e) { res.status(400).json({ error: 'Could not fetch news' }); }
});

app.get('/api/stock/:symbol/earnings', async (req, res) => {
  try {
    const date = await yfEarningsDate(req.params.symbol.toUpperCase());
    res.json({ earningsDate: date ? date.toISOString() : null });
  } catch { res.status(400).json({ error: 'Could not fetch earnings date' }); }
});

app.get('/api/stock/:symbol/profile', async (req, res) => {
  try { res.json(await yfProfile(req.params.symbol.toUpperCase())); }
  catch (e) { res.status(400).json({ error: 'Could not fetch profile' }); }
});

app.get('/api/stock/:symbol/chart', async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  const { range = '1mo' } = req.query;
  const interval = CHART_RANGES[range];
  if (!interval) return res.status(400).json({ error: 'Invalid range. Allowed: ' + Object.keys(CHART_RANGES).join(', ') });
  try { res.json(await yfChart(symbol, range, interval)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

app.get('/api/stock/:symbol/financials', async (req, res) => {
  try { res.json(await yfFinancials(req.params.symbol.toUpperCase())); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

app.get('/api/news/rss', async (req, res) => {
  try { res.json(await fetchRSSNews()); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// ─── ECONOMIC CALENDAR ────────────────────────────────────────────────────────
const econCalCache = { data: null, fetchedAt: 0 };
const ECON_CAL_TTL = 30 * 60 * 1000; // 30 min cache

async function fetchEconCalendar() {
  if (econCalCache.data && (Date.now() - econCalCache.fetchedAt) < ECON_CAL_TTL) return econCalCache.data;
  try {
    const urls = [
      'https://nfs.faireconomy.media/ff_calendar_thisweek.json',
      'https://nfs.faireconomy.media/ff_calendar_nextweek.json',
    ];
    const results = await Promise.allSettled(urls.map(async u => {
      const r = await fetch(u, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(10000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    }));
    let events = [];
    results.forEach(r => { if (r.status === 'fulfilled' && Array.isArray(r.value)) events.push(...r.value); });
    // Sort by date
    events.sort((a, b) => new Date(a.date) - new Date(b.date));
    if (events.length) {
      econCalCache.data = events;
      econCalCache.fetchedAt = Date.now();
      console.log(`Economic calendar: fetched ${events.length} events`);
    }
  } catch (e) {
    console.error('Economic calendar fetch error:', e.message);
  }
  return econCalCache.data || [];
}

app.get('/api/economic-calendar', async (req, res) => {
  try { res.json(await fetchEconCalendar()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Earnings Calendar (top 100 S&P 500 by market cap) ──
const TOP100_SYMBOLS = [
  'AAPL','MSFT','NVDA','AMZN','GOOGL','META','TSLA','BRK-B','AVGO','LLY',
  'JPM','V','ORCL','UNH','WMT','MA','XOM','NFLX','COST','HD',
  'JNJ','BAC','PG','ABBV','AMD','KO','CSCO','CRM','WFC','ACN',
  'GS','MS','CVX','MRK','TMO','NOW','ISRG','IBM','ABT','LIN',
  'NEE','CAT','DHR','BX','GE','TJX','AXP','MCD','AMGN','RTX',
  'PM','INTU','QCOM','UBER','BSX','VZ','PFE','T','LOW','NKE',
  'CB','PLTR','BKNG','SPGI','BLK','ELV','SYK','C','MMC','PLD',
  'DE','DUK','SO','MO','ETN','HON','CME','AON','ITW','USB',
  'PNC','WM','ZTS','EMR','MCO','INTC','TT','APH','ECL','COF',
  'SCHW','F','GM','NSC','FDX','UPS','DIS','PYPL','ADSK','TGT',
];

let earningsCalCache = { data: null, fetchedAt: 0 };
const EARNINGS_CAL_TTL = 6 * 60 * 60 * 1000; // 6 hours

async function fetchEarningsCalendar() {
  if (earningsCalCache.data && (Date.now() - earningsCalCache.fetchedAt) < EARNINGS_CAL_TTL) {
    return earningsCalCache.data;
  }
  // Batch fetch via crumb-authenticated v7 quote API (50 at a time)
  await ensureCrumb();
  if (!yfCrumb) {
    console.warn('Earnings calendar: no crumb available, falling back to per-symbol fetch');
    return fetchEarningsCalendarFallback();
  }

  const BATCH = 50;
  const results = [];
  for (let i = 0; i < TOP100_SYMBOLS.length; i += BATCH) {
    const batch = TOP100_SYMBOLS.slice(i, i + BATCH);
    try {
      const url = `https://query2.finance.yahoo.com/v7/finance/quote?symbols=${batch.join(',')}&formatted=false&crumb=${encodeURIComponent(yfCrumb)}`;
      const res = await fetch(url, { headers: { ...YF_UA, Cookie: yfCookies } });
      if (!res.ok) {
        if (res.status === 401) { yfCrumb = null; yfCrumbFetchedAt = 0; }
        continue;
      }
      const json = await res.json();
      const quotes = json.quoteResponse?.result || [];
      console.log(`Earnings calendar batch ${i/BATCH+1}: ${quotes.length} quotes`);
      for (const q of quotes) {
        // earningsTimestampStart = next earnings window start (most reliable for future date)
        const ts = q.earningsTimestampStart || q.earningsTimestamp;
        const tsEnd = q.earningsTimestampEnd;
        const estimated = tsEnd && ts && (tsEnd - ts) > 3 * 86400;
        results.push({
          symbol: q.symbol,
          name: q.shortName || q.symbol,
          earningsDate: ts ? new Date(ts * 1000).toISOString().split('T')[0] : null,
          estimated: !!estimated,
          sector: q.sector || null,
        });
      }
    } catch (e) { console.warn('Earnings calendar batch error:', e.message); }
    if (i + BATCH < TOP100_SYMBOLS.length) await new Promise(r => setTimeout(r, 200));
  }
  earningsCalCache = { data: results, fetchedAt: Date.now() };
  return results;
}

// Fallback: fetch earnings date per symbol using yfEarningsDate (slower but reliable)
async function fetchEarningsCalendarFallback() {
  const CONCURRENCY = 5;
  const results = [];
  for (let i = 0; i < TOP100_SYMBOLS.length; i += CONCURRENCY) {
    const batch = TOP100_SYMBOLS.slice(i, i + CONCURRENCY);
    const batchRes = await Promise.all(batch.map(async sym => {
      const date = await yfEarningsDate(sym).catch(() => null);
      return { symbol: sym, name: sym, earningsDate: date ? date.toISOString().split('T')[0] : null, estimated: false, sector: null };
    }));
    results.push(...batchRes);
    if (i + CONCURRENCY < TOP100_SYMBOLS.length) await new Promise(r => setTimeout(r, 200));
  }
  earningsCalCache = { data: results, fetchedAt: Date.now() };
  return results;
}

app.get('/api/earnings-calendar', async (req, res) => {
  try { res.json(await fetchEarningsCalendar()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Gemini AI features ──────────────────────────────────────────────────────
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_URL = GEMINI_API_KEY
  ? `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-lite:generateContent?key=${GEMINI_API_KEY}`
  : null;

async function callGemini(prompt, maxTokens = 400) {
  if (!GEMINI_URL) return null;
  const res = await fetch(GEMINI_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.3, maxOutputTokens: maxTokens },
    }),
  });
  if (!res.ok) throw new Error(`Gemini ${res.status}`);
  const json = await res.json();
  return json.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || null;
}

// ── News Summary (Market Pulse) — 2h cache ──
const newsSummaryCache = { data: null, fetchedAt: 0 };
const NEWS_SUMMARY_TTL = 2 * 60 * 60 * 1000;

app.get('/api/news-summary', async (req, res) => {
  if (newsSummaryCache.data && (Date.now() - newsSummaryCache.fetchedAt) < NEWS_SUMMARY_TTL) {
    return res.json(newsSummaryCache.data);
  }
  const articles = (latestNewsCache.data || []).slice(0, 30);
  if (!articles.length) return res.json({ available: false });

  // Without Gemini: return top 5 headlines as a simple "pulse"
  if (!GEMINI_URL) {
    const top5 = articles.slice(0, 5).map(a => a.title);
    const summary = { available: true, aiPowered: false, bullets: top5, sentiment: null, generatedAt: new Date().toISOString() };
    newsSummaryCache.data = summary; newsSummaryCache.fetchedAt = Date.now();
    return res.json(summary);
  }

  try {
    const headlines = articles.map((a, i) => `${i + 1}. ${a.title}`).join('\n');
    const prompt = `You are a senior financial analyst. From these market headlines, identify the TOP 5 most important and market-impactful stories. For each, write ONE concise sentence explaining the story and its market impact.\n\nHeadlines:\n${headlines}\n\nRespond ONLY with this exact JSON (no markdown, no extra text):\n{"bullets":["story 1 + why it matters","story 2 + why it matters","story 3 + why it matters","story 4 + why it matters","story 5 + why it matters"],"sentiment":"Bullish","sentimentReason":"one short sentence explaining overall market tone"}`;
    const text = await callGemini(prompt, 500);
    const match = text?.match(/\{[\s\S]*\}/);
    if (!match) return res.json({ available: false });
    const summary = { ...JSON.parse(match[0]), available: true, aiPowered: true, generatedAt: new Date().toISOString() };
    newsSummaryCache.data = summary; newsSummaryCache.fetchedAt = Date.now();
    res.json(summary);
  } catch (e) {
    console.warn('News summary error:', e.message);
    res.json({ available: false });
  }
});

// ── Crypto News Summary (Crypto Pulse) — 2h cache ──
const cryptoSummaryCache = { data: null, fetchedAt: 0 };
const CRYPTO_SUMMARY_TTL = 2 * 60 * 60 * 1000;

app.get('/api/crypto-news-summary', async (req, res) => {
  if (cryptoSummaryCache.data && (Date.now() - cryptoSummaryCache.fetchedAt) < CRYPTO_SUMMARY_TTL) {
    return res.json(cryptoSummaryCache.data);
  }
  const articles = (cryptoNewsCache.data || []).slice(0, 30);
  if (!articles.length) return res.json({ available: false });

  // Without Gemini: return top 5 headlines
  if (!GEMINI_URL) {
    const top5 = articles.slice(0, 5).map(a => a.title);
    const summary = { available: true, aiPowered: false, bullets: top5, sentiment: null, generatedAt: new Date().toISOString() };
    cryptoSummaryCache.data = summary; cryptoSummaryCache.fetchedAt = Date.now();
    return res.json(summary);
  }

  try {
    const headlines = articles.map((a, i) => `${i + 1}. ${a.title}`).join('\n');
    const prompt = `You are a senior crypto market analyst. From these crypto headlines, identify the TOP 5 most important stories that could impact Bitcoin, Ethereum, and the broader crypto market. For each, write ONE concise sentence explaining the story and its crypto market impact.\n\nHeadlines:\n${headlines}\n\nRespond ONLY with this exact JSON (no markdown, no extra text):\n{"bullets":["story 1 + why it matters","story 2 + why it matters","story 3 + why it matters","story 4 + why it matters","story 5 + why it matters"],"sentiment":"Bullish","sentimentReason":"one short sentence explaining overall crypto market tone"}`;
    const text = await callGemini(prompt, 500);
    const match = text?.match(/\{[\s\S]*\}/);
    if (!match) return res.json({ available: false });
    const summary = { ...JSON.parse(match[0]), available: true, aiPowered: true, generatedAt: new Date().toISOString() };
    cryptoSummaryCache.data = summary; cryptoSummaryCache.fetchedAt = Date.now();
    res.json(summary);
  } catch (e) {
    console.warn('Crypto summary error:', e.message);
    res.json({ available: false });
  }
});

// ── Crypto Why Moving — 4h cache per coin ──
const cryptoWhyMovingCache = {};
const CRYPTO_WHY_TTL = 4 * 60 * 60 * 1000;

function guessCryptoWhyMoving(title, change) {
  const t = (title || '').toLowerCase();
  if (/etf|spot etf|approval|approved/.test(t)) return change >= 0 ? 'ETF news' : 'ETF setback';
  if (/hack|exploit|breach|stolen/.test(t)) return 'Security breach';
  if (/sec|lawsuit|ban|illegal|crackdown/.test(t)) return 'Regulatory news';
  if (/upgrade|bullish|buy|outperform/.test(t)) return 'Analyst upgrade';
  if (/downgrade|bearish|sell/.test(t)) return 'Analyst downgrade';
  if (/partnership|integration|adoption/.test(t)) return 'Adoption news';
  if (/liquidat|short squeeze|long squeeze/.test(t)) return 'Liquidation cascade';
  if (/halving|fork|upgrade|mainnet/.test(t)) return 'Protocol event';
  if (/whale|large transfer|fund/.test(t)) return 'Whale activity';
  if (/fed|rate|inflation|macro/.test(t)) return 'Macro driver';
  return null;
}

app.get('/api/crypto/:id/why-moving', async (req, res) => {
  const id = req.params.id.toLowerCase();
  const change = parseFloat(req.query.change) || 0;
  const symbol = (req.query.symbol || '').toUpperCase();
  const name = (req.query.name || '').toLowerCase();
  if (Math.abs(change) < 5) return res.json({ reason: null });

  const cached = cryptoWhyMovingCache[id];
  if (cached && (Date.now() - cached.fetchedAt) < CRYPTO_WHY_TTL) {
    return res.json({ reason: cached.reason });
  }
  try {
    const all = cryptoNewsCache.data || [];
    const relevant = all.filter(a => {
      const t = (a.title || '').toLowerCase();
      return (symbol && t.includes(symbol.toLowerCase())) || (name && t.includes(name));
    }).slice(0, 6);

    if (!relevant.length) {
      // Try broader crypto market news as context
      const broad = all.slice(0, 5);
      if (!broad.length) { cryptoWhyMovingCache[id] = { reason: null, fetchedAt: Date.now() }; return res.json({ reason: null }); }
      const fallback = guessCryptoWhyMoving(broad[0].title, change);
      cryptoWhyMovingCache[id] = { reason: fallback, fetchedAt: Date.now() };
      return res.json({ reason: fallback });
    }

    let reason = null;
    if (GEMINI_URL) {
      const headlines = relevant.map(a => `- ${a.title}`).join('\n');
      const dir = change >= 0 ? `up ${change.toFixed(1)}%` : `down ${Math.abs(change).toFixed(1)}%`;
      const prompt = `Crypto ${symbol || id} is ${dir} today. Give a VERY SHORT reason (3-5 words max) based on these headlines. Only output the short phrase, nothing else.\n\nHeadlines:\n${headlines}`;
      const text = await callGemini(prompt, 25);
      reason = text?.replace(/["""*]/g, '').trim() || null;
    }
    if (!reason) reason = guessCryptoWhyMoving(relevant[0].title, change);

    cryptoWhyMovingCache[id] = { reason, fetchedAt: Date.now() };
    res.json({ reason });
  } catch (e) {
    res.json({ reason: null });
  }
});

// ── Why Moving badge — 4h cache per symbol ──
const whyMovingCache = {};
const WHY_MOVING_TTL = 4 * 60 * 60 * 1000;

// Keyword-based fallback when Gemini is not configured
function guessWhyMoving(title, change) {
  const t = (title || '').toLowerCase();
  if (/earnings|beat|beats|eps|revenue|quarterly results/.test(t)) return change >= 0 ? 'Earnings beat' : 'Earnings miss';
  if (/guidance|raised guidance|lowered guidance|outlook|forecast/.test(t)) return change >= 0 ? 'Raised guidance' : 'Lowered guidance';
  if (/upgrade|outperform|buy rating|overweight/.test(t)) return 'Analyst upgrade';
  if (/downgrade|underperform|sell rating|underweight/.test(t)) return 'Analyst downgrade';
  if (/tariff|tariffs|trade war|sanction|trade tension/.test(t)) return 'Trade tensions';
  if (/merger|acqui|buyout|takeover/.test(t)) return 'M&A activity';
  if (/fda|drug approval|trial|clinical/.test(t)) return 'Drug/FDA news';
  if (/sec|lawsuit|fraud|investigation|fine|penalty/.test(t)) return 'Regulatory news';
  if (/layoff|job cut|restructur/.test(t)) return 'Restructuring news';
  if (/dividend|buyback|split/.test(t)) return change >= 0 ? 'Shareholder return' : 'Capital event';
  if (/ipo|listing|offering/.test(t)) return 'New offering';
  if (/fed|interest rate|powell|fomc/.test(t)) return 'Fed/rate news';
  return null;
}

app.get('/api/stock/:symbol/why-moving', async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  const change = parseFloat(req.query.change) || 0;
  if (Math.abs(change) < 1.5) return res.json({ reason: null });

  const cached = whyMovingCache[symbol];
  if (cached && (Date.now() - cached.fetchedAt) < WHY_MOVING_TTL) {
    return res.json({ reason: cached.reason });
  }
  try {
    const all = latestNewsCache.data || [];
    const relevant = all.filter(a => (a.title || '').toUpperCase().includes(symbol)).slice(0, 6);

    if (!relevant.length) {
      whyMovingCache[symbol] = { reason: null, fetchedAt: Date.now() };
      return res.json({ reason: null });
    }

    // Try Gemini first; fall back to keyword heuristic
    let reason = null;
    if (GEMINI_URL) {
      const headlines = relevant.map(a => `- ${a.title}`).join('\n');
      const dir = change >= 0 ? `up ${change.toFixed(1)}%` : `down ${Math.abs(change).toFixed(1)}%`;
      const prompt = `Stock ${symbol} is ${dir} today. Give a VERY SHORT reason (3-5 words max) based on these headlines. Only output the short phrase, nothing else.\n\nHeadlines:\n${headlines}`;
      const text = await callGemini(prompt, 25);
      reason = text?.replace(/["""*]/g, '').trim() || null;
    }
    if (!reason) reason = guessWhyMoving(relevant[0].title, change);

    whyMovingCache[symbol] = { reason, fetchedAt: Date.now() };
    res.json({ reason });
  } catch (e) {
    res.json({ reason: null });
  }
});

app.get('/api/crypto', async (req, res) => {
  try { res.json(await fetchCryptoData()); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// ─── CRYPTO CHART — KuCoin public API (free, no key, US-accessible) ──────────
// KuCoin candles: data is newest-first, close price at index 2, timestamps in seconds
async function fetchKuCoinPrices(symbol, startAt, endAt, type = '1day') {
  const url = `https://api.kucoin.com/api/v1/market/candles?type=${type}&symbol=${symbol}-USDT&startAt=${startAt}&endAt=${endAt}`;
  const r = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(12000) });
  if (!r.ok) throw new Error(`KuCoin ${r.status}`);
  const json = await r.json();
  if (json.code !== '200000' || !Array.isArray(json.data) || json.data.length < 2) throw new Error('No KuCoin data');
  // Reverse to chronological order; close is index 2
  return { prices: json.data.slice().reverse().map(k => parseFloat(k[2])).filter(v => v > 0), firstTs: parseInt(json.data[json.data.length - 1][0]) * 1000 };
}

const cryptoChartCache = {};
app.get('/api/crypto/:id/chart', async (req, res) => {
  const { id } = req.params;
  const { range = '7d' } = req.query;
  const now = new Date();
  const cacheKey = `${id}_${range}`;
  const cached = cryptoChartCache[cacheKey];
  const cacheTTL = range === '1d' ? 60 * 1000 : 10 * 60 * 1000;
  if (cached && (Date.now() - cached.at) < cacheTTL) return res.json(cached.data);

  const symbol = id.split('-')[0].toUpperCase();
  const nowTs = Math.floor(Date.now() / 1000);
  const ytdDays = Math.ceil((now - new Date(now.getFullYear(), 0, 1)) / 86400000) || 1;
  const LIMIT_MAP = { '7d': 7, '30d': 30, '90d': 90, '180d': 180, 'ytd': ytdDays, '365d': 365, '1y': 365, '730d': 730, '2y': 730, '3y': 1095, '5y': 1825 };

  try {
    let prices = [];

    if (range === '1d') {
      // Intraday: 1h candles for last 24 hours
      try {
        const { prices: p } = await fetchKuCoinPrices(symbol, nowTs - 86400, nowTs, '1hour');
        prices = p;
      } catch {}
    } else {
      const limit = LIMIT_MAP[range];
      if (!limit) return res.status(400).json({ error: 'Invalid range' });
      const startAt = nowTs - limit * 86400;

      try {
        if (limit <= 1500) {
          const { prices: p } = await fetchKuCoinPrices(symbol, startAt, nowTs);
          prices = p;
        } else {
          // 5Y (1825d): two sequential calls to avoid hitting 1500-candle limit
          const midTs = nowTs - 1500 * 86400;
          const [{ prices: older }, { prices: recent }] = await Promise.all([
            fetchKuCoinPrices(symbol, startAt, midTs),
            fetchKuCoinPrices(symbol, midTs, nowTs),
          ]);
          prices = [...older, ...recent];
        }
      } catch {}
    }

    if (prices.length < 2) return res.status(500).json({ error: 'No chart data available' });
    cryptoChartCache[cacheKey] = { data: prices, at: Date.now() };
    res.json(prices);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── CRYPTO INCEPTION (Since ICO) ────────────────────────────────────────────
const cryptoInceptionCache = {};
app.get('/api/crypto/:id/inception', async (req, res) => {
  const { id } = req.params;
  const cached = cryptoInceptionCache[id];
  if (cached && (Date.now() - cached.at) < 24 * 60 * 60 * 1000) return res.json(cached.data);
  const symbol = id.split('-')[0].toUpperCase();
  const nowTs = Math.floor(Date.now() / 1000);

  try {
    // KuCoin weekly candles from Jan 2010 — 1500 weeks covers ~29 years (full crypto history)
    const CRYPTO_GENESIS = 1262304000; // 2010-01-01 in seconds
    const { prices, firstTs } = await fetchKuCoinPrices(symbol, CRYPTO_GENESIS, nowTs, '1week');
    if (prices.length < 2) throw new Error('Not enough data');
    const change = ((prices[prices.length - 1] - prices[0]) / prices[0]) * 100;
    const d = new Date(firstTs);
    const listedDate = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
    const result = { change, listedDate };
    cryptoInceptionCache[id] = { data: result, at: Date.now() };
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── CRYPTO NEWS (CryptoCompare API primary + multi-source RSS) ──────────────
const cryptoNewsCache = { data: null, at: 0 };

// Helper: parse a basic RSS feed and return articles
function parseCryptoRSS(xml, source) {
  const items = [...xml.matchAll(/<item[\s\S]*?<\/item>/g)].slice(0, 12);
  const result = [];
  for (const [item] of items) {
    const titleRaw = (item.match(/<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>/) || item.match(/<title>([\s\S]*?)<\/title>/))?.[1]?.trim();
    const title = decodeHtmlEntities(titleRaw);
    const link = (item.match(/<link>(.*?)<\/link>/) || item.match(/<guid[^>]*isPermaLink[^>]*>(https?:\/\/[^<]+)<\/guid>/) || item.match(/<guid[^>]*>(https?:\/\/[^<]+)<\/guid>/))?.[1]?.trim();
    const pubDate = item.match(/<pubDate>(.*?)<\/pubDate>/)?.[1]?.trim();
    if (title && link) result.push({ title, link, source, publishedAt: pubDate ? new Date(pubDate).toISOString() : null });
  }
  return result;
}

async function fetchCryptoNews() {
  if (cryptoNewsCache.data && (Date.now() - cryptoNewsCache.at) < 8 * 60 * 1000) return cryptoNewsCache.data;
  let articles = [];

  // ── Source 1: CryptoCompare News API — free, no key, confirmed cloud-friendly ──
  try {
    const r = await fetch('https://min-api.cryptocompare.com/data/v2/news/?lang=EN&limit=50', {
      headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(8000),
    });
    if (r.ok) {
      const json = await r.json();
      (json.Data || []).forEach(item => {
        if (item.title && item.url) articles.push({
          title: decodeHtmlEntities(item.title), link: item.url,
          source: item.source_info?.name || item.source || 'CryptoCompare',
          imageUrl: item.imageurl || null,
          publishedAt: item.published_on ? new Date(item.published_on * 1000).toISOString() : null,
        });
      });
    }
  } catch (_) {}

  // ── Source 2: Google News RSS for crypto topics — reliable from any cloud IP ──
  const cryptoGoogleFeeds = [
    { url: 'https://news.google.com/rss/search?q=bitcoin+ethereum+cryptocurrency&hl=en-US&gl=US&ceid=US:en', source: 'Google News' },
    { url: 'https://news.google.com/rss/search?q=crypto+blockchain+defi+altcoin&hl=en-US&gl=US&ceid=US:en', source: 'Google News' },
    { url: 'https://news.google.com/rss/search?q=BTC+ETH+crypto+market+price&hl=en-US&gl=US&ceid=US:en', source: 'Google News' },
  ];
  await Promise.allSettled(cryptoGoogleFeeds.map(async f => {
    try {
      const r = await fetch(f.url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)' },
        signal: AbortSignal.timeout(8000),
      });
      if (r.ok) articles.push(...parseCryptoRSS(await r.text(), f.source));
    } catch (_) {}
  }));

  // ── Source 3: Top crypto news site RSS feeds ──
  const cryptoRssFeeds = [
    { url: 'https://cointelegraph.com/rss', source: 'CoinTelegraph' },
    { url: 'https://www.coindesk.com/arc/outboundfeeds/rss/', source: 'CoinDesk' },
    { url: 'https://decrypt.co/feed', source: 'Decrypt' },
    { url: 'https://bitcoinmagazine.com/.rss/full/', source: 'Bitcoin Magazine' },
    { url: 'https://thedefiant.io/feed', source: 'The Defiant' },
    { url: 'https://blockworks.co/feed', source: 'Blockworks' },
    { url: 'https://beincrypto.com/feed/', source: 'BeInCrypto' },
    { url: 'https://ambcrypto.com/feed/', source: 'AMBCrypto' },
  ];
  await Promise.allSettled(cryptoRssFeeds.map(async f => {
    try {
      const r = await fetch(f.url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
        signal: AbortSignal.timeout(6000),
      });
      if (r.ok) articles.push(...parseCryptoRSS(await r.text(), f.source));
    } catch (_) {}
  }));

  // ── Source 4: X / Twitter via Nitter RSS — top crypto accounts ──
  // Nitter is a free Twitter frontend; availability varies — silently skip if down
  const nitterInstances = ['https://nitter.privacydev.net', 'https://nitter.poast.org'];
  const cryptoXAccounts = ['CoinDesk', 'Cointelegraph', 'bitcoin', 'VitalikButerin', 'APompliano', 'DocumentingBTC'];
  const nitter = nitterInstances[Math.floor(Math.random() * nitterInstances.length)];
  await Promise.allSettled(cryptoXAccounts.slice(0, 4).map(async handle => {
    try {
      const r = await fetch(`${nitter}/${handle}/rss`, {
        headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(5000),
      });
      if (r.ok) {
        const parsed = parseCryptoRSS(await r.text(), `X @${handle}`);
        // Only keep tweets with crypto-relevant content
        const cryptoKw = /bitcoin|btc|eth|crypto|blockchain|defi|nft|coin|token|solana|binance/i;
        articles.push(...parsed.filter(a => cryptoKw.test(a.title)));
      }
    } catch (_) {}
  }));

  // Dedupe and sort
  articles.sort((a, b) => new Date(b.publishedAt || 0) - new Date(a.publishedAt || 0));
  const seen = new Set();
  const fresh = articles.filter(a => {
    if (!a.title) return false;
    const k = a.title.slice(0, 60);
    if (seen.has(k)) return false;
    seen.add(k); return true;
  }).slice(0, 80);

  if (fresh.length > 0) {
    cryptoNewsCache.data = fresh;
    cryptoNewsCache.at = Date.now();
    console.log(`Crypto news: fetched ${fresh.length} articles from ${[...new Set(fresh.map(a => a.source))].length} sources`);
  } else if (cryptoNewsCache.data?.length) {
    console.warn('Crypto news: all sources failed, returning stale cache');
  }
  return cryptoNewsCache.data || [];
}

app.get('/api/crypto/news', async (req, res) => {
  try { res.json(await fetchCryptoNews()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/market-index', async (req, res) => {
  try { res.json(await fetchMarketIndex()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/sectors', async (req, res) => {
  try {
    const data = await fetchSectorData();
    res.json({ sectors: data, available: SECTOR_AVAILABLE });
  }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/news/latest', async (req, res) => {
  try {
    // Accept extra symbols from query param
    const qSymbols = req.query.symbols ? req.query.symbols.split(',').map(s => s.trim().toUpperCase()) : [];
    const alertSymbols = [...new Set(alerts.map(a => a.symbol))];
    const allSymbols = [...new Set([...alertSymbols, ...qSymbols])];
    const xHandles = settings.xHandles || [];
    const forceRefresh = req.query.refresh === '1';
    res.json(await fetchLatestNews(allSymbols, xHandles, forceRefresh));
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ─── ALERT ROUTES ─────────────────────────────────────────────────────────────

app.get('/api/alerts', (req, res) => res.json(alerts));

// Single alert (backward compat)
app.post('/api/alerts', async (req, res) => {
  const { symbol, conditionType, conditionValue, notificationMethods, repeatAlert, customName } = req.body;
  if (!symbol || !conditionType || conditionValue === undefined || !notificationMethods?.length) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  try {
    const quote = await yfQuote(symbol.toUpperCase());
    const alert = makeAlert(symbol.toUpperCase(), customName || quote.name, conditionType, conditionValue, quote.price, notificationMethods, repeatAlert);
    alerts.push(alert);
    stockCache[alert.symbol] = { ...quote, lastUpdated: Date.now() };
    saveData();
    res.status(201).json(alert);
  } catch (error) {
    res.status(400).json({ error: 'Invalid symbol or could not fetch price' });
  }
});

// Batch alerts (multiple conditions at once)
app.post('/api/alerts/batch', async (req, res) => {
  const { symbol, conditions, notificationMethods, repeatAlert, customName } = req.body;
  if (!symbol || !conditions?.length || !notificationMethods?.length) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  try {
    const quote = await yfQuote(symbol.toUpperCase());
    const created = [];
    for (const c of conditions) {
      if (!c.conditionType || c.conditionValue === undefined) continue;
      const alert = makeAlert(symbol.toUpperCase(), customName || quote.name, c.conditionType, c.conditionValue, quote.price, notificationMethods, repeatAlert);
      alerts.push(alert);
      created.push(alert);
    }
    stockCache[symbol.toUpperCase()] = { ...quote, lastUpdated: Date.now() };
    saveData();
    res.status(201).json(created);
  } catch (error) {
    res.status(400).json({ error: 'Invalid symbol or could not fetch price' });
  }
});

function makeAlert(symbol, name, conditionType, conditionValue, basePrice, notificationMethods, repeatAlert) {
  return {
    id: uuidv4(), symbol, name, conditionType,
    conditionValue: parseFloat(conditionValue), basePrice,
    notificationMethods, repeatAlert: !!repeatAlert,
    isActive: true, createdAt: new Date().toISOString(),
    lastTriggered: null, triggeredCount: 0,
  };
}

app.delete('/api/alerts/:id', (req, res) => {
  const idx = alerts.findIndex(a => a.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Alert not found' });
  alerts.splice(idx, 1); saveData();
  res.json({ success: true });
});

app.put('/api/alerts/:id/toggle', (req, res) => {
  const alert = alerts.find(a => a.id === req.params.id);
  if (!alert) return res.status(404).json({ error: 'Alert not found' });
  alert.isActive = !alert.isActive; saveData();
  res.json(alert);
});

// ─── SETTINGS ROUTES ──────────────────────────────────────────────────────────

app.get('/api/settings', (req, res) => {
  res.json({
    emailEnabled: settings.emailEnabled, emailAddress: settings.emailAddress, emailFrom: settings.emailFrom,
    smsEnabled: settings.smsEnabled, phoneNumber: settings.phoneNumber,
    twilioPhoneNumber: settings.twilioPhoneNumber,
    twilioAccountSid: settings.twilioAccountSid ? settings.twilioAccountSid.slice(0, 4) + '****' + settings.twilioAccountSid.slice(-4) : '',
    checkIntervalMinutes: settings.checkIntervalMinutes,
    hasEmailPassword: !!settings.emailPassword,
    hasTwilioCredentials: !!(settings.twilioAccountSid && settings.twilioAuthToken),
    xHandles: settings.xHandles || [],
    dashboardOrder: settings.dashboardOrder || [],
  });
});

app.put('/api/settings', (req, res) => {
  const update = { ...req.body };
  if (update.emailPassword === '' && settings.emailPassword) delete update.emailPassword;
  if (update.twilioAuthToken === '' && settings.twilioAuthToken) delete update.twilioAuthToken;
  if (update.twilioAccountSid?.includes('****')) delete update.twilioAccountSid;
  settings = { ...settings, ...update }; saveData();
  if (update.checkIntervalMinutes !== undefined) restartCron();
  res.json({ success: true });
});

// ─── DASHBOARD ORDER ──────────────────────────────────────────────────────────

app.put('/api/dashboard/order', (req, res) => {
  const { order } = req.body;
  if (!Array.isArray(order)) return res.status(400).json({ error: 'order must be an array' });
  settings.dashboardOrder = order;
  saveData();
  res.json({ success: true });
});

// ─── HISTORY ROUTES ───────────────────────────────────────────────────────────

app.get('/api/history', (req, res) => res.json(notificationHistory.slice(0, 100)));
app.delete('/api/history', (req, res) => { notificationHistory = []; saveData(); res.json({ success: true }); });

// ─── TEST NOTIFICATIONS ───────────────────────────────────────────────────────

app.post('/api/test/email', async (req, res) => {
  try { await sendEmail('Test Alert', 'Email notifications configured correctly! ✅'); res.json({ success: true, message: 'Test email sent!' }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/test/sms', async (req, res) => {
  try { await sendSMS('📈 Stock Tracker Test: SMS working! ✅'); res.json({ success: true, message: 'Test SMS sent!' }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// ─── NOTIFICATION HELPERS ─────────────────────────────────────────────────────

async function sendEmail(subject, message) {
  if (!settings.emailEnabled || !settings.emailAddress || !settings.emailFrom || !settings.emailPassword)
    throw new Error('Email not fully configured.');
  const transporter = nodemailer.createTransport({ service: 'gmail', auth: { user: settings.emailFrom, pass: settings.emailPassword } });
  await transporter.sendMail({
    from: `"Stock Tracker 📈" <${settings.emailFrom}>`, to: settings.emailAddress, subject: `🔔 ${subject}`,
    html: `<div style="font-family:-apple-system,Arial,sans-serif;max-width:600px;margin:0 auto;background:#0d1117;color:#c9d1d9;border-radius:12px;overflow:hidden;border:1px solid #30363d"><div style="background:linear-gradient(135deg,#4361ee,#4cc9f0);padding:28px 32px"><h1 style="margin:0;font-size:22px;color:#fff">📈 Stock Alert!</h1></div><div style="padding:28px 32px"><p style="font-size:16px;line-height:1.6;color:#c9d1d9;margin:0 0 24px">${message}</p><div style="background:#161b22;border-radius:8px;padding:14px 16px;font-size:12px;color:#6e7681;border:1px solid #30363d">Stock Volatility Tracker · ${new Date().toLocaleString()}</div></div></div>`,
  });
}

async function sendSMS(message) {
  if (!settings.smsEnabled || !settings.phoneNumber || !settings.twilioAccountSid || !settings.twilioAuthToken)
    throw new Error('SMS not fully configured.');
  const client = twilio(settings.twilioAccountSid, settings.twilioAuthToken);
  await client.messages.create({ body: message, from: settings.twilioPhoneNumber, to: settings.phoneNumber });
}

// ─── ALERT LOGIC ──────────────────────────────────────────────────────────────

function checkCondition(alert, price) {
  const { conditionType, conditionValue: val, basePrice } = alert;
  const pct = ((price - basePrice) / basePrice) * 100;
  const abs = price - basePrice;
  switch (conditionType) {
    case 'percent_up':      return pct >= val;
    case 'percent_down':    return pct <= -val;
    case 'price_above':     return price >= val;
    case 'price_below':     return price <= val;
    case 'abs_up':          return abs >= val;
    case 'abs_down':        return abs <= -val;
    case 'earnings_before': return false; // handled separately
    default: return false;
  }
}

function conditionLabel(type, val) {
  switch (type) {
    case 'percent_up':      return `rises ≥ +${val}%`;
    case 'percent_down':    return `falls ≥ −${val}%`;
    case 'price_above':     return `price ≥ $${val}`;
    case 'price_below':     return `price ≤ $${val}`;
    case 'abs_up':          return `rises ≥ +$${val}`;
    case 'abs_down':        return `falls ≥ −$${val}`;
    case 'earnings_before': return `${val} day(s) before earnings`;
    default: return '';
  }
}

function buildMessage(alert, price) {
  if (alert.conditionType === 'earnings_before') return ''; // earnings has its own message
  const pct = ((price - alert.basePrice) / alert.basePrice) * 100;
  const sign = pct >= 0 ? '+' : '';
  return `${alert.symbol} (${alert.name}) — "${conditionLabel(alert.conditionType, alert.conditionValue)}" met. Current: $${price.toFixed(2)} (${sign}${pct.toFixed(2)}% from base $${alert.basePrice.toFixed(2)})`;
}

function fireNotification(alert, message) {
  const notification = {
    id: uuidv4(), alertId: alert.id, symbol: alert.symbol, name: alert.name,
    message, conditionType: alert.conditionType, conditionValue: alert.conditionValue,
    timestamp: new Date().toISOString(), methods: alert.notificationMethods,
  };
  notificationHistory.unshift(notification);
  if (notificationHistory.length > 200) notificationHistory.length = 200;

  if (alert.notificationMethods.includes('popup')) io.emit('alertTriggered', notification);
  if (alert.notificationMethods.includes('email')) sendEmail(`${alert.symbol} Alert!`, message).catch(e => console.error('Email:', e.message));
  if (alert.notificationMethods.includes('sms'))   sendSMS(`📈 ${message}`).catch(e => console.error('SMS:', e.message));

  alert.lastTriggered = new Date().toISOString();
  alert.triggeredCount++;
  if (!alert.repeatAlert) alert.isActive = false;
  saveData();
  io.emit('alertUpdated', alert);
  console.log(`🔔 ${message}`);
}

// ─── BACKGROUND CHECKER ───────────────────────────────────────────────────────

let cronJob = null;

function isServerMarketHours() {
  const now = new Date();
  const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const day = et.getDay();
  if (day === 0 || day === 6) return false;
  const h = et.getHours(), m = et.getMinutes();
  const mins = h * 60 + m;
  return mins >= 240 && mins <= 1200; // 4:00 AM to 8:00 PM ET
}

function restartCron() {
  if (cronJob) cronJob.stop();
  // During market hours: check every 1 min. Off-hours: every 30 min (still gets pre/post data)
  const marketOpen = isServerMarketHours();
  const mins = marketOpen ? 1 : 30;
  const expr = mins === 1 ? '* * * * *' : `*/${mins} * * * *`;
  cronJob = cron.schedule(expr, checkAlerts);
  console.log(`⏱  Checking every ${mins} minute(s) [market ${marketOpen ? 'OPEN' : 'CLOSED'}]`);
}

// Re-evaluate cron interval every 15 minutes (catches market open/close transitions)
setInterval(() => {
  restartCron();
}, 15 * 60 * 1000);

async function checkAlerts() {
  const active = alerts.filter(a => a.isActive);
  if (!active.length) return;

  const symbols = [...new Set(active.map(a => a.symbol))];

  for (const symbol of symbols) {
    try {
      const quote = await yfQuote(symbol);
      const price = quote.price;

      stockCache[symbol] = { ...stockCache[symbol], ...quote, lastUpdated: Date.now() };
      // Send full quote so client can populate name, volume, type, etc. on first load
      io.emit('priceUpdate', { ...stockCache[symbol], timestamp: Date.now() });

      // ── Price-based alerts ──
      for (const alert of active.filter(a => a.symbol === symbol && a.conditionType !== 'earnings_before')) {
        if (!checkCondition(alert, price)) continue;
        fireNotification(alert, buildMessage(alert, price));
      }

      // ── Earnings-based alerts ──
      const earningsAlerts = active.filter(a => a.symbol === symbol && a.conditionType === 'earnings_before');
      if (earningsAlerts.length) {
        try {
          const earningsDate = await yfEarningsDate(symbol);
          if (earningsDate) {
            const daysUntil = (earningsDate - new Date()) / (1000 * 60 * 60 * 24);
            for (const alert of earningsAlerts) {
              if (daysUntil <= alert.conditionValue && daysUntil >= 0) {
                const msg = `${alert.symbol} (${alert.name}) — Earnings in ~${Math.round(daysUntil)} day(s) on ${earningsDate.toLocaleDateString()}. Alert threshold: ${alert.conditionValue} day(s).`;
                fireNotification(alert, msg);
              }
            }
          }
        } catch (e) { console.error(`Earnings check error for ${symbol}:`, e.message); }
      }
    } catch (err) {
      console.error(`Error checking ${symbol}:`, err.message);
    }
  }
  saveData();
}

// ─── SOCKET.IO ────────────────────────────────────────────────────────────────

io.on('connection', socket => {
  console.log('🔌 Connected:', socket.id);
  socket.emit('init', { alerts, stockCache, notificationHistory: notificationHistory.slice(0, 50) });
  socket.on('disconnect', () => console.log('🔌 Disconnected:', socket.id));
});

// ─── START ────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🚀 Stock Volatility Tracker → http://localhost:${PORT}\n`);
  restartCron();
  if (alerts.length > 0) setTimeout(checkAlerts, 2000);
  // Pre-warm all caches so first client request never waits
  setTimeout(() => {
    Promise.allSettled([fetchRSSNews(), fetchCryptoNews(), fetchEconCalendar()])
      .then(results => {
        const [rss, crypto, econ] = results;
        console.log(`📰 RSS news: ${rss.status === 'fulfilled' ? rssCache.data?.length + ' articles' : 'FAILED'}`);
        console.log(`₿  Crypto news: ${crypto.status === 'fulfilled' ? cryptoNewsCache.data?.length + ' articles' : 'FAILED'}`);
        console.log(`📅 Econ calendar: ${econ.status === 'fulfilled' ? econCalCache.data?.length + ' events' : 'FAILED'}`);
      });
  }, 2000);

  // Background auto-refresh — keeps caches warm even without client requests
  // RSS news every 15 min, crypto news every 10 min
  setInterval(() => fetchRSSNews().catch(() => {}), 15 * 60 * 1000);
  setInterval(() => fetchCryptoNews().catch(() => {}), 10 * 60 * 1000);
  setInterval(() => fetchEconCalendar().catch(() => {}), 30 * 60 * 1000);
});
