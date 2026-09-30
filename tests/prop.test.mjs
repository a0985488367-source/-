import test from 'node:test';
import assert from 'node:assert/strict';
import { PRESETS, challengeStatus, dailyBreakdown, dayKey, sizePosition } from '../src/prop/rules.js';

const R = PRESETS['two-step-10k'];
const T = (d, h = 12) => Date.UTC(2026, 9, d, h); // 10 月 d 日 UTC h 點

test('一天從 UTC 0 點開始（台灣早上 8 點）', () => {
  assert.equal(dayKey(Date.UTC(2026, 9, 1, 23, 59)), '2026-10-01');
  assert.equal(dayKey(Date.UTC(2026, 9, 2, 0, 0)), '2026-10-02');
});

test('沒有紀錄：淨值 = 起始資金，今天還能虧 500、總共還能虧 1000', () => {
  const s = challengeStatus({ rules: R, now: T(1) });
  assert.equal(s.equity, 10000);
  assert.equal(s.dailyRoom, 500);
  assert.equal(s.totalRoom, 1000);
  assert.equal(s.target, 10500);
  assert.equal(s.level, 'ok');
});

test('今天起始淨值 = 前一天最後一筆；每日底線跟著今天起始淨值走', () => {
  const snaps = [{ time: T(1), equity: 10300 }, { time: T(2, 3), equity: 10100 }];
  const s = challengeStatus({ rules: R, snapshots: snaps, now: T(2, 5) });
  assert.equal(s.start, 10300);
  assert.equal(s.dailyFloor, 9800);
  assert.equal(s.dailyRoom, 300);
  assert.equal(s.todayPnl, -200);
  assert.equal(s.totalRoom, 1100); // 最大損失底線固定 9000，不跟著最高點移動
});

test('持倉的停損風險算進剩餘空間；超過自己的停手線（每日上限的一半）就叫你收工', () => {
  const snaps = [{ time: T(2, 3), equity: 9900 }];
  const s = challengeStatus({ rules: R, snapshots: snaps, now: T(2, 5), openRisk: 160 });
  assert.equal(s.dailyRoom, 500 - 100 - 160);
  assert.equal(s.level, 'stop');
});

test('碰到每日虧損上限或最大損失底線就判定失敗', () => {
  const daily = challengeStatus({ rules: R, snapshots: [{ time: T(2, 3), equity: 9500 }], now: T(2, 5) });
  assert.deepEqual(daily.failed, ['daily']);
  assert.equal(daily.level, 'fail');
  const total = challengeStatus({
    rules: R,
    snapshots: [{ time: T(1), equity: 9400 }, { time: T(2), equity: 9100 }, { time: T(3), equity: 9000 }],
    now: T(3, 13),
  });
  assert.ok(total.failed.includes('total'));
});

test('獲利日：當天淨值增加 ≥ 50（起始資金 0.5%）才算', () => {
  const snaps = [
    { time: T(1), equity: 10060 }, // +60 ✅
    { time: T(2), equity: 10100 }, // +40 ❌
    { time: T(3), equity: 10150 }, // +50 ✅
    { time: T(4), equity: 10120 }, // -30 ❌
  ];
  const days = dailyBreakdown(R, snaps);
  assert.deepEqual(days.map((d) => d.profitable), [true, false, true, false]);
  const s = challengeStatus({ rules: R, snapshots: snaps, now: T(4, 13) });
  assert.equal(s.profitableDays, 2);
});

test('達到目標但獲利日不夠：提醒還要再做幾天；兩個都夠才算過關', () => {
  const notYet = challengeStatus({ rules: R, snapshots: [{ time: T(1), equity: 10600 }], now: T(1, 13) });
  assert.ok(notYet.messages.some((m) => /獲利日只有 1\/3/.test(m.text)));
  const pass = challengeStatus({
    rules: R,
    snapshots: [{ time: T(1), equity: 10200 }, { time: T(2), equity: 10400 }, { time: T(3), equity: 10520 }],
    now: T(3, 13),
  });
  assert.ok(pass.messages.some((m) => /已達成階段一/.test(m.text)));
});

test('倉位：每筆風險 0.5% = 50，手續費算進停損虧損', () => {
  const r = sizePosition({ equity: 10000, entry: 100, stop: 98, riskPct: 0.5, feePct: 0.06 });
  assert.equal(r.dir, 'long');
  assert.ok(Math.abs(r.lossAtStop - 50) < 1e-9);
  assert.ok(r.qty < 24 && r.qty > 23); // 沒手續費是 25 顆；來回手續費每顆約 0.12，所以只能買約 23.6 顆
  assert.equal(r.limitedBy, 'risk');
});

