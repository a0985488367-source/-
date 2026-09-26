import test from 'node:test';
import assert from 'node:assert/strict';
import { simulatePortfolio, pagedKlines } from '../scripts/research/lib.mjs';

const t = (over) => ({ symbol: 'A', filledTime: 0, closedTime: 10, r: 1, beTime: null, ...over });

test('每筆冒當下帳戶的 riskPct，賺賠複利滾進帳戶', () => {
  const res = simulatePortfolio([t({ r: 2 }), t({ filledTime: 20, closedTime: 30, r: -1 })], { riskPct: 10 });
  assert.equal(res.taken, 2);
  assert.ok(Math.abs(res.multiple - 1.2 * 0.9) < 1e-9, '先 +20% 再虧 1.2 的 10%');
  assert.ok(Math.abs(res.maxDdPct - 10) < 1e-9);
});

test('同幣不加碼：同一個幣持倉中就跳過', () => {
  const trades = [t({}), t({ filledTime: 5, closedTime: 15 }), t({ symbol: 'B', filledTime: 5, closedTime: 15 })];
  assert.equal(simulatePortfolio(trades, { oneBySymbol: true }).taken, 2);
});

test('未保本持倉上限：已經移到成本價的不佔名額', () => {
  const trades = [
    t({ symbol: 'A', beTime: 3 }),
    t({ symbol: 'B', filledTime: 1, closedTime: 10 }),
    t({ symbol: 'C', filledTime: 5, closedTime: 10 }),
    t({ symbol: 'D', filledTime: 6, closedTime: 10 }),
  ];
  // t=5 時 A 已保本、B 還沒 → 只有 1 筆佔名額，C 可以開；t=6 時 B、C 佔滿 2 筆，D 擋掉
  assert.equal(simulatePortfolio(trades, { maxAtRisk: 2 }).taken, 3);
});

test('同一根 K 棒進場就停損的單也會正常平倉', () => {
  const res = simulatePortfolio([t({ filledTime: 5, closedTime: 5, r: -1 })], { riskPct: 5 });
  assert.ok(Math.abs(res.multiple - 0.95) < 1e-9);
});

test('pagedKlines 超過 1000 根會用 endTime 往前分段抓，到上市第一根就停', async () => {
  const all = Array.from({ length: 2500 }, (_, i) => ({ time: (i + 1) * 60_000, close: i }));
  const calls = [];
  const provider = {
    async fetchKlines(_s, _i, { limit, endTime = Infinity }) {
      calls.push({ limit, endTime });
      return all.filter((c) => c.time <= endTime).slice(-Math.min(1000, limit));
    },
  };
  const got = await pagedKlines(provider, 'X', '1m', 2200);
  assert.equal(got.length, 2200);
  assert.equal(got[0].time, all[300].time);
  assert.equal(got.at(-1).time, all.at(-1).time);
  assert.ok(got.every((c, i) => !i || c.time > got[i - 1].time));
  assert.deepEqual(calls.map((c) => c.limit), [1000, 1000, 200]);

  const capped = await pagedKlines(provider, 'X', '1m', 5000);
  assert.equal(capped.length, 2500);
});
