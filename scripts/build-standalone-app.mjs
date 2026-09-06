#!/usr/bin/env node
/**
 * 產生 public/crypto-radar-guardian.html —— 瀏覽器版
 *
 * 邏輯改在 app/scan-engine.js，畫面改在 app/render.js，樣式改在 app/theme.css。
 * 改完重跑本產生器。不要手改產生後的 HTML。
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { ROOT, engineVersion, inlineModule, readText } from './lib-inline.mjs';

const outPath = resolve(ROOT, 'public/crypto-radar-guardian.html');

const engine = inlineModule('app/scan-engine.js');
const render = inlineModule('app/render.js');
const css = readText('app/theme.css');
const version = engineVersion(engine);

const GLUE = `
/* ---------------- Bybit 抓取（全部為公開端點，不需要 API Key） ---------------- */

async function bybit(path, params) {
  const url = new URL(BYBIT_BASE + path);
  for (const [k, v] of Object.entries(params ?? {})) url.searchParams.set(k, String(v));
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const json = await res.json();
  if (json.retCode !== 0) throw new Error('Bybit retCode ' + json.retCode + ': ' + json.retMsg);
  return json.result;
}

async function pool(items, size, worker) {
  const out = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(...await Promise.all(items.slice(i, i + size).map(worker)));
  }
  return out;
}

const state = { candidates: [], failed: [], scannedAt: null, universeCount: 0, analyzedCount: 0, busy: false, error: null };

async function scan() {
  if (state.busy) return;
  state.busy = true;
  state.error = null;
  render();
  setProgress(0.05);

  try {
    const [instRes, tickRes] = await Promise.all([
      bybit('/v5/market/instruments-info', { category: 'linear', limit: 1000 }),
      bybit('/v5/market/tickers', { category: 'linear' }),
    ]);
    setProgress(0.2);

    const rows = buildUniverse(instRes.list ?? [], tickRes.list ?? [], Date.now());
    const passed = rows.filter(passesUniverseFilter);
    state.universeCount = passed.length;

    const shortlist = rankUniverse(passed);
    state.analyzedCount = shortlist.length;
    if (!shortlist.length) {
      state.candidates = [];
      state.failed = [];
      state.scannedAt = Date.now();
      return;
    }

    let done = 0;
    const built = await pool(shortlist, 4, async (row) => {
      try {
        const [kl, oi, ob] = await Promise.all([
          bybit('/v5/market/kline', { category: 'linear', symbol: row.symbol, interval: 15, limit: 40 }),
          bybit('/v5/market/open-interest', { category: 'linear', symbol: row.symbol, intervalTime: '15min', limit: 5 }),
          bybit('/v5/market/orderbook', { category: 'linear', symbol: row.symbol, limit: 50 }).catch(() => null),
        ]);
        return buildCandidate(row, parseKlines(kl.list), parseOpenInterest(oi.list), ob ? parseOrderbook(ob) : null);
      } catch (err) {
        return { symbol: row.symbol, failed: true, error: String(err.message ?? err) };
      } finally {
        done += 1;
        setProgress(0.2 + 0.8 * (done / shortlist.length));
      }
    });

    state.candidates = rankCandidates(built.filter((c) => !c.failed));
    state.failed = built.filter((c) => c.failed);
    state.scannedAt = Date.now();
  } catch (err) {
    state.error = String(err && err.message ? err.message : err)
      + '。若你是用檔案方式開啟，請改用 https 或本機伺服器開啟；瀏覽器可能擋下跨來源請求。';
  } finally {
    state.busy = false;
    setProgress(1);
    setTimeout(() => setProgress(0), 400);
    render();
  }
}

/* ---------------- DOM 接線 ---------------- */

const $ = (id) => document.getElementById(id);
const setProgress = (v) => { $('bar').style.width = Math.round(v * 100) + '%'; };

function render() {
  $('meta').textContent = state.busy ? '掃描中…' : ('更新於 ' + ago(state.scannedAt));
  $('refresh').disabled = state.busy;
  $('refresh').textContent = state.busy ? '掃描中…' : '重新掃描';
  $('stat').textContent = statText(state);
  $('list').innerHTML = listHtml(state);
}

// iOS Safari 會凍結背景分頁的計時器。切回前景時強制重抓，
// 避免看到幾十分鐘前的資料卻以為是即時的。
let lastScanAt = 0;
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && Date.now() - lastScanAt > 120000) {
    lastScanAt = Date.now();
    scan();
  }
});

$('refresh').addEventListener('click', () => { lastScanAt = Date.now(); scan(); });

setInterval(() => { if (!state.busy) $('meta').textContent = '更新於 ' + ago(state.scannedAt); }, 15000);
setInterval(() => { if (!document.hidden && !state.busy) { lastScanAt = Date.now(); scan(); } }, 300000);

lastScanAt = Date.now();
scan();
`;

const html = `<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="color-scheme" content="dark">
<meta name="robots" content="noindex, nofollow">
<title>Crypto Radar Guardian</title>
<style>
${css}
</style>
</head>
<body>
<div class="wrap">

  <header>
    <div class="title">
      <h1>Crypto Radar Guardian</h1>
      <span class="ver">v${version}</span>
    </div>
    <div style="margin-top:6px">
      <span class="srcbadge">◈ 資料來源 <b>Bybit /v5/market</b></span>
    </div>
    <div class="bar">
      <button id="refresh" class="primary">重新掃描</button>
      <span id="meta" class="meta">尚未掃描</span>
    </div>
    <div class="progress"><i id="bar"></i></div>
  </header>

  <div class="note">
    <strong>早期快噴掃描</strong>：在 Bybit USDT 線性永續中，尋找「已壓縮、量能溫和放大、未平倉量增加、且尚未突破前高」的標的。
    已經噴過的一律排除。<span id="stat"></span>
  </div>

  <div id="list"></div>
${readText('app/disclaimer.html')}
</div>

<script type="module">
/* ============================================================
   由產生器內嵌，請勿直接修改此檔
   邏輯 app/scan-engine.js ｜ 畫面 app/render.js ｜ 樣式 app/theme.css
   改完執行：node scripts/build-standalone-app.mjs
   ============================================================ */
${engine}

${render}

${GLUE}
</script>
</body>
</html>
`;

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, html, 'utf8');
console.log(`已產生 ${outPath}`);
console.log(`引擎版本 ${version}，大小 ${(Buffer.byteLength(html, 'utf8') / 1024).toFixed(1)} KB`);
