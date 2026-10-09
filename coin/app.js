/**
 * 幣種全週期雷達：搜一個幣，15m～1w 每個週期的偏向、結構、流動性與獵取、關鍵點位、進場計畫、
 * 順勢策略狀態、合約數據一次列出來（2026-10-07 使用者要的獨立網頁）。
 * 分析邏輯全在 src/radar/coin-report.js（純函式、有測試）；這裡只負責抓資料跟畫畫面。
 */

import { PROVIDERS } from '../src/data/providers.js';
import { fetchDerivatives } from '../src/data/derivatives.js';
import { oiChangePct, annualizeFunding, fundingCountdown } from '../src/smc/derivatives.js';
import { buildCoinReport, narrativeZh, nextCloseTime, diffReports, REPORT_TFS } from '../src/radar/coin-report.js';
import { bigTradeThreshold, detectWalls, trackWalls, tradeStats, whaleVsCrowd } from '../src/radar/whales.js';
import { buildAiSnapshot, aiUserMessage } from '../src/radar/ai-context.js';
import { needFullSnapshot, validChat, chatsToPrune, agoZh } from '../src/radar/ai-history.js';
import { runMarketScan, marketSnapshot, marketUserMessage, SCAN_TOP_N, SCAN_FRESH_MS } from '../src/radar/market-scan.js';

const bybit = PROVIDERS.bybit;
const $ = (id) => document.getElementById(id);
const QUICK = ['BTC', 'ETH', 'SOL', 'XRP', 'BNB', 'DOGE', 'ADA', 'LINK', 'AVAX', 'SUI'];
const STORE = 'coin-radar:last';
const FULL_REFRESH_MS = 60_000;
const TICK_MS = 3_000;

let sym = null;
let report = null;
let livePrice = null;
let ticker = null;
let deriv = null;
let ls = null;
let fullTimer = null;
let tickTimer = null;
let loadSeq = 0;
let changes = []; // 最近幾次重算各自變了什麼 [{ time, items }]
const MODE_KEY = 'coin-radar:mode';
let mode = (() => { try { return localStorage.getItem(MODE_KEY) || 'live'; } catch { return 'live'; } })(); // live＝含盤中 K 棒、closed＝只用收盤
let rawTf = null; // 最近一次抓的各週期 K 棒（含盤中那根）
let lastLiveCalc = 0;
const LIVE_CALC_MS = 5_000;
const TFMS = { '15m': 9e5, '30m': 18e5, '1h': 36e5, '2h': 72e5, '4h': 144e5, '6h': 216e5, '1d': 864e5, '1w': 6048e5 };
let lastCalc = null;
const openTfs = new Set(['4h']);

/* 大戶動向的即時狀態（換幣時清空） */
const BOOK_MS = 5_000;
const TRADE_KEEP_MS = 60 * 60_000;
const whale = { trackers: { Bybit: new Map(), Binance: new Map() }, walls: [], trades: [], threshold: 100_000, top: null, crowd: null, sockets: [], bookTimer: null, drawTimer: null, dirty: false };

/* ───────────── 格式 ───────────── */
let decimals = 2;
const setDecimals = (p) => { decimals = p >= 1000 ? 1 : p >= 100 ? 2 : p >= 1 ? 4 : p >= 0.01 ? 5 : 8; };
const fp = (p) => (Number.isFinite(p) ? p.toFixed(decimals) : '-');
const dist = (p) => (Number.isFinite(p) && livePrice ? ((p - livePrice) / livePrice) * 100 : null);
const fd = (d) => (d == null ? '-' : `${d > 0 ? '+' : ''}${d.toFixed(Math.abs(d) < 1 ? 2 : 1)}%`);
const dcls = (d) => (d == null ? '' : d > 0 ? 'up' : d < 0 ? 'down' : '');
const tw = (ms) => {
  if (!ms) return '-';
  const d = new Date(ms + 8 * 3600e3);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getUTCMonth() + 1)}/${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
};
const BIAS = { bullish: '偏多', bearish: '偏空', neutral: '中性' };
const TREND = { bullish: '多頭', bearish: '空頭', ranging: '盤整' };
const DIRZ = { long: '做多', short: '做空', bull: '多', bear: '空' };
const POI_ZH = { 'Order Block': 'OB', Breaker: 'Breaker', FVG: 'FVG', 'Inversion FVG': '反轉 FVG', 'Volume Imbalance': '量能缺口' };
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fu = (n) => (!Number.isFinite(n) ? '-' : n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(0)}K` : n.toFixed(0));
const left = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  if (h >= 24) return `${Math.floor(h / 24)}天${h % 24}時`;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}` : `${m}:${String(ss).padStart(2, '0')}`;
};
const ago = (ms) => { const s = Math.max(0, Math.round((Date.now() - ms) / 1000)); return s < 60 ? `${s} 秒` : s < 3600 ? `${Math.floor(s / 60)} 分` : `${Math.floor(s / 3600)} 小時`; };
const biasCls = (score) => (score > 10 ? 'bullish' : score < -10 ? 'bearish' : 'neutral');

/* ───────────── 資料 ───────────── */
async function fetchLsRatio(symbol) {
  try {
    const r = await fetch(`https://api.bybit.com/v5/market/account-ratio?category=linear&symbol=${symbol}&period=1h&limit=24`).then((x) => x.json());
    if (r.retCode !== 0) return null;
    return r.result.list.map((x) => ({ time: Number(x.timestamp), buy: Number(x.buyRatio), sell: Number(x.sellRatio) })).sort((a, b) => a.time - b.time);
  } catch { return null; }
}

async function loadAll(symbol, { quiet = false } = {}) {
  const seq = ++loadSeq;
  if (!quiet) {
    $('out').innerHTML = `<p class="loading">正在抓 ${esc(symbol)} 的 15m～週線資料並分析…</p>`;
    $('head').hidden = true;
  }
  $('status').textContent = '更新中…';
  try {
    const [raw, tk, dv, lr] = await Promise.all([
      Promise.all(REPORT_TFS.map((tf) => bybit.fetchKlines(symbol, tf, { limit: 500 }))),
      bybit.fetchTicker(symbol),
      fetchDerivatives(symbol, { limit: 25, period: '1h' }).catch(() => null),
      fetchLsRatio(symbol),
    ]);
    if (seq !== loadSeq) return;
    const closed = {};
    REPORT_TFS.forEach((tf, k) => { closed[tf] = raw[k].slice(0, -1); });
    if (!(closed['1h']?.length > 100)) throw new Error('這個幣的 K 棒太少（可能剛上線），沒辦法分析');
    ticker = tk;
    livePrice = tk.price;
    whale.threshold = bigTradeThreshold(symbol, tk.quoteVolume);
    if (quiet) loadWhaleRatios(symbol);
    deriv = dv;
    ls = lr;
    setDecimals(livePrice);
    rawTf = Object.fromEntries(REPORT_TFS.map((tf, k) => [tf, raw[k]]));
    computeReport(symbol);
    if (quiet && $('summary')) { renderHead(); rerenderAnalysis(); renderDeriv(); } else render();
    setStatus();
  } catch (e) {
    if (seq !== loadSeq) return;
    if (quiet && report) { $('status').textContent = `更新失敗（${e.message || e}），稍後自動重試`; return; }
    $('out').innerHTML = `<p class="err">${esc(symbol)}：${esc(e.message || e)}。確認是 Bybit 上有的 USDT 永續合約（例如 BTCUSDT）。</p>`;
    $('status').textContent = '';
  }
}

/** 盤中那根用最新價格補上（換到下一根了就新開一根），給即時模式用 */
function withLivePrice(tf, list, price, now = Date.now()) {
  const ms = TFMS[tf];
  const xs = list.slice();
  const last = xs[xs.length - 1];
  if (!last || !Number.isFinite(price)) return xs;
  if (now >= last.time + ms) {
    const t = Math.floor(now / ms) * ms;
    xs.push({ time: t, open: last.close, high: Math.max(last.close, price), low: Math.min(last.close, price), close: price, volume: 0 });
  } else {
    xs[xs.length - 1] = { ...last, high: Math.max(last.high, price), low: Math.min(last.low, price), close: price };
  }
  return xs;
}

/** 用目前的 K 棒（依模式含不含盤中那根）重算報告，跟上一次比出變化 */
function computeReport(symbol) {
  if (!rawTf) return;
  const now = Date.now();
  const use = {};
  for (const tf of REPORT_TFS) use[tf] = mode === 'live' ? withLivePrice(tf, rawTf[tf], livePrice, now) : rawTf[tf].slice(0, -1);
  const daily = withLivePrice('1d', rawTf['1d'], livePrice, now);
  const prevReport = report && report.symbol === symbol && report.mode === mode ? report : null;
  const next = buildCoinReport(use, { daily, h1: rawTf['1h'].slice(0, -1), price: livePrice, derivatives: deriv, lsRatio: ls });
  if (next.empty) throw new Error('資料不夠，沒辦法分析');
  next.symbol = symbol;
  next.mode = mode;
  report = next;
  lastCalc = now;
  if (prevReport) {
    const items = diffReports(prevReport, report);
    if (items.length) changes = [{ time: lastCalc, items }, ...changes].slice(0, 12);
  }
}

