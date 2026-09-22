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
    async delete(k) { m.delete(k); },
    async list({ prefix = '' } = {}) {
      return { keys: [...m.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })) };
    },
  };
}

/** 攔截 fetch：回傳指定的 market 與價格，並收集送往 Discord 的內容；bybit 選填，用來測自動下單 */
function stubFetch({ market, prices, discord, bybit }) {
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.startsWith(MARKET_URL)) return new Response(JSON.stringify(market), { status: 200 });
    if (u.includes('api.bybit.com/v5/market/tickers')) {
      const list = Object.entries(prices).map(([symbol, price]) => ({ symbol, lastPrice: String(price) }));
      return new Response(JSON.stringify({ retCode: 0, retMsg: 'OK', result: { list } }), { status: 200 });
    }
    if (u.includes('binance.com')) {
      return new Response(JSON.stringify(Object.entries(prices).map(([symbol, price]) => ({ symbol, price: String(price) }))), { status: 200 });
    }
    if (u.includes('discord')) {
      discord.push(JSON.parse(init.body));
      return new Response(null, { status: 204 });
    }
    if (u.includes('api-demo.bybit.com')) {
      if (!bybit) throw new Error('未預期呼叫 Bybit：' + u);
      bybit.calls?.push({ url: u, method: init.method, body: init.body ? JSON.parse(init.body) : null });
      const bybitJson = (retCode, retMsg, result) => new Response(JSON.stringify({ retCode, retMsg, result }), { status: 200 });
      if (u.includes('/v5/account/wallet-balance')) return bybitJson(0, 'OK', bybit.wallet);
      if (u.includes('/v5/market/instruments-info')) return bybitJson(0, 'OK', bybit.instrument);
      if (u.includes('/v5/position/list')) return bybitJson(0, 'OK', { list: bybit.positions ?? [] });
      if (u.includes('/v5/position/set-leverage')) {
        return bybit.leverageError ? bybitJson(bybit.leverageError.code, bybit.leverageError.msg, {}) : bybitJson(0, 'OK', {});
      }
      if (u.includes('/v5/order/create')) {
        return bybit.orderError ? bybitJson(bybit.orderError.code, bybit.orderError.msg, {}) : bybitJson(0, 'OK', bybit.orderResult ?? { orderId: 'order-123' });
      }
      if (u.includes('/v5/position/trading-stop')) {
        return bybit.tradingStopError ? bybitJson(bybit.tradingStopError.code, bybit.tradingStopError.msg, {}) : bybitJson(0, 'OK', {});
      }
      if (u.includes('/v5/order/cancel-all')) return bybitJson(0, 'OK', {});
      throw new Error('未預期的 Bybit 端點：' + u);
    }
    throw new Error('未預期的請求：' + u);
  };
}

const demoWallet = { list: [{ totalAvailableBalance: '1000' }] };
const demoInstrument = {
  list: [{
    lotSizeFilter: { qtyStep: '0.1', minOrderQty: '0.1' },
    priceFilter: { tickSize: '0.01' },
    leverageFilter: { maxLeverage: '25' },
  }],
};

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

test('Bybit 打不到時改用 Binance，Binance 也失敗才退到 OKX', async () => {
  const discord = [];
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.startsWith(MARKET_URL)) return new Response(JSON.stringify(makeMarket([row()])), { status: 200 });
    if (u.includes('api.bybit.com/v5/market/tickers')) return new Response('bybit down', { status: 500 });
    if (u.includes('binance.com')) return new Response('geo-blocked', { status: 451 });
    if (u.includes('okx.com')) {
      return new Response(JSON.stringify({ data: [{ instId: 'ABC-USDT', last: '99.2' }] }), { status: 200 });
    }
    if (u.includes('discord')) { discord.push(JSON.parse(init.body)); return new Response(null, { status: 204 }); }
    throw new Error('未預期的請求：' + u);
  };
  const out = await runWorker(makeEnv());
  assert.equal(out.alerts, 1, 'Bybit 跟 Binance 都被擋時仍應透過 OKX 取得價格');
});

test('Bybit 報價可以正常拿到時，優先用它，不會去打 Binance', async () => {
  const discord = [];
  let binanceCalled = false;
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.startsWith(MARKET_URL)) return new Response(JSON.stringify(makeMarket([row()])), { status: 200 });
    if (u.includes('api.bybit.com/v5/market/tickers')) {
      return new Response(JSON.stringify({ retCode: 0, retMsg: 'OK', result: { list: [{ symbol: 'ABCUSDT', lastPrice: '99.9' }] } }), { status: 200 });
    }
    if (u.includes('binance.com')) { binanceCalled = true; return new Response(JSON.stringify([]), { status: 200 }); }
    if (u.includes('discord')) { discord.push(JSON.parse(init.body)); return new Response(null, { status: 204 }); }
    throw new Error('未預期的請求：' + u);
  };
  const out = await runWorker(makeEnv());
  assert.equal(out.alerts, 1, '應該用 Bybit 的報價判斷進場');
  assert.equal(binanceCalled, false, 'Bybit 拿得到報價就不該再打 Binance');
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

test('/status 回報 Worker 自己掃描有沒有開', async () => {
  stubFetch({ market: makeMarket([]), prices: {}, discord: [] });
  const off = await (await worker.fetch(new Request('https://w.test/status'), makeEnv())).json();
  assert.equal(off.workerScanEnabled, false);
  assert.equal(off.workerScanTop, null);

  const on = await (await worker.fetch(new Request('https://w.test/status'), makeEnv({ WORKER_SCAN_ENABLED: 'true', WORKER_SCAN_TOP: '30' }))).json();
  assert.equal(on.workerScanEnabled, true);
  assert.equal(on.workerScanTop, 30);
});

test('/status 回報 Worker 自己掃描分批進度，不會觸發真的重新掃描', async () => {
  const env = makeEnv({ WORKER_SCAN_ENABLED: 'true', WORKER_SCAN_BATCH_SIZE: '20', WORKER_SCAN_BATCH_INTERVAL_MIN: '10' });
  globalThis.fetch = async (url) => {
    throw new Error('查 /status 不該打任何外部 API：' + url);
  };

  const empty = await (await worker.fetch(new Request('https://w.test/status'), env)).json();
  assert.equal(empty.workerScanCache, null, '還沒掃過時，快取欄位應該是 null');
  assert.equal(empty.workerScanBatchSize, 20);
  assert.equal(empty.workerScanBatchIntervalMin, 10);

  const meta = { '1h': { provider: 'bybit', interval: '1h', htfInterval: '1d', poolTotal: 120, lastBatchAt: new Date(Date.now() - 3 * 60000).toISOString() } };
  await env.SMC_KV.put('worker-scan:meta', JSON.stringify(meta));
  await env.SMC_KV.put('worker-scan:rows', JSON.stringify({ '1h::ABCUSDT': row(), '1h::DEFUSDT': row({ symbol: 'DEFUSDT' }) }));
  const withCache = await (await worker.fetch(new Request('https://w.test/status'), env)).json();
  assert.equal(withCache.workerScanCache.provider, 'bybit');
  assert.equal(withCache.workerScanCache.lastBatchAgeMinutes, 3);
  assert.equal(withCache.workerScanCache.coveredSymbols, 2);
  assert.equal(withCache.workerScanCache.poolTotal, 120);
  assert.equal(withCache.workerScanCache.perInterval.length, 1, '只設了一個週期（預設 1h），perInterval 應該只有一筆');
  assert.equal(withCache.workerScanCache.perInterval[0].interval, '1h');
  assert.equal(withCache.workerScanCache.perInterval[0].provider, 'bybit');
});

