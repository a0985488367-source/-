/**
 * SMC Crypto Terminal — 應用主程式
 * 負責：狀態管理、資料載入、UI 綁定、面板渲染、各分頁功能。
 */

import { loadState, saveState, resetState, DEFAULT_STATE } from './core/store.js';
import { bus } from './core/bus.js';
import { $, $$, setHTML, toast } from './ui/dom.js';
import { Feed } from './data/feed.js';
import { PROVIDERS } from './data/providers.js';
import { analyze } from './smc/engine.js';
import { positionSize } from './smc/setups.js';
import { aggregateBias, narrative, TF_WEIGHT } from './smc/mtf.js';
import { backtest } from './smc/backtest.js';
import { Chart } from './chart/chart.js';
import * as P from './ui/panels.js';
import { runScan, renderScanTable } from './ui/scanner.js';
import { fetchMarket, renderMarket } from './ui/market.js';
import { AlertEngine, createAlert, renderAlerts } from './ui/alerts.js';
import { renderGlossary } from './ui/glossary.js';
import { createTradePanel } from './ui/trade.js';
import { fmtPrice, fmtNum, fmtTime, fmtAgo, debounce, throttle, escapeHtml } from './core/utils.js';

/* ------------------------------------------------------------------ 狀態 */

const state = loadState();
const feed = new Feed(state);
const alerts = new AlertEngine(state);

let chart = null;
let candles = [];
let analysis = null;
let ticker = null;
let mtfRows = [];
let mtfAgg = null;
let htfBias = null;
let symbols = [];
let lastUpdated = 0;
let scanRows = [];

const replay = { active: false, index: 0, timer: null, speed: 350 };

const INTERVALS = ['1m', '5m', '15m', '30m', '1h', '4h', '1d'];
const CHART_TYPES = [
  { id: 'candles', label: 'K 棒' },
  { id: 'hollow', label: '空心' },
  { id: 'line', label: '線圖' },
  { id: 'area', label: '面積' },
];

const LAYER_DEFS = [
  { id: 'orderBlocks', zh: '訂單塊 OB', en: 'Order Blocks', color: '#26a69a' },
  { id: 'breakers', zh: '破壞塊 BB', en: 'Breakers', color: '#ef5350' },
  { id: 'fvg', zh: 'FVG 缺口', en: 'FVG', color: '#409eff' },
  { id: 'volumeImbalance', zh: '量能不平衡', en: 'Vol. Imbalance', color: '#7f8ea3' },
  { id: 'liquidity', zh: '流動性', en: 'Liquidity', color: '#e2b13c' },
  { id: 'sweeps', zh: '掃除標記', en: 'Sweeps', color: '#ff6ad5' },
  { id: 'structure', zh: '結構 BOS/CHoCH', en: 'Structure', color: '#f0b429' },
  { id: 'swingLabels', zh: 'HH/HL 標籤', en: 'Swing labels', color: '#8b97a8' },
  { id: 'inducement', zh: '誘導 IDM', en: 'Inducement', color: '#ff9f43' },
  { id: 'premiumDiscount', zh: '折溢價', en: 'Premium/Discount', color: '#9b6dff' },
  { id: 'ote', zh: 'OTE', en: 'OTE', color: '#9b6dff' },
  { id: 'fib', zh: '斐波那契', en: 'Fib', color: '#7f8ea3' },
  { id: 'keyLevels', zh: '關鍵價位', en: 'Key levels', color: '#e2b13c' },
  { id: 'sessions', zh: '交易時段', en: 'Sessions', color: '#2f855a' },
  { id: 'ema', zh: 'EMA', en: 'EMA', color: '#5ba3f5' },
  { id: 'vwap', zh: 'VWAP', en: 'VWAP', color: '#48c9b0' },
  { id: 'volumeProfile', zh: '成交量分佈', en: 'Volume profile', color: '#ffcf5c' },
  { id: 'setup', zh: '交易計畫', en: 'Trade plan', color: '#3aa0ff' },
];

/** 圖層精簡度：手機上「線太擠」時一鍵切到精簡 */
const LAYER_PRESETS = {
  lean: ['orderBlocks', 'breakers', 'fvg', 'structure', 'liquidity', 'setup'],
  standard: [
    'orderBlocks', 'breakers', 'fvg', 'liquidity', 'sweeps', 'structure', 'swingLabels',
    'inducement', 'premiumDiscount', 'ote', 'keyLevels', 'sessions', 'ema', 'setup',
  ],
  full: LAYER_DEFS.map((l) => l.id),
};
const PRESET_ORDER = ['lean', 'standard', 'full'];
const PRESET_LABEL = { lean: { zh: '精簡', en: 'Lean' }, standard: { zh: '標準', en: 'Standard' }, full: { zh: '完整', en: 'Full' }, custom: { zh: '自訂', en: 'Custom' } };

// 分頁名稱用 data-tab 當索引，不用陣列順序 ——
// 之前是按順序對應，插入一個新分頁就會讓後面全部錯位。
const T = {
  zh: {
    tabs: {
      analysis: '分析', mtf: '多週期', scanner: '掃描', backtest: '回測',
      risk: '風險', trade: '下單', alerts: '警報', learn: '教學', settings: '設定',
    },
  },
  en: {
    tabs: {
      analysis: 'Analysis', mtf: 'MTF', scanner: 'Scanner', backtest: 'Backtest',
      risk: 'Risk', trade: 'Trade', alerts: 'Alerts', learn: 'Learn', settings: 'Settings',
    },
  },
};

const isZh = () => state.lang === 'zh';

/* -------------------------------------------------------------------- 初始化 */

function init() {
  document.documentElement.dataset.theme = state.theme;
  document.documentElement.lang = isZh() ? 'zh-Hant' : 'en';

  chart = new Chart($('#chart'), {
    theme: state.theme,
    lang: state.lang,
    timezone: state.timezone,
    layers: state.layers,
    chartType: state.chartType,
    onHover: handleHover,
  });

  buildSegments();
  buildQuickBar();
  buildLayerChips();
  syncPresetButton();
  buildLegend();
  buildMtfChips();
  bindTopbar();
  bindSplit();
  bindTabs();
  bindChartTools();
  bindScanner();
  bindMarket();
  bindBacktest();
  bindRisk();
  bindTrade();
  bindAlerts();
  bindGlossary();
  bindSettings();
  applyLang();

  const onResize = throttle(() => chart.resize(), 60);
  new ResizeObserver(onResize).observe($('.chart-host'));
  window.addEventListener('resize', onResize);
  window.addEventListener('orientationchange', () => setTimeout(() => chart.resize(), 150));
  window.addEventListener('keydown', handleKeys);

  bus.on('stream:status', renderStatus);
  bus.on('provider:changed', ({ id, fallback }) => {
    renderStatus();
    if (fallback) toast(isZh() ? `已自動切換至備援資料源：${PROVIDERS[id].label}` : `Switched to fallback source: ${PROVIDERS[id].label}`, 'alert');
  });
  bus.on('provider:error', ({ id, error }) => console.warn(`[provider:${id}]`, error));

  registerServiceWorker();
  setupInstallHint();
  loadSymbols();
  loadData();
  setInterval(renderStatus, 5000);
}

