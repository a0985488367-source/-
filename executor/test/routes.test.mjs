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
      if (u.includes('/v5/execution/list')) {
        const cursor = new URL(u).searchParams.get('cursor');
        if (bybit.execError) return j(10001, bybit.execError, {});
        // 第一週第一頁有下一頁，其他都是空的
        if (!cursor && !bybit.execServed) { bybit.execServed = true; return j(0, 'OK', { list: [{ symbol: 'BTCUSDT', side: 'Buy', orderLinkId: 'bo:BTC:l:4h:abc', execPrice: '100', execQty: '1', execFee: '0.05', execTime: '1', execType: 'Trade' }], nextPageCursor: 'p2' }); }
        if (cursor === 'p2') return j(0, 'OK', { list: [{ symbol: 'BTCUSDT', side: 'Sell', orderLinkId: '', execPrice: '110', execQty: '1', execFee: '0.05', execTime: '2', execType: 'Trade', closedSize: '1' }], nextPageCursor: '' });
        return j(0, 'OK', { list: [], nextPageCursor: '' });
      }
      if (u.includes('/v5/account/transaction-log')) {
        bybit.txCalls = (bybit.txCalls || 0) + 1;
        if (bybit.txServed) return j(0, 'OK', { list: [], nextPageCursor: '' });
        bybit.txServed = true;
        return j(0, 'OK', { list: [{ transactionTime: '5', type: 'TRANSFER_OUT', currency: 'USDT', change: '-2000', cashBalance: '1500', category: '', symbol: '' }], nextPageCursor: '' });
      }
      if (u.includes('/v5/position/closed-pnl')) return bybit.closedPnl ? j(0, 'OK', { list: bybit.closedPnl }) : j(10016, 'service unavailable', {});
      if (u.includes('/v5/order/realtime')) return j(0, 'OK', { list: bybit.openOrders ?? [] });
      if (u.includes('/v5/order/history')) return j(0, 'OK', { list: bybit.orderHistory ?? [] });
      if (u.includes('/v5/order/cancel')) return bybit.cancelError ? j(bybit.cancelError.code, bybit.cancelError.msg, {}) : j(0, 'OK', {});
      if (u.includes('/v5/order/create')) {
        bybit.onOrder?.(init?.body ? JSON.parse(init.body) : null);
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

test('GET /history：一週一週往前查、每週翻頁；已平倉損益失敗不影響成交明細', async () => {
  const bybit = { calls: [] };
  stubBybitFetch(bybit);
  const { baseUrl, close } = await startServer();
  try {
    const res = await call(baseUrl, 'GET', '/history?days=20');
    assert.equal(res.status, 200);
    assert.equal(res.body.days, 20);
    assert.equal(res.body.executions.length, 2);
    assert.equal(res.body.executions[0].orderLinkId, 'bo:BTC:l:4h:abc');
    assert.equal(res.body.executions[1].closedSize, 1);
    assert.ok(res.body.errors.closedPnl, '已平倉損益查詢失敗要回報錯誤');
    const weeks = bybit.calls.filter((c) => c.url.includes('/v5/execution/list') && !c.url.includes('cursor='));
    assert.equal(weeks.length, 3, '20 天 = 3 段（7＋7＋6 天）');
    for (const w of weeks) {
      const q = new URL(w.url).searchParams;
      assert.ok(Number(q.get('endTime')) - Number(q.get('startTime')) < 7 * 86_400_000);
    }
  } finally { await close(); }
});

test('GET /ledger：資金流水不分產品、一週一週查，附各幣餘額', async () => {
  const bybit = { calls: [], wallet: { list: [{ totalWalletBalance: '1500', totalEquity: '1490', coin: [{ coin: 'USDT', walletBalance: '1500', equity: '1490', usdValue: '1490' }, { coin: 'BTC', walletBalance: '0', equity: '0' }] }] } };
  stubBybitFetch(bybit);
  const { baseUrl, close } = await startServer();
  try {
    const res = await call(baseUrl, 'GET', '/ledger?days=10');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.logs.map((l) => [l.type, l.change, l.cashBalance]), [['TRANSFER_OUT', -2000, 1500]]);
    assert.deepEqual(res.body.wallet.coins.map((c) => c.coin), ['USDT']);
    const tx = bybit.calls.filter((c) => c.url.includes('/v5/account/transaction-log'));
    assert.equal(tx.length, 2, '10 天 = 2 段');
    assert.ok(tx.every((c) => new URL(c.url).searchParams.get('accountType') === 'UNIFIED' && !new URL(c.url).searchParams.get('category')));
    assert.equal(tx.filter((c) => c.method !== 'GET').length, 0);
  } finally { await close(); }
});

