import test from 'node:test';
import assert from 'node:assert/strict';

import { randomWalkCandles, parseCandleCsv } from '../src/sim/synthetic.js';
import { generateDemoCandles } from '../src/data/providers.js';
import { backtest } from '../src/smc/backtest.js';

/* ------------------------------------------------------------ 合成 K 線 */

test('randomWalkCandles 的 OHLC 自洽且可重現', () => {
  const a = randomWalkCandles({ seed: 5, count: 300 });
  const b = randomWalkCandles({ seed: 5, count: 300 });
  assert.deepEqual(a.map((k) => k.close), b.map((k) => k.close));
  for (const k of a) {
    assert.ok(k.high >= Math.max(k.open, k.close) - 1e-9, 'high 必須涵蓋 open/close');
    assert.ok(k.low <= Math.min(k.open, k.close) + 1e-9, 'low 必須涵蓋 open/close');
    assert.ok(k.high >= k.low);
  }
  const c = randomWalkCandles({ seed: 6, count: 300 });
  assert.notDeepEqual(a.map((k) => k.close), c.map((k) => k.close), '不同種子必須不同');
});

test('randomWalkCandles 的波動率與設定相符、漂移為零', () => {
  const c = randomWalkCandles({ seed: 11, count: 20000, sigma: 0.004 });
  const rets = c.slice(1).map((k, i) => Math.log(k.close / c[i].close));
  const m = rets.reduce((a, b) => a + b, 0) / rets.length;
  const s = Math.sqrt(rets.reduce((a, b) => a + (b - m) ** 2, 0) / rets.length);
  assert.ok(Math.abs(s - 0.004) < 0.0002, `sigma=${s}`);
  assert.ok(Math.abs(m) < 3 * (s / Math.sqrt(rets.length)), `漂移 ${m} 應與 0 無異`);
});

test('影線來自真實子步驟路徑，而非事後捏造', () => {
  // 子步驟越多，單根 K 棒的 high–low 範圍應越大（更接近連續路徑）
  const few = randomWalkCandles({ seed: 3, count: 2000, subSteps: 2 });
  const many = randomWalkCandles({ seed: 3, count: 2000, subSteps: 40 });
  const range = (cs) => cs.reduce((a, k) => a + (k.high - k.low) / k.open, 0) / cs.length;
  assert.ok(range(many) > range(few) * 1.3, `${range(many)} 應明顯大於 ${range(few)}`);
});

/* ------------------------------------------------------------ CSV 載入 */

test('parseCandleCsv 跳過表頭、秒轉毫秒、依時間排序', () => {
  const csv = [
    'time,open,high,low,close,volume',
    '1700000060,10,12,9,11,100',
    '1700000000,9,11,8,10,90',
    '1700000120000,11,13,10,12,110',   // 已是毫秒
    'garbage,row,here,x,y',
  ].join('\n');
  const out = parseCandleCsv(csv);
  assert.equal(out.length, 3);
  assert.deepEqual(out.map((k) => k.time), [1700000000000, 1700000060000, 1700000120000]);
  assert.equal(out[0].close, 10);
  assert.equal(out[2].volume, 110);
});

/* -------------------------------------------------- 空值檢定（迴歸） */

test('空值檢定：策略在隨機漫步上測不出優勢', async () => {
  // 若這項失敗，代表引擎出現未來函數或統計偏誤，而不是策略變強了。
  const trades = [];
  for (let i = 0; i < 40; i++) {
    const c = randomWalkCandles({ seed: 4242 + i * 7919, count: 1200 });
    const res = await backtest(c, { minScore: 55, chunkSize: 1e9 });
    trades.push(...res.trades);
  }
  assert.ok(trades.length > 300, `樣本太少：${trades.length}`);
  const rs = trades.map((t) => t.r);
  const m = rs.reduce((a, b) => a + b, 0) / rs.length;
  const s = Math.sqrt(rs.reduce((a, b) => a + (b - m) ** 2, 0) / (rs.length - 1));
  const se = s / Math.sqrt(rs.length);
  assert.ok(Math.abs(m / se) < 3, `期望值 ${m.toFixed(4)}R 顯著不為 0（t=${(m / se).toFixed(2)}）`);
});

/* -------------------------------------- 示範資料的偽複製（已知陷阱） */

test('generateDemoCandles 不因 endTime 而改變（偽複製來源）', () => {
  // 記錄這個已知性質：種子只取決於 symbol 與 interval。
  // 任何統計流程若把多次呼叫當成獨立樣本，樣本數就會虛胖。
  const a = generateDemoCandles('BTCUSDT', '15m', 1200, Date.UTC(2024, 0, 1));
  const b = generateDemoCandles('BTCUSDT', '15m', 1200, Date.UTC(2024, 5, 1));
  assert.deepEqual(a.map((k) => k.close), b.map((k) => k.close));
});
