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
  poiType: 'FVG', status: 'waiting', valid: true,
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

const EXECUTOR_URL = 'https://executor.test';

/** 攔截 fetch：回傳指定的 market 與價格，並收集送往 Discord 的內容；executor 選填，用來測自動下單（Worker 現在不直接打 Bybit，改打獨立的 Executor 服務） */
function stubFetch({ market, prices, discord, executor }) {
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
    if (u.startsWith(EXECUTOR_URL)) {
      if (!executor) throw new Error('未預期呼叫 Executor：' + u);
      return handleExecutorCall(executor, u, init);
    }
    throw new Error('未預期的請求：' + u);
  };
}

/** 模擬獨立部署的 Bybit Executor 服務——回應形狀跟 executor/src/routes.js 的真實回應一致 */
function handleExecutorCall(executor, u, init) {
  executor.calls?.push({ url: u, method: init.method, body: init.body ? JSON.parse(init.body) : null });
  const j = (obj) => new Response(JSON.stringify(obj), { status: 200 });
  if (u.includes('/balance')) {
    return executor.walletError ? j({ error: executor.walletError }) : j(executor.wallet ?? { totalAvailableBalance: 1000, totalWalletBalance: 1000 });
  }
  if (u.includes('/instrument')) {
    return executor.instrumentError ? j({ error: executor.instrumentError }) : j(executor.instrument ?? { qtyStep: 0.1, minQty: 0.1, tickSize: 0.01, maxLeverage: 25 });
  }
  if (u.includes('/position')) return j({ positions: executor.positions ?? [] });
  if (u.endsWith('/trade')) {
    const body = JSON.parse(init.body);
    if (executor.tradeError) return j({ error: executor.tradeError });
    const ladder = (body.ladder || []).map((leg, i) => (
      executor.legError && (executor.legErrorIndex === undefined || executor.legErrorIndex === i)
        ? { name: leg.name, price: leg.price, qty: leg.qty, error: executor.legError }
        : { name: leg.name, price: leg.price, qty: leg.qty, orderId: executor.legOrderId ?? `leg-order-${i}` }
    ));
    return j({ orderId: executor.orderId ?? 'order-123', orderLinkId: body.signal_id, qty: body.qty, leverage: body.leverage, ladder });
  }
  if (u.endsWith('/add-exit-leg')) {
    return executor.addLegError ? j({ error: executor.addLegError }) : j({ orderId: executor.addLegOrderId ?? 'order-123' });
  }
  if (u.endsWith('/set-stop')) {
    return executor.setStopError ? j({ error: executor.setStopError }) : j({ ok: true });
  }
  if (u.endsWith('/cancel-all')) return j({ ok: true });
  throw new Error('未預期的 Executor 端點：' + u);
}

const demoInstrument = { qtyStep: 0.1, minQty: 0.1, tickSize: 0.01, maxLeverage: 25 };

const makeEnv = (over = {}) => ({
  MARKET_URL,
  MIN_SCORE: '65',
  DISCORD_WEBHOOK_URL: 'https://discord.com/api/webhooks/1/abc',
  SMC_KV: makeKv(),
  ...over,
});

const withExecutor = (over = {}) => makeEnv({ EXECUTOR_URL, EXECUTOR_HMAC_SECRET: 'a'.repeat(32), ...over });

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

test('WORKER_SCAN_INTERVAL 拿掉某個週期後，那個週期的舊資料不會繼續混進監看名單', async () => {
  // 實測踩過的坑：把 WORKER_SCAN_INTERVAL 從含 3m 改成不含 3m 之後，KV 裡
  // 3m 那個週期累積的舊資料不會自動消失，會一直卡在 checked／監看名單裡，
  // 明明已經不想再看這個週期了，卻還是可能觸發推播或下單。
  const discord = [];
  const env = makeEnv({
    WORKER_SCAN_ENABLED: 'true', WORKER_SCAN_INTERVAL: '1h', // 現在只設定 1h，3m 已經被拿掉
    MIN_SCORE: '0',
  });
  const meta = {
    '3m': { provider: 'demo', interval: '3m', htfInterval: '1h', poolTotal: 12, lastBatchAt: new Date().toISOString() },
    '1h': { provider: 'demo', interval: '1h', htfInterval: '1d', poolTotal: 12, lastBatchAt: new Date().toISOString() },
  };
  await env.SMC_KV.put('worker-scan:meta', JSON.stringify(meta));
  await env.SMC_KV.put('worker-scan:rows', JSON.stringify({
    '3m::OLDUSDT': row({ symbol: 'OLDUSDT', interval: '3m' }), // 已經拿掉的週期，應該被濾掉
    '1h::ABCUSDT': row({ symbol: 'ABCUSDT', interval: '1h' }), // 還在設定裡的週期，應該保留
  }));

  // /status 要立刻反映：不會再顯示 3m 這個已經拿掉的週期
  globalThis.fetch = async (url) => { throw new Error('查 /status 不該打任何外部 API：' + url); };
  const status = await (await worker.fetch(new Request('https://w.test/status'), env)).json();
  assert.equal(status.workerScanCache.coveredSymbols, 1, '3m 的舊資料不該算進 coveredSymbols');
  assert.equal(status.workerScanCache.perInterval.length, 1, 'perInterval 不該再列出已經拿掉的 3m');
  assert.equal(status.workerScanCache.perInterval[0].interval, '1h');

  // /run 的監看名單也不該把 3m::OLDUSDT 算進去
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.includes('discord')) { discord.push(JSON.parse(init.body)); return new Response(null, { status: 204 }); }
    if (u.includes('api.bybit.com/v5/market/tickers')) return new Response(JSON.stringify({ retCode: 0, retMsg: 'OK', result: { list: [{ symbol: 'ABCUSDT', lastPrice: '99999' }] } }), { status: 200 });
    if (u.includes('binance.com')) return new Response(JSON.stringify([]), { status: 200 });
    throw new Error('未預期的請求：' + u);
  };
  const out = await runWorker(env);
  assert.equal(out.checked, 1, '監看名單應該只剩 1h 那筆，3m 的舊資料不該混進來');
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