function setStatus() {
  $('status').textContent = mode === 'live'
    ? `即時模式：含盤中 K 棒，每 5 秒重算（${tw(lastCalc ?? Date.now())}）`
    : `收盤確認模式：只用收盤 K 棒，每分鐘重算（${tw(lastCalc ?? Date.now())}）`;
}

/** 即時模式下只重畫會變的區塊，不整頁重建（避免捲動位置跳掉） */
function rerenderAnalysis() {
  renderSummary();
  renderBest();
  renderLadder();
  renderSweeps();
  renderMatrix();
  renderTfs();
}

function setMode(next) {
  mode = next;
  try { localStorage.setItem(MODE_KEY, mode); } catch { /* 無痕模式 */ }
  renderModeSwitch();
  if (!sym || !rawTf) return;
  changes = [];
  report = null;
  computeReport(sym);
  render();
  setStatus();
}

function renderModeSwitch() {
  for (const [id, m] of [['mode-live', 'live'], ['mode-closed', 'closed']]) $(id)?.setAttribute('aria-pressed', String(mode === m));
}

async function tick() {
  if (!sym || !report) return;
  try {
    const tk = await bybit.fetchTicker(sym);
    ticker = tk;
    livePrice = tk.price;
    renderHead();
    if (mode === 'live' && rawTf && Date.now() - lastLiveCalc >= LIVE_CALC_MS) {
      lastLiveCalc = Date.now();
      computeReport(sym);
      rerenderAnalysis();
      setStatus();
    } else {
      renderSummary();
      renderLadder();
      renderBest();
    }
  } catch { /* 下一次再試 */ }
}

/* ───────────── 大戶動向資料 ───────────── */
const getJson = (url) => fetch(url).then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); });

function pushTrades(list) {
  if (!list.length) return;
  whale.trades.push(...list);
  const cut = Date.now() - TRADE_KEEP_MS;
  if (whale.trades.length > 30_000 || whale.trades[0]?.time < cut) whale.trades = whale.trades.filter((t) => t.time >= cut).slice(-30_000);
  whale.dirty = true;
}

async function loadTradeHistory(symbol) {
  const [by, bn] = await Promise.all([
    getJson(`https://api.bybit.com/v5/market/recent-trade?category=linear&symbol=${symbol}&limit=1000`)
      .then((r) => r.result.list.map((x) => ({ time: Number(x.time), price: Number(x.price), qty: Number(x.size), side: x.side === 'Buy' ? 'buy' : 'sell', ex: 'Bybit' }))).catch(() => []),
    getJson(`https://fapi.binance.com/fapi/v1/aggTrades?symbol=${symbol}&limit=1000`)
      .then((r) => r.map((x) => ({ time: Number(x.T), price: Number(x.p), qty: Number(x.q), side: x.m ? 'sell' : 'buy', ex: 'Binance' }))).catch(() => []),
  ]);
  if (symbol !== sym) return;
  pushTrades([...by, ...bn]);
}

function openTradeStreams(symbol) {
  try {
    const ws = new WebSocket('wss://stream.bybit.com/v5/public/linear');
    ws.onopen = () => ws.send(JSON.stringify({ op: 'subscribe', args: [`publicTrade.${symbol}`] }));
    ws.onmessage = (ev) => {
      const d = JSON.parse(ev.data);
      if (!d.topic?.startsWith('publicTrade') || !Array.isArray(d.data)) return;
      pushTrades(d.data.map((x) => ({ time: Number(x.T), price: Number(x.p), qty: Number(x.v), side: x.S === 'Buy' ? 'buy' : 'sell', ex: 'Bybit' })));
    };
    // Bybit 公開頻道 20 秒沒心跳會斷
    const ping = setInterval(() => { if (ws.readyState === 1) ws.send('{"op":"ping"}'); }, 18_000);
    ws.onclose = () => clearInterval(ping);
    whale.sockets.push(ws);
  } catch { /* 連不上就只用歷史成交 */ }
  try {
    const ws = new WebSocket(`wss://fstream.binance.com/ws/${symbol.toLowerCase()}@aggTrade`);
    ws.onmessage = (ev) => {
      const x = JSON.parse(ev.data);
      if (x.e !== 'aggTrade') return;
      pushTrades([{ time: Number(x.T), price: Number(x.p), qty: Number(x.q), side: x.m ? 'sell' : 'buy', ex: 'Binance' }]);
    };
    whale.sockets.push(ws);
  } catch { /* 同上 */ }
}

async function pollBooks() {
  const symbol = sym;
  if (!symbol || !livePrice) return;
  const [by, bn] = await Promise.all([
    getJson(`https://api.bybit.com/v5/market/orderbook?category=linear&symbol=${symbol}&limit=500`).then((r) => ({ bids: r.result.b, asks: r.result.a })).catch(() => null),
    getJson(`https://fapi.binance.com/fapi/v1/depth?symbol=${symbol}&limit=1000`).then((r) => ({ bids: r.bids, asks: r.asks })).catch(() => null),
  ]);
  if (symbol !== sym) return;
  const now = Date.now();
  const walls = [];
  for (const [ex, book] of [['Bybit', by], ['Binance', bn]]) {
    if (!book) continue;
    const found = detectWalls(book, livePrice, { binPct: 0.05, ratio: 5, minNotional: whale.threshold, maxPerSide: 5 }).map((w) => ({ ...w, ex }));
    walls.push(...trackWalls(whale.trackers[ex], found, now));
  }
  whale.walls = walls;
  whale.booksOk = { Bybit: !!by, Binance: !!bn };
  whale.dirty = true;
}

async function loadWhaleRatios(symbol) {
  const conv = (r) => (Array.isArray(r) ? r.map((x) => ({ time: Number(x.timestamp), long: Number(x.longAccount), short: Number(x.shortAccount) })).sort((a, b) => a.time - b.time) : null);
  const [top, crowd] = await Promise.all([
    getJson(`https://fapi.binance.com/futures/data/topLongShortPositionRatio?symbol=${symbol}&period=5m&limit=48`).then(conv).catch(() => null),
    getJson(`https://fapi.binance.com/futures/data/globalLongShortAccountRatio?symbol=${symbol}&period=5m&limit=48`).then(conv).catch(() => null),
  ]);
  if (symbol !== sym) return;
  whale.top = top;
  whale.crowd = crowd;
  whale.dirty = true;
}

function resetWhales(symbol) {
  for (const ws of whale.sockets) { try { ws.close(); } catch { /* 已經關了 */ } }
  clearInterval(whale.bookTimer);
  clearInterval(whale.drawTimer);
  Object.assign(whale, { trackers: { Bybit: new Map(), Binance: new Map() }, walls: [], trades: [], top: null, crowd: null, sockets: [], dirty: false });
  loadTradeHistory(symbol);
  openTradeStreams(symbol);
  loadWhaleRatios(symbol);
  whale.bookTimer = setInterval(pollBooks, BOOK_MS);
  whale.drawTimer = setInterval(() => { if (whale.dirty && report) { whale.dirty = false; renderWhales(); renderLadder(); } }, 2_000);
}

function start(symbol) {
  symbol = symbol.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!symbol) return;
  if (!/USDT$/.test(symbol)) symbol += 'USDT';
  sym = symbol;
  try { localStorage.setItem(STORE, symbol); } catch { /* 無痕模式 */ }
  history.replaceState(null, '', `?s=${symbol}`);
  $('q').value = symbol.replace(/USDT$/, '');
  clearInterval(fullTimer);
  clearInterval(tickTimer);
  resetWhales(symbol);
  if (!$('ai-panel').hidden) aiOpen();
  report = null;
  rawTf = null;
  changes = [];
  loadAll(symbol);
  fullTimer = setInterval(() => loadAll(symbol, { quiet: true }), FULL_REFRESH_MS);
  tickTimer = setInterval(tick, TICK_MS);
}

/* ───────────── 畫面 ───────────── */
function render() {
  $('out').innerHTML = `
    <div class="grid2">
      <section class="card" id="summary"></section>
      <section class="card" id="best"></section>
    </div>
    <div class="grid2">
      <section class="card"><h2>價格地圖：上下方的關鍵價位（由近到遠，紫色是現價）</h2><div class="ladder" id="ladder"></div></section>
      <div style="display:grid;gap:16px;align-content:start;min-width:0">
        <section class="card" id="sweeps"></section>
        <section class="card" id="deriv"></section>
      </div>
    </div>
    <section class="card" id="whales"></section>
    <section class="card"><h2>各週期一覽</h2><div class="scroll" id="matrix"></div></section>
    <section style="display:grid;gap:10px" id="tfs"></section>`;
  renderHead();
  renderSummary();
  renderBest();
  renderLadder();
  renderSweeps();
  renderDeriv();
  renderWhales();
  renderMatrix();
  renderTfs();
}

