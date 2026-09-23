import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.BYBIT_API_KEY = 'k';
process.env.BYBIT_API_SECRET = 's';
process.env.EXECUTOR_HMAC_SECRET = 'a'.repeat(32);
process.env.REQUEST_MAX_AGE_SEC = '30';
process.env.DISCORD_WEBHOOK_URL = '';

// idempotencyStore 是讀寫真實檔案的單例，會撐過重啟——但這也代表撐過
// 「重新跑一次測試」，同樣的 signal_id 在上一次測試留下的紀錄會讓這次
// 的 /trade 誤判成「已經處理過」，回傳快取結果而不是真的執行一次。
// 每次跑測試前先清掉這個檔案，確保測試之間、測試執行之間互不影響。
const __dirname = path.dirname(fileURLToPath(import.meta.url));
fs.rmSync(path.join(__dirname, '..', 'data', 'processed-signals.json'), { force: true });

const { createRequestHandler } = await import('../src/app.js');
const { signRequest } = await import('../src/hmac.js');
const { setEmergencyStop } = await import('../src/healthcheck.js');

/** 開一個監聽在隨機 port 的測試伺服器，回傳 base URL 跟關閉函式 */
async function startServer() {
  const server = createServer(createRequestHandler());
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  return { baseUrl: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) };
}

async function call(baseUrl, method, path, body) {
  const raw = body !== undefined ? JSON.stringify(body) : '';
  const ts = Date.now();
  const sig = signRequest(ts, raw);
  const res = await fetch(baseUrl + path, {
    method,
    headers: {
      'content-type': 'application/json',
      'x-executor-timestamp': String(ts),
      'x-executor-signature': sig,
    },
    body: method === 'GET' ? undefined : raw,
  });
  return { status: res.status, body: await res.json() };
}

const realFetch = globalThis.fetch;

/** 攔截 Executor 打出去的 fetch（Bybit API），依 URL 分派假回應；打去我們自己測試伺服器（127.0.0.1）的請求原封不動放行 */
function stubBybitFetch(bybit) {
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.includes('127.0.0.1') || u.includes('localhost')) return realFetch(url, init);
    if (u.includes('api-demo.bybit.com') || u.includes('api.bybit.com')) {
      bybit.calls.push({ url: u, method: init?.method, body: init?.body ? JSON.parse(init.body) : null });
      const j = (retCode, retMsg, result) => new Response(JSON.stringify({ retCode, retMsg, result }), { status: 200 });
      if (u.includes('/v5/account/wallet-balance')) return j(0, 'OK', bybit.wallet ?? { list: [{ totalAvailableBalance: '1000', totalWalletBalance: '1000' }] });
      if (u.includes('/v5/market/instruments-info')) return j(0, 'OK', bybit.instrument ?? { list: [{ lotSizeFilter: { qtyStep: '0.1', minOrderQty: '0.1' }, priceFilter: { tickSize: '0.01' }, leverageFilter: { maxLeverage: '25' } }] });
      if (u.includes('/v5/position/set-leverage')) return j(0, 'OK', {});
      if (u.includes('/v5/position/trading-stop')) {
        return bybit.tradingStopError ? j(bybit.tradingStopError.code, bybit.tradingStopError.msg, {}) : j(0, 'OK', {});
      }
      if (u.includes('/v5/order/cancel-all')) return j(0, 'OK', {});
      if (u.includes('/v5/position/list')) return j(0, 'OK', { list: bybit.positions ?? [] });
      if (u.includes('/v5/market/time')) return j(0, 'OK', { timeSecond: '1' });
      if (u.includes('/v5/order/create')) {
        return bybit.orderError ? j(bybit.orderError.code, bybit.orderError.msg, {}) : j(0, 'OK', bybit.orderResult ?? { orderId: 'order-123' });
      }
      throw new Error('未預期的 Bybit 端點：' + u);
    }
    throw new Error('未預期的請求：' + u);
  };
}

test('沒有驗證標頭打受保護端點：401', async () => {
  const { baseUrl, close } = await startServer();
  try {
    const res = await fetch(baseUrl + '/balance');
    assert.equal(res.status, 401);
  } finally { await close(); }
});