test('/status 的 perInterval 逐一列出每個週期各自的批次進度', async () => {
  const env = makeEnv({ WORKER_SCAN_ENABLED: 'true', WORKER_SCAN_INTERVAL: '3m,1h' });
  globalThis.fetch = async (url) => {
    throw new Error('查 /status 不該打任何外部 API：' + url);
  };
  const meta = {
    '3m': { provider: 'demo', interval: '3m', htfInterval: '1h', poolTotal: 12, lastBatchAt: new Date(Date.now() - 2 * 60000).toISOString() },
    '1h': { provider: 'demo', interval: '1h', htfInterval: '1d', poolTotal: 12, lastBatchAt: new Date(Date.now() - 8 * 60000).toISOString() },
  };
  await env.SMC_KV.put('worker-scan:meta', JSON.stringify(meta));
  await env.SMC_KV.put('worker-scan:rows', JSON.stringify({
    '3m::ABCUSDT': row({ interval: '3m' }),
    '1h::ABCUSDT': row({ interval: '1h' }),
  }));
  const out = await (await worker.fetch(new Request('https://w.test/status'), env)).json();
  assert.equal(out.workerScanCache.coveredSymbols, 2, '兩個週期各自的 row 都要算進去（不同週期不算重複）');
  assert.equal(out.workerScanCache.provider, 'demo', '取最新更新那個週期（3m）當代表');
  assert.equal(out.workerScanCache.lastBatchAgeMinutes, 2);
  const byInterval = Object.fromEntries(out.workerScanCache.perInterval.map((p) => [p.interval, p]));
  assert.equal(byInterval['3m'].lastBatchAgeMinutes, 2);
  assert.equal(byInterval['1h'].lastBatchAgeMinutes, 8);
});

/* -------------------------------------------------------- Worker 自己掃描 */

test('WORKER_SCAN_ENABLED 開啟時，Worker 自己即時掃描，不去讀 data/market.json', async () => {
  const discord = [];
  const env = makeEnv({ WORKER_SCAN_ENABLED: 'true', WORKER_SCAN_PROVIDERS: 'demo', WORKER_SCAN_TOP: '5' });
  let marketUrlCalled = false;
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.startsWith(MARKET_URL)) { marketUrlCalled = true; return new Response('不該被呼叫', { status: 500 }); }
    if (u.includes('api.bybit.com/v5/market/tickers')) return new Response(JSON.stringify({ retCode: 0, retMsg: 'OK', result: { list: [] } }), { status: 200 });
    if (u.includes('binance.com')) return new Response(JSON.stringify([]), { status: 200 });
    if (u.includes('discord')) { discord.push(JSON.parse(init.body)); return new Response(null, { status: 204 }); }
    throw new Error('未預期的請求：' + u);
  };
  const out = await runWorker(env);
  assert.equal(marketUrlCalled, false, '開了 Worker 自己掃描就不該再去讀 data/market.json');
  assert.equal(typeof out.checked, 'number', '掃描應該正常跑完、回傳正常結構');
  assert.equal(out.skipped, undefined, '剛掃完的資料一定是新鮮的，不該被判定成太舊');
});

test('WORKER_SCAN_ENABLED 關閉（預設）時，還是照舊讀 data/market.json', async () => {
  const discord = [];
  const env = makeEnv();
  stubFetch({ market: makeMarket([row()]), prices: { ABCUSDT: 99.9 }, discord });
  const out = await runWorker(env);
  assert.equal(out.alerts, 1, '預設行為不該被這次改動影響');
});

test('還沒輪到下一批時，直接沿用累積結果，不會真的重新掃描', async () => {
  const discord = [];
  const env = makeEnv({ WORKER_SCAN_ENABLED: 'true', WORKER_SCAN_PROVIDERS: 'demo', WORKER_SCAN_BATCH_INTERVAL_MIN: '15' });
  const fakeMeta = {
    '1h': {
      provider: 'CACHED-FAKE-MARKER', interval: '1h', htfInterval: '1d', poolTotal: 12,
      lastBatchAt: new Date().toISOString(), // 剛剛，遠比 15 分鐘新鮮
    },
  };
  await env.SMC_KV.put('worker-scan:meta', JSON.stringify(fakeMeta));
  await env.SMC_KV.put('worker-scan:rows', JSON.stringify({}));
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.includes('discord')) { discord.push(JSON.parse(init.body)); return new Response(null, { status: 204 }); }
    throw new Error('還沒輪到下一批，不該打任何外部 API：' + u);
  };
  await runWorker(env);
  const after = JSON.parse(await env.SMC_KV.get('worker-scan:meta'));
  assert.equal(after['1h'].provider, 'CACHED-FAKE-MARKER', '還沒到批次間隔就不該被覆寫');
  assert.equal(await env.SMC_KV.get('worker-scan:cursor'), null, '沒有真的掃描，游標也不該被動到');
});

test('輪到下一批時，真的重新掃描那一批，並把結果累積進去、游標往前推', async () => {
  const discord = [];
  // MIN_SCORE 故意設超高：demo 資料是依「現在時間」產生的合成 K 棒，分數會隨執行
  // 當下的時間浮動，設高門檻確保不會有計畫進入監看名單，才不用連帶 mock 現價 API
  // （這個測試只關心「有沒有真的重新掃描、游標有沒有往前推」）
  const env = makeEnv({ WORKER_SCAN_ENABLED: 'true', WORKER_SCAN_PROVIDERS: 'demo', WORKER_SCAN_TOP: '12', WORKER_SCAN_BATCH_SIZE: '5', WORKER_SCAN_BATCH_INTERVAL_MIN: '15', MIN_SCORE: '999' });
  const staleMeta = {
    '1h': {
      provider: 'STALE-FAKE-MARKER', interval: '1h', htfInterval: '1d', poolTotal: 12,
      lastBatchAt: new Date(Date.now() - 100 * 60000).toISOString(), // 100 分鐘前，遠超過 15 分鐘
    },
  };
  await env.SMC_KV.put('worker-scan:meta', JSON.stringify(staleMeta));
  await env.SMC_KV.put('worker-scan:rows', JSON.stringify({}));
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.includes('discord')) { discord.push(JSON.parse(init.body)); return new Response(null, { status: 204 }); }
    throw new Error('未預期的請求：' + u);
  };
  await runWorker(env);
  const after = JSON.parse(await env.SMC_KV.get('worker-scan:meta'));
  assert.equal(after['1h'].provider, 'demo', '過期後應該真的重新掃描這一批，結果來自 demo');
  const cursor = JSON.parse(await env.SMC_KV.get('worker-scan:cursor'));
  assert.equal(cursor['1h'], 5, '游標應該往前推 batchSize（5）');
});

