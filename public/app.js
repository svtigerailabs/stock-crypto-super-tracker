/* ─── HTML ESCAPE UTILITY ─────────────────────────────────────── */
function escHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/* ─── STATE ───────────────────────────────────────────────────── */
const state = {
  alerts: [], stocks: {}, history: [], settings: {},
  profiles: {}, hoverCache: {},
  view: 'dashboard', selectedSymbol: null, searchTimeout: null,
  dashViewMode: 'grid', cryptoViewMode: 'detailed', cryptoData: [],
  cryptoChartPeriod: '1d', cryptoCharts: {},
  hiddenCryptoIds: JSON.parse(localStorage.getItem('hiddenCryptoIds') || '[]'),
  pinnedCryptoIds: JSON.parse(localStorage.getItem('pinnedCryptoIds') || '[]'),
  favoriteCryptoIds: JSON.parse(localStorage.getItem('favoriteCryptoIds') || '[]'),
  cryptoFilterMode: localStorage.getItem('cryptoFilterMode') || 'default',
  cryptoRankLimit: parseInt(localStorage.getItem('cryptoRankLimit') || '50', 10),
  stockChartPeriod: '1d', stockCharts: {},
  alertsMuted: localStorage.getItem('alertsMuted') === 'true',
};
let socket = null;
const NUM_CONDITION_ROWS = 6;

// Default 16 coins shown until user switches to "All"
const DEFAULT_CRYPTO_SYMBOLS = ['BTC','ETH','BNB','XRP','SOL','DOGE','HYPE','XMR','ZEC','SUI','TON','UNI','TAO','NEAR','AAVE','PAXG'];

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
  try { initSocket(); } catch(e) { console.warn('Socket.io unavailable:', e.message); }
  renderAll();
  applySettings(state.settings);
  updateMuteBtn();
  // Update profile badge on startup
  updateNavBadge('profiles', userProfiles.length);



  // Refresh dashboard news every 5 minutes
  setTimeout(loadDashboardNews, 4000);
  setInterval(() => { dashNewsLoaded = false; loadDashboardNews(); }, 5 * 60 * 1000);

  // Pre-load crypto news so it's ready when user opens Crypto Dashboard
  setTimeout(() => loadCryptoNews(), 6000);
  // Refresh crypto news every 10 minutes
  setInterval(() => loadCryptoNews(true), 10 * 60 * 1000);

  // Background chart preloading: stocks every 30 min, crypto every 5 min
  setTimeout(_preloadStockCharts, 5000); // initial load after 5s
  setInterval(_preloadStockCharts, 30 * 60 * 1000);
  setTimeout(_preloadCryptoCharts, 8000);
  setInterval(_preloadCryptoCharts, 60 * 1000); // refresh charts every 1 min

  // Preload sector data eagerly so it's ready when user clicks
  setTimeout(() => {
    if (!_sectorsData) {
      const cached = _loadSectorCache();
      if (cached) { _sectorsData = cached.data; _sectorAvailable = cached.available || {}; }
      else api('GET', '/sectors').then(res => {
        _sectorsData = res.sectors || res;
        _sectorAvailable = res.available || {};
        _saveSectorCache(_sectorsData, _sectorAvailable);
        console.log('Sector data preloaded:', _sectorsData?.length, 'sectors');
      }).catch(() => {});
    }
  }, 12000);

  // Eagerly preload crypto extended perf data (90D, 6M, YTD, 2Y, 3Y, 5Y, SinceICO)
  // so it's ready when user navigates to Crypto detailed view
  setTimeout(async () => {
    if (!state.cryptoData?.length) {
      try { state.cryptoData = await api('GET', '/crypto'); } catch { return; }
    }
    const coins = [...state.cryptoData].sort((a,b)=>(a.rank||999)-(b.rank||999)).slice(0, state.cryptoRankLimit || 50);
    _preload6MChange(coins);
    _preloadCryptoExtPerf(coins);
  }, 15000);

  // Eagerly load all stock profiles so data columns populate on first view
  setTimeout(() => loadProfilesBatch(getDashSymbols()), 3000);
  // Refresh profiles every 15 min to keep data current
  setInterval(() => {
    // Clear cache so profiles refresh
    const syms = getDashSymbols();
    syms.forEach(s => { if (state.profiles[s]) state.profiles[s]._fetchedAt = 0; });
    loadProfilesBatch(syms);
  }, 15 * 60 * 1000);
}

async function _preloadStockCharts() {
  const symbols = getDashSymbols();
  if (!symbols.length) return;
  const period = state.stockChartPeriod || '1mo';
  for (const sym of symbols) {
    if (state.stockCharts[sym]?.[period]) continue; // already cached
    try {
      const data = await api('GET', `/stock/${sym}/chart?range=${period}`);
      if (!state.stockCharts[sym]) state.stockCharts[sym] = {};
      state.stockCharts[sym][period] = (data.dataPoints || []).map(p => p.close);
    } catch {}
    await new Promise(r => setTimeout(r, 300)); // gentle rate-limit
  }
}

async function _preload6MChange(coins) {
  for (const c of coins) {
    // Compute 90D from cached 90d chart or fetch it
    if (c.change90d == null) {
      if (state.cryptoCharts[c.id]?.['90d']?.length >= 2) {
        const p90 = state.cryptoCharts[c.id]['90d'];
        c.change90d = ((p90[p90.length-1] - p90[0]) / p90[0]) * 100;
        const el = document.querySelector(`#lcw-crypto-${c.id} .lcw-90d-col`);
        if (el) { const d = c.change90d >= 0 ? 'up' : 'down'; el.className = `lcw-col lcw-pct ${d} lcw-90d-col`; el.textContent = `${c.change90d >= 0 ? '+' : ''}${c.change90d.toFixed(2)}%`; }
      } else {
        try {
          const p90 = await api('GET', `/crypto/${c.id}/chart?range=90d`);
          if (Array.isArray(p90) && p90.length >= 2) {
            if (!state.cryptoCharts[c.id]) state.cryptoCharts[c.id] = {};
            state.cryptoCharts[c.id]['90d'] = p90;
            c.change90d = ((p90[p90.length-1] - p90[0]) / p90[0]) * 100;
            const el = document.querySelector(`#lcw-crypto-${c.id} .lcw-90d-col`);
            if (el) { const d = c.change90d >= 0 ? 'up' : 'down'; el.className = `lcw-col lcw-pct ${d} lcw-90d-col`; el.textContent = `${c.change90d >= 0 ? '+' : ''}${c.change90d.toFixed(2)}%`; }
          }
        } catch {}
        await new Promise(r => setTimeout(r, 300));
      }
    }
    if (c.change6m != null) continue; // 6M already computed
    if (state.cryptoCharts[c.id]?.['180d']?.length >= 2) {
      const prices = state.cryptoCharts[c.id]['180d'];
      c.change6m = ((prices[prices.length - 1] - prices[0]) / prices[0]) * 100;
      const pctEl = document.querySelector(`#lcw-crypto-${c.id} .lcw-6m-col`);
      if (pctEl) {
        const d = c.change6m >= 0 ? 'up' : 'down';
        pctEl.className = `lcw-col lcw-pct ${d} lcw-6m-col`;
        pctEl.textContent = `${c.change6m >= 0 ? '+' : ''}${c.change6m.toFixed(2)}%`;
      }
      continue;
    }
    try {
      const prices = await api('GET', `/crypto/${c.id}/chart?range=180d`);
      if (!Array.isArray(prices) || prices.length < 2) continue;
      if (!state.cryptoCharts[c.id]) state.cryptoCharts[c.id] = {};
      state.cryptoCharts[c.id]['180d'] = prices;
      c.change6m = ((prices[prices.length - 1] - prices[0]) / prices[0]) * 100;
      const pctEl = document.querySelector(`#lcw-crypto-${c.id} .lcw-6m-col`);
      if (pctEl) {
        const d = c.change6m >= 0 ? 'up' : 'down';
        pctEl.className = `lcw-col lcw-pct ${d} lcw-6m-col`;
        pctEl.textContent = `${c.change6m >= 0 ? '+' : ''}${c.change6m.toFixed(2)}%`;
      }
    } catch {}
    await new Promise(r => setTimeout(r, 400));
  }
}

// Helper: compute YTD + 2Y from 730d price array and update DOM in-place
// Format large % values for 2Y/3Y/5Y/SinceICO — no decimals, K/M above 100K
function fmtLargePct(val) {
  if (val === null || val === undefined) return '—';
  const sign = val >= 0 ? '+' : '';
  const abs = Math.abs(val);
  if (abs >= 1e9) return `${sign}${(val / 1e9).toFixed(0)}B%`;
  if (abs >= 1e6) return `${sign}${(val / 1e6).toFixed(0)}M%`;
  if (abs >= 1e5) return `${sign}${(val / 1e3).toFixed(0)}K%`;
  return `${sign}${Math.round(val)}%`;
}

function _computeAndUpdateExtPerf2Y(c, prices) {
  const now = new Date();
  const ytdDays = Math.ceil((now - new Date(now.getFullYear(), 0, 1)) / 86400000) || 1;
  c.change2y = ((prices[prices.length - 1] - prices[0]) / prices[0]) * 100;
  const ytdIdx = Math.max(0, prices.length - ytdDays - 1);
  if (prices[ytdIdx] > 0) c.changeYTD = ((prices[prices.length - 1] - prices[ytdIdx]) / prices[ytdIdx]) * 100;
  const ytdEl = document.querySelector(`#lcw-crypto-${c.id} .lcw-ytd-col`);
  const y2El  = document.querySelector(`#lcw-crypto-${c.id} .lcw-2y-col`);
  if (ytdEl && c.changeYTD != null) { const d = c.changeYTD >= 0 ? 'up' : 'down'; ytdEl.className = `lcw-col lcw-pct ${d} lcw-ytd-col`; ytdEl.textContent = `${c.changeYTD >= 0 ? '+' : ''}${c.changeYTD.toFixed(2)}%`; }
  if (y2El  && c.change2y  != null) { const d = c.change2y  >= 0 ? 'up' : 'down'; y2El.className  = `lcw-col lcw-pct ${d} lcw-2y-col`;  y2El.textContent  = fmtLargePct(c.change2y);  }
}

function _computeAndUpdateExtPerf5Y(c, prices) {
  c.change5y = ((prices[prices.length - 1] - prices[0]) / prices[0]) * 100;
  const y5El = document.querySelector(`#lcw-crypto-${c.id} .lcw-5y-col`);
  if (y5El) { const d = c.change5y >= 0 ? 'up' : 'down'; y5El.className = `lcw-col lcw-pct ${d} lcw-5y-col`; y5El.textContent = fmtLargePct(c.change5y); }
}

function _updateInceptionCells(c) {
  const icoEl = document.querySelector(`#lcw-crypto-${c.id} .lcw-ico-col`);
  const listEl = document.querySelector(`#lcw-crypto-${c.id} .lcw-listed-col`);
  if (icoEl && c.sinceIco != null) { const d = c.sinceIco >= 0 ? 'up' : 'down'; icoEl.className = `lcw-col lcw-pct ${d} lcw-ico-col`; icoEl.textContent = fmtLargePct(c.sinceIco); }
  if (listEl && c.listedDate) { listEl.textContent = c.listedDate; }
}

async function _preloadCryptoExtPerf(coins) {
  // Separate coins by what they need
  const needs2yList = coins.filter(c => c.change2y == null || c.changeYTD == null);
  const needs3yList = coins.filter(c => c.change3y == null);

  // Step 1: Compute from cache immediately (no API call, instant)
  const toFetch2y = [];
  for (const c of needs2yList) {
    const cached = state.cryptoCharts[c.id]?.['730d'];
    if (cached?.length >= 2) { _computeAndUpdateExtPerf2Y(c, cached); }
    else toFetch2y.push(c);
  }

  // Step 2: Fetch missing 730d data in parallel batches of 3
  for (let i = 0; i < toFetch2y.length; i += 3) {
    const batch = toFetch2y.slice(i, i + 3);
    await Promise.all(batch.map(async c => {
      try {
        const prices = await api('GET', `/crypto/${c.id}/chart?range=730d`);
        if (!Array.isArray(prices) || prices.length < 2) return;
        if (!state.cryptoCharts[c.id]) state.cryptoCharts[c.id] = {};
        state.cryptoCharts[c.id]['730d'] = prices;
        _computeAndUpdateExtPerf2Y(c, prices);
      } catch {}
    }));
    if (i + 3 < toFetch2y.length) await new Promise(r => setTimeout(r, 600));
  }

  // Step 3: Fetch 3Y data in parallel batches of 3
  const toFetch3y = needs3yList.filter(c => !state.cryptoCharts[c.id]?.['3y']);
  // Compute from cache first
  needs3yList.filter(c => state.cryptoCharts[c.id]?.['3y']?.length >= 2).forEach(c => {
    const prices = state.cryptoCharts[c.id]['3y'];
    c.change3y = ((prices[prices.length - 1] - prices[0]) / prices[0]) * 100;
    const y3El = document.querySelector(`#lcw-crypto-${c.id} .lcw-3y-col`);
    if (y3El) { const d = c.change3y >= 0 ? 'up' : 'down'; y3El.className = `lcw-col lcw-pct ${d} lcw-3y-col`; y3El.textContent = fmtLargePct(c.change3y); }
  });
  for (let i = 0; i < toFetch3y.length; i += 3) {
    const batch = toFetch3y.slice(i, i + 3);
    await Promise.all(batch.map(async c => {
      try {
        const prices = await api('GET', `/crypto/${c.id}/chart?range=3y`);
        if (!Array.isArray(prices) || prices.length < 2) return;
        if (!state.cryptoCharts[c.id]) state.cryptoCharts[c.id] = {};
        state.cryptoCharts[c.id]['3y'] = prices;
        c.change3y = ((prices[prices.length - 1] - prices[0]) / prices[0]) * 100;
        const y3El = document.querySelector(`#lcw-crypto-${c.id} .lcw-3y-col`);
        if (y3El) { const d = c.change3y >= 0 ? 'up' : 'down'; y3El.className = `lcw-col lcw-pct ${d} lcw-3y-col`; y3El.textContent = fmtLargePct(c.change3y); }
      } catch {}
    }));
    if (i + 3 < toFetch3y.length) await new Promise(r => setTimeout(r, 600));
  }

  // Step 4: Fetch 5Y data in batches of 3
  const needs5yList = coins.filter(c => c.change5y == null);
  needs5yList.filter(c => state.cryptoCharts[c.id]?.['5y']?.length >= 2).forEach(c => _computeAndUpdateExtPerf5Y(c, state.cryptoCharts[c.id]['5y']));
  const toFetch5y = needs5yList.filter(c => !state.cryptoCharts[c.id]?.['5y']);
  for (let i = 0; i < toFetch5y.length; i += 3) {
    const batch = toFetch5y.slice(i, i + 3);
    await Promise.all(batch.map(async c => {
      try {
        const prices = await api('GET', `/crypto/${c.id}/chart?range=5y`);
        if (!Array.isArray(prices) || prices.length < 2) return;
        if (!state.cryptoCharts[c.id]) state.cryptoCharts[c.id] = {};
        state.cryptoCharts[c.id]['5y'] = prices;
        _computeAndUpdateExtPerf5Y(c, prices);
      } catch {}
    }));
    if (i + 3 < toFetch5y.length) await new Promise(r => setTimeout(r, 600));
  }

  // Step 5: Fetch Since ICO + listed date in batches of 2 (heavier allData fetch)
  const needsIcoList = coins.filter(c => c.sinceIco == null);
  for (let i = 0; i < needsIcoList.length; i += 2) {
    const batch = needsIcoList.slice(i, i + 2);
    await Promise.all(batch.map(async c => {
      try {
        const result = await api('GET', `/crypto/${c.id}/inception`);
        if (result && result.change != null) {
          c.sinceIco = result.change;
          c.listedDate = result.listedDate || '';
          _updateInceptionCells(c);
        }
      } catch {}
    }));
    if (i + 2 < needsIcoList.length) await new Promise(r => setTimeout(r, 800));
  }
}

