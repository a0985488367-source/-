import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createDonchianState, stepDonchian, donchianSignal, lowestActiveStop, annualVol,
  donchianWeights, donchianLatest, applyBand, alignDailyCloses,
} from '../src/strategies/donchian-ensemble.js';

test('單一週期：突破前 L 天最高收盤進場，停損＝最近 L 天中點只往上追，收盤跌破就出場', () => {
  const c = [10, 11, 12, 11, 13, 14, 12, 10];
  const st = createDonchianState([3]);
  const seen = [];
  for (let t = 0; t < c.length; t++) { stepDonchian(st, c, t); seen.push([st.subs[0].on, st.subs[0].stop]); }
  // t=3：11 沒突破 max(10,11,12)=12；t=4：13 > max(11,12,11)=12 → 進場，停損＝(13+11)/2=12
  assert.deepEqual(seen[3], [false, 0]);
  assert.deepEqual(seen[4], [true, 12]);
  // t=5：14 → 中點 (14+11)/2=12.5，往上追
  assert.deepEqual(seen[5], [true, 12.5]);
  // t=6：12 < 12.5 → 出場
  assert.equal(seen[6][0], false);
  assert.equal(st.hist, 8);
});

test('訊號、最低停損、權重＝訊號 × min(目標波動÷波動, 上限) ÷ 有資格的幣數', () => {
  const st = createDonchianState([5, 10, 20, 30]);
  st.subs[0] = { on: true, stop: 95 };
  st.subs[2] = { on: true, stop: 90 };
  st.hist = 400;
  assert.equal(donchianSignal(st), 0.5);
  assert.equal(lowestActiveStop(st), 90);
  // 價格每天 ±1% 交替 → 年化波動約 0.01×√365
  const c = Array.from({ length: 200 }, (_, i) => 100 * (i % 2 ? 1.01 : 1));
  const other = createDonchianState([5, 10, 20, 30]);
  other.hist = 400;
  const { weights, eligible } = donchianWeights({ A: st, B: other }, { A: c, B: c }, 199, { volTarget: 0.25, cap: 2 });
  const vol = annualVol(c, 199);
  assert.deepEqual(eligible, ['A', 'B']);
  assert.ok(Math.abs(weights.A - (0.5 * Math.min(0.25 / vol, 2)) / 2) < 1e-12);
  assert.equal(weights.B, undefined, '沒有訊號的幣權重是 0');
});

test('資料不到一年的幣不算進分母', () => {
  const c = Array.from({ length: 500 }, (_, i) => 100 + i);
  const young = [...Array(300).fill(NaN), ...c.slice(300)];
  const r = donchianLatest({ OLD: c, NEW: young });
  assert.deepEqual(r.eligible, ['OLD']);
  assert.ok(r.weights.OLD > 0, '一路漲，所有週期都在場內');
  assert.equal(r.detail.OLD.signal, 1);
});

test('少換倉：差不到 band 就維持原本權重', () => {
  assert.equal(applyBand(0.11, 0.1, 0.3), 0.1);
  assert.equal(applyBand(0.2, 0.1, 0.3), 0.2);
  assert.equal(applyBand(0, 0.1, 0.3), 0);
  assert.equal(applyBand(0.1, 0, 0.3), 0.1);
});

test('日 K 對齊：還沒收盤的那根不算', () => {
  const DAY = 86_400_000, d0 = Date.UTC(2026, 0, 1);
  const now = d0 + 2 * DAY + 3600_000; // 第三天還沒收盤
  const { days, closes } = alignDailyCloses({ A: [0, 1, 2].map((i) => ({ time: d0 + i * DAY, close: 10 + i })) }, now);
  assert.equal(days.length, 2);
  assert.deepEqual(closes.A, [10, 11]);
});