test('倉位：今天剩餘空間只剩一點時，改用剩餘空間的一半當風險', () => {
  const r = sizePosition({ equity: 10000, entry: 100, stop: 98, riskPct: 1, dailyRoom: 60, totalRoom: 1000 });
  assert.equal(r.limitedBy, 'daily');
  assert.ok(Math.abs(r.lossAtStop - 30) < 1e-9);
});

test('倉位：停損太近會超過 5 倍槓桿，數量壓到槓桿上限', () => {
  const r = sizePosition({ equity: 10000, entry: 100, stop: 99.95, riskPct: 1, maxLeverage: 5 });
  assert.equal(r.limitedBy, 'leverage');
  assert.ok(Math.abs(r.leverage - 5) < 1e-9);
  assert.ok(r.lossAtStop < 100);
});

test('倉位：空單、止盈的風報比；止盈放錯邊會提醒', () => {
  const r = sizePosition({ equity: 10000, entry: 100, stop: 102, takeProfit: 94, riskPct: 0.5, feePct: 0 });
  assert.equal(r.dir, 'short');
  assert.ok(Math.abs(r.rr - 3) < 1e-9);
  assert.match(sizePosition({ equity: 10000, entry: 100, stop: 102, takeProfit: 105 }).error, /止盈/);
  assert.ok(sizePosition({ equity: 10000, entry: 100, stop: 98, dailyRoom: 0 }).blocked);
});

/* ------------------------------------------------------------ 考試模擬（scripts/research/lib.mjs） */

import { simulateProp } from '../scripts/research/lib.mjs';

const H = 3_600_000;
const D0 = Date.UTC(2026, 0, 1);
// 一天一筆、每筆 12 小時結束；r 用陣列指定
const seq = (rs, sym = (i) => `S${i}USDT`) => rs.map((r, i) => ({
  filledTime: D0 + i * 24 * H + 2 * H, closedTime: D0 + i * 24 * H + 14 * H, r, stopPct: 0.02, symbol: sym(i), dir: 'long',
}));

test('考試模擬：每天賺 +1R（1% = 100），5 天過階段一、再 10 天過階段二', () => {
  const r = simulateProp(seq(Array(40).fill(1)), { startTime: D0, riskPct: 1 });
  assert.equal(r.result, 'pass');
  assert.equal(r.phaseDays.length, 2);
  assert.ok(r.phaseDays[0] >= 4 && r.phaseDays[0] <= 5, JSON.stringify(r));
});

test('考試模擬：目標到了但獲利日不夠不算過關（一天賺 +600 只算 1 個獲利日）', () => {
  const r = simulateProp(seq([6, 0, 0, 0]), { startTime: D0, riskPct: 1, maxOpen: 1 });
  // 風險 1% = 100，+6R = +600 → 目標 10500 到了，但獲利日只有 1 天
  assert.equal(r.result, 'open');
  assert.equal(r.phase, 0);
});

test('考試模擬：連續虧損會碰到最大損失；倉位隨剩餘空間縮小，所以要虧很多筆才會出局', () => {
  const r = simulateProp(seq(Array(200).fill(-1)), { startTime: D0, riskPct: 1 });
  // 風險 = min(1%、今天剩一半、總剩四分之一)：剩餘空間越少倉位越小，淨值只會無限接近底線
  assert.equal(r.result, 'open');
  const gap = simulateProp(seq([-1, -1, -1, -8]), { startTime: D0, riskPct: 1 });
  assert.equal(gap.result, 'fail-total', '跳空打穿停損（一筆 -8R ≈ -776）才會一次出局');
  const daily = simulateProp(seq([-8]), { startTime: D0, riskPct: 1 });
  assert.equal(daily.result, 'fail-total'.replace('total', 'daily'), '第一天就 -8R（-800）先碰到每日上限');
});

test('考試模擬：今天虧到每日上限一半（250）就不再開新單', () => {
  const trades = Array.from({ length: 6 }, (_, i) => ({
    filledTime: D0 + i * H, closedTime: D0 + i * H + H / 2, r: -1, stopPct: 0.02, symbol: `S${i}USDT`, dir: 'long',
  }));
  const r = simulateProp(trades, { startTime: D0, riskPct: 1 });
  assert.equal(r.result, 'open');
  // 100 + 100 + 50（剩餘一半的上限）→ 250 之後停手：6 筆只做了 3 筆
});