async function _preloadCryptoCharts() {
  if (!state.cryptoData?.length) return;
  const period = state.cryptoChartPeriod || '1d';
  // Cover all visible coins (up to 30), prioritising DEFAULT_CRYPTO_SYMBOLS
  const defaultIds = DEFAULT_CRYPTO_SYMBOLS.map(s => s.toLowerCase());
  const allCoins = state.cryptoData.filter(c => !state.hiddenCryptoIds?.includes(c.id));
  const priority = allCoins.filter(c => defaultIds.some(d => c.id.startsWith(d)));
  const rest = allCoins.filter(c => !priority.includes(c)).slice(0, 14);
  const coins = [...priority, ...rest].slice(0, 30);

  // Fetch in batches of 3 in parallel for speed
  const toFetch = coins.filter(c => !state.cryptoCharts[c.id]?.[period]);
  for (let i = 0; i < toFetch.length; i += 3) {
    const batch = toFetch.slice(i, i + 3);
    await Promise.all(batch.map(async c => {
      try {
        const prices = await api('GET', `/crypto/${c.id}/chart?range=${period}`);
        if (!Array.isArray(prices) || !prices.length) return;
        if (!state.cryptoCharts[c.id]) state.cryptoCharts[c.id] = {};
        state.cryptoCharts[c.id][period] = prices;
        // Update chart cell in-place if crypto table is visible
        const chartCell = document.getElementById(`crypto-chart-${c.id}`);
        if (chartCell && state.cryptoViewMode === 'detailed' && state.cryptoChartPeriod === period) {
          const spark = prices.length > 50 ? prices.filter((_, i2) => i2 % Math.ceil(prices.length / 50) === 0) : prices;
          chartCell.innerHTML = buildSparklineSVG(spark, 130, 32, '#77DD77', '#FF6B6B');
        }
      } catch {}
    }));
    if (i + 3 < toFetch.length) await new Promise(r => setTimeout(r, 400));
  }
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
  if (typeof io === 'undefined') { console.warn('socket.io not loaded — real-time updates disabled'); return; }
  socket = io();
  socket.on('connect', () => setConnectionStatus(true));
  socket.on('disconnect', () => setConnectionStatus(false));

  socket.on('init', data => {
    if (data.alerts?.length) state.alerts = data.alerts;
    if (data.stockCache) Object.assign(state.stocks, data.stockCache);
    if (data.notificationHistory?.length && !state.history.length) state.history = data.notificationHistory;
    renderAll();
  });

  socket.on('priceUpdate', (data) => {
    const { symbol, timestamp } = data;
    if (!symbol) return;
    if (!state.stocks[symbol]) state.stocks[symbol] = {};
    // Merge full quote data (name, volume, type, price, change, etc.)
    Object.assign(state.stocks[symbol], data, { lastUpdated: timestamp || Date.now() });
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

/* ─── MARKET HOURS DETECTION ─────────────────────────────────── */
function isMarketHours() {
  const now = new Date();
  // Convert to Eastern Time
  const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const day = et.getDay(); // 0=Sun, 6=Sat
  if (day === 0 || day === 6) return false;
  const h = et.getHours(), m = et.getMinutes();
  const mins = h * 60 + m;
  // Pre-market starts 4:00 AM, regular 9:30 AM - 4:00 PM, after-hours until 8:00 PM
  // For refresh purposes, consider 4:00 AM - 8:00 PM ET as "active" hours
  return mins >= 240 && mins <= 1200; // 4:00 AM to 8:00 PM ET
}

function isRegularMarketHours() {
  const now = new Date();
  const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const day = et.getDay();
  if (day === 0 || day === 6) return false;
  const h = et.getHours(), m = et.getMinutes();
  const mins = h * 60 + m;
  return mins >= 570 && mins <= 960; // 9:30 AM to 4:00 PM ET
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

/* ─── SIDEBAR NAV GROUPS ─────────────────────────────────────── */
function toggleNavGroup(label) {
  label.classList.toggle('collapsed');
  const group = label.nextElementSibling;
  if (group) group.classList.toggle('collapsed');
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
    case 'profiles': renderProfiles(); break;
    case 'sectors': renderSectors(); break;
    case 'maps': initTVMaps(); break;
    case 'calendar': loadEconCalendar(); break;
    case 'screener': initTVScreener(); break;
    case 'tradingview': initTVTradingView(); break;
    case 'crypto': renderCryptoDashboard(); loadCryptoNews(); break;
    case 'crypto-news': renderCryptoNewsView(); break;
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
  } catch (e) {
    const bar = document.getElementById('market-index-bar');
    if (bar && !marketIndexData.length) {
      bar.innerHTML = `<div class="mkt-idx-loading" style="cursor:pointer;color:var(--text-dim)" onclick="loadMarketIndex()">⚠ Market data unavailable — tap to retry</div>`;
    }
  }
}

function renderMarketIndexBar() {
  const bar = document.getElementById('market-index-bar');
  if (!bar) return;
  if (!marketIndexData.length) {
    bar.innerHTML = `<div class="mkt-idx-loading" style="cursor:pointer;color:var(--text-dim)" onclick="loadMarketIndex()">⚠ Market data unavailable — tap to retry</div>`;
    return;
  }

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
    const spark = buildSparklineSVG(item.sparkline || [], 88, 32, '#77DD77', '#FF6B6B');

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
    tickerState[type].articles = articles.slice(0, 8); // show up to 8 headlines
    renderTickerMarquee(type);
    // If still empty (all sources failed), retry in 30s, then 60s, then 120s
    if (!tickerState[type].articles.length) {
      const retries = (tickerState[type]._retryCount || 0);
      if (retries < 4) {
        tickerState[type]._retryCount = retries + 1;
        setTimeout(() => fetchTickerHeadlines(type), Math.min(30 * 1000 * (retries + 1), 2 * 60 * 1000));
      }
    } else {
      tickerState[type]._retryCount = 0; // reset on success
    }
  } catch(e) {
    renderTickerMarquee(type); // render fallback (prices) even on error
    // Retry on error
    const retries = (tickerState[type]._retryCount || 0);
    if (retries < 4) {
      tickerState[type]._retryCount = retries + 1;
      setTimeout(() => fetchTickerHeadlines(type), 30 * 1000);
    }
  }
}

/* Build the always-available market index ticker items (Top 5 key indices) */
function _buildMarketIndexTickerItems() {
  if (!marketIndexData?.length) return '';
  const TOP5 = ['SPY','QQQ','DIA','BTC-USD','GC=F']; // S&P, Nasdaq, Dow, BTC, Gold
  const items = marketIndexData
    .filter(d => TOP5.includes(d.symbol) && d.price)
    .sort((a, b) => TOP5.indexOf(a.symbol) - TOP5.indexOf(b.symbol));
  if (!items.length) return '';
  return items.map(d => {
    const dir = (d.changePct || 0) >= 0 ? 'var(--green)' : 'var(--red)';
    const sign = d.changePct >= 0 ? '+' : '';
    const priceStr = d.price >= 1000
      ? d.price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
      : d.price.toFixed(2);
    return `<span class="ticker-item">` +
      `<span class="ticker-title">${d.shortName || d.symbol}</span>` +
      `<span class="ticker-meta" style="color:${dir}">$${priceStr} (${sign}${(d.changePct||0).toFixed(2)}%)</span>` +
      `<span class="ticker-sep">◆</span></span>`;
  }).join('');
}

function renderTickerMarquee(type) {
  const articles = tickerState[type].articles;
  const trackEl = document.getElementById(`${type}-ticker-track`);
  if (!trackEl) return;

  // ── CRYPTO TICKER: coin price prefix + headlines ──────────────
  if (type === 'crypto') {
    // Always build a coin price prefix (fallback when news unavailable)
    const TOP_COINS = ['bitcoin','ethereum','tether','ripple','binancecoin','solana','usd-coin','dogecoin'];
    let coinPrefix = '';
    if (state.cryptoData?.length) {
      const coins = state.cryptoData
        .filter(c => c.price && TOP_COINS.some(t => c.id.startsWith(t)))
        .sort((a,b) => (a.rank||999)-(b.rank||999)).slice(0,6);
      if (!coins.length) {
        // fallback: just use top ranked coins with prices
        state.cryptoData.filter(c=>c.price).slice(0,6).forEach(c => coins.push(c));
      }
      coinPrefix = coins.map(c => {
        const chg = c.change24h;
        return `<span class="ticker-item"><span class="ticker-title">${c.symbol}</span>` +
          `<span class="ticker-meta" style="color:${(chg||0)>=0?'var(--green)':'var(--red)'}">${cryptoPriceFmt(c.price)} ${chg!=null?`(${chg>=0?'+':''}${chg.toFixed(2)}%)`:''}</span>` +
          `<span class="ticker-sep">◆</span></span>`;
      }).join('');
    }
    if (!articles.length) {
      if (coinPrefix) {
        trackEl.innerHTML = coinPrefix + coinPrefix;
        _restartTickerAnim(trackEl);
      } else {
        trackEl.innerHTML = '<span class="ticker-loading">Loading crypto data…</span>';
      }
      return;
    }
    const makeItems = (list) => list.map(art => {
      const src = art.source ? `[${escHtml(art.source)}] ` : '';
      const url = escHtml(art.link || '#');
      return `<a class="ticker-item" href="${url}" target="_blank" rel="noopener noreferrer">` +
        `<span class="ticker-meta">${src}</span>` +
        `<span class="ticker-title">${escHtml(art.title || '')}</span>` +
        `</a><span class="ticker-sep">◆</span>`;
    }).join('');
    const allContent = coinPrefix + makeItems(articles.slice(0, 8));
    trackEl.innerHTML = allContent + allContent;
    _restartTickerAnim(trackEl);
    return;
  }

  // ── STOCK TICKER: market index prices + headlines ─────────────
  let pricePrefix = _buildMarketIndexTickerItems();
  // Fallback to portfolio prices if market index not loaded yet
  if (!pricePrefix && Object.keys(state.stocks).length) {
    pricePrefix = Object.entries(state.stocks).slice(0, 6).map(([sym, s]) => {
      const chg = s.changePercent;
      return `<span class="ticker-item">` +
        `<span class="ticker-title">${sym}</span>` +
        `<span class="ticker-meta" style="color:${(chg||0)>=0?'var(--green)':'var(--red)'}">${s.price?'$'+s.price.toFixed(2):''} ${chg!=null?`(${chg>=0?'+':''}${chg.toFixed(2)}%)`:''}</span>` +
        `<span class="ticker-sep">◆</span></span>`;
    }).join('');
  }

  if (!articles.length) {
    if (pricePrefix) {
      trackEl.innerHTML = pricePrefix + pricePrefix;
      _restartTickerAnim(trackEl);
    } else {
      trackEl.innerHTML = '<span class="ticker-loading">Loading market data…</span>';
    }
    return;
  }

  const buildNewsItems = () => articles.map(art => {
    const src = art.source ? `[${escHtml(art.source)}]` : '';
    let timeStr = '';
    if (art.publishedAt) {
      const d = new Date(art.publishedAt);
      timeStr = ` · ${d.toLocaleTimeString('en-US', {hour: 'numeric', minute: '2-digit', hour12: true})}`;
    }
    const url = escHtml(art.link || '#');
    return `<a class="ticker-item" href="${url}" target="_blank" rel="noopener noreferrer">` +
      `<span class="ticker-meta">${src}${timeStr}</span>` +
      `<span class="ticker-title">${escHtml(art.title || '')}</span>` +
      `</a><span class="ticker-sep">◆</span>`;
  }).join('');

  const allContent = (pricePrefix || '') + buildNewsItems();
  trackEl.innerHTML = allContent + allContent;
  _restartTickerAnim(trackEl);
}

function _restartTickerAnim(el) {
  el.style.animation = 'none';
  void el.offsetWidth; // force reflow
  el.style.animation = 'ticker-scroll 80s linear infinite';
}

function startTickerRotation(type) {
  const st = tickerState[type];
  if (st.timer) clearInterval(st.timer);
  st.timer = null; // CSS animation handles continuous scrolling
  // Refresh headlines every 5 minutes
  if (st.refreshTimer) clearInterval(st.refreshTimer);
  st.refreshTimer = setInterval(() => fetchTickerHeadlines(type), 5 * 60 * 1000);
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
    const color = dir === 'up' ? '#77DD77' : '#FF6B6B';
    const fillColor = dir === 'up' ? '#77DD7718' : '#FF6B6B18';

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
  // Show/hide stock zoom controls based on view mode
  const stockZoomCtrl = document.getElementById('stock-zoom-controls');
  if (stockZoomCtrl) stockZoomCtrl.style.display = mode === 'detailed' ? 'flex' : 'none';
  if (mode === 'cards') {
    grid.className = 'stocks-grid stocks-grid-cards';
    grid.innerHTML = symbols.map(sym => buildStockCardRich(sym)).join('');
    loadProfilesBatch(symbols);
    setTimeout(() => loadWhyMovingBadges(symbols), 1500);
  } else if (mode === 'detailed') {
    grid.className = 'stocks-list';
    grid.innerHTML = buildStockDetailedTable(symbols);
    symbols.forEach(sym => loadStockPerfForTable(sym));
    setTimeout(() => adjustStockZoom(0), 80);
  } else {
    grid.className = 'stocks-grid';
    grid.innerHTML = symbols.map(sym => buildStockCard(sym)).join('');
    // Also load profiles for grid view so MCap/PE/52w populate
    loadProfilesBatch(symbols);
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
  const spark = buildSparklineSVG(p.sparkline || [], 180, 40, '#77DD77', '#FF6B6B');
  const mcap = p.marketCap || '—';
  const pe = p.trailingPE || '—';
  const w52h = p.week52High ? `$${p.week52High.toFixed(2)}` : '—';
  const w52l = p.week52Low ? `$${p.week52Low.toFixed(2)}` : '—';

  // Perf bar from cached profile data — card shows short-term only to keep compact
  const CARD_PERF_KEYS = ['1D','7D','1M','3M','YTD','1Y'];
  const perf = p._perf || {};
  const perfItems = Object.entries(perf)
    .filter(([label]) => CARD_PERF_KEYS.includes(label))
    .map(([label, val]) => {
      if (val === null || val === undefined) return `<span class="rc-perf-item"><span class="rc-perf-label">${label}</span><span class="rc-perf-val">—</span></span>`;
      const d = val >= 0 ? 'up' : 'down';
      return `<span class="rc-perf-item"><span class="rc-perf-label">${label}</span><span class="rc-perf-val ${d}">${val >= 0 ? '+' : ''}${val.toFixed(1)}%</span></span>`;
    }).join('');

  return `
    <div class="rich-card ${dir}" onclick="showStockDetailPopup('${symbol}')"
         onmouseenter="_scheduleShow(this,()=>{lazyLoadHoverData('${symbol}');positionStockPopup(this);this.classList.add('popup-open');})"
         onmouseleave="_scheduleHide(this,()=>this.classList.remove('popup-open'))">
      <div class="rich-card-head">
        <div>
          <div class="rich-card-symbol">${symbol}</div>
          <div class="rich-card-name">${s.name || symbol}</div>
          <div class="why-moving-badge" id="why-moving-${symbol}"></div>
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
  const period = state.stockChartPeriod || '1d';
  const periodBtns = [['1d','1D'],['7d','7D'],['1mo','1M'],['3mo','3M'],['ytd','YTD'],['1y','1Y'],['max','Max']].map(([p, label]) =>
    `<button class="chart-period-btn${p === period ? ' active' : ''}" onclick="event.stopPropagation();setStockChartPeriod('${p}')">${label}</button>`
  ).join('');
  return `
    <div class="lcw-table-scroll-wrap">
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
        <div class="lcw-col lcw-pct">5Y</div>
        <div class="lcw-col lcw-pct">10Y</div>
        <div class="lcw-col lcw-pct">Since IPO</div>
        <div class="lcw-col lcw-date">Listed</div>
        <div class="lcw-col lcw-mcap">Cap</div>
        <div class="lcw-col lcw-vol">Vol</div>
        <div class="lcw-col lcw-chart"><span class="chart-period-toggle">${periodBtns}</span></div>
      </div>
      ${symbols.map((sym, i) => buildStockDetailedRow(sym, i + 1)).join('')}
    </div>
    </div>`;
}

function buildStockDetailedRow(symbol, rank) {
  const s = state.stocks[symbol] || {};
  const p = state.profiles[symbol] || {};
  const price = typeof s.price === 'number' ? `$${s.price.toFixed(2)}` : '—';
  const period = state.stockChartPeriod || '1mo';
  const chartData = state.stockCharts?.[symbol]?.[period] || p.sparkline || [];
  const spark = buildSparklineSVG(chartData, 90, 26, '#77DD77', '#FF6B6B');
  const vol = s.volume ? fmtVol(s.volume) : (p.avgVolume || '—');
  const mcap = p.marketCap ? (typeof p.marketCap === 'number' ? fmtVol(p.marketCap) : p.marketCap) : '—';
  const perf = p._perf || {};
  const dir = typeof s.changePercent === 'number' ? (s.changePercent >= 0 ? 'up' : 'down') : '';

  const pctCell = (val) => {
    if (val === null || val === undefined) return '<div class="lcw-col lcw-pct lcw-loading">—</div>';
    const d = val >= 0 ? 'up' : 'down';
    return `<div class="lcw-col lcw-pct ${d}">${val >= 0 ? '+' : ''}${val.toFixed(2)}%</div>`;
  };

  return `
    <div class="lcw-row ${dir}" id="lcw-stock-${symbol}"
         onmouseenter="_scheduleShow(this,()=>showStockTableHover('${symbol}',this),300)"
         onmouseleave="_scheduleHide(this,()=>hideStockTableHover(this))"
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
      ${pctCell(perf['5Y'])}
      ${pctCell(perf['10Y'])}
      ${pctCell(perf['Inception'])}
      <div class="lcw-col lcw-date">${p.ipoDate || '—'}</div>
      <div class="lcw-col lcw-mcap">${mcap}</div>
      <div class="lcw-col lcw-vol">${vol}</div>
      <div class="lcw-col lcw-chart" id="stock-chart-${symbol}">${spark}</div>
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
  const spark = buildSparklineSVG(chartData, 90, 26, '#77DD77', '#FF6B6B');
  const vol = s.volume ? fmtVol(s.volume) : (p.avgVolume || '—');
  const mcap = p.marketCap ? (typeof p.marketCap === 'number' ? fmtVol(p.marketCap) : p.marketCap) : '—';
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
    ${pctCell(perf['7D'])}
    ${pctCell(perf['1M'])}
    ${pctCell(perf['3M'])}
    ${pctCell(perf['YTD'])}
    ${pctCell(perf['1Y'])}
    ${pctCell(perf['2Y'])}
    ${pctCell(perf['3Y'])}
    ${pctCell(perf['5Y'])}
    ${pctCell(perf['10Y'])}
    ${pctCell(perf['Inception'])}
    <div class="lcw-col lcw-date">${p.ipoDate || '—'}</div>
    <div class="lcw-col lcw-mcap">${mcap}</div>
    <div class="lcw-col lcw-vol">${vol}</div>
    <div class="lcw-col lcw-chart" id="stock-chart-${symbol}">${spark}</div>
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
  const spark = buildSparklineSVG(p.sparkline || [], 80, 24, '#77DD77', '#FF6B6B');

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
  <div class="stock-card ${dir}" id="card-${symbol}" onclick="showStockDetailPopup('${symbol}')"
       onmouseenter="_scheduleShow(this,()=>{lazyLoadHoverData('${symbol}');positionStockPopup(this);this.classList.add('popup-open');})"
       onmouseleave="_scheduleHide(this,()=>this.classList.remove('popup-open'))">
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

/* ─── UNIFIED HOVER TIMER SYSTEM ─────────────────────────────
   Solves the "popup disappears when mouse moves to button" problem.
   Since popups are position:fixed they visually leave the card's
   bounding box, triggering mouseleave. We bridge the gap with a
   short hide delay + popup mouseenter cancels the hide.
   ─────────────────────────────────────────────────────────────── */
const _hoverTimers = new WeakMap();
function _scheduleShow(cardEl, showFn, delay = 500) {
  if (editMode) return; // suppress popups during edit mode
  let t = _hoverTimers.get(cardEl) || {};
  clearTimeout(t.hide); t.hide = null;
  if (!t.show) t.show = setTimeout(() => { t.show = null; _hoverTimers.set(cardEl, t); showFn(); }, delay);
  _hoverTimers.set(cardEl, t);
}
function _scheduleHide(cardEl, hideFn, delay = 200) {
  let t = _hoverTimers.get(cardEl) || {};
  clearTimeout(t.show); t.show = null;
  if (!t.hide) t.hide = setTimeout(() => { t.hide = null; _hoverTimers.set(cardEl, t); hideFn(); }, delay);
  _hoverTimers.set(cardEl, t);
}
function _cancelHide(cardEl) {
  const t = _hoverTimers.get(cardEl) || {};
  clearTimeout(t.hide); t.hide = null;
  _hoverTimers.set(cardEl, t);
}

/* ─── STOCK HOVER POPUP POSITIONING ─────────────────────────── */
function positionStockPopup(cardEl) {
  const popup = cardEl.querySelector('.stock-card-detail');
  if (!popup) return;
  const rect = cardEl.getBoundingClientRect();
  const popupWidth = 820;
  const popupHeight = 560;

  // Horizontal: align with card, stay within viewport
  let left = rect.left;
  if (left + popupWidth > window.innerWidth - 10) left = window.innerWidth - popupWidth - 10;
  if (left < 230) left = 230; // don't overlap sidebar

  // Vertical: prefer above the card; fall back to below if not enough space
  let top = rect.top - popupHeight - 8;
  if (top < 8) top = rect.bottom + 8;

  popup.style.left = left + 'px';
  popup.style.top = top + 'px';
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

  const sparkline = buildSparklineSVG(p.sparkline, 640, 70, '#77DD77', '#FF6B6B');
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
      ${topNewsSlice.map(n => `<div class="hover-news-item"><a href="${escHtml(n.link)}" target="_blank" rel="noopener">${escHtml(n.title)}</a><div class="hover-news-pub">${escHtml(n.publisher || '')}</div></div>`).join('')}
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
    <div class="detail-open-bar">
      <button class="detail-open-full-btn" onclick="event.stopPropagation(); showStockDetailPopup('${symbol}')">📊 Open Full Details →</button>
    </div>
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

  // Bridge: keep popup visible when mouse moves from card into popup
  const card = el.closest('.stock-card, .rich-card');
  if (card) {
    el.onmouseenter = () => _cancelHide(card);
    el.onmouseleave = () => _scheduleHide(card, () => card.classList.remove('popup-open'));
  }
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
  renderCustomFeedsOnSettingsOpen();
}
function applySettings(s) { const el = document.getElementById('setting-interval'); if (el) el.value = s.checkIntervalMinutes || 1; }

/* ─── CUSTOM FEEDS ────────────────────────────────────────────── */
let customFeeds = JSON.parse(localStorage.getItem('customFeeds') || '[]');
let _activeFeedTab = 'website';

const FEED_TAB_CONFIG = {
  website: { label: 'Site Name', urlLabel: 'URL', placeholder: 'e.g. Seeking Alpha', urlPlaceholder: 'https://seekingalpha.com', icon: '🌐' },
  reddit: { label: 'Subreddit', urlLabel: 'Subreddit URL or Name', placeholder: 'e.g. r/wallstreetbets', urlPlaceholder: 'https://www.reddit.com/r/investing/', icon: '🟠' },
  substack: { label: 'Newsletter Name', urlLabel: 'Substack URL', placeholder: 'e.g. The Diff', urlPlaceholder: 'https://thediff.co/', icon: '📬' },
};

function switchFeedTab(type) {
  _activeFeedTab = type;
  document.querySelectorAll('.feed-tab').forEach(b => b.classList.toggle('active', b.dataset.type === type));
  const cfg = FEED_TAB_CONFIG[type];
  const nameLabel = document.getElementById('feed-name-label');
  const urlLabel = document.getElementById('feed-url-label');
  const nameInput = document.getElementById('feed-name');
  const urlInput = document.getElementById('feed-url');
  if (nameLabel) nameLabel.textContent = cfg.label;
  if (urlLabel) urlLabel.textContent = cfg.urlLabel;
  if (nameInput) nameInput.placeholder = cfg.placeholder;
  if (urlInput) urlInput.placeholder = cfg.urlPlaceholder;
  renderCustomFeeds();
}

function toggleFeedCreds() {
  const show = document.getElementById('feed-save-creds')?.checked;
  const grp = document.getElementById('feed-credentials-group');
  if (grp) grp.style.display = show ? 'block' : 'none';
}

function addCustomFeed() {
  const name = document.getElementById('feed-name')?.value.trim();
  const url = document.getElementById('feed-url')?.value.trim();
  if (!name || !url) { showErrorToast('Name and URL are required'); return; }
  const saveCreds = document.getElementById('feed-save-creds')?.checked;
  const feed = {
    id: Date.now().toString(),
    type: _activeFeedTab,
    name,
    url: url.startsWith('http') ? url : 'https://' + url,
    notes: document.getElementById('feed-notes')?.value.trim() || '',
    createdAt: new Date().toISOString(),
  };
  if (saveCreds) {
    feed.loginEmail = document.getElementById('feed-login-email')?.value.trim() || '';
    feed.loginPassword = document.getElementById('feed-login-password')?.value || '';
  }
  customFeeds.unshift(feed);
  localStorage.setItem('customFeeds', JSON.stringify(customFeeds));
  // Clear form
  ['feed-name','feed-url','feed-notes','feed-login-email','feed-login-password'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
  renderCustomFeeds();
  showSuccessToast(`"${name}" added`);
}

function removeCustomFeed(id) {
  customFeeds = customFeeds.filter(f => f.id !== id);
  localStorage.setItem('customFeeds', JSON.stringify(customFeeds));
  renderCustomFeeds();
}

function renderCustomFeeds() {
  const container = document.getElementById('custom-feeds-list');
  if (!container) return;
  const filtered = customFeeds.filter(f => f.type === _activeFeedTab);
  if (!filtered.length) {
    container.innerHTML = `<p style="font-size:12px;color:var(--text-dim);padding:8px 0">No ${_activeFeedTab === 'reddit' ? 'subreddits' : _activeFeedTab === 'substack' ? 'newsletters' : 'websites'} added yet.</p>`;
    return;
  }
  container.innerHTML = filtered.map(f => `
    <div class="feed-item">
      <div class="feed-item-info">
        <a href="${f.url}" target="_blank" rel="noopener" class="feed-item-name">${FEED_TAB_CONFIG[f.type]?.icon || '🔗'} ${f.name}</a>
        ${f.notes ? `<span class="feed-item-notes">${f.notes}</span>` : ''}
        ${f.loginEmail ? `<span class="feed-item-creds">🔑 ${f.loginEmail}</span>` : ''}
      </div>
      <button class="btn-danger-sm" onclick="removeCustomFeed('${f.id}')">✕</button>
    </div>`).join('');
}

function renderCustomFeedsOnSettingsOpen() {
  renderCustomFeeds();
}
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
  state._searchHiIdx = -1;
  if (q.length < 1) return;
  state.searchTimeout = setTimeout(() => performSearch(q), 280);
}

function handleSymbolSearchKey(e) {
  const container = document.getElementById('search-results');
  const items = Array.from(container.querySelectorAll('.search-result-item[onclick]'));
  if (!items.length) return;
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    state._searchHiIdx = Math.min((state._searchHiIdx ?? -1) + 1, items.length - 1);
    _highlightSearchItem(items, state._searchHiIdx);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    state._searchHiIdx = Math.max((state._searchHiIdx ?? 0) - 1, 0);
    _highlightSearchItem(items, state._searchHiIdx);
  } else if (e.key === 'Enter') {
    e.preventDefault();
    const idx = state._searchHiIdx ?? -1;
    if (idx >= 0 && items[idx]) {
      items[idx].click();
    } else if (items[0]) {
      items[0].click();
    }
  } else if (e.key === 'Escape') {
    container.innerHTML = '';
    state._searchHiIdx = -1;
  }
}

function _highlightSearchItem(items, idx) {
  items.forEach((el, i) => {
    el.classList.toggle('highlighted', i === idx);
    if (i === idx) el.scrollIntoView({ block: 'nearest' });
  });
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
    const submitBtn = document.getElementById('submit-alert-btn');
    submitBtn.disabled = false;
    // Auto-focus submit button so user can press Enter to create the alert
    setTimeout(() => submitBtn?.focus(), 80);
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
    const newsHtml = (p.topNews || []).map(n => `<div class="profile-news-item"><a href="${escHtml(n.link)}" target="_blank" rel="noopener">${escHtml(n.title)}</a><div class="profile-news-pub">${escHtml(n.publisher || '')} · ${n.publishedAt ? new Date(n.publishedAt).toLocaleDateString() : ''}</div></div>`).join('');

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
    const color = dir === 'up' ? '#77DD77' : '#FF6B6B';
    const fillColor = dir === 'up' ? '#77DD7718' : '#FF6B6B18';

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
    const savedSym = state.selectedSymbol.symbol;
    created.forEach(a => state.alerts.push(a));
    state.stocks[savedSym] = state.stocks[savedSym] || {};
    Object.assign(state.stocks[savedSym], { price: created[0]?.basePrice, name: created[0]?.name });
    renderAll(); // re-render dashboard in background without closing modal
    showSuccessToast(`Created ${created.length} alert(s) for ${savedSym}`);
    // Show inline success & reset form so user can add another
    const fb = document.getElementById('modal-error');
    if (fb) {
      fb.className = 'modal-success';
      fb.textContent = `✅ Alert(s) created for ${savedSym}! Search another symbol to add more.`;
      fb.style.display = 'block';
      setTimeout(() => { fb.style.display = 'none'; fb.className = 'modal-error'; }, 4000);
    }
    resetAlertForm();
    document.getElementById('symbol-search').focus();
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
      return `<div class="news-item">${thumb}<div class="news-content"><div class="news-title"><a href="${escHtml(n.link)}" target="_blank" rel="noopener">${escHtml(n.title)}</a></div><div class="news-meta"><span class="news-publisher">${escHtml(n.publisher || '')}</span><span>${date}</span></div></div></div>`;
    }).join('');
  } catch (e) {
    bodyEl.innerHTML = `<div class="news-empty">Failed to load news: ${e.message}</div>`;
  }
}

