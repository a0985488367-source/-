import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const PATH = new URL('../public/crypto-radar-guardian.scriptable.js', import.meta.url).pathname;
const source = readFileSync(PATH, 'utf8');
const NOW = Date.now();

/* ---------- Bybit 回應樣本 ---------- */

const SYMS = ['AAAUSDT', 'BBBUSDT', '1000PEPEUSDT', 'CCCUSDT'];
const PROFILE = {
  AAAUSDT: { finalClose: 99.4, volMul: 1.6, oiPct: 1.2, ch24: 3 },
  BBBUSDT: { finalClose: 99.4, volMul: 0.6, oiPct: 1.2, ch24: 3 },
  '1000PEPEUSDT': { finalClose: 99.4, volMul: 1.6, oiPct: 1.2, ch24: 3 },
  CCCUSDT: { finalClose: 97.0, volMul: 1.6, oiPct: 1.2, ch24: 3 },
};

function klines({ finalClose, volMul }) {
  const out = [];
  const step = 15 * 60_000;
  const start = NOW - 40 * step;
  for (let i = 0; i < 40; i += 1) {
    const late = i >= 32;
    const spread = late ? 0.15 : 0.6;
    const close = i === 39 ? finalClose : 100 + Math.sin(i / 3) * 0.3;
    const vol = i >= 37 ? 1000 * volMul : 1000;
    out.push([String(start + i * step), String(close), String(close + spread),
      String(close - spread), String(close), String(vol), '0']);
  }
  return out.reverse();
}

const oi = (pct) => [4, 3, 2, 1, 0].map((b) => ({
  timestamp: String(NOW - b * 15 * 60_000),
  openInterest: String(1e6 * (1 + (pct / 100) * ((4 - b) / 4))),
}));

function fixtureFor(url) {
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
      openInterestValue: '2000000', price24hPcnt: String(PROFILE[s].ch24 / 100),
      fundingRate: '0.0001',
    })) };
  }
  if (p === '/v5/market/kline') return { list: klines(PROFILE[sym]) };
  if (p === '/v5/market/open-interest') return { list: oi(PROFILE[sym].oiPct) };
  if (p === '/v5/market/orderbook') {
    return { b: [['99.9', '500'], ['99.7', '800']], a: [['100.1', '400'], ['100.3', '700']] };
  }
  throw new Error('未預期的端點 ' + p);
}

/**
 * 在 Node 裡模擬 Scriptable 的執行環境，實際跑完整份產生後的腳本。
 * 回傳 WebView 收到的 HTML 與所有被呼叫的 URL。
 */
async function runInFakeScriptable() {
  const calls = [];
  let presentedHtml = null;
  const alerts = [];

  globalThis.Request = class {
    constructor(url) { this.url = url; this.headers = {}; }
    async loadJSON() {
      calls.push(this.url);
      return { retCode: 0, retMsg: 'OK', result: fixtureFor(this.url) };
    }
  };
  globalThis.WebView = class {
    async loadHTML(html) { presentedHtml = html; }
    async present() { return true; }
  };
  globalThis.Alert = class {
    constructor() { this.title = ''; this.message = ''; }
    addAction() {}
    async present() { alerts.push(this.title + '：' + this.message); }
  };
  globalThis.Script = { complete() {} };
  globalThis.console = { ...console, log: () => {} };

  await import(PATH + '?t=' + Date.now());
  return { calls, html: presentedHtml, alerts };
}

/* ------------------------------------------------------------------ */

test('產生後的腳本語法正確', () => {
  execFileSync(process.execPath, ['--check', PATH], { stdio: 'pipe' });
});

test('內嵌時已去除 import 與 export，可在單一作用域執行', () => {
  assert.doesNotMatch(source, /^export\s/m);
  assert.doesNotMatch(source, /^import\s/m);
  assert.match(source, /function buildCandidate\(/);
  assert.match(source, /function cardHtml\(/);
});

test('檔頭有給使用者的安裝說明', () => {
  assert.match(source, /Scriptable/);
  assert.match(source, /不需要電腦/);
  assert.match(source, /不需要也不接受 API Key/);
});

test('只呼叫 Bybit 公開行情端點，且不含簽章或金鑰邏輯', () => {
  const paths = [...source.matchAll(/bybit\('(\/v5\/[^']+)'/g)].map((m) => m[1]);
  assert.ok(paths.length >= 5, `應呼叫多個端點，實得 ${paths.length}`);
  for (const p of paths) assert.match(p, /^\/v5\/market\//, `${p} 不是公開端點`);
  for (const forbidden of ['/v5/order', '/v5/position', '/v5/account', '/v5/asset']) {
    assert.ok(!source.includes(forbidden), `不得呼叫 ${forbidden}`);
  }
  for (const pattern of [/api[-_]?key/i, /hmac/i, /X-BAPI/i, /apiSecret/i]) {
    assert.doesNotMatch(source, pattern, `不得包含 ${pattern}`);
  }
});

test('沒有任何下單路徑', () => {
  for (const forbidden of ['placeOrder', 'create-order', 'submitOrder']) {
    assert.ok(!source.includes(forbidden), `不得包含 ${forbidden}`);
  }
  assert.match(source, /autoTradeEligible: false/);
});

test('在模擬的 Scriptable 環境中可完整執行並產生畫面', async () => {
  const { calls, html, alerts } = await runInFakeScriptable();
  assert.deepEqual(alerts, [], '不應出現錯誤警示');
  assert.ok(html, 'WebView 應收到 HTML');
  assert.match(html, /^<!doctype html>/i);
  assert.match(html, /<\/html>$/);
  assert.ok(calls.length >= 5, `應發出多次請求，實得 ${calls.length}`);
  for (const url of calls) {
    assert.ok(url.startsWith('https://api.bybit.com/v5/market/'), url);
  }
});

test('產生的畫面包含候選卡片、閘門就緒度與阻擋原因', async () => {
  const { html } = await runInFakeScriptable();
  assert.match(html, /Crypto Radar Guardian/);
  assert.match(html, /Bybit \/v5\/market/);
  assert.match(html, /進場條件 \d+\/10/);
  assert.match(html, /class="card/);
  assert.match(html, /量能 0\.600 倍（需 1\.1 ～ 3 倍）/, '應顯示量能不足的具體原因');
  assert.match(html, /https:\/\/www\.bybit\.com\/trade\/usdt\//);
});

test('迷因幣顯示固定防守倉標籤，未知標的顯示保守標籤', async () => {
  const { html } = await runInFakeScriptable();
  assert.match(html, /迷因幣 · 固定 0\.15% 防守倉/);
  assert.match(html, /未列入主流 · 保守 0\.15% 倉位/);
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

test('沿用相同深色賽博配色', async () => {
  const { html } = await runInFakeScriptable();
  assert.match(html, /--panel:\s*#081321/);
  assert.doesNotMatch(html, /background:\s*#fff(f{3})?\b/i);
});

test('產生器輸出是決定性的', () => {
  const before = readFileSync(PATH, 'utf8');
  execFileSync(process.execPath, ['scripts/build-scriptable-app.mjs'], {
    cwd: new URL('..', import.meta.url).pathname, stdio: 'pipe',
  });
  assert.equal(readFileSync(PATH, 'utf8'), before);
});