test('GET /ledger：沒有簽章 → 401', async () => {
  stubBybitFetch({ calls: [] });
  const { baseUrl, close } = await startServer();
  try {
    const res = await fetch(`${baseUrl}/ledger`);
    assert.equal(res.status, 401);
  } finally { await close(); }
});

test('GET /history：沒有簽章 → 401', async () => {
  stubBybitFetch({ calls: [] });
  const { baseUrl, close } = await startServer();
  try {
    const res = await fetch(`${baseUrl}/history`);
    assert.equal(res.status, 401);
  } finally { await close(); }
});

test('GET /journal：沒設定唯讀金鑰時回 configured=false，不會去打 Bybit；沒簽章被拒絕', async () => {
  const { baseUrl, close } = await startServer();
  try {
    const r = await call(baseUrl, 'GET', '/journal?days=7');
    assert.equal(r.status, 200);
    assert.equal(r.body.configured, false);
    assert.match(r.body.error, /BYBIT_READ_API_KEY/);
    const raw = await fetch(baseUrl + '/journal');
    assert.equal(raw.status, 401);
  } finally { await close(); }
});


test('POST /coach/order：限價＋停損＋目標一起掛，數量照合約步進取整；方向錯、別人的單、已有持倉都擋下', async () => {
  const { baseUrl, close } = await startServer();
  const bybit = { calls: [] };
  stubBybitFetch(bybit);
  try {
    const ok = await call(baseUrl, 'POST', '/coach/order', { account: 'demo', symbol: 'SOLUSDT', side: 'Buy', qty: 3.37, price: 150.004, stopLoss: 148, takeProfit: 156, leverage: 30, orderLinkId: 'cc:SOL:15m:L:1' });
    assert.equal(ok.body.ok, true, JSON.stringify(ok.body));
    assert.equal(ok.body.qty, 3.3);
    assert.equal(ok.body.leverage, 25, '不超過合約槓桿上限');
    const create = bybit.calls.find((c) => c.url.includes('/v5/order/create'));
    assert.equal(create.body.orderType, 'Limit');
    assert.equal(create.body.stopLoss, '148');
    assert.equal(create.body.takeProfit, '156');
    assert.match(create.url, /api-demo\.bybit\.com/, '主帳戶是 Demo 時，demo 走主帳戶');

    const wrong = await call(baseUrl, 'POST', '/coach/order', { account: 'demo', symbol: 'SOLUSDT', side: 'Buy', qty: 1, price: 150, stopLoss: 152, takeProfit: 156, leverage: 5, orderLinkId: 'cc:x' });
    assert.equal(wrong.status, 400);
    const notCoach = await call(baseUrl, 'POST', '/coach/order', { account: 'demo', symbol: 'SOLUSDT', side: 'Buy', qty: 1, price: 150, stopLoss: 148, takeProfit: 156, leverage: 5, orderLinkId: 'manual-1' });
    assert.equal(notCoach.status, 400);

    bybit.openOrders = [{ orderLinkId: 'my-own', symbol: 'SOLUSDT' }];
    const busy = await call(baseUrl, 'POST', '/coach/order', { account: 'demo', symbol: 'SOLUSDT', side: 'Buy', qty: 1, price: 150, stopLoss: 148, takeProfit: 156, leverage: 5, orderLinkId: 'cc:y' });
    assert.equal(busy.body.skipped, 'symbol-has-manual-orders');
    bybit.openOrders = []; bybit.positions = [{ symbol: 'SOLUSDT', size: '2', side: 'Sell' }];
    const pos = await call(baseUrl, 'POST', '/coach/order', { account: 'demo', symbol: 'SOLUSDT', side: 'Buy', qty: 1, price: 150, stopLoss: 148, takeProfit: 156, leverage: 5, orderLinkId: 'cc:z' });
    assert.equal(pos.body.skipped, 'symbol-has-position');

    const live = await call(baseUrl, 'POST', '/coach/order', { account: 'live', symbol: 'SOLUSDT', side: 'Buy', qty: 1, price: 150, stopLoss: 148, takeProfit: 156, leverage: 5, orderLinkId: 'cc:w' });
    assert.equal(live.status, 400, '沒設真錢金鑰時拒絕');
  } finally { globalThis.fetch = realFetch; await close(); }
});

