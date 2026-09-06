import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/**
 * 壓縮版必須跟未壓縮版行為完全一致。
 *
 * 壓縮只是為了讓 Cloudflare 儀表板的手動貼上在手機上可行，
 * 不能因此改變任何行為。這裡把同一組情境在兩個版本各跑一次再比對。
 */

const FULL = new URL('../public/crypto-radar-guardian.worker.js', import.meta.url).pathname;
const MIN = new URL('../public/crypto-radar-guardian.worker.min.js', import.meta.url).pathname;
const WD_FULL = new URL('../public/crypto-radar-watchdog.worker.js', import.meta.url).pathname;
const WD_MIN = new URL('../public/crypto-radar-watchdog.worker.min.js', import.meta.url).pathname;

const NOW = 1_760_000_000_000;
const KEY = 'workerkey1234567890';
const SECRET = 'workersecret1234567890';
const HOOK = 'https://discord.com/api/webhooks/123456789012345678/abcDEF-ghi_JKL123';
const TOKEN = 'admin-token-abc123';

const SYMS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'AAAUSDT', 'BBBUSDT', '1000PEPEUSDT'];
const P = Object.fromEntries(SYMS.map((s) => [s, { fc: s === 'ETHUSDT' ? 97 : 99.4, vm: s === 'BBBUSDT' ? 0.6 : 1.6 }]));

function klines({ fc, vm }) {
  const out = [];
  const step = 15 * 60_000;
  const start = NOW - 40 * step;
  for (let i = 0; i < 40; i += 1) {
    const spread = i >= 32 ? 0.15 : 0.6;
    const close = i === 39 ? fc : 100 + Math.sin(i / 3) * 0.3;
    out.push([String(start + i * step), String(close), String(close + spread),
      String(close - spread), String(close), String(i >= 37 ? 1000 * vm : 1000), '0']);
  }
  return out.reverse();
}
const oi = () => [4, 3, 2, 1, 0].map((b) => ({
  timestamp: String(NOW - b * 15 * 60_000),
  openInterest: String(1e6 * (1 + 0.012 * ((4 - b) / 4))),
}));

function result(pathname, params) {
  const sym = params.get('symbol');
  if (pathname === '/v5/market/instruments-info') {
    return { list: SYMS.map((s) => ({ symbol: s, quoteCoin: 'USDT', contractType: 'LinearPerpetual', status: 'Trading', launchTime: String(NOW - 400 * 864e5) })) };
  }
  if (pathname === '/v5/market/tickers') {
    return { list: SYMS.map((s) => ({ symbol: s, lastPrice: '100', bid1Price: '99.95', ask1Price: '100.05', highPrice24h: '104', lowPrice24h: '96', turnover24h: '5000000', openInterestValue: '2000000', price24hPcnt: '0.03', fundingRate: '0.0001' })) };
  }
  if (pathname === '/v5/market/kline') return { list: klines(P[sym]) };
  if (pathname === '/v5/market/open-interest') return { list: oi() };
  if (pathname === '/v5/market/orderbook') return { b: [['99.9', '500']], a: [['100.1', '400']] };
  if (pathname === '/v5/account/wallet-balance') {
    return { list: [{ accountType: 'UNIFIED', totalEquity: '2000', totalAvailableBalance: '1500', totalPerpUPL: '25.5', coin: [] }] };
  }
  if (pathname === '/v5/position/list') {
    return { list: [{ symbol: 'SOLUSDT', side: 'Sell', size: '10', avgPrice: '200', markPrice: '198', leverage: '3', unrealisedPnl: '20', positionValue: '1980', takeProfit: '0', stopLoss: '0', liqPrice: '260' }] };
  }
  if (pathname === '/v5/position/closed-pnl') return { list: [] };
  throw new Error('未預期的端點 ' + pathname);
}

/** 跑一輪排程加四個端點，回傳可比對的快照 */
async function snapshot(modulePath) {
  const calls = [];
  const posts = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const u = new URL(String(url));
    calls.push(u.pathname);
    if (u.hostname.endsWith('discord.com')) {
      posts.push(init?.body);
      return new Response('', { status: 204 });
    }
    return new Response(JSON.stringify({ retCode: 0, retMsg: 'OK', result: result(u.pathname, u.searchParams) }),
      { status: 200, headers: { 'content-type': 'application/json' } });
  };

  const store = new Map();
  const kv = {
    async get(k) { return store.has(k) ? store.get(k) : null; },
    async put(k, v) { store.set(k, v); },
  };
  const env = {
    GUARDIAN_KV: kv, BYBIT_API_KEY: KEY, BYBIT_API_SECRET: SECRET,
    DISCORD_WEBHOOK: HOOK, ADMIN_TOKEN: TOKEN,
  };

  const realLog = console.log;
  console.log = () => {};
  try {
    const worker = (await import(modulePath + '?t=' + Date.now() + Math.random())).default;
    await worker.scheduled({}, env, {});

    const get = async (p) => {
      const res = await worker.fetch(new Request('https://x.workers.dev' + p), env, {});
      return { status: res.status, body: await res.text() };
    };

    const status = await get('/api/status');
    const health = await get('/health');
    const page = await get('/');
    const authed = await get('/?token=' + TOKEN);

    const latest = JSON.parse(store.get('state:latest'));
    const statusBody = JSON.parse(status.body);
    // 兩次執行的時間本來就不同，比對前抹掉時間欄位
    for (const k of ['heartbeatAt', 'lastScanAt', 'heartbeatAgeSeconds']) delete statusBody[k];

    return {
      calls: calls.filter((c) => c.startsWith('/v5')).sort(),
      discordCount: posts.length,
      kvKeys: [...store.keys()].sort(),
      analyzedCount: latest.analyzedCount,
      universeCount: latest.universeCount,
      mainSymbols: latest.groups.main.map((c) => c.symbol),
      memeSymbols: latest.groups.meme.map((c) => c.symbol),
      scores: [...latest.groups.main, ...latest.groups.meme].map((c) => `${c.symbol}:${c.score}:${c.entryReady}`),
      reasons: [...latest.groups.main, ...latest.groups.meme].flatMap((c) => c.blockingReasons),
      statusBody,
      healthStatus: health.status,
      healthBody: JSON.parse(health.body).status,
      pageHasAccount: page.body.includes('Bybit 帳戶'),
      authedHasAccount: authed.body.includes('Bybit 帳戶'),
      authedHasProtectionWarning: authed.body.includes('沒有 TP 也沒有 SL'),
      pageHasSections: /<h2>主幣/.test(page.body) && /<h2>迷因幣/.test(page.body),
    };
  } finally {
    console.log = realLog;
    globalThis.fetch = original;
  }
}