/* ------------------------------------------------- PWA（加到主畫面／離線） */

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  // file:// 直接開啟時不註冊（Service Worker 需要 http/https）
  if (!/^https?:$/.test(location.protocol)) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(new URL('../sw.js', import.meta.url)).catch((e) => console.warn('SW 註冊失敗', e));
  });
}

const isStandalone = () =>
  window.matchMedia?.('(display-mode: standalone)').matches || window.navigator.standalone === true;

function setupInstallHint() {
  const hint = $('#installHint');
  if (!hint) return;
  const dismissed = (() => { try { return localStorage.getItem('smc-install-hint') === 'off'; } catch { return false; } })();
  const isIos = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  let deferredPrompt = null;

  $('#installHintClose').onclick = () => {
    hint.hidden = true;
    try { localStorage.setItem('smc-install-hint', 'off'); } catch {}
  };

  // Android / 桌面 Chrome：直接提供安裝按鈕
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    if (dismissed || isStandalone()) return;
    hint.querySelector('span').innerHTML = isZh()
      ? '可以把這個工具安裝成 App，全螢幕又能離線使用。'
      : 'Install this as an app for full-screen, offline use.';
    const btn = document.createElement('button');
    btn.className = 'btn btn--primary btn--sm';
    btn.textContent = isZh() ? '安裝' : 'Install';
    btn.onclick = async () => {
      hint.hidden = true;
      deferredPrompt.prompt();
      await deferredPrompt.userChoice;
      deferredPrompt = null;
    };
    hint.insertBefore(btn, $('#installHintClose'));
    hint.hidden = false;
  });

  const canInstall = /^https?:$/.test(location.protocol);
  if (isIos && canInstall && !isStandalone() && !dismissed) {
    if (!isZh()) {
      hint.querySelector('span').innerHTML =
        'Add to your Home Screen for a full-screen app: tap <b>Share</b> → <b>Add to Home Screen</b>.';
    }
    setTimeout(() => { hint.hidden = false; }, 2500);
  }
  if (isStandalone()) document.documentElement.classList.add('standalone');
}

/* ------------------------------------------------------------------ 建構 UI */

function buildSegments() {
  const seg = $('#intervalSeg');
  seg.innerHTML = INTERVALS.map((i) => `<button data-iv="${i}" class="${i === state.interval ? 'active' : ''}">${i}</button>`).join('');
  seg.onclick = (e) => {
    const iv = e.target.dataset?.iv;
    if (iv) setInterval_(iv);
  };

  const ct = $('#chartTypeSeg');
  ct.innerHTML = CHART_TYPES.map((t) => `<button data-ct="${t.id}" class="${t.id === state.chartType ? 'active' : ''}">${t.label}</button>`).join('');
  ct.onclick = (e) => {
    const id = e.target.dataset?.ct;
    if (!id) return;
    state.chartType = id;
    saveState(state);
    $$('#chartTypeSeg button').forEach((b) => b.classList.toggle('active', b.dataset.ct === id));
    chart.setChartType(id);
  };
}

/** 切換分析週期（頂部按鈕與手機快速列共用） */
function setInterval_(iv) {
  if (iv === state.interval) return;
  state.interval = iv;
  saveState(state);
  $$('#intervalSeg button').forEach((b) => b.classList.toggle('active', b.dataset.iv === iv));
  buildQuickBar();
  loadData();
}

/** 手機快速切換列：自選幣種 + 常用週期，免去開下拉選單 */
function buildQuickBar() {
  const host = $('#quickBar');
  if (!host) return;
  const syms = state.watchlist.slice(0, 8);
  const ivs = ['5m', '15m', '1h', '4h', '1d'];
  host.innerHTML =
    `<div class="quickbar__group">${syms
      .map((s) => `<button data-qsym="${s}" class="${s === state.symbol ? 'active' : ''}">${s.replace('USDT', '')}</button>`)
      .join('')}</div>` +
    `<span class="quickbar__sep"></span>` +
    `<div class="quickbar__group">${ivs
      .map((i) => `<button data-qiv="${i}" class="${i === state.interval ? 'active' : ''}">${i}</button>`)
      .join('')}</div>`;
  host.onclick = (e) => {
    const sym = e.target.dataset?.qsym;
    const iv = e.target.dataset?.qiv;
    if (sym) selectSymbol(sym);
    else if (iv) setInterval_(iv);
  };
}

/** 圖表與分析面板的高度分割：可拖曳，也可點一下循環三段 */
function bindSplit() {
  const bar = $('#splitBar');
  const ws = $('.workspace');
  if (!bar || !ws) return;
  const SNAPS = [45, 68, 85];
  const apply = (pct, save = true) => {
    state.split = Math.max(30, Math.min(88, pct));
    ws.style.setProperty('--split-a', `${state.split}fr`);
    ws.style.setProperty('--split-b', `${100 - state.split}fr`);
    if (save) saveState(state);
    chart.resize();
  };
  apply(state.split ?? 68, false);

  let dragging = false;
  let moved = false;
  let startY = 0;
  let startPct = 50;

  bar.addEventListener('pointerdown', (e) => {
    dragging = true;
    moved = false;
    startY = e.clientY;
    startPct = state.split;
    bar.setPointerCapture(e.pointerId);
    bar.classList.add('split-bar--dragging');
  });
  bar.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const dy = e.clientY - startY;
    if (Math.abs(dy) > 4) moved = true;
    apply(startPct + (dy / window.innerHeight) * 100, false);
  });
  const end = () => {
    if (!dragging) return;
    dragging = false;
    bar.classList.remove('split-bar--dragging');
    if (!moved) {
      // 點一下 → 往下一個段位循環（小 → 中 → 大 → 小）
      apply(SNAPS.find((s) => s > state.split + 2) ?? SNAPS[0]);
    } else {
      const near = SNAPS.reduce((a, b) => (Math.abs(b - state.split) < Math.abs(a - state.split) ? b : a));
      apply(Math.abs(near - state.split) < 7 ? near : state.split);
    }
  };
  bar.addEventListener('pointerup', end);
  bar.addEventListener('pointercancel', end);
}

/** 套用圖層精簡度 */
function applyPreset(name) {
  const ids = LAYER_PRESETS[name];
  if (ids) {
    for (const l of LAYER_DEFS) state.layers[l.id] = ids.includes(l.id);
  }
  state.layerPreset = name;
  saveState(state);
  chart.setLayers(state.layers);
  buildLayerChips();
  syncPresetButton();
}

