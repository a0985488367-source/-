import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const PATH = new URL('../public/crypto-radar-guardian.worker.js', import.meta.url).pathname;
const source = readFileSync(PATH, 'utf8');
const NOW = Date.now();

const SECRET_KEY = 'workerkey1234567890';
const SECRET_SECRET = 'workersecret1234567890';
const HOOK = 'https://discord.com/api/webhooks/123456789012345678/abcDEF-ghi_JKL123';
const TOKEN = 'admin-token-abc123';

const SYMS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'AAAUSDT', 'BBBUSDT', '1000PEPEUSDT', 'CCCUSDT'];
const PROFILE = {
  BTCUSDT: { fc: 99.4, vm: 1.6, oi: 1.2 },
  ETHUSDT: { fc: 97.0, vm: 1.0, oi: 1.2 },
  SOLUSDT: { fc: 99.4, vm: 1.6, oi: 1.2 },
  AAAUSDT: { fc: 99.4, vm: 1.6, oi: 1.2 },
  BBBUSDT: { fc: 99.4, vm: 0.6, oi: 1.2 },
  '1000PEPEUSDT': { fc: 99.4, vm: 1.6, oi: 1.2 },
  CCCUSDT: { fc: 97.0, vm: 1.2, oi: 1.2 },
};

function klines({ fc, vm }) {
  const out = [];
  const step = 15 * 60_000;
  const start = NOW - 40 * step;
  for (let i = 0; i < 40; i += 1) {
    const spread = i >= 32 ? 0.15 : 0.6;
    const close = i === 39 ? fc : 100 + Math.sin(i / 3) * 0.3;
    const vol = i >= 37 ? 1000 * vm : 1000;
    out.push([String(start + i * step), String(close), String(close + spread),
      String(close - spread), String(close), String(vol), '0']);
  }
  return out.reverse();
}
const oiSeries = (pct) => [4, 3, 2, 1, 0].map((b) => ({
  timestamp: String(NOW - b * 15 * 60_000),
  openInterest: String(1e6 * (1 + (pct / 100) * ((4 - b) / 4))),
}));

function bybitResult(pathname, params) {
  const sym = params.get('symbol');
  if (pathname === '/v5/market/instruments-info') {
    return { list: SYMS.map((s) => ({
      symbol: s, quoteCoin: 'USDT', contractType: 'LinearPerpetual',
      status: 'Trading', launchTime: String(NOW - 400 * 864e5),
    })) };
  }
  if (pathname === '/v5/market/tickers') {
    return { list: SYMS.map((s) => ({
      symbol: s, lastPrice: '100', bid1Price: '99.95', ask1Price: '100.05',
      highPrice24h: '104', lowPrice24h: '96', turnover24h: '5000000',
      openInterestValue: '2000000', price24hPcnt: '0.03', fundingRate: '0.0001',
    })) };
  }
  if (pathname === '/v5/market/kline') return { list: klines(PROFILE[sym]) };
  if (pathname === '/v5/market/open-interest') return { list: oiSeries(PROFILE[sym].oi) };
  if (pathname === '/v5/market/orderbook') {
    return { b: [['99.9', '500'], ['99.7', '800']], a: [['100.1', '400'], ['100.3', '700']] };
  }
  if (pathname === '/v5/account/wallet-balance') {
    return { list: [{ accountType: 'UNIFIED', totalEquity: '2000', totalAvailableBalance: '1500',
      totalPerpUPL: '25.5', coin: [{ coin: 'USDT', equity: '2000', availableToWithdraw: '1500' }] }] };
  }
  if (pathname === '/v5/position/list') {
    return { list: [
      { symbol: 'BTCUSDT', side: 'Buy', size: '0.5', avgPrice: '90000', markPrice: '91000',
        leverage: '3', unrealisedPnl: '500', positionValue: '45500',
        takeProfit: '95000', stopLoss: '88000', liqPrice: '70000' },
      { symbol: 'SOLUSDT', side: 'Sell', size: '10', avgPrice: '200', markPrice: '198',
        leverage: '3', unrealisedPnl: '20', positionValue: '1980',
        takeProfit: '0', stopLoss: '0', liqPrice: '260' },
    ] };
  }
  if (pathname === '/v5/position/closed-pnl') {
    return { list: [{ symbol: 'ETHUSDT', side: 'Sell', closedPnl: '42.5', avgEntryPrice: '3000',
      avgExitPrice: '3050', closedSize: '1', leverage: '3', createdTime: String(NOW - 3600_000) }] };
  }
  throw new Error('未預期的端點 ' + pathname);
}