/* ------------------------------------------------------------------ */

test('壓縮版確實匯出可用的 default handler', async () => {
  // esbuild 會把 export default 改寫成 export{X as default}，
  // 語意相同。與其比對字串，不如直接 import 看拿不拿得到。
  for (const path of [MIN, WD_MIN]) {
    const mod = await import(path + '?t=' + Date.now() + Math.random());
    assert.equal(typeof mod.default, 'object', `${path} 沒有 default 匯出`);
    assert.equal(typeof mod.default.fetch, 'function', `${path} 缺少 fetch handler`);
    assert.equal(typeof mod.default.scheduled, 'function', `${path} 缺少 scheduled handler`);
  }
});

test('壓縮版明顯比未壓縮版短，貼上負擔小很多', () => {
  const full = readFileSync(FULL, 'utf8').split('\n').length;
  const min = readFileSync(MIN, 'utf8').split('\n').length;
  assert.ok(min < full / 5, `未壓縮 ${full} 行、壓縮 ${min} 行，壓縮幅度不足`);
});

test('壓縮版與未壓縮版的行為完全一致', async () => {
  const full = await snapshot(FULL);
  const min = await snapshot(MIN);
  assert.deepEqual(min, full, '壓縮不得改變任何行為');
});

test('壓縮版仍然只呼叫唯讀端點', async () => {
  const snap = await snapshot(MIN);
  for (const p of snap.calls) {
    assert.match(p, /^\/v5\/(market\/|account\/wallet-balance|position\/list|position\/closed-pnl)/, p);
  }
});

test('壓縮版的授權判斷沒有被最佳化掉', async () => {
  const snap = await snapshot(MIN);
  assert.equal(snap.pageHasAccount, false, '無 Token 不得顯示帳戶');
  assert.equal(snap.authedHasAccount, true, '帶 Token 應顯示帳戶');
  assert.equal(snap.authedHasProtectionWarning, true);
});

test('壓縮版不含任何憑證值', () => {
  const min = readFileSync(MIN, 'utf8');
  assert.doesNotMatch(min, /discord\.com\/api\/webhooks\/\d+/);
  assert.doesNotMatch(min, /(apiKey|apiSecret)\s*[:=]\s*['"][A-Za-z0-9_-]{16,}['"]/i);
});

test('守衛壓縮版的排程與端點都正常', async () => {
  const original = globalThis.fetch;
  const posts = [];
  globalThis.fetch = async (url, init) => {
    const u = new URL(String(url));
    if (u.hostname.endsWith('discord.com')) { posts.push(init?.body); return new Response('', { status: 204 }); }
    return new Response(JSON.stringify({ ok: false, status: 'stale', ageSeconds: 1800, heartbeatAt: NOW }), { status: 503 });
  };
  try {
    const store = new Map();
    const kv = {
      async get(k) { return store.has(k) ? store.get(k) : null; },
      async put(k, v) { store.set(k, v); },
    };
    const env = { WATCHDOG_KV: kv, GUARDIAN_URL: 'https://g.example.dev', DISCORD_WEBHOOK: HOOK };
    const realLog = console.log;
    console.log = () => {};
    const worker = (await import(WD_MIN + '?t=' + Date.now() + Math.random())).default;
    await worker.scheduled({}, env, {});
    assert.equal(posts.length, 0, '第一次不該告警');
    await worker.scheduled({}, env, {});
    assert.equal(posts.length, 1, '第二次才告警');
    console.log = realLog;

    const res = await worker.fetch(new Request('https://w.example.dev/'), env, {});
    const body = await res.json();
    assert.equal(body.role, 'discord-heartbeat-watchdog');
    assert.equal(body.alerting, true);
  } finally {
    globalThis.fetch = original;
  }
});

test('壓縮版沒有超長單行', () => {
  // Cloudflare 儀表板用的 Monaco 編輯器對超長行處理很差，
  // 一萬多字元的單行可能讓它卡住或按 Deploy 沒反應。
  for (const [name, path] of [['Guardian', MIN], ['守衛', WD_MIN]]) {
    const longest = readFileSync(path, 'utf8')
      .split('\n')
      .reduce((max, line) => Math.max(max, line.length), 0);
    assert.ok(longest <= 600, `${name} 壓縮版最長一行 ${longest} 字元，對編輯器不友善`);
  }
});

test('未壓縮版也沒有超長單行', () => {
  for (const [name, path] of [['Guardian', FULL], ['守衛', WD_FULL]]) {
    const longest = readFileSync(path, 'utf8')
      .split('\n')
      .reduce((max, line) => Math.max(max, line.length), 0);
    assert.ok(longest <= 600, `${name} 最長一行 ${longest} 字元`);
  }
});