function syncPresetButton() {
  const btn = $('#presetBtn');
  if (btn) btn.textContent = (PRESET_LABEL[state.layerPreset] || PRESET_LABEL.custom)[isZh() ? 'zh' : 'en'];
}

function buildLayerChips() {
  const host = $('#layerChips');
  host.innerHTML = LAYER_DEFS.map(
    (l) => `<button class="chip ${state.layers[l.id] ? 'on' : ''}" data-layer="${l.id}">
      <i style="background:${l.color}"></i>${isZh() ? l.zh : l.en}</button>`,
  ).join('');
  host.onclick = (e) => {
    const btn = e.target.closest('[data-layer]');
    if (!btn) return;
    const id = btn.dataset.layer;
    state.layers[id] = !state.layers[id];
    btn.classList.toggle('on', state.layers[id]);
    state.layerPreset = 'custom';
    syncPresetButton();
    saveState(state);
    chart.setLayers(state.layers);
  };
}

function buildLegend() {
  const items = [
    ['box', '#26a69a', isZh() ? '看多 OB / 需求區' : 'Bullish OB'],
    ['box', '#ef5350', isZh() ? '看空 OB / 供給區' : 'Bearish OB'],
    ['box', '#409eff', isZh() ? '多方 FVG' : 'Bullish FVG'],
    ['box', '#ffa640', isZh() ? '空方 FVG' : 'Bearish FVG'],
    ['line', '#e2b13c', isZh() ? '流動性（未掃）' : 'Liquidity'],
    ['line', '#f0b429', 'CHoCH'],
    ['line', '#7f8ea3', 'BOS'],
    ['box', '#9b6dff', 'OTE 0.62–0.79'],
    ['line', '#ff6ad5', isZh() ? '掃流動性' : 'Sweep'],
  ];
  $('#legendBar').innerHTML = items
    .map(([kind, color, label]) => `<span><i class="${kind === 'box' ? 'box' : ''}" style="background:${color};${kind === 'box' ? 'opacity:.55' : ''}"></i>${label}</span>`)
    .join('') + `<span class="dim" style="margin-left:auto">${isZh() ? '滾輪縮放 · 拖曳平移 · 雙擊重設 · 移到區塊看詳情' : 'Scroll to zoom · drag to pan · double-click to reset'}</span>`;
}

function buildMtfChips() {
  const all = ['5m', '15m', '30m', '1h', '4h', '1d'];
  $('#mtfChips').innerHTML = all
    .map((i) => `<button class="chip ${state.mtfList.includes(i) ? 'on' : ''}" data-mtf="${i}">${i}</button>`)
    .join('');
  $('#mtfChips').onclick = (e) => {
    const btn = e.target.closest('[data-mtf]');
    if (!btn) return;
    const iv = btn.dataset.mtf;
    const idx = state.mtfList.indexOf(iv);
    if (idx >= 0) state.mtfList.splice(idx, 1);
    else state.mtfList.push(iv);
    state.mtfList.sort((a, b) => (TF_WEIGHT[a] ?? 1) - (TF_WEIGHT[b] ?? 1));
    btn.classList.toggle('on');
    saveState(state);
    loadMtf();
  };
}

/* ---------------------------------------------------------------- 事件綁定 */

function bindTopbar() {
  const panel = $('#symbolPanel');
  $('#symbolBtn').onclick = () => {
    panel.hidden = !panel.hidden;
    if (!panel.hidden) {
      $('#symbolSearch').value = '';
      renderSymbolList('');
      $('#symbolSearch').focus();
    }
  };
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.symbol-box')) panel.hidden = true;
  });
  $('#symbolSearch').oninput = debounce((e) => renderSymbolList(e.target.value), 120);

  $('#liveBtn').onclick = () => {
    state.live = !state.live;
    saveState(state);
    if (state.live) startStream();
    else feed.stopStream();
    renderStatus();
  };
  $('#refreshBtn').onclick = () => loadData(true);
  $('#themeBtn').onclick = () => {
    state.theme = state.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = state.theme;
    chart.setTheme(state.theme);
    saveState(state);
  };
  $('#langBtn').onclick = () => {
    state.lang = isZh() ? 'en' : 'zh';
    saveState(state);
    document.documentElement.lang = isZh() ? 'zh-Hant' : 'en';
    chart.setLang(state.lang);
    applyLang();
    buildLayerChips();
    buildQuickBar();
    syncPresetButton();
    buildLegend();
    renderAll();
  };
  // 手機：☰ 放大分析面板、⛶ 放大圖表（互斥）
  $('#panelBtn').onclick = () => {
    document.body.classList.remove('chart-full');
    document.body.classList.toggle('panel-max');
    $('#panelBtn').classList.toggle('on', document.body.classList.contains('panel-max'));
    setTimeout(() => chart.resize(), 50);
  };
}

function bindTabs() {
  $('#tabs').onclick = (e) => {
    const btn = e.target.closest('[data-tab]');
    if (!btn) return;
    $$('#tabs button').forEach((b) => b.classList.toggle('active', b === btn));
    $$('.tab-panel').forEach((p) => p.classList.toggle('active', p.dataset.panel === btn.dataset.tab));
    if (btn.dataset.tab === 'learn') renderGloss();
    if (btn.dataset.tab === 'scanner') loadMarket();
    // 切到下單頁時用最新的計畫重算委託單（數量、停損停利都會跟著變）
    if (btn.dataset.tab === 'trade') tradePanel?.renderTicket();
  };
}

function bindChartTools() {
  $('#zoomInBtn').onclick = () => chart.zoom(1 / 1.25);
  $('#zoomOutBtn').onclick = () => chart.zoom(1.25);
  $('#fitBtn').onclick = () => chart.resetView();
  $('#presetBtn').onclick = () => {
    const i = PRESET_ORDER.indexOf(state.layerPreset);
    applyPreset(PRESET_ORDER[(i + 1) % PRESET_ORDER.length]);
    toast(isZh() ? `圖層：${PRESET_LABEL[state.layerPreset].zh}` : `Layers: ${PRESET_LABEL[state.layerPreset].en}`, 'info', 1400);
  };
  $('#snapBtn').onclick = () => {
    const a = document.createElement('a');
    a.href = chart.toDataURL();
    a.download = `${state.symbol}-${state.interval}-${Date.now()}.png`;
    a.click();
    toast(isZh() ? '已匯出圖表 PNG' : 'Chart exported');
  };
  $('#chartFsBtn').onclick = () => {
    document.body.classList.remove('panel-max');
    document.body.classList.toggle('chart-full');
    $('#chartFsBtn').classList.toggle('on', document.body.classList.contains('chart-full'));
    $('#panelBtn')?.classList.remove('on');
    setTimeout(() => chart.resize(), 50);
  };
  $('#replayBtn').onclick = () => toggleReplay(!replay.active);
  $('#replayExit').onclick = () => toggleReplay(false);
  $('#replayRange').oninput = (e) => {
    replay.index = +e.target.value;
    recompute({ keepView: true });
  };
  $('#replayPrev').onclick = () => stepReplay(-1);
  $('#replayNext').onclick = () => stepReplay(1);
  $('#replaySpeed').onchange = (e) => {
    replay.speed = +e.target.value;
    if (replay.timer) { clearInterval(replay.timer); playReplay(); }
  };
  $('#replayPlay').onclick = () => {
    if (replay.timer) {
      clearInterval(replay.timer);
      replay.timer = null;
      $('#replayPlay').textContent = '▶';
    } else playReplay();
  };
}