test('任何 route 裡沒接住的例外都會變成看得懂的 JSON 錯誤，不是 Cloudflare 自己的 error code 1101', async () => {
  // 實測踩過兩次：某個 route 裡有一行沒被接住的例外，會直接變成
  // Cloudflare 自己的「error code: 1101」錯誤頁，完全看不出是哪裡炸的。
  // 這裡故意讓 data/market.json 的請求丟一個跟「HTTP 狀態碼」無關的
  // 例外（模擬網路層真的斷線，不是 4xx/5xx），驗證頂層有接住、回傳的是
  // 看得懂 JSON（帶 error 訊息），不是一片空白的錯誤頁。
  const env = makeEnv();
  globalThis.fetch = async () => { throw new Error('模擬網路層炸裂'); };
  const res = await worker.fetch(new Request('https://w.test/run'), env);
  assert.equal(res.status, 500);
  const out = await res.json();
  assert.match(out.error, /模擬網路層炸裂/);
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

test('KV 裡還留著支援多週期以前的舊格式資料時，不會噴例外，而是當成沒掃過重新開始', async () => {
  // 實測踩過的坑：支援多週期以前，meta 是攤平的單一物件，rows 用裸
  // symbol 當 key，cursor 是單純數字字串。upgrade 後如果直接照新格式
  // （週期 → meta／`interval::symbol`／週期 → cursor）解析這些舊資料，
  // Object.entries(舊 meta) 會把 provider/interval 這些欄位名誤判成
  // 「週期」，而且舊 meta 裡 lastBatchSampleError 這個欄位的值本來就會
  // 是 null，對 null 取 .lastBatchAt 會直接丟例外——部署後 /status、
  // /run 全部噴 500 就是這個問題（cursor 同理：對數字字串賦屬性在
  // strict mode 下也會噴例外）。
  const discord = [];
  const env = makeEnv({ WORKER_SCAN_ENABLED: 'true', WORKER_SCAN_PROVIDERS: 'demo', WORKER_SCAN_TOP: '12', WORKER_SCAN_BATCH_SIZE: '5', WORKER_SCAN_BATCH_INTERVAL_MIN: '15', MIN_SCORE: '999' });
  const legacyFlatMeta = {
    provider: 'demo', interval: '1h', htfInterval: '1d', poolTotal: 12,
    lastBatchAt: new Date(Date.now() - 100 * 60000).toISOString(),
    lastBatchScanned: 12, lastBatchSkippedLowVolatility: 0, lastBatchErrors: 0,
    lastBatchQualified: 5, lastBatchSampleError: null, // 這個 null 就是實測會噴例外的地方
  };
  await env.SMC_KV.put('worker-scan:meta', JSON.stringify(legacyFlatMeta));
  await env.SMC_KV.put('worker-scan:rows', JSON.stringify({ ABCUSDT: row({ symbol: 'ABCUSDT' }) })); // 舊格式：裸 symbol
  await env.SMC_KV.put('worker-scan:cursor', '10'); // 舊格式：純數字字串
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.includes('discord')) { discord.push(JSON.parse(init.body)); return new Response(null, { status: 204 }); }
    throw new Error('未預期的請求：' + u);
  };

  // /status 不該噴例外
  const status = await (await worker.fetch(new Request('https://w.test/status'), env)).json();
  assert.equal(status.workerScanCache, null, '格式不符的舊 meta 應該當成沒掃過，不是硬解析出一堆假的「週期」');

  // /run 也不該噴例外，而是正常跑完（當成第一次掃描，reset 重新累積）
  const out = await runWorker(env);
  assert.equal(typeof out.checked, 'number', '舊格式資料不該讓整次執行掛掉');
  const rows = JSON.parse(await env.SMC_KV.get('worker-scan:rows'));
  assert.ok(!('ABCUSDT' in rows), '舊格式（裸 symbol）的殘留資料不該被當成有效計畫繼續用');
  const meta = JSON.parse(await env.SMC_KV.get('worker-scan:meta'));
  assert.ok(meta['1h'], '重新掃描後應該用新格式（週期 → meta）存回去');
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

/* -------------------------------------------------------- 自動下單（Demo，透過獨立的 Bybit Executor 執行） */

test('自動下單預設關閉：就算 Executor 都設定好了，價格到了也不會呼叫它', async () => {
  const discord = [];
  const executor = { calls: [], wallet: { totalAvailableBalance: 1000, totalWalletBalance: 1000 }, instrument: demoInstrument };
  const env = withExecutor();
  stubFetch({ market: makeMarket([row()]), prices: { ABCUSDT: 99.9 }, discord, executor });
  const out = await runWorker(env);
  assert.equal(out.alerts, 1, '沒開自動下單，Discord 還是要照常推播');
  assert.equal(executor.calls.length, 0, '沒開自動下單就不該打 Executor');
  assert.doesNotMatch(discord[0].embeds[0].fields.map((f) => f.name).join(','), /自動下單/);
});

test('/auto-trade/status 回報開關與金鑰狀態', async () => {
  const env = withExecutor();
  stubFetch({ market: makeMarket([]), prices: {}, discord: [], executor: { calls: [], wallet: { totalAvailableBalance: 500, totalWalletBalance: 1000 } } });
  const res = await worker.fetch(new Request('https://w.test/auto-trade/status'), env);
  const out = await res.json();
  assert.equal(out.enabled, false);
  assert.equal(out.hasKeys, true);
  assert.equal(out.mode, 'demo');
});

test('/auto-trade/status 補上帳戶餘額跟追蹤中的部位數，方便排查下單失敗（保證金不足等）', async () => {
  const env = withExecutor();
  stubFetch({
    market: makeMarket([]), prices: {}, discord: [],
    executor: { calls: [], wallet: { totalAvailableBalance: 12.34, totalWalletBalance: 1000 } },
  });
  await env.SMC_KV.put('open-pos:BTCUSDT:long', JSON.stringify({ symbol: 'BTCUSDT', dir: 'long' }));
  await env.SMC_KV.put('open-pos:ETHUSDT:short', JSON.stringify({ symbol: 'ETHUSDT', dir: 'short' }));
  const res = await worker.fetch(new Request('https://w.test/auto-trade/status'), env);
  const out = await res.json();
  assert.equal(out.wallet.totalAvailableBalance, 12.34, '保證金被既有部位佔滿時，這裡應該看得出可用餘額很低');
  assert.equal(out.wallet.totalWalletBalance, 1000);
  assert.equal(out.trackedOpenPositions, 2);
  assert.deepEqual(out.openPositions.sort(), ['open-pos:BTCUSDT:long', 'open-pos:ETHUSDT:short']);
});

test('查餘額時 Executor 回應 403：錯誤訊息會夾帶一小段回應內容，不會只顯示看不出原因的狀態碼', async () => {
  // 實測踩過的坑：Bybit 對這個服務的網路路徑（不管是 Cloudflare Worker
  // 的共用 IP 還是其他雲端機房）有地理封鎖，403 持續好幾個小時。Worker
  // 現在不直接打 Bybit，改打 Executor；這裡驗證 Executor 回應非 2xx 時，
  // Worker 的錯誤訊息會夾帶一小段回應內容，不是只有看不出原因的狀態碼。
  const env = withExecutor();
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.startsWith(EXECUTOR_URL) && u.includes('/balance')) return new Response('upstream Bybit blocked this region', { status: 403 });
    throw new Error('未預期的請求：' + u);
  };
  const res = await worker.fetch(new Request('https://w.test/auto-trade/status'), env);
  const out = await res.json();
  assert.match(out.wallet.error, /Executor HTTP 403/);
  assert.match(out.wallet.error, /upstream Bybit blocked this region/, '要能看到 Executor 實際回了什麼內容，不是只有狀態碼');
});