function hideNewsModal() {
  document.getElementById('news-modal').classList.remove('active');
  document.body.style.overflow = '';
}

/* ─── STOCK DETAIL POPUP (card click / table row click) ──────── */
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

    // Interactive chart section at the top
    const chartRanges = [['1d','1D'],['5d','7D'],['1mo','1M'],['3mo','3M'],['ytd','YTD'],['1y','1Y'],['2y','2Y'],['3y','3Y']];
    const chartHtml = `
      <div class="chart-section" style="margin-bottom:12px;padding:4px">
        <div class="chart-period-buttons" id="chart-periods-${symbol}" style="justify-content:flex-start">
          ${chartRanges.map(([r,l]) => `<button class="chart-period-btn${r==='1d'?' active':''}" data-range="${r}">${l}</button>`).join('')}
        </div>
        <div class="chart-container" id="chart-${symbol}"><div class="chart-loading">Loading chart…</div></div>
        <div class="chart-stats" id="chart-stats-${symbol}"></div>
      </div>`;

    // Profile stats / news / alerts content
    const tmp = document.createElement('div');
    tmp.className = 'stock-detail-popup-content';
    renderHoverPopup(symbol, tmp);
    tmp.querySelector('.hover-sparkline')?.remove(); // replaced by interactive chart

    bodyEl.innerHTML = chartHtml;
    bodyEl.appendChild(tmp);

    // Initialize chart + wire period buttons
    loadChart(symbol, '1d');
    document.querySelectorAll(`#chart-periods-${symbol} .chart-period-btn`).forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll(`#chart-periods-${symbol} .chart-period-btn`).forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        loadChart(symbol, btn.dataset.range);
      });
      btn.addEventListener('mouseenter', () => { loadChart(symbol, btn.dataset.range); });
    });
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
    // Close any open popups immediately
    document.querySelectorAll('.popup-open').forEach(c => c.classList.remove('popup-open'));
    addEditModeHandlers();
  } else {
    grid.classList.remove('edit-mode');
    if (btn) { btn.textContent = '✏️ Edit'; btn.classList.remove('active-edit'); }
    document.querySelectorAll('.card-delete-btn').forEach(b => b.remove());
    // Remove drag from all draggable items across all view types
    document.querySelectorAll('.stock-card, .rich-card, .lcw-row').forEach(c => {
      c.draggable = false;
      c.classList.remove('dragging', 'drag-over');
    });
    saveCardOrder();
  }
}

function _getDraggableSelector() {
  const mode = state.dashViewMode;
  if (mode === 'cards') return '.rich-card';
  if (mode === 'detailed') return '.lcw-row';
  return '.stock-card';
}

function _getSymFromDraggable(el) {
  const mode = state.dashViewMode;
  if (mode === 'cards') return el.querySelector('.rich-card-symbol')?.textContent?.trim();
  if (mode === 'detailed') return el.id.replace('lcw-stock-', '');
  return el.id.replace('card-', '');
}