function handleKeys(e) {
  if (e.target.matches('input, select, textarea')) return;
  if (e.key === 'ArrowRight') stepReplay(1);
  if (e.key === 'ArrowLeft') stepReplay(-1);
  if (e.key === '+' || e.key === '=') chart.zoom(1 / 1.25);
  if (e.key === '-') chart.zoom(1.25);
  if (e.key.toLowerCase() === 'r') loadData(true);
  if (e.key.toLowerCase() === 't') $('#themeBtn').click();
}

/* ------------------------------------------------------------------ 資料 */

async function loadSymbols() {
  try {
    symbols = await feed.getSymbols();
    renderSymbolList('');
  } catch (e) {
    console.warn('symbols', e);
  }
}

function setLoading(on) {
  $('#chartLoading').hidden = !on;
}

async function loadData(force = false) {
  setLoading(true);
  try {
    candles = await feed.getCandles(state.symbol, state.interval, state.candleCount, { force });
    lastUpdated = Date.now();
    replay.index = candles.length;
    $('#replayRange').max = candles.length;
    $('#replayRange').min = Math.min(80, candles.length);
    $('#replayRange').value = candles.length;
    recompute({ keepView: false });
    if (state.live && !replay.active) startStream();
    loadTicker();
    loadMtf();
  } catch (e) {
    toast((isZh() ? '資料載入失敗：' : 'Failed to load data: ') + (e?.message || e), 'error', 6000);
  } finally {
    setLoading(false);
    renderStatus();
  }
}

async function loadTicker() {
  try {
    ticker = await feed.getTicker(state.symbol, state.interval);
    renderTickerStrip();
  } catch {}
}

function startStream() {
  if (!state.live) return;
  feed.startStream(state.symbol, state.interval, (c) => {
    Feed.merge(candles, c);
    lastUpdated = Date.now();
    if (!replay.active) {
      replay.index = candles.length;
      throttledRecompute();
    }
  });
}

const throttledRecompute = throttle(() => recompute({ keepView: true }), 800);

/** 依目前（或回放）資料重新計算並渲染 */
function recompute({ keepView = true } = {}) {
  const view = replay.active ? candles.slice(0, Math.max(60, replay.index)) : candles;
  if (!view.length) return;
  analysis = analyze(view, { ...state.smc, htfBias });
  chart.setData(view, analysis, { keepView });
  renderAll();
  if (!replay.active) alerts.check(state.symbol, state.interval, analysis, state.lang);
  if (replay.active) {
    $('#replayLabel').textContent = `${replay.index}/${candles.length} · ${fmtTime(view[view.length - 1].time, { tz: state.timezone })}`;
  }
}

async function loadMtf() {
  const list = [...state.mtfList].sort((a, b) => (TF_WEIGHT[a] ?? 1) - (TF_WEIGHT[b] ?? 1));
  if (!list.length) { mtfRows = []; mtfAgg = null; htfBias = null; renderMtfPanel(); return; }
  try {
    const data = await feed.getMulti(state.symbol, list, 320);
    mtfRows = list
      .map((iv) => {
        const c = data[iv];
        if (!c?.length) return null;
        const a = analyze(c, state.smc);
        if (a.empty) return null;
        return { interval: iv, bias: a.bias, structure: a.structure, pd: a.pd, setup: a.setup, price: a.price };
      })
      .filter(Boolean);
    mtfAgg = aggregateBias(mtfRows);
    const higher = mtfRows.filter((r) => (TF_WEIGHT[r.interval] ?? 1) > (TF_WEIGHT[state.interval] ?? 1));
    htfBias = higher.length ? aggregateBias(higher) : mtfAgg;
    recompute({ keepView: true });
    renderMtfPanel();
  } catch (e) {
    console.warn('mtf', e);
  }
}

/* ---------------------------------------------------------------- 渲染 */

function renderAll() {
  renderAnalysisPanel();
  renderTickerStrip();
  renderStatus();
}

function renderAnalysisPanel() {
  if (!analysis) return;
  const risk = analysis.setup && !analysis.setup.none
    ? positionSize({
        accountSize: state.risk.account,
        riskPct: state.risk.riskPct,
        entry: analysis.setup.entry,
        stop: analysis.setup.stop,
        leverage: state.risk.leverage,
      })
    : null;
  setHTML('#panelAnalysis', [
    P.renderSetup(analysis, state.lang, risk),
    P.renderBias(analysis, mtfAgg, state.lang),
    P.renderStructure(analysis, state.lang),
    P.renderPois(analysis, state.lang),
    P.renderLiquidity(analysis, state.lang),
    P.renderKeyLevels(analysis, state.lang),
  ].join(''));
  const copyBtn = $('[data-copy-setup]');
  if (copyBtn) copyBtn.onclick = copyPlan;
}

/** 將目前計畫輸出成可貼進交易日誌的純文字 */
function copyPlan() {
  const s = analysis?.setup;
  if (!s || s.none) return;
  const L = isZh();
  const lines = [
    `${state.symbol} · ${state.interval} · ${PROVIDERS[feed.activeProvider]?.label}`,
    `${L ? '方向' : 'Direction'}: ${s.dir.toUpperCase()}  |  ${L ? '評級' : 'Grade'}: ${s.grade} (${s.score}/100)  |  R:R ${s.rrFinal.toFixed(2)}`,
    `${L ? '進場區' : 'Entry zone'}: ${fmtPrice(s.entryZone.bottom)} - ${fmtPrice(s.entryZone.top)} (${s.poi.type})`,
    `${L ? '進場' : 'Entry'}: ${fmtPrice(s.entry)}`,
    `${L ? '停損' : 'Stop'}: ${fmtPrice(s.stop)} (${s.riskPct.toFixed(2)}%)`,
    ...s.targets.map((t) => `${t.name}: ${fmtPrice(t.price)} (${t.rr.toFixed(2)}R, ${L ? t.label : t.labelEn})`),
    `${L ? '失效條件' : 'Invalidation'}: ${L ? s.invalidation : s.invalidationEn}`,
    `${L ? '匯流' : 'Confluence'}: ${s.checklist.filter((c) => c.ok).map((c) => (L ? c.zh : c.en)).join(' / ')}`,
    `${L ? '時間' : 'Time'}: ${fmtTime(Date.now(), { tz: state.timezone })} ${state.timezone}`,
  ];
  const text = lines.join('\n');
  navigator.clipboard?.writeText(text).then(
    () => toast(isZh() ? '交易計畫已複製到剪貼簿' : 'Trade plan copied'),
    () => toast(text, 'info', 8000),
  );
}