test('/auto-trade/status?detail=1 會多列出每筆追蹤中部位的完整內容，方便排查「有停損沒止盈」', async () => {
  const env = withExecutor();
  stubFetch({
    market: makeMarket([]), prices: {}, discord: [],
    executor: { calls: [], wallet: { totalAvailableBalance: 1000, totalWalletBalance: 1000 } },
  });
  await env.SMC_KV.put('open-pos:BTCUSDT:long', JSON.stringify({
    symbol: 'BTCUSDT', dir: 'long', entry: 100, stop: 95,
    ladder: [{ name: 'TP1', price: 110, fraction: 1, qty: 2, error: 'Bybit [10006] rate limited' }],
  }));
  const res = await worker.fetch(new Request('https://w.test/auto-trade/status?detail=1'), env);
  const out = await res.json();
  assert.equal(out.positions.length, 1);
  assert.equal(out.positions[0].symbol, 'BTCUSDT');
  assert.equal(out.positions[0].ladder[0].error, 'Bybit [10006] rate limited', '要能直接看到是哪一段出場單掛失敗、原因是什麼');
});

test('/auto-trade/status 沒帶 detail 參數就不會多花 KV 讀取去查部位內容', async () => {
  const env = withExecutor();
  stubFetch({
    market: makeMarket([]), prices: {}, discord: [],
    executor: { calls: [], wallet: { totalAvailableBalance: 1000, totalWalletBalance: 1000 } },
  });
  await env.SMC_KV.put('open-pos:BTCUSDT:long', JSON.stringify({ symbol: 'BTCUSDT', dir: 'long' }));
  const res = await worker.fetch(new Request('https://w.test/auto-trade/status'), env);
  const out = await res.json();
  assert.equal(out.positions, undefined);
});

test('/auto-trade/status 沒設定 Executor 時不會嘗試查餘額', async () => {
  const env = makeEnv();
  globalThis.fetch = async (url) => { throw new Error('沒設定 Executor 不該打任何 API：' + url); };
  const res = await worker.fetch(new Request('https://w.test/auto-trade/status'), env);
  const out = await res.json();
  assert.equal(out.wallet, null);
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

test('開啟後價格到了：用可用餘額 × 風險 % 算數量，送出一次完整的交易指令給 Executor', async () => {
  const discord = [];
  const executor = { calls: [], wallet: { totalAvailableBalance: 1000, totalWalletBalance: 1000 }, instrument: demoInstrument, orderId: 'order-abc123' };
  const env = withExecutor();
  await env.SMC_KV.put('auto-trade:enabled', 'true');
  stubFetch({ market: makeMarket([row()]), prices: { ABCUSDT: 99.9 }, discord, executor });
  const out = await runWorker(env);

  assert.equal(out.alerts, 1);
  const tradeCall = executor.calls.find((c) => c.url.endsWith('/trade'));
  assert.ok(tradeCall, '應該呼叫 Executor 的 /trade 送出完整交易指令');
  // 帳戶 1000 USDT × 1% 風險 ÷ 每單位風險 5（entry 100 - stop 95）= 2，對齊步進 0.1 還是 2
  assert.equal(tradeCall.body.qty, '2');
  assert.equal(tradeCall.body.side, 'Buy');
  assert.equal(tradeCall.body.stop_loss, '95');
  assert.equal(tradeCall.body.signal_id, 'ABCUSDT:long:1h:100', 'signal_id 要能唯一對應這個進場區，供 Executor 冪等去重');

  const field = discord[0].embeds[0].fields.find((f) => f.name.includes('自動下單'));
  assert.match(field.value, /✅/);
  assert.match(field.value, /2/);
  // score 75、MIN_SCORE 65、槓桿範圍 3~10 倍 → (75-65)/(100-65)=0.29 → 3+0.29*7≈5 倍
  assert.equal(tradeCall.body.leverage, '5');
  assert.match(field.value, /5x 槓桿/);
});

test('保本鏢與目標價會一次算好、放進 /trade 的 ladder 欄位送給 Executor', async () => {
  const discord = [];
  const executor = { calls: [], wallet: { totalAvailableBalance: 1000, totalWalletBalance: 1000 }, instrument: demoInstrument };
  const env = withExecutor();
  await env.SMC_KV.put('auto-trade:enabled', 'true');
  // entry 100、stop 95（risk=5）、目標 115（rr=3）：保本鏢在 100+5*0.5=102.5，
  // 佔 34%；剩下 66% 全部給唯一的目標 115
  stubFetch({ market: makeMarket([row()]), prices: { ABCUSDT: 99.9 }, discord, executor });
  await runWorker(env);

  const tradeCall = executor.calls.find((c) => c.url.endsWith('/trade'));
  assert.equal(tradeCall.body.ladder.length, 2, '保本鏢 + 1 個目標，ladder 應該有 2 段');

  const scalpLeg = tradeCall.body.ladder.find((l) => Number(l.price) === 102.5);
  assert.ok(scalpLeg, '應該有一段保本鏢（102.5 = 100 + 5*0.5）');
  assert.equal(scalpLeg.qty, '0.6', '2 顆 × 34% ≈ 0.68，對齊步進 0.1 捨去成 0.6');

  const tp1Leg = tradeCall.body.ladder.find((l) => Number(l.price) === 115);
  assert.ok(tp1Leg, '應該有一段 TP1');
  assert.equal(tp1Leg.qty, '1.3', '2 顆 × 66% ≈ 1.32，對齊步進 0.1 捨去成 1.3');

  const pos = JSON.parse(await env.SMC_KV.get('open-pos:ABCUSDT:long'));
  assert.equal(pos.ladder.length, 2, 'KV 也要記住這兩段分批出場單（Executor 回傳的 orderId）');
  assert.ok(pos.ladder.every((l) => l.orderId));
  assert.equal(pos.initialStop, 95);
  assert.equal(pos.maxFavorableR, 0);
  assert.equal(pos.beMoved, false);
  assert.equal(pos.trailing, false);
});

test('Executor 回報某一段出場單掛失敗：Discord 通知會示警，KV 也留著錯誤紀錄供之後自動補掛', async () => {
  const discord = [];
  const executor = { calls: [], wallet: { totalAvailableBalance: 1000, totalWalletBalance: 1000 }, instrument: demoInstrument, legError: 'Bybit [10006] still limited' };
  const env = withExecutor();
  await env.SMC_KV.put('auto-trade:enabled', 'true');
  stubFetch({ market: makeMarket([row()]), prices: { ABCUSDT: 99.9 }, discord, executor });
  await runWorker(env);

  const field = discord[0].embeds[0].fields.find((f) => f.name.includes('自動下單'));
  assert.match(field.value, /⚠️.*掛不上/, '出場單掛不上應該在通知裡示警，不能只顯示「已送出市價單」看起來一切正常');
  const pos = JSON.parse(await env.SMC_KV.get('open-pos:ABCUSDT:long'));
  assert.ok(pos.ladder.some((leg) => leg.error), '掛失敗的那一段應該留著錯誤紀錄，之後才能被自動補掛邏輯撿到');
});

test('Executor 本身回應失敗（例如連不上、簽章被拒絕）：回報錯誤，但 Discord 照常推播', async () => {
  const discord = [];
  const env = withExecutor();
  await env.SMC_KV.put('auto-trade:enabled', 'true');
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.startsWith(MARKET_URL)) return new Response(JSON.stringify(makeMarket([row()])), { status: 200 });
    if (u.includes('api.bybit.com/v5/market/tickers')) {
      return new Response(JSON.stringify({ retCode: 0, retMsg: 'OK', result: { list: [{ symbol: 'ABCUSDT', lastPrice: '99.9' }] } }), { status: 200 });
    }
    if (u.includes('discord')) { discord.push(JSON.parse(init.body)); return new Response(null, { status: 204 }); }
    if (u.startsWith(EXECUTOR_URL)) return new Response('service unavailable', { status: 503 });
    throw new Error('未預期的請求：' + u);
  };
  const out = await runWorker(env);
  assert.equal(out.alerts, 1, 'Executor 連不上不該擋住 Discord 通知');
  const field = discord[0].embeds[0].fields.find((f) => f.name.includes('自動下單'));
  assert.match(field.value, /❌/);
  assert.equal(await env.SMC_KV.get('open-pos:ABCUSDT:long'), null, '沒有實際下成單，就不該留下部位追蹤紀錄');
});