function renderHead() {
  $('head').hidden = false;
  $('symName').textContent = `${sym.replace(/USDT$/, '')}／USDT 永續`;
  $('price').textContent = fp(livePrice);
  if (ticker) {
    $('chg').innerHTML = `<span class="${dcls(ticker.change)}">${fd(ticker.change)}</span>`;
    $('hl').textContent = `${fp(ticker.high)}／${fp(ticker.low)}`;
  }
  if (deriv && Number.isFinite(deriv.fundingRate)) {
    const fr = deriv.fundingRate * 100;
    $('fund').innerHTML = `<span class="${fr > 0.03 ? 'down' : fr < -0.01 ? 'up' : ''}">${fr.toFixed(4)}%</span>`;
    const oc = oiChangePct(deriv.oiSeries ?? []);
    $('oi').innerHTML = oc == null ? '-' : `<span class="${dcls(oc)}">${fd(oc)}</span>`;
  }
  if (ls?.length) {
    const r = ls[ls.length - 1];
    $('ls').innerHTML = `<span class="up">${(r.buy * 100).toFixed(0)}%</span>／<span class="down">${(r.sell * 100).toFixed(0)}%</span>`;
  }
  $('tv').href = `https://www.tradingview.com/chart/?symbol=BYBIT:${sym}.P`;
}

/** 總結文字用即時價格重寫（距離％跟下面卡片一致） */
function liveNarrative() {
  return narrativeZh({ agg: report.agg, htf: report.htf, reports: report.tfs, best: report.best, conflicts: report.conflicts, liqAbove: report.liqAbove, liqBelow: report.liqBelow, price: livePrice, derivatives: deriv, lsRatio: ls });
}

function renderSummary() {
  if (!$('summary')) return;
  const a = report.agg;
  $('summary').innerHTML = `
    <h2>多空總結（15m～週線，越大的週期權重越高）</h2>
    <div class="verdict">
      <span class="badge ${a.label}">${a.labelZh}</span>
      <span class="num">分數 ${a.score > 0 ? '+' : ''}${a.score}／方向一致 ${a.alignment}%（多 ${a.bulls}、空 ${a.bears}、中性 ${a.neutrals}）</span>
    </div>
    <div class="chips">${report.tfs.map((t) => `<span class="chip ${biasCls(t.bias.score)}" title="下一根 K 棒收盤後這個週期才會重算">${t.interval} ${BIAS[biasCls(t.bias.score)]} <span class="num">${t.bias.score > 0 ? '+' : ''}${t.bias.score}</span> <span class="num muted">⏱${left(nextCloseTime(t.interval) - Date.now())}</span></span>`).join('')}</div>
    <p class="note" style="margin:6px 0 0">${mode === 'live'
      ? '即時模式：含盤中那根 K 棒，每 5 秒重算。⏱＝那根還有多久收盤，收盤前看到的訊號都還沒確認，可能會變回去。'
      : '收盤確認模式：只用收盤的 K 棒（跟 Discord、TV 一樣），⏱ 走完那個週期才會變。'}</p>
    <ul class="narr">${liveNarrative().map((s) => `<li class="${s.startsWith('⚠') ? 'warn' : ''}">${esc(s)}</li>`).join('')}</ul>
    <div class="sec" style="margin-top:12px"><h3>最近變化（${mode === 'live' ? '每 5 秒' : '每分鐘'}重算一次，有變才列）</h3>${changes.length
      ? `<ul>${changes.map((c) => `<li><span class="num muted">${tw(c.time).slice(6)}</span> ${c.items.map((i) => `<span class="tag ${i.kind === 'best' || i.kind === 'conflict' ? 'liq' : i.kind === 'sweep' ? 'key' : ''}">${esc(i.zh)}</span>`).join(' ')}</li>`).join('')}</ul>`
      : `<p class="muted" style="margin:0">打開之後還沒有變化。上次重算 ${lastCalc ? tw(lastCalc).slice(6) : '-'}；${mode === 'live' ? '價格一動、計畫或偏向有變就會列在這裡' : `最快會變的是 15m，還有 ${left(nextCloseTime('15m') - Date.now())}`}。</p>`}</div>`;
}

function planTable(p) {
  const rows = [
    ['進場', `${fp(p.entry)} <span class="${dcls(dist(p.entry))}">${fd(dist(p.entry))}</span>${p.entryType === 'market' ? '（已經在進場區）' : '（掛單等回踩）'}`],
    ['停損', `${fp(p.stop)} <span class="muted">（風險 ${p.riskPct}%）</span>`],
    ...p.targets.map((t) => [t.name, `${fp(t.price)} <span class="muted">${t.rr}R｜${esc(t.label ?? '')}</span> <span class="${dcls(dist(t.price))}">${fd(dist(t.price))}</span>`]),
  ];
  if (p.poi) rows.push(['進場區', `${POI_ZH[p.poi.type] ?? p.poi.type} ${fp(p.poi.bottom)}～${fp(p.poi.top)}`]);
  return `<table><tbody>${rows.map(([k, v]) => `<tr><td class="muted" style="width:72px">${k}</td><td class="num">${v}</td></tr>`).join('')}</tbody></table>`;
}

function renderBest() {
  if (!$('best')) return;
  const b = report.best;
  const others = report.plans.filter((p) => p.valid && (!b || p.tf !== b.tf)).slice(0, 5);
  $('best').innerHTML = `
    <h2>最值得看的週期</h2>
    ${b ? `<div class="plan">
      <div class="head"><span class="dir ${b.dir === 'long' ? 'up' : 'down'}">${b.tf} ${DIRZ[b.dir]}</span><span class="chip">${b.grade} 級 ${b.score} 分</span><span class="muted">最後目標 ${b.rrFinal}R</span>${b.againstHtf ? '<span class="chip bearish">逆大週期，只當短線</span>' : report.htf?.dir ? '<span class="chip bullish">跟日線／週線同方向</span>' : ''}</div>
      ${report.conflicts.filter((c) => b.entry >= c.low * 0.99 && b.entry <= c.high * 1.01).map((c) => `<p class="warn" style="margin:0">⚠ 這一帶多空打架：${c.longs.join('／')} 做多、${c.shorts.join('／')} 做空。等其中一邊被收盤打破再進。</p>`).join('')}
      ${planTable(b)}
      ${b.invalidation ? `<div class="note">失效條件：${esc(b.invalidation)}</div>` : ''}
    </div>` : '<p class="muted">現在沒有任何週期有有效的進場計畫，等價格回到進場區或結構轉向。</p>'}
    ${others.length ? `<h2 style="margin-top:14px">其他有效計畫（由近到遠）</h2>
      <div class="scroll"><table class="tbl"><thead><tr><th>週期</th><th>方向</th><th class="r">進場</th><th class="r">距離</th><th class="r">停損</th><th class="r">分數</th></tr></thead><tbody>
      ${others.map((p) => `<tr><td>${p.tf}</td><td class="${p.dir === 'long' ? 'up' : 'down'}">${DIRZ[p.dir]}${p.againstHtf ? ' <span class="muted">逆大週期</span>' : ''}</td><td class="r num">${fp(p.entry)}</td><td class="r num ${dcls(dist(p.entry))}">${fd(dist(p.entry))}</td><td class="r num">${fp(p.stop)}</td><td class="r num">${p.grade} ${p.score}</td></tr>`).join('')}
      </tbody></table></div>` : ''}`;
}

/** 價格地圖：把各週期的流動性、前日／前週／前月高低、高週期 OB／FVG、成交量分布、計畫進場價、爆倉估算排成一條梯子 */
function ladderItems() {
  const items = [];
  const add = (price, cls, text) => { if (Number.isFinite(price) && price > 0) items.push({ price, cls, text }); };
  for (const x of [...report.liqAbove, ...report.liqBelow]) add(x.price, 'liq', `流動性 ${x.tfs.join('／')}${x.touches > 1 ? `（${x.touches} 次）` : ''}`);
  for (const l of report.levels) add(l.price, 'key', l.zh);
  for (const t of report.tfs) {
    if (!['1h', '4h', '1d', '1w'].includes(t.interval)) continue;
    for (const p of t.pois.slice(0, 3)) add((p.top + p.bottom) / 2, p.dir === 'bull' ? 'bull' : 'bear', `${t.interval} ${POI_ZH[p.type] ?? p.type} ${fp(p.bottom)}～${fp(p.top)}`);
    if (['4h', '1d', '1w'].includes(t.interval) && t.vp) {
      add(t.vp.poc, '', `${t.interval} 成交量 POC`);
      add(t.vp.vah, '', `${t.interval} VAH`);
      add(t.vp.val, '', `${t.interval} VAL`);
    }
    if (['1d', '1w'].includes(t.interval) && t.pd) {
      add(t.pd.high, 'key', `${t.interval} 區間高`);
      add(t.pd.low, 'key', `${t.interval} 區間低`);
      add(t.pd.eq, '', `${t.interval} 區間中線`);
    }
  }
  for (const p of report.plans.filter((x) => x.valid)) add(p.entry, 'plan', `${p.tf} ${DIRZ[p.dir]}進場（${p.grade}）`);
  for (const w of whale.walls) add(w.price, w.side === 'bid' ? 'wallb' : 'walla', `${w.side === 'bid' ? '買牆' : '賣牆'} ${w.ex} ${fu(w.notional)}${w.seenCount > 1 ? `（掛 ${ago(w.firstSeen)}）` : ''}`);
  if (report.liquidation) {
    for (const x of report.liquidation.longs) add(x.price, 'liqd', `多單爆倉區 估 ${x.strength}`);
    for (const x of report.liquidation.shorts) add(x.price, 'liqd', `空單爆倉區 估 ${x.strength}`);
  }
  return items;
}