test('簽章錯誤：401', async () => {
  const { baseUrl, close } = await startServer();
  try {
    const res = await fetch(baseUrl + '/balance', { headers: { 'x-executor-timestamp': String(Date.now()), 'x-executor-signature': 'bad' } });
    assert.equal(res.status, 401);
  } finally { await close(); }
});

test('GET /health 不需要驗證', async () => {
  const { baseUrl, close } = await startServer();
  try {
    const res = await fetch(baseUrl + '/health');
    assert.equal(res.status, 200);
    const out = await res.json();
    assert.equal(typeof out.ok, 'boolean');
  } finally { await close(); }
});

test('POST /trade：成功下單，市價單 + 停損 + 分批出場都掛上', async () => {
  setEmergencyStop(false);
  const bybit = { calls: [] };
  stubBybitFetch(bybit);
  const { baseUrl, close } = await startServer();
  try {
    const res = await call(baseUrl, 'POST', '/trade', {
      signal_id: 'sig-1', symbol: 'BTCUSDT', side: 'Buy', qty: '2', leverage: '5', stop_loss: '95',
      ladder: [{ name: 'TP0', price: '110', qty: '0.68' }, { name: 'TP1', price: '120', qty: '1.32' }],
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.orderId, 'order-123');
    assert.equal(res.body.ladder.length, 2);
    assert.ok(res.body.ladder.every((l) => l.orderId === 'order-123'));
    const entryCall = bybit.calls.find((c) => c.url.includes('order/create') && c.body.orderType === 'Market');
    assert.equal(entryCall.body.orderLinkId, 'sig-1');
    // 保險：進場單本身雖然帶了 stopLoss，但實測發生過部位開出來卻完全沒
    // 停損的情況，開倉後應該再用 trading-stop 明確設定一次同樣的停損。
    const stopCall = bybit.calls.find((c) => c.url.includes('/v5/position/trading-stop'));
    assert.ok(stopCall, '開倉後應該再打一次 trading-stop 明確設定停損');
    assert.equal(stopCall.body.stopLoss, '95');
  } finally { await close(); }
});

test('POST /trade：開倉後明確設定停損那一步失敗，不影響主流程（進場單本身已經帶了停損，這只是多一層保險）', async () => {
  setEmergencyStop(false);
  const bybit = { calls: [], tradingStopError: { code: 10001, msg: 'boom' } };
  stubBybitFetch(bybit);
  const { baseUrl, close } = await startServer();
  try {
    const res = await call(baseUrl, 'POST', '/trade', {
      signal_id: 'sig-stop-fail', symbol: 'BTCUSDT', side: 'Buy', qty: '2', leverage: '5', stop_loss: '95', ladder: [],
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.orderId, 'order-123', '再次設定停損失敗不該擋住整筆下單流程');
  } finally { await close(); }
});

test('POST /trade：分批出場限價單第一次被限流（retCode 10006）會重試一次，重試後成功就正常掛上', async () => {
  setEmergencyStop(false);
  const bybit = { calls: [] };
  let legAttempts = 0;
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.includes('127.0.0.1') || u.includes('localhost')) return realFetch(url, init);
    if (u.includes('api-demo.bybit.com')) {
      bybit.calls.push({ url: u, method: init?.method, body: init?.body ? JSON.parse(init.body) : null });
      const j = (retCode, retMsg, result) => new Response(JSON.stringify({ retCode, retMsg, result }), { status: 200 });
      if (u.includes('/v5/position/set-leverage')) return j(0, 'OK', {});
      if (u.includes('/v5/position/trading-stop')) return j(0, 'OK', {});
      if (u.includes('/v5/order/create')) {
        const body = JSON.parse(init.body);
        if (body.orderType === 'Limit') {
          legAttempts++;
          if (legAttempts === 1) return j(10006, 'rate limited', {});
          return j(0, 'OK', { orderId: 'leg-retry-ok' });
        }
        return j(0, 'OK', { orderId: 'order-123' });
      }
      throw new Error('未預期的 Bybit 端點：' + u);
    }
    throw new Error('未預期的請求：' + u);
  };
  const { baseUrl, close } = await startServer();
  try {
    const res = await call(baseUrl, 'POST', '/trade', {
      signal_id: 'sig-leg-retry', symbol: 'BTCUSDT', side: 'Buy', qty: '2', leverage: '5', stop_loss: '95',
      ladder: [{ name: 'TP0', price: '110', qty: '0.68' }],
    });
    assert.equal(res.body.ladder[0].orderId, 'leg-retry-ok', '第一次被限流重試後應該成功掛上限價單，不該直接放棄');
    assert.equal(res.body.ladder[0].error, undefined);
  } finally { await close(); }
});

