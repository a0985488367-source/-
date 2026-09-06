#!/usr/bin/env node
/**
 * 產生 public/crypto-radar-guardian.scriptable.js —— iPhone 版
 *
 * 給 iOS 的 Scriptable App 執行。與瀏覽器版共用同一份掃描引擎與畫面模組，
 * 差別只在抓資料的方式：
 *   瀏覽器版用 fetch，受同源政策限制，需要從 https 或本機伺服器開啟。
 *   Scriptable 用原生 Request，沒有跨來源限制，因此不需要任何伺服器或電腦。
 *
 * 邏輯改在 app/scan-engine.js，畫面改在 app/render.js，樣式改在 app/theme.css。
 * 改完重跑本產生器。不要手改產生後的 .js。
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { ROOT, engineVersion, inlineModule, readText } from './lib-inline.mjs';

const outPath = resolve(ROOT, 'public/crypto-radar-guardian.scriptable.js');

const engine = inlineModule('app/scan-engine.js');
const render = inlineModule('app/render.js');
const css = readText('app/theme.css');
const disclaimer = readText('app/disclaimer.html');
const version = engineVersion(engine);

const GLUE = `
/* ================= Bybit 抓取（Scriptable 原生 Request，無跨來源限制） ================= */

async function bybit(path, params) {
  let url = BYBIT_BASE + path;
  const pairs = [];
  for (const key of Object.keys(params || {})) {
    pairs.push(encodeURIComponent(key) + '=' + encodeURIComponent(String(params[key])));
  }
  if (pairs.length) url += '?' + pairs.join('&');

  const req = new Request(url);
  req.method = 'GET';
  req.timeoutInterval = 25;
  req.headers = { accept: 'application/json' };

  const json = await req.loadJSON();
  if (!json || typeof json !== 'object') throw new Error('回應格式不正確');
  if (json.retCode !== 0) throw new Error('Bybit retCode ' + json.retCode + '：' + json.retMsg);
  return json.result;
}

async function pool(items, size, worker) {
  const out = [];
  for (let i = 0; i < items.length; i += size) {
    const batch = items.slice(i, i + size);
    const done = await Promise.all(batch.map(worker));
    for (const d of done) out.push(d);
  }
  return out;
}

/* ================= 掃描 ================= */

async function runScan() {
  const state = {
    candidates: [], failed: [], scannedAt: null,
    universeCount: 0, analyzedCount: 0, busy: false, error: null,
  };

  const instRes = await bybit('/v5/market/instruments-info', { category: 'linear', limit: 1000 });
  const tickRes = await bybit('/v5/market/tickers', { category: 'linear' });

  const rows = buildUniverse(instRes.list || [], tickRes.list || [], Date.now());
  const passed = rows.filter(passesUniverseFilter);
  state.universeCount = passed.length;

  const shortlist = rankUniverse(passed);
  state.analyzedCount = shortlist.length;
  console.log('第一階段通過 ' + passed.length + ' 檔，詳細分析 ' + shortlist.length + ' 檔');

  if (shortlist.length) {
    const built = await pool(shortlist, 3, async (row) => {
      try {
        const kl = await bybit('/v5/market/kline', { category: 'linear', symbol: row.symbol, interval: 15, limit: 40 });
        const oi = await bybit('/v5/market/open-interest', { category: 'linear', symbol: row.symbol, intervalTime: '15min', limit: 5 });
        let ob = null;
        try {
          ob = await bybit('/v5/market/orderbook', { category: 'linear', symbol: row.symbol, limit: 50 });
        } catch (e) {
          ob = null;
        }
        return buildCandidate(row, parseKlines(kl.list), parseOpenInterest(oi.list), ob ? parseOrderbook(ob) : null);
      } catch (err) {
        console.log('抓取失敗 ' + row.symbol + '：' + err.message);
        return { symbol: row.symbol, failed: true, error: String(err.message || err) };
      }
    });

    state.candidates = rankCandidates(built.filter((c) => !c.failed));
    state.failed = built.filter((c) => c.failed);
  }

  state.scannedAt = Date.now();
  return state;
}