function renderLadder() {
  if (!$('ladder')) return;
  const items = ladderItems().sort((a, b) => b.price - a.price);
  // 0.1% 以內的併成一列
  const rows = [];
  for (const it of items) {
    const last = rows[rows.length - 1];
    if (last && Math.abs((last.price - it.price) / it.price) < 0.001) last.tags.push(it);
    else rows.push({ price: it.price, tags: [it] });
  }
  const above = rows.filter((r) => r.price > livePrice).slice(-18);
  const below = rows.filter((r) => r.price <= livePrice).slice(0, 18);
  const row = (r) => `<div class="lrow"><span class="num">${fp(r.price)}</span><span class="num ${dcls(dist(r.price))}">${fd(dist(r.price))}</span><span class="tags">${r.tags.map((t) => `<span class="tag ${t.cls}">${esc(t.text)}</span>`).join('')}</span></div>`;
  $('ladder').innerHTML = above.map(row).join('')
    + `<div class="lrow now"><span class="num">${fp(livePrice)}</span><span>現價</span><span class="tags"><span class="tag">上方 ${above.length} 個／下方 ${below.length} 個價位</span></span></div>`
    + below.map(row).join('');
}

function renderSweeps() {
  const xs = report.recentSweeps;
  $('sweeps').innerHTML = `<h2>最近被獵取的流動性（各週期）</h2>
    ${xs.length ? `<div class="scroll"><table class="tbl"><thead><tr><th>時間</th><th>週期</th><th>掃哪邊</th><th class="r">價位</th><th class="r">刺穿到</th><th>意思</th></tr></thead><tbody>
    ${xs.map((s) => `<tr><td class="num">${tw(s.time)}</td><td>${s.tf}</td><td class="${s.side === 'buyside' ? 'down' : 'up'}">${s.side === 'buyside' ? '掃上方買方流動性' : '掃下方賣方流動性'}</td><td class="r num">${fp(s.level)}</td><td class="r num">${fp(s.extreme)}</td><td class="muted">${s.side === 'buyside' ? '假突破，偏空訊號' : '假跌破，偏多訊號'}</td></tr>`).join('')}
    </tbody></table></div>` : '<p class="muted">最近沒有明顯的掃流動性。</p>'}`;
}

function spark(values, { w = 240, h = 40, color = 'var(--info)' } = {}) {
  const v = values.filter(Number.isFinite);
  if (v.length < 2) return '';
  const lo = Math.min(...v), hi = Math.max(...v);
  const sx = (i) => (i / (v.length - 1)) * (w - 4) + 2;
  const sy = (x) => h - 3 - ((x - lo) / (hi - lo || 1)) * (h - 6);
  const d = v.map((x, i) => `${i ? 'L' : 'M'}${sx(i).toFixed(1)},${sy(x).toFixed(1)}`).join(' ');
  return `<svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}" preserveAspectRatio="none" role="img"><path d="${d} L${sx(v.length - 1)},${h} L2,${h} Z" fill="${color}" fill-opacity=".12"/><path d="${d}" fill="none" stroke="${color}" stroke-width="1.6"/><circle cx="${sx(v.length - 1)}" cy="${sy(v.at(-1))}" r="2.6" fill="${color}"/></svg>`;
}

function renderDeriv() {
  const parts = ['<h2>合約數據</h2>'];
  if (deriv && Number.isFinite(deriv.fundingRate)) {
    const fr = deriv.fundingRate * 100;
    const cd = fundingCountdown(deriv.nextFundingTime);
    parts.push(`<div class="sec"><h3>資金費率（${esc(deriv.provider)}）</h3><p class="num" style="margin:0">${fr.toFixed(4)}%／8h，年化 ${annualizeFunding(deriv.fundingRate)?.toFixed(1)}%${cd ? `，${esc(cd.zh)}` : ''}
      <br><span class="muted">${fr > 0.05 ? '多單付錢給空單、而且很貴：多單擠，容易往下掃' : fr > 0.01 ? '多單付錢給空單：偏多擁擠' : fr < -0.01 ? '空單付錢給多單：空單擠，容易往上軋' : '正常範圍'}</span></p></div>`);
    const oc = oiChangePct(deriv.oiSeries ?? []);
    if (deriv.oiSeries?.length > 1) {
      parts.push(`<div class="sec" style="margin-top:10px"><h3>未平倉量（近 24 小時 ${oc == null ? '' : fd(oc)}）</h3>${spark(deriv.oiSeries.map((x) => x.value))}
      <p class="note" style="margin:2px 0 0">${oc == null ? '' : oc > 3 && (ticker?.change ?? 0) > 0 ? '價漲＋未平倉增：新多單進場，趨勢有力' : oc > 3 && (ticker?.change ?? 0) < 0 ? '價跌＋未平倉增：新空單進場，空方有力' : oc < -3 && (ticker?.change ?? 0) > 0 ? '價漲＋未平倉減：空單回補推上去，持續性較弱' : oc < -3 ? '價跌＋未平倉減：多單停損／平倉，殺多' : '未平倉變化不大'}</p></div>`);
    }
  } else parts.push('<p class="muted">資金費率／未平倉量暫時抓不到。</p>');
  if (ls?.length) {
    const r = ls.at(-1);
    parts.push(`<div class="sec" style="margin-top:10px"><h3>Bybit 帳戶多空比（近 24 小時，線＝做多帳戶比例）</h3>${spark(ls.map((x) => x.buy), { color: 'var(--up)' })}
      <p class="note" style="margin:2px 0 0">現在 ${(r.buy * 100).toFixed(1)}% 帳戶做多。${r.buy > 0.6 ? '大部分人做多：主力常反向往下掃多單停損' : r.sell > 0.6 ? '大部分人做空：小心往上軋空' : '多空差不多'}</p></div>`);
  }
  const lq = report.liquidation;
  if (lq) {
    const max = Math.max(1, ...[...lq.longs, ...lq.shorts].map((x) => x.strength));
    const row = (x) => `<tr><td class="num">${fp(x.price)}</td><td class="num ${dcls(dist(x.price))}">${fd(dist(x.price))}</td><td style="width:40%"><div class="bar"><i style="width:${(x.strength / max) * 100}%;background:var(${x.side === 'long' ? '--down' : '--up'})"></i></div></td></tr>`;
    parts.push(`<div class="sec" style="margin-top:10px"><h3>爆倉密集區（估算，近 7 天）</h3>
      <table class="tbl"><tbody>
        <tr><td colspan="3" class="muted">上方：空單爆倉（價格漲上去會被強制買回，容易一路衝）</td></tr>${lq.shorts.slice().sort((a, b) => b.price - a.price).map(row).join('')}
        <tr><td colspan="3" class="muted">下方：多單爆倉（價格跌下去會被強制賣出，容易一路殺）</td></tr>${lq.longs.slice().sort((a, b) => b.price - a.price).map(row).join('')}
      </tbody></table></div>`);
  }
  $('deriv').innerHTML = parts.join('');
}