test('掃描累積用的門檻（WORKER_SCAN_MIN_SCORE）不受推播門檻（MIN_SCORE）影響', async () => {
  // 實測踩過的坑：如果掃描這一步直接套用 MIN_SCORE 當篩選門檻，候選池
  // 繞完一輪也留不下幾檔——這裡故意把 MIN_SCORE（推播/下單門檻）設超高，
  // 確認累積結果不會被這個門檻鎖死，掃描本身只看 WORKER_SCAN_MIN_SCORE
  // （預設 0，幾乎不濾），MIN_SCORE 只影響 run() 要不要因此推播/下單。
  const discord = [];
  const env = makeEnv({
    WORKER_SCAN_ENABLED: 'true', WORKER_SCAN_PROVIDERS: 'demo', WORKER_SCAN_TOP: '12',
    WORKER_SCAN_BATCH_SIZE: '5', WORKER_SCAN_BATCH_INTERVAL_MIN: '15', MIN_SCORE: '999',
  });
  const staleMeta = {
    '1h': {
      provider: 'demo', interval: '1h', htfInterval: '1d', poolTotal: 12,
      lastBatchAt: new Date(Date.now() - 100 * 60000).toISOString(),
    },
  };
  await env.SMC_KV.put('worker-scan:meta', JSON.stringify(staleMeta));
  await env.SMC_KV.put('worker-scan:rows', JSON.stringify({}));
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.includes('discord')) { discord.push(JSON.parse(init.body)); return new Response(null, { status: 204 }); }
    throw new Error('未預期的請求：' + u);
  };
  await runWorker(env);
  const rows = JSON.parse(await env.SMC_KV.get('worker-scan:rows'));
  assert.ok(
    Object.keys(rows).length > 0,
    'MIN_SCORE=999（推播門檻）不該讓累積結果變成空的——掃描階段該用 WORKER_SCAN_MIN_SCORE（預設 0）',
  );
});

test('分批結果會累積：這批沒掃到的舊資料要保留，不會被清空', async () => {
  const discord = [];
  // MIN_SCORE 故意設超高，確保這次分批算出來不會有任何計畫進入監看名單，
  // 才不用連帶 mock 現價 API（這個測試只關心批次累積的邏輯本身）
  const env = makeEnv({ WORKER_SCAN_ENABLED: 'true', WORKER_SCAN_PROVIDERS: 'demo', WORKER_SCAN_TOP: '12', WORKER_SCAN_BATCH_SIZE: '5', WORKER_SCAN_BATCH_INTERVAL_MIN: '15', MIN_SCORE: '999' });
  const staleMeta = {
    '1h': {
      provider: 'demo', interval: '1h', htfInterval: '1d', poolTotal: 12,
      lastBatchAt: new Date(Date.now() - 100 * 60000).toISOString(),
    },
  };
  await env.SMC_KV.put('worker-scan:meta', JSON.stringify(staleMeta));
  // 假裝上一輪已經掃過某個這次批次不會碰到的幣種（游標從 0 開始只會碰前 5 檔）
  await env.SMC_KV.put('worker-scan:rows', JSON.stringify({ '1h::UNTOUCHED-FAKE-SYMBOL': row({ symbol: 'UNTOUCHED-FAKE-SYMBOL' }) }));
  await env.SMC_KV.put('worker-scan:cursor', JSON.stringify({ '1h': 0 }));
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.includes('discord')) { discord.push(JSON.parse(init.body)); return new Response(null, { status: 204 }); }
    throw new Error('未預期的請求：' + u);
  };
  await runWorker(env);
  const rows = JSON.parse(await env.SMC_KV.get('worker-scan:rows'));
  assert.ok('1h::UNTOUCHED-FAKE-SYMBOL' in rows, '這批沒碰到的舊資料應該還在，不會被這次的批次結果蓋掉');
});

test('游標繞完候選池一圈會回到開頭（round-robin）', async () => {
  const discord = [];
  const env = makeEnv({ WORKER_SCAN_ENABLED: 'true', WORKER_SCAN_PROVIDERS: 'demo', WORKER_SCAN_TOP: '12', WORKER_SCAN_BATCH_SIZE: '5', WORKER_SCAN_BATCH_INTERVAL_MIN: '15', MIN_SCORE: '999' });
  const staleMeta = {
    '1h': {
      provider: 'demo', interval: '1h', htfInterval: '1d', poolTotal: 12,
      lastBatchAt: new Date(Date.now() - 100 * 60000).toISOString(),
    },
  };
  await env.SMC_KV.put('worker-scan:meta', JSON.stringify(staleMeta));
  await env.SMC_KV.put('worker-scan:rows', JSON.stringify({}));
  await env.SMC_KV.put('worker-scan:cursor', JSON.stringify({ '1h': 10 })); // 候選池共 12 檔，10 + 5 應該繞回 3（10+5-12）
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.includes('discord')) { discord.push(JSON.parse(init.body)); return new Response(null, { status: 204 }); }
    throw new Error('未預期的請求：' + u);
  };
  await runWorker(env);
  const cursor = JSON.parse(await env.SMC_KV.get('worker-scan:cursor'));
  assert.equal(cursor['1h'], 3);
});

/* -------------------------------------------------------- 多個進場週期 */