/* ================= 產生畫面 ================= */

function pageHtml(state) {
  const when = new Date(state.scannedAt).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' });
  const readyCount = state.candidates.filter(function (c) { return c.entryReady; }).length;

  return '<!doctype html>'
    + '<html lang="zh-Hant"><head>'
    + '<meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">'
    + '<meta name="color-scheme" content="dark">'
    + '<title>Crypto Radar Guardian</title>'
    + '<style>' + CSS + '</style>'
    + '</head><body><div class="wrap">'
    + '<header>'
    +   '<div class="title"><h1>Crypto Radar Guardian</h1>'
    +   '<span class="ver">v' + ENGINE_VERSION + ' · iPhone</span></div>'
    +   '<div style="margin-top:6px"><span class="srcbadge">◈ 資料來源 <b>Bybit /v5/market</b></span></div>'
    +   '<div class="bar"><span class="meta" style="margin-left:0">掃描於 ' + when
    +   '　·　符合進場條件 ' + readyCount + ' 檔</span></div>'
    + '</header>'
    + '<div class="note"><strong>早期快噴掃描</strong>：在 Bybit USDT 線性永續中，尋找「已壓縮、量能溫和放大、'
    + '未平倉量增加、且尚未突破前高」的標的。已經噴過的一律排除。'
    + statText(state)
    + '<div style="margin-top:6px;color:var(--muted)">要更新資料，請回到 Scriptable 再執行一次。</div></div>'
    + listHtml(state)
    + DISCLAIMER
    + '</div></body></html>';
}

/* ================= 進入點 ================= */

try {
  const state = await runScan();
  const wv = new WebView();
  await wv.loadHTML(pageHtml(state));
  await wv.present(true);
} catch (err) {
  const a = new Alert();
  a.title = '掃描失敗';
  a.message = String((err && err.message) ? err.message : err)
    + '\\n\\n請確認網路連線正常，稍後再試一次。';
  a.addAction('好');
  await a.present();
}

Script.complete();
`;

const out = `// Crypto Radar Guardian — iPhone 版 (Scriptable)
// 引擎版本 ${version}
//
// 這是什麼
//   在 Bybit USDT 線性永續合約中，找出「已壓縮、量能溫和放大、未平倉量增加、
//   且尚未突破前高」的早期候選。已經噴過的一律排除。
//
// 怎麼用
//   1. 在 App Store 安裝免費的 Scriptable
//   2. 打開 Scriptable，右上角 + 新增一個 Script
//   3. 把這整份檔案的內容貼進去
//   4. 按右下角的播放鍵執行
//   不需要電腦，不需要伺服器。
//
// 安全性
//   只讀取 Bybit 公開行情端點，不需要也不接受 API Key，
//   不連接任何交易帳戶，永遠不會下單。
//
// 要改邏輯
//   改 app/scan-engine.js，然後執行 node scripts/build-scriptable-app.mjs
//   不要直接改這個檔案，它是產生出來的。

/* ============================================================
   掃描引擎 —— 由 app/scan-engine.js 內嵌
   ============================================================ */
${engine}

/* ============================================================
   畫面 —— 由 app/render.js 內嵌
   ============================================================ */
${render}

/* ============================================================
   樣式與免責 —— 由 app/theme.css 與 app/disclaimer.html 內嵌
   ============================================================ */
const CSS = ${JSON.stringify(css)};
const DISCLAIMER = ${JSON.stringify(disclaimer)};

/* ============================================================
   Scriptable 接線
   ============================================================ */
${GLUE}
`;

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, out, 'utf8');
console.log(`已產生 ${outPath}`);
console.log(`引擎版本 ${version}，大小 ${(Buffer.byteLength(out, 'utf8') / 1024).toFixed(1)} KB`);