function renderMtfPanel() {
  const html = P.renderMtf(mtfRows, mtfAgg, state.lang)
    + (mtfAgg ? `<section class="card"><header class="card__head"><h3>${isZh() ? '由上而下敘事' : 'Top-down narrative'}</h3></header>
        <p class="pad" style="white-space:pre-line;line-height:1.75;font-size:11.5px">${escapeHtml(narrative(mtfRows, mtfAgg, state.lang))}</p></section>` : '');
  setHTML('#panelMtf', html || `<p class="dim pad">${isZh() ? '請於設定中選擇週期。' : 'Pick timeframes in settings.'}</p>`);
  if (mtfAgg) {
    $('#statusNarrative').textContent = narrative(mtfRows, mtfAgg, state.lang).split('\n')[0];
  }
}

function renderTickerStrip() {
  const base = state.symbol.replace('USDT', '');
  $('#symbolLabel').innerHTML = `${base}<span class="dim">/USDT</span>`;
  setHTML('#tickerStrip', P.renderTicker(ticker, analysis, state.lang, state.interval));
}

function renderStatus() {
  const p = PROVIDERS[feed.activeProvider];
  const streamMap = {
    live: [isZh() ? '即時串流' : 'Live stream', 'live'],
    polling: [isZh() ? '輪詢更新' : 'Polling', 'live'],
    closed: [isZh() ? '串流中斷' : 'Disconnected', 'err'],
    error: [isZh() ? '串流錯誤' : 'Stream error', 'err'],
    idle: [state.live ? (isZh() ? '待連線' : 'Idle') : (isZh() ? '已暫停' : 'Paused'), ''],
  };
  const [label, cls] = streamMap[feed.streamStatus] || streamMap.idle;
  $('#statusProvider').innerHTML = `<span class="status-dot ${p?.offline ? 'err' : 'live'}"></span>${p?.label || '—'} · ${state.symbol} · ${state.interval}`;
  $('#statusStream').innerHTML = `<span class="status-dot ${cls}"></span>${label}`;
  $('#statusUpdated').textContent = lastUpdated ? `${isZh() ? '更新於' : 'updated'} ${fmtAgo(lastUpdated)} ${isZh() ? '前' : 'ago'}` : '—';
  $('#liveBtn').classList.toggle('on', state.live);
}

function renderSymbolList(query) {
  const q = (query || '').trim().toUpperCase();
  const list = (symbols.length ? symbols : state.watchlist.map((s) => ({ symbol: s, price: 0, change: 0 })))
    .filter((s) => !q || s.symbol.includes(q))
    .slice(0, 60);
  $('#watchlistQuick').innerHTML = state.watchlist
    .map((s) => `<button data-sym="${s}">${s.replace('USDT', '')}</button>`).join('');
  $('#symbolList').innerHTML = list
    .map((s) => `<li data-sym="${s.symbol}">
        <span><b>${s.symbol.replace('USDT', '')}</b><span class="dim">/USDT</span></span>
        <span class="mono dim">${s.price ? fmtPrice(s.price) : ''}</span>
        <span class="mono ${s.change >= 0 ? 'up' : 'down'}">${s.change ? (s.change >= 0 ? '+' : '') + s.change.toFixed(2) + '%' : ''}</span>
        <span class="star ${state.watchlist.includes(s.symbol) ? 'on' : ''}" data-star="${s.symbol}">★</span>
      </li>`).join('');
  const pick = (e) => {
    const star = e.target.closest('[data-star]');
    if (star) {
      e.stopPropagation();
      const sym = star.dataset.star;
      const i = state.watchlist.indexOf(sym);
      if (i >= 0) state.watchlist.splice(i, 1);
      else state.watchlist.push(sym);
      saveState(state);
      renderSymbolList(query);
      return;
    }
    const li = e.target.closest('[data-sym]');
    if (!li) return;
    selectSymbol(li.dataset.sym);
  };
  $('#symbolList').onclick = pick;
  $('#watchlistQuick').onclick = pick;
}

function selectSymbol(sym) {
  state.symbol = sym;
  saveState(state);
  buildQuickBar();
  $('#symbolPanel').hidden = true;
  toggleReplay(false);
  loadData(true);
}

/* --------------------------------------------------------------- Hover tip */

function handleHover(hits, pointer) {
  const tip = $('#tip');
  if (!hits || !pointer) { tip.hidden = true; return; }
  tip.innerHTML = P.renderHoverTip(hits, state.lang);
  tip.hidden = false;
  const host = $('.chart-host').getBoundingClientRect();
  const w = tip.offsetWidth;
  const h = tip.offsetHeight;
  let x = pointer.x + 16;
  let y = pointer.y + 16;
  if (x + w > host.width) x = pointer.x - w - 16;
  if (y + h > host.height) y = Math.max(4, pointer.y - h - 16);
  tip.style.left = `${x}px`;
  tip.style.top = `${y}px`;
}

/* ------------------------------------------------------------------ 回放 */

function toggleReplay(on) {
  replay.active = on;
  $('#replayBar').hidden = !on;
  $('#replayBtn').classList.toggle('on', on);
  if (on) {
    feed.stopStream();
    replay.index = Math.max(120, Math.floor(candles.length * 0.7));
    $('#replayRange').value = replay.index;
  } else {
    clearInterval(replay.timer);
    replay.timer = null;
    $('#replayPlay').textContent = '▶';
    replay.index = candles.length;
    if (state.live) startStream();
  }
  recompute({ keepView: false });
}

function stepReplay(dir) {
  if (!replay.active) return;
  replay.index = Math.max(80, Math.min(candles.length, replay.index + dir));
  $('#replayRange').value = replay.index;
  recompute({ keepView: true });
}

function playReplay() {
  $('#replayPlay').textContent = '⏸';
  replay.timer = setInterval(() => {
    if (replay.index >= candles.length) {
      clearInterval(replay.timer);
      replay.timer = null;
      $('#replayPlay').textContent = '▶';
      return;
    }
    stepReplay(1);
  }, replay.speed);
}

/* ------------------------------------------------------------ 全市場掃描 */