test('WORKER_SCAN_INTERVAL 設多個週期時，一個 tick 只真的重新掃描最久沒更新的那個週期', async () => {
  const discord = [];
  const env = makeEnv({
    WORKER_SCAN_ENABLED: 'true', WORKER_SCAN_PROVIDERS: 'demo', WORKER_SCAN_TOP: '12',
    WORKER_SCAN_BATCH_SIZE: '5', WORKER_SCAN_BATCH_INTERVAL_MIN: '15', WORKER_SCAN_INTERVAL: '3m,1h',
    MIN_SCORE: '999',
  });
  // 3m 比 1h 更久沒更新（120 分鐘 vs 20 分鐘前，都已經超過 15 分鐘的批次間隔，
  // 兩個都到期了），照「最久沒更新優先」的邏輯，這次 tick 應該挑 3m。
  const meta = {
    '3m': { provider: 'demo', interval: '3m', htfInterval: '1h', poolTotal: 12, lastBatchAt: new Date(Date.now() - 120 * 60000).toISOString() },
    '1h': { provider: 'OLD-1H-MARKER', interval: '1h', htfInterval: '1d', poolTotal: 12, lastBatchAt: new Date(Date.now() - 20 * 60000).toISOString() },
  };
  await env.SMC_KV.put('worker-scan:meta', JSON.stringify(meta));
  await env.SMC_KV.put('worker-scan:rows', JSON.stringify({}));
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.includes('discord')) { discord.push(JSON.parse(init.body)); return new Response(null, { status: 204 }); }
    throw new Error('未預期的請求：' + u);
  };
  await runWorker(env);
  const after = JSON.parse(await env.SMC_KV.get('worker-scan:meta'));
  assert.ok(after['3m'].lastBatchAt !== meta['3m'].lastBatchAt, '3m 最久沒更新，這次 tick 應該真的重新掃描它');
  assert.equal(after['1h'].provider, 'OLD-1H-MARKER', '1h 這次不該被動到，留給下一個 tick');
  const cursor = JSON.parse(await env.SMC_KV.get('worker-scan:cursor'));
  assert.equal(cursor['3m'], 5, '3m 的游標應該往前推 batchSize（5）');
  assert.equal(cursor['1h'], undefined, '1h 這次沒掃到，游標不該被動到');
});

test('多個週期各自累積結果，同一個 symbol 不同週期不會互相覆蓋', async () => {
  const discord = [];
  const env = makeEnv({
    WORKER_SCAN_ENABLED: 'true', WORKER_SCAN_PROVIDERS: 'demo', WORKER_SCAN_TOP: '12',
    WORKER_SCAN_BATCH_SIZE: '5', WORKER_SCAN_BATCH_INTERVAL_MIN: '15', WORKER_SCAN_INTERVAL: '3m,1h',
    MIN_SCORE: '999',
  });
  // 假裝 1h 上一輪已經算出一筆 BTCUSDT 的計畫；3m 這個週期完全還沒掃過
  // （沒有 meta），這次 tick 應該輪到 3m（沒 meta 的視為最久沒更新）。
  const meta = {
    '1h': { provider: 'demo', interval: '1h', htfInterval: '1d', poolTotal: 12, lastBatchAt: new Date().toISOString() },
  };
  await env.SMC_KV.put('worker-scan:meta', JSON.stringify(meta));
  await env.SMC_KV.put('worker-scan:rows', JSON.stringify({ '1h::BTCUSDT': row({ symbol: 'BTCUSDT', interval: '1h' }) }));
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.includes('discord')) { discord.push(JSON.parse(init.body)); return new Response(null, { status: 204 }); }
    throw new Error('未預期的請求：' + u);
  };
  await runWorker(env);
  const rows = JSON.parse(await env.SMC_KV.get('worker-scan:rows'));
  assert.ok('1h::BTCUSDT' in rows, '1h 這筆舊資料應該還在，不會被 3m 這批蓋掉');
  const after = JSON.parse(await env.SMC_KV.get('worker-scan:meta'));
  assert.ok(after['3m'], '沒 meta 的週期（3m）這次應該被排到，補上 meta');
});

/* -------------------------------------------------- 把掃描結果寫回 data/market.json */

test('沒設定 GITHUB_API_TOKEN 時，完全不會呼叫 GitHub API', async () => {
  const discord = [];
  const env = makeEnv({ WORKER_SCAN_ENABLED: 'true', WORKER_SCAN_PROVIDERS: 'demo', WORKER_SCAN_TOP: '12', WORKER_SCAN_BATCH_SIZE: '5', WORKER_SCAN_BATCH_INTERVAL_MIN: '15', MIN_SCORE: '999' });
  const staleMeta = { '1h': { provider: 'demo', interval: '1h', htfInterval: '1d', poolTotal: 12, lastBatchAt: new Date(Date.now() - 100 * 60000).toISOString() } };
  await env.SMC_KV.put('worker-scan:meta', JSON.stringify(staleMeta));
  await env.SMC_KV.put('worker-scan:rows', JSON.stringify({}));
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.includes('discord')) { discord.push(JSON.parse(init.body)); return new Response(null, { status: 204 }); }
    if (u.includes('api.github.com')) throw new Error('沒設定 GITHUB_API_TOKEN 就不該打 GitHub API：' + u);
    throw new Error('未預期的請求：' + u);
  };
  await runWorker(env);
});

test('設定了 GITHUB_API_TOKEN：輪到下一批時把結果寫回 data/market.json，並保留舊檔的資金費率', async () => {
  const discord = [];
  const env = makeEnv({
    WORKER_SCAN_ENABLED: 'true', WORKER_SCAN_PROVIDERS: 'demo', WORKER_SCAN_TOP: '12', WORKER_SCAN_BATCH_SIZE: '5',
    WORKER_SCAN_BATCH_INTERVAL_MIN: '15', MIN_SCORE: '0', GITHUB_API_TOKEN: 'ghp_fake', GITHUB_REPO: 'me/repo',
  });
  const staleMeta = { '1h': { provider: 'demo', interval: '1h', htfInterval: '1d', poolTotal: 12, lastBatchAt: new Date(Date.now() - 100 * 60000).toISOString() } };
  await env.SMC_KV.put('worker-scan:meta', JSON.stringify(staleMeta));
  await env.SMC_KV.put('worker-scan:rows', JSON.stringify({}));

  const oldFile = {
    generatedAt: '2020-01-01T00:00:00.000Z', provider: 'binance', interval: '1h', htfInterval: '4h',
    universe: 1, rows: [{ symbol: 'BTCUSDT', deriv: { fundingRate: 0.0001, fundingLevel: 'neutral', regimeZh: '中性', fundingAnnualPct: 3.65, oiChangePct: 1.2 } }],
  };
  let putBody = null;
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.includes('discord')) { discord.push(JSON.parse(init.body)); return new Response(null, { status: 204 }); }
    // MIN_SCORE=0 這批多半會有計畫進入監看名單，run() 接著會去查現價——
    // 這個測試只關心「有沒有正確寫回 GitHub」，現價 API 給空清單即可。
    if (u.includes('api.bybit.com/v5/market/tickers')) return new Response(JSON.stringify({ retCode: 0, retMsg: 'OK', result: { list: [] } }), { status: 200 });
    if (u.includes('binance.com')) return new Response(JSON.stringify([]), { status: 200 });
    if (u.includes('api.github.com/repos/me/repo/contents/data/market.json') && (!init || init.method === undefined || init.method === 'GET')) {
      return new Response(JSON.stringify({ sha: 'old-sha-123', content: Buffer.from(JSON.stringify(oldFile), 'utf8').toString('base64') }), { status: 200 });
    }
    if (u.includes('api.github.com/repos/me/repo/contents/data/market.json') && init.method === 'PUT') {
      putBody = JSON.parse(init.body);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    throw new Error('未預期的請求：' + u);
  };
  await runWorker(env);

  assert.ok(putBody, '應該呼叫 PUT 寫回 data/market.json');
  assert.equal(putBody.sha, 'old-sha-123', '要帶舊檔的 sha，不然 GitHub 會拒絕更新');
  const written = JSON.parse(Buffer.from(putBody.content, 'base64').toString('utf8'));
  assert.ok(Array.isArray(written.rows) && written.rows.length > 0, 'minScore=0 應該至少有幾檔通過門檻');
  // 不管這批實際掃到哪些幣種：有對到舊檔symbol 的要原封不動接上 deriv，
  // 沒對到的（舊檔沒有的新標的）不該生出一個假的 deriv 欄位
  for (const r of written.rows) {
    const oldRow = oldFile.rows.find((o) => o.symbol === r.symbol);
    if (oldRow) assert.deepEqual(r.deriv, oldRow.deriv, `${r.symbol} 應該保留舊檔的 deriv`);
    else assert.ok(!('deriv' in r), `${r.symbol} 是舊檔沒有的標的，不該生出假的 deriv`);
  }
  assert.ok(written.rows.some((r) => r.symbol === 'BTCUSDT'), '候選池第一個（成交量最高）應該在這批裡');
});

