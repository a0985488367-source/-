import test from 'node:test';
import assert from 'node:assert/strict';
import { advanceTrade, computeStats, tradeFromSetup } from '../scripts/lib/tracker.mjs';

const T0 = Date.UTC(2026, 0, 1);
const STEP = 900000;
/** 依序給 [high, low] 造出 K 棒 */
const bars = (spec) =>
  spec.map(([h, l], i) => ({
    time: T0 + (i + 1) * STEP,
    open: (h + l) / 2, high: h, low: l, close: (h + l) / 2, volume: 1,
  }));

const longTrade = (over = {}) => ({
  id: 't1', symbol: 'BTCUSDT', interval: '15m', dir: 'long',
  entry: 100, stop: 95,
  targets: [{ name: 'TP1', price: 105, rr: 1 }, { name: 'TP2', price: 115, rr: 3 }],
  grade: 'A', score: 80, status: 'pending',
  openTime: T0, lastCheckedTime: T0, barsSinceOpen: 0, hitTargets: [],
  ...over,
});

test('限價單：價格碰到進場價才算成交', () => {
  const t = advanceTrade(longTrade(), bars([[103, 101], [102, 99.5]]));
  assert.equal(t.status, 'active');
  assert.equal(t.filledTime, T0 + 2 * STEP);
});

test('限價單：價格一路殺穿 → 同一根先成交再停損（真實情況）', () => {
  const t = advanceTrade(longTrade(), bars([[103, 101], [101, 94]]));
  assert.equal(t.status, 'stop', '掛單在 100、價格跌到 94，會先成交再被 95 停損');
  assert.equal(t.r, -1);
  assert.equal(t.filledTime, T0 + 2 * STEP);
});

test('限價單：等太久沒成交 → 逾時作廢', () => {
  const spec = Array.from({ length: 30 }, () => [103, 101]);
  const t = advanceTrade(longTrade(), bars(spec), { entryWindowBars: 5 });
  assert.equal(t.status, 'expired');
  assert.equal(t.events.at(-1).reason, 'timeout');
});

test('市價單打到全部目標 → 以最後一個目標的 R 結算', () => {
  const t = advanceTrade(longTrade({ status: 'active', filledTime: T0 }), bars([[106, 99], [116, 105]]));
  assert.equal(t.status, 'target');
  assert.deepEqual(t.hitTargets, ['TP1', 'TP2']);
  assert.equal(t.r, 3);
});

test('直接停損 → -1R', () => {
  const t = advanceTrade(longTrade({ status: 'active', filledTime: T0 }), bars([[101, 94]]));
  assert.equal(t.status, 'stop');
  assert.equal(t.r, -1);
});

test('打到 TP1 後停損會移到成本價，之後回落不會變成 -1R', () => {
  const t1 = advanceTrade(longTrade({ status: 'active', filledTime: T0 }), bars([[106, 99]]));
  assert.deepEqual(t1.hitTargets, ['TP1']);
  assert.equal(t1.stop, 100, '停損應移到進場價');
  const t2 = advanceTrade(t1, bars([[106, 99], [104, 96]]));
  assert.equal(t2.status, 'stop');
  assert.ok(t2.r > 0, '已保本又打到過 TP1，結算不應為負');
});

test('同一根同時觸及停損與目標 → 保守算停損', () => {
  const t = advanceTrade(longTrade({ status: 'active', filledTime: T0 }), bars([[120, 90]]));
  assert.equal(t.status, 'stop');
});

test('空單方向判斷相反', () => {
  const short = longTrade({ dir: 'short', entry: 100, stop: 105, status: 'active', filledTime: T0,
    targets: [{ name: 'TP1', price: 95, rr: 1 }] });
  const t = advanceTrade(short, bars([[101, 94]]));
  assert.equal(t.status, 'target');
  assert.equal(t.r, 1);
});

test('已結束的單不會再被推進', () => {
  const done = longTrade({ status: 'stop', r: -1, closedTime: T0 });
  const t = advanceTrade(done, bars([[200, 190]]));
  assert.equal(t.status, 'stop');
  assert.equal(t.r, -1);
});

test('記錄最大有利與不利幅度', () => {
  const t = advanceTrade(longTrade({ status: 'active', filledTime: T0 }), bars([[104, 97.5]]));
  assert.equal(t.maxFavorableR, 0.8);   // (104-100)/5
  assert.equal(t.maxAdverseR, -0.5);    // (97.5-100)/5
});

test('computeStats 正確統計且排除未進場的單', () => {
  const closed = [
    { status: 'target', r: 2, grade: 'A', symbol: 'BTCUSDT', dir: 'long' },
    { status: 'stop', r: -1, grade: 'B', symbol: 'BTCUSDT', dir: 'long' },
    { status: 'target', r: 1, grade: 'A', symbol: 'ETHUSDT', dir: 'short' },
    { status: 'expired', r: 0, grade: 'C', symbol: 'SOLUSDT', dir: 'long' },
  ];
  const s = computeStats(closed);
  assert.equal(s.count, 3, 'expired 不計入交易筆數');
  assert.equal(s.expired, 1);
  assert.equal(s.wins, 2);
  assert.equal(s.winRate, (2 / 3) * 100);
  assert.equal(s.totalR, 2);
  assert.equal(s.profitFactor, 3);
  assert.equal(s.byGrade.find((g) => g.key === 'A').count, 2);
});

test('tradeFromSetup 依進場方式決定初始狀態', () => {
  const setup = {
    dir: 'long', entry: 100, stop: 95, entryType: 'market', grade: 'A', score: 80,
    targets: [{ name: 'TP1', price: 110, rr: 2, label: '流動性' }], poi: { type: 'Order Block' },
  };
  const t = tradeFromSetup({ id: 'x', symbol: 'BTCUSDT', interval: '15m', setup, candleTime: T0 });
  assert.equal(t.status, 'active');
  assert.equal(t.filledTime, T0);
  assert.equal(t.targets[0].label, '流動性');

  const t2 = tradeFromSetup({ id: 'y', symbol: 'BTCUSDT', interval: '15m', setup: { ...setup, entryType: 'limit' }, candleTime: T0 });
  assert.equal(t2.status, 'pending');
  assert.equal(t2.filledTime, null);
});
