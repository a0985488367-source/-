import test from 'node:test';
import assert from 'node:assert/strict';
import { sizeCoachOrder, runCoachAuto, handleCoachAuto, dayStart, safeLev, liqSafe, placeTrendLive, manageTrendLive } from '../worker/coach-auto.js';

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

test('倉位大小：每筆固定風險 20U，強平距離 ≥ 停損 1.3 倍，保證金不夠就不下', () => {
  const a = sizeCoachOrder({ equity: 220, en: 100, sl: 99 });
  assert.ok(Math.abs(a.riskU - 20) < 1e-9, '打到停損虧 20U');
  assert.equal(a.notional, 2000);
  assert.equal(a.lev, 43, '停損 1% → 1/(1.3%+1%) = 43x');
  assert.ok(Math.abs(a.margin - 2000 / 43) < 1e-9);
  const far = sizeCoachOrder({ equity: 220, en: 100, sl: 95 });
  assert.equal(far.lev, 13, '停損 5% → 1/(6.5%+1%) = 13x');
  // 實際案例：SOL 空單 103.02 停損 ≈105.07（2%），舊算法開 40x 強平剛好在停損上；新算法 27x，強平約 +2.7～3.2%
  const sol = safeLev(0.0199);
  assert.equal(sol, 27);
  assert.ok(1 / sol - 0.01 >= 0.0199 * 1.3);
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
  const many = ['A', 'B', 'C', 'D', 'E', 'F', 'G'].map((s, i) => cand({ id: `cc:${s}:15m:L:${i}`, sym: `${s}USDT`, sl: 147 }));
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

test('真錢條件可以一鍵切換：liveLoose 打開後逆勢、不到 2R 的也下真錢', async () => {
  const env = { SMC_KV: makeKv(), EXECUTOR_URL: 'x' }, ex = fakeExecutor();
  await env.SMC_KV.put('coachauto:cfg', JSON.stringify({ mode: 'live' }));
  const deps = { executorCall: ex.call, postDiscord: async () => {}, fetchKlines: async () => [], now: Date.UTC(2026, 9, 15, 5) };
  await runCoachAuto(env, { ...deps, candidates: [cand({ id: 'cc:x', sym: 'XUSDT', bias: 0, rr: 1.5 })] });
  assert.equal(ex.calls.filter((c) => c.path === '/coach/order').length, 0, '嚴格時不下');
  await handleCoachAuto(new Request('https://w/coach-auto', { method: 'POST', body: JSON.stringify({ liveLoose: true }) }), env);
  await runCoachAuto(env, { ...deps, candidates: [cand({ id: 'cc:y', sym: 'YUSDT', bias: 0, rr: 1.5 })] });
  assert.equal(ex.calls.filter((c) => c.path === '/coach/order').length, 1, '寬鬆時下');
});

test('強平價太靠近停損：判斷正確，開著的教練倉位會自動降槓桿', async () => {
  assert.equal(liqSafe({ side: 'S', en: 103.02, sl: 105.07, liq: 105.07 }), false, 'SOL 那張：強平就在停損上');
  assert.equal(liqSafe({ side: 'S', en: 103.02, sl: 105.07, liq: 105.5 }), true);
  assert.equal(liqSafe({ side: 'L', en: 100, sl: 99, liq: 98.4 }), true);
  assert.equal(liqSafe({ side: 'L', en: 100, sl: 99, liq: 98.9 }), false);
  const env = { SMC_KV: makeKv(), EXECUTOR_URL: 'x' }, ex = fakeExecutor(), msgs = [];
  await env.SMC_KV.put('coachauto:cfg', JSON.stringify({ mode: 'live' }));
  await env.SMC_KV.put('coachauto:trades', JSON.stringify([{ id: 'cc:SOL:15m:S:1', account: 'live', sym: 'SOLUSDT', iv: '15m', ms: 9e5, side: 'S', en: 103.02, sl: 105.07, tp: 101.4, state: 'open', qty: 10.2, riskU: 20.9, lev: 40, placedAt: 1, fillAt: 1 }]));
  ex.positions = [{ symbol: 'SOLUSDT', side: 'Sell', size: 10.2, avgPrice: 103.02, leverage: 40, liqPrice: 105.07, positionIM: 26.3 }];
  const base = ex.call;
  ex.call = async (e, m, path, o = {}) => (path === '/coach/leverage' ? (ex.calls.push({ path, body: o.body }), { ok: true, how: 'set-leverage', leverage: o.body.leverage, liqPrice: 106.1 }) : base(e, m, path, o));
  await runCoachAuto(env, { executorCall: ex.call, postDiscord: async (e, p) => msgs.push(p.content), fetchKlines: async () => [], now: Date.UTC(2026, 9, 15, 8) });
  const c = ex.calls.find((x) => x.path === '/coach/leverage');
  assert.equal(c.body.leverage, 27);
  assert.ok(c.body.addMargin > 10 && c.body.addMargin < 15, `補保證金 ${c.body.addMargin}`);
  assert.match(msgs.at(-1), /40x → 27x，強平價移到 106\.100/);
});

test('超級趨勢上真錢：每單風險 9%、市價進場掛停損、最多 5 張、保本＋追蹤停損、平倉算 R', async () => {
  const env = { SMC_KV: makeKv(), EXECUTOR_URL: 'x' }, msgs = [], calls = [];
  const st = { configured: true, equity: 240, positions: [], orders: [], history: [], closedPnl: [], errors: {} };
  const executorCall = async (e, m, path, { body } = {}) => {
    calls.push({ path, body });
    if (path === '/coach/state') return st;
    if (path === '/coach/market') { st.positions.push({ symbol: body.symbol, size: body.qty, avgPrice: 10, positionIM: body.qty * 10 / body.leverage }); return { ok: true, qty: body.qty, avgPrice: 10, stopLoss: body.stopLoss, leverage: body.leverage, liqPrice: 11.2 }; }
    if (path === '/coach/set-stop') return { ok: true, stopLoss: body.stopLoss };
    throw new Error(path);
  };
  const deps = { executorCall, postDiscord: async (e, p) => msgs.push(p.content) };
  const mgmt = { breakevenAtR: 1, breakevenOffsetR: 0.05, trailFromR: 1.5, trailGapR: 1.5 };
  const sig = (sym) => ({ symbol: sym, strategy: 'st', dir: 'short' });
  const plan = { entry: 10, stop: 10.4, risk: 0.4 };
  // 不是超級趨勢 → 不上真錢
  assert.equal(await placeTrendLive(env, { ...sig('AUSDT'), strategy: 'ema' }, { interval: '4h', signalId: 'ema:A', price: 10, plan, management: mgmt, ...deps }), null);
  const r = await placeTrendLive(env, sig('AUSDT'), { interval: '4h', signalId: 'st:A:s:4h:x', price: 10, plan, management: mgmt, ...deps, now: 1000 });
  assert.ok(r.ok);
  const o = calls.find((c) => c.path === '/coach/market').body;
  assert.equal(o.account, 'live');
  assert.equal(o.orderLinkId, 'ct:st:A:s:4h:x');
  assert.equal(o.side, 'Sell');
  assert.ok(Math.abs(o.qty * 0.4 - 21.6) < 1e-9, '打到停損虧 240×9%＝21.6U');
  assert.equal(o.leverage, safeLev(0.04));
  assert.match(msgs.at(-1), /超級趨勢（真錢）｜A 4h 空單：市價成交/);
  // 同一個幣不重複
  await placeTrendLive(env, sig('AUSDT'), { interval: '4h', signalId: 'st:A:s:4h:y', price: 10, plan, management: mgmt, ...deps });
  assert.equal(calls.filter((c) => c.path === '/coach/market').length, 1);
  // 最多 5 張
  for (const x of ['B', 'C', 'D', 'E', 'F']) await placeTrendLive(env, sig(x + 'USDT'), { interval: '4h', signalId: 'st:' + x, price: 10, plan, management: mgmt, ...deps });
  assert.equal(calls.filter((c) => c.path === '/coach/market').length, 5);
  assert.match(msgs.at(-1), /達上限 5/);
  // 賺 1.2R → 保本；賺 3R → 追蹤到鎖 1.5R
  await manageTrendLive(env, { ...deps, getPrices: async () => ({ AUSDT: 9.52 }) });
  let t = JSON.parse(await env.SMC_KV.get('trendlive:trades')).find((x) => x.sym === 'AUSDT');
  assert.ok(Math.abs(t.stop - 9.98) < 1e-9, `保本 ${t.stop}`);
  assert.match(msgs.at(-1), /保本/);
  await manageTrendLive(env, { ...deps, getPrices: async () => ({ AUSDT: 8.8 }) });
  t = JSON.parse(await env.SMC_KV.get('trendlive:trades')).find((x) => x.sym === 'AUSDT');
  assert.ok(Math.abs(t.stop - 9.4) < 1e-9, `追蹤 ${t.stop}`);
  // 平倉
  st.positions = st.positions.filter((p) => p.symbol !== 'AUSDT');
  st.closedPnl = [{ symbol: 'AUSDT', closedPnl: 32.4, updatedTime: 5000 }];
  await manageTrendLive(env, { ...deps, getPrices: async () => ({}) });
  t = JSON.parse(await env.SMC_KV.get('trendlive:trades')).find((x) => x.sym === 'AUSDT');
  assert.equal(t.state, 'closed');
  assert.equal(t.r, 1.5);
  assert.match(msgs.at(-1), /平倉 \+1\.50R/);
  // App 可以關掉
  await handleCoachAuto(new Request('https://w/coach-auto', { method: 'POST', body: JSON.stringify({ trendLive: false }) }), env);
  assert.equal(await placeTrendLive(env, sig('GUSDT'), { interval: '4h', signalId: 'st:G', price: 10, plan, management: mgmt, ...deps }), null);
  const g = (await handleCoachAuto(new Request('https://w/coach-auto'), env)).body;
  assert.equal(g.trendLive.cfg.enabled, false);
});