/** 大戶動向：大單牆、大額成交、大戶 vs 散戶多空比 */
function renderWhales() {
  const el = $('whales');
  if (!el) return;
  const now = Date.now();
  const st = tradeStats(whale.trades, whale.threshold, now);
  const asks = whale.walls.filter((w) => w.side === 'ask').sort((a, b) => b.price - a.price);
  const bids = whale.walls.filter((w) => w.side === 'bid').sort((a, b) => b.price - a.price);
  const wallRow = (w) => `<tr><td class="num">${fp(w.price)}</td><td class="num ${dcls(dist(w.price))}">${fd(dist(w.price))}</td><td class="num">${fu(w.notional)}</td><td class="num">${w.times}×</td><td>${w.ex}</td><td>${w.seenCount > 1 ? `${ago(w.firstSeen)}${w.seenCount >= 12 ? ' <span class="warn">撐很久</span>' : ''}` : '<span class="muted">剛出現</span>'}</td></tr>`;
  const walls = whale.walls.length || whale.booksOk
    ? `<div class="scroll"><table class="tbl"><thead><tr><th>價位</th><th>距離</th><th>金額</th><th>比附近大</th><th>交易所</th><th>掛多久</th></tr></thead><tbody>
      <tr><td colspan="6" class="muted">上方賣牆（往上會被擋、大戶可能在這裡出貨）</td></tr>${asks.map(wallRow).join('') || '<tr><td colspan="6" class="muted">沒有</td></tr>'}
      <tr><td colspan="6" class="muted">下方買牆（往下會被接、大戶可能在這裡吸貨）</td></tr>${bids.map(wallRow).join('') || '<tr><td colspan="6" class="muted">沒有</td></tr>'}
      </tbody></table></div>`
    : '<p class="muted">正在讀掛單簿…</p>';
  const winRow = (w) => {
    const net = w.bigBuy - w.bigSell;
    const tot = w.bigBuy + w.bigSell;
    return `<tr><td>近 ${w.minutes} 分</td><td class="num up">${fu(w.bigBuy)}</td><td class="num down">${fu(w.bigSell)}</td><td class="num ${dcls(net)}">${net >= 0 ? '+' : ''}${fu(Math.abs(net)).replace(/^/, net < 0 ? '-' : '')}</td><td style="width:28%"><div class="bar"><i style="width:${tot ? (w.bigBuy / tot) * 100 : 50}%;background:var(--up)"></i></div></td><td class="num muted">${w.bigCount} 筆</td></tr>`;
  };
  const w15 = st.windows[1];
  const lean = w15 && w15.bigBuy + w15.bigSell > 0 ? (w15.bigBuy > w15.bigSell * 1.5 ? '近 15 分鐘大單以買為主' : w15.bigSell > w15.bigBuy * 1.5 ? '近 15 分鐘大單以賣為主' : '近 15 分鐘大單買賣差不多') : '近 15 分鐘沒有大單';
  const big = st.big.slice(0, 15);
  const ratio = whaleVsCrowd(whale.top, whale.crowd);
  el.innerHTML = `
    <h2>大戶動向（Bybit＋Binance 永續；大單門檻 ${fu(whale.threshold)} U）</h2>
    <div class="body" style="display:grid;gap:16px;grid-template-columns:repeat(auto-fit,minmax(320px,1fr))">
      <div class="sec" style="min-width:0"><h3>大單牆（掛單簿裡特別大的單，每 5 秒更新）</h3>${walls}
        <p class="note" style="margin:6px 0 0">大單可以隨時撤掉（假掛單）。一直掛著、價格靠近也不撤的才比較可信。</p></div>
      <div class="sec" style="min-width:0"><h3>大額成交（主動吃單；${esc(lean)}）</h3>
        <div class="scroll"><table class="tbl"><thead><tr><th>期間</th><th class="r">大單買</th><th class="r">大單賣</th><th class="r">淨買</th><th></th><th class="r">筆數</th></tr></thead><tbody>${st.windows.map(winRow).join('')}</tbody></table></div>
        <h3 style="margin-top:10px">累積買賣差 CVD（全部成交，近 1 小時）</h3>${spark(st.cvd.filter((_, i, a) => i % Math.ceil(a.length / 300 || 1) === 0).map((x) => x.value), { color: (st.cvd.at(-1)?.value ?? 0) >= 0 ? 'var(--up)' : 'var(--down)' })}
        <div class="scroll" style="max-height:260px;overflow-y:auto"><table class="tbl"><thead><tr><th>時間</th><th>買／賣</th><th class="r">價格</th><th class="r">金額</th><th>交易所</th></tr></thead><tbody>
          ${big.map((t) => `<tr><td class="num">${tw(t.time).slice(6)}<span class="muted">:${String(new Date(t.time).getSeconds()).padStart(2, '0')}</span></td><td class="${t.side === 'buy' ? 'up' : 'down'}">${t.side === 'buy' ? '大單買進' : '大單賣出'}</td><td class="r num">${fp(t.price)}</td><td class="r num"><b>${fu(t.notional)}</b></td><td>${t.ex}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">最近一小時還沒有超過門檻的成交</td></tr>'}
        </tbody></table></div></div>
      <div class="sec" style="min-width:0"><h3>大戶 vs 散戶多空比（Binance，近 4 小時）</h3>${ratio ? `
        <p class="num" style="margin:0">大戶持倉：<span class="up">多 ${(ratio.top.long * 100).toFixed(1)}%</span>／<span class="down">空 ${(ratio.top.short * 100).toFixed(1)}%</span>${ratio.global ? `<br>全部帳戶：<span class="up">多 ${(ratio.global.long * 100).toFixed(1)}%</span>／<span class="down">空 ${(ratio.global.short * 100).toFixed(1)}%</span>` : ''}</p>
        <p style="margin:6px 0">${esc(ratio.zh)}</p>
        <div class="note">大戶多單比例</div>${spark(whale.top.map((x) => x.long), { color: 'var(--info)' })}
        ${whale.crowd ? `<div class="note">全部帳戶多單比例</div>${spark(whale.crowd.map((x) => x.long), { color: 'var(--muted)' })}` : ''}
        <p class="note" style="margin:6px 0 0">「大戶」是 Binance 保證金餘額前 20% 的帳戶，看的是持倉金額比例，不是人數。</p>` : '<p class="muted">Binance 沒有這個幣的大戶數據（只有 Binance 有上架的合約才有）。</p>'}</div>
    </div>`;
}

function trendCell(t) {
  if (!t) return '-';
  const st = t.supertrend === 1 ? '<span class="up">多</span>' : t.supertrend === -1 ? '<span class="down">空</span>' : '-';
  const last = Object.entries(t.last).filter(([, v]) => v).sort((a, b) => a[1].barsAgo - b[1].barsAgo)[0];
  const NAME = { breakout: '唐奇安突破', ema: 'EMA 交叉', macd: 'MACD 零軸', vol: '放量突破', st: '超級趨勢', gc: '黃金交叉' };
  return `超級趨勢 ${st}${last ? `｜最近：${NAME[last[0]]} <span class="${last[1].dir === 'long' ? 'up' : 'down'}">${DIRZ[last[1].dir]}</span>（${last[1].barsAgo} 根前）` : ''}`;
}

function renderMatrix() {
  const near = (arr) => (arr[0] ? `${fp(arr[0].price)} <span class="${dcls(dist(arr[0].price))}">${fd(dist(arr[0].price))}</span>${arr[0].touches > 1 ? ` ×${arr[0].touches}` : ''}` : '-');
  $('matrix').innerHTML = `<table class="tbl"><thead><tr><th>週期</th><th>偏向</th><th>結構（大／小）</th><th>最近結構事件</th><th>折溢價</th><th>上方流動性</th><th>下方流動性</th><th>最近獵取</th><th>SMC 計畫</th><th>順勢策略</th></tr></thead><tbody>
    ${report.tfs.map((t) => {
      const e = t.events[0];
      const s = t.liquidity.sweeps[0];
      const p = t.setup;
      return `<tr>
        <td><b>${t.interval}</b></td>
        <td class="${biasCls(t.bias.score) === 'bullish' ? 'up' : biasCls(t.bias.score) === 'bearish' ? 'down' : 'muted'} num">${BIAS[biasCls(t.bias.score)]} ${t.bias.score > 0 ? '+' : ''}${t.bias.score}</td>
        <td>${TREND[t.swingTrend] ?? t.swingTrend}／${TREND[t.internalTrend] ?? t.internalTrend}</td>
        <td>${e ? `<span class="${e.dir === 'bull' ? 'up' : 'down'}">${e.type} ${DIRZ[e.dir]}</span> <span class="muted">${e.barsAgo} 根前</span>` : '-'}</td>
        <td>${t.pd ? `${t.pd.zone === 'premium' ? '溢價' : t.pd.zone === 'discount' ? '折價' : '中間'} ${t.pd.pct}%` : '-'}</td>
        <td class="num">${near(t.liquidity.above)}</td>
        <td class="num">${near(t.liquidity.below)}</td>
        <td>${s ? `<span class="${s.side === 'buyside' ? 'down' : 'up'}">${s.side === 'buyside' ? '掃上方' : '掃下方'}</span> <span class="num">${fp(s.level)}</span> <span class="muted">${s.barsAgo} 根前</span>` : '-'}</td>
        <td>${p.none ? '<span class="muted">沒有</span>' : `<span class="${p.dir === 'long' ? 'up' : 'down'}">${DIRZ[p.dir]}</span> ${p.valid ? '' : '<span class="muted">（無效）</span>'} <span class="num">${fp(p.entry)}</span> <span class="${dcls(dist(p.entry))}">${fd(dist(p.entry))}</span> <span class="muted">${p.grade} ${p.score}</span>`}</td>
        <td>${trendCell(t.trend)}</td>
      </tr>`;
    }).join('')}</tbody></table>`;
}

function tfDetail(t) {
  const L = (arr, cls) => (arr.length ? `<ul>${arr.map((p) => `<li class="num">${fp(p.price)} <span class="${dcls(dist(p.price))}">${fd(dist(p.price))}</span>${p.touches > 1 ? ` <span class="${cls}">等${cls === 'up' ? '高' : '低'} ×${p.touches}</span>` : ''}</li>`).join('')}</ul>` : '<p class="muted">沒有</p>');
  const p = t.setup;
  const tr = t.trend;
  const NAME = { breakout: ['唐奇安 55 突破', '6h'], ema: ['EMA20／50 交叉', '6h'], macd: ['MACD 穿零軸', '6h'], vol: ['放量突破', '6h'], st: ['超級趨勢', '4h'], gc: ['黃金／死亡交叉', '6h'] };
  return `
    <div class="sec"><h3>結構</h3><ul>
      <li>大結構 ${TREND[t.swingTrend]}、小結構 ${TREND[t.internalTrend]}${t.htfBias ? `；上一層週期偏向 ${BIAS[biasCls(t.htfBias.score)]}（${t.htfBias.score}）` : ''}</li>
      ${t.events.map((e) => `<li><span class="${e.dir === 'bull' ? 'up' : 'down'}">${e.scope === 'swing' ? '大' : '小'} ${e.type} ${DIRZ[e.dir]}</span> 破 <span class="num">${fp(e.price)}</span> <span class="muted">${tw(e.time)}（${e.barsAgo} 根前）</span></li>`).join('')}
      <li>ATR ${fp(t.atr)}（${t.atrPct}%）、RSI ${t.rsi ?? '-'}</li>
    </ul></div>
    <div class="sec"><h3>上方流動性（買方停損：空單停損、突破單）</h3>${L(t.liquidity.above, 'up')}</div>
    <div class="sec"><h3>下方流動性（賣方停損：多單停損）</h3>${L(t.liquidity.below, 'down')}</div>
    <div class="sec"><h3>最近獵取</h3>${t.liquidity.sweeps.length ? `<ul>${t.liquidity.sweeps.map((s) => `<li><span class="${s.side === 'buyside' ? 'down' : 'up'}">${s.side === 'buyside' ? '掃上方' : '掃下方'}</span> <span class="num">${fp(s.level)}</span> → 刺到 <span class="num">${fp(s.extreme)}</span> <span class="muted">${tw(s.time)}，${s.barsAgo} 根前</span></li>`).join('')}</ul>` : '<p class="muted">沒有</p>'}
      ${t.liquidity.inducement ? `<p class="note" style="margin:6px 0 0">誘導價位（IDM）${fp(t.liquidity.inducement.price)}${t.liquidity.inducement.taken ? '，已被拿走' : '，還沒被拿走：價格可能先去掃它再進 OB'}</p>` : ''}</div>
    <div class="sec"><h3>關鍵區塊（還有效的 OB／FVG／Breaker）</h3>${t.pois.length ? `<ul>${t.pois.map((z) => `<li><span class="${z.dir === 'bull' ? 'up' : 'down'}">${POI_ZH[z.type] ?? z.type} ${z.dir === 'bull' ? '需求' : '供給'}</span> <span class="num">${fp(z.bottom)}～${fp(z.top)}</span> <span class="${dcls(dist((z.top + z.bottom) / 2))}">${fd(dist((z.top + z.bottom) / 2))}</span></li>`).join('')}</ul>` : '<p class="muted">沒有</p>'}</div>
    <div class="sec"><h3>區間與均線</h3><ul>
      ${t.pd ? `<li>交易區間 <span class="num">${fp(t.pd.low)}～${fp(t.pd.high)}</span>，中線 <span class="num">${fp(t.pd.eq)}</span>，現在在 ${t.pd.zone === 'premium' ? '溢價區（偏貴，適合找空）' : t.pd.zone === 'discount' ? '折價區（偏便宜，適合找多）' : '中間'}（${t.pd.pct}%）</li>` : ''}
      ${t.ote ? `<li>OTE 回撤區（${DIRZ[t.ote.dir]}）<span class="num">${fp(t.ote.bottom)}～${fp(t.ote.top)}</span>，甜蜜點 <span class="num">${fp(t.ote.sweet)}</span></li>` : ''}
      ${t.vp ? `<li>成交量分布 POC <span class="num">${fp(t.vp.poc)}</span>、VAH <span class="num">${fp(t.vp.vah)}</span>、VAL <span class="num">${fp(t.vp.val)}</span></li>` : ''}
      <li>EMA20 <span class="num">${fp(t.ema.e20)}</span>、EMA50 <span class="num">${fp(t.ema.e50)}</span>、EMA200 <span class="num">${fp(t.ema.e200)}</span></li>
    </ul></div>
    <div class="sec"><h3>SMC 進場計畫</h3>${p.none ? `<p class="muted">${esc(p.reasonZh)}</p>` : `
      <p style="margin:0 0 6px"><b class="${p.dir === 'long' ? 'up' : 'down'}">${DIRZ[p.dir]}</b>　${p.grade} 級 ${p.score} 分${p.valid ? '' : '　<span class="warn">（分數或風報比不夠，計畫無效）</span>'}</p>
      ${planTable(p)}
      <ul class="check" style="margin-top:6px">${p.checklist.map((c) => `<li class="${c.ok ? 'up' : 'muted'}">${c.ok ? '✓' : '✗'} ${esc(c.zh)}</li>`).join('')}</ul>`}</div>
    <div class="sec"><h3>6 個順勢策略（線上 Demo 只在括號內的週期下單）</h3>${tr ? `<ul>
      <li>現在：超級趨勢 ${tr.supertrend === 1 ? '<span class="up">多</span>' : '<span class="down">空</span>'}、EMA20 ${tr.emaFastAbove ? '在 EMA50 上' : '在 EMA50 下'}、價格${tr.aboveEma200 ? '在' : '不在'} EMA200 上、MACD ${tr.macdAboveZero ? '零軸上' : '零軸下'}、SMA50 在 SMA200 ${tr.sma50Above200 ? '上（黃金交叉後）' : '下（死亡交叉後）'}</li>
      <li>55 根高低點：<span class="num">${fp(tr.donchian55.high)}</span>／<span class="num">${fp(tr.donchian55.low)}</span>（收盤突破就是唐奇安訊號）</li>
      ${Object.entries(NAME).map(([k, [zh, live]]) => { const v = tr.last[k]; return `<li>${zh}（${live}）：${v ? `<span class="${v.dir === 'long' ? 'up' : 'down'}">${DIRZ[v.dir]}</span> ${tw(v.time)}，${v.barsAgo} 根前${v.barsAgo === 0 ? ' <b class="warn">剛出現</b>' : ''}` : '<span class="muted">最近 120 根沒有</span>'}</li>`; }).join('')}
    </ul>` : '<p class="muted">K 棒不夠 210 根，算不出來</p>'}</div>`;
}

function renderTfs() {
  $('tfs').innerHTML = `<h2 style="margin:6px 0 0">各週期細節（點開看）</h2>` + report.tfs.map((t) => `
    <details class="tf" data-tf="${t.interval}" ${openTfs.has(t.interval) ? 'open' : ''}>
      <summary><span class="tfname">${t.interval}</span>
        <span class="chip ${biasCls(t.bias.score)}">${BIAS[biasCls(t.bias.score)]} ${t.bias.score}</span>
        <span class="muted">${TREND[t.swingTrend]}</span>
        ${t.setup.none ? '' : `<span class="${t.setup.dir === 'long' ? 'up' : 'down'}">計畫 ${DIRZ[t.setup.dir]} ${fp(t.setup.entry)}</span>${t.setup.valid ? '' : ' <span class="muted">（無效）</span>'}`}
      </summary>
      <div class="body">${tfDetail(t)}</div>
    </details>`).join('');
  for (const d of $('tfs').querySelectorAll('details.tf')) {
    d.addEventListener('toggle', () => { if (d.open) openTfs.add(d.dataset.tf); else openTfs.delete(d.dataset.tf); });
  }
}


/* ───────────── 問 AI ───────────── */
const AI_KEY = 'coin-radar:ai';
const AI_DEFAULT_URL = 'https://smc-signals.crypto-radar-guardian-24x7.workers.dev';
// Claude Opus 5.5 價格（美元／百萬 token）：輸入 4、輸出 20、快取讀 0.2、快取寫 5；網路搜尋每次 0.01
const AI_PRICE = { in: 4, out: 20, cacheRead: 0.2, cacheWrite: 5, search: 0.01 };
const USD_TWD = 32;
const AI_QUICK_MARKET = ['現在哪幾個幣最值得做多？', '哪幾個幣最值得做空？', '有沒有剛出順勢訊號的幣？', '哪些幣多週期最一致？', '整體市場現在偏多還偏空？'];
const MARKET_KEY = 'MARKET'; // 全市場那段對話在瀏覽器裡的 key
const AI_QUICK = ['現在能做多還是做空？', '最近的進場點在哪？停損放哪？', '大戶最近在做什麼？', '各週期在打架嗎？該怎麼辦？', '最近為什麼漲／跌？（查新聞）'];
const ai = { scope: 'coin', symbol: null, messages: [], view: [], lastFullAt: 0, updated: 0, busy: false, loadP: null, cfg: (() => { try { return JSON.parse(localStorage.getItem(AI_KEY) || '{}'); } catch { return {}; } })() };

function aiSaveCfg() { try { localStorage.setItem(AI_KEY, JSON.stringify(ai.cfg)); } catch { /* 無痕模式 */ } }
const aiUrl = () => (ai.cfg.url || AI_DEFAULT_URL).replace(/\/$/, '');

/** 很陽春的 markdown：粗體、行內程式碼、標題、條列、連結，其他全部跳脫 */
function mdLite(src) {
  const inline = (t) => esc(t)
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (m, a, u) => `<a href="${u.replace(/"/g, '%22')}" target="_blank" rel="noopener">${a}</a>`);
  const out = [];
  let list = null;
  for (const raw of String(src).split('\n')) {
    const lineTxt = raw.trimEnd();
    const li = /^\s*(?:[-*•]|\d+[.)])\s+(.*)$/.exec(lineTxt);
    if (li) { (list ??= []).push(`<li>${inline(li[1])}</li>`); continue; }
    if (list) { out.push(`<ul>${list.join('')}</ul>`); list = null; }
    const h = /^#{1,4}\s+(.*)$/.exec(lineTxt);
    if (h) out.push(`<h4>${inline(h[1])}</h4>`);
    else if (lineTxt.trim()) out.push(`<div>${inline(lineTxt)}</div>`);
    else out.push('<div style="height:6px"></div>');
  }
  if (list) out.push(`<ul>${list.join('')}</ul>`);
  return out.join('');
}