test('GitHub 寫入失敗不影響主流程，Discord 通知照常運作', async () => {
  const discord = [];
  const env = makeEnv({
    WORKER_SCAN_ENABLED: 'true', WORKER_SCAN_PROVIDERS: 'demo', WORKER_SCAN_TOP: '12', WORKER_SCAN_BATCH_SIZE: '5',
    WORKER_SCAN_BATCH_INTERVAL_MIN: '15', MIN_SCORE: '999', GITHUB_API_TOKEN: 'ghp_fake',
  });
  const staleMeta = { '1h': { provider: 'demo', interval: '1h', htfInterval: '1d', poolTotal: 12, lastBatchAt: new Date(Date.now() - 100 * 60000).toISOString() } };
  await env.SMC_KV.put('worker-scan:meta', JSON.stringify(staleMeta));
  await env.SMC_KV.put('worker-scan:rows', JSON.stringify({}));
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.includes('discord')) { discord.push(JSON.parse(init.body)); return new Response(null, { status: 204 }); }
    if (u.includes('api.github.com')) return new Response('boom', { status: 500 });
    throw new Error('未預期的請求：' + u);
  };
  const out = await runWorker(env);
  assert.equal(typeof out.checked, 'number', 'GitHub 寫入失敗不該讓整次執行掛掉');
});

test('還沒輪到下一批的 tick，不會嘗試寫回 GitHub', async () => {
  const discord = [];
  const env = makeEnv({ WORKER_SCAN_ENABLED: 'true', WORKER_SCAN_BATCH_INTERVAL_MIN: '15', GITHUB_API_TOKEN: 'ghp_fake' });
  const fakeMeta = { '1h': { provider: 'CACHED', interval: '1h', htfInterval: '1d', poolTotal: 12, lastBatchAt: new Date().toISOString() } };
  await env.SMC_KV.put('worker-scan:meta', JSON.stringify(fakeMeta));
  await env.SMC_KV.put('worker-scan:rows', JSON.stringify({}));
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.includes('discord')) { discord.push(JSON.parse(init.body)); return new Response(null, { status: 204 }); }
    throw new Error('還沒輪到下一批，不該打任何外部 API（含 GitHub）：' + u);
  };
  await runWorker(env);
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

/* -------------------------------------------------------- 自動下單（Demo） */

test('自動下單預設關閉：就算金鑰都設定好了，價格到了也不會呼叫 Bybit', async () => {
  const discord = [];
  const bybit = { calls: [], wallet: demoWallet, instrument: demoInstrument };
  const env = makeEnv({ BYBIT_DEMO_API_KEY: 'k', BYBIT_DEMO_API_SECRET: 's' });
  stubFetch({ market: makeMarket([row()]), prices: { ABCUSDT: 99.9 }, discord, bybit });
  const out = await runWorker(env);
  assert.equal(out.alerts, 1, '沒開自動下單，Discord 還是要照常推播');
  assert.equal(bybit.calls.length, 0, '沒開自動下單就不該打 Bybit API');
  assert.doesNotMatch(discord[0].embeds[0].fields.map((f) => f.name).join(','), /自動下單/);
});

test('/auto-trade/status 回報開關與金鑰狀態', async () => {
  const env = makeEnv({ BYBIT_DEMO_API_KEY: 'k', BYBIT_DEMO_API_SECRET: 's' });
  const res = await worker.fetch(new Request('https://w.test/auto-trade/status'), env);
  const out = await res.json();
  assert.equal(out.enabled, false);
  assert.equal(out.hasKeys, true);
  assert.equal(out.mode, 'demo');
});

test('/auto-trade/on 沒帶對 token 會被拒絕，也不會真的開啟', async () => {
  const env = makeEnv({ AUTO_TRADE_TOKEN: 'secret123' });
  const res = await worker.fetch(new Request('https://w.test/auto-trade/on?token=wrong'), env);
  assert.equal(res.status, 403);
  assert.equal(await env.SMC_KV.get('auto-trade:enabled'), null);
});

test('/auto-trade/on 帶對 token 就會開啟，寫進 KV', async () => {
  const env = makeEnv({ AUTO_TRADE_TOKEN: 'secret123' });
  const res = await worker.fetch(new Request('https://w.test/auto-trade/on?token=secret123'), env);
  assert.equal(res.status, 200);
  assert.equal(await env.SMC_KV.get('auto-trade:enabled'), 'true');
});

test('/auto-trade/off 會把 KV 標記關閉', async () => {
  const env = makeEnv({ AUTO_TRADE_TOKEN: 'secret123' });
  await env.SMC_KV.put('auto-trade:enabled', 'true');
  const res = await worker.fetch(new Request('https://w.test/auto-trade/off?token=secret123'), env);
  assert.equal(res.status, 200);
  assert.equal(await env.SMC_KV.get('auto-trade:enabled'), 'false');
});