test('槓桿照評分線性插值：高分給接近上限的槓桿，低分給接近下限的槓桿', async () => {
  const discord = [];
  const executor = { calls: [], wallet: { totalAvailableBalance: 1000, totalWalletBalance: 1000 }, instrument: demoInstrument };
  const env = withExecutor();
  await env.SMC_KV.put('auto-trade:enabled', 'true');
  stubFetch({ market: makeMarket([row({ score: 99 })]), prices: { ABCUSDT: 99.9 }, discord, executor });
  await runWorker(env);
  const tradeCall = executor.calls.find((c) => c.url.endsWith('/trade'));
  // (99-65)/(100-65)=0.97 → 3+0.97*7≈10 倍（上限）
  assert.equal(tradeCall.body.leverage, '10');
});

test('槓桿不會超過該合約本身的上限', async () => {
  const discord = [];
  const lowMaxInstrument = { ...demoInstrument, maxLeverage: 4 };
  const executor = { calls: [], wallet: { totalAvailableBalance: 1000, totalWalletBalance: 1000 }, instrument: lowMaxInstrument };
  const env = withExecutor();
  await env.SMC_KV.put('auto-trade:enabled', 'true');
  stubFetch({ market: makeMarket([row({ score: 99 })]), prices: { ABCUSDT: 99.9 }, discord, executor });
  await runWorker(env);
  const tradeCall = executor.calls.find((c) => c.url.endsWith('/trade'));
  assert.equal(tradeCall.body.leverage, '4', '算出來是 10 倍，但合約上限只有 4 倍');
});

/* -------------------------------------------------- 自動下單：部位關閉偵測 */

test('下單成功會把部位記進 KV，供之後偵測是否平倉', async () => {
  const discord = [];
  const executor = { calls: [], wallet: { totalAvailableBalance: 1000, totalWalletBalance: 1000 }, instrument: demoInstrument };
  const env = withExecutor();
  await env.SMC_KV.put('auto-trade:enabled', 'true');
  stubFetch({ market: makeMarket([row()]), prices: { ABCUSDT: 99.9 }, discord, executor });
  await runWorker(env);
  const raw = await env.SMC_KV.get('open-pos:ABCUSDT:long');
  assert.ok(raw, '應該記錄追蹤中的部位');
  const pos = JSON.parse(raw);
  assert.equal(pos.entry, 100);
  assert.equal(pos.stop, 95);
});

test('Bybit 那邊部位還在時（透過 Executor 查到），不會誤判成平倉', async () => {
  const discord = [];
  const env = withExecutor();
  await env.SMC_KV.put('open-pos:ABCUSDT:long', JSON.stringify({
    symbol: 'ABCUSDT', dir: 'long', entry: 100, stop: 95, qty: 2, riskAmount: 10, leverage: 5, grade: 'A', score: 75,
  }));
  const executor = { calls: [], positions: [{ symbol: 'ABCUSDT', side: 'Buy', size: '2' }] };
  stubFetch({ market: makeMarket([]), prices: {}, discord, executor });
  await runWorker(env);
  assert.ok(await env.SMC_KV.get('open-pos:ABCUSDT:long'), '部位還在，追蹤紀錄不該被刪掉');
  assert.equal(discord.length, 0, '部位還在，不該推播平倉通知');
});

test('Bybit 那邊部位消失了 → 推一則平倉通知（獲利），並清掉追蹤紀錄', async () => {
  const discord = [];
  const env = withExecutor();
  await env.SMC_KV.put('open-pos:ABCUSDT:long', JSON.stringify({
    symbol: 'ABCUSDT', dir: 'long', entry: 100, stop: 95, qty: 2, riskAmount: 10, leverage: 5, grade: 'A', score: 75,
  }));
  const executor = { calls: [], positions: [] }; // 這個幣種已經不在持倉清單裡了 = 平倉
  stubFetch({ market: makeMarket([]), prices: { ABCUSDT: 110 }, discord, executor });
  await runWorker(env);
  assert.equal(await env.SMC_KV.get('open-pos:ABCUSDT:long'), null, '通知完應該清掉追蹤紀錄');
  assert.equal(discord.length, 1);
  assert.match(discord[0].embeds[0].title, /✅.*已平倉.*\+2\.00R/);
});

test('平倉時價格低於進場價 → 判定為虧損', async () => {
  const discord = [];
  const env = withExecutor();
  await env.SMC_KV.put('open-pos:ABCUSDT:long', JSON.stringify({
    symbol: 'ABCUSDT', dir: 'long', entry: 100, stop: 95, qty: 2, riskAmount: 10, leverage: 5, grade: 'A', score: 75,
  }));
  const executor = { calls: [], positions: [] };
  stubFetch({ market: makeMarket([]), prices: { ABCUSDT: 90 }, discord, executor });
  await runWorker(env);
  assert.match(discord[0].embeds[0].title, /❌.*已平倉.*-2\.00R/);
});

