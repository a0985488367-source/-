#!/usr/bin/env node
/**
 * 從 Bybit 抓取 K 線並存成 CSV（零依賴，Node 18+ 內建 fetch）
 *
 *   node scripts/fetch-bybit.mjs --symbol BTCUSDT --interval 15m --bars 20000
 *   node scripts/fetch-bybit.mjs --symbol ETHUSDT --interval 1h --bars 10000 --category linear
 *
 * Bybit v5 單次上限 1000 根，因此以 end 參數往回分頁。
 * 抓完會做品質檢查（缺口／重複／OHLC 自洽），問題直接印出來而不自動補值——
 * 悄悄補值會製造假的連續性，讓回測量到不存在的東西。
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseBybitKline, candlesToCsv, validateCandles } from '../src/sim/candle-io.js';

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] ? args[i + 1] : d; };

const SYMBOL = flag('symbol', 'BTCUSDT');
const INTERVAL = flag('interval', '15m');
const BARS = Number(flag('bars', 20000));
const CATEGORY = flag('category', 'spot');        // spot | linear | inverse
const OUT = flag('out', `data/bybit-${SYMBOL}-${INTERVAL}.csv`);
const HOST = flag('host', 'https://api.bybit.com');

const TF = { '1m': '1', '3m': '3', '5m': '5', '15m': '15', '30m': '30', '1h': '60', '2h': '120', '4h': '240', '6h': '360', '12h': '720', '1d': 'D', '1w': 'W' };
const MINUTES = { '1m': 1, '3m': 3, '5m': 5, '15m': 15, '30m': 30, '1h': 60, '2h': 120, '4h': 240, '6h': 360, '12h': 720, '1d': 1440, '1w': 10080 };

const tf = TF[INTERVAL];
if (!tf) { console.error(`不支援的週期 ${INTERVAL}，可用：${Object.keys(TF).join(', ')}`); process.exit(1); }
const stepMs = MINUTES[INTERVAL] * 60000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchPage(end, attempt = 0) {
  const q = new URLSearchParams({ category: CATEGORY, symbol: SYMBOL, interval: tf, limit: '1000' });
  if (end) q.set('end', String(end));
  try {
    const res = await fetch(`${HOST}/v5/market/kline?${q}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    if (json.retCode !== 0) throw new Error(`Bybit retCode ${json.retCode}: ${json.retMsg}`);
    return parseBybitKline(json);
  } catch (err) {
    if (attempt >= 4) throw err;
    const wait = 2 ** (attempt + 1) * 1000;           // 2s → 4s → 8s → 16s
    console.log(`   請求失敗（${err.message}），${wait / 1000}s 後重試…`);
    await sleep(wait);
    return fetchPage(end, attempt + 1);
  }
}

console.log(`Bybit ${CATEGORY} · ${SYMBOL} · ${INTERVAL} · 目標 ${BARS.toLocaleString('en-US')} 根`);

/** 把網路層的失敗翻成看得懂的說明，而不是丟出堆疊追蹤 */
function explain(err) {
  const m = String(err.message || err);
  if (m.includes('403')) {
    return '連線被閘道拒絕（HTTP 403）。這台機器的網路政策擋掉了交易所網域。\n'
      + '  請在你自己的電腦上執行這個腳本（Bybit 在一般網路環境可直接存取），\n'
      + '  或改用瀏覽器把資料存成 CSV 後，用 --source csv 餵給 measure-edge。';
  }
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|fetch failed/i.test(m)) {
    return `連不到 ${HOST}（${m}）。請確認網路，或以 --host 指定備用網域（例如 https://api.bytick.com）。`;
  }
  return m;
}

const all = new Map();
let end = Date.now();
let emptyPages = 0;

while (all.size < BARS) {
  let page;
  try {
    page = await fetchPage(end);
  } catch (err) {
    console.error(`\n\n抓取失敗：${explain(err)}`);
    process.exit(1);
  }
  if (!page.length) {
    if (++emptyPages >= 2) { console.log('   交易所沒有更早的資料了，提前結束。'); break; }
    end -= stepMs * 1000;
    continue;
  }
  emptyPages = 0;
  const before = all.size;
  for (const k of page) all.set(k.time, k);
  const oldest = page[0].time;
  process.stdout.write(`\r   已取得 ${all.size.toLocaleString('en-US')} 根，最早到 ${new Date(oldest).toISOString().slice(0, 16)}`);
  if (all.size === before) { console.log('\n   沒有新增資料，停止分頁。'); break; }
  end = oldest - 1;
  await sleep(150);                                    // 尊重速率限制
}

const sorted = [...all.values()].sort((a, b) => a.time - b.time).slice(-BARS);
console.log(`\n\n共 ${sorted.length.toLocaleString('en-US')} 根 K 棒`);
console.log(`期間 ${new Date(sorted[0].time).toISOString().slice(0, 16)} → ${new Date(sorted[sorted.length - 1].time).toISOString().slice(0, 16)}`);

const { candles, issues } = validateCandles(sorted);
console.log('\n資料品質：');
if (issues.length) for (const m of issues) console.log(`  · ${m}`);
else console.log('  · 無缺口、無重複、OHLC 自洽');

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, candlesToCsv(candles));
console.log(`\n已寫入 ${OUT}`);
console.log(`接著跑：node scripts/measure-edge.mjs --source csv --file ${OUT}`);