let marketData = null;

async function loadMarket({ force = false } = {}) {
  const host = $('#marketResult');
  if (!host) return;
  if (marketData && !force) return renderMarketPane();
  host.innerHTML = `<p class="dim pad">${isZh() ? '載入掃描結果…' : 'Loading…'}</p>`;
  try {
    marketData = await fetchMarket();
    renderMarketPane();
  } catch (e) {
    host.innerHTML = `<p class="dim pad">${isZh()
      ? '還沒有掃描結果。伺服器每小時會掃描一次全市場，稍後再試。'
      : 'No scan results yet — the server scans hourly.'}<br><span class="tiny">${escapeHtml(e.message)}</span></p>`;
  }
}

function renderMarketPane() {
  if (!marketData) return;
  setHTML('#marketResult', renderMarket(marketData, state.lang, {
    minScore: +$('#marketMinScore').value || 0,
    dir: $('#marketDir').value,
  }));
  $('#marketResult').onclick = (e) => {
    const row = e.target.closest('[data-symbol]');
    if (!row) return;
    const iv = row.dataset.interval;
    if (iv && iv !== state.interval) {
      state.interval = iv;
      $$('#intervalSeg button').forEach((b) => b.classList.toggle('active', b.dataset.iv === iv));
    }
    selectSymbol(row.dataset.symbol);
  };
}

function bindMarket() {
  $('#scanModeSeg').onclick = (e) => {
    const mode = e.target.dataset?.mode;
    if (!mode) return;
    $$('#scanModeSeg button').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
    $('#marketPane').hidden = mode !== 'market';
    $('#localPane').hidden = mode !== 'local';
    if (mode === 'market') loadMarket();
  };
  $('#marketRefresh').onclick = () => loadMarket({ force: true });
  $('#marketMinScore').onchange = renderMarketPane;
  $('#marketDir').onchange = renderMarketPane;
}

/* ---------------------------------------------------------------- 掃描器 */

function bindScanner() {
  $('#scanBtn').onclick = async () => {
    const scope = $('#scanScope').value;
    const minScore = +$('#scanMinScore').value || 0;
    let list = state.watchlist;
    if (scope !== 'watchlist') {
      if (!symbols.length) await loadSymbols();
      list = symbols.slice(0, scope === 'top20' ? 20 : 50).map((s) => s.symbol);
    }
    if (!list.length) return toast(isZh() ? '清單為空' : 'Empty list', 'error');
    const bar = $('#scanProgress');
    bar.hidden = false;
    $('#scanBtn').disabled = true;
    $('#scanBtn').textContent = isZh() ? '掃描中…' : 'Scanning…';
    try {
      scanRows = await runScan(feed, {
        symbols: list,
        interval: state.interval,
        settings: state.smc,
        onProgress: ({ done, total }) => { bar.firstElementChild.style.width = `${(done / total) * 100}%`; },
      });
      const filtered = scanRows.filter((r) => !r.setup || r.setup.score >= minScore);
      setHTML('#scanResult', renderScanTable(filtered, state.lang));
      $('#scanResult').onclick = (e) => {
        const row = e.target.closest('[data-symbol]');
        if (row) selectSymbol(row.dataset.symbol);
      };
      toast(isZh() ? `掃描完成：${filtered.length} 個標的` : `Scan complete: ${filtered.length} symbols`);
    } catch (e) {
      toast((isZh() ? '掃描失敗：' : 'Scan failed: ') + e.message, 'error');
    } finally {
      bar.hidden = true;
      bar.firstElementChild.style.width = '0';
      $('#scanBtn').disabled = false;
      $('#scanBtn').textContent = isZh() ? '開始掃描' : 'Run scan';
    }
  };
}

/* ------------------------------------------------------------------ 回測 */

function bindBacktest() {
  $('#btRun').onclick = async () => {
    if (!candles.length) return;
    const bar = $('#btProgress');
    bar.hidden = false;
    $('#btRun').disabled = true;
    $('#btRun').textContent = isZh() ? '計算中…' : 'Running…';
    try {
      const { trades, stats } = await backtest(
        candles,
        {
          minScore: +$('#btMinScore').value || 55,
          horizon: +$('#btHorizon').value || 90,
          step: +$('#btStep').value || 5,
          settings: state.smc,
        },
        ({ done, total }) => { bar.firstElementChild.style.width = `${(done / total) * 100}%`; },
      );
      renderBacktest(trades, stats);
    } catch (e) {
      toast((isZh() ? '回測失敗：' : 'Backtest failed: ') + e.message, 'error');
    } finally {
      bar.hidden = true;
      bar.firstElementChild.style.width = '0';
      $('#btRun').disabled = false;
      $('#btRun').textContent = isZh() ? '執行回測' : 'Run backtest';
    }
  };
}

function renderBacktest(trades, s) {
  if (!s.count) {
    setHTML('#btResult', `<p class="dim pad">${isZh() ? '此設定下沒有產生足夠訊號，請降低最低評分或改用較長的歷史資料。' : 'No signals under these settings.'}</p>`);
    return;
  }
  const stat = (label, value, cls = '') => `<div class="stat"><span>${label}</span><b class="${cls}">${value}</b></div>`;
  const grades = s.byGrade.map((g) => `<div class="row"><span>${isZh() ? '評級' : 'Grade'} ${g.key}</span><b class="mono">${g.count} ${isZh() ? '筆' : 'trades'} · ${g.winRate.toFixed(0)}% · ${g.avgR.toFixed(2)}R</b></div>`).join('');
  const rows = trades.slice(-14).reverse().map((t) => `<tr>
      <td>${fmtTime(t.time, { tz: state.timezone }).slice(5, 16)}</td>
      <td class="${t.dir === 'long' ? 'up' : 'down'}">${t.dir === 'long' ? 'L' : 'S'}</td>
      <td class="mono">${fmtPrice(t.entry)}</td>
      <td class="mono ${t.r > 0 ? 'up' : 'down'}">${t.r.toFixed(2)}R</td>
      <td class="tiny dim">${t.outcome}</td></tr>`).join('');
  setHTML('#btResult', `
    <div class="stat-grid">
      ${stat(isZh() ? '訊號數' : 'Signals', s.count)}
      ${stat(isZh() ? '勝率' : 'Win rate', s.winRate.toFixed(1) + '%', s.winRate >= 50 ? 'up' : 'down')}
      ${stat(isZh() ? '期望值' : 'Expectancy', s.expectancy.toFixed(2) + 'R', s.expectancy > 0 ? 'up' : 'down')}
      ${stat(isZh() ? '總 R' : 'Total R', s.totalR.toFixed(1), s.totalR > 0 ? 'up' : 'down')}
      ${stat(isZh() ? '獲利因子' : 'Profit factor', isFinite(s.profitFactor) ? s.profitFactor.toFixed(2) : '∞')}
      ${stat(isZh() ? '最大回撤' : 'Max DD', s.maxDrawdownR.toFixed(1) + 'R', 'down')}
      ${stat(isZh() ? '平均獲利' : 'Avg win', s.avgWin.toFixed(2) + 'R', 'up')}
      ${stat(isZh() ? '平均虧損' : 'Avg loss', s.avgLoss.toFixed(2) + 'R', 'down')}
      ${stat(isZh() ? '最長連敗' : 'Max streak', s.maxLossStreak)}
    </div>
    <canvas class="equity" id="equityCurve"></canvas>
    <div class="card"><header class="card__head"><h3>${isZh() ? '分級表現' : 'By grade'}</h3></header><div class="rows rows--tight">${grades}</div></div>
    <table class="table table--compact"><thead><tr><th>${isZh() ? '時間' : 'Time'}</th><th></th><th>${isZh() ? '進場' : 'Entry'}</th><th>R</th><th>${isZh() ? '結果' : 'Result'}</th></tr></thead><tbody>${rows}</tbody></table>
    <p class="hint">${isZh() ? '註：同一根 K 棒同時觸及停損與目標時，保守假設為停損；未計手續費與滑價。' : 'Note: stop assumed first when both are hit in one bar; fees and slippage excluded.'}</p>`);
  drawEquity(s.curve);
}

