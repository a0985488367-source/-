import test from 'node:test';
import assert from 'node:assert/strict';
import { sizeCoachOrder, runCoachAuto, handleCoachAuto, dayStart } from '../worker/coach-auto.js';

function makeKv() {
  const m = new Map();
  return { store: m, async get(k) { return m.get(k) ?? null; }, async put(k, v) { m.set(k, v); } };
}
/** 假的 Executor：記住掛單，讓測試控制成交／平倉 */
function fakeExecutor() {
  const ex = { orders: [], history: [], positions: [], closedPnl: [], equity: 220, calls: [] };
  ex.call = async (env, method, path, { query, body } = {}) => {
    ex.calls.push({ method, path, query, body });
    if (path === '/coach/state') return { configured: true, equity: ex.equity, orders: ex.orders, history: ex.history, positions: ex.positions, closedPnl: ex.closedPnl, errors: {} };
    if (path === '/coach/order') { ex.orders.push({ orderLinkId: body.orderLinkId, symbol: body.symbol, cumExecQty: 0 }); return { ok: true, qty: Math.floor(body.qty * 10) / 10, price: body.price, stopLoss: body.stopLoss, takeProfit: body.takeProfit, leverage: body.leverage }; }
    if (path === '/coach/cancel') { ex.orders = ex.orders.filter((o) => o.orderLinkId !== body.orderLinkId); return { ok: true }; }
    throw new Error('未預期 ' + path);
  };
  return ex;
}
const cand = (over = {}) => ({ id: 'cc:SOL:15m:L:1', sym: 'SOLUSDT', iv: '15m', ms: 9e5, side: 'L', en: 150, sl: 148.5, tp: 154, rr: 2.6, disc: true, sessKz: false, ...over });

test('倉位大小：風險 1.5%～2.5%，保證金 20U，槓桿＝名目價值÷20，停損一定比強平近', () => {
  const a = sizeCoachOrder({ equity: 220, en: 100, sl: 99, disc: false, sessKz: false });
  assert.equal(a.riskPct, 0.015);
  assert.equal(a.lev, 17); // 220×1.5%÷1% = 330U → 330÷20 = 16.5 → 17 倍
  assert.ok(Math.abs(a.riskU - 340 / 100) < 1e-9, '1R ≈ 3.4U');
  const b = sizeCoachOrder({ equity: 220, en: 100, sl: 99, disc: true, sessKz: true });
  assert.equal(b.riskPct, 0.025);
  const c = sizeCoachOrder({ equity: 220, en: 100, sl: 99.9, disc: true, sessKz: true });
  assert.equal(c.lev, 50, '最高 50 倍');
  const d = sizeCoachOrder({ equity: 220, en: 100, sl: 95, disc: false, sessKz: false });
  assert.ok(d.lev * 0.05 <= 0.8);
});

test('自動下單：關的時候不下；開 Demo → 掛單 → 成交 → 平倉算 R', async () => {
  const env = { SMC_KV: makeKv(), EXECUTOR_URL: 'x' }, ex = fakeExecutor(), msgs = [];
  const deps = { executorCall: ex.call, postDiscord: async (e, p) => msgs.push(p.content), fetchKlines: async () => [], now: Date.UTC(2026, 9, 15, 3) };
  assert.equal((await runCoachAuto(env, { ...deps, candidates: [cand()] })).mode, 'off');
  assert.equal(ex.calls.length, 0);
  const tok = (b) => new Request('https://w/coach-auto', { method: 'POST', body: JSON.stringify(b) });
  assert.equal((await handleCoachAuto(tok({ mode: 'demo' }), env)).status, 200);
  let r = await runCoachAuto(env, { ...deps, candidates: [cand()] });
  assert.deepEqual(r.placed, ['cc:SOL:15m:L:1']);
  assert.match(msgs.at(-1), /教練自動下單（Demo）｜SOL 15m 多單/);
  // 同一個劇本不重複下
  await runCoachAuto(env, { ...deps, candidates: [cand()] });
  assert.equal(ex.calls.filter((c) => c.path === '/coach/order').length, 1);
  // 成交
  ex.orders = []; ex.history = [{ orderLinkId: 'cc:SOL:15m:L:1', orderStatus: 'Filled', avgPrice: 150, cumExecQty: 2.2, updatedTime: deps.now }];
  ex.positions = [{ symbol: 'SOLUSDT', size: 2.2, avgPrice: 150 }];
  await runCoachAuto(env, deps);
  assert.match(msgs.at(-1), /成交 150/);
  // 停損出場
  ex.positions = []; ex.closedPnl = [{ symbol: 'SOLUSDT', closedPnl: -3.4, updatedTime: deps.now + 1000 }];
  await runCoachAuto(env, deps);
  assert.match(msgs.at(-1), /平倉 -1\.03R/);
  const st = (await handleCoachAuto(new Request('https://w/coach-auto'), env)).body;
  assert.equal(st.trades[0].state, 'closed');
  assert.equal(st.trades[0].r, -1.03);
});

test('煞車：當天虧到 -3R 就暫停；同時最多 5 筆；12 根沒成交就取消', async () => {
  const env = { SMC_KV: makeKv(), EXECUTOR_URL: 'x' }, ex = fakeExecutor(), msgs = [];
  const now = Date.UTC(2026, 9, 15, 5);
  const deps = { executorCall: ex.call, postDiscord: async (e, p) => msgs.push(p.content), fetchKlines: async () => [], now };
  await env.SMC_KV.put('coachauto:cfg', JSON.stringify({ mode: 'demo' }));
  // 最多 5 筆
  const many = ['A', 'B', 'C', 'D', 'E', 'F', 'G'].map((s, i) => cand({ id: `cc:${s}:15m:L:${i}`, sym: `${s}USDT` }));
  const r = await runCoachAuto(env, { ...deps, candidates: many });
  assert.equal(r.placed.length, 5);
  // 過了有效時間還沒成交 → 取消
  await runCoachAuto(env, { ...deps, now: now + 13 * 9e5 });
  assert.equal(ex.orders.length, 0);
  assert.ok(msgs.some((m) => /取消掛單（12 根沒成交）/.test(m)));
  // 當天虧 3R → 暫停
  await env.SMC_KV.put('coachauto:trades', JSON.stringify([1, 2, 3].map((i) => ({ id: 'x' + i, account: 'demo', state: 'closed', r: -1.03, closedAt: dayStart(now) + i }))));
  const r2 = await runCoachAuto(env, { ...deps, now: now + 14 * 9e5, candidates: [cand({ id: 'cc:new', sym: 'NEWUSDT' })] });
  assert.equal(r2.placed.length, 0);
  assert.ok(msgs.some((m) => /暫停到明天早上 8 點/.test(m)));
});