function aiCost(u) {
  if (!u) return null;
  const usd = (u.input_tokens * AI_PRICE.in + u.output_tokens * AI_PRICE.out + (u.cache_read_input_tokens || 0) * AI_PRICE.cacheRead + (u.cache_creation_input_tokens || 0) * AI_PRICE.cacheWrite) / 1e6 + (u.web_search_requests || 0) * AI_PRICE.search;
  return `約 ${usd.toFixed(3)} 美元（${(usd * USD_TWD).toFixed(1)} 台幣）${u.web_search_requests ? `，上網查了 ${u.web_search_requests} 次` : ''}`;
}

function aiBubble(cls, html) {
  const el = document.createElement('div');
  el.className = `ai-msg ${cls}`;
  el.innerHTML = html;
  $('ai-log').appendChild(el);
  $('ai-log').scrollTop = $('ai-log').scrollHeight;
  return el;
}

/* 對話紀錄：每個幣一段，存在瀏覽器的 IndexedDB（關掉網頁再開還在；AI 回覆含搜尋結果，localStorage 放不下） */
const AI_DB = 'coin-radar';
const AI_STORE = 'ai-chats';
let aiDbP = null;
function aiDb() {
  aiDbP ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(AI_DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(AI_STORE, { keyPath: 'symbol' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }).catch(() => null); // 無痕模式等不能存：照樣能問，只是不會保存
  return aiDbP;
}
async function aiTx(txMode, fn) {
  const db = await aiDb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(AI_STORE, txMode);
      const req = fn(tx.objectStore(AI_STORE));
      tx.oncomplete = () => resolve(req?.result ?? null);
      tx.onerror = tx.onabort = () => resolve(null);
    } catch { resolve(null); }
  });
}
async function aiStoreSave(chat) {
  if (!chat.messages.length) { await aiTx('readwrite', (s) => s.delete(chat.symbol)); return; }
  await aiTx('readwrite', (s) => s.put(chat));
  const all = (await aiTx('readonly', (s) => s.getAll())) ?? [];
  const drop = chatsToPrune(all.map((c) => ({ symbol: c.symbol, updated: c.updated })));
  if (drop.length) await aiTx('readwrite', (s) => { drop.forEach((k) => s.delete(k)); });
}

