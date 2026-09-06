#!/usr/bin/env node
/**
 * 產生 public/crypto-radar-guardian.html
 *
 * 與原專案 scripts/build-guardian-worker-v10.mjs 同樣的規矩：
 * 邏輯改在 app/scan-engine.js，改完重跑本產生器。
 * 不要手改產生後的 HTML。
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const enginePath = resolve(root, 'app/scan-engine.js');
const outPath = resolve(root, 'public/crypto-radar-guardian.html');

// 內嵌時去掉 export 關鍵字：模組內容直接放進單一 script 作用域
const engineSource = readFileSync(enginePath, 'utf8')
  .replace(/^export\s+/gm, '')
  .trimEnd();

const CSS = `
:root {
  color-scheme: dark;
  --bg: #050d17;
  --panel: #081321;
  --panel-2: #0b1a2c;
  --line: rgba(34, 211, 238, 0.16);
  --line-soft: rgba(34, 211, 238, 0.08);
  --text: #cfe6f2;
  --muted: #6d8ca6;
  --cyan: #22d3ee;
  --green: #34d399;
  --amber: #ffb020;
  --red: #ff4d6d;
  --violet: #a78bfa;
}
* { box-sizing: border-box; }
html, body { margin: 0; background: var(--bg); }
body {
  font: 15px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans TC", "PingFang TC", sans-serif;
  color: var(--text);
  padding: env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left);
  -webkit-text-size-adjust: 100%;
}
.wrap { max-width: 640px; margin: 0 auto; padding: 14px 12px 40px; }

header { position: sticky; top: 0; z-index: 20; background: linear-gradient(180deg, var(--bg) 72%, transparent); padding-top: 8px; }
.title { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
h1 { font-size: 19px; margin: 0; letter-spacing: .02em; }
.ver { font-size: 11px; color: var(--muted); font-variant-numeric: tabular-nums; }
.srcbadge {
  display: inline-flex; align-items: center; gap: 5px;
  font-size: 11px; color: var(--cyan); border: 1px solid var(--line);
  border-radius: 999px; padding: 2px 9px; background: rgba(34, 211, 238, .06);
}
.srcbadge b { font-weight: 600; }

.bar { display: flex; gap: 8px; align-items: center; margin-top: 10px; }
button {
  font: inherit; font-size: 14px; color: var(--text);
  background: var(--panel-2); border: 1px solid var(--line);
  border-radius: 10px; padding: 9px 14px; cursor: pointer;
  min-height: 42px; -webkit-tap-highlight-color: transparent;
}
button:active { background: #10263c; }
button[disabled] { opacity: .5; cursor: default; }
button.primary { border-color: rgba(34, 211, 238, .45); color: #e6fbff; }
.meta { font-size: 12px; color: var(--muted); font-variant-numeric: tabular-nums; margin-left: auto; text-align: right; }

.note {
  margin: 12px 0 0; padding: 10px 12px; border-radius: 10px;
  background: var(--panel); border: 1px solid var(--line-soft);
  font-size: 12.5px; color: var(--muted);
}
.note strong { color: var(--text); font-weight: 600; }

.banner { margin-top: 12px; padding: 11px 13px; border-radius: 11px; background: var(--panel); border-left: 3px solid var(--amber); }
.banner.err { border-left-color: var(--red); }
.banner .bt { font-size: 13.5px; color: #ffe9c2; font-weight: 600; }
.banner.err .bt { color: #ffd6de; }
.banner .bd { font-size: 12.5px; color: var(--muted); margin-top: 3px; }

.progress { height: 3px; background: var(--panel-2); border-radius: 2px; overflow: hidden; margin-top: 12px; }
.progress i { display: block; height: 100%; background: linear-gradient(90deg, var(--cyan), var(--violet)); width: 0; transition: width .25s ease; }

h2 { font-size: 13px; color: var(--muted); font-weight: 600; letter-spacing: .06em; margin: 22px 0 10px; text-transform: uppercase; }

.card {
  background: var(--panel); border: 1px solid var(--line-soft);
  border-radius: 13px; padding: 13px; margin-bottom: 11px;
}
.card.ready { border-color: rgba(52, 211, 153, .38); box-shadow: 0 0 0 1px rgba(52, 211, 153, .09), 0 6px 22px -14px rgba(52, 211, 153, .5); }
.card.excluded { opacity: .72; }

.chead { display: flex; align-items: center; gap: 9px; flex-wrap: wrap; }
.sym { font-size: 17px; font-weight: 650; letter-spacing: .01em; }
.tag { font-size: 10.5px; padding: 2px 7px; border-radius: 5px; border: 1px solid var(--line); color: var(--muted); white-space: nowrap; }
.tag.near { color: var(--green); border-color: rgba(52, 211, 153, .4); }
.tag.build { color: var(--cyan); border-color: rgba(34, 211, 238, .35); }
.tag.excl { color: var(--red); border-color: rgba(255, 77, 109, .35); }
.tag.meme { color: var(--amber); border-color: rgba(255, 176, 32, .4); }
.score { margin-left: auto; text-align: right; }
.score b { font-size: 21px; font-variant-numeric: tabular-nums; letter-spacing: -.01em; }
.score span { display: block; font-size: 10.5px; color: var(--muted); }

.readiness { display: flex; align-items: center; gap: 8px; margin-top: 10px; }
.dots { display: flex; gap: 3px; }
.dot { width: 7px; height: 7px; border-radius: 2px; background: rgba(255,255,255,.13); }
.dot.on { background: var(--green); }
.rtext { font-size: 12px; color: var(--muted); font-variant-numeric: tabular-nums; }

.reasons { margin: 9px 0 0; padding: 9px 11px; border-radius: 9px; background: rgba(255, 77, 109, .06); border: 1px solid rgba(255, 77, 109, .18); }
.reasons div { font-size: 12.5px; color: #ffc9d4; padding: 1.5px 0; }
.reasons div::before { content: "✕ "; color: var(--red); }

.entry { margin-top: 10px; padding: 10px 11px; border-radius: 9px; background: rgba(52, 211, 153, .06); border: 1px solid rgba(52, 211, 153, .2); }
.erow { display: flex; justify-content: space-between; font-size: 13px; padding: 2.5px 0; font-variant-numeric: tabular-nums; }
.erow span { color: var(--muted); }
.erow b { font-weight: 600; }
.erow.tp b { color: var(--green); }
.erow.sl b { color: var(--red); }

.grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 7px 12px; margin-top: 11px; }
.cell { font-size: 12px; display: flex; justify-content: space-between; gap: 6px; font-variant-numeric: tabular-nums; }
.cell span { color: var(--muted); }
.cell b { font-weight: 600; }
.pos { color: var(--green); }
.neg { color: var(--red); }

.foot { display: flex; align-items: center; gap: 10px; margin-top: 11px; padding-top: 10px; border-top: 1px solid var(--line-soft); }
.foot a { color: var(--cyan); font-size: 12.5px; text-decoration: none; border-bottom: 1px solid rgba(34,211,238,.3); }
.noauto { font-size: 11px; color: var(--muted); margin-left: auto; }

.empty { padding: 26px 14px; text-align: center; color: var(--muted); font-size: 13.5px; background: var(--panel); border-radius: 12px; border: 1px dashed var(--line-soft); }

.disc { margin-top: 26px; padding: 13px; border-radius: 11px; background: var(--panel); border: 1px solid var(--line-soft); font-size: 11.5px; line-height: 1.65; color: var(--muted); }
.disc b { color: var(--text); display: block; margin-bottom: 5px; font-size: 12.5px; }
.disc li { margin: 3px 0; }
.disc ul { margin: 5px 0 0; padding-left: 17px; }

@media (max-width: 380px) { .grid { grid-template-columns: 1fr; } h1 { font-size: 17px; } }
`;

const APP_JS = `
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

const state = { candidates: [], scannedAt: null, universeCount: 0, analyzedCount: 0, busy: false, error: null };

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
    state.error = String(err && err.message ? err.message : err);
  } finally {
    state.busy = false;
    setProgress(1);
    setTimeout(() => setProgress(0), 400);
    render();
  }
}

/* ---------------- 畫面 ---------------- */

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const setProgress = (v) => { $('bar').style.width = Math.round(v * 100) + '%'; };