function drawEquity(curve) {
  const cv = $('#equityCurve');
  if (!cv || !curve.length) return;
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth || 300;
  const h = 90;
  cv.width = w * dpr;
  cv.height = h * dpr;
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const vals = curve.map((c) => c.equity);
  const min = Math.min(0, ...vals);
  const max = Math.max(0, ...vals);
  const span = max - min || 1;
  const x = (i) => (i / Math.max(1, curve.length - 1)) * (w - 4) + 2;
  const y = (v) => h - 6 - ((v - min) / span) * (h - 12);
  const css = getComputedStyle(document.documentElement);
  ctx.strokeStyle = css.getPropertyValue('--border').trim();
  ctx.beginPath();
  ctx.moveTo(0, y(0));
  ctx.lineTo(w, y(0));
  ctx.stroke();
  ctx.beginPath();
  curve.forEach((c, i) => (i ? ctx.lineTo(x(i), y(c.equity)) : ctx.moveTo(x(i), y(c.equity))));
  ctx.strokeStyle = vals[vals.length - 1] >= 0 ? css.getPropertyValue('--up').trim() : css.getPropertyValue('--down').trim();
  ctx.lineWidth = 1.6;
  ctx.stroke();
  ctx.lineTo(x(curve.length - 1), y(0));
  ctx.lineTo(x(0), y(0));
  ctx.closePath();
  ctx.fillStyle = (vals[vals.length - 1] >= 0 ? 'rgba(38,166,154,' : 'rgba(239,83,80,') + '0.12)';
  ctx.fill();
}

/* ------------------------------------------------------------------ 風險 */

function bindRisk() {
  const sync = () => {
    state.risk.account = +$('#riskAccount').value || 0;
    state.risk.riskPct = +$('#riskPct').value || 1;
    state.risk.leverage = +$('#riskLev').value || 1;
    saveState(state);
  };
  $('#riskAccount').value = state.risk.account;
  $('#riskPct').value = state.risk.riskPct;
  $('#riskLev').value = state.risk.leverage;
  ['#riskAccount', '#riskPct', '#riskLev'].forEach((id) => ($(id).onchange = () => { sync(); renderAnalysisPanel(); }));

  $('#riskFromSetup').onclick = () => {
    const s = analysis?.setup?.none ? null : analysis?.setup;
    if (!s) return toast(isZh() ? '目前沒有計畫可帶入' : 'No active plan', 'error');
    $('#riskEntry').value = s.entry.toFixed(6);
    $('#riskStop').value = s.stop.toFixed(6);
    $('#riskTarget').value = (s.targets[0]?.price ?? '').toString().slice(0, 12);
    $('#riskCalc').click();
  };
  $('#riskCalc').onclick = () => {
    sync();
    const entry = +$('#riskEntry').value;
    const stop = +$('#riskStop').value;
    const target = +$('#riskTarget').value;
    const pos = positionSize({ accountSize: state.risk.account, riskPct: state.risk.riskPct, entry, stop, leverage: state.risk.leverage });
    if (!pos) return toast(isZh() ? '請輸入有效的進場與停損價' : 'Enter valid entry & stop', 'error');
    const rr = target ? Math.abs(target - entry) / Math.abs(entry - stop) : null;
    setHTML('#riskResult', `<div class="card"><header class="card__head"><h3>${isZh() ? '計算結果' : 'Result'}</h3>
      ${rr ? `<span class="pill ${rr >= 2 ? 'pill--up' : 'pill--warn'}">${rr.toFixed(2)}R</span>` : ''}</header>
      <div class="rows">
        <div class="row"><span>${isZh() ? '風險金額' : 'Risk amount'}</span><b class="mono">${fmtNum(pos.riskAmount)} USDT</b></div>
        <div class="row"><span>${isZh() ? '每單位風險' : 'Risk per unit'}</span><b class="mono">${fmtNum(Math.abs(entry - stop), 6)}</b></div>
        <div class="row"><span>${isZh() ? '部位大小' : 'Position size'}</span><b class="mono">${fmtNum(pos.qty, 5)}</b></div>
        <div class="row"><span>${isZh() ? '名目價值' : 'Notional'}</span><b class="mono">${fmtNum(pos.notional)} USDT</b></div>
        <div class="row"><span>${isZh() ? '所需保證金' : 'Margin'}</span><b class="mono">${fmtNum(pos.marginRequired)} USDT</b></div>
        <div class="row"><span>${isZh() ? '實際槓桿' : 'Effective leverage'}</span><b class="mono">${pos.leverageUsed.toFixed(2)}×</b></div>
        ${target ? `<div class="row"><span>${isZh() ? '目標獲利' : 'Target profit'}</span><b class="mono up">${fmtNum(pos.qty * Math.abs(target - entry))} USDT</b></div>` : ''}
      </div>
      ${pos.liquidationWarning ? `<p class="invalid">⚠ ${isZh() ? '所需保證金超過帳戶權益，請降低風險或提高槓桿。' : 'Margin exceeds account equity.'}</p>` : ''}
    </div>`);
  };
}

/* ------------------------------------------------------------------ 警報 */

let tradePanel = null;

function bindTrade() {
  tradePanel = createTradePanel({
    lang: () => state.lang,
    getSymbol: () => state.symbol,
    getRisk: () => state.risk,
    getPlan: () => {
      const s = analysis?.setup;
      return !s || s.none ? null : s;
    },
  });
  tradePanel.render();
}