/* 全市場掃描（在瀏覽器裡跑，10 分鐘內重問沿用同一次結果） */
const market = { scan: null, running: null };
const aiKey = () => (ai.scope === 'market' ? MARKET_KEY : sym);

async function bybitTickers() {
  const r = await fetch('https://api.bybit.com/v5/market/tickers?category=linear').then((x) => x.json());
  if (r.retCode !== 0) throw new Error(r.retMsg || 'bybit error');
  return r.result.list.map((t) => ({ symbol: t.symbol, price: +t.lastPrice, change: +t.price24hPcnt * 100, turnover: +t.turnover24h, funding: t.fundingRate === '' ? null : +t.fundingRate }));
}

function marketScan(onProgress) {
  if (market.scan && Date.now() - market.scan.time < SCAN_FRESH_MS) return Promise.resolve(market.scan);
  market.running ??= runMarketScan({
    fetchTickers: bybitTickers,
    fetchKlines: (s, tf) => bybit.fetchKlines(s, tf, { limit: 500 }),
    onProgress: (d, n, s) => market.onProgress?.(d, n, s),
    n: SCAN_TOP_N,
  }).then((scan) => { market.scan = scan; return scan; }).finally(() => { market.running = null; });
  market.onProgress = onProgress;
  return market.running;
}

/** 掃描結果泡泡：前 10 名，點了直接打開那個幣 */
function scanBubble(rows) {
  const dz = (d) => (d === 'long' ? '<span class="up">多</span>' : d === 'short' ? '<span class="down">空</span>' : '<span class="muted">中性</span>');
  const el = aiBubble('ai', `<div class="ai-meta" style="margin:0 0 6px">掃描結果前 ${rows.length} 名（機會分數只是排序，不是勝率；點幣名打開）</div>`
    + rows.map((r) => `<button type="button" class="ai-coin" data-s="${esc(r.s)}"><b>${esc(r.s.replace(/USDT$/, ''))}</b> ${dz(r.dir)} <span class="muted">${r.score}分 · 24h ${r.chg >= 0 ? '+' : ''}${r.chg}%</span></button>`).join(''));
  el.classList.add('ai-scan');
  return el;
}

function aiRender(resumed) {
  $('ai-log').innerHTML = '';
  if (ai.symbol === MARKET_KEY) aiBubble('ai', mdLite(`問的時候我會先掃一輪 **Bybit 成交額前 ${SCAN_TOP_N} 檔**（1h／4h／6h／1d／1w 的結構、順勢策略、多週期偏向、SMC 計畫），再挑出值得看的幣說明。\n掃一次約 10～30 秒，10 分鐘內再問會沿用同一次結果。這段對話也會保存；按「新對話」重新開始。`));
  else aiBubble('ai', mdLite(`我會根據這頁 **${(ai.symbol || '').replace(/USDT$/, '')}** 當下的資料回答（各週期結構、流動性、計畫、大戶動向、合約數據），需要時也會上網查新聞。\n可以直接問，或點下面的問題。每個幣的對話分開保存，關掉網頁再開還在；按「新對話」重新開始。`));
  for (const v of ai.view) {
    if (v.k === 'scan') { scanBubble(v.rows ?? []); continue; }
    const el = aiBubble(v.k, v.k === 'user' ? esc(v.text) : mdLite(v.text));
    if (v.meta) { const m = document.createElement('div'); m.className = 'ai-meta'; m.textContent = v.meta; el.appendChild(m); }
  }
  if (resumed) aiBubble('ai', `<span class="ai-status">↑ 接續 ${esc(agoZh(ai.updated))}的對話；再問會用現在的最新資料</span>`);
}

/** 切到某個幣的對話：先清空，再從瀏覽器讀回之前存的 */
function aiLoad(symbol) {
  Object.assign(ai, { symbol, messages: [], view: [], lastFullAt: 0, updated: 0 });
  aiRender(false);
  ai.loadP = aiTx('readonly', (s) => s.get(symbol)).then((chat) => {
    if (ai.symbol !== symbol || ai.messages.length || !validChat(chat) || !chat.messages.length) return;
    Object.assign(ai, { messages: chat.messages, view: chat.view, lastFullAt: chat.lastFullAt || 0, updated: chat.updated || 0 });
    aiRender(true);
  });
  return ai.loadP;
}

function aiReset() {
  if (ai.busy) return; // 回答到一半不能清掉
  const symbol = aiKey();
  Object.assign(ai, { symbol, messages: [], view: [], lastFullAt: 0, updated: 0, loadP: null });
  aiRender(false);
  aiStoreSave({ symbol, messages: [] });
}

function aiOpen() {
  $('ai-panel').hidden = false;
  $('ai-fab').hidden = true;
  if (ai.symbol !== aiKey()) aiLoad(aiKey());
  $('ai-title').textContent = '問 AI';
  $('ai-tab-coin').textContent = (sym || '').replace(/USDT$/, '') || '這個幣';
  $('ai-tab-coin').classList.toggle('on', ai.scope === 'coin');
  $('ai-tab-market').classList.toggle('on', ai.scope === 'market');
  $('ai-q').placeholder = ai.scope === 'market' ? '問全市場，例如：現在哪幾個幣最值得做多？' : '問這個幣的任何事，例如：現在 4h 能做多嗎？停損放哪？';
  const noToken = !ai.cfg.token;
  $('ai-set').hidden = !noToken;
  if (noToken) { $('ai-token').value = ''; $('ai-url').value = aiUrl(); }
  $('ai-quick').innerHTML = (ai.scope === 'market' ? AI_QUICK_MARKET : AI_QUICK).map((q) => `<button type="button">${esc(q)}</button>`).join('');
  aiStatusRefresh();
}

const aiHeaders = () => (ai.cfg.token ? { 'x-ai-token': ai.cfg.token } : {});
const usd = (v) => `${v < 0 ? '-' : ''}$${Math.abs(v).toFixed(2)}`;

/** 標題下面那條：剩多少錢（記帳估算）、這個月花多少、今天問幾次 */
function aiRenderBal(st) {
  const el = $('ai-bal');
  if (!st?.configured) { el.hidden = true; return; }
  const l = st.ledger;
  const parts = [];
  if (l?.set) parts.push(`餘額約 <b>${usd(l.balance)}</b>（≈${Math.round(l.balance * USD_TWD)} 台幣）`);
  else if (st.authed) parts.push('餘額：到「設定」填一次 console 上的餘額，之後自動扣');
  if (l) parts.push(`本月花 ${usd(l.monthUsd)}`);
  parts.push(`今天問 ${st.usedToday ?? '?'}／${st.dailyLimit} 次`);
  if (l?.low) parts.push('快用完了，去 console 儲值');
  el.innerHTML = parts.join('・');
  el.classList.toggle('low', !!l?.low);
  el.hidden = false;
}

async function aiStatusRefresh() {
  try {
    const r = await fetch(`${aiUrl()}/ai/status`, { headers: aiHeaders(), cache: 'no-store' }).then((x) => x.json());
    aiRenderBal(r);
    return r;
  } catch { return null; }
}

async function aiCheck() {
  $('ai-check').textContent = '檢查中…';
  const r = await aiStatusRefresh();
  if (!r) { $('ai-check').textContent = '連不到 Worker，檢查網址'; return; }
  $('ai-check').textContent = !r.configured ? 'Worker 還沒設定 ANTHROPIC_API_KEY／AI_TOKEN' : !r.authed ? 'Worker 已設定好，但密碼不對' : `Worker 已設定好（${r.model}），密碼正確`;
  if (r.ledger?.set && $('ai-balance').value === '') $('ai-balance').placeholder = `目前估算 ${r.ledger.balance.toFixed(2)}`;
}