test('平倉時會取消還沒成交的分批出場限價單', async () => {
  const discord = [];
  const env = withExecutor();
  await env.SMC_KV.put('open-pos:ABCUSDT:long', JSON.stringify({
    symbol: 'ABCUSDT', dir: 'long', entry: 100, stop: 95, initialStop: 95, qty: 2, riskAmount: 10, leverage: 5, grade: 'A', score: 75,
  }));
  const executor = { calls: [], positions: [] };
  stubFetch({ market: makeMarket([]), prices: { ABCUSDT: 110 }, discord, executor });
  await runWorker(env);
  const cancelCall = executor.calls.find((c) => c.url.endsWith('/cancel-all'));
  assert.ok(cancelCall, '平倉後應該呼叫 Executor 的 /cancel-all 清掉殘留的分批出場單');
  assert.equal(cancelCall.body.symbol, 'ABCUSDT');
});

/* -------------------------------------------------------- 部位管理（保本鏢／移到成本價／追蹤停損） */

test('獲利還不到 0.5R 時，停損不會動', async () => {
  const discord = [];
  const env = withExecutor();
  await env.SMC_KV.put('open-pos:ABCUSDT:long', JSON.stringify({
    symbol: 'ABCUSDT', dir: 'long', entry: 100, stop: 95, initialStop: 95, tickSize: 0.01,
    maxFavorableR: 0, beMoved: false, trailing: false, qty: 2, riskAmount: 10, leverage: 5, grade: 'A', score: 75,
  }));
  const executor = { calls: [], positions: [{ symbol: 'ABCUSDT', side: 'Buy', size: '2' }] };
  // entry 100、stop 95（risk=5），現價 102 → 獲利 0.4R，還沒到 0.5R 的保本門檻
  stubFetch({ market: makeMarket([]), prices: { ABCUSDT: 102 }, discord, executor });
  await runWorker(env);
  assert.equal(executor.calls.find((c) => c.url.endsWith('/set-stop')), undefined, '還沒到門檻不該搬停損');
  const pos = JSON.parse(await env.SMC_KV.get('open-pos:ABCUSDT:long'));
  assert.equal(pos.stop, 95);
  assert.equal(pos.beMoved, false);
});

test('獲利達到 0.5R → 停損移到成本價 + 0.05R', async () => {
  const discord = [];
  const env = withExecutor();
  await env.SMC_KV.put('open-pos:ABCUSDT:long', JSON.stringify({
    symbol: 'ABCUSDT', dir: 'long', entry: 100, stop: 95, initialStop: 95, tickSize: 0.01,
    maxFavorableR: 0, beMoved: false, trailing: false, qty: 2, riskAmount: 10, leverage: 5, grade: 'A', score: 75,
  }));
  const executor = { calls: [], positions: [{ symbol: 'ABCUSDT', side: 'Buy', size: '2' }] };
  // entry 100、stop 95（risk=5），現價 102.5 → 獲利剛好 0.5R
  stubFetch({ market: makeMarket([]), prices: { ABCUSDT: 102.5 }, discord, executor });
  await runWorker(env);
  const stopCall = executor.calls.find((c) => c.url.endsWith('/set-stop'));
  assert.ok(stopCall, '獲利到 0.5R 應該搬停損');
  // 成本價 + risk*0.05 = 100 + 5*0.05 = 100.25
  assert.equal(stopCall.body.stop_loss, '100.25');
  const pos = JSON.parse(await env.SMC_KV.get('open-pos:ABCUSDT:long'));
  assert.equal(pos.stop, 100.25);
  assert.equal(pos.beMoved, true);
  assert.equal(pos.trailing, false);
});

test('獲利超過 1.5R → 改用追蹤停損，距離最高獲利 0.8R', async () => {
  const discord = [];
  const env = withExecutor();
  await env.SMC_KV.put('open-pos:ABCUSDT:long', JSON.stringify({
    symbol: 'ABCUSDT', dir: 'long', entry: 100, stop: 100.25, initialStop: 95, tickSize: 0.01,
    maxFavorableR: 0.5, beMoved: true, trailing: false, qty: 2, riskAmount: 10, leverage: 5, grade: 'A', score: 75,
  }));
  const executor = { calls: [], positions: [{ symbol: 'ABCUSDT', side: 'Buy', size: '2' }] };
  // entry 100、initialStop 95（risk=5），現價 110 → 獲利 2R，超過 1.5R 的追蹤門檻
  // 鎖定 R = 2 - 0.8 = 1.2 → 停損 = 100 + 5*1.2 = 106
  stubFetch({ market: makeMarket([]), prices: { ABCUSDT: 110 }, discord, executor });
  await runWorker(env);
  const stopCall = executor.calls.find((c) => c.url.endsWith('/set-stop'));
  assert.ok(stopCall, '獲利超過 1.5R 應該搬停損');
  assert.equal(stopCall.body.stop_loss, '106');
  const pos = JSON.parse(await env.SMC_KV.get('open-pos:ABCUSDT:long'));
  assert.equal(pos.stop, 106);
  assert.equal(pos.trailing, true);
  assert.equal(pos.maxFavorableR, 2);
});

test('停損只會愈移愈緊：價格回落也不會把已經移動過的停損搬回去', async () => {
  const discord = [];
  const env = withExecutor();
  await env.SMC_KV.put('open-pos:ABCUSDT:long', JSON.stringify({
    symbol: 'ABCUSDT', dir: 'long', entry: 100, stop: 106, initialStop: 95, tickSize: 0.01,
    maxFavorableR: 2, beMoved: true, trailing: true, qty: 2, riskAmount: 10, leverage: 5, grade: 'A', score: 75,
  }));
  const executor = { calls: [], positions: [{ symbol: 'ABCUSDT', side: 'Buy', size: '2' }] };
  // 價格從最高點回落到 104（還沒打到目前的追蹤停損 106，也沒創新高）
  stubFetch({ market: makeMarket([]), prices: { ABCUSDT: 104 }, discord, executor });
  await runWorker(env);
  assert.equal(executor.calls.find((c) => c.url.endsWith('/set-stop')), undefined, '沒有創新高就不該再搬停損');
  const pos = JSON.parse(await env.SMC_KV.get('open-pos:ABCUSDT:long'));
  assert.equal(pos.stop, 106, '停損應該維持在原本追蹤到的位置，不會因為價格回落而鬆開');
  assert.equal(pos.maxFavorableR, 2, 'maxFavorableR 記錄的是曾經到過的最高點，不會因為回落而降低');
});

