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

test('市價單打到全部目標 → 以整筆部位的淨 R 結算（含分批）', () => {
  const t = advanceTrade(longTrade({ status: 'active', filledTime: T0 }), bars([[106, 99], [116, 105]]));
  assert.equal(t.status, 'target');
  assert.deepEqual(t.hitTargets, ['TP1', 'TP2']);
  // 一半在 TP1(+1R) 出場、一半抱到 TP2(+3R) → 0.5×1 + 0.5×3 = 2R
  assert.equal(t.r, 2);
});

test('直接停損 → -1R', () => {
  const t = advanceTrade(longTrade({ status: 'active', filledTime: T0 }), bars([[101, 94]]));
  assert.equal(t.status, 'stop');
  assert.equal(t.r, -1);
});

test('breakevenAtR：獲利達門檻後停損移到成本價，之後回落不會變成 -1R', () => {
  const cfg = { breakevenAtR: 1 };
  const t1 = advanceTrade(longTrade({ status: 'active', filledTime: T0 }), bars([[106, 99]]), cfg);
  assert.deepEqual(t1.hitTargets, ['TP1']);
  assert.equal(t1.stop, 100, '停損應移到進場價');
  const t2 = advanceTrade(t1, bars([[106, 99], [104, 96]]), cfg);
  assert.equal(t2.status, 'stop');
  assert.equal(t2.exitReason, 'breakeven');
  assert.ok(t2.r > 0, '已保本又在 TP1 出掉一半，結算不應為負');
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

/* ---------------------------------------------- 新的部位管理規則 */

test('保本鏢：先在 0.5R 出掉一部分，之後回到成本價仍是正報酬（原本會是 -1R）', () => {
  const cfg = { scalpR: 0.5, scalpFraction: 0.34, breakevenAtR: 0.5 };
  const setup = {
    dir: 'long', entry: 100, stop: 95, entryType: 'market',
    targets: [{ name: 'TP1', price: 110, rr: 2 }, { name: 'TP2', price: 120, rr: 4 }],
    grade: 'A', score: 80,
  };
  const t0 = tradeFromSetup({ id: 'z', symbol: 'BTCUSDT', interval: '15m', setup, candleTime: T0, management: cfg });
  assert.equal(t0.targets[0].name, 'TP0', '階梯最前面應該是保本鏢');
  assert.equal(t0.targets[0].price, 102.5, '0.5R = 進場價 + 0.5 × 風險');

  // 先碰到 102.5（+0.5R），再跌回進場價
  const t = advanceTrade(t0, bars([[103, 99], [101, 99]]), cfg);
  assert.equal(t.status, 'stop');
  assert.equal(t.exitReason, 'breakeven');
  assert.ok(t.r > 0, `原本應該是 -1R，現在是 ${t.r.toFixed(3)}R`);
});

test('保本鏢：TP1 本來就夠近時不會重複插入', () => {
  const setup = {
    dir: 'long', entry: 100, stop: 95, entryType: 'market',
    targets: [{ name: 'TP1', price: 102, rr: 0.4 }], grade: 'A', score: 70,
  };
  const t = tradeFromSetup({ id: 'q', symbol: 'ETHUSDT', interval: '1h', setup, candleTime: T0, management: { scalpR: 0.5, scalpFraction: 0.34 } });
  assert.equal(t.targets.length, 1);
  assert.equal(t.targets[0].name, 'TP1');
});

test('認賠出場：逆行到 scratchR 就走，虧損小於一個完整停損', () => {
  const cfg = { scratchR: 0.75 };
  const t = advanceTrade(longTrade({ status: 'active', filledTime: T0 }), bars([[101, 96]]), cfg);
  assert.equal(t.status, 'stop');
  assert.equal(t.exitReason, 'scratch');
  assert.ok(Math.abs(t.r + 0.75) < 1e-9, `應為 -0.75R，實得 ${t.r}`);
});

test('認賠出場：已經分批獲利過就不再觸發（避免把賺錢單掃掉）', () => {
  const cfg = { scratchR: 0.75, scalpR: 0.5, scalpFraction: 0.34 };
  const t = advanceTrade(
    longTrade({ status: 'active', filledTime: T0, targets: [{ name: 'TP0', price: 102.5, rr: 0.5, fraction: 0.34 }, { name: 'TP1', price: 115, rr: 3, fraction: 0 }] }),
    bars([[103, 99], [101, 96.5]]),
    cfg,
  );
  assert.deepEqual(t.hitTargets, ['TP0']);
  assert.notEqual(t.exitReason, 'scratch');
});

test('追蹤停損：獲利回吐超過 trailGapR 就出場，且鎖住利潤', () => {
  const cfg = { trailFromR: 1, trailGapR: 0.5 };
  const t = advanceTrade(
    longTrade({ status: 'active', filledTime: T0, targets: [{ name: 'TP1', price: 200, rr: 20 }] }),
    bars([[110, 99], [109, 106]]),
    cfg,
  );
  assert.equal(t.status, 'stop');
  assert.equal(t.exitReason, 'trail');
  assert.ok(t.r > 1, `應鎖住 1R 以上，實得 ${t.r.toFixed(2)}R`);
});

test('R 的刻度以原始停損為準：停損移動後 R 不會被重新縮放', () => {
  const cfg = { breakevenAtR: 1 };
  const t1 = advanceTrade(longTrade({ status: 'active', filledTime: T0, targets: [{ name: 'TP1', price: 115, rr: 3 }] }), bars([[106, 99]]), cfg);
  assert.equal(t1.stop, 100);
  const t2 = advanceTrade(t1, bars([[106, 99], [116, 105]]), cfg);
  assert.equal(t2.r, 3, '仍以進場價到原始停損（5 點）為 1R');
});

test('未成交就作廢的單不列入勝率；成交後逾時的單要列入', () => {
  const s = computeStats([
    { status: 'expired', exitReason: 'timeout', r: 0, filledTime: null, grade: 'A', symbol: 'A', dir: 'long' },
    { status: 'expired', exitReason: 'maxHold', r: -0.4, filledTime: T0, grade: 'A', symbol: 'A', dir: 'long' },
    { status: 'target', r: 2, filledTime: T0, grade: 'A', symbol: 'A', dir: 'long' },
  ]);
  assert.equal(s.count, 2, '成交後逾時的那筆要算進交易數');
  assert.equal(s.expired, 1);
  assert.equal(s.wins, 1);
});