function addEditModeHandlers() {
  const sel = _getDraggableSelector();
  document.querySelectorAll(sel).forEach(card => {
    const sym = _getSymFromDraggable(card);
    // Add delete button if not already present
    if (!card.querySelector('.card-delete-btn')) {
      const del = document.createElement('button');
      del.className = 'card-delete-btn';
      del.textContent = '×';
      del.onclick = e => { e.stopPropagation(); removeFromDashboard(sym); };
      card.appendChild(del);
    }
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
function onDragEnd() {
  this.classList.remove('dragging');
  const sel = _getDraggableSelector();
  document.querySelectorAll(sel).forEach(c => c.classList.remove('drag-over'));
}
function onDrop(e) {
  e.stopPropagation(); e.preventDefault();
  this.classList.remove('drag-over');
  if (dragSrc === this) return;
  const parent = dragSrc.parentNode;
  const sel = _getDraggableSelector();
  const cards = [...parent.querySelectorAll(sel)];
  const srcIdx = cards.indexOf(dragSrc), tgtIdx = cards.indexOf(this);
  if (srcIdx < tgtIdx) parent.insertBefore(dragSrc, this.nextSibling);
  else parent.insertBefore(dragSrc, this);
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
let newsCategoryFilter = 'breaking';
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
              <span class="latest-news-source">${escHtml(n.source || '')}</span>
              <span style="font-size:10px;color:var(--text-dim)">${pubDate}</span>
            </div>
            <div class="latest-news-title"><a href="${escHtml(n.link)}" target="_blank" rel="noopener">${escHtml(n.title)}</a></div>
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

/* ─── SAVED USER PROFILES ────────────────────────────────────── */
let userProfiles = JSON.parse(localStorage.getItem('userProfiles') || '[]');
let activeProfileId = localStorage.getItem('activeProfileId') || null;

function _buildProfileSnapshot(name) {
  return {
    id: Date.now().toString(),
    name: name.trim(),
    savedAt: new Date().toISOString(),
    dashboardOrder: getDashSymbols(),
    hiddenCryptoIds: [...state.hiddenCryptoIds],
    pinnedCryptoIds: [...state.pinnedCryptoIds],
    dashViewMode: state.dashViewMode,
    cryptoViewMode: state.cryptoViewMode,
    cryptoChartPeriod: state.cryptoChartPeriod,
    stockChartPeriod: state.stockChartPeriod,
    settings: { ...state.settings },
  };
}

function showSaveProfileModal() {
  const existing = activeProfileId ? userProfiles.find(p => p.id === activeProfileId) : null;
  const defaultName = existing ? existing.name : `Profile ${userProfiles.length + 1}`;
  const name = prompt('Profile name:', defaultName);
  if (!name || !name.trim()) return;
  // If overwriting active profile, update it; else create new
  if (existing && name.trim() === existing.name) {
    const idx = userProfiles.findIndex(p => p.id === existing.id);
    userProfiles[idx] = _buildProfileSnapshot(name);
    userProfiles[idx].id = existing.id;
  } else {
    userProfiles.unshift(_buildProfileSnapshot(name));
    activeProfileId = userProfiles[0].id;
    localStorage.setItem('activeProfileId', activeProfileId);
  }
  localStorage.setItem('userProfiles', JSON.stringify(userProfiles));
  updateNavBadge('profiles', userProfiles.length);
  showSuccessToast(`Profile "${name.trim()}" saved`);
  if (state.view === 'profiles') renderProfiles();
}

function loadProfile(id) {
  const p = userProfiles.find(pr => pr.id === id);
  if (!p) return;
  if (!confirm(`Switch to profile "${p.name}"? This will update your view settings but won't change your alerts.`)) return;
  activeProfileId = id;
  localStorage.setItem('activeProfileId', id);
  // Apply stored view settings
  if (p.dashViewMode) { state.dashViewMode = p.dashViewMode; document.querySelectorAll('#view-toggle .view-toggle-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === p.dashViewMode)); }
  if (p.cryptoViewMode) state.cryptoViewMode = p.cryptoViewMode;
  if (p.cryptoChartPeriod) state.cryptoChartPeriod = p.cryptoChartPeriod;
  if (p.stockChartPeriod) state.stockChartPeriod = p.stockChartPeriod;
  if (p.hiddenCryptoIds) { state.hiddenCryptoIds = p.hiddenCryptoIds; localStorage.setItem('hiddenCryptoIds', JSON.stringify(p.hiddenCryptoIds)); }
  if (p.pinnedCryptoIds) { state.pinnedCryptoIds = p.pinnedCryptoIds; localStorage.setItem('pinnedCryptoIds', JSON.stringify(p.pinnedCryptoIds)); }
  if (p.dashboardOrder) state.settings.dashboardOrder = p.dashboardOrder;
  showSuccessToast(`Switched to "${p.name}"`);
  navigate('dashboard');
}

function deleteProfile(id) {
  const p = userProfiles.find(pr => pr.id === id);
  if (!p) return;
  if (!confirm(`Delete profile "${p.name}"?`)) return;
  userProfiles = userProfiles.filter(pr => pr.id !== id);
  if (activeProfileId === id) { activeProfileId = userProfiles[0]?.id || null; localStorage.setItem('activeProfileId', activeProfileId || ''); }
  localStorage.setItem('userProfiles', JSON.stringify(userProfiles));
  updateNavBadge('profiles', userProfiles.length);
  renderProfiles();
}

function renderProfiles() {
  const container = document.getElementById('profiles-list');
  const subtitle = document.getElementById('profiles-subtitle');
  if (!container) return;
  if (subtitle) subtitle.textContent = `${userProfiles.length} saved profile${userProfiles.length !== 1 ? 's' : ''} · Click to switch`;
  updateNavBadge('profiles', userProfiles.length);
  if (!userProfiles.length) {
    container.innerHTML = `<div class="empty-state"><div class="empty-icon">👤</div><h3>No saved profiles yet</h3><p>Click <strong>💾 Save Current Profile</strong> to save your current watchlist, view settings, and crypto preferences.</p></div>`;
    return;
  }
  container.innerHTML = userProfiles.map(p => {
    const isActive = p.id === activeProfileId;
    const date = new Date(p.savedAt).toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric', hour:'2-digit', minute:'2-digit' });
    const symbols = (p.dashboardOrder || []).slice(0, 8).join(', ') + ((p.dashboardOrder || []).length > 8 ? '…' : '');
    return `
      <div class="profile-card${isActive ? ' profile-active' : ''}">
        <div class="profile-card-header">
          <div>
            <div class="profile-name">${isActive ? '✅ ' : ''}${p.name}</div>
            <div class="profile-meta">Saved ${date}</div>
          </div>
          <div class="profile-actions">
            <button class="btn-sm-add" onclick="loadProfile('${p.id}')" ${isActive ? 'disabled title="Already active"' : ''}>
              ${isActive ? 'Active' : '▶ Load'}
            </button>
            <button class="btn-secondary" onclick="showOverwriteProfile('${p.id}')">💾 Update</button>
            <button class="btn-danger-sm" onclick="deleteProfile('${p.id}')">✕</button>
          </div>
        </div>
        <div class="profile-details">
          <span class="profile-tag">📊 ${p.dashViewMode || 'grid'}</span>
          <span class="profile-tag">₿ ${p.cryptoViewMode || 'grid'}</span>
          <span class="profile-tag">📈 ${(p.dashboardOrder || []).length} stocks</span>
          <span class="profile-tag">🙈 ${(p.hiddenCryptoIds || []).length} hidden</span>
          <span class="profile-tag">📌 ${(p.pinnedCryptoIds || []).length} pinned</span>
        </div>
        ${symbols ? `<div class="profile-symbols">${symbols}</div>` : ''}
      </div>`;
  }).join('');
}

function showOverwriteProfile(id) {
  const p = userProfiles.find(pr => pr.id === id);
  if (!p) return;
  if (!confirm(`Update profile "${p.name}" with current settings?`)) return;
  const idx = userProfiles.findIndex(pr => pr.id === id);
  const updated = _buildProfileSnapshot(p.name);
  updated.id = id;
  userProfiles[idx] = updated;
  localStorage.setItem('userProfiles', JSON.stringify(userProfiles));
  showSuccessToast(`"${p.name}" updated`);
  renderProfiles();
}

// All known sources (update tabs dynamically)
const NEWS_SOURCES = ['Yahoo Finance', 'Google News'];
const NEWS_CATEGORIES = [
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

    <!-- Compact combined filter row: category + source on one line -->
    <div class="news-controls-compact" id="news-controls-compact">
      <div class="news-ctrl-group">
        ${NEWS_CATEGORIES.map(c => `<button class="news-chip ${c.key===newsCategoryFilter?'active':''}" data-cat="${c.key}" onclick="filterNewsCategory('${c.key}')">${c.label}</button>`).join('')}
      </div>
      <div class="news-ctrl-divider"></div>
      <div class="news-ctrl-group">
        <span class="news-ctrl-label">Source</span>
        <button class="news-chip active" data-src="all" onclick="filterNews('all')">All</button>
        ${NEWS_SOURCES.map(s => `<button class="news-chip" data-src="${s}" onclick="filterNews('${s}')">${s}</button>`).join('')}
        <button class="news-chip" data-src="X" onclick="filterNews('X')">𝕏</button>
      </div>
    </div>

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

    <div id="market-pulse-card"></div>
    <div id="latest-news-list" class="latest-news-list">
      <div class="news-loading">Loading news…</div>
    </div>`;

  renderNewsCustSymbols();
  await refreshLatestNews();
  loadMarketPulse();
}

async function loadMarketPulse() {
  const card = document.getElementById('market-pulse-card');
  if (!card) return;
  try {
    const data = await api('GET', '/news-summary');
    if (!data?.available) { card.innerHTML = ''; return; }

    const isAI = data.aiPowered !== false; // true when Gemini key set
    const timeStr = data.generatedAt ? new Date(data.generatedAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : '';

    let headerRight = '';
    if (isAI && data.sentiment) {
      const sentimentColor = data.sentiment === 'Bullish' ? 'var(--green)' : data.sentiment === 'Bearish' ? 'var(--red)' : 'var(--orange)';
      const sentimentIcon = data.sentiment === 'Bullish' ? '▲' : data.sentiment === 'Bearish' ? '▼' : '◆';
      headerRight = `<span class="mp-sentiment" style="color:${sentimentColor}">${sentimentIcon} ${data.sentiment}</span>`;
    }

    card.innerHTML = `
      <div class="market-pulse-card">
        <div class="mp-header">
          <span class="mp-title">${isAI ? '🤖 AI Market Pulse' : '📰 Top Market Headlines'}</span>
          ${headerRight}
          <span class="mp-time">${timeStr}</span>
        </div>
        ${isAI && data.sentimentReason ? `<div class="mp-reason">${escHtml(data.sentimentReason)}</div>` : ''}
        <ul class="mp-bullets">
          ${(data.bullets || []).map(b => `<li>${escHtml(b)}</li>`).join('')}
        </ul>
        ${!isAI ? `<div class="mp-setup-hint">💡 Add a <strong>Gemini API key</strong> to get AI-powered sentiment analysis</div>` : ''}
      </div>`;
  } catch(e) { if (card) card.innerHTML = ''; }
}

const _whyMovingFetched = new Set();
async function loadWhyMovingBadges(symbols) {
  for (const symbol of symbols) {
    if (_whyMovingFetched.has(symbol)) continue;
    const s = state.stocks[symbol] || {};
    const chg = s.changePercent;
    if (typeof chg !== 'number' || Math.abs(chg) < 1.5) continue;
    _whyMovingFetched.add(symbol);
    try {
      const data = await api('GET', `/stock/${symbol}/why-moving?change=${chg.toFixed(2)}`);
      if (!data?.reason) continue;
      const el = document.getElementById(`why-moving-${symbol}`);
      if (!el) continue;
      const dir = chg >= 0 ? 'up' : 'down';
      el.innerHTML = `<span class="why-moving-tag ${dir}" title="AI-generated explanation">✦ ${escHtml(data.reason)}</span>`;
    } catch(e) { /* silent */ }
    await new Promise(r => setTimeout(r, 500)); // rate-limit Gemini calls
  }
}

/* ─── CRYPTO NEWS VIEW ─────────────────────────────────────────── */
let _cryptoNewsViewFilter = 'CoinTelegraph';
let _cryptoNewsViewCatFilter = 'all'; // 'all' | 'breaking'
let _cryptoNewsViewRefreshTimer = null;
const CRYPTO_URGENCY = ['breaking','alert','urgent','crash','surge','soars','plunges','collapses','halted','suspended','fraud','crisis','record high','record low','liquidat','hack','exploit','ban','sec','lawsuit'];

async function renderCryptoNewsView() {
  const view = document.getElementById('crypto-news-view');
  if (!view) return;

  view.innerHTML = `
    <div class="view-header">
      <div>
        <h1 class="view-title">₿ Crypto News</h1>
        <p class="view-subtitle" id="crypto-news-subtitle">Latest news from top crypto sources · Updated every 10 min</p>
      </div>
      <div style="display:flex;gap:8px;align-items:center">
        <button class="btn-secondary" onclick="loadCryptoNews(true).then(renderCryptoNewsView)">🔄 Refresh</button>
      </div>
    </div>
    <!-- combined filter row: Breaking + sources on one line -->
    <div class="news-controls-compact" id="crypto-news-cat-bar" style="margin-bottom:10px">
      <div class="news-ctrl-group">
        <button class="news-chip ${_cryptoNewsViewCatFilter==='breaking'?'active':''}" data-cat="breaking" onclick="setCryptoNewsCatFilter('breaking')">🔴 Breaking</button>
        <button class="news-chip ${_cryptoNewsViewCatFilter==='all'?'active':''}" data-cat="all" onclick="setCryptoNewsCatFilter('all')">All</button>
      </div>
      <div class="news-ctrl-divider"></div>
      <div class="news-ctrl-group" id="crypto-news-tabs">
        <button class="news-tab" data-src="CoinTelegraph" onclick="setCryptoNewsFilter('CoinTelegraph')">CoinTelegraph</button>
        <button class="news-tab" data-src="CoinDesk" onclick="setCryptoNewsFilter('CoinDesk')">CoinDesk</button>
        <button class="news-tab" data-src="Decrypt" onclick="setCryptoNewsFilter('Decrypt')">Decrypt</button>
        <button class="news-tab" data-src="Bitcoin Magazine" onclick="setCryptoNewsFilter('Bitcoin Magazine')">Bitcoin Mag</button>
        <button class="news-tab" data-src="Google News" onclick="setCryptoNewsFilter('Google News')">Google News</button>
        <button class="news-tab" data-src="x" onclick="setCryptoNewsFilter('x')">𝕏 Twitter</button>
      </div>
    </div>
    <div id="crypto-news-view-list" class="latest-news-list">
      <div class="news-loading">Loading crypto news…</div>
    </div>`;

  // Restore active tab
  document.querySelectorAll('#crypto-news-tabs .news-tab').forEach(b => {
    b.classList.toggle('active', b.dataset.src === _cryptoNewsViewFilter);
  });

  // Load if cache empty
  if (!_cryptoNewsCache.length) {
    await loadCryptoNews();
  }
  renderCryptoNewsViewList();

  // Auto-refresh every 10 min when view is active
  if (_cryptoNewsViewRefreshTimer) clearInterval(_cryptoNewsViewRefreshTimer);
  _cryptoNewsViewRefreshTimer = setInterval(() => {
    if (state.view === 'crypto-news') {
      loadCryptoNews(true).then(renderCryptoNewsViewList);
    } else {
      clearInterval(_cryptoNewsViewRefreshTimer);
      _cryptoNewsViewRefreshTimer = null;
    }
  }, 10 * 60 * 1000);
}

function setCryptoNewsFilter(src) {
  _cryptoNewsViewFilter = src;
  document.querySelectorAll('#crypto-news-tabs .news-tab').forEach(b => {
    b.classList.toggle('active', b.dataset.src === src);
  });
  renderCryptoNewsViewList();
}

function setCryptoNewsCatFilter(cat) {
  _cryptoNewsViewCatFilter = cat;
  document.querySelectorAll('#crypto-news-cat-bar .news-chip').forEach(b => {
    b.classList.toggle('active', b.dataset.cat === cat);
  });
  renderCryptoNewsViewList();
}

function renderCryptoNewsViewList() {
  const list = document.getElementById('crypto-news-view-list');
  if (!list) return;

  if (!_cryptoNewsCache.length) {
    list.innerHTML = '<div class="news-loading">Loading crypto news…</div>';
    return;
  }

  let articles = _cryptoNewsCache;
  if (_cryptoNewsViewFilter !== 'all') {
    if (_cryptoNewsViewFilter === 'x') {
      articles = articles.filter(a => (a.source || '').startsWith('X @'));
    } else {
      articles = articles.filter(a => (a.source || '').toLowerCase().includes(_cryptoNewsViewFilter.toLowerCase()));
    }
  }
  if (_cryptoNewsViewCatFilter === 'breaking') {
    articles = articles.filter(a => {
      const t = (a.title || '').toLowerCase();
      return CRYPTO_URGENCY.some(kw => t.includes(kw));
    });
  }

  if (!articles.length) {
    list.innerHTML = `<div class="news-empty">No articles from this source. <button class="btn-sm" onclick="setCryptoNewsFilter('all')">Show All</button></div>`;
    return;
  }

  // Update subtitle
  const sub = document.getElementById('crypto-news-subtitle');
  if (sub) sub.textContent = `${articles.length} articles · updated ${new Date().toLocaleTimeString()}`;

  list.innerHTML = articles.slice(0, 80).map(a => {
    const ts = a.publishedAt || a.pubDate;
    const timeStr = ts ? new Date(ts).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
    const ageHours = ts ? (Date.now() - new Date(ts).getTime()) / 3600000 : Infinity;
    const freshDot = ageHours < 1 ? '<span class="nl-live" style="margin-right:2px">LIVE</span>' : '';
    const isX = (a.source || '').startsWith('X @');
    const srcLabel = isX
      ? `<span class="nl-src" style="background:rgba(200,200,200,.1);color:#ccc">𝕏 ${escHtml(a.source.replace('X @', '@'))}</span>`
      : `<span class="nl-src">${escHtml(a.source || 'News')}</span>`;
    return `<div class="nl-item">
      ${srcLabel}${freshDot}<a class="nl-title" href="${escHtml(a.link)}" target="_blank" rel="noopener">${escHtml(a.title)}</a>
      <span class="nl-time">${timeStr}</span>
    </div>`;
  }).join('');
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
  document.querySelectorAll('#news-controls-compact .news-chip[data-src]').forEach(t => t.classList.toggle('active', t.dataset.src === source));
  renderNewsItems();
}

function filterNewsCategory(cat) {
  newsCategoryFilter = cat;
  document.querySelectorAll('#news-controls-compact .news-chip[data-cat]').forEach(t => t.classList.toggle('active', t.dataset.cat === cat));
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

  if (!items.length) { list.innerHTML = '<div class="news-empty">No news found for this filter.</div>'; return; }

  list.innerHTML = items.map((n, idx) => {
    const ts = n.publishedAt;
    const ageMs = ts ? Date.now() - new Date(ts).getTime() : Infinity;
    const ageHours = ageMs / 3600000;
    const timeStr = ts ? new Date(ts).toLocaleString('en-US', { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' }) : '';
    const freshDot = ageHours < 1 ? '<span class="nl-live">LIVE</span>' : ageHours < 3 ? '<span class="nl-new">NEW</span>' : '';
    const src = n.source || n.publisher || '';
    const isX = src.startsWith('X:');
    const srcDisplay = isX ? '𝕏 ' + src.replace('X:','').replace('@','') : src;
    const srcClass = src.toLowerCase().replace(/\s+/g,'-').replace(/[^a-z0-9-]/g,'');
    const cats = n.categories || [];
    const breaking = cats.includes('breaking'), portfolio = cats.includes('portfolio');
    const newsKey = (n.title || '').slice(0, 30);
    // Safe cats serialization: use single-quoted array to avoid breaking HTML attributes
    const catsAttr = cats.length ? `['${cats.join("','")}']` : '[]';

    return `<div class="nl-item${breaking ? ' nl-breaking' : portfolio ? ' nl-portfolio' : ''}">
      <span class="nl-src ${srcClass}">${escHtml(srcDisplay)}</span>${freshDot}${n.relatedSymbol ? `<button class="news-sym-pill" onclick="showNewsModal('${escHtml(n.relatedSymbol)}')">${escHtml(n.relatedSymbol)}</button>` : ''}
      <a class="nl-title" href="${escHtml(n.link)}" target="_blank" rel="noopener" onclick="recordNewsClick('${newsKey.replace(/'/g,"\\'")}',${catsAttr})">${escHtml(n.title)}</a>
      <span class="nl-time">${timeStr}</span>
    </div>`;
  }).join('');
}

/* ─── DASHBOARD NEWS (below stock grid) ──────────────────────── */
let dashNewsLoaded = false;
let _dashNewsCache = [];

async function loadDashboardNews() {
  const container = document.getElementById('dashboard-news');
  if (!container) return;

  // If already loaded with content, don't re-fetch (refresh via interval)
  if (dashNewsLoaded && _dashNewsCache.length && container.innerHTML) return;

  try {
    // Try primary endpoint first
    let items = [];
    try {
      const watchedSymbols = [...new Set(state.alerts.map(a => a.symbol)), ...newsCustomSymbols].join(',');
      const url = `/news/latest${watchedSymbols ? '?symbols=' + encodeURIComponent(watchedSymbols) : ''}`;
      const data = await api('GET', url);
      items = Array.isArray(data) ? data.slice(0, 12) : [];
    } catch(e) { /* primary failed, try fallback */ }

    // Fallback: use RSS endpoint directly if primary gave nothing
    if (!items.length) {
      try {
        const rss = await api('GET', '/news/rss');
        items = Array.isArray(rss) ? rss.slice(0, 12) : [];
      } catch(e2) { /* silent */ }
    }

    // Fallback 2: use crypto news if still empty
    if (!items.length) {
      try {
        const crypto = await api('GET', '/crypto/news');
        items = Array.isArray(crypto) ? crypto.slice(0, 12) : [];
      } catch(e3) { /* silent */ }
    }

    // Update cache only if we got items
    if (items.length) {
      _dashNewsCache = items;
      dashNewsLoaded = true;
    }

    // Always render from cache (never leave empty)
    const renderItems = _dashNewsCache.length ? _dashNewsCache : items;
    if (!renderItems.length) {
      container.innerHTML = `<div class="dashboard-news-header"><h3>Latest Market News</h3></div><div style="padding:16px;color:var(--text-dim);font-size:13px">Loading headlines… please wait a moment.</div>`;
      // Retry in 15 seconds if empty
      setTimeout(() => { dashNewsLoaded = false; loadDashboardNews(); }, 15000);
      return;
    }

    container.innerHTML = `
      <div class="dashboard-news-header">
        <h3>Latest Market News</h3>
        <button class="btn-sm" onclick="navigate('news')">View All →</button>
      </div>
      <div class="dashboard-news-grid">
        ${renderItems.map(n => {
          const date = (n.publishedAt || n.pubDate) ? new Date(n.publishedAt || n.pubDate).toLocaleString('en-US', { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' }) : '';
          const src = n.source || n.publisher || '';
          const srcClass = src.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
          const ageHours = (n.publishedAt || n.pubDate) ? (Date.now() - new Date(n.publishedAt || n.pubDate).getTime()) / 3600000 : Infinity;
          const freshDot = ageHours < 1 ? '<span class="dash-fresh-dot"></span>' : '';
          const cats = n.categories || [];
          const breaking = cats.includes('breaking') ? ' dash-news-breaking' : cats.includes('portfolio') ? ' dash-news-portfolio' : '';
          return `<div class="dash-news-card${breaking}">
            <div class="dash-news-top"><span class="dash-news-source ${srcClass}">${escHtml(src)}</span>${freshDot}${buildNewsActionBtns(n.title, n.link, src, n.publishedAt || n.pubDate)}</div>
            <div class="dash-news-title"><a href="${escHtml(n.link)}" target="_blank" rel="noopener">${escHtml(n.title)}</a></div>
            <div class="dash-news-meta">${date}</div>
          </div>`;
        }).join('')}
      </div>`;
  } catch (e) {
    // On error, still show cached data if available
    if (_dashNewsCache.length) {
      dashNewsLoaded = true;
      loadDashboardNews();
    }
  }
}

/* ─── STOCK TABLE ZOOM ───────────────────────────────────────── */
let _stockTableZoom = 1.0;
function adjustStockZoom(delta) {
  _stockTableZoom = Math.max(0.65, Math.min(1.25, parseFloat((_stockTableZoom + delta).toFixed(2))));
  const table = document.querySelector('.lcw-stock');
  if (table) {
    table.style.zoom = _stockTableZoom;
    const label = document.getElementById('stock-zoom-label');
    if (label) label.textContent = Math.round(_stockTableZoom * 100) + '%';
  }
}

/* ─── CRYPTO DASHBOARD ───────────────────────────────────────── */
let _cryptoTableZoom = 1.0;
function adjustCryptoZoom(delta) {
  _cryptoTableZoom = Math.max(0.65, Math.min(1.25, parseFloat((_cryptoTableZoom + delta).toFixed(2))));
  const table = document.querySelector('.lcw-crypto-table');
  if (table) {
    table.style.zoom = _cryptoTableZoom;
    const label = document.getElementById('crypto-zoom-label');
    if (label) label.textContent = Math.round(_cryptoTableZoom * 100) + '%';
  }
}

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


  // Apply filter mode
  let visibleCoins = state.cryptoData.filter(c => !state.hiddenCryptoIds.includes(c.id));
  if (state.cryptoFilterMode === 'favorites') {
    const favs = visibleCoins.filter(c => state.favoriteCryptoIds.includes(c.id));
    // If no favorites yet, show all with a hint
    visibleCoins = favs.length ? favs : visibleCoins;
  }
  // 'all' and 'default' both show full list — sort by rank, then apply limit
  visibleCoins = visibleCoins.sort((a, b) => (a.rank || 999) - (b.rank || 999));
  if (state.cryptoFilterMode !== 'favorites') {
    visibleCoins = visibleCoins.slice(0, state.cryptoRankLimit);
  }
  _updateCryptoFilterBtns();
  const mode = state.cryptoViewMode;
  // Show/hide zoom controls based on mode
  const zoomCtrl = document.getElementById('crypto-zoom-controls');
  if (zoomCtrl) zoomCtrl.style.display = mode === 'detailed' ? 'flex' : 'none';
  // Lazy-load 6M change data in background for all visible coins
  setTimeout(() => _preload6MChange(visibleCoins), 1500);
  const newsSection = document.getElementById('crypto-news-section');

  if (mode === 'detailed') {
    grid.className = 'stocks-list';
    grid.innerHTML = buildCryptoDetailedTable(visibleCoins);
    if (newsSection) newsSection.style.display = 'none';
    // Load charts immediately for visible period (shows cached, fetches missing)
    setTimeout(() => setCryptoChartPeriod(state.cryptoChartPeriod), 50);
    // Preload extended perf data (YTD, 2Y, 3Y) in background for all visible coins
    setTimeout(() => _preloadCryptoExtPerf(visibleCoins), 500);
    // Apply zoom if previously set
    setTimeout(() => adjustCryptoZoom(0), 80);
  } else if (mode === 'heatmap') {
    grid.className = 'crypto-heatmap-container';
    grid.innerHTML = `<div id="tv-crypto-heatmap-container" class="maps-widget-container" style="height:calc(100vh - 205px);min-height:500px"></div>`;
    if (newsSection) newsSection.style.display = 'none';
    setTimeout(() => initTVCryptoHeatmap(), 80);
  } else {
    grid.className = 'stocks-grid';
    grid.innerHTML = visibleCoins.map(c => buildCryptoCard(c)).join('');
    if (newsSection) newsSection.style.display = '';  // show news panel in card view
  }
}

/* buildCryptoCompactCard removed — compact mode replaced by heatmap */

function toggleCryptoPin(id) {
  if (!state.pinnedCryptoIds) state.pinnedCryptoIds = [];
  const idx = state.pinnedCryptoIds.indexOf(id);
  if (idx >= 0) state.pinnedCryptoIds.splice(idx, 1);
  else state.pinnedCryptoIds.push(id);
  localStorage.setItem('pinnedCryptoIds', JSON.stringify(state.pinnedCryptoIds));
  renderCryptoDashboard();
}

let _cryptoNewsCache = [];
let _cryptoNewsLoadedAt = 0;
let _cryptoNewsSourceFilter = 'all';

async function loadCryptoNews(forceRefresh = false) {
  const section = document.getElementById('crypto-news-section');
  if (!section) return;

  // Skip if recently loaded (5 min) unless forced
  if (!forceRefresh && _cryptoNewsCache.length && (Date.now() - _cryptoNewsLoadedAt) < 5 * 60 * 1000) {
    renderCryptoNewsCards();
    return;
  }

  // Show skeleton while loading (only if empty)
  if (!_cryptoNewsCache.length) {
    section.innerHTML = '<div style="grid-column:1/-1;padding:20px;color:var(--text-dim);text-align:center;font-size:13px">Loading crypto news from top sources…</div>';
  }

  try {
    const articles = await api('GET', '/crypto/news');
    if (Array.isArray(articles) && articles.length) {
      _cryptoNewsCache = articles;
      _cryptoNewsLoadedAt = Date.now();
    }
  } catch(e) { /* use stale cache */ }

  if (!_cryptoNewsCache.length) {
    section.innerHTML = '<div style="grid-column:1/-1;padding:20px;color:var(--text-dim);text-align:center">No crypto news available yet — retrying…</div>';
    setTimeout(() => loadCryptoNews(true), 20000);
    return;
  }

  renderCryptoNewsCards();
}

function renderCryptoNewsCards() {
  const section = document.getElementById('crypto-news-section');
  if (!section) return;
  section.style.display = '';  // ensure section is visible

  let articles = _cryptoNewsCache;

  // Apply source filter
  if (_cryptoNewsSourceFilter !== 'all') {
    if (_cryptoNewsSourceFilter === 'x') {
      articles = articles.filter(a => (a.source || '').startsWith('X @'));
    } else {
      articles = articles.filter(a => (a.source || '').toLowerCase().includes(_cryptoNewsSourceFilter.toLowerCase()));
    }
  }

  if (!articles.length) {
    section.innerHTML = `<div style="grid-column:1/-1;padding:20px;color:var(--text-dim);text-align:center">No articles from this source yet. <button class="btn-sm" onclick="filterCryptoNewsBySource('all')">Show All</button></div>`;
    return;
  }

  section.innerHTML = articles.slice(0, 40).map(a => {
    const ts = a.publishedAt || a.pubDate;
    const date = ts ? new Date(ts).toLocaleString('en-US', { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' }) : '';
    const ageHours = ts ? (Date.now() - new Date(ts).getTime()) / 3600000 : Infinity;
    const freshDot = ageHours < 1 ? '<span class="crypto-news-fresh-dot"></span>' : '';
    const isX = (a.source || '').startsWith('X @');
    const srcLabel = isX
      ? `<span class="crypto-news-src-label x-label">𝕏 ${escHtml(a.source.replace('X @', '@'))}</span>`
      : `<span class="crypto-news-src-label">${escHtml(a.source || 'News')}</span>`;
    return `<div class="crypto-news-card">
      <div class="crypto-news-card-source">
        ${srcLabel}
        <span class="crypto-news-card-time">${freshDot}${date}</span>
      </div>
      <div class="crypto-news-card-title">
        <a href="${escHtml(a.link)}" target="_blank" rel="noopener">${escHtml(a.title)}</a>
      </div>
    </div>`;
  }).join('');
}

function filterCryptoNewsBySource(src) {
  _cryptoNewsSourceFilter = src;
  document.querySelectorAll('.crypto-news-src-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.src === src);
  });
  renderCryptoNewsCards();
}

function refreshCryptoNews() {
  loadCryptoNews(true);
}

function buildCryptoCard(c) {
  const dir = (c.change24h || 0) >= 0 ? 'up' : 'down';
  const chg24 = c.change24h != null ? `${c.change24h >= 0 ? '+' : ''}${c.change24h.toFixed(2)}%` : '—';
  const priceStr = cryptoPriceFmt(c.price);
  const mcap = c.marketCap ? fmtVol(c.marketCap) : '—';
  const vol = c.volume24h ? fmtVol(c.volume24h) : '—';
  const spark = (c.sparkline||[]).length > 30 ? c.sparkline.filter((_, i) => i % Math.ceil(c.sparkline.length / 30) === 0) : (c.sparkline||[]);
  const sparkSvg = buildSparklineSVG(spark, 120, 30, '#77DD77', '#FF6B6B');
  const isFav = state.favoriteCryptoIds?.includes(c.id);

  return `
    <div class="crypto-card ${dir}" style="position:relative"
         onclick="openCryptoDetailModal('${c.id}')"
         onmouseenter="_scheduleShow(this,()=>showCryptoHover('${c.id}',this))"
         onmouseleave="_scheduleHide(this,()=>hideCryptoHover(this))">
      <button class="crypto-star-btn card-star${isFav ? ' starred' : ''}"
        onclick="event.stopPropagation();toggleCryptoFavorite('${c.id}')"
        title="${isFav ? 'Remove from favorites' : 'Add to favorites'}"></button>
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
  const rect = cardEl.getBoundingClientRect();
  popup.style.left = Math.min(rect.left, window.innerWidth - 420) + 'px';
  cardEl.classList.add('popup-open');
  if (popup.dataset.loaded) return;
  popup.dataset.loaded = '1';
  const c = state.cryptoData.find(x => x.id === id);
  if (c) renderCryptoHoverPopup(c, popup);
}

function hideCryptoHover(cardEl) {
  cardEl.classList.remove('popup-open');
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
      ${[['1H', c.change1h], ['24H', c.change24h], ['7D', c.change7d], ['30D', c.change30d], ['YTD', c.changeYtd], ['1Y', c.change1y]].map(([l, v]) => {
        if (v == null) return '';
        const d = v >= 0 ? 'up' : 'down';
        return `<div class="perf-item"><span class="perf-label">${l}</span><span class="perf-val ${d}">${v >= 0 ? '+' : ''}${v.toFixed(1)}%</span></div>`;
      }).join('')}
    </div>
    <div class="hover-popup-periods" id="${popupId}-periods">
      ${POPUP_PERIODS.map(p => `<button class="hover-popup-period-btn${p.range === '1d' ? ' active' : ''}" onclick="event.stopPropagation();loadCryptoPopupChart('${c.id}','${p.range}',this,'${popupId}')" onmouseenter="loadCryptoPopupChart('${c.id}','${p.range}',this,'${popupId}')">${p.label}</button>`).join('')}
    </div>
    <div class="hover-popup-chart-wrap" id="${popupId}-chart"><div style="height:80px;display:flex;align-items:center;justify-content:center;color:var(--text-dim);font-size:11px">Loading chart…</div></div>
    <div class="hover-stats-grid">
      <div class="hover-stat"><span class="hover-stat-label">Market Cap</span><span class="hover-stat-value">${mcap}</span></div>
      <div class="hover-stat"><span class="hover-stat-label">Volume 24H</span><span class="hover-stat-value">${vol}</span></div>
      <div class="hover-stat"><span class="hover-stat-label">ATH</span><span class="hover-stat-value">${cryptoPriceFmt(c.ath)}</span></div>
      <div class="hover-stat"><span class="hover-stat-label">ATH Change</span><span class="hover-stat-value" style="color:var(--red)">${c.athChangePercent != null ? c.athChangePercent.toFixed(1) + '%' : '—'}</span></div>
    </div>`;
  // Auto-load the default 7D chart
  loadCryptoPopupChart(c.id, '1d', el.querySelector('.hover-popup-period-btn.active'), popupId);

  // Bridge: keep popup visible when mouse moves from card into popup
  const card = el.closest('.crypto-card, .crypto-compact-card');
  if (card) {
    el.onmouseenter = () => _cancelHide(card);
    el.onmouseleave = () => _scheduleHide(card, () => hideCryptoHover(card));
  }
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
    const color = up ? '#77DD77' : '#FF6B6B';
    const fill = up ? '#77DD7718' : '#FF6B6B18';
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
  const period = state.cryptoChartPeriod || '1d';
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
    // Use cached chart data for the current period; fall back to coinpaprika sparkline
    const chartData = state.cryptoCharts?.[c.id]?.[period]?.length
      ? state.cryptoCharts[c.id][period]
      : (c.sparkline || []);
    const spark = chartData.length > 50 ? chartData.filter((_, i) => i % Math.ceil(chartData.length / 50) === 0) : chartData;
    const sparkSvg = buildSparklineSVG(spark, 130, 32, '#77DD77', '#FF6B6B');
    // Popup container
    const popup = `<div class="crypto-hover-popup" id="crypto-tbl-hover-${c.id}"></div>`;

    const isFav = state.favoriteCryptoIds?.includes(c.id);
    return `
      <div class="lcw-row" id="lcw-crypto-${c.id}"
           onmouseenter="_scheduleShow(this,()=>showCryptoTableHover('${c.id}',this),300)"
           onmouseleave="_scheduleHide(this,()=>hideCryptoTableHover(this))"
           onclick="openCryptoDetailModal('${c.id}')">
        <div class="lcw-col lcw-rank">${c.rank || ''}</div>
        <div class="lcw-col lcw-crypto-icon" style="position:relative">
          <button class="crypto-star-btn${isFav ? ' starred' : ''}" data-id="${c.id}"
            onclick="event.stopPropagation();toggleCryptoFavorite('${c.id}')"
            title="${isFav ? 'Remove from favorites' : 'Add to favorites'}">☆</button>
          <img class="crypto-icon" src="${c.image}" alt="${c.symbol}" onerror="this.style.display='none'" />
        </div>
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
        <div class="lcw-col lcw-pct lcw-90d-col${c.change90d != null ? (c.change90d >= 0 ? ' up' : ' down') : ''}">${c.change90d != null ? `${c.change90d >= 0 ? '+' : ''}${c.change90d.toFixed(2)}%` : '—'}</div>
        <div class="lcw-col lcw-pct lcw-6m-col${(c.change6m ?? c.change200d) != null ? ((c.change6m ?? c.change200d) >= 0 ? ' up' : ' down') : ''}">${(c.change6m ?? c.change200d) != null ? `${(c.change6m ?? c.change200d) >= 0 ? '+' : ''}${(c.change6m ?? c.change200d).toFixed(2)}%` : '—'}</div>
        <div class="lcw-col lcw-pct lcw-ytd-col${c.changeYTD != null ? (c.changeYTD >= 0 ? ' up' : ' down') : ''}">${c.changeYTD != null ? `${c.changeYTD >= 0 ? '+' : ''}${c.changeYTD.toFixed(2)}%` : '—'}</div>
        ${fmtPctCell(c.change1y)}
        <div class="lcw-col lcw-pct lcw-2y-col${c.change2y != null ? (c.change2y >= 0 ? ' up' : ' down') : ''}">${c.change2y != null ? fmtLargePct(c.change2y) : '—'}</div>
        <div class="lcw-col lcw-pct lcw-3y-col${c.change3y != null ? (c.change3y >= 0 ? ' up' : ' down') : ''}">${c.change3y != null ? fmtLargePct(c.change3y) : '—'}</div>
        <div class="lcw-col lcw-pct lcw-5y-col${c.change5y != null ? (c.change5y >= 0 ? ' up' : ' down') : ''}">${c.change5y != null ? fmtLargePct(c.change5y) : '—'}</div>
        <div class="lcw-col lcw-pct lcw-ico-col${c.sinceIco != null ? (c.sinceIco >= 0 ? ' up' : ' down') : ''}">${c.sinceIco != null ? fmtLargePct(c.sinceIco) : '—'}</div>
        <div class="lcw-col lcw-date lcw-listed-col">${c.listedDate || '—'}</div>
        <div class="lcw-col lcw-mcap">${mcap}</div>
        <div class="lcw-col lcw-vol">${vol}</div>
        <div class="lcw-col lcw-chart" id="crypto-chart-${c.id}">${sparkSvg}</div>
        ${popup}
      </div>`;
  }).join('');

  const periodBtns = [['1d','1D'],['7d','7D'],['30d','1M'],['90d','3M'],['180d','6M'],['ytd','YTD'],['365d','1Y'],['730d','2Y']].map(([p, label]) =>
    `<button class="chart-period-btn${p === period ? ' active' : ''}" data-period="${p}" onclick="event.stopPropagation();setCryptoChartPeriod('${p}')">${label}</button>`
  ).join('');

  return `
    <div class="lcw-table-scroll-wrap">
    <div class="lcw-table lcw-crypto-table">
      <div class="lcw-header">
        <div class="lcw-col lcw-rank">#</div>
        <div class="lcw-col lcw-crypto-icon"></div>
        <div class="lcw-col lcw-coin">Coin</div>
        <div class="lcw-col lcw-price">Price</div>
        <div class="lcw-col lcw-ath">ATH</div>
        <div class="lcw-col lcw-pct">↑ATH</div>
        <div class="lcw-col lcw-pct">1H</div>
        <div class="lcw-col lcw-pct">24H</div>
        <div class="lcw-col lcw-pct">7D</div>
        <div class="lcw-col lcw-pct">30D</div>
        <div class="lcw-col lcw-pct">90D</div>
        <div class="lcw-col lcw-pct">6M</div>
        <div class="lcw-col lcw-pct">YTD</div>
        <div class="lcw-col lcw-pct">1Y</div>
        <div class="lcw-col lcw-pct">2Y</div>
        <div class="lcw-col lcw-pct">3Y</div>
        <div class="lcw-col lcw-pct">5Y</div>
        <div class="lcw-col lcw-pct">Since ICO</div>
        <div class="lcw-col lcw-date">Listed</div>
        <div class="lcw-col lcw-mcap">Mkt Cap</div>
        <div class="lcw-col lcw-vol">Volume</div>
        <div class="lcw-col lcw-chart"><span class="chart-period-toggle">${periodBtns}</span></div>
      </div>
      ${rows}
    </div>
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
  const sparkSvg = buildSparklineSVG(p.sparkline || [], 360, 60, '#77DD77', '#FF6B6B');
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
      ${fmtPct(perf['YTD'], 'YTD')}
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
  // Bridge: keep popup open when mouse moves into it
  popup.onmouseenter = () => _cancelHide(rowEl);
  popup.onmouseleave = () => _scheduleHide(rowEl, () => hideStockTableHover(rowEl));
}
function hideStockTableHover(rowEl) {
  const popup = rowEl.querySelector('.crypto-hover-popup');
  if (popup) popup.classList.remove('visible');
}

/* Hover on detailed table rows */
function showCryptoTableHover(id, rowEl) {
  const popup = rowEl.querySelector('.crypto-hover-popup');
  if (!popup) return;
  // Position popup to the right of the mouse so it doesn't block the star button
  const popupW = 380;
  let left = _mouseX + 18;
  if (left + popupW > window.innerWidth - 8) left = _mouseX - popupW - 10;
  if (left < 4) left = 4;
  popup.style.left = left + 'px';
  popup.style.top = '';   // reset any absolute top override
  popup.classList.add('visible');
  if (popup.dataset.loaded) return;
  popup.dataset.loaded = '1';
  const c = state.cryptoData.find(x => x.id === id);
  if (c) renderCryptoHoverPopup(c, popup);
  // Bridge: keep popup open when mouse moves into it
  popup.onmouseenter = () => _cancelHide(rowEl);
  popup.onmouseleave = () => _scheduleHide(rowEl, () => hideCryptoTableHover(rowEl));
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
  const sparkSvg = buildSparklineSVG(c.sparkline, 560, 100, '#77DD77', '#FF6B6B');
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
  // Update period button active state using data-period attribute
  document.querySelectorAll('.lcw-crypto-table .chart-period-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.period === period);
  });
  if (state.cryptoViewMode !== 'detailed') return;

  // Use coins currently visible in the table (matches render filter)
  let visibleCoins = state.cryptoData.filter(c => !state.hiddenCryptoIds.includes(c.id));
  if (state.cryptoFilterMode === 'favorites') {
    const favs = visibleCoins.filter(c => state.favoriteCryptoIds.includes(c.id));
    if (favs.length) visibleCoins = favs;
  }
  visibleCoins = visibleCoins.sort((a, b) => (a.rank || 999) - (b.rank || 999));
  // '7d' uses Coinpaprika sparkline (instant, no API call needed)
  if (period === '7d') {
    visibleCoins.forEach(c => {
      const cell = document.getElementById(`crypto-chart-${c.id}`);
      if (!cell) return;
      const spark = (c.sparkline||[]).length > 50 ? c.sparkline.filter((_,i)=>i%Math.ceil(c.sparkline.length/50)===0) : c.sparkline||[];
      cell.innerHTML = buildSparklineSVG(spark, 130, 32, '#77DD77', '#FF6B6B');
    });
    return;
  }

  // For other periods: show cached immediately, show loading for missing, then fetch in parallel batches
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
    cell.innerHTML = buildSparklineSVG(spark, 130, 32, '#77DD77', '#FF6B6B');
  });

  // Fetch uncached coins in parallel batches of 3 for speed
  for (let i = 0; i < toFetch.length; i += 3) {
    const batch = toFetch.slice(i, i + 3);
    await Promise.all(batch.map(async c => {
      try {
        const prices = await api('GET', `/crypto/${c.id}/chart?range=${period}`);
        if (!Array.isArray(prices) || !prices.length) throw new Error('empty');
        if (!state.cryptoCharts[c.id]) state.cryptoCharts[c.id] = {};
        state.cryptoCharts[c.id][period] = prices;
        // Compute 6M change from 180d chart data
        if (period === '180d' && prices.length >= 2) {
          const change6m = ((prices[prices.length - 1] - prices[0]) / prices[0]) * 100;
          const coinRef = state.cryptoData.find(x => x.id === c.id);
          if (coinRef) coinRef.change6m = change6m;
          const pctEl = document.querySelector(`#lcw-crypto-${c.id} .lcw-6m-col`);
          if (pctEl) { const d = change6m >= 0 ? 'up' : 'down'; pctEl.className = `lcw-col lcw-pct ${d} lcw-6m-col`; pctEl.textContent = `${change6m >= 0 ? '+' : ''}${change6m.toFixed(2)}%`; }
        }
        if (state.cryptoChartPeriod !== period) return; // user switched period
        const cell = document.getElementById(`crypto-chart-${c.id}`);
        if (cell) {
          const spark = prices.length > 50 ? prices.filter((_,i2)=>i2%Math.ceil(prices.length/50)===0) : prices;
          cell.innerHTML = buildSparklineSVG(spark, 130, 32, '#77DD77', '#FF6B6B');
        }
      } catch {
        const cell = document.getElementById(`crypto-chart-${c.id}`);
        if (cell) cell.innerHTML = '<span style="color:var(--text-dim);font-size:9px">—</span>';
      }
    }));
    // 400ms between batches to respect CryptoCompare free-tier limits
    if (i + 3 < toFetch.length) await new Promise(r => setTimeout(r, 400));
  }
}

function switchCryptoView(mode) {
  state.cryptoViewMode = mode;
  document.querySelectorAll('#crypto-view-toggle .view-toggle-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
  // Show zoom controls only in detailed mode
  const zoomCtrl = document.getElementById('crypto-zoom-controls');
  if (zoomCtrl) zoomCtrl.style.display = mode === 'detailed' ? 'flex' : 'none';
  renderCryptoDashboard();
}

async function refreshCrypto() {
  state.cryptoData = [];
  await renderCryptoDashboard();
}

/* ─── CRYPTO FILTER MODE ─────────────────────────────────────── */
function toggleCryptoFavFilter() {
  // Toggle between favorites and all
  const next = state.cryptoFilterMode === 'favorites' ? 'all' : 'favorites';
  setCryptoFilterMode(next);
}

function setCryptoFilterMode(mode) {
  state.cryptoFilterMode = mode;
  localStorage.setItem('cryptoFilterMode', mode);
  _updateCryptoFilterBtns();
  renderCryptoDashboard();
}

function setCryptoRankLimit(n) {
  state.cryptoRankLimit = n;
  localStorage.setItem('cryptoRankLimit', String(n));
  _updateCryptoRankBtns();
  renderCryptoDashboard();
}

function _updateCryptoRankBtns() {
  document.querySelectorAll('.crypto-rank-btn').forEach(b => {
    b.classList.toggle('active', parseInt(b.dataset.limit) === state.cryptoRankLimit);
  });
}

function _updateCryptoFilterBtns() {
  const btn = document.getElementById('crypto-fav-toggle');
  if (!btn) return;
  const isFav = state.cryptoFilterMode === 'favorites';
  btn.textContent = isFav ? '⭐ Favorites' : '☆ All Coins';
  btn.classList.toggle('active', isFav);
}

/* ─── CRYPTO FAVORITES (STAR) ────────────────────────────────── */
function toggleCryptoFavorite(id) {
  if (!state.favoriteCryptoIds) state.favoriteCryptoIds = [];
  const idx = state.favoriteCryptoIds.indexOf(id);
  if (idx >= 0) state.favoriteCryptoIds.splice(idx, 1);
  else state.favoriteCryptoIds.push(id);
  localStorage.setItem('favoriteCryptoIds', JSON.stringify(state.favoriteCryptoIds));
  // Update star button without full re-render
  document.querySelectorAll(`.crypto-star-btn[data-id="${id}"]`).forEach(btn => {
    btn.classList.toggle('starred', state.favoriteCryptoIds.includes(id));
    btn.title = state.favoriteCryptoIds.includes(id) ? 'Remove from favorites' : 'Add to favorites';
  });
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
        cell.innerHTML = buildSparklineSVG(data, 90, 26, '#77DD77', '#FF6B6B');
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
        cell.innerHTML = buildSparklineSVG(prices, 90, 26, '#77DD77', '#FF6B6B');
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

/* ─── MARKET SECTOR TRENDS ────────────────────────────────────── */
let _sectorsData = null;
let _sectorAvailable = {};
let _sectorPeriod = '1D';
let _sectorHoverTimer = null;
let _mouseX = 0, _mouseY = 0;
document.addEventListener('mousemove', e => { _mouseX = e.clientX; _mouseY = e.clientY; });

// Client-side sector cache (localStorage, 6h TTL)
const SECTOR_CLIENT_TTL = 6 * 60 * 60 * 1000;
function _loadSectorCache() {
  try {
    const raw = localStorage.getItem('sectorDataCache');
    if (!raw) return null;
    const { data, available, at } = JSON.parse(raw);
    if (Date.now() - at > SECTOR_CLIENT_TTL) return null;
    return { data, available };
  } catch { return null; }
}
function _saveSectorCache(data, available) {
  try { localStorage.setItem('sectorDataCache', JSON.stringify({ data, available, at: Date.now() })); } catch {}
}

const SECTOR_GROUP_ORDER = ['US Sectors', 'Tech Sectors', 'International', 'Commodities', 'Crypto', 'Fixed Income'];

async function renderSectors() {
  const grid = document.getElementById('sectors-grid');
  if (!grid) return;
  if (!_sectorsData) {
    // Try localStorage cache first
    const cached = _loadSectorCache();
    if (cached) {
      _sectorsData = cached.data;
      _sectorAvailable = cached.available || {};
      _buildSectorGrid();
      return;
    }
    grid.innerHTML = '<div class="empty-state"><div class="empty-icon">📊</div><h3>Loading sector data…</h3><p>Fetching performance for 90 market sectors across 6 groups (cached for 12h)</p></div>';
    try {
      const res = await api('GET', '/sectors');
      _sectorsData = res.sectors || res;
      _sectorAvailable = res.available || {};
      _saveSectorCache(_sectorsData, _sectorAvailable);
    } catch (e) {
      grid.innerHTML = `<div class="empty-state"><div class="empty-icon">⚠️</div><h3>Failed to load sectors</h3><p>${e.message}</p><button class="btn-secondary" onclick="refreshSectors()">Retry</button></div>`;
      return;
    }
  }
  _buildSectorGrid();
}

async function refreshSectors() {
  _sectorsData = null;
  _sectorAvailable = {};
  localStorage.removeItem('sectorDataCache');
  const grid = document.getElementById('sectors-grid');
  if (grid) grid.innerHTML = '<div class="empty-state"><div class="empty-icon">📊</div><h3>Refreshing sector data…</h3><p>Fetching live data from Yahoo Finance</p></div>';
  await renderSectors();
}

function setSectorPeriod(period) {
  _sectorPeriod = period;
  document.querySelectorAll('.sector-period-btn').forEach(b => b.classList.toggle('active', b.dataset.period === period));
  _buildSectorGrid();
}

function _buildSectorGrid() {
  const grid = document.getElementById('sectors-grid');
  if (!grid || !_sectorsData) return;

  const period = _sectorPeriod;
  // Compute global maxAbs for scaling bars across ALL sectors
  const allVals = _sectorsData.map(s => s.perf?.[period]).filter(v => v != null);
  const maxAbs = allVals.length ? Math.max(...allVals.map(Math.abs), 0.01) : 1;

  // Group sectors
  const groups = {};
  for (const s of _sectorsData) {
    if (!groups[s.group]) groups[s.group] = [];
    groups[s.group].push(s);
  }
  // Sort each group best→worst for the chosen period
  for (const arr of Object.values(groups)) {
    arr.sort((a, b) => (b.perf?.[period] ?? -999) - (a.perf?.[period] ?? -999));
  }

  // Update subtitle
  const valid = allVals.length;
  const up = allVals.filter(v => v > 0).length;
  const dn = allVals.filter(v => v < 0).length;
  const subtitle = document.getElementById('sectors-subtitle');
  if (subtitle) subtitle.textContent = `${_sectorsData.length} sectors · ${up} ↑ up · ${dn} ↓ down · ${period} performance`;

  grid.innerHTML = SECTOR_GROUP_ORDER.map(groupName => {
    const custom = _getCustomSector(groupName);
    const displayName = custom.label || groupName;
    let items = groups[groupName] || [];
    if (custom.symbols?.length) {
      // Preserve custom order; add any custom symbols not in base data as placeholder
      items = custom.symbols.map(sym => items.find(s => s.symbol === sym)).filter(Boolean);
    }
    if (!items.length) return '';
    return `
      <div class="sector-group">
        <div class="sector-group-header">
          <span>${displayName}</span>
          <button class="sector-customize-btn" onclick="customizeSectorGroup('${groupName}')">✏️ Customize</button>
        </div>
        ${items.map(s => _buildSectorRow(s, period, maxAbs)).join('')}
      </div>`;
  }).join('');
}

function _buildSectorRow(s, period, maxAbs) {
  const pct = s.perf?.[period];
  const dir = pct == null ? '' : (pct >= 0 ? 'up' : 'down');
  const pctStr = pct == null ? '—' : `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`;
  // Bar width: 0→48% of the half-side
  const barW = pct == null ? 0 : Math.min(Math.abs(pct) / maxAbs * 48, 48).toFixed(1);

  const priceStr = s.price != null ? `$${s.price.toFixed(2)}` : '';
  const chgStr = s.changePct != null
    ? `<span class="${s.changePct >= 0 ? 'up' : 'down'}">${s.changePct >= 0 ? '+' : ''}${s.changePct.toFixed(2)}%</span>`
    : '';

  return `
    <div class="sector-row"
         onmouseenter="_scheduleSectorHover(this,'${s.symbol}','${s.name.replace(/'/g, '&#39;')}')"
         onmouseleave="_clearSectorHover()">
      <div class="sector-row-name">
        <span class="sector-emoji">${s.emoji}</span>
        <span class="sector-ticker">${s.symbol}</span>
        <span class="sector-label">${s.name}</span>
      </div>
      <div class="sector-bar-container">
        <div class="sector-bar-neg-half">
          ${dir === 'down' ? `<div class="sector-bar neg" style="width:${barW}%"></div>` : ''}
        </div>
        <div class="sector-bar-center-line"></div>
        <div class="sector-bar-pos-half">
          ${dir === 'up' ? `<div class="sector-bar pos" style="width:${barW}%"></div>` : ''}
        </div>
      </div>
      <div class="sector-row-pct ${dir}">${pctStr}</div>
    </div>`;
}

// ── Sector hover popup (news) ──────────────────────────────────
function _scheduleSectorHover(el, symbol, name) {
  clearTimeout(_sectorHoverTimer);
  _sectorHoverTimer = setTimeout(() => _showSectorPopup(el, symbol, name), 500);
}

function _clearSectorHover() {
  clearTimeout(_sectorHoverTimer);
  _sectorHoverTimer = setTimeout(() => {
    const p = document.getElementById('sector-news-popup');
    if (p) p.classList.remove('snp-active');
  }, 200);
}

async function _showSectorPopup(anchorEl, symbol, name) {
  let popup = document.getElementById('sector-news-popup');
  if (!popup) {
    popup = document.createElement('div');
    popup.id = 'sector-news-popup';
    popup.className = 'sector-news-popup';
    popup.onmouseenter = () => clearTimeout(_sectorHoverTimer);
    popup.onmouseleave = () => _clearSectorHover();
    document.body.appendChild(popup);
  }

  // Position popup near mouse cursor (not at element right edge)
  const popupW = 560, popupH = 480;
  let left = _mouseX + 16;
  let top = _mouseY + window.scrollY - 20;
  // Keep within viewport
  if (left + popupW > window.innerWidth - 10) left = _mouseX - popupW - 10;
  if (left < 0) left = 10;
  if (top - window.scrollY + popupH > window.innerHeight - 10) top = _mouseY + window.scrollY - popupH + 20;
  if (top < window.scrollY + 10) top = window.scrollY + 10;
  popup.style.top = `${top}px`;
  popup.style.left = `${left}px`;

  // Find sector data for quick stats
  const sec = _sectorsData?.find(s => s.symbol === symbol);
  const priceStr = sec?.price != null ? `$${sec.price.toFixed(2)}` : '';
  const chgStr = sec?.changePct != null
    ? `<span style="color:var(--${sec.changePct >= 0 ? 'green' : 'red'})">${sec.changePct >= 0 ? '+' : ''}${sec.changePct.toFixed(2)}%</span>`
    : '';
  const perfRows = sec?.perf ? ['1D','1W','1M','3M','YTD','1Y','2Y','5Y','10Y'].map(p =>
    `<span class="snp-perf-item"><span class="snp-perf-label">${p}</span><span class="snp-perf-val ${(sec.perf[p] ?? 0) >= 0 ? 'up' : 'down'}">${sec.perf[p] != null ? (sec.perf[p] >= 0 ? '+' : '') + sec.perf[p].toFixed(2) + '%' : '—'}</span></span>`
  ).join('') : '';

  popup.innerHTML = `
    <div class="snp-header">
      <div class="snp-title"><span class="snp-symbol">${symbol}</span> ${name}</div>
      <div class="snp-price">${priceStr} ${chgStr}</div>
    </div>
    <div class="snp-chart-wrap" id="snp-chart-${symbol}"><div class="snp-chart-loading">Loading chart…</div></div>
    ${perfRows ? `<div class="snp-perf-row">${perfRows}</div>` : (sec ? '' : '<div class="snp-loading">Loading sector data…</div>')}
    <div class="snp-news-list" id="snp-news-${symbol}"><div class="snp-loading">Loading news…</div></div>
    <div class="snp-footer">
      <button class="snp-open-btn" onclick="event.stopPropagation();setTVSymbol('${symbol}');navigate('tradingview')">📈 Open Chart →</button>
    </div>`;
  popup.classList.add('snp-active');

  // Load sparkline chart for this ETF (3-month)
  try {
    const chartData = await api('GET', `/stock/${encodeURIComponent(symbol)}/chart?range=3mo`);
    const chartEl = document.getElementById(`snp-chart-${symbol}`);
    if (chartEl && popup.classList.contains('snp-active')) {
      const prices = (chartData.dataPoints || []).map(p => p.close).filter(v => v != null && v > 0);
      if (prices.length > 2) {
        const svg = buildSparklineSVG(prices, 532, 100, '#77DD77', '#FF6B6B');
        if (svg) { chartEl.innerHTML = svg; }
        else { chartEl.style.display = 'none'; } // hide empty placeholder
      } else {
        chartEl.style.display = 'none'; // no data — hide cleanly instead of showing blank
      }
    }
  } catch {
    const el = document.getElementById(`snp-chart-${symbol}`);
    if (el) el.style.display = 'none'; // hide rather than show ugly error
  }

  // Lazy-load news (try stock news endpoint, fall back to latest)
  try {
    let news = [];
    try { news = await api('GET', `/stock/${symbol}/news`); } catch {}
    if (!news?.length) {
      try {
        const latest = await api('GET', `/api/news/latest?symbols=${symbol}`);
        news = latest?.articles || latest || [];
      } catch {}
    }
    const nl = document.getElementById(`snp-news-${symbol}`);
    if (!nl || !popup.classList.contains('snp-active')) return;
    nl.innerHTML = news.length
      ? news.slice(0, 5).map(n => `
          <div class="snp-news-item">
            <a href="${escHtml(n.link || n.url)}" target="_blank" rel="noopener">${escHtml(n.title)}</a>
            <span class="snp-news-meta">${escHtml(n.source || n.publisher || '')}</span>
          </div>`).join('')
      : '<div class="snp-loading">No recent news</div>';
  } catch {
    const nl = document.getElementById(`snp-news-${symbol}`);
    if (nl) nl.innerHTML = '<div class="snp-loading">No recent news</div>';
  }
}

/* ─── SECTOR CUSTOMIZE ────────────────────────────────────────── */
let _customizingGroup = null;

function _getCustomSector(groupName) {
  try { return (JSON.parse(localStorage.getItem('customSectors') || '{}'))[groupName] || {}; }
  catch { return {}; }
}
function _setCustomSector(groupName, data) {
  try {
    const all = JSON.parse(localStorage.getItem('customSectors') || '{}');
    all[groupName] = data;
    localStorage.setItem('customSectors', JSON.stringify(all));
  } catch {}
}

function customizeSectorGroup(groupName) {
  _customizingGroup = groupName;
  const custom = _getCustomSector(groupName);
  const allInGroup = _sectorsData?.filter(s => s.group === groupName) || [];
  const activeSymbols = custom.symbols?.length ? custom.symbols : allInGroup.map(s => s.symbol);
  const displayName = custom.label || groupName;

  // Get available alternatives for this group (not already active)
  const availableList = (_sectorAvailable[groupName] || []).filter(a => !activeSymbols.includes(a.symbol));

  document.getElementById('cust-modal-title').textContent = `✏️ Customize: ${groupName}`;
  const body = document.getElementById('cust-modal-body');
  body.innerHTML = `
    <div class="form-group">
      <label class="form-label">Group Display Name</label>
      <input type="text" class="form-input" id="cust-group-name" value="${displayName}" placeholder="${groupName}" />
    </div>
    <div class="form-group">
      <label class="form-label">Active Sectors <span class="form-label-hint">(click × to remove)</span></label>
      <div class="cust-chips" id="cust-active-chips">
        ${activeSymbols.map(sym => {
          const s = _sectorsData?.find(x => x.symbol === sym) || (_sectorAvailable[groupName] || []).find(x => x.symbol === sym);
          return `<span class="cust-chip" data-sym="${sym}">${s?.emoji || '📊'} ${sym}<button onclick="removeCustChip('${sym}')">×</button></span>`;
        }).join('')}
      </div>
    </div>
    ${availableList.length ? `
    <div class="form-group">
      <label class="form-label">Quick Add from Suggestions</label>
      <div class="cust-dropdown-wrap">
        <select class="form-select" id="cust-dropdown">
          <option value="">— Select an ETF to add —</option>
          ${availableList.map(a => `<option value="${a.symbol}" data-emoji="${a.emoji}">${a.emoji} ${a.symbol} — ${a.name}</option>`).join('')}
        </select>
        <button class="btn-secondary" onclick="addCustFromDropdown()">+ Add</button>
      </div>
    </div>` : ''}
    <div class="form-group">
      <label class="form-label">Add Custom Ticker</label>
      <div style="display:flex;gap:8px">
        <input type="text" class="form-input" id="cust-add-ticker" placeholder="e.g. VTI, SPY, GLD…" style="text-transform:uppercase" onkeydown="if(event.key==='Enter')addCustChip()" />
        <button class="btn-secondary" onclick="addCustChip()">Add</button>
      </div>
      <p class="form-hint">Enter any ETF or stock ticker symbol to add it to this group.</p>
    </div>
    <div style="margin-top:4px">
      <button class="btn-outline" style="font-size:11px;padding:4px 10px" onclick="resetCustomSector('${groupName}')">↺ Reset to Default</button>
    </div>`;

  document.getElementById('customize-sectors-modal').style.display = 'flex';
}

function addCustFromDropdown() {
  const sel = document.getElementById('cust-dropdown');
  const sym = sel?.value;
  if (!sym) return;
  const opt = sel.options[sel.selectedIndex];
  const emoji = opt?.dataset?.emoji || '📊';
  if (document.querySelector(`.cust-chip[data-sym="${sym}"]`)) { sel.value = ''; return; }
  const chips = document.getElementById('cust-active-chips');
  const chip = document.createElement('span');
  chip.className = 'cust-chip';
  chip.dataset.sym = sym;
  chip.innerHTML = `${emoji} ${sym}<button onclick="removeCustChip('${sym}')">×</button>`;
  chips.appendChild(chip);
  // Remove from dropdown
  opt.remove();
  sel.value = '';
}

function removeCustChip(sym) {
  const chip = document.querySelector(`.cust-chip[data-sym="${sym}"]`);
  if (chip) chip.remove();
}

function addCustChip() {
  const input = document.getElementById('cust-add-ticker');
  const sym = input.value.trim().toUpperCase();
  if (!sym) return;
  if (document.querySelector(`.cust-chip[data-sym="${sym}"]`)) { input.value = ''; return; }
  const s = _sectorsData?.find(x => x.symbol === sym);
  const emoji = s?.emoji || '📊';
  const chips = document.getElementById('cust-active-chips');
  const chip = document.createElement('span');
  chip.className = 'cust-chip';
  chip.dataset.sym = sym;
  chip.innerHTML = `${emoji} ${sym}<button onclick="removeCustChip('${sym}')">×</button>`;
  chips.appendChild(chip);
  input.value = '';
}

function saveCustomizeSectors() {
  if (!_customizingGroup) return;
  const label = (document.getElementById('cust-group-name')?.value || '').trim();
  const chips = document.querySelectorAll('#cust-active-chips .cust-chip');
  const symbols = [...chips].map(c => c.dataset.sym);
  _setCustomSector(_customizingGroup, { label: label || _customizingGroup, symbols });
  hideCustomizeSectorsModal();
  _buildSectorGrid();
}

function resetCustomSector(groupName) {
  _setCustomSector(groupName, {});
  hideCustomizeSectorsModal();
  _buildSectorGrid();
}

function hideCustomizeSectorsModal() {
  const m = document.getElementById('customize-sectors-modal');
  if (m) m.style.display = 'none';
  _customizingGroup = null;
}

/* ─── TRADINGVIEW WIDGETS ─────────────────────────────────────── */
function _injectTVWidget(containerId, widgetName, config) {
  const container = document.getElementById(containerId);
  if (!container || container.dataset.initialized) return;
  container.dataset.initialized = 'true';
  container.innerHTML = ''; // clear any placeholder
  const script = document.createElement('script');
  script.src = `https://s3.tradingview.com/external-embedding/embed-widget-${widgetName}.js`;
  script.async = true;
  script.text = JSON.stringify(config);
  container.appendChild(script);
}

/* ── Maps state ── */
let _mapsSource = 'SPX500';
let _mapsSourceLabel = 'S&P 500';
let _mapsGrouping = 'sector';
let _mapsMetric = 'change';

function initTVMaps() {
  // Always re-render with current params (clear initialized flag)
  const container = document.getElementById('tv-maps-container');
  if (container) {
    container.dataset.initialized = '';
    container.innerHTML = '';
  }
  const h = Math.max(500, window.innerHeight - 130);
  _injectTVWidget('tv-maps-container', 'stock-heatmap', {
    exchanges: [],
    dataSource: _mapsSource,
    grouping: _mapsGrouping,
    blockSize: 'market_cap_basic',
    blockColor: _mapsMetric,
    locale: 'en',
    symbolUrl: '',
    colorTheme: 'dark',
    hasTopBar: true,
    isDataSetEnabled: false,
    isZoomEnabled: true,
    hasSymbolTooltip: true,
    isMonoSize: false,
    width: '100%',
    height: h,
  });
}

function initTVCryptoHeatmap() {
  const container = document.getElementById('tv-crypto-heatmap-container');
  if (!container) return;
  container.dataset.initialized = '';
  container.innerHTML = '';
  const h = Math.max(500, window.innerHeight - 205);
  _injectTVWidget('tv-crypto-heatmap-container', 'crypto-coins-heatmap', {
    dataSource: 'Crypto',
    blockSize: 'market_cap_calc',
    blockColor: 'change',
    locale: 'en',
    colorTheme: 'dark',
    hasTopBar: true,
    width: '100%',
    height: h,
  });
}

function setMapsSource(source, label) {
  _mapsSource = source;
  _mapsSourceLabel = label;
  const lbl = document.getElementById('maps-source-label');
  if (lbl) lbl.textContent = label;
  const menu = document.getElementById('maps-source-menu');
  if (menu) menu.classList.remove('open');
  initTVMaps();
}

function setMapsGrouping(grouping, btn) {
  _mapsGrouping = grouping;
  document.querySelectorAll('.maps-group-btn').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  initTVMaps();
}

function setMapsMetric(metric) {
  _mapsMetric = metric;
  initTVMaps();
}

function toggleMapsSourceMenu(e) {
  e.stopPropagation();
  const menu = document.getElementById('maps-source-menu');
  if (menu) menu.classList.toggle('open');
}

// Close maps dropdown when clicking outside
document.addEventListener('click', function(e) {
  const wrap = document.getElementById('maps-source-wrap');
  if (wrap && !wrap.contains(e.target)) {
    const menu = document.getElementById('maps-source-menu');
    if (menu) menu.classList.remove('open');
  }
});

/* ─── ECONOMIC CALENDAR (Finviz-style) ─────────────────────── */
let _econCalData = [];
let _econCalLoaded = false;
let _econCalRange = '1w';

const COUNTRY_FLAGS = {
  USD: '🇺🇸', EUR: '🇪🇺', GBP: '🇬🇧', JPY: '🇯🇵', CAD: '🇨🇦', AUD: '🇦🇺',
  NZD: '🇳🇿', CHF: '🇨🇭', CNY: '🇨🇳', KRW: '🇰🇷', INR: '🇮🇳', BRL: '🇧🇷',
};

async function loadEconCalendar() {
  try {
    const data = await api('GET', '/economic-calendar');
    if (Array.isArray(data) && data.length) {
      _econCalData = data;
      _econCalLoaded = true;
    }
  } catch(e) { console.warn('Econ calendar load failed:', e.message); }
  renderEconCalendar();
  // Also load earnings calendar alongside
  if (!_earningsCalLoaded) loadEarningsCalendar();
}

function setEconCalRange(range) {
  _econCalRange = range;
  document.querySelectorAll('#cal-range-btns .cal-range-btn').forEach(b => b.classList.toggle('active', b.dataset.range === range));
  renderEconCalendar();
}

function renderEconCalendar() {
  const container = document.getElementById('econ-cal-table');
  if (!container) return;

  if (!_econCalLoaded) {
    container.innerHTML = '<div style="padding:24px;color:var(--text-dim);text-align:center">Loading economic calendar…</div>';
    return;
  }

  // Read filters
  const showHigh = document.getElementById('econ-impact-high')?.checked ?? true;
  const showMedium = document.getElementById('econ-impact-medium')?.checked ?? true;
  const showLow = document.getElementById('econ-impact-low')?.checked ?? false;
  const searchQ = (document.getElementById('econ-search-input')?.value || '').toLowerCase().trim();

  const impactFilter = new Set();
  if (showHigh) impactFilter.add('High');
  if (showMedium) impactFilter.add('Medium');
  if (showLow) { impactFilter.add('Low'); impactFilter.add('Holiday'); }

  // Filter events — USD only
  let events = _econCalData.filter(e => {
    if (e.country !== 'USD' && e.country) return false;
    if (!impactFilter.has(e.impact)) return false;
    if (searchQ && !(e.title || '').toLowerCase().includes(searchQ) && !(e.country || '').toLowerCase().includes(searchQ)) return false;
    return true;
  });

  // Date range filter
  const now = new Date();
  let rangeEnd = new Date();
  if (_econCalRange === '1w') rangeEnd = new Date(now.getTime() + 7 * 86400000);
  else if (_econCalRange === '1m') rangeEnd = new Date(now.getTime() + 30 * 86400000);
  else if (_econCalRange === '1q') rangeEnd = new Date(now.getTime() + 91 * 86400000);
  else if (_econCalRange === '1y') rangeEnd = new Date(now.getTime() + 365 * 86400000);
  events = events.filter(e => {
    const d = new Date(e.date);
    return d >= new Date(now.getTime() - 86400000) && d <= rangeEnd; // include yesterday to catch today's events
  });

  if (!events.length) {
    container.innerHTML = '<div style="padding:24px;color:var(--text-dim);text-align:center">No events match your filters. Try adjusting the impact or country filters.</div>';
    return;
  }

  // Group by day
  const today = new Date().toLocaleDateString('en-US', { timeZone: 'America/New_York' });
  const dayGroups = {};
  events.forEach(e => {
    const d = new Date(e.date);
    const dayKey = d.toLocaleDateString('en-US', { timeZone: 'America/New_York', weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
    if (!dayGroups[dayKey]) dayGroups[dayKey] = [];
    dayGroups[dayKey].push(e);
  });

  let html = `<table class="econ-cal-table">
    <thead><tr>
      <th style="width:70px">Time</th>
      <th style="width:50px">Ctry</th>
      <th style="width:30px"></th>
      <th>Event</th>
      <th style="width:80px;text-align:right">Forecast</th>
      <th style="width:80px;text-align:right">Previous</th>
    </tr></thead><tbody>`;

  for (const [day, evts] of Object.entries(dayGroups)) {
    const isToday = day === new Date().toLocaleDateString('en-US', { timeZone: 'America/New_York', weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
    html += `<tr class="econ-cal-day-row${isToday ? ' today' : ''}"><td colspan="6">${isToday ? '📍 ' : ''}${day}</td></tr>`;

    evts.forEach(e => {
      const d = new Date(e.date);
      const time = d.toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit', hour12: true });
      const flag = COUNTRY_FLAGS[e.country] || '🏳️';
      const impactClass = (e.impact || 'low').toLowerCase();
      const isHoliday = e.impact === 'Holiday';
      const forecast = e.forecast || '—';
      const previous = e.previous || '—';

      html += `<tr class="${isHoliday ? 'econ-holiday-row' : ''}">
        <td><span class="econ-time">${isHoliday ? 'All Day' : time}</span></td>
        <td><span class="econ-country-flag">${flag}</span>${e.country}</td>
        <td><span class="econ-impact ${impactClass}" title="${e.impact} Impact"></span></td>
        <td><span class="econ-event-name">${escHtml(e.title)}</span></td>
        <td style="text-align:right"><span class="econ-val neutral">${forecast}</span></td>
        <td style="text-align:right"><span class="econ-val neutral">${previous}</span></td>
      </tr>`;
    });
  }

  html += '</tbody></table>';
  container.innerHTML = html;

  // Update subtitle
  const subtitle = document.getElementById('econ-cal-subtitle');
  if (subtitle) subtitle.textContent = `${events.length} events · ${Object.keys(dayGroups).length} days`;
}

function switchCalTab(tab) {
  document.querySelectorAll('#cal-tab-switcher .cal-period-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.getElementById('econ-cal-tab').style.display = tab === 'econ' ? '' : 'none';
  document.getElementById('tv-cal-tab').style.display = tab === 'tv' ? '' : 'none';
  if (tab === 'econ' && !_econCalLoaded) loadEconCalendar();
  if (tab === 'tv') initTVCalendar();
}

/* ─── EARNINGS CALENDAR (Top 100 companies) ─────────────────── */
let _earningsCalData = [];
let _earningsCalLoaded = false;
let _earningsCalRange = '3m';

async function loadEarningsCalendar() {
  const container = document.getElementById('earnings-cal-table');
  if (!container) return;
  try {
    const data = await api('GET', '/earnings-calendar');
    if (Array.isArray(data)) {
      _earningsCalData = data;
      _earningsCalLoaded = true;
    }
  } catch(e) { console.warn('Earnings calendar load failed:', e.message); }
  renderEarningsCalendar();
}

function setEarningsCalRange(range) {
  _earningsCalRange = range;
  document.querySelectorAll('#earnings-cal-range-btns .cal-range-btn').forEach(b => b.classList.toggle('active', b.dataset.range === range));
  renderEarningsCalendar();
}

function renderEarningsCalendar() {
  const container = document.getElementById('earnings-cal-table');
  if (!container) return;

  if (!_earningsCalLoaded) {
    container.innerHTML = '<div style="padding:24px;text-align:center;color:var(--text-dim)">Loading earnings calendar…</div>';
    return;
  }

  const now = new Date();
  const todayStr = now.toISOString().split('T')[0];
  let rangeMs;
  if (_earningsCalRange === '1m') rangeMs = 30 * 86400000;
  else if (_earningsCalRange === '3m') rangeMs = 91 * 86400000;
  else if (_earningsCalRange === '6m') rangeMs = 182 * 86400000;
  else rangeMs = 730 * 86400000; // 'all' = 2 years

  const rangeEnd = new Date(now.getTime() + rangeMs);

  const items = _earningsCalData
    .filter(c => {
      if (!c.earningsDate) return false;
      const d = new Date(c.earningsDate);
      return d >= new Date(todayStr) && d <= rangeEnd;
    })
    .sort((a, b) => a.earningsDate.localeCompare(b.earningsDate));

  if (!items.length) {
    container.innerHTML = '<div style="padding:24px;text-align:center;color:var(--text-dim)">No upcoming earnings in this period.</div>';
    return;
  }

  // Group by date
  const groups = {};
  items.forEach(c => {
    if (!groups[c.earningsDate]) groups[c.earningsDate] = [];
    groups[c.earningsDate].push(c);
  });

  let html = '';
  const todayDateStr = now.toISOString().split('T')[0];

  for (const [date, cos] of Object.entries(groups)) {
    const d = new Date(date + 'T12:00:00');
    const daysUntil = Math.round((d - now) / 86400000);
    const isToday = date === todayDateStr;
    const isSoon = daysUntil <= 7;
    const dayLabel = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
    const daysStr = isToday ? 'Today' : daysUntil === 1 ? 'Tomorrow' : `${daysUntil}d`;
    const urgencyClass = isToday ? 'ecal-today' : isSoon ? 'ecal-soon' : '';

    html += `<div class="ecal-day-group ${urgencyClass}">
      <div class="ecal-day-header">
        <span class="ecal-day-label">${dayLabel}</span>
        <span class="ecal-days-badge ${isToday ? 'today' : isSoon ? 'soon' : ''}">${daysStr}</span>
      </div>`;

    cos.forEach(c => {
      const estLabel = c.estimated ? '<span class="ecal-est">est</span>' : '';
      const sectorLabel = c.sector ? `<span class="ecal-sector">${c.sector}</span>` : '';
      html += `<div class="ecal-row" onclick="navigate('dashboard');state.selectedSymbol='${escHtml(c.symbol)}';setTimeout(()=>openStockModal('${escHtml(c.symbol)}'),400)" title="View ${escHtml(c.symbol)} details">
        <span class="ecal-symbol">${escHtml(c.symbol)}</span>
        <span class="ecal-name">${escHtml(c.name)}${estLabel}</span>
        ${sectorLabel}
      </div>`;
    });

    html += `</div>`;
  }

  container.innerHTML = html;
}

let _calPeriod = 'week';
function setCalendarPeriod(range) {
  _calPeriod = range;
  document.querySelectorAll('.cal-period-btn').forEach(b => b.classList.toggle('active', b.dataset.range === range));
  // Re-inject with fresh container
  const container = document.getElementById('tv-calendar-container');
  if (container) { delete container.dataset.initialized; container.innerHTML = ''; }
  initTVCalendar();
}

function refreshCalendarFilters() {
  const container = document.getElementById('tv-calendar-container');
  if (container) { delete container.dataset.initialized; container.innerHTML = ''; }
  initTVCalendar();
}

function filterCalendarEvents(query) {
  const bar = document.getElementById('cal-event-filter-bar');
  const label = document.getElementById('cal-filter-label-text');
  if (query.trim()) {
    bar.style.display = 'flex';
    label.textContent = `Showing events matching: "${query}"`;
  } else {
    bar.style.display = 'none';
  }
  // TradingView widget can't be filtered externally; show note overlay
  const overlay = document.getElementById('cal-search-overlay');
  if (overlay) overlay.remove();
  if (query.trim()) {
    const container = document.getElementById('tv-calendar-container');
    const ov = document.createElement('div');
    ov.id = 'cal-search-overlay';
    ov.className = 'cal-search-overlay';
    ov.innerHTML = `<div class="cal-search-note">📅 Showing TradingView calendar — search "<strong>${query}</strong>" not supported within the embedded widget.<br>Use <a href="https://www.tradingview.com/economic-calendar/" target="_blank">TradingView Economic Calendar</a> for full search.</div>`;
    container.parentNode.insertBefore(ov, container);
  }
}

function clearCalendarSearch() {
  const input = document.getElementById('cal-search-input');
  if (input) input.value = '';
  filterCalendarEvents('');
}

function initTVCalendar() {
  // Read impact filter checkboxes (default: High only)
  const high = document.getElementById('cal-impact-high')?.checked ?? true;
  const medium = document.getElementById('cal-impact-medium')?.checked ?? false;
  const low = document.getElementById('cal-impact-low')?.checked ?? false;
  const filters = [];
  if (high) filters.push('1');
  if (medium) filters.push('0');
  if (low) filters.push('-1');
  const importanceFilter = filters.length ? filters.join(',') : '1';

  _injectTVWidget('tv-calendar-container', 'events', {
    colorTheme: 'dark',
    isTransparent: false,
    width: '100%',
    height: 680,
    locale: 'en',
    importanceFilter,
    countryFilter: 'us',
  });
}

let _screenerLength = 50;

function setScreenerLength(n) {
  _screenerLength = n;
  document.querySelectorAll('.screener-len-btn').forEach(b => b.classList.toggle('active', b.dataset.len == n));
  initTVScreener();
}

function initTVScreener() {
  // Re-init if filters changed
  const container = document.getElementById('tv-screener-container');
  if (container) { delete container.dataset.initialized; container.innerHTML = ''; }
  const market = document.getElementById('screener-market')?.value || 'america';
  const col = document.getElementById('screener-column')?.value || 'performance';
  const screen = document.getElementById('screener-screen')?.value || 'most_capitalized';
  _injectTVWidget('tv-screener-container', 'screener', {
    width: '100%',
    height: Math.max(600, _screenerLength <= 50 ? 650 : _screenerLength <= 100 ? 800 : 1200),
    defaultColumn: col,
    defaultScreen: screen,
    market: market,
    showToolbar: true,
    colorTheme: 'dark',
    locale: 'en',
  });
}

/* ─── TRADINGVIEW ADVANCED CHART ──────────────────────────────── */
let _tvChartSymbol = 'NASDAQ:AAPL';
let _tvChartInitialized = false;

function initTVTradingView() {
  const container = document.getElementById('tv-tradingview-container');
  if (!container) return;
  // Always re-create to load new symbol
  delete container.dataset.initialized;
  container.innerHTML = '';
  // Set explicit height to fill window
  const headerH = document.querySelector('#tradingview-view .view-header')?.offsetHeight || 80;
  const barH = document.querySelector('.tv-symbol-bar')?.offsetHeight || 46;
  const h = Math.max(500, window.innerHeight - headerH - barH - 60);
  container.style.height = h + 'px';

  const sym = _tvChartSymbol;
  const script = document.createElement('script');
  script.src = 'https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js';
  script.async = true;
  script.text = JSON.stringify({
    autosize: true,
    symbol: sym,
    interval: 'D',
    timezone: 'America/New_York',
    theme: 'dark',
    style: '1',
    locale: 'en',
    enable_publishing: false,
    allow_symbol_change: true,
    calendar: false,
    support_host: 'https://www.tradingview.com',
    hide_legend: false,
    hide_top_toolbar: false,
    save_image: true,
    studies: ['RSI@tv-basicstudies', 'MAExp@tv-basicstudies'],
  });
  container.appendChild(script);
}

function setTVSymbol(sym) {
  _tvChartSymbol = sym;
  const input = document.getElementById('tv-symbol-input');
  if (input) input.value = sym;
  initTVTradingView();
}

function loadTVChart() {
  const input = document.getElementById('tv-symbol-input');
  let sym = (input?.value || '').trim().toUpperCase();
  if (!sym) return;
  // Auto-prefix if no exchange specified
  if (!sym.includes(':')) {
    // Guess exchange
    if (sym.endsWith('-USD') || sym.endsWith('USDT') || sym.endsWith('BTC')) sym = 'BINANCE:' + sym.replace('-', '');
    else sym = sym; // TradingView will resolve
  }
  _tvChartSymbol = sym;
  initTVTradingView();
}

function screenerSearchSymbol() {
  const input = document.getElementById('screener-symbol-input');
  const sym = (input?.value || '').trim().toUpperCase();
  if (!sym) return;
  // Open in TradingView tab with the searched symbol
  _tvChartSymbol = sym;
  navigate('tradingview');
}

/* ─── BOOT ────────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', init);