function bindAlerts() {
  alerts.requestPermission();
  const refresh = () => {
    setHTML('#alertList', renderAlerts(state.alerts, state.lang));
    $('#alertList').onclick = (e) => {
      const id = e.target.closest('[data-del-alert]')?.dataset.delAlert;
      if (!id) return;
      state.alerts = state.alerts.filter((a) => a.id !== id);
      saveState(state);
      refresh();
    };
  };
  $('#alertType').onchange = (e) => { $('#alertLevelRow').hidden = e.target.value !== 'price'; };
  $('#alertAdd').onclick = () => {
    const type = $('#alertType').value;
    const level = $('#alertLevel').value;
    if (type === 'price' && !level) return toast(isZh() ? '請輸入價位' : 'Enter a level', 'error');
    state.alerts.push(createAlert({ symbol: state.symbol, interval: state.interval, type, level, note: $('#alertNote').value }));
    saveState(state);
    $('#alertNote').value = '';
    refresh();
    toast(isZh() ? '已建立警報' : 'Alert created');
  };
  refresh();
}

/* ------------------------------------------------------------------ 教學 */

function renderGloss() {
  setHTML('#glossBody', renderGlossary(state.lang, $('#glossSearch').value));
}
function bindGlossary() {
  $('#glossSearch').oninput = debounce(renderGloss, 150);
  renderGloss();
}

/* ------------------------------------------------------------------ 設定 */

function bindSettings() {
  $('#setProvider').value = state.provider;
  $('#setCandles').value = state.candleCount;
  $('#setTz').value = state.timezone;
  $('#setBreakBy').value = state.smc.breakBy;
  $('#setObMode').value = state.smc.obZoneMode;
  $('#setInternal').value = state.smc.internalStrength;
  $('#setSwing').value = state.smc.swingStrength;
  $('#setDisp').value = state.smc.minDisplacementAtr;
  $('#setFvg').value = state.smc.fvgMinAtr;
  $('#setTol').value = state.smc.liquidityTolAtr;
  $('#setRR').value = state.smc.minRR;
  $('#setBuf').value = state.smc.riskBufferAtr;
  syncSettingLabels();

  $('#setProvider').onchange = (e) => {
    state.provider = e.target.value;
    feed.activeProvider = e.target.value;
    saveState(state);
    symbols = [];
    loadSymbols();
    loadData(true);
  };
  $('#setCandles').onchange = (e) => { state.candleCount = Math.max(150, Math.min(1000, +e.target.value || 500)); saveState(state); loadData(true); };
  $('#setTz').onchange = (e) => { state.timezone = e.target.value; chart.setTimezone(e.target.value); saveState(state); };

  const smcBind = (sel, key, parse = Number) => {
    $(sel).oninput = (e) => {
      state.smc[key] = parse(e.target.value);
      syncSettingLabels();
      saveState(state);
      debouncedRecompute();
    };
  };
  smcBind('#setInternal', 'internalStrength');
  smcBind('#setSwing', 'swingStrength');
  smcBind('#setDisp', 'minDisplacementAtr');
  smcBind('#setFvg', 'fvgMinAtr');
  smcBind('#setTol', 'liquidityTolAtr');
  smcBind('#setRR', 'minRR');
  smcBind('#setBuf', 'riskBufferAtr');
  $('#setBreakBy').onchange = (e) => { state.smc.breakBy = e.target.value; saveState(state); recompute({ keepView: true }); };
  $('#setObMode').onchange = (e) => { state.smc.obZoneMode = e.target.value; saveState(state); recompute({ keepView: true }); };

  $('#exportBtn').onclick = () => {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'smc-terminal-settings.json';
    a.click();
  };
  $('#resetBtn').onclick = () => {
    if (!confirm(isZh() ? '確定回復所有預設值？' : 'Reset all settings?')) return;
    Object.assign(state, resetState());
    saveState(state);
    location.reload();
  };
}

const debouncedRecompute = debounce(() => { recompute({ keepView: true }); loadMtf(); }, 250);

function syncSettingLabels() {
  $('#valInternal').textContent = state.smc.internalStrength;
  $('#valSwing').textContent = state.smc.swingStrength;
  $('#valDisp').textContent = Number(state.smc.minDisplacementAtr).toFixed(1);
  $('#valFvg').textContent = Number(state.smc.fvgMinAtr).toFixed(2);
  $('#valTol').textContent = Number(state.smc.liquidityTolAtr).toFixed(2);
  $('#valRR').textContent = Number(state.smc.minRR).toFixed(2);
  $('#valBuf').textContent = Number(state.smc.riskBufferAtr).toFixed(2);
}

/* ------------------------------------------------------------------ 語言 */

function applyLang() {
  const tabs = T[state.lang].tabs;
  tradePanel?.render();
  $$('#tabs button').forEach((b) => { const label = tabs[b.dataset.tab]; if (label) b.textContent = label; });
  $('#symbolSearch').placeholder = isZh() ? '搜尋幣種… (BTC, ETH, SOL)' : 'Search symbol… (BTC, ETH, SOL)';
  $('#glossSearch').placeholder = isZh() ? '搜尋術語… OB / FVG / CHoCH' : 'Search terms… OB / FVG / CHoCH';
  $('#scanBtn').textContent = isZh() ? '開始掃描' : 'Run scan';
  $('#btRun').textContent = isZh() ? '執行回測' : 'Run backtest';
  $('#alertAdd').textContent = isZh() ? '建立警報' : 'Create alert';
  $('#riskCalc').textContent = isZh() ? '計算' : 'Calculate';
  $('#riskFromSetup').textContent = isZh() ? '帶入目前計畫' : 'Use current plan';
  $('#replayExit').textContent = isZh() ? '離開回放' : 'Exit replay';
  $('#exportBtn').textContent = isZh() ? '匯出設定' : 'Export settings';
  $('#resetBtn').textContent = isZh() ? '回復預設' : 'Reset';
  const dict = {
    appName: [isZh() ? 'SMC 加密貨幣分析終端' : 'SMC Crypto Terminal'],
    tagline: [isZh() ? 'Smart Money Concepts 專業分析工作台' : 'Smart Money Concepts workbench'],
    disclaimer: [isZh() ? '僅供教育與研究用途，不構成投資建議。' : 'Education only — not financial advice.'],
    replay: [isZh() ? '回放' : 'Replay'],
  };
  $$('[data-i18n]').forEach((n) => {
    const v = dict[n.dataset.i18n];
    if (v) n.textContent = v[0];
  });
}

/* -------------------------------------------------------------------- 啟動 */

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();

// 便於在瀏覽器主控台檢查引擎輸出
window.__SMC__ = { get analysis() { return analysis; }, get candles() { return candles; }, state, feed, analyze };