test('開啟後價格到了：用可用餘額 × 風險 % 算數量，送出市價進場單並帶停損', async () => {
  const discord = [];
  const bybit = { calls: [], wallet: demoWallet, instrument: demoInstrument, orderResult: { orderId: 'order-abc123' } };
  const env = makeEnv({ BYBIT_DEMO_API_KEY: 'k', BYBIT_DEMO_API_SECRET: 's' });
  await env.SMC_KV.put('auto-trade:enabled', 'true');
  stubFetch({ market: makeMarket([row()]), prices: { ABCUSDT: 99.9 }, discord, bybit });
  const out = await runWorker(env);

  assert.equal(out.alerts, 1);
  const orderCalls = bybit.calls.filter((c) => c.url.includes('/v5/order/create'));
  const entryCall = orderCalls.find((c) => c.body.orderType === 'Market');
  assert.ok(entryCall, '應該呼叫 order/create 送出市價進場單');
  // 帳戶 1000 USDT × 1% 風險 ÷ 每單位風險 5（entry 100 - stop 95）= 2，對齊步進 0.1 還是 2
  assert.equal(entryCall.body.qty, '2');
  assert.equal(entryCall.body.side, 'Buy');
  assert.equal(entryCall.body.stopLoss, '95');
  assert.equal(entryCall.body.takeProfit, undefined, '不該再用單一 takeProfit 欄位，分批出場改掛限價單');

  const field = discord[0].embeds[0].fields.find((f) => f.name.includes('自動下單'));
  assert.match(field.value, /✅/);
  assert.match(field.value, /2/);
  // score 75、MIN_SCORE 65、槓桿範圍 3~10 倍 → (75-65)/(100-65)=0.29 → 3+0.29*7≈5 倍
  const leverageCall = bybit.calls.find((c) => c.url.includes('/v5/position/set-leverage'));
  assert.equal(leverageCall.body.buyLeverage, '5');
  assert.match(field.value, /5x 槓桿/);
});

test('保本鏢與目標價會一次掛成真的 reduce-only 限價單', async () => {
  const discord = [];
  const bybit = { calls: [], wallet: demoWallet, instrument: demoInstrument };
  const env = makeEnv({ BYBIT_DEMO_API_KEY: 'k', BYBIT_DEMO_API_SECRET: 's' });
  await env.SMC_KV.put('auto-trade:enabled', 'true');
  // entry 100、stop 95（risk=5）、目標 115（rr=3）：保本鏢在 100+5*0.5=102.5，
  // 佔 34%；剩下 66% 全部給唯一的目標 115
  stubFetch({ market: makeMarket([row()]), prices: { ABCUSDT: 99.9 }, discord, bybit });
  await runWorker(env);

  const legCalls = bybit.calls.filter((c) => c.url.includes('/v5/order/create') && c.body.orderType === 'Limit');
  assert.equal(legCalls.length, 2, '保本鏢 + 1 個目標，應該掛 2 張限價單');

  const scalpLeg = legCalls.find((c) => Number(c.body.price) === 102.5);
  assert.ok(scalpLeg, '應該有一張保本鏢限價單（102.5 = 100 + 5*0.5）');
  assert.equal(scalpLeg.body.reduceOnly, true);
  assert.equal(scalpLeg.body.side, 'Sell', '多單的出場單方向要相反');
  assert.equal(scalpLeg.body.qty, '0.6', '2 顆 × 34% ≈ 0.68，對齊步進 0.1 捨去成 0.6');

  const tp1Leg = legCalls.find((c) => Number(c.body.price) === 115);
  assert.ok(tp1Leg, '應該有一張 TP1 限價單');
  assert.equal(tp1Leg.body.qty, '1.3', '2 顆 × 66% ≈ 1.32，對齊步進 0.1 捨去成 1.3');

  const pos = JSON.parse(await env.SMC_KV.get('open-pos:ABCUSDT:long'));
  assert.equal(pos.ladder.length, 2, 'KV 也要記住這兩段分批出場單');
  assert.equal(pos.initialStop, 95);
  assert.equal(pos.maxFavorableR, 0);
  assert.equal(pos.beMoved, false);
  assert.equal(pos.trailing, false);
});

test('槓桿照評分線性插值：高分給接近上限的槓桿，低分給接近下限的槓桿', async () => {
  const discord = [];
  const bybit = { calls: [], wallet: demoWallet, instrument: demoInstrument };
  const env = makeEnv({ BYBIT_DEMO_API_KEY: 'k', BYBIT_DEMO_API_SECRET: 's' });
  await env.SMC_KV.put('auto-trade:enabled', 'true');
  stubFetch({ market: makeMarket([row({ score: 99 })]), prices: { ABCUSDT: 99.9 }, discord, bybit });
  await runWorker(env);
  const leverageCall = bybit.calls.find((c) => c.url.includes('/v5/position/set-leverage'));
  // (99-65)/(100-65)=0.97 → 3+0.97*7≈10 倍（上限）
  assert.equal(leverageCall.body.buyLeverage, '10');
});

test('槓桿不會超過該合約本身的上限', async () => {
  const discord = [];
  const lowMaxInstrument = { list: [{ ...demoInstrument.list[0], leverageFilter: { maxLeverage: '4' } }] };
  const bybit = { calls: [], wallet: demoWallet, instrument: lowMaxInstrument };
  const env = makeEnv({ BYBIT_DEMO_API_KEY: 'k', BYBIT_DEMO_API_SECRET: 's' });
  await env.SMC_KV.put('auto-trade:enabled', 'true');
  stubFetch({ market: makeMarket([row({ score: 99 })]), prices: { ABCUSDT: 99.9 }, discord, bybit });
  await runWorker(env);
  const leverageCall = bybit.calls.find((c) => c.url.includes('/v5/position/set-leverage'));
  assert.equal(leverageCall.body.buyLeverage, '4', '算出來是 10 倍，但合約上限只有 4 倍');
});

/* -------------------------------------------------- 自動下單：部位關閉偵測 */

test('下單成功會把部位記進 KV，供之後偵測是否平倉', async () => {
  const discord = [];
  const bybit = { calls: [], wallet: demoWallet, instrument: demoInstrument };
  const env = makeEnv({ BYBIT_DEMO_API_KEY: 'k', BYBIT_DEMO_API_SECRET: 's' });
  await env.SMC_KV.put('auto-trade:enabled', 'true');
  stubFetch({ market: makeMarket([row()]), prices: { ABCUSDT: 99.9 }, discord, bybit });
  await runWorker(env);
  const raw = await env.SMC_KV.get('open-pos:ABCUSDT:long');
  assert.ok(raw, '應該記錄追蹤中的部位');
  const pos = JSON.parse(raw);
  assert.equal(pos.entry, 100);
  assert.equal(pos.stop, 95);
});

test('Bybit 那邊部位還在時，不會誤判成平倉', async () => {
  const discord = [];
  const env = makeEnv({ BYBIT_DEMO_API_KEY: 'k', BYBIT_DEMO_API_SECRET: 's' });
  await env.SMC_KV.put('open-pos:ABCUSDT:long', JSON.stringify({
    symbol: 'ABCUSDT', dir: 'long', entry: 100, stop: 95, qty: 2, riskAmount: 10, leverage: 5, grade: 'A', score: 75,
  }));
  const bybit = { calls: [], positions: [{ symbol: 'ABCUSDT', side: 'Buy', size: '2' }] };
  stubFetch({ market: makeMarket([]), prices: {}, discord, bybit });
  await runWorker(env);
  assert.ok(await env.SMC_KV.get('open-pos:ABCUSDT:long'), '部位還在，追蹤紀錄不該被刪掉');
  assert.equal(discord.length, 0, '部位還在，不該推播平倉通知');
});

