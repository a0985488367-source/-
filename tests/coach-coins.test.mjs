import test from 'node:test';
import assert from 'node:assert/strict';
import { coachCoins, handleCoachCoins, bybitUniverse } from '../worker/coach-coins.js';

function makeKv() { const m = new Map(); return { store: m, async get(k) { return m.get(k) ?? null; }, async put(k, v) { m.set(k, v); } }; }
const tickers = (n) => ({
  retCode: 0,
  result: { list: [
    { symbol: 'USDCUSDT', turnover24h: '9e12' }, { symbol: 'BTCPERP', turnover24h: '8e12' }, { symbol: 'ETHUSDT-26DEC25', turnover24h: '7e12' },
    ...Array.from({ length: n }, (_, i) => ({ symbol: `C${i}USDT`, turnover24h: String(1e9 - i) })),
  ] },
});
const fetchOk = (n = 80) => { const f = async () => ({ ok: true, json: async () => tickers(n) }); f.calls = 0; return f; };

test('教練名單：Bybit 成交額前 50（不含穩定幣、交割合約）＋主流 15＋自己加的', async () => {
  const all = await bybitUniverse(fetchOk(5));
  assert.deepEqual(all.map((x) => x.s), ['C0USDT', 'C1USDT', 'C2USDT', 'C3USDT', 'C4USDT']);
  const env = { SMC_KV: makeKv() };
  const x = await coachCoins(env, { base: ['BTCUSDT', 'C3USDT'], topN: 50, fetchImpl: fetchOk(80) });
  assert.equal(x.top.length, 50);
  assert.equal(x.coins[0], 'BTCUSDT');
  assert.equal(x.coins.length, 51, '主流跟前 50 重複的只算一次');
  // 同一天不再跟 Bybit 拿
  let called = 0;
  await coachCoins(env, { base: [], topN: 50, fetchImpl: async () => { called++; throw new Error('x'); } });
  assert.equal(called, 0);
});

test('App 搜尋後加幣／移除；Bybit 沒有的幣不能加；最多 20 個', async () => {
  const env = { SMC_KV: makeKv() }, opts = { base: [], topN: 10, fetchImpl: fetchOk(80) };
  const post = (b) => handleCoachCoins(new Request('https://w/coach-coins', { method: 'POST', body: JSON.stringify(b) }), env, opts);
  let r = await post({ add: 'c60' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.extra, ['C60USDT']);
  assert.ok(r.body.coins.includes('C60USDT'));
  r = await post({ add: 'NOPE' });
  assert.equal(r.status, 400);
  r = await post({ remove: 'C60' });
  assert.deepEqual(r.body.extra, []);
  for (let i = 0; i < 20; i++) await post({ add: `C${20 + i}` });
  r = await post({ add: 'C79' });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /最多 20/);
  const g = await handleCoachCoins(new Request('https://w/coach-coins'), env, opts);
  assert.equal(g.body.coins.length, 30);
  assert.equal(g.body.all.length, 80);
});