test('空單方向：獲利到 0.5R 停損往下移到成本價', async () => {
  const discord = [];
  const env = withExecutor();
  await env.SMC_KV.put('open-pos:ABCUSDT:short', JSON.stringify({
    symbol: 'ABCUSDT', dir: 'short', entry: 100, stop: 105, initialStop: 105, tickSize: 0.01,
    maxFavorableR: 0, beMoved: false, trailing: false, qty: 2, riskAmount: 10, leverage: 5, grade: 'A', score: 75,
  }));
  const executor = { calls: [], positions: [{ symbol: 'ABCUSDT', side: 'Sell', size: '2' }] };
  // entry 100、stop 105（risk=5），現價 97.5 → 空單獲利 0.5R
  stubFetch({ market: makeMarket([]), prices: { ABCUSDT: 97.5 }, discord, executor });
  await runWorker(env);
  const stopCall = executor.calls.find((c) => c.url.endsWith('/set-stop'));
  assert.ok(stopCall);
  // 成本價 - risk*0.05 = 100 - 0.25 = 99.75
  assert.equal(stopCall.body.stop_loss, '99.75');
});

test('追蹤中的部位如果有分批出場單當初掛失敗，之後每次執行都會自動重試補掛', async () => {
  // 實測踩過的坑：開倉當下驗證過數量沒問題，但實際掛單時還是可能因為
  // 限流／網路暫時失敗，失敗就記在 ladder 那一段的 error 欄位、以前沒人
  // 再處理——變成部位有停損卻缺了出場計畫。這裡驗證 updateTrailingStops()
  // 會透過 Executor 的 /add-exit-leg 把這種留著 error 的段重新掛一次。
  const discord = [];
  const env = withExecutor();
  await env.SMC_KV.put('open-pos:ABCUSDT:long', JSON.stringify({
    symbol: 'ABCUSDT', dir: 'long', entry: 100, stop: 95, initialStop: 95, tickSize: 0.01,
    maxFavorableR: 0, beMoved: false, trailing: false, qty: 2, riskAmount: 10, leverage: 5, grade: 'A', score: 75,
    ladder: [{ name: 'TP1', price: 110, fraction: 1, qty: 2, error: 'Bybit [10006] rate limited' }],
  }));
  const executor = { calls: [], positions: [{ symbol: 'ABCUSDT', side: 'Buy', size: '2' }] };
  stubFetch({ market: makeMarket([]), prices: { ABCUSDT: 101 }, discord, executor });
  const out = await runWorker(env);
  const legCall = executor.calls.find((c) => c.url.endsWith('/add-exit-leg'));
  assert.ok(legCall, '應該重新嘗試掛出當初失敗的那一段');
  assert.equal(legCall.body.price, '110');
  const pos = JSON.parse(await env.SMC_KV.get('open-pos:ABCUSDT:long'));
  assert.equal(pos.ladder[0].error, undefined, '補掛成功後不該還留著錯誤紀錄');
  assert.ok(pos.ladder[0].orderId);
  assert.equal(out.trailingStops.legsRepaired, 1);
});

test('補掛還是失敗：留著錯誤紀錄等下次執行再試，不影響其他部位邏輯', async () => {
  const discord = [];
  const env = withExecutor();
  await env.SMC_KV.put('open-pos:ABCUSDT:long', JSON.stringify({
    symbol: 'ABCUSDT', dir: 'long', entry: 100, stop: 95, initialStop: 95, tickSize: 0.01,
    maxFavorableR: 0, beMoved: false, trailing: false, qty: 2, riskAmount: 10, leverage: 5, grade: 'A', score: 75,
    ladder: [{ name: 'TP1', price: 110, fraction: 1, qty: 2, error: 'Bybit [10006] rate limited' }],
  }));
  const executor = { calls: [], positions: [{ symbol: 'ABCUSDT', side: 'Buy', size: '2' }], addLegError: 'Bybit [10006] still limited' };
  stubFetch({ market: makeMarket([]), prices: { ABCUSDT: 101 }, discord, executor });
  const out = await runWorker(env);
  const pos = JSON.parse(await env.SMC_KV.get('open-pos:ABCUSDT:long'));
  assert.ok(pos.ladder[0].error, '再次失敗應該還是留著錯誤，等下次執行再試');
  assert.equal(out.trailingStops.legsRepaired, 0);
});

test('dry 模式不會去查有沒有平倉，也不會動到追蹤紀錄', async () => {
  const discord = [];
  const env = withExecutor();
  await env.SMC_KV.put('open-pos:ABCUSDT:long', JSON.stringify({
    symbol: 'ABCUSDT', dir: 'long', entry: 100, stop: 95, qty: 2, riskAmount: 10, leverage: 5, grade: 'A', score: 75,
  }));
  // 故意不設定 executor stub：如果 dry 模式還是去打了 Executor，stubFetch 會直接丟例外讓測試失敗
  stubFetch({ market: makeMarket([]), prices: {}, discord });
  const res = await worker.fetch(new Request('https://w.test/run?dry=1'), env);
  const out = await res.json();
  assert.equal(out.closedPositions.checked, 0);
  assert.ok(await env.SMC_KV.get('open-pos:ABCUSDT:long'), 'dry 模式不該清掉追蹤紀錄');
});

test('沒設定 Executor 時開啟自動下單：標記略過，完全不打任何 API', async () => {
  const discord = [];
  const env = makeEnv();
  await env.SMC_KV.put('auto-trade:enabled', 'true');
  stubFetch({ market: makeMarket([row()]), prices: { ABCUSDT: 99.9 }, discord });
  const out = await runWorker(env);
  assert.equal(out.alerts, 1);
  const field = discord[0].embeds[0].fields.find((f) => f.name.includes('自動下單'));
  assert.match(field.value, /尚未設定/);
});

const shortRow = () => row({ dir: 'short', entry: 100, stop: 105, targets: [{ name: 'TP1', price: 85, rr: 3 }] });

test('預設只自動下多單：空單訊號照常推播，但不送單', async () => {
  const discord = [];
  const executor = { calls: [], wallet: { totalAvailableBalance: 1000, totalWalletBalance: 1000 }, instrument: demoInstrument };
  const env = withExecutor();
  await env.SMC_KV.put('auto-trade:enabled', 'true');
  stubFetch({ market: makeMarket([shortRow()]), prices: { ABCUSDT: 100.05 }, discord, executor });
  const out = await runWorker(env);
  assert.equal(out.alerts, 1, '空單訊號還是要推播');
  assert.equal(executor.calls.length, 0, '不允許的方向連餘額都不該查');
  const field = discord[0].embeds[0].fields.find((f) => f.name.includes('自動下單'));
  assert.match(field.value, /不自動下單/);
});

