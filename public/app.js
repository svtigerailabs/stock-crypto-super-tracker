/* ─── STATE ───────────────────────────────────────────────────── */
const state = {
  alerts: [], stocks: {}, history: [], settings: {},
  profiles: {}, hoverCache: {},
  view: 'dashboard', selectedSymbol: null, searchTimeout: null,
  dashViewMode: 'grid', cryptoViewMode: 'grid', cryptoData: [],
  cryptoEditMode: false, cryptoChartPeriod: '7d', cryptoCharts: {},
  hiddenCryptoIds: JSON.parse(localStorage.getItem('hiddenCryptoIds') || '[]'),
  pinnedCryptoIds: JSON.parse(localStorage.getItem('pinnedCryptoIds') || '[]'),
  stockChartPeriod: '1mo', stockCharts: {},
  alertsMuted: localStorage.getItem('alertsMuted') === 'true',
};
let socket = null;
const NUM_CONDITION_ROWS = 6;

/* ─── INIT ────────────────────────────────────────────────────── */
async function init() {
  if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission();
  try {
    const [alerts, settings, history] = await Promise.all([
      api('GET', '/alerts'), api('GET', '/settings'), api('GET', '/history'),
    ]);
    state.alerts = alerts; state.settings = settings; state.history = history;
  } catch (e) { console.warn('Init load failed:', e.message); }

  buildConditionRows();
  initSocket();
  renderAll();
  applySettings(state.settings);
  updateMuteBtn();

  // Load market index bar
  loadMarketIndex();
  // Refresh every 30 seconds
  setInterval(loadMarketIndex, 30000);

  // Headline tickers
  initHeadlineTickers().then(() => {
    startTickerRotation('stock', 12);
    startTickerRotation('crypto', 12);
  });
}

/* ─── BUILD CONDITION ROWS (6 checkboxes, first two ON by default) ─── */
const COND_DEFS = [
  { type: 'percent_down', label: 'Falls by',    unit: '%', val: '5', on: true },
  { type: 'percent_up',   label: 'Rises by',    unit: '%', val: '5', on: true },
  { type: 'price_below',  label: 'Price below', unit: '$', val: '',  on: false },
  { type: 'price_above',  label: 'Price above', unit: '$', val: '',  on: false },
  { type: 'abs_down',     label: 'Falls by $',  unit: '$', val: '',  on: false },
  { type: 'abs_up',       label: 'Rises by $',  unit: '$', val: '',  on: false },
];

function buildConditionRows() {
  const container = document.getElementById('condition-rows');
  container.innerHTML = COND_DEFS.map((c, i) => `
    <div class="condition-row-group">
      <input type="checkbox" class="cond-check" id="cond-${i}" data-type="${c.type}" ${c.on ? 'checked' : ''} onchange="toggleCondRow(${i})" />
      <label class="condition-label" for="cond-${i}">${c.label}</label>
      <input type="number" class="form-input" data-row="${i}" placeholder="value" min="0.01" step="0.01" ${c.val ? `value="${c.val}"` : ''} ${!c.on ? 'disabled' : ''} />
      <span class="condition-unit-label">${c.unit}</span>
    </div>`).join('');
}

function toggleCondRow(i) {
  const check = document.getElementById(`cond-${i}`);
  const inp = document.querySelector(`input[data-row="${i}"]`);
  if (inp) inp.disabled = !check.checked;
}