test('POST /trade：同一個 signal_id 再送一次，不會重複下單，直接回傳原本的結果', async () => {
  setEmergencyStop(false);
  const bybit = { calls: [] };
  stubBybitFetch(bybit);
  const { baseUrl, close } = await startServer();
  try {
    const payload = { signal_id: 'sig-dup', symbol: 'BTCUSDT', side: 'Buy', qty: '2', leverage: '5', stop_loss: '95', ladder: [] };
    const first = await call(baseUrl, 'POST', '/trade', payload);
    const callsAfterFirst = bybit.calls.length;
    const second = await call(baseUrl, 'POST', '/trade', payload);
    assert.equal(bybit.calls.length, callsAfterFirst, '第二次不該再打任何 Bybit API');
    assert.equal(second.body.idempotent, true);
    assert.equal(second.body.orderId, first.body.orderId);
  } finally { await close(); }
});

test('緊急停止觸發時：/trade 直接被拒絕，不會打任何 Bybit API', async () => {
  setEmergencyStop(true, '測試用');
  const bybit = { calls: [] };
  stubBybitFetch(bybit);
  const { baseUrl, close } = await startServer();
  try {
    const res = await call(baseUrl, 'POST', '/trade', {
      signal_id: 'sig-blocked', symbol: 'BTCUSDT', side: 'Buy', qty: '2', leverage: '5', stop_loss: '95', ladder: [],
    });
    assert.equal(res.status, 503);
    assert.equal(bybit.calls.length, 0);
  } finally {
    setEmergencyStop(false);
    await close();
  }
});

test('POST /trade：缺必要欄位回 400，不會嘗試下單', async () => {
  setEmergencyStop(false);
  const bybit = { calls: [] };
  stubBybitFetch(bybit);
  const { baseUrl, close } = await startServer();
  try {
    const res = await call(baseUrl, 'POST', '/trade', { signal_id: 'sig-x', symbol: 'BTCUSDT' });
    assert.equal(res.status, 400);
    assert.equal(bybit.calls.length, 0);
  } finally { await close(); }
});

test('GET /balance：驗證通過就回傳餘額', async () => {
  stubBybitFetch({ calls: [], wallet: { list: [{ totalAvailableBalance: '42.5', totalWalletBalance: '100' }] } });
  const { baseUrl, close } = await startServer();
  try {
    const res = await call(baseUrl, 'GET', '/balance');
    assert.equal(res.status, 200);
    assert.equal(res.body.totalAvailableBalance, 42.5);
  } finally { await close(); }
});

test('POST /add-exit-leg：補掛單一段出場單', async () => {
  setEmergencyStop(false);
  const bybit = { calls: [] };
  stubBybitFetch(bybit);
  const { baseUrl, close } = await startServer();
  try {
    const res = await call(baseUrl, 'POST', '/add-exit-leg', { symbol: 'BTCUSDT', side: 'Sell', qty: '1', price: '110' });
    assert.equal(res.status, 200);
    assert.equal(res.body.orderId, 'order-123');
  } finally { await close(); }
});

test('POST /emergency-stop：手動觸發後，狀態會反映在 GET /health', async () => {
  const bybit = { calls: [] };
  stubBybitFetch(bybit);
  const { baseUrl, close } = await startServer();
  try {
    await call(baseUrl, 'POST', '/emergency-stop', { tripped: true, reason: '手動測試' });
    const health = await fetch(baseUrl + '/health').then((r) => r.json());
    assert.equal(health.emergencyStop, true);

    await call(baseUrl, 'POST', '/emergency-stop', { tripped: false });
    const health2 = await fetch(baseUrl + '/health').then((r) => r.json());
    assert.equal(health2.emergencyStop, false);
  } finally { await close(); }
});
