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

test('Bybit 連不到時改用 OKX 永續成交額排名', async () => {
  const f = async (u) => {
    if (u.includes('okx')) return { ok: true, json: async () => ({ code: '0', data: [{ instId: 'ETH-USDT-SWAP', volCcy24h: '10', last: '3000' }, { instId: 'BTC-USDT-SWAP', volCcy24h: '1', last: '60000' }, { instId: 'USDC-USDT-SWAP', volCcy24h: '1e9', last: '1' }, { instId: 'BTC-USD-SWAP', volCcy24h: '1e9', last: '1' }] }) };
    return { ok: false, status: 403 };
  };
  const all = await bybitUniverse(f);
  assert.deepEqual(all.map((x) => x.s), ['BTCUSDT', 'ETHUSDT']);
  const env = { SMC_KV: makeKv() };
  const x = await coachCoins(env, { base: [], topN: 50, fetchImpl: f });
  assert.equal(x.src, 'okx');
  const r = await handleCoachCoins(new Request('https://w/coach-coins', { method: 'POST', body: JSON.stringify({ add: 'SUI' }) }), env, { base: [], topN: 50, fetchImpl: f });
  assert.equal(r.status, 200, 'OKX 名單不完整，不擋 Bybit 才有的幣');
});

test('名單優先用 Executor 代拿的 Bybit 排名；OKX 備用時只留加密貨幣', async () => {
  const via = async () => ({ list: [{ s: 'SUIUSDT', v: 9 }, { s: 'BTCUSDT', v: 8 }] });
  const x = await coachCoins({ SMC_KV: makeKv() }, { base: [], topN: 50, fetchImpl: async () => { throw new Error('不該用到'); }, viaExecutor: via });
  assert.deepEqual(x.top, ['SUIUSDT', 'BTCUSDT']);
  const f = async (u) => {
    if (u.includes('instruments')) return { ok: true, json: async () => ({ code: '0', data: [{ instId: 'BTC-USDT-SWAP', instCategory: '1' }, { instId: 'NVDA-USDT-SWAP', instCategory: '3' }] }) };
    if (u.includes('okx')) return { ok: true, json: async () => ({ code: '0', data: [{ instId: 'NVDA-USDT-SWAP', volCcy24h: '1e9', last: '100' }, { instId: 'BTC-USDT-SWAP', volCcy24h: '1', last: '60000' }] }) };
    return { ok: false, status: 403 };
  };
  const all = await bybitUniverse(f, async () => ({ error: 'down' }));
  assert.deepEqual(all.map((x) => x.s), ['BTCUSDT']);
});