async function aiSaveBalance() {
  const v = Number($('ai-balance').value);
  if ($('ai-balance').value === '' || !Number.isFinite(v) || v < 0) { $('ai-bal-msg').textContent = '請填 0 以上的數字（美元）'; return; }
  $('ai-bal-msg').textContent = '更新中…';
  try {
    const res = await fetch(`${aiUrl()}/ai/budget`, { method: 'POST', headers: { 'content-type': 'application/json', ...aiHeaders() }, body: JSON.stringify({ balance: v }) });
    const r = await res.json();
    if (!res.ok) { $('ai-bal-msg').textContent = r.error || `失敗（HTTP ${res.status}）`; return; }
    $('ai-bal-msg').textContent = `已更新：從現在起由 ${usd(v)} 開始扣`;
    $('ai-balance').value = '';
    aiStatusRefresh();
  } catch { $('ai-bal-msg').textContent = '連不到 Worker'; }
}

async function aiAsk(question) {
  question = String(question || '').trim();
  if (!question || ai.busy) return;
  const isMarket = ai.scope === 'market';
  if (!isMarket && (!report || !sym)) { aiBubble('err', '還在載入資料，等一下再問'); return; }
  if (!ai.cfg.token) { $('ai-set').hidden = false; aiBubble('err', '先輸入 AI 密碼'); return; }
  const key = aiKey();
  if (ai.symbol !== key) aiLoad(key);
  ai.busy = true;
  $('ai-send').disabled = true;
  await ai.loadP; // 先等之前的紀錄讀回來，才接得上
  if (ai.symbol !== key) { ai.busy = false; $('ai-send').disabled = false; return; }
  const chatSym = ai.symbol;
  const prevFullAt = ai.lastFullAt;
  let now = Date.now();
  let full;
  let content;
  const view = [...ai.view, { k: 'user', text: question }];
  aiBubble('user', esc(question));
  if (isMarket) {
    // 全市場：先掃（10 分鐘內沿用），這段對話還沒看過這次掃描才附上完整結果
    const prog = aiBubble('ai', '<span class="ai-status">掃描市場中…</span>');
    let scan;
    try {
      scan = await marketScan((d, n, s) => { prog.innerHTML = `<span class="ai-status">掃描市場中… ${d}/${n}（${esc(s.replace(/USDT$/, ''))}）</span>`; });
    } catch (e) {
      prog.className = 'ai-msg err';
      prog.textContent = `掃描失敗（連不到 Bybit）：${e.message || e}`;
      ai.busy = false; $('ai-send').disabled = false;
      return;
    }
    prog.remove();
    full = !ai.messages.length || ai.lastFullAt !== scan.time;
    now = scan.time;
    const rows = scan.rows.slice(0, 10).map((r) => ({ s: r.symbol, dir: r.dir, score: r.score, chg: Math.round(r.change * 10) / 10 }));
    if (full) { view.push({ k: 'scan', text: '', rows }); scanBubble(rows); }
    content = marketUserMessage(full ? marketSnapshot(scan) : null, question);
  } else {
    full = needFullSnapshot(ai, now);
    const snapshot = buildAiSnapshot({
      symbol: sym, mode, price: livePrice, report, ticker, deriv, ls, changes,
      whales: { walls: whale.walls, threshold: whale.threshold, stats: tradeStats(whale.trades, whale.threshold, Date.now()), ratio: whaleVsCrowd(whale.top, whale.crowd) },
      full,
    });
    content = aiUserMessage(snapshot, question);
  }
  const userMsg = { role: 'user', content };
  const convo = [...ai.messages, userMsg];
  const bubble = aiBubble('ai', '<span class="ai-status">送出中…</span>');
  let text = '';
  let status = '';
  const paint = () => { bubble.innerHTML = (text ? mdLite(text) : '') + (status ? `<div class="ai-status">${esc(status)}</div>` : ''); $('ai-log').scrollTop = $('ai-log').scrollHeight; };
  try {
    const res = await fetch(`${aiUrl()}/ai/ask`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-ai-token': ai.cfg.token }, body: JSON.stringify({ symbol: isMarket ? 'MARKET' : sym, messages: convo }) });
    if (!res.body) throw new Error(`HTTP ${res.status}`);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let done = null;
    for (;;) {
      const { value, done: end } = await reader.read();
      if (end) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const lineTxt = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!lineTxt) continue;
        const ev = JSON.parse(lineTxt);
        if (ev.t === 'text') { text += ev.d; status = ''; }
        else if (ev.t === 'status') status = ev.d;
        else if (ev.t === 'error' || ev.t === 'refusal') { status = ''; text = ''; bubble.className = 'ai-msg err'; bubble.textContent = ev.d; }
        else if (ev.t === 'done') done = ev;
        if (ev.t !== 'error' && ev.t !== 'refusal') paint();
      }
    }
    if (done && done.append?.length) {
      // 對話只能往後加：把這次的問題和 AI 原封不動的回覆接上去，下次整段送回
      status = '';
      paint();
      const meta = document.createElement('div');
      meta.className = 'ai-meta';
      meta.textContent = isMarket
        ? `${aiCost(done.usage) ?? ''}｜根據 ${tw(now).slice(6)} 的全市場掃描`
        : `${aiCost(done.usage) ?? ''}｜根據 ${tw(now).slice(6)} 的資料${mode === 'live' ? '（含盤中 K 棒）' : ''}${full ? '' : '（摘要）'}`;
      bubble.appendChild(meta);
      // 存起來：關掉網頁再開、換幣再換回來都接得上（回答途中換了幣也照樣存到原本那個幣）
      const chat = { symbol: chatSym, messages: [...convo, ...done.append], view: [...view, { k: 'ai', text, meta: meta.textContent }], lastFullAt: full ? now : prevFullAt, updated: Date.now() };
      if (ai.symbol === chatSym) Object.assign(ai, chat);
      aiStoreSave(chat);
      aiStatusRefresh(); // 餘額、今天次數跟著更新
    } else if (bubble.className !== 'ai-msg err') {
      bubble.className = 'ai-msg err';
      bubble.textContent = '沒有拿到完整回答，請再問一次';
    }
    if (res.status === 401) { ai.cfg.token = ''; aiSaveCfg(); $('ai-set').hidden = false; }
  } catch (e) {
    bubble.className = 'ai-msg err';
    bubble.textContent = `連線失敗：${e.message || e}`;
  } finally {
    ai.busy = false;
    $('ai-send').disabled = false;
  }
}

$('ai-fab').addEventListener('click', aiOpen);
$('ai-close').addEventListener('click', () => { $('ai-panel').hidden = true; $('ai-fab').hidden = false; });
$('ai-new').addEventListener('click', aiReset);
$('ai-gear').addEventListener('click', () => { $('ai-set').hidden = !$('ai-set').hidden; $('ai-token').value = ai.cfg.token || ''; $('ai-url').value = aiUrl(); if (!$('ai-set').hidden) aiCheck(); });
$('ai-save').addEventListener('click', () => { ai.cfg.token = $('ai-token').value.trim(); ai.cfg.url = $('ai-url').value.trim() || AI_DEFAULT_URL; aiSaveCfg(); aiCheck(); if (ai.cfg.token) setTimeout(() => { $('ai-set').hidden = true; }, 1200); });
$('ai-bal-save').addEventListener('click', aiSaveBalance);
const aiScope = (scope) => { if (ai.busy || ai.scope === scope) return; ai.scope = scope; aiOpen(); };
$('ai-tab-coin').addEventListener('click', () => aiScope('coin'));
$('ai-tab-market').addEventListener('click', () => aiScope('market'));
$('ai-log').addEventListener('click', (e) => {
  const b = e.target.closest('button.ai-coin');
  if (!b || ai.busy) return;
  ai.scope = 'coin';
  start(b.dataset.s); // 打開那個幣（start 會順便把問 AI 換到那個幣的對話）
});
$('ai-quick').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) aiAsk(b.textContent); });
$('ai-form').addEventListener('submit', (e) => { e.preventDefault(); const q = $('ai-q').value; $('ai-q').value = ''; aiAsk(q); });
$('ai-q').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('ai-form').requestSubmit(); } });

/* ───────────── 初始化 ───────────── */
$('mode-live')?.addEventListener('click', () => setMode('live'));
$('mode-closed')?.addEventListener('click', () => setMode('closed'));
renderModeSwitch();
$('quick').innerHTML = QUICK.map((b) => `<button type="button" data-s="${b}">${b}</button>`).join('');
$('quick').addEventListener('click', (e) => { const b = e.target.closest('button[data-s]'); if (b) start(b.dataset.s); });
$('form').addEventListener('submit', (e) => { e.preventDefault(); start($('q').value); });
bybit.fetchSymbols().then((list) => {
  $('symbols').innerHTML = list.map((x) => `<option value="${x.base}">${x.symbol}</option>`).join('');
}).catch(() => { /* 沒有清單也能手動輸入 */ });
const first = new URLSearchParams(location.search).get('s') || (() => { try { return localStorage.getItem(STORE); } catch { return null; } })() || 'BTCUSDT';
start(first);
document.addEventListener('visibilitychange', () => { if (!document.hidden && sym) loadAll(sym, { quiet: true }); });