test('AUTO_TRADE_DIRECTIONS 加上 short 之後空單會正常下單', async () => {
  const discord = [];
  const executor = { calls: [], wallet: { totalAvailableBalance: 1000, totalWalletBalance: 1000 }, instrument: demoInstrument };
  const env = withExecutor({ AUTO_TRADE_DIRECTIONS: 'long, short' });
  await env.SMC_KV.put('auto-trade:enabled', 'true');
  stubFetch({ market: makeMarket([shortRow()]), prices: { ABCUSDT: 100.05 }, discord, executor });
  await runWorker(env);
  const tradeCall = executor.calls.find((c) => c.url.endsWith('/trade'));
  assert.ok(tradeCall, '允許做空時應該送出 /trade');
  assert.equal(tradeCall.body.side, 'Sell');
});

const putPosition = (env, p) => env.SMC_KV.put(`open-pos:${p.symbol}:${p.dir}`, JSON.stringify(p));

test('持倉總風險上限：既有部位加上這筆超過 6% 就只通知不下單', async () => {
  const discord = [];
  const executor = { calls: [], wallet: { totalAvailableBalance: 1000, totalWalletBalance: 1000 }, instrument: demoInstrument };
  const env = withExecutor();
  await env.SMC_KV.put('auto-trade:enabled', 'true');
  await putPosition(env, { symbol: 'XYZUSDT', dir: 'long', entry: 10, stop: 9, qty: 55 }); // 還會虧 55 = 5.5%
  executor.positions = [{ symbol: 'XYZUSDT', side: 'Buy', size: '55' }];
  stubFetch({ market: makeMarket([row()]), prices: { ABCUSDT: 99.9, XYZUSDT: 10 }, discord, executor });
  const out = await runWorker(env);
  assert.equal(out.alerts, 1, '超過上限還是要推播');
  assert.equal(executor.calls.find((c) => c.url.endsWith('/trade')), undefined);
  const field = discord[0].embeds[0].fields.find((f) => f.name.includes('自動下單'));
  assert.match(field.value, /持倉總風險已達 5\.5%（上限 6%/);
});

test('持倉總風險上限：停損已經搬到成本價以上的部位不佔額度', async () => {
  const executor = { calls: [], wallet: { totalAvailableBalance: 1000, totalWalletBalance: 1000 }, instrument: demoInstrument };
  const env = withExecutor();
  await env.SMC_KV.put('auto-trade:enabled', 'true');
  await putPosition(env, { symbol: 'XYZUSDT', dir: 'long', entry: 10, stop: 10.05, qty: 55, beMoved: true });
  await putPosition(env, { symbol: 'QQQUSDT', dir: 'short', entry: 10, stop: 9.9, qty: 500, beMoved: true });
  executor.positions = [{ symbol: 'XYZUSDT', side: 'Buy', size: '55' }, { symbol: 'QQQUSDT', side: 'Sell', size: '500' }];
  stubFetch({ market: makeMarket([row()]), prices: { ABCUSDT: 99.9, XYZUSDT: 10.1, QQQUSDT: 9.95 }, discord: [], executor });
  await runWorker(env);
  assert.ok(executor.calls.find((c) => c.url.endsWith('/trade')), '保本後的部位剩餘風險是 0，應該照常下單');
});

test('停損距離低於 1% 只通知不下單（手續費會吃掉大半獲利）', async () => {
  const discord = [];
  const executor = { calls: [], wallet: { totalAvailableBalance: 1000, totalWalletBalance: 1000 }, instrument: demoInstrument };
  const env = withExecutor();
  await env.SMC_KV.put('auto-trade:enabled', 'true');
  stubFetch({ market: makeMarket([row({ entry: 100, stop: 99.4 })]), prices: { ABCUSDT: 99.95 }, discord, executor });
  const out = await runWorker(env);
  assert.equal(out.alerts, 1);
  assert.equal(executor.calls.length, 0);
  const field = discord[0].embeds[0].fields.find((f) => f.name.includes('自動下單'));
  assert.match(field.value, /停損距離只有 0\.60%（下限 1%/);
});

test('持倉總風險上限設成 0 就不限制', async () => {
  const executor = { calls: [], wallet: { totalAvailableBalance: 1000, totalWalletBalance: 1000 }, instrument: demoInstrument };
  const env = withExecutor({ AUTO_TRADE_MAX_OPEN_RISK_PCT: '0' });
  await env.SMC_KV.put('auto-trade:enabled', 'true');
  await putPosition(env, { symbol: 'XYZUSDT', dir: 'long', entry: 10, stop: 9, qty: 500 });
  executor.positions = [{ symbol: 'XYZUSDT', side: 'Buy', size: '500' }];
  stubFetch({ market: makeMarket([row()]), prices: { ABCUSDT: 99.9, XYZUSDT: 10 }, discord: [], executor });
  await runWorker(env);
  assert.ok(executor.calls.find((c) => c.url.endsWith('/trade')));
});

test('預設排除 Order Block 進場區：照常推播，但不送單；設成空字串就恢復下單', async () => {
  const discord = [];
  const executor = { calls: [], wallet: { totalAvailableBalance: 1000, totalWalletBalance: 1000 }, instrument: demoInstrument };
  const env = withExecutor();
  await env.SMC_KV.put('auto-trade:enabled', 'true');
  stubFetch({ market: makeMarket([row({ poiType: 'Order Block' })]), prices: { ABCUSDT: 99.9 }, discord, executor });
  const out = await runWorker(env);
  assert.equal(out.alerts, 1, 'Order Block 訊號還是要推播');
  assert.equal(executor.calls.length, 0);
  const field = discord[0].embeds[0].fields.find((f) => f.name.includes('自動下單'));
  assert.match(field.value, /Order Block 類型的進場區目前不自動下單/);

  const executor2 = { calls: [], wallet: { totalAvailableBalance: 1000, totalWalletBalance: 1000 }, instrument: demoInstrument };
  const env2 = withExecutor({ AUTO_TRADE_EXCLUDE_POI: '' });
  await env2.SMC_KV.put('auto-trade:enabled', 'true');
  stubFetch({ market: makeMarket([row({ poiType: 'Order Block' })]), prices: { ABCUSDT: 99.9 }, discord: [], executor: executor2 });
  await runWorker(env2);
  assert.ok(executor2.calls.find((c) => c.url.endsWith('/trade')), '清空排除清單後應該正常下單');
});