test('POST /coach/cancel 只取消 cc: 的單；GET /coach/state 只回 cc: 的掛單', async () => {
  const { baseUrl, close } = await startServer();
  const bybit = { calls: [], openOrders: [{ orderLinkId: 'cc:a', symbol: 'BTCUSDT', side: 'Buy', price: '1', qty: '1', cumExecQty: '0', orderStatus: 'New' }, { orderLinkId: 'manual', symbol: 'ETHUSDT' }], orderHistory: [{ orderLinkId: 'cc:b', symbol: 'XRPUSDT', orderStatus: 'Filled', avgPrice: '2', cumExecQty: '5', updatedTime: '9' }], closedPnl: [{ symbol: 'XRPUSDT', side: 'Sell', qty: '5', closedPnl: '1.5', avgEntryPrice: '2', avgExitPrice: '2.3', createdTime: '10', updatedTime: '10' }] };
  stubBybitFetch(bybit);
  try {
    assert.equal((await call(baseUrl, 'POST', '/coach/cancel', { account: 'demo', symbol: 'BTCUSDT', orderLinkId: 'manual' })).status, 400);
    assert.equal((await call(baseUrl, 'POST', '/coach/cancel', { account: 'demo', symbol: 'BTCUSDT', orderLinkId: 'cc:a' })).body.ok, true);
    const st = await call(baseUrl, 'GET', '/coach/state?account=demo');
    assert.equal(st.body.configured, true);
    assert.deepEqual(st.body.orders.map((o) => o.orderLinkId), ['cc:a']);
    assert.equal(st.body.history[0].orderStatus, 'Filled');
    assert.equal(st.body.closedPnl[0].closedPnl, 1.5);
  } finally { globalThis.fetch = realFetch; await close(); }
});

test('POST /dc/adjust：沒部位 → 市價買到目標（照步進捨去）並設災難停損', async () => {
  setEmergencyStop(false);
  const bybit = { calls: [], positions: [] };
  bybit.onOrder = (b) => { bybit.positions = [{ symbol: b.symbol, side: 'Buy', size: b.qty, avgPrice: '100' }]; };
  stubBybitFetch(bybit);
  const { baseUrl, close } = await startServer();
  try {
    const res = await call(baseUrl, 'POST', '/dc/adjust', { symbol: 'BTCUSDT', targetQty: 0.123, expectQty: 0, refPrice: 100, stopLoss: 90, leverage: 10, orderLinkId: 'dc:BTC:20261022' });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.ordered, 0.1);
    assert.equal(res.body.after, 0.1);
    assert.equal(res.body.stopLoss, 90);
    const order = bybit.calls.find((c) => c.url.includes('order/create'));
    assert.deepEqual([order.body.side, order.body.qty, order.body.orderLinkId, order.body.reduceOnly], ['Buy', '0.1', 'dc:BTC:20261022', undefined]);
    assert.ok(bybit.calls.some((c) => c.url.includes('trading-stop') && c.body.stopLoss === '90'));
  } finally { await close(); }
});

test('POST /dc/adjust：交易所部位跟唐奇安記的對不上（別人佔著）→ 不碰', async () => {
  setEmergencyStop(false);
  const bybit = { calls: [], positions: [{ symbol: 'ETHUSDT', side: 'Buy', size: '0.5', avgPrice: '100' }] };
  stubBybitFetch(bybit);
  const { baseUrl, close } = await startServer();
  try {
    const res = await call(baseUrl, 'POST', '/dc/adjust', { symbol: 'ETHUSDT', targetQty: 1, expectQty: 0, refPrice: 100, orderLinkId: 'dc:ETH:20261022' });
    assert.equal(res.body.ok, false);
    assert.equal(res.body.skipped, 'occupied');
    assert.equal(bybit.calls.filter((c) => c.url.includes('order/create')).length, 0);
  } finally { await close(); }
});

test('POST /dc/adjust：目標低於最小下單量 → reduce-only 全平', async () => {
  setEmergencyStop(false);
  const bybit = { calls: [], positions: [{ symbol: 'SOLUSDT', side: 'Buy', size: '0.5', avgPrice: '100' }] };
  bybit.onOrder = () => { bybit.positions = []; };
  stubBybitFetch(bybit);
  const { baseUrl, close } = await startServer();
  try {
    const res = await call(baseUrl, 'POST', '/dc/adjust', { symbol: 'SOLUSDT', targetQty: 0.04, expectQty: 0.5, refPrice: 100, stopLoss: 90, orderLinkId: 'dc:SOL:20261022' });
    assert.equal(res.body.ok, true);
    assert.equal(res.body.after, 0);
    const order = bybit.calls.find((c) => c.url.includes('order/create'));
    assert.deepEqual([order.body.side, order.body.qty, order.body.reduceOnly], ['Sell', '0.5', true]);
    assert.equal(bybit.calls.filter((c) => c.url.includes('trading-stop')).length, 0, '平光了就不用設停損');
  } finally { await close(); }
});

test('POST /dc/adjust：orderLinkId 不是 dc: 開頭 → 400', async () => {
  stubBybitFetch({ calls: [] });
  const { baseUrl, close } = await startServer();
  try {
    const res = await call(baseUrl, 'POST', '/dc/adjust', { symbol: 'BTCUSDT', targetQty: 1, expectQty: 0, refPrice: 100, orderLinkId: 'bo:x' });
    assert.equal(res.status, 400);
  } finally { await close(); }
});
