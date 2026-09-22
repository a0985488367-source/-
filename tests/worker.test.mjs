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

test('/status 回報 Worker 自己掃描有沒有開', async () => {
  stubFetch({ market: makeMarket([]), prices: {}, discord: [] });
  const off = await (await worker.fetch(new Request('https://w.test/status'), makeEnv())).json();
  assert.equal(off.workerScanEnabled, false);
  assert.equal(off.workerScanTop, null);

  const on = await (await worker.fetch(new Request('https://w.test/status'), makeEnv({ WORKER_SCAN_ENABLED: 'true', WORKER_SCAN_TOP: '30' }))).json();
  assert.equal(on.workerScanEnabled, true);
  assert.equal(on.workerScanTop, 30);
});

/* -------------------------------------------------------- Worker 自己掃描 */

test('WORKER_SCAN_ENABLED 開啟時，Worker 自己即時掃描，不去讀 data/market.json', async () => {
  const discord = [];
  const env = makeEnv({ WORKER_SCAN_ENABLED: 'true', WORKER_SCAN_PROVIDERS: 'demo', WORKER_SCAN_TOP: '5' });
  let marketUrlCalled = false;
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.startsWith(MARKET_URL)) { marketUrlCalled = true; return new Response('不該被呼叫', { status: 500 }); }
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

test('開啟後價格到了：用可用餘額 × 風險 % 算數量，送出市價單並帶停損停利', async () => {
  const discord = [];
  const bybit = { calls: [], wallet: demoWallet, instrument: demoInstrument, orderResult: { orderId: 'order-abc123' } };
  const env = makeEnv({ BYBIT_DEMO_API_KEY: 'k', BYBIT_DEMO_API_SECRET: 's' });
  await env.SMC_KV.put('auto-trade:enabled', 'true');
  stubFetch({ market: makeMarket([row()]), prices: { ABCUSDT: 99.9 }, discord, bybit });
  const out = await runWorker(env);

  assert.equal(out.alerts, 1);
  const orderCall = bybit.calls.find((c) => c.url.includes('/v5/order/create'));
  assert.ok(orderCall, '應該呼叫 order/create');
  // 帳戶 1000 USDT × 1% 風險 ÷ 每單位風險 5（entry 100 - stop 95）= 2，對齊步進 0.1 還是 2
  assert.equal(orderCall.body.qty, '2');
  assert.equal(orderCall.body.side, 'Buy');
  assert.equal(orderCall.body.stopLoss, '95');
  assert.equal(orderCall.body.takeProfit, '115');

  const field = discord[0].embeds[0].fields.find((f) => f.name.includes('自動下單'));
  assert.match(field.value, /✅/);
  assert.match(field.value, /2/);
  // score 75、MIN_SCORE 65、槓桿範圍 3~10 倍 → (75-65)/(100-65)=0.29 → 3+0.29*7≈5 倍
  const leverageCall = bybit.calls.find((c) => c.url.includes('/v5/position/set-leverage'));
  assert.equal(leverageCall.body.buyLeverage, '5');
  assert.match(field.value, /5x 槓桿/);
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
  await runWorker(env);
  const orderCalls = bybit.calls.filter((c) => c.url.includes('order/create'));
  assert.equal(orderCalls.length, 1, '第二次執行不該再下一次單');
});
