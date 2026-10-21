import test from 'node:test';
import assert from 'node:assert/strict';
import { runDonchian, donchianHeld, fetchDaily, DC_STATE_KEY } from '../worker/donchian.js';

const DAY = 86_400_000;
function makeKv() {
  const m = new Map();
  return { store: m, async get(k) { return m.get(k) ?? null; }, async put(k, v) { m.set(k, v); } };
}
// 假日 K：A 一路漲（全部週期在場內）、B 一路跌（沒有訊號）
const NOW = Date.UTC(2026, 9, 22, 0, 30);
function fakeFetch() {
  return async (url) => {
    const u = new URL(url);
    const sym = u.searchParams.get('symbol');
    const end = Number(u.searchParams.get('endTime')) || NOW;
    const last = Math.floor(end / DAY) * DAY;
    const n = Number(u.searchParams.get('limit'));
    const rows = [];
    for (let i = n - 1; i >= 0; i--) {
      const t = last - i * DAY;
      const k = (t - Date.UTC(2022, 0, 1)) / DAY;
      if (k < 0) continue;
      const close = sym === 'AAAUSDT' ? 100 * 1.002 ** k * (1 + 0.02 * Math.sin(k)) : 100 * 0.999 ** k * (1 + 0.02 * Math.sin(k));
      rows.push([t, 0, 0, 0, String(close)]);
    }
    return new Response(JSON.stringify(rows), { status: 200 });
  };
}
function deps(over = {}) {
  const calls = [], msgs = [];
  const ex = { positions: {} };
  return {
    calls, msgs, ex,
    fetchImpl: fakeFetch(),
    executorCall: async (env, method, path, { body } = {}) => {
      calls.push({ path, body });
      if (path === '/balance') return { totalWalletBalance: 1000, totalAvailableBalance: 800 };
      if (path === '/dc/adjust') {
        const cur = ex.positions[body.symbol] ?? 0;
        if (Math.abs(cur - body.expectQty) > 1e-9) return { ok: false, skipped: 'occupied', current: cur };
        const after = Math.floor(body.targetQty * 1000) / 1000;
        ex.positions[body.symbol] = after;
        return { ok: true, before: cur, after, ordered: after - cur, stopLoss: body.stopLoss };
      }
      throw new Error('未預期 ' + path);
    },
    getPrices: async () => ({}),
    postDiscord: async (env, p) => { msgs.push(p); },
    isAutoTradeEnabled: async () => true,
    executorMode: async () => 'demo',
    trackedPositions: async () => [],
    ...over,
  };
}
const env = () => ({ SMC_KV: makeKv(), DONCHIAN_ENABLED: 'true', DONCHIAN_SYMBOLS: 'AAA,BBB', DONCHIAN_DAYS: '1500' });

test('每天跑一次：漲的幣買進、記在 KV，同一天不重跑；其他策略查得到它持有', async () => {
  const e = env(), d = deps();
  const r = await runDonchian(e, d, { now: NOW });
  assert.equal(r.ran, true);
  const adj = d.calls.filter((c) => c.path === '/dc/adjust');
  assert.deepEqual(adj.map((c) => c.body.symbol), ['AAAUSDT'], '跌的幣沒訊號、本來也沒部位，不用叫 Executor');
  const a = adj[0].body;
  assert.ok(a.targetQty > 0 && a.expectQty === 0 && a.orderLinkId === 'dc:AAA:20261022');
  assert.ok(a.stopLoss > 0 && a.stopLoss < a.refPrice, '災難停損在現價下面');
  const st = JSON.parse(e.SMC_KV.store.get(DC_STATE_KEY));
  assert.ok(st.pos.AAAUSDT.qty > 0);
  assert.deepEqual([...(await donchianHeld(e))], ['AAAUSDT']);
  assert.equal(d.msgs.length, 1);
  assert.match(d.msgs[0].embeds[0].title, /唐奇安/);
  const again = await runDonchian(e, d, { now: NOW + 120_000 });
  assert.equal(again.skipped, 'done');
});

test('不在時段、不是 Demo、自動下單關掉 → 不動', async () => {
  assert.equal((await runDonchian(env(), deps(), { now: Date.UTC(2026, 9, 22, 0, 5) })).skipped, 'not-time');
  assert.equal((await runDonchian(env(), deps({ executorMode: async () => 'live' }), { now: NOW })).skipped, 'not-demo');
  assert.equal((await runDonchian(env(), deps({ isAutoTradeEnabled: async () => false }), { now: NOW })).skipped, 'auto-trade-off');
});

test('別的策略佔著的幣不買；部位被停損平掉會重新對帳', async () => {
  const e = env(), d = deps({ trackedPositions: async () => [{ symbol: 'AAAUSDT' }] });
  await runDonchian(e, d, { now: NOW });
  assert.equal(d.calls.filter((c) => c.path === '/dc/adjust').length, 0);

  const e2 = env(), d2 = deps();
  await e2.SMC_KV.put(DC_STATE_KEY, JSON.stringify({ pos: { AAAUSDT: { qty: 5 } } }));
  await runDonchian(e2, d2, { now: NOW });
  const adj = d2.calls.filter((c) => c.path === '/dc/adjust');
  assert.equal(adj.length, 2, '第一次對不上（交易所已經是 0），歸零再下一次');
  assert.equal(adj[1].body.expectQty, 0);
  assert.ok(JSON.parse(e2.SMC_KV.store.get(DC_STATE_KEY)).pos.AAAUSDT.qty > 0);
});

test('資料抓不到的幣維持原狀，不會被平掉', async () => {
  const e = env();
  const base = fakeFetch();
  const d = deps({ fetchImpl: async (url) => (String(url).includes('BBB') ? new Response('x', { status: 500 }) : base(url)) });
  await e.SMC_KV.put(DC_STATE_KEY, JSON.stringify({ pos: { BBBUSDT: { qty: 3 } } }));
  d.ex.positions.BBBUSDT = 3;
  // 過了 until 還抓不到才會跑
  await runDonchian(e, d, { now: Date.UTC(2026, 9, 22, 3, 30) });
  assert.ok(!d.calls.some((c) => c.path === '/dc/adjust' && c.body.symbol === 'BBBUSDT'));
  assert.equal(JSON.parse(e.SMC_KV.store.get(DC_STATE_KEY)).pos.BBBUSDT.qty, 3);
});

test('日 K 分頁往前補', async () => {
  const xs = await fetchDaily('AAAUSDT', 1500, fakeFetch());
  assert.equal(xs.length, 1500);
  assert.ok(xs.every((k, i) => !i || k.time - xs[i - 1].time === DAY));
});