test('Bybit 那邊部位消失了 → 推一則平倉通知（獲利），並清掉追蹤紀錄', async () => {
  const discord = [];
  const env = makeEnv({ BYBIT_DEMO_API_KEY: 'k', BYBIT_DEMO_API_SECRET: 's' });
  await env.SMC_KV.put('open-pos:ABCUSDT:long', JSON.stringify({
    symbol: 'ABCUSDT', dir: 'long', entry: 100, stop: 95, qty: 2, riskAmount: 10, leverage: 5, grade: 'A', score: 75,
  }));
  const bybit = { calls: [], positions: [] }; // 這個幣種已經不在持倉清單裡了 = 平倉
  stubFetch({ market: makeMarket([]), prices: { ABCUSDT: 110 }, discord, bybit });
  await runWorker(env);
  assert.equal(await env.SMC_KV.get('open-pos:ABCUSDT:long'), null, '通知完應該清掉追蹤紀錄');
  assert.equal(discord.length, 1);
  assert.match(discord[0].embeds[0].title, /✅.*已平倉.*\+2\.00R/);
});

test('平倉時價格低於進場價 → 判定為虧損', async () => {
  const discord = [];
  const env = makeEnv({ BYBIT_DEMO_API_KEY: 'k', BYBIT_DEMO_API_SECRET: 's' });
  await env.SMC_KV.put('open-pos:ABCUSDT:long', JSON.stringify({
    symbol: 'ABCUSDT', dir: 'long', entry: 100, stop: 95, qty: 2, riskAmount: 10, leverage: 5, grade: 'A', score: 75,
  }));
  const bybit = { calls: [], positions: [] };
  stubFetch({ market: makeMarket([]), prices: { ABCUSDT: 90 }, discord, bybit });
  await runWorker(env);
  assert.match(discord[0].embeds[0].title, /❌.*已平倉.*-2\.00R/);
});

test('平倉時會取消還沒成交的分批出場限價單', async () => {
  const discord = [];
  const env = makeEnv({ BYBIT_DEMO_API_KEY: 'k', BYBIT_DEMO_API_SECRET: 's' });
  await env.SMC_KV.put('open-pos:ABCUSDT:long', JSON.stringify({
    symbol: 'ABCUSDT', dir: 'long', entry: 100, stop: 95, initialStop: 95, qty: 2, riskAmount: 10, leverage: 5, grade: 'A', score: 75,
  }));
  const bybit = { calls: [], positions: [] };
  stubFetch({ market: makeMarket([]), prices: { ABCUSDT: 110 }, discord, bybit });
  await runWorker(env);
  const cancelCall = bybit.calls.find((c) => c.url.includes('/v5/order/cancel-all'));
  assert.ok(cancelCall, '平倉後應該呼叫 cancel-all 清掉殘留的分批出場單');
  assert.equal(cancelCall.body.symbol, 'ABCUSDT');
});

/* -------------------------------------------------------- 部位管理（保本鏢／移到成本價／追蹤停損） */

test('獲利還不到 0.5R 時，停損不會動', async () => {
  const discord = [];
  const env = makeEnv({ BYBIT_DEMO_API_KEY: 'k', BYBIT_DEMO_API_SECRET: 's' });
  await env.SMC_KV.put('open-pos:ABCUSDT:long', JSON.stringify({
    symbol: 'ABCUSDT', dir: 'long', entry: 100, stop: 95, initialStop: 95, tickSize: 0.01,
    maxFavorableR: 0, beMoved: false, trailing: false, qty: 2, riskAmount: 10, leverage: 5, grade: 'A', score: 75,
  }));
  const bybit = { calls: [], positions: [{ symbol: 'ABCUSDT', side: 'Buy', size: '2' }] };
  // entry 100、stop 95（risk=5），現價 102 → 獲利 0.4R，還沒到 0.5R 的保本門檻
  stubFetch({ market: makeMarket([]), prices: { ABCUSDT: 102 }, discord, bybit });
  await runWorker(env);
  assert.equal(bybit.calls.find((c) => c.url.includes('/v5/position/trading-stop')), undefined, '還沒到門檻不該搬停損');
  const pos = JSON.parse(await env.SMC_KV.get('open-pos:ABCUSDT:long'));
  assert.equal(pos.stop, 95);
  assert.equal(pos.beMoved, false);
});

test('獲利達到 0.5R → 停損移到成本價 + 0.05R', async () => {
  const discord = [];
  const env = makeEnv({ BYBIT_DEMO_API_KEY: 'k', BYBIT_DEMO_API_SECRET: 's' });
  await env.SMC_KV.put('open-pos:ABCUSDT:long', JSON.stringify({
    symbol: 'ABCUSDT', dir: 'long', entry: 100, stop: 95, initialStop: 95, tickSize: 0.01,
    maxFavorableR: 0, beMoved: false, trailing: false, qty: 2, riskAmount: 10, leverage: 5, grade: 'A', score: 75,
  }));
  const bybit = { calls: [], positions: [{ symbol: 'ABCUSDT', side: 'Buy', size: '2' }] };
  // entry 100、stop 95（risk=5），現價 102.5 → 獲利剛好 0.5R
  stubFetch({ market: makeMarket([]), prices: { ABCUSDT: 102.5 }, discord, bybit });
  await runWorker(env);
  const stopCall = bybit.calls.find((c) => c.url.includes('/v5/position/trading-stop'));
  assert.ok(stopCall, '獲利到 0.5R 應該搬停損');
  // 成本價 + risk*0.05 = 100 + 5*0.05 = 100.25
  assert.equal(stopCall.body.stopLoss, '100.25');
  const pos = JSON.parse(await env.SMC_KV.get('open-pos:ABCUSDT:long'));
  assert.equal(pos.stop, 100.25);
  assert.equal(pos.beMoved, true);
  assert.equal(pos.trailing, false);
});

test('獲利超過 1.5R → 改用追蹤停損，距離最高獲利 0.8R', async () => {
  const discord = [];
  const env = makeEnv({ BYBIT_DEMO_API_KEY: 'k', BYBIT_DEMO_API_SECRET: 's' });
  await env.SMC_KV.put('open-pos:ABCUSDT:long', JSON.stringify({
    symbol: 'ABCUSDT', dir: 'long', entry: 100, stop: 100.25, initialStop: 95, tickSize: 0.01,
    maxFavorableR: 0.5, beMoved: true, trailing: false, qty: 2, riskAmount: 10, leverage: 5, grade: 'A', score: 75,
  }));
  const bybit = { calls: [], positions: [{ symbol: 'ABCUSDT', side: 'Buy', size: '2' }] };
  // entry 100、initialStop 95（risk=5），現價 110 → 獲利 2R，超過 1.5R 的追蹤門檻
  // 鎖定 R = 2 - 0.8 = 1.2 → 停損 = 100 + 5*1.2 = 106
  stubFetch({ market: makeMarket([]), prices: { ABCUSDT: 110 }, discord, bybit });
  await runWorker(env);
  const stopCall = bybit.calls.find((c) => c.url.includes('/v5/position/trading-stop'));
  assert.ok(stopCall, '獲利超過 1.5R 應該搬停損');
  assert.equal(stopCall.body.stopLoss, '106');
  const pos = JSON.parse(await env.SMC_KV.get('open-pos:ABCUSDT:long'));
  assert.equal(pos.stop, 106);
  assert.equal(pos.trailing, true);
  assert.equal(pos.maxFavorableR, 2);
});