test('算出的數量小於最小下單量：回報錯誤，但 Discord 照常推播（下單失敗不能擋住通知）', async () => {
  const discord = [];
  const executor = { calls: [], wallet: { totalAvailableBalance: 1000, totalWalletBalance: 1000 }, instrument: { ...demoInstrument, minQty: 50 } };
  const env = withExecutor();
  await env.SMC_KV.put('auto-trade:enabled', 'true');
  stubFetch({ market: makeMarket([row()]), prices: { ABCUSDT: 99.9 }, discord, executor });
  const out = await runWorker(env);
  assert.equal(out.alerts, 1, '下單失敗不該擋住 Discord 通知');
  const field = discord[0].embeds[0].fields.find((f) => f.name.includes('自動下單'));
  assert.match(field.value, /❌/);
  assert.equal(executor.calls.find((c) => c.url.endsWith('/trade')), undefined, '數量不足就不該送出訂單');
});

test('分批出場階梯任何一段掛不了單（低於最小下單量）就整筆跳過，不會開出沒有止盈的裸部位', async () => {
  // 實測踩過的坑：以前是「先開倉，掛腿單時哪一段太小就默默跳過那一段」，
  // 極端情況下全部段都太小，整筆變成完全沒有止盈的裸部位。這裡故意讓
  // 總量（qty=2）通過最小下單量檢查，但保本鏢那一段（34% ≈ 0.68 → 捨去
  // 成 0.6）低於最小下單量（1），驗證整筆會直接跳過，連進場單都不會送。
  const discord = [];
  const executor = { calls: [], wallet: { totalAvailableBalance: 1000, totalWalletBalance: 1000 }, instrument: { ...demoInstrument, minQty: 1 } };
  const env = withExecutor();
  await env.SMC_KV.put('auto-trade:enabled', 'true');
  stubFetch({ market: makeMarket([row()]), prices: { ABCUSDT: 99.9 }, discord, executor });
  const out = await runWorker(env);
  assert.equal(out.alerts, 1, '下單失敗不該擋住 Discord 通知');
  const field = discord[0].embeds[0].fields.find((f) => f.name.includes('自動下單'));
  assert.match(field.value, /❌/);
  assert.equal(executor.calls.find((c) => c.url.endsWith('/trade')), undefined, '任何一段掛不了單就整筆不該送出任何訂單，含進場單本身');
  assert.equal(await env.SMC_KV.get('open-pos:ABCUSDT:long'), null, '沒有實際進場，就不該留下部位追蹤紀錄');
});

test('停損距離很近時，算出的保證金超過上限：先試著拉高槓桿，數量不用縮', async () => {
  // entry 100、stop 99.75（perUnit=0.25），risk 預設 1% × 1000 = 10 → qty=40。
  // 評分 75 分算出的初始槓桿是 5 倍 → 保證金 = 40*100/5 = 800，
  // 超過帳戶的 25%（250）。先試著拉高槓桿：需要 4000/250=16 倍，
  // 16 倍還在合約上限（25）內，拉到 16 倍後保證金剛好等於上限，
  // 不用再縮數量。價格用 99.9（比 stop 高，劇本還沒失效，但夠接近進場區）。
  const discord = [];
  const executor = { calls: [], wallet: { totalAvailableBalance: 1000, totalWalletBalance: 1000 }, instrument: demoInstrument };
  const env = withExecutor({ AUTO_TRADE_MIN_STOP_PCT: '0' });
  await env.SMC_KV.put('auto-trade:enabled', 'true');
  stubFetch({ market: makeMarket([row({ stop: 99.75 })]), prices: { ABCUSDT: 99.9 }, discord, executor });
  await runWorker(env);
  const tradeCall = executor.calls.find((c) => c.url.endsWith('/trade'));
  assert.equal(tradeCall.body.leverage, '16', '應該把槓桿拉高到剛好讓保證金落在上限內');
  assert.equal(tradeCall.body.qty, '40', '拉高槓桿就夠了，不需要縮小數量');
});

test('停損距離很近時，就算拉滿槓桿保證金還是超過上限：縮小數量，實際風險比設定的更小（方向保守）', async () => {
  // entry 100、stop 99.9（perUnit=0.1），risk 預設 1% × 1000 = 10 → qty=100。
  // 就算拉到合約上限 25 倍，保證金還是 100*100/25=400，還是超過上限 250，
  // 只能縮小數量：250*25/100 = 62.5。價格用 100（比 stop 高，劇本沒失效）。
  const discord = [];
  const executor = { calls: [], wallet: { totalAvailableBalance: 1000, totalWalletBalance: 1000 }, instrument: demoInstrument };
  const env = withExecutor({ AUTO_TRADE_MIN_STOP_PCT: '0' });
  await env.SMC_KV.put('auto-trade:enabled', 'true');
  stubFetch({ market: makeMarket([row({ stop: 99.9 })]), prices: { ABCUSDT: 100 }, discord, executor });
  await runWorker(env);
  const tradeCall = executor.calls.find((c) => c.url.endsWith('/trade'));
  assert.equal(tradeCall.body.leverage, '25', '應該拉到合約上限的槓桿');
  assert.equal(tradeCall.body.qty, '62.5', '槓桿拉滿還是不夠，應該縮小數量讓保證金落在上限內');
});

test('保證金上限縮完數量後低於最小下單量：直接跳過這筆，不進場', async () => {
  const discord = [];
  const executor = { calls: [], wallet: { totalAvailableBalance: 1000, totalWalletBalance: 1000 }, instrument: { ...demoInstrument, minQty: 100 } };
  const env = withExecutor({ AUTO_TRADE_MIN_STOP_PCT: '0' });
  await env.SMC_KV.put('auto-trade:enabled', 'true');
  stubFetch({ market: makeMarket([row({ stop: 99.9 })]), prices: { ABCUSDT: 100 }, discord, executor });
  const out = await runWorker(env);
  assert.equal(out.alerts, 1, '下單失敗不該擋住 Discord 通知');
  const field = discord[0].embeds[0].fields.find((f) => f.name.includes('自動下單'));
  assert.match(field.value, /❌.*AUTO_TRADE_MAX_MARGIN_PCT/);
  assert.equal(executor.calls.find((c) => c.url.endsWith('/trade')), undefined, '保證金上限縮完數量不夠就不該送出任何訂單');
});

test('同一個進場區重複執行只會下單一次（跟 Discord 通知共用去重）', async () => {
  const discord = [];
  const executor = { calls: [], wallet: { totalAvailableBalance: 1000, totalWalletBalance: 1000 }, instrument: demoInstrument };
  const env = withExecutor();
  await env.SMC_KV.put('auto-trade:enabled', 'true');
  stubFetch({ market: makeMarket([row()]), prices: { ABCUSDT: 99.9 }, discord, executor });
  await runWorker(env);
  const firstRoundTrades = executor.calls.filter((c) => c.url.endsWith('/trade')).length;
  await runWorker(env);
  const tradeCalls = executor.calls.filter((c) => c.url.endsWith('/trade'));
  assert.equal(tradeCalls.length, firstRoundTrades, '第二次執行不該再下一次單');
});
