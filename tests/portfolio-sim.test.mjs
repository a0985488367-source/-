import test from 'node:test';
import assert from 'node:assert/strict';
import { simulatePortfolio } from '../scripts/research/lib.mjs';

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
