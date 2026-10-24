import test from 'node:test';
import assert from 'node:assert/strict';
import { btcRegime, regimeAllows, enforceRegime, REGIME_KEY } from '../worker/regime.js';

const H4 = 4 * 3_600_000;
function makeKv() {
  const m = new Map();
  return { store: m, async get(k) { return m.get(k) ?? null; }, async put(k, v) { m.set(k, v); } };
}
const NOW = Date.UTC(2026, 9, 25, 0, 10);
// 300 根 4h：前半段一路跌、最後一段一路漲 → 最後是多
const candles = (up = true, now = NOW) => {
  const last = Math.floor(now / H4) * H4 - H4;
  return Array.from({ length: 300 }, (_, i) => {
    const k = i - 299;
    const p = up ? (i < 200 ? 200 - i * 0.5 : 100 + (i - 200) * 2) : (i < 200 ? 100 + i * 0.5 : 200 - (i - 200) * 2);
    return { time: last + k * H4, open: p, high: p * 1.01, low: p * 0.99, close: p, volume: 1 };
  });
};
const env = (over = {}) => ({ SMC_KV: makeKv(), DIRECTION_FILTER: 'btc-st4h', DIRECTION_FLIP_CLOSE: 'true', ...over });

test('BTC 4h 超級趨勢方向：漲＝1、跌＝-1，同一根只算一次', async () => {
  const e = env();
  let calls = 0;
  const up = await btcRegime(e, { fetchKlines: async () => { calls++; return candles(true); }, now: NOW });
  assert.equal(up.dir, 1);
  assert.equal(up.fresh, true);
  const again = await btcRegime(e, { fetchKlines: async () => { calls++; return candles(false); }, now: NOW + 120_000 });
  assert.equal(again.dir, 1, '同一根 4h 用快取');
  assert.equal(calls, 1);
  const next = NOW + H4;
  const down = await btcRegime(e, { fetchKlines: async () => candles(false, next), now: next });
  assert.equal(down.dir, -1);
  assert.equal(down.prevDir, 1);
});

test('資料還沒更新：沿用 8 小時內的舊方向（標 stale），太舊就不明', async () => {
  const e = env();
  await btcRegime(e, { fetchKlines: async () => candles(true), now: NOW });
  const r = await btcRegime(e, { fetchKlines: async () => { throw new Error('429'); }, now: NOW + H4 });
  assert.equal(r.dir, 1);
  assert.ok(r.stale);
  assert.equal(await btcRegime(e, { fetchKlines: async () => { throw new Error('429'); }, now: NOW + 3 * H4 }), null);
});

test('只開跟大方向同邊的單；不在名單的策略、沒開過濾照舊；方向不明就不開', () => {
  const e = env();
  const up = { dir: 1 };
  assert.equal(regimeAllows(e, up, { strategy: 'st', dir: 'long' }), true);
  assert.equal(regimeAllows(e, up, { strategy: 'rsi', dir: 'short' }), false);
  assert.equal(regimeAllows(e, up, { strategy: 'dc', dir: 'short' }), true);
  assert.equal(regimeAllows(e, null, { strategy: 'st', dir: 'long' }), false);
  assert.equal(regimeAllows(env({ DIRECTION_FILTER: 'off' }), up, { strategy: 'st', dir: 'short' }), true);
});

test('反方向的單平掉，同一根 4h 每個幣只試一次；第一次上線推一則通知', async () => {
  const e = env();
  const calls = [], msgs = [];
  const deps = {
    trackedPositions: async () => [
      { symbol: 'SOLUSDT', dir: 'long', strategy: 'st' },
      { symbol: 'AXSUSDT', dir: 'short', strategy: 'rsi' },
      { symbol: 'ZILUSDT', dir: 'short', strategy: undefined }, // SMC／手動不動
    ],
    executorCall: async (env, method, path, { body }) => { calls.push(body.symbol); return { ok: true }; },
    postDiscord: async (env, p) => { msgs.push(p); },
  };
  const r = await enforceRegime(e, { bar: 1, dir: 1, fresh: true, prevDir: null }, deps);
  assert.deepEqual(calls, ['AXSUSDT']);
  assert.equal(r.closed, 1);
  assert.equal(msgs.length, 1);
  assert.match(msgs[0].embeds[0].description, /現在是多/);
  await enforceRegime(e, { bar: 1, dir: 1 }, deps);
  assert.deepEqual(calls, ['AXSUSDT'], '同一根不重試');
  assert.equal(msgs.length, 1, '沒有新動作就不推');
});

test('翻轉時推通知；DIRECTION_FLIP_CLOSE 關掉就只推不平', async () => {
  const e = env({ DIRECTION_FLIP_CLOSE: 'false' });
  const calls = [], msgs = [];
  const deps = { trackedPositions: async () => [{ symbol: 'SOLUSDT', dir: 'long', strategy: 'st' }], executorCall: async (e2, m, p, { body }) => { calls.push(body.symbol); return {}; }, postDiscord: async (e2, p) => { msgs.push(p); } };
  const r = await enforceRegime(e, { bar: 2, dir: -1, fresh: true, prevDir: 1 }, deps);
  assert.equal(r.flipped, true);
  assert.equal(calls.length, 0);
  assert.match(msgs[0].embeds[0].description, /翻空/);
});