function makeKv() {
  const store = new Map();
  return {
    store,
    async get(key) { return store.has(key) ? store.get(key) : null; },
    async put(key, value) { store.set(key, value); },
  };
}

function makeEnv(overrides = {}) {
  return { GUARDIAN_KV: null, ...overrides };
}

/** 攔截所有網路請求，記錄下來 */
function installFetch() {
  const calls = [];
  const discordPosts = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const u = new URL(String(url));
    calls.push({ url: String(url), origin: u.origin, pathname: u.pathname, headers: init?.headers ?? {} });
    if (u.hostname.endsWith('discord.com')) {
      discordPosts.push({ url: String(url), body: init?.body });
      return new Response('', { status: 204 });
    }
    const result = bybitResult(u.pathname, u.searchParams);
    return new Response(JSON.stringify({ retCode: 0, retMsg: 'OK', result }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  };
  return { calls, discordPosts, restore: () => { globalThis.fetch = original; } };
}

async function loadWorker() {
  const mod = await import(PATH + '?t=' + Date.now() + Math.random());
  return mod.default;
}

/* ------------------------------------------------------------------ */

test('產生後的 Worker 語法正確', () => {
  execFileSync(process.execPath, ['--check', PATH], { stdio: 'pipe' });
});

test('內嵌時已去除 import 與 export，只保留 default export', () => {
  assert.doesNotMatch(source, /^import\s/m);
  const exports = [...source.matchAll(/^export\s+(\w+)/gm)].map((m) => m[1]);
  assert.deepEqual(exports, ['default'], '只應有一個 default export');
});

test('部署說明涵蓋 KV、Secrets 與 Cron', () => {
  assert.match(source, /GUARDIAN_KV/);
  assert.match(source, /DISCORD_WEBHOOK/);
  assert.match(source, /ADMIN_TOKEN/);
  assert.match(source, /Cron Triggers/);
  assert.match(source, /dash\.cloudflare\.com/);
});

test('沒有任何下單、改單或提領的呼叫', () => {
  const signed = [...source.matchAll(/signedGet\('([^']+)'/g)].map((m) => m[1]);
  assert.ok(signed.length >= 3);
  for (const p of signed) {
    assert.match(p, /^\/v5\/(account\/wallet-balance|position\/list|position\/closed-pnl)$/, `${p} 不在唯讀白名單`);
  }
  const pub = [...source.matchAll(/publicGet\('([^']+)'/g)].map((m) => m[1]);
  for (const p of pub) assert.match(p, /^\/v5\/market\//, `${p} 不是公開行情端點`);
});

test('原始碼裡沒有任何憑證值', () => {
  assert.doesNotMatch(source, /(apiKey|apiSecret|webhook|token)\s*[:=]\s*['"][A-Za-z0-9_-]{16,}['"]/i);
  assert.doesNotMatch(source, /discord\.com\/api\/webhooks\/\d+/);
});

test('排程執行會完成掃描並寫入 KV', async () => {
  const net = installFetch();
  try {
    const kv = makeKv();
    const worker = await loadWorker();
    await worker.scheduled({}, makeEnv({ GUARDIAN_KV: kv }), {});

    const latest = JSON.parse(kv.store.get('state:latest'));
    assert.ok(latest.scannedAt > 0);
    assert.ok(latest.analyzedCount > 0);
    assert.ok(latest.groups.main.length > 0, '主幣區應有內容');

    const hb = JSON.parse(kv.store.get('state:heartbeat'));
    assert.equal(hb.ok, true);
    assert.match(hb.version, /Crypto Radar Guardian 10\.0/);
  } finally {
    net.restore();
  }
});

test('子請求數量遠低於 Cloudflare 免費方案的 50 個上限', async () => {
  const net = installFetch();
  try {
    const kv = makeKv();
    const worker = await loadWorker();
    await worker.scheduled({}, makeEnv({
      GUARDIAN_KV: kv, BYBIT_API_KEY: SECRET_KEY, BYBIT_API_SECRET: SECRET_SECRET, DISCORD_WEBHOOK: HOOK,
    }), {});
    assert.ok(net.calls.length < 50, `實際發出 ${net.calls.length} 個請求`);
  } finally {
    net.restore();
  }
});

test('兩段式抓取：盤口只對可進場的標的抓', async () => {
  const net = installFetch();
  try {
    const kv = makeKv();
    const worker = await loadWorker();
    await worker.scheduled({}, makeEnv({ GUARDIAN_KV: kv }), {});

    const klineCalls = net.calls.filter((c) => c.pathname === '/v5/market/kline').length;
    const bookCalls = net.calls.filter((c) => c.pathname === '/v5/market/orderbook').length;
    const latest = JSON.parse(kv.store.get('state:latest'));
    const ready = [...latest.groups.main, ...latest.groups.meme].filter((c) => c.entryReady).length;

    assert.ok(klineCalls > bookCalls, '盤口請求應少於 K 線請求');
    assert.ok(bookCalls <= Math.min(ready, 4), `盤口請求 ${bookCalls} 應不超過可進場數與上限`);
  } finally {
    net.restore();
  }
});

test('未設定憑證時完全不呼叫私有端點', async () => {
  const net = installFetch();
  try {
    const kv = makeKv();
    const worker = await loadWorker();
    await worker.scheduled({}, makeEnv({ GUARDIAN_KV: kv }), {});
    for (const c of net.calls) {
      assert.match(c.pathname, /^\/v5\/market\//, `${c.pathname} 不該被呼叫`);
    }
  } finally {
    net.restore();
  }
});

test('設定憑證後會讀帳戶，且簽章標頭齊全', async () => {
  const net = installFetch();
  try {
    const kv = makeKv();
    const worker = await loadWorker();
    await worker.scheduled({}, makeEnv({
      GUARDIAN_KV: kv, BYBIT_API_KEY: SECRET_KEY, BYBIT_API_SECRET: SECRET_SECRET,
    }), {});
    const signed = net.calls.filter((c) => c.headers['X-BAPI-SIGN']);
    assert.equal(signed.length, 3);
    for (const c of signed) {
      assert.match(c.headers['X-BAPI-SIGN'], /^[0-9a-f]{64}$/);
      assert.equal(c.headers['X-BAPI-API-KEY'], SECRET_KEY);
    }
  } finally {
    net.restore();
  }
});

test('帳戶資料存在獨立的 KV key，不會混進公開狀態', async () => {
  const net = installFetch();
  try {
    const kv = makeKv();
    const worker = await loadWorker();
    await worker.scheduled({}, makeEnv({
      GUARDIAN_KV: kv, BYBIT_API_KEY: SECRET_KEY, BYBIT_API_SECRET: SECRET_SECRET,
    }), {});
    const latest = kv.store.get('state:latest');
    assert.ok(!latest.includes('totalEquity'), '公開狀態不得含餘額');
    assert.equal(JSON.parse(latest).account, null);
    assert.ok(kv.store.get('state:account'), '帳戶資料應另存');
  } finally {
    net.restore();
  }
});

test('Discord 通知會送出，且狀態寫回 KV 供去重', async () => {
  const net = installFetch();
  try {
    const kv = makeKv();
    const worker = await loadWorker();
    await worker.scheduled({}, makeEnv({ GUARDIAN_KV: kv, DISCORD_WEBHOOK: HOOK }), {});
    assert.ok(net.discordPosts.length > 0);
    for (const p of net.discordPosts) {
      const payload = JSON.parse(p.body);
      assert.deepEqual(payload.allowed_mentions, { parse: [] });
    }
    assert.ok(kv.store.get('state:notify'), '通知狀態應寫回 KV');
  } finally {
    net.restore();
  }
});

test('第二次排程不會重送同一標的的通知', async () => {
  const net = installFetch();
  try {
    const kv = makeKv();
    const worker = await loadWorker();
    const env = makeEnv({ GUARDIAN_KV: kv, DISCORD_WEBHOOK: HOOK });
    await worker.scheduled({}, env, {});
    const first = net.discordPosts.length;
    assert.ok(first > 0);
    await worker.scheduled({}, env, {});
    assert.equal(net.discordPosts.length, first, '冷卻時間內不應重送');
  } finally {
    net.restore();
  }
});

/* ---------------- HTTP 端點 ---------------- */

async function get(worker, env, kv, path) {
  return worker.fetch(new Request('https://example.workers.dev' + path), { ...env, GUARDIAN_KV: kv }, {});
}

test('尚未掃描時 /health 回 503', async () => {
  const worker = await loadWorker();
  const res = await get(worker, makeEnv(), makeKv(), '/health');
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.equal(body.status, 'no-heartbeat');
});

test('掃描後 /health 回 200 且帶心跳年齡', async () => {
  const net = installFetch();
  try {
    const kv = makeKv();
    const worker = await loadWorker();
    await worker.scheduled({}, makeEnv({ GUARDIAN_KV: kv }), {});
    const res = await get(worker, makeEnv(), kv, '/health');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.status, 'healthy');
    assert.ok(Number.isFinite(body.ageSeconds));
    assert.match(body.version, /Crypto Radar Guardian 10\.0/);
  } finally {
    net.restore();
  }
});

test('/api/status 回報版本、排程、資料來源與唯讀模式', async () => {
  const net = installFetch();
  try {
    const kv = makeKv();
    const worker = await loadWorker();
    await worker.scheduled({}, makeEnv({ GUARDIAN_KV: kv }), {});
    const res = await get(worker, makeEnv({ DISCORD_WEBHOOK: HOOK }), kv, '/api/status');
    const body = await res.json();
    assert.match(body.version, /Crypto Radar Guardian 10\.0/);
    assert.equal(body.moonshotProvider, 'Bybit Pre-Breakout');
    assert.equal(body.cron, '每 5 分鐘');
    assert.equal(body.tradeMode, 'read-only');
    assert.equal(body.autoTrading, false);
    assert.equal(body.discordConfigured, true);
    assert.ok(body.analyzedCount > 0);
  } finally {
    net.restore();
  }
});

test('首頁是完整 HTML，主幣與迷因幣分兩區', async () => {
  const net = installFetch();
  try {
    const kv = makeKv();
    const worker = await loadWorker();
    await worker.scheduled({}, makeEnv({ GUARDIAN_KV: kv }), {});
    const res = await get(worker, makeEnv(), kv, '/');
    assert.equal(res.headers.get('content-type'), 'text/html; charset=utf-8');
    const html = await res.text();
    assert.match(html, /^<!doctype html>/i);
    assert.match(html, /<h2>主幣/);
    assert.match(html, /<h2>迷因幣／高風險/);
    assert.match(html, /--panel:\s*#081321/, '樣式應內嵌');
    assert.match(html, /不是勝率/);
  } finally {
    net.restore();
  }
});

test('公開頁面不顯示帳戶餘額', async () => {
  const net = installFetch();
  try {
    const kv = makeKv();
    const worker = await loadWorker();
    const env = makeEnv({ BYBIT_API_KEY: SECRET_KEY, BYBIT_API_SECRET: SECRET_SECRET, ADMIN_TOKEN: TOKEN });
    await worker.scheduled({}, { ...env, GUARDIAN_KV: kv }, {});
    const html = await (await get(worker, env, kv, '/')).text();
    assert.ok(!html.includes('Bybit 帳戶'), '無 Token 不得顯示帳戶區');
    assert.ok(!html.includes('2000.00'), '不得洩漏餘額');
    assert.match(html, /token=/, '應提示如何檢視');
  } finally {
    net.restore();
  }
});

test('帶正確 Token 才看得到帳戶，錯誤 Token 一律拒絕', async () => {
  const net = installFetch();
  try {
    const kv = makeKv();
    const worker = await loadWorker();
    const env = makeEnv({ BYBIT_API_KEY: SECRET_KEY, BYBIT_API_SECRET: SECRET_SECRET, ADMIN_TOKEN: TOKEN });
    await worker.scheduled({}, { ...env, GUARDIAN_KV: kv }, {});

    const ok = await (await get(worker, env, kv, '/?token=' + TOKEN)).text();
    assert.match(ok, /Bybit 帳戶 · 唯讀/);
    assert.match(ok, /沒有 TP 也沒有 SL/);

    for (const bad of ['', 'wrong', TOKEN + 'x', TOKEN.slice(0, -1)]) {
      const html = await (await get(worker, env, kv, '/?token=' + bad)).text();
      assert.ok(!html.includes('Bybit 帳戶 · 唯讀'), `Token "${bad}" 不該通過`);
    }
  } finally {
    net.restore();
  }
});

test('未設定 ADMIN_TOKEN 時，任何 token 參數都不放行', async () => {
  const net = installFetch();
  try {
    const kv = makeKv();
    const worker = await loadWorker();
    const env = makeEnv({ BYBIT_API_KEY: SECRET_KEY, BYBIT_API_SECRET: SECRET_SECRET });
    await worker.scheduled({}, { ...env, GUARDIAN_KV: kv }, {});
    for (const t of ['', 'anything', 'undefined']) {
      const html = await (await get(worker, env, kv, '/?token=' + t)).text();
      assert.ok(!html.includes('Bybit 帳戶 · 唯讀'));
    }
  } finally {
    net.restore();
  }
});

test('任何回應都不含 API Secret 或 Webhook', async () => {
  const net = installFetch();
  try {
    const kv = makeKv();
    const worker = await loadWorker();
    const env = makeEnv({
      BYBIT_API_KEY: SECRET_KEY, BYBIT_API_SECRET: SECRET_SECRET,
      DISCORD_WEBHOOK: HOOK, ADMIN_TOKEN: TOKEN,
    });
    await worker.scheduled({}, { ...env, GUARDIAN_KV: kv }, {});
    for (const p of ['/', '/?token=' + TOKEN, '/health', '/api/status', '/api/scan']) {
      const text = await (await get(worker, env, kv, p)).text();
      assert.ok(!text.includes(SECRET_SECRET), `${p} 洩漏 Secret`);
      assert.ok(!text.includes(HOOK), `${p} 洩漏 Webhook`);
      assert.ok(!text.includes(SECRET_KEY), `${p} 洩漏完整 API Key`);
      assert.ok(!text.includes(TOKEN.slice(0, 8)) || p.includes('token='), `${p} 洩漏 Token`);
    }
  } finally {
    net.restore();
  }
});

test('未知路徑回 404，非 GET 回 405', async () => {
  const worker = await loadWorker();
  const kv = makeKv();
  assert.equal((await get(worker, makeEnv(), kv, '/nope')).status, 404);
  const post = await worker.fetch(
    new Request('https://example.workers.dev/', { method: 'POST' }),
    { ...makeEnv(), GUARDIAN_KV: kv }, {},
  );
  assert.equal(post.status, 405);
});

test('缺少 KV 綁定時給出明確錯誤而不是崩潰', async () => {
  const worker = await loadWorker();
  const res = await worker.fetch(new Request('https://example.workers.dev/'), {}, {});
  assert.equal(res.status, 500);
  assert.match((await res.json()).error, /GUARDIAN_KV/);
});

test('掃描失敗時仍寫入心跳，讓守衛看得到', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('network down'); };
  try {
    const kv = makeKv();
    const worker = await loadWorker();
    await worker.scheduled({}, makeEnv({ GUARDIAN_KV: kv }), {});
    const hb = JSON.parse(kv.store.get('state:heartbeat'));
    assert.equal(hb.ok, false);
    assert.match(hb.error, /network down/);

    const res = await get(worker, makeEnv(), kv, '/health');
    assert.equal(res.status, 503);
    assert.equal((await res.json()).status, 'last-run-failed');
  } finally {
    globalThis.fetch = original;
  }
});

test('產生器輸出是決定性的', () => {
  const before = readFileSync(PATH, 'utf8');
  execFileSync(process.execPath, ['scripts/build-worker.mjs'], {
    cwd: new URL('..', import.meta.url).pathname, stdio: 'pipe',
  });
  assert.equal(readFileSync(PATH, 'utf8'), before);
});
