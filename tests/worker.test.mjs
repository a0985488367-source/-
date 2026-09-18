import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker/index.js';

/* ------------------------------------------------------------ 測試替身 */

const MARKET_URL = 'https://example.test/market.json';

function makeMarket(rows, ageMin = 5) {
  return {
    generatedAt: new Date(Date.now() - ageMin * 60000).toISOString(),
    interval: '1h',
    universe: 120,
    rows,
  };
}

const row = (over = {}) => ({
  symbol: 'ABCUSDT', interval: '1h', dir: 'long', grade: 'A', score: 75,
  entry: 100, stop: 95, rr: 3, riskPct: 5,
  targets: [{ name: 'TP1', price: 115, rr: 3 }],
  poiType: 'Order Block', status: 'waiting', valid: true,
  checksPassed: 8, checksTotal: 10, pd: { zone: 'discount', pct: 30 },
  ...over,
});

/** 假的 KV：用 Map 模擬，並記錄寫入 */
function makeKv() {
  const m = new Map();
  return {
    store: m,
    async get(k) { return m.get(k) ?? null; },
    async put(k, v) { m.set(k, v); },
  };
}

/** 攔截 fetch：回傳指定的 market 與價格，並收集送往 Discord 的內容*/
function stubFetch({ market, prices, discord }) {
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.startsWith(MARKET_URL)) return new Response(JSON.stringify(market), { status: 200 });
    if (u.includes('binance.com')) {
      return new Response(JSON.stringify(Object.entries(prices).map(([symbol, price]) => ({ symbol, price: String(price) }))), { status: 200 });
    }
    if (u.includes('discord')) {
      discord.push(JSON.parse(init.body));
      return new Response(null, { status: 204 });
    }
    throw new Error('未預期的請求：' + u);
  };
}

const makeEnv = (over = {}) => ({
  MARKET_URL,
  MIN_SCORE: '65',
  DISCORD_WEBHOOK_URL: 'https://discord.com/api/webhooks/1/abc',
  SMC_KV: makeKv(),
  ...over,
});

const runWorker = async (env) => {
  const res = await worker.fetch(new Request('https://w.test/run'), env);
  return res.json();
};

/* ------------------------------------------------------------------ 測試 */

test('價格回到進場區 → 推播一則提醒', async () => {
  const discord = [];
  stubFetch({ market: makeMarket([row()]), prices: { ABCUSDT: 99.9 }, discord });
  const out = await runWorker(makeEnv());
  assert.equal(out.checked, 1);
  assert.equal(out.alerts, 1);
  assert.equal(discord.length, 1);
  assert.match(discord[0].embeds[0].title, /ABC\/USDT 價格到了/);
});

test('價格還沒到 → 不推播', async () => {
  const discord = [];
  stubFetch({ market: makeMarket([row()]), prices: { ABCUSDT: 108 }, discord });
  const out = await runWorker(makeEnv());
  assert.equal(out.reached, 0);
  assert.equal(discord.length, 0);
});

test('同一個進場區不會重複通知', async () => {
  const discord = [];
  const env = makeEnv();
  stubFetch({ market: makeMarket([row()]), prices: { ABCUSDT: 99.5 }, discord });
  await runWorker(env);
  await runWorker(env);
  assert.equal(discord.length, 1, '第二次執行不應再推播');
  assert.equal(env.SMC_KV.store.size, 1);
});

test('價格已經穿過停損 → 劇本失效，不通知', async () => {
  const discord = [];
  stubFetch({ market: makeMarket([row()]), prices: { ABCUSDT: 94 }, discord });
  const out = await runWorker(makeEnv());
  assert.equal(out.reached, 0);
  assert.equal(discord.length, 0);
});

test('空單方向相反：價格漲到進場價才通知', async () => {
  const discord = [];
  const short = row({ dir: 'short', entry: 100, stop: 105, targets: [{ name: 'TP1', price: 85, rr: 3 }] });
  stubFetch({ market: makeMarket([short]), prices: { ABCUSDT: 100.05 }, discord });
  const out = await runWorker(makeEnv());
  assert.equal(out.alerts, 1);
  assert.match(discord[0].embeds[0].title, /做空/);
});

test('分數低於門檻的計畫不列入監看', async () => {
  const discord = [];
  stubFetch({ market: makeMarket([row({ score: 50 })]), prices: { ABCUSDT: 99 }, discord });
  const out = await runWorker(makeEnv());
  assert.equal(out.checked, 0);
  assert.equal(discord.length, 0);
});

test('只監看「等待回測」的計畫，已可進場的交給主推播處理', async () => {
  const discord = [];
  stubFetch({ market: makeMarket([row({ status: 'ready' })]), prices: { ABCUSDT: 99 }, discord });
  const out = await runWorker(makeEnv());
  assert.equal(out.checked, 0);
});

test('掃描結果太舊 → 整個跳過，不拿過期資料亂叫', async () => {
  const discord = [];
  stubFetch({ market: makeMarket([row()], 600), prices: { ABCUSDT: 99 }, discord });
  const out = await runWorker(makeEnv());
  assert.equal(out.skipped, 'market-too-old');
  assert.equal(discord.length, 0);
});

test('Binance 失敗時自動改用 OKX 報價', async () => {
  const discord = [];
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.startsWith(MARKET_URL)) return new Response(JSON.stringify(makeMarket([row()])), { status: 200 });
    if (u.includes('binance.com')) return new Response('geo-blocked', { status: 451 });
    if (u.includes('okx.com')) {
      return new Response(JSON.stringify({ data: [{ instId: 'ABC-USDT', last: '99.2' }] }), { status: 200 });
    }
    if (u.includes('discord')) { discord.push(JSON.parse(init.body)); return new Response(null, { status: 204 }); }
    throw new Error('未預期的請求：' + u);
  };
  const out = await runWorker(makeEnv());
  assert.equal(out.alerts, 1, 'Binance 被擋時仍應透過 OKX 取得價格');
});

test('/status 回報設定與資料新鮮度', async () => {
  stubFetch({ market: makeMarket([row(), row({ status: 'ready' })]), prices: {}, discord: [] });
  const res = await worker.fetch(new Request('https://w.test/status'), makeEnv());
  const out = await res.json();
  assert.equal(out.hasWebhook, true);
  assert.equal(out.hasKv, true);
  assert.equal(out.market.waiting, 1);
  assert.equal(out.market.ready, 1);
});

test('dry 模式只回報不推播、也不寫入 KV', async () => {
  const discord = [];
  const env = makeEnv();
  stubFetch({ market: makeMarket([row()]), prices: { ABCUSDT: 99 }, discord });
  const res = await worker.fetch(new Request('https://w.test/run?dry=1'), env);
  const out = await res.json();
  assert.equal(out.alerts, 1);
  assert.equal(discord.length, 0);
  assert.equal(env.SMC_KV.store.size, 0);
});