/* ─── SVG SPARKLINE HELPER ────────────────────────────────────── */
function buildSparklineSVG(data, width, height, colorUp, colorDown) {
  if (!data || data.length < 2) return '';
  const min = Math.min(...data), max = Math.max(...data);
  const range = max - min || 1;
  const pts = data.map((v, i) => {
    const x = (i / (data.length - 1)) * width;
    const y = height - ((v - min) / range) * (height - 4) - 2;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const color = data[data.length - 1] >= data[0] ? colorUp : colorDown;
  const fill = data[data.length - 1] >= data[0] ? colorUp + '18' : colorDown + '18';
  const areaPath = `M0,${height} L${pts.join(' L')} L${width},${height} Z`;
  return `<svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">
    <path d="${areaPath}" fill="${fill}" />
    <polyline points="${pts.join(' ')}" fill="none" stroke="${color}" stroke-width="1.5" stroke-linejoin="round" />
  </svg>`;
}

/* ─── SOCKET.IO ───────────────────────────────────────────────── */
function initSocket() {
  socket = io();
  socket.on('connect', () => setConnectionStatus(true));
  socket.on('disconnect', () => setConnectionStatus(false));

  socket.on('init', data => {
    if (data.alerts?.length) state.alerts = data.alerts;
    if (data.stockCache) Object.assign(state.stocks, data.stockCache);
    if (data.notificationHistory?.length && !state.history.length) state.history = data.notificationHistory;
    renderAll();
  });

  socket.on('priceUpdate', ({ symbol, price, change, changePercent, marketState, timestamp }) => {
    if (!state.stocks[symbol]) state.stocks[symbol] = {};
    Object.assign(state.stocks[symbol], { price, change, changePercent, marketState, lastUpdated: timestamp });
    updateStockCard(symbol);
    updateLastCheck();
  });

  socket.on('alertTriggered', notification => {
    state.history.unshift(notification);
    updateNavBadge('history', state.history.length);
    if (state.view === 'history') renderHistory();
    showBrowserNotification(notification);
    showAlertToast(notification);
  });

  socket.on('alertUpdated', alert => {
    const idx = state.alerts.findIndex(a => a.id === alert.id);
    if (idx !== -1) state.alerts[idx] = alert; else state.alerts.push(alert);
    renderAlerts(); renderDashboard();
  });
}

function setConnectionStatus(connected) {
  const el = document.getElementById('connection-status');
  el.className = 'connection-status ' + (connected ? 'connected' : 'disconnected');
  el.innerHTML = `<span class="status-dot"></span> ${connected ? 'Live' : 'Reconnecting…'}`;
}

function updateLastCheck() {
  document.getElementById('last-check-time').textContent = 'Last check: ' + new Date().toLocaleTimeString();
}

/* ─── API ─────────────────────────────────────────────────────── */
async function api(method, path, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch('/api' + path, opts);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

/* ─── NAVIGATION ──────────────────────────────────────────────── */
function navigate(view) {
  state.view = view;
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  document.getElementById(view + '-view').classList.add('active');
  document.querySelector(`[data-view="${view}"]`)?.classList.add('active');
  switch (view) {
    case 'dashboard': renderDashboard(); loadDashboardNews(); break;
    case 'alerts': renderAlerts(); break;
    case 'history': renderHistory(); break;
    case 'news': renderLatestNews(); break;
    case 'saved-news': renderSavedNews(); break;
    case 'crypto': renderCryptoDashboard(); break;
    case 'settings': renderSettings(); break;
  }
}

function updateNavBadge(view, count) {
  const el = document.getElementById(`nav-${view}-badge`);
  if (!el) return;
  if (count > 0) { el.textContent = count > 99 ? '99+' : count; el.style.display = 'inline'; }
  else el.style.display = 'none';
}

/* ─── RENDER ALL ──────────────────────────────────────────────── */
function renderAll() {
  renderDashboard(); renderAlerts(); renderHistory(); loadDashboardNews();
  updateNavBadge('alerts', state.alerts.filter(a => a.isActive).length);
  updateNavBadge('history', state.history.length);
}

/* ─── CONDITION LABELS ────────────────────────────────────────── */
function condLabel(type, val) {
  switch (type) {
    case 'percent_up':      return `+${val}%`;
    case 'percent_down':    return `-${val}%`;
    case 'price_above':     return `>$${val}`;
    case 'price_below':     return `<$${val}`;
    case 'abs_up':          return `+$${val}`;
    case 'abs_down':        return `-$${val}`;
    case 'earnings_before': return `${val}d pre-earn`;
    default: return '';
  }
}

function condLabelFull(type, val) {
  switch (type) {
    case 'percent_up':      return `rises ≥ +${val}% from base`;
    case 'percent_down':    return `falls ≥ −${val}% from base`;
    case 'price_above':     return `price ≥ $${val}`;
    case 'price_below':     return `price ≤ $${val}`;
    case 'abs_up':          return `rises ≥ +$${val} from base`;
    case 'abs_down':        return `falls ≥ −$${val} from base`;
    case 'earnings_before': return `${val} day(s) before earnings`;
    default: return '';
  }
}

function fmtVol(v) {
  if (v >= 1e9) return (v / 1e9).toFixed(1) + 'B';
  if (v >= 1e6) return (v / 1e6).toFixed(1) + 'M';
  if (v >= 1e3) return (v / 1e3).toFixed(0) + 'K';
  return v.toString();
}

/* ─── MARKET INDEX BAR (Yahoo Finance style) ──────────────────── */
let marketIndexData = [];

async function loadMarketIndex() {
  try {
    const data = await api('GET', '/market-index');
    marketIndexData = data;
    renderMarketIndexBar();
  } catch (e) { /* silent */ }
}

function renderMarketIndexBar() {
  const bar = document.getElementById('market-index-bar');
  if (!bar || !marketIndexData.length) return;

  // Gold (GC=F) and BTC-USD trade nearly 24/7 — override misleading CLOSED state
  const ALWAYS_ON = new Set(['GC=F', 'BTC-USD']);

  bar.innerHTML = marketIndexData.map(item => {
    if (!item.price) return `<div class="mkt-index-box"><div class="mkt-idx-name">${item.shortName}</div><div class="mkt-idx-price mkt-idx-na">N/A</div></div>`;
    const dir = (item.changePct || 0) >= 0 ? 'up' : 'down';
    const sign = item.changePct >= 0 ? '+' : '';
    const absSign = item.change >= 0 ? '+' : '';
    // Override market state for always-on assets
    if (ALWAYS_ON.has(item.symbol) && item.marketState === 'CLOSED') item.marketState = 'REGULAR';
    const priceStr = item.price >= 1000
      ? item.price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
      : item.price >= 1 ? item.price.toFixed(2)
      : item.price.toPrecision(4);
    const chgStr = `${absSign}${Math.abs(item.change) >= 1 ? item.change.toFixed(2) : item.change.toFixed(4)}`;
    const pctStr = `(${sign}${item.changePct.toFixed(2)}%)`;
    const spark = buildSparklineSVG(item.sparkline || [], 88, 32, '#3fb950', '#f85149');

    // Pre-market / futures indicator
    let futuresHtml = '';
    const pm = item.prePost || item.futures;
    if (pm) {
      const fDir = (pm.changePct || 0) >= 0 ? 'up' : 'down';
      const fSign = pm.changePct >= 0 ? '+' : '';
      // For direct Yahoo pre/post data use actual price; for futures show only % change (different scale)
      const isYahoo = pm.source === 'yahoo' || item.prePost;
      let fLabel = pm.type || 'Futures';
      if (!isYahoo) {
        const fs = (pm.marketState || '').toLowerCase();
        fLabel = fs === 'pre' ? 'Pre-Mkt' : fs === 'post' ? 'After-Hrs' : 'Futures';
      }
      const fContent = isYahoo
        ? `${pm.price >= 1000 ? pm.price.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}) : pm.price.toFixed(2)} <span>(${fSign}${pm.changePct.toFixed(2)}%)</span>`
        : `<span>${fSign}${pm.changePct.toFixed(2)}%</span>`;
      futuresHtml = `<span class="mkt-idx-futures-inline ${fDir}"><span class="mkt-idx-futures-label">${fLabel}</span> ${fContent}</span>`;
    }

    return `
      <div class="mkt-index-box ${dir}" onclick="showIndexModal('${item.symbol}','${item.shortName}')" style="cursor:pointer" title="Click to see historical chart">
        <div class="mkt-idx-top">
          <span class="mkt-idx-name">${item.shortName}</span>
          <span class="mkt-idx-state ${(item.marketState||'').toLowerCase()}">${item.marketState === 'REGULAR' ? '' : item.marketState || ''}</span>
        </div>
        <div class="mkt-idx-mid">
          <div class="mkt-idx-price">${priceStr}</div>
          ${spark ? `<div class="mkt-idx-spark">${spark}</div>` : ''}
        </div>
        <div class="mkt-idx-change ${dir}">${chgStr} ${pctStr}${futuresHtml}</div>
      </div>`;
  }).join('');
}

/* ─── HEADLINE TICKER ──────────────────────────────────────────── */
const MARKET_MOVE_KEYWORDS = /\b(fed|federal reserve|rate|hike|cut|inflation|cpi|pce|gdp|recession|crash|surge|plunge|rally|halt|earnings|beats?|misses?|beats estimates|misses estimates|acquire|merger|acquisition|ipo|sec|tariff|sanctions|layoffs?|bankruptcy|default|downgrad|upgrad|selloff|sell.off|bull|bear|crisis|war|geopolit|opec|oil|jobs|unemployment|powell|yellen|treasury|yield|bond)\b/i;
const CRYPTO_KEYWORDS = /\b(bitcoin|btc|ethereum|eth|crypto|blockchain|defi|nft|altcoin|binance|coinbase|solana|xrp|ripple|stablecoin|usdt|usdc|halving|mining|wallet|exchange|hack|exploit|sec crypto|token|dao|web3|metaverse)\b/i;

let tickerState = {
  stock: { articles: [], idx: 0, timer: null, refreshTimer: null },
  crypto: { articles: [], idx: 0, timer: null, refreshTimer: null }
};

async function initHeadlineTickers() {
  await fetchTickerHeadlines('stock');
  await fetchTickerHeadlines('crypto');
}

async function fetchTickerHeadlines(type) {
  try {
    let articles = [];
    if (type === 'crypto') {
      // Use dedicated crypto news endpoint
      const data = await api('GET', '/crypto/news');
      articles = Array.isArray(data) ? data : [];
      // Also pull from RSS and add crypto-tagged items
      try {
        const rss = await api('GET', '/news/rss');
        const cryptoRss = (Array.isArray(rss) ? rss : []).filter(a => CRYPTO_KEYWORDS.test((a.title || '') + ' ' + (a.source || '')));
        articles = [...articles, ...cryptoRss];
      } catch(e2) { /* silent */ }
    } else {
      // Use RSS feed for stock market news
      const data = await api('GET', '/news/rss');
      articles = Array.isArray(data) ? data : [];
      // Prefer market-moving headlines; fall back to all non-crypto
      const nonCrypto = articles.filter(a => !CRYPTO_KEYWORDS.test(a.title || ''));
      const highImpact = nonCrypto.filter(a => MARKET_MOVE_KEYWORDS.test(a.title || ''));
      articles = highImpact.length >= 3 ? highImpact : nonCrypto;
    }

    // Deduplicate by title, sort newest first, take top 3
    const seen = new Set();
    articles = articles.filter(a => { const k = (a.title||'').slice(0,60); if(seen.has(k)) return false; seen.add(k); return true; });
    articles.sort((a, b) => new Date(b.publishedAt || 0) - new Date(a.publishedAt || 0));
    tickerState[type].articles = articles.slice(0, 3);
    renderTickerMarquee(type);
  } catch(e) { /* silent */ }
}

function renderTickerMarquee(type) {
  const articles = tickerState[type].articles;
  const trackEl = document.getElementById(`${type}-ticker-track`);
  if (!trackEl) return;
  if (!articles.length) { trackEl.innerHTML = '<span class="ticker-loading">No headlines available</span>'; return; }

  const buildItems = () => articles.map(art => {
    const src = art.source ? `[${art.source}]` : '';
    let timeStr = '';
    if (art.publishedAt) {
      const d = new Date(art.publishedAt);
      timeStr = ` · ${d.toLocaleTimeString('en-US', {hour: 'numeric', minute: '2-digit', hour12: true})}`;
    }
    const url = art.link || '#';
    return `<a class="ticker-item" href="${url}" target="_blank" rel="noopener noreferrer">` +
      `<span class="ticker-meta">${src}${timeStr}</span>` +
      `<span class="ticker-title">${art.title || ''}</span>` +
      `</a><span class="ticker-sep">◆</span>`;
  }).join('');

  // Duplicate content for seamless infinite loop
  trackEl.innerHTML = buildItems() + buildItems();
  // Restart animation with fresh content
  trackEl.style.animation = 'none';
  void trackEl.offsetWidth;
  trackEl.style.animation = '';
}

function startTickerRotation(type) {
  const st = tickerState[type];
  if (st.timer) clearInterval(st.timer);
  st.timer = null; // CSS animation handles continuous scrolling
  // Refresh headlines every 10 minutes
  if (st.refreshTimer) clearInterval(st.refreshTimer);
  st.refreshTimer = setInterval(() => fetchTickerHeadlines(type), 10 * 60 * 1000);
}

/* ─── INDEX MODAL (click on index bar) ────────────────────────── */
const INDEX_PERIODS = [
  { label: '1D', range: '1d' }, { label: '7D', range: '7d' }, { label: '1M', range: '1mo' },
  { label: '3M', range: '3mo' }, { label: 'YTD', range: 'ytd' }, { label: '1Y', range: '1y' },
  { label: '2Y', range: '2y' }, { label: '3Y', range: '3y' }, { label: '5Y', range: '5y' }, { label: 'All', range: 'max' }
];
let indexModalRange = '1d';

function showIndexModal(symbol, name) {
  indexModalRange = '1d';
  let modal = document.getElementById('index-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'index-modal';
    modal.className = 'index-modal-overlay';
    modal.innerHTML = `
      <div class="index-modal-box">
        <div class="index-modal-header">
          <div>
            <div class="index-modal-name" id="index-modal-name"></div>
            <div class="index-modal-sym" id="index-modal-sym"></div>
          </div>
          <button class="index-modal-close" onclick="closeIndexModal()">✕</button>
        </div>
        <div class="index-modal-stats" id="index-modal-stats"></div>
        <div class="index-modal-periods" id="index-modal-periods"></div>
        <div class="index-modal-chart-wrap">
          <div id="index-modal-chart" class="index-modal-chart"></div>
        </div>
        <div class="index-modal-detail-grid" id="index-modal-detail"></div>
      </div>`;
    modal.addEventListener('click', e => { if (e.target === modal) closeIndexModal(); });
    document.body.appendChild(modal);
  }
  document.getElementById('index-modal-name').textContent = name;
  document.getElementById('index-modal-sym').textContent = symbol;
  document.getElementById('index-modal-detail').innerHTML = '';
  modal.style.display = 'flex';
  document.body.style.overflow = 'hidden';
  // Load chart + extra quote data in parallel
  loadIndexModalChart(symbol);
  loadIndexModalDetails(symbol);
}

async function loadIndexModalDetails(symbol) {
  const detailEl = document.getElementById('index-modal-detail');
  if (!detailEl) return;
  try {
    const q = await api('GET', `/stock/${encodeURIComponent(symbol)}`);
    const fmt = v => v != null ? (v >= 1000 ? v.toLocaleString('en-US', { maximumFractionDigits: 2 }) : v.toFixed(2)) : '—';
    const fmtVl = v => v ? fmtVol(v) : '—';
    const ytd = (() => {
      if (!q.ytdChangePercent) return null;
      return q.ytdChangePercent;
    })();
    const rows = [
      ['Previous Close', fmt(q.previousClose)],
      ['Open', fmt(q.open)],
      ['Day High', fmt(q.high)],
      ['Day Low', fmt(q.low)],
      ['52W High', fmt(q.week52High || q.fiftyTwoWeekHigh)],
      ['52W Low', fmt(q.week52Low || q.fiftyTwoWeekLow)],
      ['Volume', fmtVl(q.volume)],
      ['Avg Volume', fmtVl(q.averageVolume || q.avgVolume)],
    ];
    detailEl.innerHTML = rows.map(([label, val]) =>
      `<div class="idx-detail-item"><span class="idx-detail-label">${label}</span><span class="idx-detail-value">${val}</span></div>`
    ).join('');
  } catch (e) { /* silently skip if quote fails */ }
}

function closeIndexModal() {
  const modal = document.getElementById('index-modal');
  if (modal) modal.style.display = 'none';
  document.body.style.overflow = '';
}

async function loadIndexModalChart(symbol) {
  const container = document.getElementById('index-modal-chart');
  const statsEl = document.getElementById('index-modal-stats');
  const periodsEl = document.getElementById('index-modal-periods');
  if (!container) return;

  // Render period buttons
  periodsEl.innerHTML = INDEX_PERIODS.map(p =>
    `<button class="idx-period-btn${p.range === indexModalRange ? ' active' : ''}"
       onclick="indexModalRange='${p.range}';loadIndexModalChart('${symbol}')">${p.label}</button>`
  ).join('');

  container.innerHTML = '<div class="chart-loading">Loading…</div>';

  try {
    const data = await api('GET', `/stock/${encodeURIComponent(symbol)}/chart?range=${indexModalRange}`);
    const pts = (data.dataPoints || []).filter(p => p.close !== null);
    if (pts.length < 2) { container.innerHTML = '<div class="chart-loading">No data available</div>'; return; }

    const closes = pts.map(p => p.close);
    const timestamps = pts.map(p => p.timestamp);
    const highs = pts.map(p => p.high);
    const lows = pts.map(p => p.low);
    const volumes = pts.map(p => p.volume);
    const first = closes[0], last = closes[closes.length - 1];
    const basePrice = data.previousClose || first;
    const perf = ((last - basePrice) / basePrice * 100);
    const perfSign = perf >= 0 ? '+' : '';
    const dir = perf >= 0 ? 'up' : 'down';
    const color = dir === 'up' ? '#3fb950' : '#f85149';
    const fillColor = dir === 'up' ? '#3fb95018' : '#f8514918';

    const priceStr = last >= 1000
      ? last.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
      : last.toFixed(2);
    const chg = last - basePrice;
    const absSign = chg >= 0 ? '+' : '';
    statsEl.innerHTML = `
      <span class="idx-stat-price">${priceStr}</span>
      <span class="idx-stat-chg ${dir}">${absSign}${chg.toFixed(2)}</span>
      <span class="idx-stat-pct ${dir}">(${perfSign}${perf.toFixed(2)}%)</span>
      <span class="idx-stat-label">Open: ${first.toFixed(2)}</span>
      <span class="idx-stat-label">High: ${Math.max(...closes).toFixed(2)}</span>
      <span class="idx-stat-label">Low: ${Math.min(...closes).toFixed(2)}</span>`;

    const W = 860, H = 260;
    const min = Math.min(...closes), max = Math.max(...closes);
    const span = max - min || 1;
    const step = W / (closes.length - 1);
    const toY = v => H - ((v - min) / span) * (H - 20) - 10;
    const ptStr = closes.map((v, i) => `${(i * step).toFixed(1)},${toY(v).toFixed(1)}`);
    const baseY = toY(Math.max(min, Math.min(max, basePrice))).toFixed(1);
    const areaPath = `M0,${H} L${ptStr.join(' L')} L${W},${H} Z`;

    // Y-axis labels
    const yLabels = [];
    for (let i = 0; i <= 4; i++) {
      const val = min + (span * i / 4);
      const y = toY(val);
      yLabels.push(`<line x1="0" y1="${y.toFixed(1)}" x2="${W}" y2="${y.toFixed(1)}" stroke="#21262d" stroke-width="0.5"/>
        <text x="${W - 2}" y="${(y - 3).toFixed(1)}" fill="#484f58" font-size="9" text-anchor="end">${last >= 1000 ? val.toLocaleString('en-US',{maximumFractionDigits:0}) : val.toFixed(2)}</text>`);
    }

    container.innerHTML = `
      <svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" preserveAspectRatio="none" style="display:block">
        ${yLabels.join('')}
        <line x1="0" y1="${baseY}" x2="${W}" y2="${baseY}" stroke="#484f58" stroke-width="1" stroke-dasharray="4,4"/>
        <path d="${areaPath}" fill="${fillColor}"/>
        <polyline points="${ptStr.join(' ')}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
      </svg>
      <div class="chart-overlay" id="idx-chart-overlay"></div>
      <div class="chart-crosshair" id="idx-crosshair"></div>
      <div class="chart-dot" style="background:${color}" id="idx-dot"></div>
      <div class="chart-tooltip" id="idx-tooltip"></div>`;

    // Hover interaction
    const overlay = document.getElementById('idx-chart-overlay');
    const crosshair = document.getElementById('idx-crosshair');
    const dot = document.getElementById('idx-dot');
    const tooltip = document.getElementById('idx-tooltip');
    const range = indexModalRange;

    overlay.addEventListener('mousemove', (e) => {
      const rect = overlay.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const idx = Math.round((x / rect.width) * (closes.length - 1));
      if (idx < 0 || idx >= closes.length) return;
      const price = closes[idx];
      const ts = timestamps[idx];
      const high = highs[idx], low = lows[idx], vol = volumes[idx];
      const chgFromBase = ((price - basePrice) / basePrice * 100).toFixed(2);
      const chgSign = chgFromBase >= 0 ? '+' : '';
      const chgDirC = chgFromBase >= 0 ? 'up' : 'down';
      const dateObj = new Date(ts * 1000);
      let dateStr;
      if (range === '1d' || range === '7d') {
        dateStr = dateObj.toLocaleString('en-US', { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' });
      } else {
        dateStr = dateObj.toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' });
      }
      const xPct = (idx / (closes.length - 1)) * 100;
      const yPct = (toY(price) / H) * 100;
      crosshair.style.cssText = `display:block;left:${xPct}%`;
      dot.style.cssText = `display:block;background:${color};left:${xPct}%;top:${yPct}%`;
      tooltip.style.display = 'block';
      tooltip.style.left = xPct < 70 ? xPct + '%' : (xPct - 12) + '%';
      const pStr = price >= 1000 ? price.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}) : price.toFixed(2);
      tooltip.innerHTML = `
        <div class="chart-tooltip-price">${pStr}</div>
        <div class="chart-tooltip-date">${dateStr}</div>
        <div class="chart-tooltip-change" style="color:var(--${chgDirC === 'up' ? 'green' : 'red'})">${chgSign}${chgFromBase}%</div>
        ${high != null ? `<div style="font-size:9px;color:var(--text-dim)">H: ${high.toFixed(2)} · L: ${low.toFixed(2)}${vol ? ' · Vol: '+fmtVol(vol) : ''}</div>` : ''}`;
    });
    overlay.addEventListener('mouseleave', () => {
      crosshair.style.display = 'none';
      dot.style.display = 'none';
      tooltip.style.display = 'none';
    });
  } catch(e) {
    container.innerHTML = '<div class="chart-loading">Chart unavailable</div>';
  }
}

/* ─── DASHBOARD (grid or list mode) ───────────────────────────── */
function getDashSymbols() {
  let symbols = [...new Set(state.alerts.map(a => a.symbol))];
  const savedOrder = state.settings.dashboardOrder || [];
  if (savedOrder.length) {
    const ordered = savedOrder.filter(s => symbols.includes(s));
    const unordered = symbols.filter(s => !ordered.includes(s));
    symbols = [...ordered, ...unordered];
  }
  return symbols;
}

function renderDashboard() {
  const symbols = getDashSymbols();
  const activeCount = state.alerts.filter(a => a.isActive).length;
  const subtitleEl = document.getElementById('dashboard-subtitle');
  if (subtitleEl) subtitleEl.textContent = `Watching ${symbols.length} symbol(s) · ${activeCount} active alert(s)`;
  const grid = document.getElementById('stocks-grid');

  if (!symbols.length) {
    grid.innerHTML = `<div class="empty-state"><div class="empty-icon">📊</div><h3>No stocks tracked yet</h3><p>Add an alert to start monitoring US stocks and ETFs</p><button class="btn-primary" onclick="showAddAlertModal()">+ Add Your First Alert</button></div>`;
    grid.className = 'stocks-grid';
    return;
  }

  const mode = state.dashViewMode === 'list' ? 'grid' : state.dashViewMode; // list view removed
  if (mode === 'cards') {
    grid.className = 'stocks-grid stocks-grid-cards';
    grid.innerHTML = symbols.map(sym => buildStockCardRich(sym)).join('');
    // Lazy-load sparklines for cards (staggered to avoid API flood)
    loadProfilesBatch(symbols);
  } else if (mode === 'detailed') {
    grid.className = 'stocks-list';
    grid.innerHTML = buildStockDetailedTable(symbols);
    // Lazy-load perf data for detailed table
    symbols.forEach(sym => loadStockPerfForTable(sym));
  } else {
    grid.className = 'stocks-grid';
    grid.innerHTML = symbols.map(sym => buildStockCard(sym)).join('');
  }
}

function switchDashView(mode) {
  state.dashViewMode = mode;
  document.querySelectorAll('#view-toggle .view-toggle-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
  // Exit edit mode if switching away from grid
  if (mode !== 'grid' && editMode) toggleEditMode();
  renderDashboard();
}

/* ─── STOCK CARD RICH (Dashboard 2 — crypto-card style) ──────── */
function buildStockCardRich(symbol) {
  const s = state.stocks[symbol] || {};
  const p = state.profiles[symbol] || {};
  const price = typeof s.price === 'number' ? `$${s.price.toFixed(2)}` : '—';
  const chg = s.changePercent;
  const chgStr = typeof chg === 'number' ? `${chg >= 0 ? '+' : ''}${chg.toFixed(2)}%` : '';
  const dir = typeof chg === 'number' ? (chg >= 0 ? 'up' : 'down') : '';
  const changeAbs = typeof s.change === 'number' ? `${s.change >= 0 ? '+' : ''}$${Math.abs(s.change).toFixed(2)}` : '';
  const vol = s.volume ? fmtVol(s.volume) : '—';
  const spark = buildSparklineSVG(p.sparkline || [], 180, 40, '#3fb950', '#f85149');
  const mcap = p.marketCap || '—';
  const pe = p.trailingPE || '—';
  const w52h = p.week52High ? `$${p.week52High.toFixed(2)}` : '—';
  const w52l = p.week52Low ? `$${p.week52Low.toFixed(2)}` : '—';

  // Perf bar from cached profile data
  const perf = p._perf || {};
  const perfItems = Object.entries(perf).map(([label, val]) => {
    if (val === null || val === undefined) return `<span class="rc-perf-item"><span class="rc-perf-label">${label}</span><span class="rc-perf-val">—</span></span>`;
    const d = val >= 0 ? 'up' : 'down';
    return `<span class="rc-perf-item"><span class="rc-perf-label">${label}</span><span class="rc-perf-val ${d}">${val >= 0 ? '+' : ''}${val.toFixed(1)}%</span></span>`;
  }).join('');

  return `
    <div class="rich-card ${dir}" onclick="showNewsModal('${symbol}')" onmouseenter="lazyLoadHoverData('${symbol}');positionStockPopup(this)">
      <div class="rich-card-head">
        <div>
          <div class="rich-card-symbol">${symbol}</div>
          <div class="rich-card-name">${s.name || symbol}</div>
        </div>
        <div class="rich-card-price-block">
          <div class="rich-card-price">${price}</div>
          <div class="rich-card-change ${dir}">${chgStr} <span class="rich-card-abs">${changeAbs}</span></div>
        </div>
      </div>
      ${spark ? `<div class="rich-card-spark">${spark}</div>` : '<div class="rich-card-spark-empty"></div>'}
      ${perfItems ? `<div class="rc-perf-row">${perfItems}</div>` : ''}
      <div class="rich-card-stats">
        <span>Vol: ${vol}</span>
        <span>MCap: ${mcap}</span>
        <span>P/E: ${pe}</span>
      </div>
      <div class="rich-card-range">
        <span class="rc-range-label">52w</span>
        <span class="rc-range-low">${w52l}</span>
        <div class="rc-range-bar"><div class="rc-range-fill" style="width:${calc52wPct(s.price, p.week52Low, p.week52High)}%"></div></div>
        <span class="rc-range-high">${w52h}</span>
      </div>
      <div class="stock-card-detail" id="hover-cards-${symbol}" onclick="event.stopPropagation()">
        <div class="hover-loading">Loading details…</div>
      </div>
    </div>`;
}

function calc52wPct(price, low, high) {
  if (!price || !low || !high || high === low) return 50;
  return Math.max(0, Math.min(100, ((price - low) / (high - low)) * 100));
}

/* ─── STOCK DETAILED TABLE (Dashboard 3 — livecoinwatch style) ── */
function buildStockDetailedTable(symbols) {
  const period = state.stockChartPeriod || '1mo';
  const periodBtns = [['1d','1D'],['7d','7D'],['1mo','1M'],['3mo','3M'],['ytd','YTD'],['1y','1Y'],['2y','2Y']].map(([p, label]) =>
    `<button class="chart-period-btn${p === period ? ' active' : ''}" onclick="setStockChartPeriod('${p}')">${label}</button>`
  ).join('');
  return `
    <div class="lcw-table lcw-stock">
      <div class="lcw-header">
        <div class="lcw-col lcw-rank">#</div>
        <div class="lcw-col lcw-coin">Stock</div>
        <div class="lcw-col lcw-price">Price</div>
        <div class="lcw-col lcw-pct">1D</div>
        <div class="lcw-col lcw-pct">7D</div>
        <div class="lcw-col lcw-pct">1M</div>
        <div class="lcw-col lcw-pct">3M</div>
        <div class="lcw-col lcw-pct">YTD</div>
        <div class="lcw-col lcw-pct">1Y</div>
        <div class="lcw-col lcw-pct">2Y</div>
        <div class="lcw-col lcw-pct">3Y</div>
        <div class="lcw-col lcw-chart">Chart <span class="chart-period-toggle">${periodBtns}</span></div>
        <div class="lcw-col lcw-mcap">Mkt Cap</div>
        <div class="lcw-col lcw-vol">Volume</div>
      </div>
      ${symbols.map((sym, i) => buildStockDetailedRow(sym, i + 1)).join('')}
    </div>`;
}

function buildStockDetailedRow(symbol, rank) {
  const s = state.stocks[symbol] || {};
  const p = state.profiles[symbol] || {};
  const price = typeof s.price === 'number' ? `$${s.price.toFixed(2)}` : '—';
  const period = state.stockChartPeriod || '1mo';
  const chartData = state.stockCharts?.[symbol]?.[period] || p.sparkline || [];
  const spark = buildSparklineSVG(chartData, 90, 26, '#3fb950', '#f85149');
  const vol = s.volume ? fmtVol(s.volume) : '—';
  const mcap = p.marketCap || '—';
  const perf = p._perf || {};
  const dir = typeof s.changePercent === 'number' ? (s.changePercent >= 0 ? 'up' : 'down') : '';

  const pctCell = (val) => {
    if (val === null || val === undefined) return '<div class="lcw-col lcw-pct lcw-loading">—</div>';
    const d = val >= 0 ? 'up' : 'down';
    return `<div class="lcw-col lcw-pct ${d}">${val >= 0 ? '+' : ''}${val.toFixed(2)}%</div>`;
  };

  return `
    <div class="lcw-row ${dir}" id="lcw-stock-${symbol}"
         onmouseenter="showStockTableHover('${symbol}',this)" onmouseleave="hideStockTableHover(this)"
         onclick="showStockDetailPopup('${symbol}')" title="Click for full details">
      <div class="lcw-col lcw-rank">${rank}</div>
      <div class="lcw-col lcw-coin">
        <span class="lcw-symbol">${symbol}</span>
        <span class="lcw-name">${s.name || symbol}</span>
      </div>
      <div class="lcw-col lcw-price">${price}</div>
      ${pctCell(perf['1D'] ?? s.changePercent)}
      ${pctCell(perf['7D'])}
      ${pctCell(perf['1M'])}
      ${pctCell(perf['3M'])}
      ${pctCell(perf['YTD'])}
      ${pctCell(perf['1Y'])}
      ${pctCell(perf['2Y'])}
      ${pctCell(perf['3Y'])}
      <div class="lcw-col lcw-chart" id="stock-chart-${symbol}">${spark}</div>
      <div class="lcw-col lcw-mcap">${mcap}</div>
      <div class="lcw-col lcw-vol">${vol}</div>
      <div class="crypto-hover-popup" id="stock-tbl-hover-${symbol}"></div>
    </div>`;
}

/* Lazy load perf data for stocks in detailed table */
async function loadStockPerfForTable(symbol) {
  // If profile already has _perf, just re-render the row
  const p = state.profiles[symbol];
  if (p && p._perf) { updateStockDetailedRow(symbol); return; }
  // Otherwise load profile (which includes _perf)
  try {
    const profile = await api('GET', `/stock/${symbol}/profile`);
    state.profiles[symbol] = profile;
    updateStockDetailedRow(symbol);
  } catch (e) { /* silent */ }
}

function updateStockDetailedRow(symbol) {
  const row = document.getElementById(`lcw-stock-${symbol}`);
  if (!row || state.dashViewMode !== 'detailed') return;
  const s = state.stocks[symbol] || {};
  const p = state.profiles[symbol] || {};
  const perf = p._perf || {};
  const period = state.stockChartPeriod || '1mo';
  const chartData = state.stockCharts?.[symbol]?.[period] || p.sparkline || [];
  const spark = buildSparklineSVG(chartData, 90, 26, '#3fb950', '#f85149');
  const vol = s.volume ? fmtVol(s.volume) : '—';
  const mcap = p.marketCap || '—';
  const price = typeof s.price === 'number' ? `$${s.price.toFixed(2)}` : '—';
  const rank = row.querySelector('.lcw-rank')?.textContent || '';

  const pctCell = (val) => {
    if (val === null || val === undefined) return '<div class="lcw-col lcw-pct lcw-loading">—</div>';
    const d = val >= 0 ? 'up' : 'down';
    return `<div class="lcw-col lcw-pct ${d}">${val >= 0 ? '+' : ''}${val.toFixed(2)}%</div>`;
  };

  row.innerHTML = `
    <div class="lcw-col lcw-rank">${rank}</div>
    <div class="lcw-col lcw-coin">
      <span class="lcw-symbol">${symbol}</span>
      <span class="lcw-name">${s.name || symbol}</span>
    </div>
    <div class="lcw-col lcw-price">${price}</div>
    ${pctCell(perf['1D'] ?? s.changePercent)}
    ${pctCell(perf['5D'])}
    ${pctCell(perf['1M'])}
    ${pctCell(perf['3M'])}
    ${pctCell(perf['YTD'])}
    ${pctCell(perf['1Y'])}
    ${pctCell(perf['2Y'])}
    ${pctCell(perf['3Y'])}
    <div class="lcw-col lcw-chart" id="stock-chart-${symbol}">${spark}</div>
    <div class="lcw-col lcw-mcap">${mcap}</div>
    <div class="lcw-col lcw-vol">${vol}</div>
    <div class="crypto-hover-popup" id="stock-tbl-hover-${symbol}"></div>`;
}

function buildStockListRow(symbol, rank) {
  const s = state.stocks[symbol] || {};
  const price = typeof s.price === 'number' ? `$${s.price.toFixed(2)}` : '—';
  const chg = s.changePercent;
  const chgStr = typeof chg === 'number' ? `${chg >= 0 ? '+' : ''}${chg.toFixed(2)}%` : '';
  const dir = typeof chg === 'number' ? (chg >= 0 ? 'up' : 'down') : '';
  const changeAbs = typeof s.change === 'number' ? `${s.change >= 0 ? '+' : ''}$${Math.abs(s.change).toFixed(2)}` : '';
  const vol = s.volume ? fmtVol(s.volume) : '—';
  const ms = s.marketState || 'CLOSED';
  const p = state.profiles[symbol] || {};
  const spark = buildSparklineSVG(p.sparkline || [], 80, 24, '#3fb950', '#f85149');

  return `
    <div class="stock-list-row" onclick="showNewsModal('${symbol}')" onmouseenter="lazyLoadHoverData('${symbol}')">
      <div class="list-rank">${rank}</div>
      <div class="list-symbol-group"><span class="list-symbol">${symbol}</span><span class="list-name">${s.name || symbol}</span></div>
      <div class="list-price" id="list-price-${symbol}">${price}</div>
      <div class="list-change ${dir}" id="list-chg-${symbol}">${chgStr}<br/><span style="font-size:10px;color:var(--text-dim)">${changeAbs}</span></div>
      <div class="list-sparkline">${spark}</div>
      <div class="list-volume">${vol}</div>
      <div class="list-market-state"><span class="market-state-badge ${ms}">${ms}</span></div>
    </div>`;
}

/* ─── TINY STOCK CARD (just symbol + price + change) ──────────── */
function buildStockCard(symbol) {
  const s = state.stocks[symbol] || {};
  const price = typeof s.price === 'number' ? `$${s.price.toFixed(2)}` : '—';
  const chg = s.changePercent;
  const chgStr = typeof chg === 'number' ? `${chg >= 0 ? '+' : ''}${chg.toFixed(2)}%` : '';
  const dir = typeof chg === 'number' ? (chg >= 0 ? 'up' : 'down') : '';

  return `
  <div class="stock-card ${dir}" id="card-${symbol}" onclick="showNewsModal('${symbol}')" onmouseenter="lazyLoadHoverData('${symbol}');positionStockPopup(this)">
    <div class="stock-card-compact">
      <div class="stock-symbol">${symbol}</div>
      <div class="stock-price-compact">
        <span class="price" id="price-${symbol}">${price}</span>
        <span class="change ${dir}" id="chg-${symbol}">${chgStr}</span>
      </div>
    </div>
    <div class="stock-card-detail" id="hover-${symbol}" onclick="event.stopPropagation()">
      <div class="hover-loading">Loading details…</div>
    </div>
  </div>`;
}

function updateStockCard(symbol) {
  const card = document.getElementById(`card-${symbol}`);
  if (!card) return;
  const s = state.stocks[symbol] || {};
  const chg = s.changePercent;
  const dir = typeof chg === 'number' ? (chg >= 0 ? 'up' : 'down') : '';

  const priceEl = document.getElementById(`price-${symbol}`);
  const chgEl = document.getElementById(`chg-${symbol}`);
  if (priceEl && typeof s.price === 'number') priceEl.textContent = `$${s.price.toFixed(2)}`;
  if (chgEl && typeof chg === 'number') {
    chgEl.textContent = `${chg >= 0 ? '+' : ''}${chg.toFixed(2)}%`;
    chgEl.className = `change ${dir}`;
  }
  card.className = card.className.replace(/\b(up|down)\b/g, '').trim() + ' ' + dir;
}

/* ─── STOCK HOVER POPUP POSITIONING ─────────────────────────── */
function positionStockPopup(cardEl) {
  const popup = cardEl.querySelector('.stock-card-detail');
  if (!popup) return;
  const rect = cardEl.getBoundingClientRect();
  // Place horizontally near the card but keep within viewport
  const popupWidth = 700;
  let left = rect.left;
  if (left + popupWidth > window.innerWidth - 10) left = window.innerWidth - popupWidth - 10;
  if (left < 0) left = 0;
  popup.style.left = left + 'px';
}

/* ─── LAZY-LOAD HOVER DATA ────────────────────────────────────── */
async function lazyLoadHoverData(symbol) {
  const getEl = () => document.getElementById(`hover-${symbol}`) || document.getElementById(`hover-cards-${symbol}`);
  const el = getEl();
  if (el && el.dataset.loaded) return;

  // Profile already cached → just render
  if (state.profiles[symbol]) {
    const target = getEl();
    if (target && !target.dataset.loaded) { target.dataset.loaded = '1'; renderHoverPopup(symbol, target); }
    return;
  }

  if (el) el.dataset.loaded = '1';

  try {
    const [profile] = await Promise.all([
      api('GET', `/stock/${symbol}/profile`),
      state.stocks[symbol]?.price ? Promise.resolve() : api('GET', `/stock/${symbol}`).then(d => { state.stocks[symbol] = { ...state.stocks[symbol], ...d }; }),
    ]);
    state.profiles[symbol] = profile;

    if (state.dashViewMode === 'cards') {
      // First refresh the card (updates sparklines/perf), THEN render popup into the NEW element
      refreshRichCard(symbol);
      const newEl = document.getElementById(`hover-cards-${symbol}`);
      if (newEl) { newEl.dataset.loaded = '1'; renderHoverPopup(symbol, newEl); }
    } else {
      const target = getEl();
      if (target) { target.dataset.loaded = '1'; renderHoverPopup(symbol, target); }
    }
  } catch (e) {
    const errEl = getEl();
    if (errEl) errEl.innerHTML = `<div class="hover-loading">Failed to load: ${e.message}</div>`;
  }
}

/* Batch load profiles with staggered requests */
async function loadProfilesBatch(symbols) {
  const toLoad = symbols.filter(s => !state.profiles[s]);
  for (let i = 0; i < toLoad.length; i++) {
    lazyLoadHoverData(toLoad[i]);
    if (i % 3 === 2) await new Promise(r => setTimeout(r, 300)); // 3 at a time
  }
}

/* Refresh a single rich card after profile loads */
function refreshRichCard(symbol) {
  const grid = document.getElementById('stocks-grid');
  if (!grid || state.dashViewMode !== 'cards') return;
  const cards = grid.querySelectorAll('.rich-card');
  cards.forEach(card => {
    const sym = card.querySelector('.rich-card-symbol')?.textContent;
    if (sym === symbol) {
      const tmp = document.createElement('div');
      tmp.innerHTML = buildStockCardRich(symbol);
      const newCard = tmp.firstElementChild;
      card.replaceWith(newCard);
    }
  });
}

function renderHoverPopup(symbol, el) {
  const s = state.stocks[symbol] || {};
  const p = state.profiles[symbol] || {};
  const price = typeof s.price === 'number' ? `$${s.price.toFixed(2)}` : '—';
  const chg = s.changePercent;
  const chgStr = typeof chg === 'number' ? `${chg >= 0 ? '+' : ''}${chg.toFixed(2)}%` : '—';
  const dir = typeof chg === 'number' ? (chg >= 0 ? 'up' : 'down') : '';
  const changeAbs = typeof s.change === 'number' ? `${s.change >= 0 ? '+' : ''}$${Math.abs(s.change).toFixed(2)}` : '';

  const sparkline = buildSparklineSVG(p.sparkline, 640, 70, '#3fb950', '#f85149');
  const myAlerts = state.alerts.filter(a => a.symbol === symbol && a.isActive);

  // Multi-timeframe performance bar
  const perfData = p._perf || null;
  let perfBar = '';
  if (perfData) {
    const bars = Object.entries(perfData).map(([label, val]) => {
      if (val === null) return '';
      const dir = val >= 0 ? 'up' : 'down';
      return `<div class="perf-item"><span class="perf-label">${label}</span><span class="perf-val ${dir}">${val >= 0 ? '+' : ''}${val.toFixed(1)}%</span></div>`;
    }).join('');
    if (bars) perfBar = `<div class="perf-bar">${bars}</div>`;
  }

  // Stats grid
  const stats = [
    ['Open', typeof s.open === 'number' ? `$${s.open.toFixed(2)}` : '—'],
    ['High', typeof s.high === 'number' ? `$${s.high.toFixed(2)}` : '—'],
    ['Low', typeof s.low === 'number' ? `$${s.low.toFixed(2)}` : '—'],
    ['Volume', s.volume ? fmtVol(s.volume) : '—'],
    ['52w Low', p.week52Low ? `$${p.week52Low.toFixed(2)}` : '—'],
    ['52w High', p.week52High ? `$${p.week52High.toFixed(2)}` : '—'],
    ['Mkt Cap', p.marketCap || '—'],
    ['P/E', p.trailingPE || '—'],
    ['EPS', p.eps || '—'],
  ].map(([l, v]) => `<div class="hover-stat"><span class="hover-stat-label">${l}</span><span class="hover-stat-value">${v}</span></div>`).join('');

  // News headlines (top 5)
  const topNewsSlice = (p.topNews || []).slice(0, 5);
  const newsHtml = topNewsSlice.length ? `
    <div class="hover-news-section">
      <div class="hover-news-title">Latest Headlines</div>
      ${topNewsSlice.map(n => `<div class="hover-news-item"><a href="${n.link}" target="_blank" rel="noopener">${n.title}</a><div class="hover-news-pub">${n.publisher || ''}</div></div>`).join('')}
      ${(p.topNews || []).length > 5 ? `<div style="padding:4px 0;font-size:12px"><a href="#" style="color:var(--blue);text-decoration:none" onclick="event.stopPropagation();showNewsModal('${symbol}');return false">📰 View all ${p.topNews.length} headlines →</a></div>` : ''}
    </div>` : '';

  // Earnings
  const eq = p.earningsQuarterly || [];
  const earningsHtml = (p.earningsDate || eq.length) ? `
    <div class="hover-earnings">
      <div class="hover-earnings-title">Earnings</div>
      ${p.earningsDate ? `<div class="hover-earnings-next">Next: ${p.earningsDate}${p.earningsAvgEst ? ` (est. $${p.earningsAvgEst})` : ''}</div>` : ''}
      ${eq.length ? `<div class="hover-earnings-quarters">${eq.slice(-4).map(q => {
        const beat = q.actual !== null && q.estimate !== null ? (q.actual >= q.estimate ? 'beat' : 'miss') : '';
        return `<div class="hover-eq-item"><span class="hover-eq-label">${q.date}</span><span class="hover-eq-actual ${beat === 'beat' ? 'hover-eq-beat' : beat === 'miss' ? 'hover-eq-miss' : ''}">$${q.actual?.toFixed(2) ?? '—'}</span><span class="hover-eq-label">est $${q.estimate?.toFixed(2) ?? '—'}</span></div>`;
      }).join('')}</div>` : ''}
    </div>` : '';

  // Alert rows
  const alertRows = myAlerts.length
    ? myAlerts.map(a => `
      <div class="detail-alert-row">
        <span class="detail-alert-condition">${condLabel(a.conditionType, a.conditionValue)}</span>
        <div class="detail-alert-actions">
          <button class="detail-btn" title="${a.isActive ? 'Pause' : 'Resume'}" onclick="event.stopPropagation(); toggleAlert('${a.id}')">${a.isActive ? '⏸' : '▶'}</button>
          <button class="detail-btn danger" title="Delete" onclick="event.stopPropagation(); deleteAlert('${a.id}')">🗑</button>
        </div>
      </div>`).join('')
    : '<div style="font-size:11px;color:var(--text-dim);padding:2px 0">No active alerts</div>';

  el.innerHTML = `
    <div class="detail-header">
      <div>
        <div class="detail-symbol">${symbol}</div>
        <div class="detail-name">${s.name || symbol}</div>
      </div>
      <div class="detail-header-right">
        <button class="detail-edit-btn" onclick="event.stopPropagation(); quickAdd('${symbol}')">✏️ Edit</button>
        <div>
          <div class="detail-price">${price}</div>
          <div class="detail-change ${dir}">${chgStr} (${changeAbs})</div>
        </div>
      </div>
    </div>
    ${sparkline ? `<div class="hover-sparkline">${sparkline}</div>` : ''}
    ${perfBar}
    <div class="hover-stats-grid">${stats}</div>
    ${newsHtml}
    ${earningsHtml}
    <div class="detail-section-title">Alerts (${myAlerts.length})</div>
    ${alertRows}`;
}

/* ─── ALERTS VIEW ─────────────────────────────────────────────── */
function renderAlerts() {
  const container = document.getElementById('alerts-list');
  updateNavBadge('alerts', state.alerts.filter(a => a.isActive).length);

  if (!state.alerts.length) {
    container.innerHTML = `<div class="empty-state"><div class="empty-icon">🔔</div><h3>No alerts configured</h3><p>Create an alert to get notified when a stock moves</p><button class="btn-primary" onclick="showAddAlertModal()">+ Add Alert</button></div>`;
    return;
  }
  container.innerHTML = state.alerts.map(a => buildAlertItem(a)).join('');
}

function buildAlertItem(a) {
  const label = condLabelFull(a.conditionType, a.conditionValue);
  const notifyIcons = { popup: '🖥️', email: '✉️', sms: '📱' };
  const pills = a.notificationMethods.map(m => `<span class="alert-notify-pill">${notifyIcons[m] || ''} ${m}</span>`).join('');
  const date = new Date(a.createdAt).toLocaleDateString();
  const triggered = a.triggeredCount > 0 ? ` · fired ${a.triggeredCount}×` : '';
  const repeatBadge = a.repeatAlert ? `<span class="alert-notify-pill">🔁 repeat</span>` : `<span class="alert-notify-pill">1× only</span>`;

  return `
  <div class="alert-item ${a.isActive ? '' : 'inactive'}">
    <div class="alert-item-symbol">${a.symbol}</div>
    <div class="alert-item-info">
      <div class="alert-item-name">${a.name}</div>
      <div class="alert-item-condition">When <span>${label}</span></div>
      <div class="alert-item-meta">Base: $${a.basePrice.toFixed(2)} · ${date}${triggered}</div>
      <div class="alert-item-meta" style="margin-top:4px">${pills}${repeatBadge}</div>
    </div>
    <div class="alert-item-actions">
      <button class="btn-icon" title="${a.isActive ? 'Pause' : 'Resume'}" onclick="toggleAlert('${a.id}')">${a.isActive ? '⏸' : '▶'}</button>
      <button class="btn-icon danger" title="Delete" onclick="deleteAlert('${a.id}')">🗑</button>
    </div>
  </div>`;
}

async function toggleAlert(id) {
  try {
    const updated = await api('PUT', `/alerts/${id}/toggle`);
    const idx = state.alerts.findIndex(a => a.id === id);
    if (idx !== -1) state.alerts[idx] = updated;
    renderAlerts(); renderDashboard();
  } catch (e) { showErrorToast(e.message); }
}

async function deleteAlert(id) {
  if (!confirm('Delete this alert?')) return;
  try {
    await api('DELETE', `/alerts/${id}`);
    state.alerts = state.alerts.filter(a => a.id !== id);
    renderAlerts(); renderDashboard();
    showSuccessToast('Alert deleted');
  } catch (e) { showErrorToast(e.message); }
}

/* ─── HISTORY VIEW ────────────────────────────────────────────── */
function renderHistory() {
  const container = document.getElementById('history-list');
  if (!state.history.length) {
    container.innerHTML = `<div class="empty-state"><div class="empty-icon">📋</div><h3>No history yet</h3><p>Triggered alerts will appear here</p></div>`;
    return;
  }
  container.innerHTML = state.history.map(h => {
    const pct = h.changePercent;
    const icon = typeof pct === 'number' ? (pct >= 0 ? '📈' : '📉') : '🔔';
    const methods = (h.methods || []).map(m => `<span class="method-pill">${m}</span>`).join('');
    const time = new Date(h.timestamp).toLocaleString();
    return `<div class="history-item"><div class="history-icon">${icon}</div><div class="history-content"><div><span class="history-symbol">${h.symbol}</span> · ${h.name || ''}</div><div class="history-message">${h.message}</div><div class="history-time">${time}</div><div class="history-methods">${methods}</div></div></div>`;
  }).join('');
}

async function clearHistory() {
  if (!confirm('Clear all notification history?')) return;
  try {
    await api('DELETE', '/history');
    state.history = []; renderHistory(); updateNavBadge('history', 0);
    showSuccessToast('History cleared');
  } catch (e) { showErrorToast(e.message); }
}

/* ─── SETTINGS VIEW ───────────────────────────────────────────── */
function renderSettings() {
  const s = state.settings;
  const el = id => document.getElementById(id);
  if (el('setting-interval')) el('setting-interval').value = s.checkIntervalMinutes || 1;
  if (el('setting-email-enabled')) el('setting-email-enabled').checked = !!s.emailEnabled;
  setVal('setting-email-from', s.emailFrom || '');
  setVal('setting-email-address', s.emailAddress || '');
  setVal('setting-email-password', '');
  el('setting-email-password').placeholder = s.hasEmailPassword ? '••••••• (saved)' : 'Gmail App Password';
  toggleEmailFields();
  if (el('setting-sms-enabled')) el('setting-sms-enabled').checked = !!s.smsEnabled;
  setVal('setting-twilio-sid', s.twilioAccountSid || '');
  setVal('setting-twilio-phone', s.twilioPhoneNumber || '');
  setVal('setting-phone-number', s.phoneNumber || '');
  setVal('setting-twilio-token', '');
  el('setting-twilio-token').placeholder = s.hasTwilioCredentials ? '••••••• (saved)' : 'Twilio Auth Token';
  toggleSmsFields();
  renderXHandles();
}
function applySettings(s) { const el = document.getElementById('setting-interval'); if (el) el.value = s.checkIntervalMinutes || 1; }
function setVal(id, val) { const el = document.getElementById(id); if (el) el.value = val; }
function toggleEmailFields() { const on = document.getElementById('setting-email-enabled').checked; const f = document.getElementById('email-fields'); f.style.opacity = on ? '1' : '.4'; f.style.pointerEvents = on ? 'all' : 'none'; }
function toggleSmsFields() { const on = document.getElementById('setting-sms-enabled').checked; const f = document.getElementById('sms-fields'); f.style.opacity = on ? '1' : '.4'; f.style.pointerEvents = on ? 'all' : 'none'; }

function renderXHandles() {
  const handles = state.settings.xHandles || [];
  const el = document.getElementById('x-handles-list');
  if (!el) return;
  if (!handles.length) { el.innerHTML = '<p style="font-size:12px;color:var(--text-dim)">No accounts added yet</p>'; return; }
  el.innerHTML = handles.map((h, i) => `
    <div class="x-handle-item">
      <a href="https://x.com/${h.replace('@','')}" target="_blank" rel="noopener" style="color:var(--blue);text-decoration:none">${h.startsWith('@') ? h : '@'+h}</a>
      <button class="btn-icon danger" style="width:24px;height:24px;font-size:11px" onclick="removeXHandle(${i})">🗑</button>
    </div>`).join('');
}

async function addXHandle() {
  const inp = document.getElementById('new-x-handle');
  let handle = inp.value.trim().replace(/^https?:\/\/(www\.)?x\.com\//, '').replace(/\/$/, '');
  if (!handle) return;
  if (!handle.startsWith('@')) handle = '@' + handle;
  const handles = state.settings.xHandles || [];
  if (handles.includes(handle)) { showErrorToast('Already added'); return; }
  handles.push(handle);
  try {
    await api('PUT', '/settings', { xHandles: handles });
    state.settings.xHandles = handles;
    inp.value = '';
    renderXHandles();
    showSuccessToast(`${handle} added`);
  } catch (e) { showErrorToast(e.message); }
}

async function removeXHandle(index) {
  const handles = [...(state.settings.xHandles || [])];
  handles.splice(index, 1);
  try {
    await api('PUT', '/settings', { xHandles: handles });
    state.settings.xHandles = handles;
    renderXHandles();
  } catch (e) { showErrorToast(e.message); }
}

async function saveGeneralSettings() {
  try { const v = parseInt(document.getElementById('setting-interval').value); await api('PUT', '/settings', { checkIntervalMinutes: v }); state.settings.checkIntervalMinutes = v; showSuccessToast('Checking every ' + v + ' min'); }
  catch (e) { showErrorToast(e.message); }
}
async function saveEmailSettings() {
  try {
    const p = { emailEnabled: document.getElementById('setting-email-enabled').checked, emailFrom: document.getElementById('setting-email-from').value.trim(), emailAddress: document.getElementById('setting-email-address').value.trim(), emailPassword: document.getElementById('setting-email-password').value };
    await api('PUT', '/settings', p); Object.assign(state.settings, p); state.settings.hasEmailPassword = true; showSuccessToast('Email saved');
  } catch (e) { showErrorToast(e.message); }
}
async function saveSmsSettings() {
  try {
    const p = { smsEnabled: document.getElementById('setting-sms-enabled').checked, twilioAccountSid: document.getElementById('setting-twilio-sid').value.trim(), twilioAuthToken: document.getElementById('setting-twilio-token').value, twilioPhoneNumber: document.getElementById('setting-twilio-phone').value.trim(), phoneNumber: document.getElementById('setting-phone-number').value.trim() };
    await api('PUT', '/settings', p); Object.assign(state.settings, p); showSuccessToast('SMS saved');
  } catch (e) { showErrorToast(e.message); }
}
async function testEmail() {
  const r = document.getElementById('email-test-result'); r.textContent = 'Sending…'; r.className = 'test-result';
  try { const d = await api('POST', '/test/email'); r.textContent = '✅ ' + d.message; r.className = 'test-result success'; }
  catch (e) { r.textContent = '❌ ' + e.message; r.className = 'test-result error'; }
}
async function testSms() {
  const r = document.getElementById('sms-test-result'); r.textContent = 'Sending…'; r.className = 'test-result';
  try { const d = await api('POST', '/test/sms'); r.textContent = '✅ ' + d.message; r.className = 'test-result success'; }
  catch (e) { r.textContent = '❌ ' + e.message; r.className = 'test-result error'; }
}

/* ─── ADD ALERT MODAL ─────────────────────────────────────────── */
function showAddAlertModal() {
  document.getElementById('add-alert-modal').classList.add('active');
  document.getElementById('symbol-search').focus();
  document.body.style.overflow = 'hidden';
}

function hideAddAlertModal() {
  document.getElementById('add-alert-modal').classList.remove('active');
  document.body.style.overflow = '';
  resetAlertForm();
}

function handleModalOverlayClick(e, id) {
  if (e.target === e.currentTarget) {
    document.getElementById(id).classList.remove('active');
    document.body.style.overflow = '';
    if (id === 'add-alert-modal') resetAlertForm();
  }
}

function resetAlertForm() {
  state.selectedSymbol = null;
  document.getElementById('symbol-search').value = '';
  document.getElementById('search-results').innerHTML = '';
  document.getElementById('selected-symbol-info').innerHTML = '';
  document.getElementById('conditions-container').style.display = 'none';
  document.getElementById('earnings-section').style.display = 'none';
  document.getElementById('notify-group').style.display = 'none';
  document.getElementById('repeat-group').style.display = 'none';
  document.getElementById('submit-alert-btn').disabled = true;
  document.getElementById('submit-alert-btn').textContent = 'Create Alert(s)';
  document.getElementById('modal-error').style.display = 'none';
  document.getElementById('notify-popup').checked = true;
  document.getElementById('notify-email').checked = false;
  document.getElementById('notify-sms').checked = false;
  document.getElementById('repeat-alert').checked = true;
  document.getElementById('earnings-alert-check').checked = true;
  document.getElementById('earnings-days-input').value = '7';
  document.getElementById('modal-right-panel').innerHTML = '<div class="modal-right-empty">Select a stock on the left to see<br/>its full profile and key data</div>';
  const finBtn = document.getElementById('financials-header-btn');
  if (finBtn) finBtn.style.display = 'none';
  // Reset condition rows to defaults (row 1 = percent_down 5%)
  buildConditionRows();
}

/* ─── SYMBOL SEARCH ───────────────────────────────────────────── */
function handleSymbolSearch(e) {
  clearTimeout(state.searchTimeout);
  const q = e.target.value.trim();
  document.getElementById('search-results').innerHTML = '';
  if (q.length < 1) return;
  state.searchTimeout = setTimeout(() => performSearch(q), 280);
}

async function performSearch(q) {
  try {
    const results = await api('GET', '/search/' + encodeURIComponent(q));
    if (!results.length) {
      document.getElementById('search-results').innerHTML = `<div class="search-result-item" style="color:var(--text-dim)">No results found</div>`;
      return;
    }
    document.getElementById('search-results').innerHTML = results.map(r => `
      <div class="search-result-item" onclick="selectSymbol('${r.symbol}', '${escQ(r.name)}', '${r.type}')">
        <span class="symbol">${r.symbol}</span><span class="name">${r.name}</span><span class="type ${r.type.toLowerCase()}">${r.type}</span>
      </div>`).join('');
  } catch (e) { console.error('Search error:', e); }
}

function escQ(s) { return s.replace(/'/g, "\\'").replace(/"/g, '&quot;'); }

async function selectSymbol(symbol, name, type) {
  document.getElementById('symbol-search').value = `${symbol} — ${name}`;
  document.getElementById('search-results').innerHTML = '';

  try {
    const stock = await api('GET', '/stock/' + symbol);
    state.selectedSymbol = stock;
    const pct = stock.changePercent;
    const sign = pct >= 0 ? '+' : '';
    document.getElementById('selected-symbol-info').innerHTML = `
      <div class="symbol-preview">
        <div><div class="symbol-ticker">${stock.symbol}</div><div class="symbol-name">${stock.name}</div></div>
        <div><div class="price">$${stock.price.toFixed(2)}</div><div class="change ${pct >= 0 ? 'up' : 'down'}">${sign}${pct.toFixed(2)}% today</div></div>
      </div>`;
    document.getElementById('conditions-container').style.display = 'block';
    document.getElementById('earnings-section').style.display = 'block';
    document.getElementById('notify-group').style.display = 'block';
    document.getElementById('repeat-group').style.display = 'flex';
    document.getElementById('submit-alert-btn').disabled = false;
    const finBtn = document.getElementById('financials-header-btn');
    if (finBtn) finBtn.style.display = 'inline-block';
    state.stocks[symbol] = state.stocks[symbol] || {};
    Object.assign(state.stocks[symbol], stock);

    // Load profile for right panel + earnings info (async)
    loadRightPanel(symbol);
    loadEarningsInfo(symbol);
  } catch (e) {
    document.getElementById('selected-symbol-info').innerHTML = `<p style="color:var(--red);font-size:13px;margin-bottom:12px">Could not fetch ${symbol}</p>`;
  }
}

/* ─── RIGHT PANEL: Stock Profile ──────────────────────────────── */
async function loadRightPanel(symbol) {
  const panel = document.getElementById('modal-right-panel');
  panel.innerHTML = '<div class="modal-right-loading">Loading stock profile…</div>';

  try {
    const p = await api('GET', `/stock/${symbol}/profile`);
    state.profiles[symbol] = p;
    const s = state.stocks[symbol] || {};
    const price = typeof s.price === 'number' ? `$${s.price.toFixed(2)}` : '—';
    const chg = s.changePercent;
    const chgStr = typeof chg === 'number' ? `${chg >= 0 ? '+' : ''}${chg.toFixed(2)}%` : '—';
    const dir = typeof chg === 'number' ? (chg >= 0 ? 'up' : 'down') : '';

    // Build analyst bar
    const rt = p.recommendationTrend;
    let analystHtml = '';
    if (rt) {
      const total = rt.strongBuy + rt.buy + rt.hold + rt.sell + rt.strongSell;
      if (total > 0) {
        const pct = v => ((v / total) * 100).toFixed(1) + '%';
        analystHtml = `
          <div class="analyst-bar-container">
            <div class="analyst-bar">
              <div class="sb" style="width:${pct(rt.strongBuy)}"></div>
              <div class="b" style="width:${pct(rt.buy)}"></div>
              <div class="h" style="width:${pct(rt.hold)}"></div>
              <div class="s" style="width:${pct(rt.sell)}"></div>
              <div class="ss" style="width:${pct(rt.strongSell)}"></div>
            </div>
            <div class="analyst-legend">
              <span>Strong Buy ${rt.strongBuy}</span><span>Buy ${rt.buy}</span><span>Hold ${rt.hold}</span><span>Sell ${rt.sell}</span><span>Strong Sell ${rt.strongSell}</span>
            </div>
          </div>`;
      }
    }

    // EPS quarters
    const eq = p.earningsQuarterly || [];
    const epsHtml = eq.length ? `
      <div class="eps-quarters">${eq.slice(-4).map(q => {
        const beat = q.actual !== null && q.estimate !== null ? (q.actual >= q.estimate) : null;
        return `<div class="eps-q"><span class="eps-q-label">${q.date}</span><span class="eps-q-actual ${beat === true ? 'eps-beat' : beat === false ? 'eps-miss' : ''}">$${q.actual?.toFixed(2) ?? '—'}</span><span class="eps-q-est">est $${q.estimate?.toFixed(2) ?? '—'}</span></div>`;
      }).join('')}</div>` : '';

    // News (scrollable, all articles)
    const newsHtml = (p.topNews || []).map(n => `<div class="profile-news-item"><a href="${n.link}" target="_blank" rel="noopener">${n.title}</a><div class="profile-news-pub">${n.publisher || ''} · ${n.publishedAt ? new Date(n.publishedAt).toLocaleDateString() : ''}</div></div>`).join('');

    const stat = (label, val) => `<div class="profile-stat"><span class="profile-stat-label">${label}</span><span class="profile-stat-value">${val || '—'}</span></div>`;

    const chartRanges = [
      ['1d','1D'],['5d','5D'],['1mo','1M'],['ytd','YTD'],['1y','1Y'],['2y','2Y'],['3y','3Y'],['5y','5Y'],['max','All']
    ];

    panel.innerHTML = `
      <div class="profile-header">
        <div>
          <div class="profile-ticker">${symbol}</div>
          <div class="profile-name">${s.name || symbol}</div>
          <div class="profile-exchange">${p.exchangeName || ''}</div>
        </div>
        <div>
          <div class="profile-price">${price}</div>
          <div class="profile-change ${dir}">${chgStr}</div>
        </div>
      </div>
      <div class="chart-section">
        <div class="chart-period-buttons" id="chart-periods-${symbol}">
          ${chartRanges.map(([r,l]) => `<button class="chart-period-btn${r==='1mo'?' active':''}" data-range="${r}">${l}</button>`).join('')}
        </div>
        <div class="chart-container" id="chart-${symbol}"><div class="chart-loading">Loading chart…</div></div>
        <div class="chart-stats" id="chart-stats-${symbol}"></div>
      </div>

      <div class="profile-section-label">Key Statistics</div>
      <div class="profile-stats-grid">
        ${stat('Market Cap', p.marketCap)}
        ${stat('P/E (TTM)', p.trailingPE)}
        ${stat('Forward P/E', p.forwardPE)}
        ${stat('EPS (TTM)', p.eps)}
        ${stat('Forward EPS', p.forwardEps)}
        ${stat('52w Low', p.week52Low ? '$' + p.week52Low.toFixed(2) : null)}
        ${stat('52w High', p.week52High ? '$' + p.week52High.toFixed(2) : null)}
        ${stat('Beta', p.beta)}
        ${stat('Avg Volume', p.avgVolume)}
        ${stat('50-Day Avg', p.fiftyDayAvg ? '$' + p.fiftyDayAvg.toFixed(2) : null)}
        ${stat('200-Day Avg', p.twoHundredDayAvg ? '$' + p.twoHundredDayAvg.toFixed(2) : null)}
        ${stat('Dividend', p.dividendYield || 'None')}
        ${stat('P/B Ratio', p.priceToBook)}
        ${stat('Short Float', p.shortPercentOfFloat)}
        ${stat('Shares Out', p.sharesOutstanding)}
      </div>

      <div class="profile-section-label">Financial Health</div>
      <div class="profile-stats-grid">
        ${stat('Revenue', p.revenue)}
        ${stat('Rev Growth', p.revenueGrowth)}
        ${stat('Gross Margin', p.grossMargins)}
        ${stat('Op Margin', p.operatingMargins)}
        ${stat('Profit Margin', p.profitMargins)}
        ${stat('ROE', p.returnOnEquity)}
        ${stat('Total Cash', p.totalCash)}
        ${stat('Total Debt', p.totalDebt)}
        ${stat('Debt/Equity', p.debtToEquity)}
        ${stat('Current Ratio', p.currentRatio)}
        ${stat('Free Cash Flow', p.freeCashflow)}
      </div>

      <div class="profile-section-label">Analyst Consensus (${p.numberOfAnalysts || 0} analysts)</div>
      ${p.recommendationKey ? `<div style="font-size:13px;font-weight:700;color:var(--blue);margin-bottom:4px;text-transform:uppercase">${p.recommendationKey}</div>` : ''}
      <div class="profile-stats-grid">
        ${stat('Target Low', p.targetLowPrice ? '$' + p.targetLowPrice.toFixed(2) : null)}
        ${stat('Target Mean', p.targetMeanPrice ? '$' + p.targetMeanPrice.toFixed(2) : null)}
        ${stat('Target High', p.targetHighPrice ? '$' + p.targetHighPrice.toFixed(2) : null)}
      </div>
      ${analystHtml}

      ${eq.length ? `<div class="profile-section-label">Quarterly Earnings (EPS)</div>${epsHtml}` : ''}
      ${p.earningsDate || p.currentQuarterEstimate != null ? `
        <div class="next-quarter-box">
          <div class="next-quarter-title">📅 Next Quarter Estimate${p.currentQuarterEstimateDate ? ' (' + p.currentQuarterEstimateDate + ')' : ''}</div>
          <div class="next-quarter-grid">
            ${p.earningsDate ? `<div class="next-quarter-item"><span class="next-quarter-label">Earnings Date</span><span class="next-quarter-value">${p.earningsDate}</span></div>` : ''}
            ${p.earningsAvgEstRaw != null ? `<div class="next-quarter-item"><span class="next-quarter-label">Consensus EPS</span><span class="next-quarter-value">$${p.earningsAvgEstRaw.toFixed(2)}</span></div>` : ''}
            ${p.earningsLowEst != null ? `<div class="next-quarter-item"><span class="next-quarter-label">EPS Low Est.</span><span class="next-quarter-value">$${p.earningsLowEst.toFixed(2)}</span></div>` : ''}
            ${p.earningsHighEst != null ? `<div class="next-quarter-item"><span class="next-quarter-label">EPS High Est.</span><span class="next-quarter-value">$${p.earningsHighEst.toFixed(2)}</span></div>` : ''}
            ${p.currentQuarterEstimate != null ? `<div class="next-quarter-item"><span class="next-quarter-label">Current Qtr Est.</span><span class="next-quarter-value">$${p.currentQuarterEstimate.toFixed(2)}</span></div>` : ''}
          </div>
        </div>` : ''}

      <div class="profile-section-label">Quarterly Financial Reports</div>
      <button class="btn-secondary" style="font-size:11px;padding:5px 10px;width:100%" onclick="loadFinancials('${symbol}')">📊 View Quarterly Reports</button>
      <div id="financials-${symbol}" class="financials-container" style="display:none"></div>

      ${newsHtml ? `<div class="profile-section-label">Latest Headlines (scroll for more)</div><div class="profile-news-scroll">${newsHtml}<div class="profile-news-xlink"><a href="#" onclick="navigate('news');return false;">📰 See all news in Latest News →</a></div></div>` : ''}
    `;
    // Initialize interactive chart
    loadChart(symbol, '1mo');
    document.querySelectorAll(`#chart-periods-${symbol} .chart-period-btn`).forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll(`#chart-periods-${symbol} .chart-period-btn`).forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        loadChart(symbol, btn.dataset.range);
      });
    });
  } catch (e) {
    panel.innerHTML = `<div class="modal-right-loading">Failed to load profile</div>`;
  }
}

/* ─── INTERACTIVE CHART WITH HOVER TOOLTIP ────────────────────── */
let chartDataCache = {}; // stores data points for hover interaction

async function loadChart(symbol, range = '1mo') {
  const container = document.getElementById(`chart-${symbol}`);
  const statsEl = document.getElementById(`chart-stats-${symbol}`);
  if (!container) return;
  container.innerHTML = '<div class="chart-loading">Loading…</div>';
  try {
    const data = await api('GET', `/stock/${symbol}/chart?range=${range}`);
    const pts = (data.dataPoints || []).filter(p => p.close !== null);
    if (pts.length < 2) { container.innerHTML = '<div class="chart-loading">No data available</div>'; return; }

    const closes = pts.map(p => p.close);
    const timestamps = pts.map(p => p.timestamp);
    const highs = pts.map(p => p.high);
    const lows = pts.map(p => p.low);
    const volumes = pts.map(p => p.volume);
    const first = closes[0], last = closes[closes.length - 1];
    const basePrice = data.previousClose || first;
    const perf = ((last - basePrice) / basePrice * 100).toFixed(2);
    const perfSign = perf >= 0 ? '+' : '';
    const dir = perf >= 0 ? 'up' : 'down';
    const color = dir === 'up' ? '#3fb950' : '#f85149';
    const fillColor = dir === 'up' ? '#3fb95018' : '#f8514918';

    const W = 460, H = 140;
    const min = Math.min(...closes), max = Math.max(...closes);
    const span = max - min || 1;
    const step = W / (closes.length - 1);
    const toY = v => H - ((v - min) / span) * (H - 10) - 5;
    const ptStr = closes.map((v, i) => `${(i * step).toFixed(1)},${toY(v).toFixed(1)}`);
    const baseY = toY(Math.max(min, Math.min(max, basePrice))).toFixed(1);
    const areaPath = `M0,${H} L${ptStr.join(' L')} L${W},${H} Z`;

    // Store chart data for hover interaction
    chartDataCache[symbol] = { closes, timestamps, highs, lows, volumes, basePrice, min, max, span, W, H, step, toY, color, range };

    // Y-axis labels (5 levels)
    const yLabels = [];
    for (let i = 0; i <= 4; i++) {
      const val = min + (span * i / 4);
      const y = toY(val);
      yLabels.push(`<line x1="0" y1="${y.toFixed(1)}" x2="${W}" y2="${y.toFixed(1)}" stroke="#21262d" stroke-width="0.5"/>
        <text x="${W - 2}" y="${(y - 3).toFixed(1)}" fill="#484f58" font-size="8" text-anchor="end">$${val.toFixed(2)}</text>`);
    }

    container.innerHTML = `
      <svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" preserveAspectRatio="none" style="display:block">
        ${yLabels.join('')}
        <line x1="0" y1="${baseY}" x2="${W}" y2="${baseY}" stroke="#484f58" stroke-width="1" stroke-dasharray="4,4"/>
        <path d="${areaPath}" fill="${fillColor}"/>
        <polyline points="${ptStr.join(' ')}" fill="none" stroke="${color}" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/>
      </svg>
      <div class="chart-overlay" data-symbol="${symbol}"></div>
      <div class="chart-crosshair"></div>
      <div class="chart-dot" style="background:${color}"></div>
      <div class="chart-tooltip"></div>`;

    // Add hover interaction
    const overlay = container.querySelector('.chart-overlay');
    const crosshair = container.querySelector('.chart-crosshair');
    const dot = container.querySelector('.chart-dot');
    const tooltip = container.querySelector('.chart-tooltip');

    overlay.addEventListener('mousemove', (e) => {
      const rect = overlay.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const pct = x / rect.width;
      const idx = Math.round(pct * (closes.length - 1));
      if (idx < 0 || idx >= closes.length) return;

      const price = closes[idx];
      const ts = timestamps[idx];
      const high = highs[idx];
      const low = lows[idx];
      const vol = volumes[idx];
      const chgFromBase = ((price - basePrice) / basePrice * 100).toFixed(2);
      const chgSign = chgFromBase >= 0 ? '+' : '';
      const chgDir = chgFromBase >= 0 ? 'up' : 'down';

      // Date formatting based on range
      const dateObj = new Date(ts * 1000);
      let dateStr;
      if (range === '1d' || range === '5d') {
        dateStr = dateObj.toLocaleString('en-US', { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' });
      } else {
        dateStr = dateObj.toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' });
      }

      // Position elements
      const xPct = (idx / (closes.length - 1)) * 100;
      const yVal = toY(price);
      const yPct = (yVal / H) * 100;

      crosshair.style.display = 'block';
      crosshair.style.left = xPct + '%';

      dot.style.display = 'block';
      dot.style.left = xPct + '%';
      dot.style.top = yPct + '%';

      tooltip.style.display = 'block';
      // Position tooltip - if near right edge, shift left
      tooltip.style.left = xPct < 75 ? xPct + '%' : (xPct - 10) + '%';
      tooltip.innerHTML = `
        <div class="chart-tooltip-price">$${price.toFixed(2)}</div>
        <div class="chart-tooltip-date">${dateStr}</div>
        <div class="chart-tooltip-change" style="color:var(--${chgDir === 'up' ? 'green' : 'red'})">${chgSign}${chgFromBase}%</div>
        ${high != null ? `<div style="font-size:9px;color:var(--text-dim)">H: $${high.toFixed(2)} · L: $${low.toFixed(2)}${vol ? ' · Vol: ' + fmtVol(vol) : ''}</div>` : ''}`;
    });

    overlay.addEventListener('mouseleave', () => {
      crosshair.style.display = 'none';
      dot.style.display = 'none';
      tooltip.style.display = 'none';
    });

    if (statsEl) {
      const highAll = Math.max(...closes), lowAll = Math.min(...closes);
      statsEl.innerHTML = `
        <div class="chart-stat-row">
          <span>Open: $${first.toFixed(2)}</span>
          <span>High: $${highAll.toFixed(2)}</span>
          <span>Low: $${lowAll.toFixed(2)}</span>
          <span>Current: $${last.toFixed(2)}</span>
          <span class="${dir}">Return: ${perfSign}${perf}%</span>
        </div>`;
    }
  } catch (e) {
    container.innerHTML = `<div class="chart-loading">Chart unavailable</div>`;
  }
}

/* ─── QUARTERLY FINANCIALS (Schwab-style with tabs + charts) ──── */
let financialsDataCache = {};
let financialsActiveTab = {};

const FIN_FMT = v => {
  if (v === null || v === undefined) return '—';
  const abs = Math.abs(v), sign = v < 0 ? '-' : '';
  if (abs >= 1e9) return sign + '$' + (abs/1e9).toFixed(1) + 'B';
  if (abs >= 1e6) return sign + '$' + (abs/1e6).toFixed(0) + 'M';
  if (abs >= 1e3) return sign + '$' + (abs/1e3).toFixed(0) + 'K';
  return sign + '$' + abs.toFixed(0);
};

const FIN_FMT_SHORT = v => {
  if (v === null || v === undefined) return '—';
  const abs = Math.abs(v), sign = v < 0 ? '-' : '';
  if (abs >= 1e9) return sign + (abs/1e9).toFixed(1) + 'B';
  if (abs >= 1e6) return sign + (abs/1e6).toFixed(0) + 'M';
  return sign + abs.toFixed(0);
};

function buildFinBarChart(items, title) {
  // items: [{label, value}]
  const validItems = items.filter(i => i.value != null);
  if (!validItems.length) return '';
  const maxVal = Math.max(...validItems.map(i => Math.abs(i.value)));
  if (maxVal === 0) return '';
  return `
    <div class="fin-chart-section">
      <div class="fin-chart-title">${title}</div>
      <div class="fin-bar-chart">
        ${validItems.map(item => {
          const pct = Math.max(5, (Math.abs(item.value) / maxVal) * 100);
          const cls = item.value >= 0 ? 'positive' : 'negative';
          return `<div class="fin-bar-group">
            <div class="fin-bar-value">${FIN_FMT_SHORT(item.value)}</div>
            <div class="fin-bar ${cls}" style="height:${pct}%"></div>
            <div class="fin-bar-label">${item.label}</div>
          </div>`;
        }).join('')}
      </div>
    </div>`;
}

function trendArrow(arr, key) {
  if (!arr || arr.length < 2) return '';
  const cur = arr[0]?.[key], prev = arr[1]?.[key];
  if (cur == null || prev == null) return '';
  if (cur > prev) return '<span class="fin-trend up">▲</span>';
  if (cur < prev) return '<span class="fin-trend down">▼</span>';
  return '';
}

function buildFinTable(quarters, rows) {
  return `<div class="financials-table">
    <div class="fin-row fin-header">
      <div class="fin-cell fin-label">Metric</div>
      ${quarters.map(q => `<div class="fin-cell">${q.endDate || '—'}</div>`).join('')}
    </div>
    ${rows.map(([label, key, formatter]) => `
      <div class="fin-row">
        <div class="fin-cell fin-label">${label}${trendArrow(quarters, key)}</div>
        ${quarters.map(q => {
          const v = q[key];
          const val = formatter ? formatter(v) : FIN_FMT(v);
          return `<div class="fin-cell">${val}</div>`;
        }).join('')}
      </div>`).join('')}
  </div>`;
}

async function loadFinancials(symbol) {
  const container = document.getElementById(`financials-${symbol}`);
  if (!container) return;
  if (container.style.display !== 'none' && container.innerHTML && financialsDataCache[symbol]) {
    container.style.display = 'none'; return;
  }
  container.style.display = 'block';
  container.innerHTML = '<div class="chart-loading">Loading financial data…</div>';

  try {
    const data = financialsDataCache[symbol] || await api('GET', `/stock/${symbol}/financials`);
    financialsDataCache[symbol] = data;
    financialsActiveTab[symbol] = financialsActiveTab[symbol] || 'income';
    renderFinancialsTab(symbol);
  } catch (e) {
    container.innerHTML = `<div class="chart-loading">Failed to load: ${e.message}</div>`;
  }
}

function renderFinancialsTab(symbol) {
  const container = document.getElementById(`financials-${symbol}`);
  const data = financialsDataCache[symbol];
  if (!container || !data) return;
  const tab = financialsActiveTab[symbol] || 'income';

  const income = (data.income || data.quarterly || []).slice(0, 4);
  const balance = (data.balance || []).slice(0, 4);
  const cashflow = (data.cashflow || []).slice(0, 4);

  let content = '';

  if (tab === 'income' && income.length) {
    const labels = income.map(q => q.endDate?.split('-').slice(1).join('/') || '—');
    content = buildFinBarChart(
      income.map((q, i) => ({ label: labels[i], value: q.revenue })),
      '📊 Revenue by Quarter'
    ) + buildFinBarChart(
      income.map((q, i) => ({ label: labels[i], value: q.netIncome })),
      '💰 Net Income by Quarter'
    ) + buildFinBarChart(
      income.map((q, i) => ({ label: labels[i], value: q.grossProfit })),
      '📈 Gross Profit by Quarter'
    ) + buildFinTable(income, [
      ['Revenue', 'revenue'],
      ['Cost of Revenue', 'costOfRevenue'],
      ['Gross Profit', 'grossProfit'],
      ['R&D Expense', 'researchDevelopment'],
      ['SG&A Expense', 'sellingGeneralAdmin'],
      ['Operating Income', 'operatingIncome'],
      ['Net Income', 'netIncome'],
      ['EPS (Diluted)', 'eps', v => v != null ? '$' + v.toFixed(2) : '—'],
      ['EBITDA', 'ebitda'],
    ]);
  } else if (tab === 'balance' && balance.length) {
    const labels = balance.map(q => q.endDate?.split('-').slice(1).join('/') || '—');
    content = buildFinBarChart(
      balance.map((q, i) => ({ label: labels[i], value: q.totalAssets })),
      '🏦 Total Assets'
    ) + buildFinBarChart(
      [
        ...balance.map((q, i) => ({ label: 'Equity ' + labels[i], value: q.totalEquity })),
      ].filter(x => x.value != null),
      '⚖️ Equity vs Liabilities'
    ) + buildFinTable(balance, [
      ['Cash', 'cash'],
      ['Short-term Inv.', 'shortTermInvestments'],
      ['Net Receivables', 'netReceivables'],
      ['Inventory', 'inventory'],
      ['Total Current Assets', 'totalCurrentAssets'],
      ['PP&E', 'propertyPlantEquipment'],
      ['Goodwill', 'goodwill'],
      ['Total Assets', 'totalAssets'],
      ['Accounts Payable', 'accountsPayable'],
      ['Current Liabilities', 'totalCurrentLiabilities'],
      ['Long-term Debt', 'longTermDebt'],
      ['Total Liabilities', 'totalLiabilities'],
      ['Total Equity', 'totalEquity'],
    ]);
  } else if (tab === 'cashflow' && cashflow.length) {
    const labels = cashflow.map(q => q.endDate?.split('-').slice(1).join('/') || '—');
    content = buildFinBarChart(
      cashflow.map((q, i) => ({ label: labels[i], value: q.operatingCashflow })),
      '🔄 Operating Cash Flow'
    ) + buildFinBarChart(
      cashflow.map((q, i) => ({ label: labels[i], value: q.freeCashflow })),
      '💵 Free Cash Flow'
    ) + buildFinTable(cashflow, [
      ['Net Income', 'netIncome'],
      ['Depreciation', 'depreciation'],
      ['Operating Cash Flow', 'operatingCashflow'],
      ['Capital Expenditure', 'capitalExpenditure'],
      ['Investing Cash Flow', 'investingCashflow'],
      ['Dividends Paid', 'dividendsPaid'],
      ['Financing Cash Flow', 'financingCashflow'],
      ['Free Cash Flow', 'freeCashflow'],
      ['Change in Cash', 'changeInCash'],
    ]);
  } else {
    content = '<div class="chart-loading">No data available for this section</div>';
  }

  container.innerHTML = `
    <div class="fin-tabs">
      <button class="fin-tab ${tab==='income'?'active':''}" onclick="switchFinTab('${symbol}','income')">Income Statement</button>
      <button class="fin-tab ${tab==='balance'?'active':''}" onclick="switchFinTab('${symbol}','balance')">Balance Sheet</button>
      <button class="fin-tab ${tab==='cashflow'?'active':''}" onclick="switchFinTab('${symbol}','cashflow')">Cash Flow</button>
    </div>
    ${content}`;
}

function switchFinTab(symbol, tab) {
  financialsActiveTab[symbol] = tab;
  renderFinancialsTab(symbol);
}

function showFinancialsFromHeader() {
  if (!state.selectedSymbol) return;
  const symbol = state.selectedSymbol.symbol;
  const panel = document.getElementById('modal-right-panel');
  if (panel) {
    const finEl = document.getElementById(`financials-${symbol}`);
    if (finEl) { loadFinancials(symbol); finEl.scrollIntoView({ behavior: 'smooth' }); }
  }
}

/* ─── EARNINGS INFO (left panel section) ──────────────────────── */
async function loadEarningsInfo(symbol) {
  const infoEl = document.getElementById('earnings-info');
  try {
    const p = state.profiles[symbol] || await api('GET', `/stock/${symbol}/profile`);
    state.profiles[symbol] = p;

    const eq = p.earningsQuarterly || [];
    const lastQ = eq.length ? eq[eq.length - 1] : null;
    let html = '';
    if (lastQ) {
      const beat = lastQ.actual !== null && lastQ.estimate !== null ? (lastQ.actual >= lastQ.estimate ? '✅ Beat' : '❌ Missed') : '';
      html += `<div class="earnings-info-row">Last Earnings (<strong>${lastQ.date}</strong>): EPS <strong>$${lastQ.actual?.toFixed(2) ?? '—'}</strong> (est. $${lastQ.estimate?.toFixed(2) ?? '—'}) ${beat}</div>`;
    }
    if (p.earningsDate) {
      html += `<div class="earnings-info-row">Next Earnings: <strong>${p.earningsDate}</strong>${p.earningsAvgEst ? ` · Est. EPS: $${p.earningsAvgEst}` : ''}</div>`;
    }
    if (!html) html = '<div class="earnings-info-row">No earnings data available</div>';
    infoEl.innerHTML = html;
  } catch (e) {
    infoEl.innerHTML = '<div class="earnings-info-row">Could not load earnings data</div>';
  }
}

function quickAdd(symbol) {
  showAddAlertModal();
  document.getElementById('symbol-search').value = symbol;
  selectSymbol(symbol, symbol, 'EQUITY');
}

/* ─── SUBMIT ALERT (batch + optional earnings alert) ──────────── */
async function submitAlert() {
  clearModalError();
  if (!state.selectedSymbol) { showModalError('Please select a symbol first'); return; }

  // Gather filled conditions from all 6 checkbox rows
  const conditions = [];
  document.querySelectorAll('.cond-check').forEach((check, i) => {
    if (!check.checked) return;
    const type = check.dataset.type;
    const inp = document.querySelector(`input[data-row="${i}"]`);
    const val = parseFloat(inp?.value);
    if (type && !isNaN(val) && val > 0) {
      conditions.push({ conditionType: type, conditionValue: val });
    }
  });

  // Earnings alert (from separate section)
  const earningsCheck = document.getElementById('earnings-alert-check')?.checked;
  const earningsDays = parseInt(document.getElementById('earnings-days-input')?.value) || 7;
  if (earningsCheck && earningsDays > 0) {
    conditions.push({ conditionType: 'earnings_before', conditionValue: earningsDays });
  }

  if (!conditions.length) { showModalError('Fill at least one condition or enable earnings alert'); return; }

  const notificationMethods = [];
  if (document.getElementById('notify-popup').checked) notificationMethods.push('popup');
  if (document.getElementById('notify-email').checked) notificationMethods.push('email');
  if (document.getElementById('notify-sms').checked) notificationMethods.push('sms');
  if (!notificationMethods.length) { showModalError('Select at least one notification method'); return; }

  const repeatAlert = document.getElementById('repeat-alert').checked;
  const btn = document.getElementById('submit-alert-btn');
  btn.disabled = true; btn.textContent = 'Creating…';

  try {
    const created = await api('POST', '/alerts/batch', {
      symbol: state.selectedSymbol.symbol,
      customName: state.selectedSymbol.name,
      conditions, notificationMethods, repeatAlert,
    });
    created.forEach(a => state.alerts.push(a));
    state.stocks[state.selectedSymbol.symbol] = state.stocks[state.selectedSymbol.symbol] || {};
    Object.assign(state.stocks[state.selectedSymbol.symbol], { price: created[0]?.basePrice, name: created[0]?.name });
    hideAddAlertModal();
    navigate('dashboard');
    showSuccessToast(`Created ${created.length} alert(s) for ${state.selectedSymbol.symbol}`);
  } catch (e) {
    showModalError(e.message);
    btn.disabled = false; btn.textContent = 'Create Alert(s)';
  }
}

function showModalError(msg) { const el = document.getElementById('modal-error'); el.textContent = msg; el.style.display = 'block'; }
function clearModalError() { document.getElementById('modal-error').style.display = 'none'; }

/* ─── NEWS MODAL (click a card) ───────────────────────────────── */
async function showNewsModal(symbol) {
  const modal = document.getElementById('news-modal');
  const titleEl = document.getElementById('news-modal-title');
  const bodyEl = document.getElementById('news-modal-body');

  titleEl.textContent = `📰 ${symbol} — Financial News & Highlights`;
  bodyEl.innerHTML = '<div class="news-loading">Loading news…</div>';
  modal.classList.add('active');
  document.body.style.overflow = 'hidden';

  try {
    // Fetch news + profile in parallel
    const [news, profile] = await Promise.all([
      api('GET', `/stock/${symbol}/news`),
      state.profiles[symbol] ? Promise.resolve(state.profiles[symbol]) : api('GET', `/stock/${symbol}/profile`),
    ]);
    state.profiles[symbol] = profile;
    const s = state.stocks[symbol] || {};

    // Header section with highlights
    let headerHtml = '<div class="news-header-section">';
    if (typeof s.price === 'number') {
      const dir = s.changePercent >= 0 ? 'up' : 'down';
      headerHtml += `<div class="news-header-price" style="color:var(--${dir === 'up' ? 'green' : 'red'})">$${s.price.toFixed(2)} (${s.changePercent >= 0 ? '+' : ''}${s.changePercent.toFixed(2)}%)</div>`;
    }
    const highlights = [];
    if (profile.recommendationKey) highlights.push(`Analyst: ${profile.recommendationKey.toUpperCase()}`);
    if (profile.targetMeanPrice) highlights.push(`Target: $${profile.targetMeanPrice.toFixed(2)}`);
    if (profile.earningsDate) highlights.push(`Next Earnings: ${profile.earningsDate}`);
    if (profile.marketCap) highlights.push(`Cap: ${profile.marketCap}`);
    if (highlights.length) {
      headerHtml += `<div class="news-header-highlights">${highlights.map(h => `<span>${h}</span>`).join('')}</div>`;
    }
    headerHtml += '</div>';

    if (!news.length) { bodyEl.innerHTML = headerHtml + '<div class="news-empty">No recent news found for this symbol.</div>'; return; }

    bodyEl.innerHTML = headerHtml + news.map(n => {
      const date = n.publishedAt ? new Date(n.publishedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '';
      const thumb = n.thumbnail ? `<img class="news-thumb" src="${n.thumbnail}" alt="" onerror="this.style.display='none'" />` : '';
      return `<div class="news-item">${thumb}<div class="news-content"><div class="news-title"><a href="${n.link}" target="_blank" rel="noopener">${n.title}</a></div><div class="news-meta"><span class="news-publisher">${n.publisher || ''}</span><span>${date}</span></div></div></div>`;
    }).join('');
  } catch (e) {
    bodyEl.innerHTML = `<div class="news-empty">Failed to load news: ${e.message}</div>`;
  }
}

function hideNewsModal() {
  document.getElementById('news-modal').classList.remove('active');
  document.body.style.overflow = '';
}

/* ─── STOCK DETAIL POPUP (Detailed Table row click) ──────────── */
async function showStockDetailPopup(symbol) {
  const modal = document.getElementById('stock-detail-modal');
  const titleEl = document.getElementById('stock-detail-modal-title');
  const bodyEl = document.getElementById('stock-detail-modal-body');
  if (!modal) return;

  titleEl.textContent = `📊 ${symbol} — Full Details`;
  bodyEl.innerHTML = '<div class="hover-loading" style="padding:24px">Loading details…</div>';
  modal.classList.add('active');
  document.body.style.overflow = 'hidden';

  try {
    if (!state.stocks[symbol]?.price) {
      const quote = await api('GET', `/stock/${symbol}`);
      state.stocks[symbol] = { ...state.stocks[symbol], ...quote };
    }
    if (!state.profiles[symbol]) {
      state.profiles[symbol] = await api('GET', `/stock/${symbol}/profile`);
    }
    // Render the hover popup content into a temp div then move to modal
    const tmp = document.createElement('div');
    tmp.className = 'stock-detail-popup-content';
    renderHoverPopup(symbol, tmp);
    bodyEl.innerHTML = '';
    bodyEl.appendChild(tmp);
  } catch (e) {
    bodyEl.innerHTML = `<div class="hover-loading" style="padding:24px">Failed to load: ${e.message}</div>`;
  }
}

function hideStockDetailModal() {
  document.getElementById('stock-detail-modal').classList.remove('active');
  document.body.style.overflow = '';
}

/* ─── BROWSER NOTIFICATIONS ───────────────────────────────────── */
/* ─── MUTE ALERTS ────────────────────────────────────────────── */
function toggleAlertsMute() {
  state.alertsMuted = !state.alertsMuted;
  localStorage.setItem('alertsMuted', state.alertsMuted);
  updateMuteBtn();
}
function updateMuteBtn() {
  const btn = document.getElementById('mute-alerts-btn');
  const icon = document.getElementById('mute-icon');
  const label = document.getElementById('mute-label');
  if (!btn) return;
  if (state.alertsMuted) {
    btn.classList.add('muted');
    if (icon) icon.textContent = '🔕';
    if (label) label.textContent = 'Alerts Off';
  } else {
    btn.classList.remove('muted');
    if (icon) icon.textContent = '🔔';
    if (label) label.textContent = 'Alerts On';
  }
}

function showBrowserNotification(notification) {
  if (state.alertsMuted) return;
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  new Notification(`📈 ${notification.symbol} Alert!`, {
    body: notification.message,
    icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">📈</text></svg>',
    tag: 'stock-alert-' + notification.symbol,
  });
}

/* ─── TOAST NOTIFICATIONS ─────────────────────────────────────── */
function showAlertToast(n) { if (state.alertsMuted) return; createToast({ type: 'alert-toast', icon: '🔔', title: `Alert: ${n.symbol}`, message: n.message, duration: 8000 }); }
function showSuccessToast(msg) { createToast({ type: 'success-toast', icon: '✅', title: 'Success', message: msg, duration: 3500 }); }
function showErrorToast(msg) { createToast({ type: 'error-toast', icon: '⚠️', title: 'Error', message: msg, duration: 5000 }); }

function createToast({ type, icon, title, message, duration = 4000 }) {
  const container = document.getElementById('toast-container');
  const id = 'toast-' + Date.now();
  const div = document.createElement('div');
  div.className = `toast ${type}`; div.id = id;
  div.innerHTML = `<span class="toast-icon">${icon}</span><div class="toast-body"><div class="toast-title">${title}</div><div class="toast-message">${message}</div></div><button class="toast-close" onclick="dismissToast('${id}')">✕</button>`;
  container.appendChild(div);
  setTimeout(() => dismissToast(id), duration);
}

function dismissToast(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.style.animation = 'slideOut .3s ease forwards';
  setTimeout(() => el.remove(), 300);
}

/* ─── DASHBOARD EDIT MODE ─────────────────────────────────────── */
let editMode = false;
let dragSrc = null;

function toggleEditMode() {
  editMode = !editMode;
  const grid = document.getElementById('stocks-grid');
  const btn = document.getElementById('edit-mode-btn');
  if (editMode) {
    grid.classList.add('edit-mode');
    if (btn) { btn.textContent = '✅ Done'; btn.classList.add('active-edit'); }
    addEditModeHandlers();
  } else {
    grid.classList.remove('edit-mode');
    if (btn) { btn.textContent = '✏️ Edit'; btn.classList.remove('active-edit'); }
    document.querySelectorAll('.card-delete-btn').forEach(b => b.remove());
    document.querySelectorAll('.stock-card').forEach(c => { c.draggable = false; c.onclick = () => showNewsModal(c.id.replace('card-', '')); });
    saveCardOrder();
  }
}

function addEditModeHandlers() {
  document.querySelectorAll('.stock-card').forEach(card => {
    const sym = card.id.replace('card-', '');
    const del = document.createElement('button');
    del.className = 'card-delete-btn';
    del.textContent = '×';
    del.onclick = e => { e.stopPropagation(); removeFromDashboard(sym); };
    card.appendChild(del);
    card.draggable = true;
    card.addEventListener('dragstart', onDragStart);
    card.addEventListener('dragover', onDragOver);
    card.addEventListener('dragleave', onDragLeave);
    card.addEventListener('drop', onDrop);
    card.addEventListener('dragend', onDragEnd);
  });
}

function onDragStart(e) { dragSrc = this; this.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; }
function onDragOver(e) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; this.classList.add('drag-over'); }
function onDragLeave() { this.classList.remove('drag-over'); }
function onDragEnd() { this.classList.remove('dragging'); document.querySelectorAll('.stock-card').forEach(c => c.classList.remove('drag-over')); }
function onDrop(e) {
  e.stopPropagation(); e.preventDefault();
  this.classList.remove('drag-over');
  if (dragSrc === this) return;
  const grid = document.getElementById('stocks-grid');
  const cards = [...grid.querySelectorAll('.stock-card')];
  const srcIdx = cards.indexOf(dragSrc), tgtIdx = cards.indexOf(this);
  if (srcIdx < tgtIdx) grid.insertBefore(dragSrc, this.nextSibling);
  else grid.insertBefore(dragSrc, this);
}

async function saveCardOrder() {
  const grid = document.getElementById('stocks-grid');
  const order = [...grid.querySelectorAll('.stock-card')].map(c => c.id.replace('card-', ''));
  state.settings.dashboardOrder = order;
  try { await api('PUT', '/dashboard/order', { order }); } catch (e) { console.warn('Order save failed:', e); }
}

async function removeFromDashboard(symbol) {
  if (!confirm(`Remove ${symbol} from dashboard? All its alerts will be deleted.`)) return;
  const toDelete = state.alerts.filter(a => a.symbol === symbol);
  try {
    await Promise.all(toDelete.map(a => api('DELETE', `/alerts/${a.id}`)));
    state.alerts = state.alerts.filter(a => a.symbol !== symbol);
    if (state.settings.dashboardOrder) state.settings.dashboardOrder = state.settings.dashboardOrder.filter(s => s !== symbol);
    renderDashboard(); renderAlerts();
    // Stay in edit mode — re-add handlers
    if (editMode) {
      const grid = document.getElementById('stocks-grid');
      grid.classList.add('edit-mode');
      addEditModeHandlers();
    }
    showSuccessToast(`${symbol} removed`);
  } catch (e) { showErrorToast(e.message); }
}

/* ─── LATEST NEWS VIEW ────────────────────────────────────────── */
let latestNewsData = null;
let newsFilter = 'all';
let newsCategoryFilter = 'all';
let newsClickHistory = JSON.parse(localStorage.getItem('newsClickHistory') || '{}');
let newsCustomSymbols = JSON.parse(localStorage.getItem('newsCustomSymbols') || '[]');
let savedArticles = JSON.parse(localStorage.getItem('savedArticles') || '[]');

/* ─── SAVE / SHARE NEWS ──────────────────────────────────────── */
function toggleSaveArticle(encTitle, encLink, encSource, pubDate, btn) {
  const title = decodeURIComponent(encTitle);
  const link = decodeURIComponent(encLink);
  const source = decodeURIComponent(encSource);
  const key = title.slice(0, 80);
  const idx = savedArticles.findIndex(a => a.title?.slice(0, 80) === key);
  if (idx >= 0) {
    savedArticles.splice(idx, 1);
    if (btn) { btn.classList.remove('saved'); btn.title = 'Save article'; }
  } else {
    savedArticles.unshift({ title, link, source, pubDate, savedAt: new Date().toISOString() });
    if (btn) { btn.classList.add('saved'); btn.title = 'Unsave'; }
  }
  localStorage.setItem('savedArticles', JSON.stringify(savedArticles));
  // Update badge
  const badge = document.getElementById('nav-saved-badge');
  if (badge) { badge.textContent = savedArticles.length; badge.style.display = savedArticles.length ? 'inline' : 'none'; }
}

function showShareMenu(encTitle, encLink, btn) {
  // Remove any existing share dropdowns
  document.querySelectorAll('.share-dropdown').forEach(d => d.remove());
  const title = decodeURIComponent(encTitle);
  const link = decodeURIComponent(encLink);
  const text = encodeURIComponent(title + ' ' + link);
  const dropdown = document.createElement('div');
  dropdown.className = 'share-dropdown';
  dropdown.innerHTML = `
    <a href="mailto:?subject=${encodeURIComponent(title)}&body=${encodeURIComponent(link)}" target="_blank">📧 Email</a>
    <a href="https://api.whatsapp.com/send?text=${text}" target="_blank">📱 WhatsApp</a>
    <a href="https://mail.google.com/mail/?view=cm&su=${encodeURIComponent(title)}&body=${encodeURIComponent(link)}" target="_blank">✉️ Gmail</a>
    <a href="#" onclick="navigator.clipboard.writeText('${link.replace(/'/g,"\\'")}').then(()=>{this.textContent='✅ Copied!';setTimeout(()=>this.textContent='💬 WeChat / Copy Link',1500)});return false;">💬 WeChat / Copy Link</a>
    <a href="https://twitter.com/intent/tweet?text=${encodeURIComponent(title)}&url=${encodeURIComponent(link)}" target="_blank">𝕏 Twitter</a>`;
  // Position near button
  const rect = btn.getBoundingClientRect();
  dropdown.style.position = 'fixed';
  dropdown.style.top = (rect.bottom + 4) + 'px';
  dropdown.style.left = Math.min(rect.left, window.innerWidth - 200) + 'px';
  document.body.appendChild(dropdown);
  setTimeout(() => document.addEventListener('click', function rm() { dropdown.remove(); document.removeEventListener('click', rm); }, { once: true }), 10);
}

function buildNewsActionBtns(title, link, source, pubDate) {
  const encTitle = encodeURIComponent((title || '').slice(0, 200));
  const encLink = encodeURIComponent(link || '');
  const encSrc = encodeURIComponent(source || '');
  const key = (title || '').slice(0, 80);
  const isSaved = savedArticles.some(a => a.title?.slice(0, 80) === key);
  return `
    <div class="news-action-btns">
      <button class="news-save-btn${isSaved ? ' saved' : ''}" onclick="toggleSaveArticle('${encTitle}','${encLink}','${encSrc}','${pubDate||''}',this)" title="${isSaved ? 'Unsave' : 'Save article'}">🔖</button>
      <button class="news-share-btn" onclick="showShareMenu('${encTitle}','${encLink}',this)" title="Share">📤</button>
    </div>`;
}

function renderSavedNews() {
  const view = document.getElementById('saved-news-view');
  if (!view) return;
  if (!savedArticles.length) {
    view.innerHTML = `<div class="view-header"><h1 class="view-title">🔖 Saved News</h1></div><div class="empty-state"><div class="empty-icon">🔖</div><h3>No saved articles yet</h3><p>Click 🔖 on any news article to save it here.</p></div>`;
    return;
  }
  view.innerHTML = `
    <div class="view-header">
      <div><h1 class="view-title">🔖 Saved News</h1><p class="view-subtitle">${savedArticles.length} saved article${savedArticles.length !== 1 ? 's' : ''}</p></div>
      <button class="btn-secondary" onclick="clearSavedNews()">Clear All</button>
    </div>
    <div class="latest-news-list">
      ${savedArticles.map((n, idx) => {
        const date = n.savedAt ? 'Saved ' + new Date(n.savedAt).toLocaleDateString('en-US', {month:'short',day:'numeric'}) : '';
        const pubDate = n.pubDate ? new Date(n.pubDate).toLocaleString('en-US', {month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}) : '';
        return `
          <div class="latest-news-item">
            <div class="latest-news-top">
              <span class="latest-news-source">${n.source || ''}</span>
              <span style="font-size:10px;color:var(--text-dim)">${pubDate}</span>
            </div>
            <div class="latest-news-title"><a href="${n.link}" target="_blank" rel="noopener">${n.title}</a></div>
            <div class="latest-news-time">${date}</div>
            ${buildNewsActionBtns(n.title, n.link, n.source, n.pubDate)}
          </div>`;
      }).join('')}
    </div>`;
}

function clearSavedNews() {
  if (!confirm('Clear all saved articles?')) return;
  savedArticles = [];
  localStorage.setItem('savedArticles', JSON.stringify(savedArticles));
  const badge = document.getElementById('nav-saved-badge');
  if (badge) badge.style.display = 'none';
  renderSavedNews();
}

// All known sources (update tabs dynamically)
const NEWS_SOURCES = ['Yahoo Finance', 'CNBC', 'Bloomberg', 'Reuters', 'MarketWatch'];
const NEWS_CATEGORIES = [
  { key: 'all', label: 'All News' },
  { key: 'breaking', label: '🔴 Breaking' },
  { key: 'portfolio', label: '💼 My Stocks' },
  { key: 'geo', label: '🌍 Geopolitical' },
  { key: 'market', label: '📊 Market' },
];

function recordNewsClick(newsId, categories) {
  if (!newsId) return;
  newsClickHistory[newsId] = (newsClickHistory[newsId] || 0) + 1;
  (categories || []).forEach(cat => {
    const key = `cat_${cat}`;
    newsClickHistory[key] = (newsClickHistory[key] || 0) + 1;
  });
  localStorage.setItem('newsClickHistory', JSON.stringify(newsClickHistory));
}

function applyAILearning(newsItems) {
  // Boost score for categories user has clicked more
  const totalClicks = Object.values(newsClickHistory).reduce((s, v) => s + v, 0);
  if (totalClicks < 5) return newsItems; // not enough data
  return newsItems.map(n => {
    let boost = 0;
    (n.categories || []).forEach(cat => {
      const clicks = newsClickHistory[`cat_${cat}`] || 0;
      boost += (clicks / Math.max(1, totalClicks)) * 20;
    });
    return { ...n, priority: (n.priority || 0) + boost };
  }).sort((a, b) => b.priority - a.priority);
}

async function renderLatestNews() {
  const view = document.getElementById('news-view');
  if (!view) return;

  const watchedSymbols = [...new Set(state.alerts.map(a => a.symbol)), ...newsCustomSymbols].join(',');

  view.innerHTML = `
    <div class="view-header">
      <div>
        <h1 class="view-title">Latest News</h1>
        <p class="view-subtitle" id="news-subtitle">Smart news · prioritized by urgency, geopolitics &amp; your portfolio</p>
      </div>
      <div style="display:flex;gap:8px;align-items:center">
        <button class="btn-outline" onclick="showNewsCustomize()" style="font-size:12px">⚙ Customize</button>
        <button class="btn-secondary" onclick="refreshLatestNews(true)">🔄 Refresh</button>
      </div>
    </div>

    <!-- Category filter tabs -->
    <div class="news-category-tabs" id="news-cat-tabs">
      ${NEWS_CATEGORIES.map(c => `<button class="news-tab ${c.key==='all'?'active':''}" data-cat="${c.key}" onclick="filterNewsCategory('${c.key}')">${c.label}</button>`).join('')}
    </div>

    <!-- Source filter tabs -->
    <div class="news-source-tabs" id="news-tabs">
      <button class="news-tab active" data-src="all" onclick="filterNews('all')">All Sources</button>
      ${NEWS_SOURCES.map(s => `<button class="news-tab" data-src="${s}" onclick="filterNews('${s}')">${s}</button>`).join('')}
      <button class="news-tab" data-src="X" onclick="filterNews('X')">𝕏 Twitter</button>
    </div>

    ${buildXSection()}

    <!-- Customize panel (hidden) -->
    <div id="news-customize-panel" class="news-customize-panel" style="display:none">
      <div class="news-cust-title">📌 Follow Additional Stocks for News</div>
      <div style="display:flex;gap:8px;margin-bottom:8px">
        <input type="text" class="form-input" id="news-cust-sym" placeholder="e.g. NVDA, META, AMZN" style="flex:1;font-size:12px;padding:6px 10px" />
        <button class="btn-secondary" style="font-size:12px" onclick="addNewsCustomSymbol()">Add</button>
      </div>
      <div id="news-cust-sym-list" class="news-cust-sym-list"></div>
      <div class="news-cust-hint">💡 AI learns from which articles you click. Click more articles to improve recommendations.</div>
      <div class="news-cust-ai-bar">
        <span>🧠 AI Learning Progress:</span>
        <div class="news-ai-bar"><div class="news-ai-fill" style="width:${Math.min(100,(Object.keys(newsClickHistory).length/20)*100)}%"></div></div>
        <span style="font-size:11px;color:var(--text-dim)">${Object.values(newsClickHistory).reduce((s,v)=>s+v,0)} article clicks tracked</span>
      </div>
    </div>

    <div id="latest-news-list" class="latest-news-list">
      <div class="news-loading">Loading news…</div>
    </div>`;

  renderNewsCustSymbols();
  await refreshLatestNews();
}

function showNewsCustomize() {
  const panel = document.getElementById('news-customize-panel');
  if (panel) panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
}

function addNewsCustomSymbol() {
  const inp = document.getElementById('news-cust-sym');
  const syms = (inp.value || '').toUpperCase().split(/[,\s]+/).map(s => s.trim()).filter(Boolean);
  syms.forEach(s => { if (s && !newsCustomSymbols.includes(s)) newsCustomSymbols.push(s); });
  localStorage.setItem('newsCustomSymbols', JSON.stringify(newsCustomSymbols));
  inp.value = '';
  renderNewsCustSymbols();
  latestNewsData = null; // force re-fetch with new symbols
  refreshLatestNews();
}

function removeNewsCustomSymbol(sym) {
  newsCustomSymbols = newsCustomSymbols.filter(s => s !== sym);
  localStorage.setItem('newsCustomSymbols', JSON.stringify(newsCustomSymbols));
  renderNewsCustSymbols();
  latestNewsData = null;
  refreshLatestNews();
}

function renderNewsCustSymbols() {
  const el = document.getElementById('news-cust-sym-list');
  if (!el) return;
  const watched = [...new Set(state.alerts.map(a => a.symbol))];
  el.innerHTML = [
    ...watched.map(s => `<span class="news-cust-pill portfolio-pill">${s} <small>tracked</small></span>`),
    ...newsCustomSymbols.map(s => `<span class="news-cust-pill custom-pill">${s} <button onclick="removeNewsCustomSymbol('${s}')" style="background:none;border:none;color:var(--red);cursor:pointer;font-size:11px;padding:0 2px">✕</button></span>`),
  ].join('') || '<span style="color:var(--text-dim);font-size:12px">No custom symbols yet</span>';
}

function buildXSection() {
  const handles = state.settings.xHandles || [];
  const defaultAccounts = ['@unusual_whales','@zerohedge','@TruthGundlach','@LizAnnSonders','@KobeissiLetter','@bespokeinvest'];
  const displayHandles = handles.length ? handles : defaultAccounts;
  return `
    <div class="x-section">
      <div class="x-section-title">𝕏 X / Twitter — Real-Time Market News${handles.length ? ' (Your Accounts)' : ' (Popular Finance)'}</div>
      <div class="x-links-group">
        ${displayHandles.map(h => `<a class="x-link-pill" href="https://x.com/${h.replace('@','')}" target="_blank" rel="noopener">${h.startsWith('@') ? h : '@'+h}</a>`).join('')}
        <a class="x-link-pill x-search-pill" href="https://x.com/search?q=%23stocks+%23market&f=live" target="_blank" rel="noopener">🔍 #stocks live</a>
        <a class="x-link-pill x-search-pill" href="https://x.com/search?q=%23investing+%23macro&f=live" target="_blank" rel="noopener">🔍 #macro live</a>
      </div>
      ${!handles.length ? '<div class="x-links-hint">Add your X accounts in Settings → X Handles to get their tweets as RSS</div>' : ''}
    </div>`;
}

async function refreshLatestNews(force = false) {
  const list = document.getElementById('latest-news-list');
  if (list) list.innerHTML = '<div class="news-loading">Loading news…</div>';
  try {
    const watchedSymbols = [...new Set(state.alerts.map(a => a.symbol)), ...newsCustomSymbols].join(',');
    const url = `/news/latest${watchedSymbols ? '?symbols=' + encodeURIComponent(watchedSymbols) : ''}${force ? (watchedSymbols ? '&' : '?') + 'refresh=1' : ''}`;
    const data = await api('GET', url);
    latestNewsData = applyAILearning(data);
    const sub = document.getElementById('news-subtitle');
    if (sub) sub.textContent = `${latestNewsData.length} articles · sorted by urgency, geopolitics & portfolio · updated ${new Date().toLocaleTimeString()}`;
    renderNewsItems();
  } catch (e) {
    if (list) list.innerHTML = `<div class="news-empty">Could not load news: ${e.message}</div>`;
  }
}

function filterNews(source) {
  newsFilter = source;
  document.querySelectorAll('#news-tabs .news-tab').forEach(t => t.classList.toggle('active', t.dataset.src === source));
  renderNewsItems();
}

function filterNewsCategory(cat) {
  newsCategoryFilter = cat;
  document.querySelectorAll('#news-cat-tabs .news-tab').forEach(t => t.classList.toggle('active', t.dataset.cat === cat));
  renderNewsItems();
}

function renderNewsItems() {
  const list = document.getElementById('latest-news-list');
  if (!list || !latestNewsData) return;

  let items = latestNewsData;

  // Source filter
  if (newsFilter !== 'all') {
    if (newsFilter === 'X') {
      items = items.filter(n => (n.source || n.publisher || '').startsWith('X:'));
    } else {
      items = items.filter(n => (n.source || n.publisher || '') === newsFilter);
    }
  }

  // Category filter
  if (newsCategoryFilter !== 'all') {
    items = items.filter(n => (n.categories || []).includes(newsCategoryFilter));
  }

  if (!items.length) { list.innerHTML = '<div class="news-empty">No news found for current filter. Try "All News".</div>'; return; }

  list.innerHTML = items.map((n, idx) => {
    const date = n.publishedAt ? new Date(n.publishedAt).toLocaleString('en-US', { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' }) : '';
    const ageMs = n.publishedAt ? Date.now() - new Date(n.publishedAt).getTime() : Infinity;
    const ageHours = ageMs / 3600000;
    const freshBadge = ageHours < 1 ? '<span class="news-fresh-badge">🔴 LIVE</span>' : ageHours < 3 ? '<span class="news-fresh-badge fresh-3h">NEW</span>' : '';
    const src = n.source || n.publisher || '';
    const isX = src.startsWith('X:');
    const srcDisplay = isX ? src.replace('X:', '𝕏 ') : src;
    const srcClass = src.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
    const cats = (n.categories || []);
    const catBadges = cats.map(c => {
      const labels = { breaking: '🔴 Breaking', geo: '🌍 Geo', market: '📊 Market', portfolio: '💼 Portfolio' };
      return labels[c] ? `<span class="news-cat-badge ${c}">${labels[c]}</span>` : '';
    }).join('');
    const relatedSym = n.relatedSymbol ? `<button class="news-sym-pill" onclick="showNewsModal('${n.relatedSymbol}')">${n.relatedSymbol}</button>` : '';
    const newsKey = (n.title || '').slice(0, 30);
    const userBoost = newsClickHistory[newsKey] ? '⭐' : '';

    return `
      <div class="latest-news-item${cats.includes('breaking') ? ' news-breaking' : cats.includes('portfolio') ? ' news-portfolio' : ''}">
        <div class="latest-news-top">
          <span class="latest-news-source ${srcClass}">${srcDisplay}</span>
          ${freshBadge}
          ${catBadges}
          ${relatedSym}
          ${userBoost}
        </div>
        <div class="latest-news-title">
          <a href="${n.link}" target="_blank" rel="noopener" onclick="recordNewsClick('${newsKey.replace(/'/g,"\\'")}', ${JSON.stringify(cats)})">${n.title}</a>
        </div>
        ${n.description ? `<div class="latest-news-desc">${n.description.slice(0, 160)}…</div>` : ''}
        <div class="latest-news-time">${date}</div>
        ${buildNewsActionBtns(n.title, n.link, src, n.publishedAt)}
      </div>`;
  }).join('');
}

/* ─── DASHBOARD NEWS (below stock grid) ──────────────────────── */
let dashNewsLoaded = false;

async function loadDashboardNews() {
  const container = document.getElementById('dashboard-news');
  if (!container) return;
  if (dashNewsLoaded && container.innerHTML) return;

  try {
    const watchedSymbols = [...new Set(state.alerts.map(a => a.symbol)), ...newsCustomSymbols].join(',');
    const url = `/news/latest${watchedSymbols ? '?symbols=' + encodeURIComponent(watchedSymbols) : ''}`;
    const data = await api('GET', url);
    dashNewsLoaded = true;
    const items = data.slice(0, 12);
    if (!items.length) { container.innerHTML = ''; return; }
    container.innerHTML = `
      <div class="dashboard-news-header">
        <h3>Latest Market News</h3>
        <button class="btn-sm" onclick="navigate('news')">View All →</button>
      </div>
      <div class="dashboard-news-grid">
        ${items.map(n => {
          const date = n.publishedAt ? new Date(n.publishedAt).toLocaleString('en-US', { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' }) : '';
          const src = n.source || n.publisher || '';
          const srcClass = src.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
            const ageHours = n.publishedAt ? (Date.now() - new Date(n.publishedAt).getTime()) / 3600000 : Infinity;
          const freshDot = ageHours < 1 ? '<span class="dash-fresh-dot"></span>' : '';
          const cats = n.categories || [];
          const breaking = cats.includes('breaking') ? ' dash-news-breaking' : cats.includes('portfolio') ? ' dash-news-portfolio' : '';
          return `<div class="dash-news-card${breaking}">
            <div class="dash-news-top"><span class="dash-news-source ${srcClass}">${src}</span>${freshDot}${buildNewsActionBtns(n.title, n.link, src, n.publishedAt)}</div>
            <div class="dash-news-title"><a href="${n.link}" target="_blank" rel="noopener" onclick="recordNewsClick('${(n.title||'').slice(0,30).replace(/'/g,"\\'")}')">${n.title}</a></div>
            <div class="dash-news-meta">${date}</div>
          </div>`;
        }).join('')}
      </div>`;
  } catch (e) { /* silent fail */ }
}

/* ─── CRYPTO DASHBOARD ───────────────────────────────────────── */
async function renderCryptoDashboard() {
  const grid = document.getElementById('crypto-grid');
  if (!grid) return;

  if (!state.cryptoData.length) {
    grid.innerHTML = '<div class="empty-state"><div class="empty-icon">₿</div><h3>Loading crypto data…</h3></div>';
    try {
      state.cryptoData = await api('GET', '/crypto');
    } catch (e) {
      grid.innerHTML = `<div class="empty-state"><div class="empty-icon">⚠️</div><h3>Failed to load crypto data</h3><p>${e.message}</p><button class="btn-secondary" onclick="refreshCrypto()">Retry</button></div>`;
      return;
    }
  }

  const subtitle = document.getElementById('crypto-subtitle');
  if (subtitle) subtitle.textContent = `${state.cryptoData.length} coins · Updated ${new Date().toLocaleTimeString()}`;

  const visibleCoins = state.cryptoData.filter(c => !state.hiddenCryptoIds.includes(c.id));
  const mode = state.cryptoViewMode;
  const newsSection = document.getElementById('crypto-news-section');

  if (mode === 'detailed') {
    grid.className = 'stocks-list';
    grid.innerHTML = buildCryptoDetailedTable(visibleCoins);
    if (newsSection) newsSection.style.display = 'none';
  } else if (mode === 'compact') {
    // Pinned coins first, then rest
    const pinned = visibleCoins.filter(c => state.pinnedCryptoIds.includes(c.id));
    const rest = visibleCoins.filter(c => !state.pinnedCryptoIds.includes(c.id));
    const ordered = [...pinned, ...rest];
    grid.className = 'crypto-compact-grid';
    grid.innerHTML = ordered.map(c => buildCryptoCompactCard(c)).join('');
    if (newsSection) { newsSection.style.display = 'block'; loadCryptoNews(); }
  } else {
    grid.className = 'stocks-grid';
    grid.innerHTML = visibleCoins.map(c => buildCryptoCard(c)).join('');
    if (newsSection) newsSection.style.display = 'none';
  }
}

function buildCryptoCompactCard(c) {
  const dir = (c.change24h || 0) >= 0 ? 'up' : 'down';
  const chg24 = c.change24h != null ? `${c.change24h >= 0 ? '+' : ''}${c.change24h.toFixed(2)}%` : '—';
  const priceStr = cryptoPriceFmt(c.price);
  const isPinned = state.pinnedCryptoIds.includes(c.id);
  const deleteBtn = state.cryptoEditMode
    ? `<button class="card-delete-btn" onclick="event.stopPropagation();hideCryptoCoin('${c.id}')" title="Hide">✕</button>`
    : '';
  const pinBtn = state.cryptoEditMode
    ? `<button class="card-pin-btn${isPinned ? ' pinned' : ''}" onclick="event.stopPropagation();toggleCryptoPin('${c.id}')" title="${isPinned ? 'Unpin' : 'Pin to top'}">📌</button>`
    : '';

  return `
    <div class="crypto-compact-card ${dir}"
         onmouseenter="showCryptoHover('${c.id}', this)" onmouseleave="hideCryptoHover(this)"
         onclick="openCryptoDetailModal('${c.id}')">
      ${deleteBtn}${pinBtn}
      <div class="compact-card-left">
        <img class="crypto-icon" src="${c.image}" alt="${c.symbol}" onerror="this.style.display='none'" />
        <span class="compact-symbol">${c.symbol}</span>
      </div>
      <div class="compact-card-right">
        <span class="compact-price">${priceStr}</span>
        <span class="compact-change ${dir}">${chg24}</span>
      </div>
      <div class="crypto-hover-popup" id="crypto-hover-${c.id}" onclick="event.stopPropagation()"></div>
    </div>`;
}

function toggleCryptoPin(id) {
  if (!state.pinnedCryptoIds) state.pinnedCryptoIds = [];
  const idx = state.pinnedCryptoIds.indexOf(id);
  if (idx >= 0) state.pinnedCryptoIds.splice(idx, 1);
  else state.pinnedCryptoIds.push(id);
  localStorage.setItem('pinnedCryptoIds', JSON.stringify(state.pinnedCryptoIds));
  renderCryptoDashboard();
}

async function loadCryptoNews() {
  const section = document.getElementById('crypto-news-section');
  if (!section) return;
  if (section.dataset.loaded && (Date.now() - parseInt(section.dataset.loaded)) < 10 * 60 * 1000) return;
  section.innerHTML = '<div style="color:var(--text-dim);font-size:12px;padding:8px">Loading crypto news…</div>';
  try {
    const articles = await api('GET', '/crypto/news');
    section.dataset.loaded = Date.now().toString();
    if (!articles || !articles.length) {
      section.innerHTML = '<div style="color:var(--text-dim);font-size:12px;padding:8px">No news available.</div>';
      return;
    }
    section.innerHTML = `
      <div class="news-section-header">
        <span class="news-section-title">📰 Crypto News</span>
        <button class="btn-sm" onclick="refreshCryptoNews()">↻ Refresh</button>
      </div>
      <div class="news-articles-grid">
        ${articles.map(a => `
          <div class="news-article-item">
            <div class="news-article-top">
              <div class="news-article-source">${a.source}</div>
              ${buildNewsActionBtns(a.title, a.link, a.source, a.pubDate)}
            </div>
            <a class="news-article-link" href="${a.link}" target="_blank" rel="noopener">${a.title}</a>
            <div class="news-article-date">${a.pubDate ? new Date(a.pubDate).toLocaleDateString('en-US', {month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}) : ''}</div>
          </div>`).join('')}
      </div>`;
  } catch (e) {
    section.innerHTML = `<div style="color:var(--red);font-size:12px;padding:8px">Failed to load news: ${e.message}</div>`;
  }
}

function refreshCryptoNews() {
  const section = document.getElementById('crypto-news-section');
  if (section) section.dataset.loaded = '0';
  loadCryptoNews();
}

function buildCryptoCard(c) {
  const dir = (c.change24h || 0) >= 0 ? 'up' : 'down';
  const chg24 = c.change24h != null ? `${c.change24h >= 0 ? '+' : ''}${c.change24h.toFixed(2)}%` : '—';
  const priceStr = cryptoPriceFmt(c.price);
  const mcap = c.marketCap ? fmtVol(c.marketCap) : '—';
  const vol = c.volume24h ? fmtVol(c.volume24h) : '—';
  const spark = c.sparkline.length > 30 ? c.sparkline.filter((_, i) => i % Math.ceil(c.sparkline.length / 30) === 0) : c.sparkline;
  const sparkSvg = buildSparklineSVG(spark, 120, 30, '#3fb950', '#f85149');
  const deleteBtn = state.cryptoEditMode
    ? `<button class="card-delete-btn" onclick="event.stopPropagation();hideCryptoCoin('${c.id}')" title="Hide coin">✕</button>`
    : '';

  return `
    <div class="crypto-card ${dir}" onmouseenter="showCryptoHover('${c.id}', this)" onmouseleave="hideCryptoHover(this)">
      ${deleteBtn}
      <div class="crypto-card-top">
        <img class="crypto-icon" src="${c.image}" alt="${c.symbol}" onerror="this.style.display='none'" />
        <div>
          <div class="crypto-symbol">${c.symbol}</div>
          <div class="crypto-name">${c.name}</div>
        </div>
      </div>
      <div class="crypto-card-bottom">
        <span class="crypto-price">${priceStr}</span>
        <span class="crypto-change ${dir}">${chg24}</span>
      </div>
      ${sparkSvg ? `<div class="crypto-sparkline">${sparkSvg}</div>` : ''}
      <div class="crypto-meta"><span>MCap: ${mcap}</span><span>Vol: ${vol}</span></div>
      <div class="crypto-hover-popup" id="crypto-hover-${c.id}" onclick="event.stopPropagation()"></div>
    </div>`;
}

/* ─── CRYPTO HOVER POPUP ─────────────────────────────────────── */
function showCryptoHover(id, cardEl) {
  const popup = cardEl.querySelector('.crypto-hover-popup');
  if (!popup) return;
  // Position popup fixed at top of viewport
  const rect = cardEl.getBoundingClientRect();
  popup.style.left = Math.min(rect.left, window.innerWidth - 420) + 'px';
  popup.classList.add('visible');
  if (popup.dataset.loaded) return;
  popup.dataset.loaded = '1';
  const c = state.cryptoData.find(x => x.id === id);
  if (c) renderCryptoHoverPopup(c, popup);
}

function hideCryptoHover(cardEl) {
  const popup = cardEl.querySelector('.crypto-hover-popup');
  if (popup) popup.classList.remove('visible');
}

function renderCryptoHoverPopup(c, el) {
  const priceStr = cryptoPriceFmt(c.price);
  const mcap = c.marketCap ? fmtVol(c.marketCap) : '—';
  const vol = c.volume24h ? fmtVol(c.volume24h) : '—';
  const dir = (c.change24h || 0) >= 0 ? 'up' : 'down';
  const popupId = `chp-${c.id}`;
  const POPUP_PERIODS = [
    { label: '1D', range: '1d', chg: null },
    { label: '7D', range: '7d', chg: c.change7d },
    { label: '1M', range: '30d', chg: c.change30d },
    { label: '1Y', range: '365d', chg: c.change1y },
  ];

  el.innerHTML = `
    <div class="detail-header">
      <div style="display:flex;align-items:center;gap:8px">
        <img src="${c.image}" style="width:28px;height:28px;border-radius:50%" onerror="this.style.display='none'" />
        <div>
          <div class="detail-symbol">${c.symbol}</div>
          <div class="detail-name">${c.name} · #${c.rank || '—'}</div>
        </div>
      </div>
      <div>
        <div class="detail-price">${priceStr}</div>
        <div class="detail-change ${dir}">${c.change24h != null ? (c.change24h >= 0 ? '+' : '') + c.change24h.toFixed(2) + '%' : '—'} (24h)</div>
      </div>
    </div>
    <div class="perf-bar">
      ${[['1H', c.change1h], ['24H', c.change24h], ['7D', c.change7d], ['30D', c.change30d], ['1Y', c.change1y]].map(([l, v]) => {
        if (v == null) return '';
        const d = v >= 0 ? 'up' : 'down';
        return `<div class="perf-item"><span class="perf-label">${l}</span><span class="perf-val ${d}">${v >= 0 ? '+' : ''}${v.toFixed(1)}%</span></div>`;
      }).join('')}
    </div>
    <div class="hover-popup-periods" id="${popupId}-periods">
      ${POPUP_PERIODS.map(p => `<button class="hover-popup-period-btn${p.range === '7d' ? ' active' : ''}" onclick="event.stopPropagation();loadCryptoPopupChart('${c.id}','${p.range}',this,'${popupId}')">${p.label}</button>`).join('')}
    </div>
    <div class="hover-popup-chart-wrap" id="${popupId}-chart"><div style="height:80px;display:flex;align-items:center;justify-content:center;color:var(--text-dim);font-size:11px">Loading chart…</div></div>
    <div class="hover-stats-grid">
      <div class="hover-stat"><span class="hover-stat-label">Market Cap</span><span class="hover-stat-value">${mcap}</span></div>
      <div class="hover-stat"><span class="hover-stat-label">Volume 24H</span><span class="hover-stat-value">${vol}</span></div>
      <div class="hover-stat"><span class="hover-stat-label">ATH</span><span class="hover-stat-value">${cryptoPriceFmt(c.ath)}</span></div>
      <div class="hover-stat"><span class="hover-stat-label">ATH Change</span><span class="hover-stat-value" style="color:var(--red)">${c.athChangePercent != null ? c.athChangePercent.toFixed(1) + '%' : '—'}</span></div>
    </div>`;
  // Auto-load the default 7D chart
  loadCryptoPopupChart(c.id, '7d', el.querySelector('.hover-popup-period-btn.active'), popupId);
}

async function loadCryptoPopupChart(id, range, btnEl, popupId) {
  // Update active button
  const periodsEl = document.getElementById(popupId + '-periods');
  if (periodsEl) periodsEl.querySelectorAll('.hover-popup-period-btn').forEach(b => b.classList.remove('active'));
  if (btnEl) btnEl.classList.add('active');
  const chartEl = document.getElementById(popupId + '-chart');
  if (!chartEl) return;
  chartEl.innerHTML = '<div style="height:80px;display:flex;align-items:center;justify-content:center;color:var(--text-dim);font-size:11px">Loading…</div>';
  try {
    const prices = await api('GET', `/crypto/${id}/chart?range=${range}`);
    if (!Array.isArray(prices) || prices.length < 2) { chartEl.innerHTML = '<div style="height:80px;display:flex;align-items:center;justify-content:center;color:var(--text-dim);font-size:11px">No data</div>'; return; }
    const W = 360, H = 80;
    const min = Math.min(...prices), max = Math.max(...prices), span = max - min || 1;
    const step = W / (prices.length - 1);
    const toY = v => H - ((v - min) / span) * (H - 8) - 4;
    const ptStr = prices.map((v, i) => `${(i * step).toFixed(1)},${toY(v).toFixed(1)}`).join(' ');
    const first = prices[0], last = prices[prices.length - 1];
    const up = last >= first;
    const color = up ? '#3fb950' : '#f85149';
    const fill = up ? '#3fb95018' : '#f8514918';
    const baseY = toY(first).toFixed(1);
    chartEl.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" preserveAspectRatio="none" style="display:block;background:var(--bg);border-radius:4px">
      <line x1="0" y1="${baseY}" x2="${W}" y2="${baseY}" stroke="#484f58" stroke-width="1" stroke-dasharray="3,3"/>
      <path d="M0,${H} L${ptStr} L${W},${H} Z" fill="${fill}"/>
      <polyline points="${ptStr}" fill="none" stroke="${color}" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>
    </svg>
    <div style="font-size:9px;color:var(--text-dim);margin-top:2px;display:flex;justify-content:space-between">
      <span>${last >= first ? '▲' : '▼'} ${Math.abs(((last-first)/first)*100).toFixed(2)}%</span>
      <span>${last >= 1 ? '$' + last.toLocaleString('en-US',{maximumFractionDigits:2}) : '$' + last.toFixed(6)}</span>
    </div>`;
  } catch (e) { chartEl.innerHTML = '<div style="height:80px;display:flex;align-items:center;justify-content:center;color:var(--text-dim);font-size:11px">—</div>'; }
}

/* ─── CRYPTO EDIT MODE ───────────────────────────────────────── */
function toggleCryptoEditMode() {
  state.cryptoEditMode = !state.cryptoEditMode;
  const btn = document.getElementById('crypto-edit-mode-btn');
  if (btn) { btn.classList.toggle('active-edit', state.cryptoEditMode); btn.textContent = state.cryptoEditMode ? '✓ Done' : '✏️ Edit'; }
  renderCryptoDashboard();
}

function hideCryptoCoin(id) {
  if (!state.hiddenCryptoIds) state.hiddenCryptoIds = [];
  if (!state.hiddenCryptoIds.includes(id)) state.hiddenCryptoIds.push(id);
  localStorage.setItem('hiddenCryptoIds', JSON.stringify(state.hiddenCryptoIds));
  state.cryptoData = state.cryptoData.filter(c => c.id !== id);
  renderCryptoDashboard();
}

function buildCryptoListRow(c) {
  const fmtPct = v => v != null ? `<span class="${v >= 0 ? 'up' : 'down'}" style="color:var(--${v >= 0 ? 'green' : 'red'})">${v >= 0 ? '+' : ''}${v.toFixed(2)}%</span>` : '—';
  const priceStr = cryptoPriceFmt(c.price);
  const mcap = c.marketCap ? fmtVol(c.marketCap) : '—';

  return `
    <div class="crypto-list-row">
      <div class="list-rank">${c.rank || ''}</div>
      <div><img class="crypto-icon" src="${c.image}" alt="${c.symbol}" onerror="this.style.display='none'" style="width:20px;height:20px" /></div>
      <div class="list-symbol-group"><span class="list-symbol">${c.symbol}</span><span class="list-name">${c.name}</span></div>
      <div style="text-align:right;font-weight:700">${priceStr}</div>
      <div style="text-align:right;font-size:12px">${fmtPct(c.change1h)}</div>
      <div style="text-align:right;font-size:12px">${fmtPct(c.change24h)}</div>
      <div style="text-align:right;font-size:12px">${fmtPct(c.change7d)}</div>
      <div style="text-align:right;font-size:12px;color:var(--text-dim)">${mcap}</div>
    </div>`;
}

function cryptoPriceFmt(price) {
  if (price == null) return '—';
  if (price >= 1) return `$${price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  if (price >= 0.01) return `$${price.toFixed(4)}`;
  return `$${price.toPrecision(4)}`;
}

/* ─── CRYPTO DETAILED TABLE (livecoinwatch style) ────────────── */
function buildCryptoDetailedTable(coins) {
  const period = state.cryptoChartPeriod || '7d';
  const fmtPctCell = (val) => {
    if (val === null || val === undefined) return `<div class="lcw-col lcw-pct">—</div>`;
    const d = val >= 0 ? 'up' : 'down';
    return `<div class="lcw-col lcw-pct ${d}">${val >= 0 ? '+' : ''}${val.toFixed(2)}%</div>`;
  };

  const rows = coins.map(c => {
    const priceStr = cryptoPriceFmt(c.price);
    const mcap = c.marketCap ? fmtVol(c.marketCap) : '—';
    const vol = c.volume24h ? fmtVol(c.volume24h) : '—';
    const athStr = c.ath ? cryptoPriceFmt(c.ath) : '—';
    const athPct = c.athChangePercent != null ? c.athChangePercent.toFixed(1) + '%' : '—';
    const athDir = (c.athChangePercent || 0) >= 0 ? 'up' : 'down';
    // Use period-specific chart if cached, else 7d sparkline
    const chartData = (period === '7d' || !state.cryptoCharts?.[c.id]?.[period])
      ? c.sparkline || []
      : state.cryptoCharts[c.id][period];
    const spark = chartData.length > 50 ? chartData.filter((_, i) => i % Math.ceil(chartData.length / 50) === 0) : chartData;
    const sparkSvg = buildSparklineSVG(spark, 130, 32, '#3fb950', '#f85149');
    // Popup container
    const popup = `<div class="crypto-hover-popup" id="crypto-tbl-hover-${c.id}"></div>`;

    return `
      <div class="lcw-row" id="lcw-crypto-${c.id}"
           onmouseenter="showCryptoTableHover('${c.id}',this)"
           onmouseleave="hideCryptoTableHover(this)"
           onclick="openCryptoDetailModal('${c.id}')">
        <div class="lcw-col lcw-rank">${c.rank || ''}</div>
        <div class="lcw-col lcw-crypto-icon"><img class="crypto-icon" src="${c.image}" alt="${c.symbol}" onerror="this.style.display='none'" /></div>
        <div class="lcw-col lcw-coin">
          <span class="lcw-symbol">${c.symbol}</span>
          <span class="lcw-name">${c.name}</span>
        </div>
        <div class="lcw-col lcw-price">${priceStr}</div>
        <div class="lcw-col lcw-ath">${athStr}</div>
        <div class="lcw-col lcw-pct ${athDir}">${athPct}</div>
        ${fmtPctCell(c.change1h)}
        ${fmtPctCell(c.change24h)}
        ${fmtPctCell(c.change7d)}
        ${fmtPctCell(c.change30d)}
        ${fmtPctCell(c.change200d)}
        ${fmtPctCell(c.change1y)}
        <div class="lcw-col lcw-chart" id="crypto-chart-${c.id}">${sparkSvg}</div>
        <div class="lcw-col lcw-mcap">${mcap}</div>
        <div class="lcw-col lcw-vol">${vol}</div>
        ${popup}
      </div>`;
  }).join('');

  const periodBtns = [['1d','1D'],['7d','7D'],['30d','1M'],['90d','3M'],['ytd','YTD'],['365d','1Y'],['730d','2Y']].map(([p, label]) =>
    `<button class="chart-period-btn${p === period ? ' active' : ''}" onclick="event.stopPropagation();setCryptoChartPeriod('${p}')">${label}</button>`
  ).join('');

  return `
    <div class="lcw-table lcw-crypto-table">
      <div class="lcw-header">
        <div class="lcw-col lcw-rank">#</div>
        <div class="lcw-col lcw-crypto-icon"></div>
        <div class="lcw-col lcw-coin">Coin</div>
        <div class="lcw-col lcw-price">Price</div>
        <div class="lcw-col lcw-ath">ATH</div>
        <div class="lcw-col lcw-pct">To ATH</div>
        <div class="lcw-col lcw-pct">1H</div>
        <div class="lcw-col lcw-pct">24H</div>
        <div class="lcw-col lcw-pct">7D</div>
        <div class="lcw-col lcw-pct">30D</div>
        <div class="lcw-col lcw-pct">~6M</div>
        <div class="lcw-col lcw-pct">1Y</div>
        <div class="lcw-col lcw-chart">Chart <span class="chart-period-toggle">${periodBtns}</span></div>
        <div class="lcw-col lcw-mcap">Mkt Cap</div>
        <div class="lcw-col lcw-vol">Volume</div>
      </div>
      ${rows}
    </div>`;
}

/* ─── STOCK TABLE HOVER ──────────────────────────────────────── */
function showStockTableHover(symbol, rowEl) {
  const popup = rowEl.querySelector('.crypto-hover-popup');
  if (!popup) return;
  const rect = rowEl.getBoundingClientRect();
  popup.style.left = Math.min(rect.left + 40, window.innerWidth - 420) + 'px';
  popup.classList.add('visible');
  if (popup.dataset.loaded) return;
  popup.dataset.loaded = '1';
  // Build a stock hover popup using available data
  const s = state.stocks[symbol] || {};
  const p = state.profiles[symbol] || {};
  const perf = p._perf || {};
  const dir = typeof s.changePercent === 'number' ? (s.changePercent >= 0 ? 'up' : 'down') : '';
  const price = typeof s.price === 'number' ? `$${s.price.toFixed(2)}` : '—';
  const chgStr = typeof s.changePercent === 'number'
    ? `${s.changePercent >= 0 ? '+' : ''}${s.changePercent.toFixed(2)}% (1D)`
    : '—';
  const sparkSvg = buildSparklineSVG(p.sparkline || [], 360, 60, '#3fb950', '#f85149');
  const fmtPct = (v, label) => {
    if (v == null) return `<div class="perf-item"><span class="perf-label">${label}</span><span class="perf-val">—</span></div>`;
    const d = v >= 0 ? 'up' : 'down';
    return `<div class="perf-item"><span class="perf-label">${label}</span><span class="perf-val ${d}">${v >= 0 ? '+' : ''}${v.toFixed(1)}%</span></div>`;
  };
  popup.innerHTML = `
    <div class="detail-header">
      <div>
        <div class="detail-symbol">${symbol}</div>
        <div class="detail-name">${s.name || symbol} · ${s.marketState || ''}</div>
      </div>
      <div>
        <div class="detail-price">${price}</div>
        <div class="detail-change ${dir}">${chgStr}</div>
      </div>
    </div>
    ${sparkSvg ? `<div class="hover-sparkline">${sparkSvg}</div>` : ''}
    <div class="perf-bar">
      ${fmtPct(perf['1D'] ?? s.changePercent, '1D')}
      ${fmtPct(perf['7D'], '7D')}
      ${fmtPct(perf['1M'], '1M')}
      ${fmtPct(perf['3M'], '3M')}
      ${fmtPct(perf['1Y'], '1Y')}
      ${fmtPct(perf['2Y'], '2Y')}
      ${fmtPct(perf['3Y'], '3Y')}
    </div>
    <div class="hover-stats-grid">
      <div class="hover-stat"><span class="hover-stat-label">Volume</span><span class="hover-stat-value">${s.volume ? fmtVol(s.volume) : '—'}</span></div>
      <div class="hover-stat"><span class="hover-stat-label">Mkt Cap</span><span class="hover-stat-value">${p.marketCap || '—'}</span></div>
      <div class="hover-stat"><span class="hover-stat-label">52W High</span><span class="hover-stat-value">${p.fiftyTwoWeekHigh ? '$' + p.fiftyTwoWeekHigh.toFixed(2) : '—'}</span></div>
      <div class="hover-stat"><span class="hover-stat-label">52W Low</span><span class="hover-stat-value">${p.fiftyTwoWeekLow ? '$' + p.fiftyTwoWeekLow.toFixed(2) : '—'}</span></div>
    </div>`;
  // Lazy load hover data if not yet loaded
  lazyLoadHoverData(symbol);
}
function hideStockTableHover(rowEl) {
  const popup = rowEl.querySelector('.crypto-hover-popup');
  if (popup) popup.classList.remove('visible');
}

/* Hover on detailed table rows */
function showCryptoTableHover(id, rowEl) {
  const popup = rowEl.querySelector('.crypto-hover-popup');
  if (!popup) return;
  popup.classList.add('visible');
  if (popup.dataset.loaded) return;
  popup.dataset.loaded = '1';
  const c = state.cryptoData.find(x => x.id === id);
  if (c) renderCryptoHoverPopup(c, popup);
}
function hideCryptoTableHover(rowEl) {
  const popup = rowEl.querySelector('.crypto-hover-popup');
  if (popup) popup.classList.remove('visible');
}

/* Click to open coin detail modal */
function openCryptoDetailModal(id) {
  const c = state.cryptoData.find(x => x.id === id);
  if (!c) return;
  const priceStr = cryptoPriceFmt(c.price);
  const mcap = c.marketCap ? fmtVol(c.marketCap) : '—';
  const vol = c.volume24h ? fmtVol(c.volume24h) : '—';
  const sparkSvg = buildSparklineSVG(c.sparkline, 560, 100, '#3fb950', '#f85149');
  const dir = (c.change24h || 0) >= 0 ? 'up' : 'down';

  // Build or reuse modal
  let modal = document.getElementById('crypto-detail-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'crypto-detail-modal';
    modal.className = 'modal-overlay';
    modal.onclick = e => { if (e.target === modal) modal.classList.remove('active'); };
    document.body.appendChild(modal);
  }
  modal.innerHTML = `
    <div class="modal-box" style="max-width:640px">
      <div class="modal-header">
        <div style="display:flex;align-items:center;gap:10px">
          <img src="${c.image}" style="width:36px;height:36px;border-radius:50%" onerror="this.style.display='none'"/>
          <div>
            <h2 class="modal-title">${c.symbol} — ${c.name}</h2>
            <div style="font-size:12px;color:var(--text-dim)">Rank #${c.rank || '—'}</div>
          </div>
        </div>
        <button class="modal-close" onclick="document.getElementById('crypto-detail-modal').classList.remove('active')">✕</button>
      </div>
      <div style="padding:20px 24px">
        <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:12px">
          <div style="font-size:28px;font-weight:800">${priceStr}</div>
          <div class="detail-change ${dir}" style="font-size:16px">${c.change24h != null ? (c.change24h >= 0 ? '+' : '') + c.change24h.toFixed(2) + '%' : '—'} (24h)</div>
        </div>
        ${sparkSvg ? `<div class="hover-sparkline">${sparkSvg}</div>` : ''}
        <div class="perf-bar" style="margin:12px 0">
          ${[['1H',c.change1h],['24H',c.change24h],['7D',c.change7d],['30D',c.change30d],['~6M',c.change200d],['1Y',c.change1y]].map(([l,v])=>{
            if(v==null)return '';
            const d=v>=0?'up':'down';
            return `<div class="perf-item"><span class="perf-label">${l}</span><span class="perf-val ${d}">${v>=0?'+':''}${v.toFixed(1)}%</span></div>`;
          }).join('')}
        </div>
        <div class="hover-stats-grid">
          <div class="hover-stat"><span class="hover-stat-label">24H High</span><span class="hover-stat-value">${cryptoPriceFmt(c.high24h)}</span></div>
          <div class="hover-stat"><span class="hover-stat-label">24H Low</span><span class="hover-stat-value">${cryptoPriceFmt(c.low24h)}</span></div>
          <div class="hover-stat"><span class="hover-stat-label">Market Cap</span><span class="hover-stat-value">${mcap}</span></div>
          <div class="hover-stat"><span class="hover-stat-label">Volume 24H</span><span class="hover-stat-value">${vol}</span></div>
          <div class="hover-stat"><span class="hover-stat-label">ATH</span><span class="hover-stat-value">${cryptoPriceFmt(c.ath)}</span></div>
          <div class="hover-stat"><span class="hover-stat-label">ATH Change</span><span class="hover-stat-value" style="color:var(--red)">${c.athChangePercent != null ? c.athChangePercent.toFixed(1)+'%' : '—'}</span></div>
        </div>
        <div style="margin-top:16px;padding-top:14px;border-top:1px solid var(--border);font-size:12px;color:var(--text-dim);text-align:center">
          Crypto price alerts coming soon · Stock alerts available on the Stock Dashboard
        </div>
      </div>
    </div>`;
  modal.classList.add('active');
}

async function setCryptoChartPeriod(period) {
  state.cryptoChartPeriod = period;
  // Update period button states without re-rendering the whole table
  document.querySelectorAll('.lcw-crypto-table .chart-period-btn').forEach(b => {
    b.classList.toggle('active', b.textContent.toLowerCase() === period);
  });
  if (state.cryptoViewMode !== 'detailed') return;

  // For 7d, already have sparkline data — just swap charts in DOM
  const visibleCoins = state.cryptoData.filter(c => !state.hiddenCryptoIds.includes(c.id));
  if (period === '7d') {
    visibleCoins.forEach(c => {
      const cell = document.getElementById(`crypto-chart-${c.id}`);
      if (!cell) return;
      const spark = (c.sparkline||[]).length > 50 ? c.sparkline.filter((_,i)=>i%Math.ceil(c.sparkline.length/50)===0) : c.sparkline||[];
      cell.innerHTML = buildSparklineSVG(spark, 130, 32, '#3fb950', '#f85149');
    });
    return;
  }

  // For other periods: show loading, then fetch in batches
  if (!state.cryptoCharts) state.cryptoCharts = {};
  const toFetch = visibleCoins.filter(c => !state.cryptoCharts[c.id]?.[period]);
  // Show loading dots for uncached cells
  toFetch.forEach(c => {
    const cell = document.getElementById(`crypto-chart-${c.id}`);
    if (cell) cell.innerHTML = '<span style="color:var(--text-dim);font-size:10px">…</span>';
  });
  // Show cached cells immediately
  visibleCoins.filter(c => state.cryptoCharts[c.id]?.[period]).forEach(c => {
    const cell = document.getElementById(`crypto-chart-${c.id}`);
    if (!cell) return;
    const data = state.cryptoCharts[c.id][period];
    const spark = data.length > 50 ? data.filter((_,i)=>i%Math.ceil(data.length/50)===0) : data;
    cell.innerHTML = buildSparklineSVG(spark, 130, 32, '#3fb950', '#f85149');
  });

  // Fetch uncached — max 5 coins, 2s between each to respect CoinGecko free-tier rate limits
  let fetched = 0;
  const batch = toFetch.slice(0, 5);
  for (const c of batch) {
    try {
      const prices = await api('GET', `/crypto/${c.id}/chart?range=${period}`);
      if (!Array.isArray(prices) || !prices.length) throw new Error('empty');
      if (!state.cryptoCharts[c.id]) state.cryptoCharts[c.id] = {};
      state.cryptoCharts[c.id][period] = prices;
      if (state.cryptoChartPeriod !== period) return; // user switched again
      const cell = document.getElementById(`crypto-chart-${c.id}`);
      if (cell) {
        const spark = prices.length > 50 ? prices.filter((_,i)=>i%Math.ceil(prices.length/50)===0) : prices;
        cell.innerHTML = buildSparklineSVG(spark, 130, 32, '#3fb950', '#f85149');
      }
      fetched++;
    } catch (e) {
      const cell = document.getElementById(`crypto-chart-${c.id}`);
      if (cell) cell.innerHTML = '<span style="color:var(--text-dim);font-size:9px">—</span>';
    }
    if (fetched < batch.length) await new Promise(r => setTimeout(r, 2000));
  }
}

function switchCryptoView(mode) {
  state.cryptoViewMode = mode;
  document.querySelectorAll('#crypto-view-toggle .view-toggle-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
  renderCryptoDashboard();
}

async function refreshCrypto() {
  state.cryptoData = [];
  await renderCryptoDashboard();
}

/* ─── STOCK CHART PERIOD ─────────────────────────────────────── */
async function setStockChartPeriod(period) {
  state.stockChartPeriod = period;
  if (state.dashViewMode !== 'detailed') return;
  // Re-render the table header period buttons
  renderDashboard();
  // Lazy-fetch chart data per symbol
  const symbols = getDashSymbols();
  for (const symbol of symbols) {
    if (state.stockCharts[symbol]?.[period]) {
      const cell = document.getElementById(`stock-chart-${symbol}`);
      if (cell) {
        const data = state.stockCharts[symbol][period];
        cell.innerHTML = buildSparklineSVG(data, 90, 26, '#3fb950', '#f85149');
      }
      continue;
    }
    try {
      const data = await api('GET', `/stock/${symbol}/chart?range=${period}`);
      if (!state.stockCharts[symbol]) state.stockCharts[symbol] = {};
      state.stockCharts[symbol][period] = (data.dataPoints || []).map(p => p.close);
      const cell = document.getElementById(`stock-chart-${symbol}`);
      if (cell) {
        const prices = state.stockCharts[symbol][period];
        cell.innerHTML = buildSparklineSVG(prices, 90, 26, '#3fb950', '#f85149');
      }
    } catch (_) { /* silent */ }
    await new Promise(r => setTimeout(r, 200));
  }
}

/* ─── KEYBOARD SHORTCUTS ──────────────────────────────────────── */
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    const stockDetailModal = document.getElementById('stock-detail-modal');
    const newsModal = document.getElementById('news-modal');
    const alertModal = document.getElementById('add-alert-modal');
    if (stockDetailModal?.classList.contains('active')) hideStockDetailModal();
    else if (newsModal.classList.contains('active')) hideNewsModal();
    else if (alertModal.classList.contains('active')) hideAddAlertModal();
  }
  if ((e.ctrlKey || e.metaKey) && e.key === 'n') { e.preventDefault(); showAddAlertModal(); }
});

/* ─── BOOT ────────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', init);