test('停損只會愈移愈緊：價格回落也不會把已經移動過的停損搬回去', async () => {
  const discord = [];
  const env = makeEnv({ BYBIT_DEMO_API_KEY: 'k', BYBIT_DEMO_API_SECRET: 's' });
  await env.SMC_KV.put('open-pos:ABCUSDT:long', JSON.stringify({
    symbol: 'ABCUSDT', dir: 'long', entry: 100, stop: 106, initialStop: 95, tickSize: 0.01,
    maxFavorableR: 2, beMoved: true, trailing: true, qty: 2, riskAmount: 10, leverage: 5, grade: 'A', score: 75,
  }));
  const bybit = { calls: [], positions: [{ symbol: 'ABCUSDT', side: 'Buy', size: '2' }] };
  // 價格從最高點回落到 104（還沒打到目前的追蹤停損 106，也沒創新高）
  stubFetch({ market: makeMarket([]), prices: { ABCUSDT: 104 }, discord, bybit });
  await runWorker(env);
  assert.equal(bybit.calls.find((c) => c.url.includes('/v5/position/trading-stop')), undefined, '沒有創新高就不該再搬停損');
  const pos = JSON.parse(await env.SMC_KV.get('open-pos:ABCUSDT:long'));
  assert.equal(pos.stop, 106, '停損應該維持在原本追蹤到的位置，不會因為價格回落而鬆開');
  assert.equal(pos.maxFavorableR, 2, 'maxFavorableR 記錄的是曾經到過的最高點，不會因為回落而降低');
});

test('空單方向：獲利到 0.5R 停損往下移到成本價', async () => {
  const discord = [];
  const env = makeEnv({ BYBIT_DEMO_API_KEY: 'k', BYBIT_DEMO_API_SECRET: 's' });
  await env.SMC_KV.put('open-pos:ABCUSDT:short', JSON.stringify({
    symbol: 'ABCUSDT', dir: 'short', entry: 100, stop: 105, initialStop: 105, tickSize: 0.01,
    maxFavorableR: 0, beMoved: false, trailing: false, qty: 2, riskAmount: 10, leverage: 5, grade: 'A', score: 75,
  }));
  const bybit = { calls: [], positions: [{ symbol: 'ABCUSDT', side: 'Sell', size: '2' }] };
  // entry 100、stop 105（risk=5），現價 97.5 → 空單獲利 0.5R
  stubFetch({ market: makeMarket([]), prices: { ABCUSDT: 97.5 }, discord, bybit });
  await runWorker(env);
  const stopCall = bybit.calls.find((c) => c.url.includes('/v5/position/trading-stop'));
  assert.ok(stopCall);
  // 成本價 - risk*0.05 = 100 - 0.25 = 99.75
  assert.equal(stopCall.body.stopLoss, '99.75');
});

test('dry 模式不會去查有沒有平倉，也不會動到追蹤紀錄', async () => {
  const discord = [];
  const env = makeEnv({ BYBIT_DEMO_API_KEY: 'k', BYBIT_DEMO_API_SECRET: 's' });
  await env.SMC_KV.put('open-pos:ABCUSDT:long', JSON.stringify({
    symbol: 'ABCUSDT', dir: 'long', entry: 100, stop: 95, qty: 2, riskAmount: 10, leverage: 5, grade: 'A', score: 75,
  }));
  // 故意不設定 bybit stub：如果 dry 模式還是去打了 Bybit API，stubFetch 會直接丟例外讓測試失敗
  stubFetch({ market: makeMarket([]), prices: {}, discord });
  const res = await worker.fetch(new Request('https://w.test/run?dry=1'), env);
  const out = await res.json();
  assert.equal(out.closedPositions.checked, 0);
  assert.ok(await env.SMC_KV.get('open-pos:ABCUSDT:long'), 'dry 模式不該清掉追蹤紀錄');
});

test('沒設定 Demo 金鑰時開啟自動下單：標記略過，完全不打 Bybit API', async () => {
  const discord = [];
  const env = makeEnv();
  await env.SMC_KV.put('auto-trade:enabled', 'true');
  stubFetch({ market: makeMarket([row()]), prices: { ABCUSDT: 99.9 }, discord });
  const out = await runWorker(env);
  assert.equal(out.alerts, 1);
  const field = discord[0].embeds[0].fields.find((f) => f.name.includes('自動下單'));
  assert.match(field.value, /尚未設定/);
});

test('算出的數量小於最小下單量：回報錯誤，但 Discord 照常推播（下單失敗不能擋住通知）', async () => {
  const discord = [];
  const bybit = { calls: [], wallet: demoWallet, instrument: { list: [{ ...demoInstrument.list[0], lotSizeFilter: { qtyStep: '0.1', minOrderQty: '50' } }] } };
  const env = makeEnv({ BYBIT_DEMO_API_KEY: 'k', BYBIT_DEMO_API_SECRET: 's' });
  await env.SMC_KV.put('auto-trade:enabled', 'true');
  stubFetch({ market: makeMarket([row()]), prices: { ABCUSDT: 99.9 }, discord, bybit });
  const out = await runWorker(env);
  assert.equal(out.alerts, 1, '下單失敗不該擋住 Discord 通知');
  const field = discord[0].embeds[0].fields.find((f) => f.name.includes('自動下單'));
  assert.match(field.value, /❌/);
  assert.equal(bybit.calls.find((c) => c.url.includes('order/create')), undefined, '數量不足就不該送出訂單');
});

test('同一個進場區重複執行只會下單一次（跟 Discord 通知共用去重）', async () => {
  const discord = [];
  const bybit = { calls: [], wallet: demoWallet, instrument: demoInstrument };
  const env = makeEnv({ BYBIT_DEMO_API_KEY: 'k', BYBIT_DEMO_API_SECRET: 's' });
  await env.SMC_KV.put('auto-trade:enabled', 'true');
  stubFetch({ market: makeMarket([row()]), prices: { ABCUSDT: 99.9 }, discord, bybit });
  await runWorker(env);
  const firstRoundOrders = bybit.calls.filter((c) => c.url.includes('order/create')).length;
  await runWorker(env);
  const orderCalls = bybit.calls.filter((c) => c.url.includes('order/create'));
  assert.equal(orderCalls.length, firstRoundOrders, '第二次執行不該再下一次單（含分批出場單）');
});
