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
const cand = (over = {}) => ({ id: 'cc:SOL:15m:L:1', sym: 'SOLUSDT', iv: '15m', ms: 9e5, side: 'L', en: 150, sl: 148.5, tp: 154, rr: 2.6, bias: 2, disc: true, sessKz: false, ...over });

test('倉位大小：每筆固定風險 20U，槓桿 ≤50 而且停損比強平近，保證金不夠就不下', () => {
  const a = sizeCoachOrder({ equity: 220, en: 100, sl: 99 });
  assert.ok(Math.abs(a.riskU - 20) < 1e-9, '打到停損虧 20U');
  assert.equal(a.notional, 2000);
  assert.equal(a.lev, 50);
  assert.equal(a.margin, 40);
  const far = sizeCoachOrder({ equity: 220, en: 100, sl: 95 });
  assert.equal(far.lev, 16, '停損 5% → 槓桿 ≤ 0.8/0.05 = 16');
  assert.ok(far.lev * 0.05 <= 0.8);
  const near = sizeCoachOrder({ equity: 220, en: 100, sl: 99.8, maxNotional: 6000 });
  assert.equal(near.notional, 6000, '名目價值有上限');
  assert.ok(near.riskU < 20, '縮了之後實際風險變小');
  const full = sizeCoachOrder({ equity: 220, en: 100, sl: 99, usedMargin: 190 });
  assert.match(full.skip, /保證金不夠/);
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

test('條件：真錢只做順勢＋≥2R；Demo 有訊號就進', async () => {
  for (const [mode, want] of [['live', 0], ['demo', 1]]) {
    const env = { SMC_KV: makeKv(), EXECUTOR_URL: 'x' }, ex = fakeExecutor();
    await env.SMC_KV.put('coachauto:cfg', JSON.stringify({ mode }));
    const r = await runCoachAuto(env, { executorCall: ex.call, postDiscord: async () => {}, fetchKlines: async () => [], now: Date.UTC(2026, 9, 15, 5), candidates: [cand({ bias: 0, rr: 1.4 })] });
    assert.equal(r.placed.length, want, mode);
  }
});

test('煞車：當天虧 5 筆就暫停（虧 4 筆還會繼續下）；同時最多 5 筆；12 根沒成交就取消', async () => {
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
  // 當天虧 4 筆 → 還會下
  await env.SMC_KV.put('coachauto:trades', JSON.stringify([1, 2, 3, 4].map((i) => ({ id: 'x' + i, account: 'demo', state: 'closed', r: -1.03, closedAt: dayStart(now) + i }))));
  const r1 = await runCoachAuto(env, { ...deps, now: now + 14 * 9e5, candidates: [cand({ id: 'cc:four', sym: 'FOURUSDT' })] });
  assert.equal(r1.placed.length, 1);
  // 當天虧 5 筆 → 暫停
  await env.SMC_KV.put('coachauto:trades', JSON.stringify([1, 2, 3, 4, 5].map((i) => ({ id: 'x' + i, account: 'demo', state: 'closed', r: -1.03, closedAt: dayStart(now) + i }))));
  const r2 = await runCoachAuto(env, { ...deps, now: now + 14 * 9e5, candidates: [cand({ id: 'cc:new', sym: 'NEWUSDT' })] });
  assert.equal(r2.placed.length, 0);
  assert.ok(msgs.some((m) => /暫停到明天早上 8 點/.test(m)));
});

test('每筆風險＝權益 9%：Demo 當成 220U → 約 19.8U', async () => {
  const env = { SMC_KV: makeKv(), EXECUTOR_URL: 'x' }, ex = fakeExecutor();
  ex.equity = 1600;
  await env.SMC_KV.put('coachauto:cfg', JSON.stringify({ mode: 'demo' }));
  await runCoachAuto(env, { executorCall: ex.call, postDiscord: async () => {}, fetchKlines: async () => [], now: Date.UTC(2026, 9, 15, 5), candidates: [cand({ en: 100, sl: 99, tp: 103 })] });
  const o = ex.calls.find((c) => c.path === '/coach/order').body;
  assert.ok(Math.abs(o.qty * 1 - 19.8) < 0.01, `風險 ${o.qty}U`);
});

test('兩個都開（both）：Demo 有訊號就進、真錢只做順勢＋≥2R，各下各的帳戶', async () => {
  const env = { SMC_KV: makeKv(), EXECUTOR_URL: 'x' }, ex = fakeExecutor();
  await env.SMC_KV.put('coachauto:cfg', JSON.stringify({ mode: 'both' }));
  const deps = { executorCall: ex.call, postDiscord: async () => {}, fetchKlines: async () => [], now: Date.UTC(2026, 9, 15, 5) };
  const r = await runCoachAuto(env, { ...deps, candidates: [cand({ id: 'cc:a', sym: 'AUSDT', bias: 2, rr: 2.5 }), cand({ id: 'cc:b', sym: 'BUSDT', bias: 1, rr: 1.4 })] });
  const orders = ex.calls.filter((c) => c.path === '/coach/order').map((c) => `${c.body.account}:${c.body.orderLinkId}`);
  assert.deepEqual(orders.sort(), ['demo:cc:a', 'demo:cc:b', 'live:cc:a']);
  assert.equal(r.placed.length, 3);
});