const fx = (v, d) => (Number.isFinite(v) ? v.toFixed(d ?? 4) : '—');
const fpct = (v) => (Number.isFinite(v) ? (v >= 0 ? '+' : '') + v.toFixed(2) + '%' : '—');
const fusd = (v) => {
  if (!Number.isFinite(v) || v <= 0) return '—';
  if (v >= 1e9) return (v / 1e9).toFixed(2) + 'B';
  if (v >= 1e6) return (v / 1e6).toFixed(2) + 'M';
  if (v >= 1e3) return (v / 1e3).toFixed(1) + 'K';
  return v.toFixed(0);
};
const sgn = (v) => (Number.isFinite(v) ? (v >= 0 ? 'pos' : 'neg') : '');
const ago = (ts) => {
  if (!ts) return '尚未掃描';
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return s + ' 秒前';
  return Math.round(s / 60) + ' 分鐘前';
};

function priceDigits(p) {
  if (!Number.isFinite(p)) return 4;
  if (p >= 1000) return 1;
  if (p >= 10) return 3;
  if (p >= 1) return 4;
  if (p >= 0.01) return 5;
  return 7;
}

function cardHtml(c) {
  const d = priceDigits(c.lastPrice);
  const stageClass = c.stage === 'NEAR_BREAKOUT' ? 'near' : c.stage === 'EXCLUDED' ? 'excl' : 'build';
  const dots = Array.from({ length: c.readiness.total }, (_, i) =>
    '<i class="dot' + (i < c.readiness.passed ? ' on' : '') + '"></i>').join('');

  const entryBlock = c.entryReady ? \`
    <div class="entry">
      <div class="erow"><span>Entry 區</span><b>\${fx(c.entryLow, d)} – \${fx(c.entryHigh, d)}</b></div>
      <div class="erow sl"><span>停損 SL</span><b>\${fx(c.stopLoss, d)}</b></div>
      <div class="erow tp"><span>TP1 · 1.5R</span><b>\${fx(c.takeProfit1, d)}</b></div>
      <div class="erow tp"><span>TP2 · 2.5R</span><b>\${fx(c.takeProfit2, d)}</b></div>
      \${c.maxPositionUsd > 0 ? '<div class="erow"><span>盤口可承受</span><b>約 ' + fusd(c.maxPositionUsd) + ' USDT</b></div>' : ''}
    </div>\` : '';

  const reasonBlock = c.blockingReasons.length ? \`
    <div class="reasons">\${c.blockingReasons.map((r) => '<div>' + esc(r) + '</div>').join('')}</div>\` : '';

  const staleBlock = c.staleWarning
    ? '<div class="banner"><div class="bt">資料偏舊</div><div class="bd">此標的資料已 ' + Math.round(c.dataAgeMinutes) + ' 分鐘未更新。</div></div>'
    : '';

  return \`
  <div class="card \${c.entryReady ? 'ready' : ''} \${c.stage === 'EXCLUDED' ? 'excluded' : ''}">
    <div class="chead">
      <span class="sym">\${esc(c.symbol)}</span>
      <span class="tag \${stageClass}">\${STAGE_LABEL[c.stage] ?? c.stage}</span>
      \${c.riskLabel ? '<span class="tag meme">' + esc(c.riskLabel) + '</span>' : ''}
      <span class="score"><b>\${c.score}</b><span>完成度</span></span>
    </div>

    <div class="readiness">
      <span class="dots">\${dots}</span>
      <span class="rtext">進場條件 \${c.readiness.passed}/\${c.readiness.total}</span>
    </div>

    \${entryBlock}
    \${reasonBlock}
    \${staleBlock}

    <div class="grid">
      <div class="cell"><span>現價</span><b>\${fx(c.lastPrice, d)}</b></div>
      <div class="cell"><span>距突破點</span><b>\${fpct(c.breakoutDistancePct)}</b></div>
      <div class="cell"><span>15m 壓縮比</span><b>\${fx(c.compressionRatio, 3)}</b></div>
      <div class="cell"><span>量能倍率</span><b>\${fx(c.volumeMultiple, 2)}x</b></div>
      <div class="cell"><span>OI 變化</span><b class="\${sgn(c.oiChangePct)}">\${fpct(c.oiChangePct)}</b></div>
      <div class="cell"><span>資金費率</span><b>\${fx(c.fundingRatePct, 4)}%</b></div>
      <div class="cell"><span>1H / 6H</span><b><span class="\${sgn(c.change1hPct)}">\${fpct(c.change1hPct)}</span> / <span class="\${sgn(c.change6hPct)}">\${fpct(c.change6hPct)}</span></b></div>
      <div class="cell"><span>24H 成交額</span><b>\${fusd(c.turnover24hUsd)}</b></div>
    </div>

    <div class="foot">
      <a href="\${c.bybitUrl}" target="_blank" rel="noopener noreferrer">在 Bybit 開啟合約 ↗</a>
      <span class="noauto">僅供研究觀察 · 不自動下單</span>
    </div>
  </div>\`;
}

function render() {
  $('meta').textContent = state.busy ? '掃描中…' : ('更新於 ' + ago(state.scannedAt));
  $('refresh').disabled = state.busy;
  $('refresh').textContent = state.busy ? '掃描中…' : '重新掃描';

  const stat = state.scannedAt && !state.busy
    ? \`通過第一階段 \${state.universeCount} 檔，詳細分析 \${state.analyzedCount} 檔\`
    : '';
  $('stat').textContent = stat;

  let html = '';

  if (state.error) {
    html += \`<div class="banner err">
      <div class="bt">無法取得 Bybit 資料</div>
      <div class="bd">\${esc(state.error)}<br>若你是用檔案方式開啟，請改用 https 或本機伺服器開啟；瀏覽器可能擋下跨來源請求。</div>
    </div>\`;
  }

  if (state.failed && state.failed.length) {
    html += \`<div class="banner">
      <div class="bt">\${state.failed.length} 檔標的資料抓取失敗</div>
      <div class="bd">\${state.failed.map((f) => esc(f.symbol)).join('、')}</div>
    </div>\`;
  }

  const ready = state.candidates.filter((c) => c.entryReady);
  const watch = state.candidates.filter((c) => !c.entryReady);

  if (!state.candidates.length && !state.busy && state.scannedAt) {
    html += '<div class="empty">目前沒有符合條件的早期候選。<br>這是正常結果 —— 多數時間市場都不在壓縮待突破的狀態。</div>';
  }

  if (ready.length) {
    html += '<h2>條件式 Entry · ' + ready.length + ' 檔</h2>' + ready.map(cardHtml).join('');
  }
  if (watch.length) {
    html += '<h2>觀察中 · ' + watch.length + ' 檔</h2>' + watch.map(cardHtml).join('');
  }

  $('list').innerHTML = html;
}

/* ---------------- 生命週期 ---------------- */

// iOS Safari 會凍結背景分頁的計時器。切回前景時強制重抓，
// 避免看到幾十分鐘前的資料卻以為是即時的。
let lastScanAt = 0;
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && Date.now() - lastScanAt > 120_000) {
    lastScanAt = Date.now();
    scan();
  }
});

$('refresh').addEventListener('click', () => { lastScanAt = Date.now(); scan(); });

setInterval(() => { if (!state.busy) $('meta').textContent = '更新於 ' + ago(state.scannedAt); }, 15_000);
setInterval(() => { if (!document.hidden && !state.busy) { lastScanAt = Date.now(); scan(); } }, 300_000);

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
<style>${CSS}</style>
</head>
<body>
<div class="wrap">

  <header>
    <div class="title">
      <h1>Crypto Radar Guardian</h1>
      <span class="ver">v${'ENGINE_VERSION_PLACEHOLDER'}</span>
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

  <div class="disc">
    <b>使用前請務必了解</b>
    <ul>
      <li>本頁只讀取 Bybit 公開行情端點，<strong>不連接任何帳戶、不需要也不接受 API Key</strong>，並且<strong>永遠不會下單</strong>。</li>
      <li>完成度分數衡量的是「型態成熟程度」，<strong>不是勝率，也不是報酬預期</strong>。分數高不等於可以進場，必須十項進場條件全部通過。</li>
      <li>Entry、SL、TP 為依 1.5R 與 2.5R 機械換算的參考值，不是投資建議。實際下單前請自行確認盤口深度與可承受風險。</li>
      <li>迷因幣一律標記並套用固定 0.15% 防守倉，不因分數提高倉位。</li>
      <li>加密貨幣永續合約風險極高，可能損失全部本金。本工具不對任何結果作出保證。</li>
    </ul>
  </div>

</div>

<script type="module">
/* ============================================================
   掃描引擎 —— 由 app/scan-engine.js 產生，請勿直接修改此區塊
   修改方式：改 app/scan-engine.js，再執行
   node scripts/build-standalone-app.mjs
   ============================================================ */
${engineSource}

/* ============================================================
   介面
   ============================================================ */
${APP_JS}
</script>
</body>
</html>
`;

const engineVersion = /ENGINE_VERSION = '([^']+)'/.exec(engineSource)?.[1] ?? 'unknown';
const finalHtml = html.replace('ENGINE_VERSION_PLACEHOLDER', engineVersion);

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, finalHtml, 'utf8');

const kb = (Buffer.byteLength(finalHtml, 'utf8') / 1024).toFixed(1);
console.log(`已產生 ${outPath}`);
console.log(`引擎版本 ${engineVersion}，檔案大小 ${kb} KB`);
