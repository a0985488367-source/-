import test from 'node:test';
import assert from 'node:assert/strict';
import { perfWarning } from '../src/core/perf-flags.js';

const statsWith = (byGrade = [], byDir = []) => ({ byGrade, byDir });

test('沒有 stats 時回傳 null（拿不到資料不能讓畫面報錯）', () => {
  assert.equal(perfWarning(null, { grade: 'A+', dir: 'long' }), null);
});

test('樣本數不足時就算平均是負的也不標記（避免小樣本雜訊）', () => {
  const stats = statsWith([{ key: 'A+', count: 3, avgR: -1 }]);
  assert.equal(perfWarning(stats, { grade: 'A+', dir: 'long' }), null);
});

test('樣本數足夠且平均為負：標記警告，並帶出筆數與期望值', () => {
  const stats = statsWith([{ key: 'A+', count: 10, avgR: -0.34 }]);
  const msg = perfWarning(stats, { grade: 'A+', dir: 'long' });
  assert.match(msg, /A\+/);
  assert.match(msg, /10 筆/);
  assert.match(msg, /-0\.34R/);
});

test('平均為正時不標記', () => {
  const stats = statsWith([{ key: 'A', count: 30, avgR: 0.25 }]);
  assert.equal(perfWarning(stats, { grade: 'A', dir: 'long' }), null);
});

test('等級與方向都是負的，兩條一起列出', () => {
  const stats = statsWith(
    [{ key: 'A+', count: 10, avgR: -0.34 }],
    [{ key: 'short', count: 8, avgR: -0.75 }],
  );
  const msg = perfWarning(stats, { grade: 'A+', dir: 'short' });
  assert.match(msg, /A\+/);
  assert.match(msg, /做空/);
});

test('英文語系輸出英文文案', () => {
  const stats = statsWith([{ key: 'A+', count: 10, avgR: -0.34 }]);
  const msg = perfWarning(stats, { grade: 'A+', dir: 'long' }, 'en');
  assert.match(msg, /Weak track record/);
});
