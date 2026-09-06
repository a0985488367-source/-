import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const PATH = new URL('../public/crypto-radar-guardian.scriptable.js', import.meta.url).pathname;
const source = readFileSync(PATH, 'utf8');
const NOW = Date.now();

/* ---------- Bybit 回應樣本 ---------- */

const SYMS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'AAAUSDT', 'BBBUSDT', '1000PEPEUSDT'];
const PROFILE = {
  BTCUSDT: { fc: 99.4, vm: 1.6, oi: 1.2, c: 3 },
  ETHUSDT: { fc: 97.0, vm: 1.0, oi: 1.2, c: 3 },
  SOLUSDT: { fc: 99.4, vm: 1.6, oi: 1.2, c: 3 },
  AAAUSDT: { fc: 99.4, vm: 1.6, oi: 1.2, c: 3 },
  BBBUSDT: { fc: 99.4, vm: 0.6, oi: 1.2, c: 3 },
  '1000PEPEUSDT': { fc: 99.4, vm: 1.6, oi: 1.2, c: 3 },
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

const FAKE_KEY = 'fakekey1234567890';
const FAKE_SECRET = 'fakesecret1234567890';
const FAKE_HOOK = 'https://discord.com/api/webhooks/123456789012345678/abcDEF-ghi_JKL123';

function publicFixture(url) {
  const [path, qs] = url.split('?');
  const params = new URLSearchParams(qs ?? '');
  const p = path.replace('https://api.bybit.com', '');
  const sym = params.get('symbol');

  if (p === '/v5/market/instruments-info') {
    return { list: SYMS.map((s) => ({
      symbol: s, quoteCoin: 'USDT', contractType: 'LinearPerpetual',
      status: 'Trading', launchTime: String(NOW - 400 * 864e5),
    })) };
  }
  if (p === '/v5/market/tickers') {
    return { list: SYMS.map((s) => ({
      symbol: s, lastPrice: '100', bid1Price: '99.95', ask1Price: '100.05',
      highPrice24h: '104', lowPrice24h: '96', turnover24h: '5000000',
      openInterestValue: '2000000', price24hPcnt: String(PROFILE[s].c / 100),
      fundingRate: '0.0001',
    })) };
  }
  if (p === '/v5/market/kline') return { list: klines(PROFILE[sym]) };
  if (p === '/v5/market/open-interest') return { list: oiSeries(PROFILE[sym].oi) };
  if (p === '/v5/market/orderbook') {
    return { b: [['99.9', '500'], ['99.7', '800']], a: [['100.1', '400'], ['100.3', '700']] };
  }
  if (p === '/v5/account/wallet-balance') {
    return { list: [{ accountType: 'UNIFIED', totalEquity: '2000', totalAvailableBalance: '1500',
      totalPerpUPL: '25.5', coin: [{ coin: 'USDT', equity: '2000', availableToWithdraw: '1500' }] }] };
  }
  if (p === '/v5/position/list') {
    return { list: [
      { symbol: 'BTCUSDT', side: 'Buy', size: '0.5', avgPrice: '90000', markPrice: '91000',
        leverage: '3', unrealisedPnl: '500', positionValue: '45500',
        takeProfit: '95000', stopLoss: '88000', liqPrice: '70000' },
      { symbol: 'SOLUSDT', side: 'Sell', size: '10', avgPrice: '200', markPrice: '198',
        leverage: '3', unrealisedPnl: '20', positionValue: '1980',
        takeProfit: '0', stopLoss: '0', liqPrice: '260' },
    ] };
  }
  if (p === '/v5/position/closed-pnl') {
    return { list: [{ symbol: 'ETHUSDT', side: 'Sell', closedPnl: '42.5', avgEntryPrice: '3000',
      avgExitPrice: '3050', closedSize: '1', leverage: '3', createdTime: String(NOW - 3600_000) }] };
  }
  throw new Error('未預期的端點 ' + p);
}

/**
 * 在 Node 裡模擬 Scriptable 的執行環境，實際跑完整份產生後的腳本。
 */
async function runInFakeScriptable({ withCreds = false, withWebhook = false, runsInApp = false } = {}) {
  const calls = [];
  const signedHeaders = [];
  const discordPosts = [];
  let presentedHtml = null;
  const alerts = [];
  const store = new Map();

  if (withCreds) {
    store.set('crg.bybit.apiKey', FAKE_KEY);
    store.set('crg.bybit.apiSecret', FAKE_SECRET);
  }
  if (withWebhook) store.set('crg.discord.webhook', FAKE_HOOK);

  globalThis.Keychain = {
    contains: (k) => store.has(k),
    get: (k) => store.get(k),
    set: (k, v) => store.set(k, v),
    remove: (k) => store.delete(k),
  };
  globalThis.config = { runsInApp };
  globalThis.Request = class {
    constructor(url) { this.url = url; this.headers = {}; this.response = { statusCode: 200 }; }
    async loadJSON() {
      calls.push(this.url);
      if (this.headers['X-BAPI-SIGN']) signedHeaders.push({ url: this.url, headers: this.headers });
      return { retCode: 0, retMsg: 'OK', result: publicFixture(this.url) };
    }
    async loadString() {
      if (this.url.includes('discord.com')) { discordPosts.push({ url: this.url, body: this.body }); return ''; }
      throw new Error('未預期的 POST ' + this.url);
    }
  };
  globalThis.WebView = class {
    async loadHTML(html) { presentedHtml = html; }
    async present() { return true; }
  };
  globalThis.Alert = class {
    constructor() { this.title = ''; this.message = ''; }
    addAction() {} addDestructiveAction() {} addCancelAction() {}
    addTextField() {} addSecureTextField() {}
    textFieldValue() { return ''; }
    async present() { alerts.push(this.title + '｜' + this.message); return -1; }
    async presentSheet() { alerts.push(this.title + '｜' + this.message); return -1; }
  };
  globalThis.Script = { complete() {} };
  const realLog = console.log;
  console.log = () => {};
  try {
    await import(PATH + '?t=' + Date.now() + Math.random());
  } finally {
    console.log = realLog;
  }
  return { calls, signedHeaders, discordPosts, html: presentedHtml, alerts, store };
}

/* ------------------------------------------------------------------ */

test('產生後的腳本語法正確', () => {
  execFileSync(process.execPath, ['--check', PATH], { stdio: 'pipe' });
});

test('內嵌時已去除 import 與 export', () => {
  assert.doesNotMatch(source, /^export\s/m);
  assert.doesNotMatch(source, /^import\s/m);
});

test('檔頭說明涵蓋安裝、主畫面、Bybit 與 Discord', () => {
  assert.match(source, /App Store 安裝免費的 Scriptable/);
  assert.match(source, /加入主畫面/);
  assert.match(source, /只讀」權限的 API Key/);
  assert.match(source, /Webhook/);
  assert.match(source, /不需要電腦/);
});

test('沒有任何下單、改單、撤單或提領的程式路徑', () => {
  for (const forbidden of [
    '/v5/order/create', '/v5/order/amend', '/v5/order/cancel',
    '/v5/position/trading-stop', '/v5/position/set-leverage',
    '/v5/asset/transfer', '/v5/asset/withdraw',
    'placeOrder', 'submitOrder',
  ]) {
    // 這些字串只允許出現在「禁止清單」的定義裡，不得出現在實際呼叫
    const callSites = [...source.matchAll(/bybit(?:Public|Signed)\('([^']+)'/g)].map((m) => m[1]);
    assert.ok(!callSites.includes(forbidden), `不得呼叫 ${forbidden}`);
  }
});

test('所有實際呼叫的端點都在允許範圍內', () => {
  const publicCalls = [...source.matchAll(/bybitPublic\('([^']+)'/g)].map((m) => m[1]);
  const signedCalls = [...source.matchAll(/bybitSigned\('([^']+)'/g)].map((m) => m[1]);
  assert.ok(publicCalls.length >= 5);
  for (const p of publicCalls) assert.match(p, /^\/v5\/market\//, `${p} 應為公開行情端點`);
  assert.ok(signedCalls.length >= 3);
  for (const p of signedCalls) {
    assert.match(p, /^\/v5\/(account\/wallet-balance|position\/list|position\/closed-pnl|execution\/list|order\/realtime)$/,
      `${p} 不在唯讀白名單內`);
  }
});

test('憑證只從 Keychain 取得，原始碼裡沒有任何憑證值', () => {
  assert.match(source, /Keychain\.get/);
  assert.match(source, /Keychain\.set/);
  // 不得有看起來像實際金鑰的字面值
  assert.doesNotMatch(source, /(apiKey|apiSecret|webhook)\s*[:=]\s*['"][A-Za-z0-9_-]{12,}['"]/i);
  assert.doesNotMatch(source, /discord\.com\/api\/webhooks\/\d+/, '不得內嵌實際 webhook');
});

test('autoTradeEligible 恆為 false', () => {
  assert.match(source, /autoTradeEligible: false/);
  assert.doesNotMatch(source, /autoTradeEligible:\s*true/);
});

test('未設定憑證時可完整執行，且不呼叫任何私有端點', async () => {
  const { calls, signedHeaders, html, alerts } = await runInFakeScriptable();
  assert.deepEqual(alerts, [], '不應出現錯誤警示');
  assert.ok(html, 'WebView 應收到 HTML');
  assert.equal(signedHeaders.length, 0, '沒有憑證時不得發出簽章請求');
  for (const url of calls) {
    assert.ok(url.startsWith('https://api.bybit.com/v5/market/'), url);
  }
});

test('主幣與迷因幣分兩區顯示', async () => {
  const { html } = await runInFakeScriptable();
  assert.match(html, /<h2>主幣/);
  assert.match(html, /<h2>迷因幣／高風險/);
  assert.match(html, /BTCUSDT/);
  assert.match(html, /1000PEPEUSDT/);
  assert.match(html, /固定 0\.15% 防守倉/);
});

test('設定憑證後會讀取帳戶，且簽章標頭齊全', async () => {
  const { signedHeaders, html } = await runInFakeScriptable({ withCreds: true });
  assert.equal(signedHeaders.length, 3, '應呼叫錢包、持倉、已平倉三個端點');
  for (const { headers } of signedHeaders) {
    assert.equal(headers['X-BAPI-API-KEY'], FAKE_KEY);
    assert.match(headers['X-BAPI-SIGN'], /^[0-9a-f]{64}$/, '簽章應為 64 位十六進位');
    assert.ok(headers['X-BAPI-TIMESTAMP']);
    assert.equal(headers['X-BAPI-RECV-WINDOW'], '5000');
  }
  assert.match(html, /Bybit 帳戶 · 唯讀/);
  assert.match(html, /總權益/);
});

test('帳戶畫面永遠不含 API Key 或 Secret 的完整值', async () => {
  const { html } = await runInFakeScriptable({ withCreds: true });
  assert.ok(!html.includes(FAKE_SECRET), '畫面不得出現 Secret');
  assert.ok(!html.includes(FAKE_KEY), '畫面不得出現完整 API Key');
  assert.match(html, /fake••••7890/, '應顯示遮罩後的 Key');
});

test('持倉缺少 TP／SL 會在畫面上標示', async () => {
  const { html } = await runInFakeScriptable({ withCreds: true });
  assert.match(html, /沒有 TP 也沒有 SL/);
  assert.match(html, /TP／SL 皆已設定/);
});

test('設定 Discord 後會送出通知，內容不含憑證', async () => {
  const { discordPosts } = await runInFakeScriptable({ withCreds: true, withWebhook: true });
  assert.ok(discordPosts.length > 0, '應送出通知');
  for (const post of discordPosts) {
    assert.equal(post.url, FAKE_HOOK);
    assert.ok(!post.body.includes(FAKE_SECRET));
    assert.ok(!post.body.includes(FAKE_KEY));
    const payload = JSON.parse(post.body);
    assert.deepEqual(payload.allowed_mentions, { parse: [] });
  }
  const joined = discordPosts.map((p) => p.body).join('\n');
  assert.match(joined, /不是勝率|不會替你掛單/);
});

test('同一次執行內，通知狀態會寫回 Keychain 供下次去重', async () => {
  const { store } = await runInFakeScriptable({ withCreds: true, withWebhook: true });
  const raw = store.get('crg.notify.state');
  assert.ok(raw, '應寫入通知狀態');
  const parsed = JSON.parse(raw);
  assert.ok(Object.keys(parsed.sent).length > 0);
});

test('沒有 webhook 時不會嘗試送出通知', async () => {
  const { discordPosts } = await runInFakeScriptable({ withCreds: true, withWebhook: false });
  assert.equal(discordPosts.length, 0);
});

test('從 Scriptable App 內執行會顯示選單而不是直接掃描', async () => {
  const { alerts, calls } = await runInFakeScriptable({ runsInApp: true });
  assert.ok(alerts.length > 0, '應顯示選單');
  assert.match(alerts[0], /Crypto Radar Guardian/);
  assert.match(alerts[0], /未連接/);
  assert.equal(calls.length, 0, '選單階段不應發出請求');
});

test('畫面帶有免責聲明，且不承諾獲利', async () => {
  const { html } = await runInFakeScriptable();
  assert.match(html, /不是勝率/);
  assert.match(html, /永遠不會下單/);
  assert.match(html, /可能損失全部本金/);
  for (const pattern of [/保證獲利/, /穩賺/, /百倍報酬/]) {
    assert.doesNotMatch(html, pattern);
  }
});

test('產生器輸出是決定性的', () => {
  const before = readFileSync(PATH, 'utf8');
  execFileSync(process.execPath, ['scripts/build-scriptable-app.mjs'], {
    cwd: new URL('..', import.meta.url).pathname, stdio: 'pipe',
  });
  assert.equal(readFileSync(PATH, 'utf8'), before);
});

/* ------------------------------------------------------------------ */
/* 環境切換（對應 retCode 10003 的實際故障）                             */
/* ------------------------------------------------------------------ */

/** 讓模擬環境可以指定 Keychain 內容並攔截所有請求主機 */
async function runWithEnv(env, { retCode = 0 } = {}) {
  const hosts = [];
  const errors = [];
  let presentedHtml = null;
  const store = new Map([
    ['crg.bybit.apiKey', FAKE_KEY],
    ['crg.bybit.apiSecret', FAKE_SECRET],
  ]);
  if (env) store.set('crg.bybit.env', env);

  globalThis.Keychain = {
    contains: (k) => store.has(k),
    get: (k) => store.get(k),
    set: (k, v) => store.set(k, v),
    remove: (k) => store.delete(k),
  };
  globalThis.config = { runsInApp: false };
  globalThis.Request = class {
    constructor(url) { this.url = url; this.headers = {}; this.response = { statusCode: 200 }; }
    async loadJSON() {
      hosts.push(new URL(this.url).origin + new URL(this.url).pathname);
      if (this.headers['X-BAPI-SIGN'] && retCode !== 0) {
        return { retCode, retMsg: 'API key is invalid.', result: {} };
      }
      return { retCode: 0, retMsg: 'OK', result: publicFixture(this.url) };
    }
    async loadString() { return ''; }
  };
  globalThis.WebView = class {
    async loadHTML(html) { presentedHtml = html; }
    async present() { return true; }
  };
  globalThis.Alert = class {
    constructor() { this.title = ''; this.message = ''; }
    addAction() {} addDestructiveAction() {} addCancelAction() {}
    addTextField() {} addSecureTextField() {}
    textFieldValue() { return ''; }
    async present() { errors.push(this.title + '｜' + this.message); return -1; }
    async presentSheet() { return -1; }
  };
  globalThis.Script = { complete() {} };
  const realLog = console.log;
  console.log = () => {};
  try {
    await import(PATH + '?t=' + Date.now() + Math.random());
  } finally {
    console.log = realLog;
  }
  return { hosts, html: presentedHtml, errors };
}

test('未設定環境時，私有端點打正式站', async () => {
  const { hosts } = await runWithEnv(null);
  const signed = hosts.filter((h) => !h.includes('/v5/market/'));
  assert.ok(signed.length > 0);
  for (const h of signed) assert.ok(h.startsWith('https://api.bybit.com/'), h);
});

test('選模擬交易時，私有端點改打 api-demo，行情仍走正式站', async () => {
  const { hosts } = await runWithEnv('demo');
  const signed = hosts.filter((h) => !h.includes('/v5/market/'));
  const market = hosts.filter((h) => h.includes('/v5/market/'));
  assert.ok(signed.length > 0);
  for (const h of signed) assert.ok(h.startsWith('https://api-demo.bybit.com/'), h);
  for (const h of market) assert.ok(h.startsWith('https://api.bybit.com/'), `Demo 應共用正式站行情：${h}`);
});

test('選測試網時，行情與私有端點都改打 api-testnet', async () => {
  const { hosts } = await runWithEnv('testnet');
  for (const h of hosts) assert.ok(h.startsWith('https://api-testnet.bybit.com/'), h);
});

test('retCode 10003 會在畫面上說清楚環境可能選錯', async () => {
  const { html } = await runWithEnv('live', { retCode: 10003 });
  assert.match(html, /無法讀取帳戶資料/);
  assert.match(html, /環境選錯/);
  assert.match(html, /模擬交易與測試網各自發自己的 Key/);
  assert.ok(!html.includes(FAKE_SECRET));
});

test('簽章帶上 X-BAPI-SIGN-TYPE', () => {
  assert.match(source, /'X-BAPI-SIGN-TYPE': '2'/);
});

test('憑證讀出時會先清掉不可見字元', () => {
  assert.match(source, /sanitizeCredential\(kcGet\(KEY_API_KEY\)\)/);
  assert.match(source, /sanitizeCredential\(kcGet\(KEY_API_SECRET\)\)/);
});
