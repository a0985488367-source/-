import test from 'node:test';
import assert from 'node:assert/strict';
import { simulatePortfolio, pagedKlines, researchTargets, applyStopResearch, runSignals } from '../scripts/research/lib.mjs';

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

test('researchTargets：固定 R 出場與目標等比例拉近（多空都對）', () => {
  const long = { entry: 100, stop: 98, targets: [{ price: 104, rr: 2 }, { price: 108, rr: 4 }] };
  assert.deepEqual(researchTargets(long, { fixedTpR: 1.5 }), [{ name: 'TP1', price: 103, rr: 1.5 }]);
  assert.deepEqual(researchTargets(long, { tpScale: 0.5 }).map((t) => [t.price, t.rr]), [[102, 1], [104, 2]]);
  assert.equal(researchTargets(long, {}), long.targets);
  const short = { entry: 100, stop: 102, targets: [{ price: 96, rr: 2 }] };
  assert.equal(researchTargets(short, { fixedTpR: 1 })[0].price, 98);
  assert.equal(researchTargets(short, { tpScale: 0.75 })[0].price, 97);
});

test('同方向未保本上限、每小時新單上限', () => {
  const H = 3_600_000;
  const trades = [
    t({ symbol: 'A', dir: 'long', filledTime: 0, closedTime: 10 * H }),
    t({ symbol: 'B', dir: 'long', filledTime: 1, closedTime: 10 * H }),
    t({ symbol: 'C', dir: 'short', filledTime: 2, closedTime: 10 * H }),
    t({ symbol: 'D', dir: 'long', filledTime: 2 * H, closedTime: 10 * H }),
  ];
  assert.equal(simulatePortfolio(trades, { maxSameDirAtRisk: 1 }).taken, 2, '多單只留 A，空單 C 照開');
  assert.equal(simulatePortfolio(trades, { maxNewPerHour: 2 }).taken, 3, '第一小時只開 A、B，兩小時後的 D 可以開');
});

test('疊單縮小風險、單日虧損停手、skip 過濾', () => {
  const H = 3_600_000;
  const stacked = simulatePortfolio([
    t({ symbol: 'A', filledTime: 0, closedTime: 10, r: -1 }),
    t({ symbol: 'B', filledTime: 1, closedTime: 10, r: -1 }),
  ], { riskPct: 10, stackScale: 0.5 });
  assert.ok(Math.abs(stacked.multiple - (1 - 0.1 - 0.05)) < 1e-9, '第二筆只冒一半');

  const daily = simulatePortfolio([
    t({ symbol: 'A', filledTime: 0, closedTime: 1, r: -1 }),
    t({ symbol: 'B', filledTime: 2, closedTime: 3, r: -1 }),
    t({ symbol: 'C', filledTime: 4, closedTime: 5, r: -1 }),
    t({ symbol: 'D', filledTime: 30 * H, closedTime: 30 * H + 1, r: 1 }),
  ], { riskPct: 10, dailyStopPct: 15 });
  assert.equal(daily.taken, 3, '同一天虧超過 15% 後 C 不開，隔天 D 照開');

  assert.equal(simulatePortfolio([t({}), t({ symbol: 'B', dir: 'long' })], { skip: (x) => x.dir === 'long' }).taken, 1);
});

test('applyStopResearch：倉位不變只拉近停損／倉位照新停損重算', () => {
  const keep = applyStopResearch({ entry: 100, stop: 90, stopPct: 0.1 }, { tightStopKeepSize: 0.5 });
  assert.deepEqual([keep.stop, keep.initialStop, keep.stopPct], [95, 90, 0.1], 'R 仍以原停損算，打到虧 0.5R');
  const resize = applyStopResearch({ entry: 100, stop: 110, stopPct: 0.1 }, { tightStopResize: 0.7 });
  assert.equal(resize.stop, 107);
  assert.equal(resize.initialStop, 107);
  assert.ok(Math.abs(resize.stopPct - 0.07) < 1e-12, '倉位變大，手續費換算成 R 也跟著變大');
  const same = { entry: 100, stop: 90 };
  assert.equal(applyStopResearch(same, {}).stop, 90);
});

test('fillBarConservative：成交那根只看停損，不因成交前的高點提早保本或止盈', async () => {
  const { stepTrade } = await import('../src/smc/manage.js');
  const mk = () => ({ dir: 'long', entry: 100, stop: 98, status: 'pending', targets: [{ name: 'TP1', price: 103, rr: 1.5, fraction: 0 }], hitTargets: [], events: [], remaining: 1, realizedR: 0 });
  const bar = { time: 1, open: 104, high: 104, low: 99.5, close: 100 };
  const loose = mk();
  assert.equal(stepTrade(loose, bar, {}), true, '預設：成交那根的高點算成打到止盈');
  const strict = mk();
  assert.equal(stepTrade(strict, bar, { fillBarConservative: true }), false);
  assert.equal(strict.status, 'active');
  assert.equal(strict.maxFavorableR ?? 0, 0);
});

test('fillBarPath：收黑的成交根不算成交前的高點，收紅的算', async () => {
  const { stepTrade } = await import('../src/smc/manage.js');
  const mk = () => ({ dir: 'long', entry: 100, stop: 98, status: 'pending', targets: [{ name: 'TP1', price: 103, rr: 1.5, fraction: 0 }], hitTargets: [], events: [], remaining: 1, realizedR: 0 });
  const red = mk();
  assert.equal(stepTrade(red, { time: 1, open: 104, high: 104, low: 99.5, close: 100.2 }, { fillBarPath: true }), false, '收黑：高點在成交前');
  assert.ok(Math.abs(red.maxFavorableR - 0.1) < 1e-9, '只算到收盤價');
  const green = mk();
  assert.equal(stepTrade(green, { time: 1, open: 101, high: 104, low: 99.5, close: 103.5 }, { fillBarPath: true }), true, '收紅：先跌到成交再漲到止盈');
  const short = { ...mk(), dir: 'short', entry: 100, stop: 102, targets: [{ name: 'TP1', price: 97, rr: 1.5, fraction: 0 }] };
  assert.equal(stepTrade(short, { time: 1, open: 96, high: 100.5, low: 96, close: 99.8 }, { fillBarPath: true }), false, '空單收紅：低點在成交前');
});

test('runSignals subBars：成交那根裡先漲後跌，用 5 分鐘 K 棒就不會誤算成先賺', () => {
  const H = 3_600_000, M5 = 300_000;
  const k = (time, o, h, l, c) => ({ time, open: o, high: h, low: l, close: c });
  // 1h：第 0 根出訊號；第 1 根從 104 跌到 99.5（碰到 100 成交）；第 2 根跌破停損 98
  const tf = [k(0, 104, 104.5, 103.5, 104), k(H, 104, 104, 99.5, 99.8), k(2 * H, 99.8, 99.9, 97.5, 97.6)];
  const sub = [];
  for (let i = 0; i < 12; i++) { const p = Math.max(99.5, 104 - i * 0.9); sub.push(k(H + i * M5, p + 0.1, p + 0.1, p - 0.1, p)); }
  for (let i = 0; i < 12; i++) { const p = 99.8 - i * 0.2; sub.push(k(2 * H + i * M5, p, p + 0.05, p - 0.05, p)); }
  const candlesBy = new Map([['X|1h', tf], ['X|sub', sub]]);
  const sig = { symbol: 'X', interval: '1h', index: 0, time: 0, dir: 'long', entry: 100, stop: 98, entryType: 'limit', targets: [{ name: 'TP1', price: 106, rr: 3 }] };
  const [coarse] = runSignals([sig], candlesBy, {});
  assert.ok(coarse.r > 0, '原週期算法：把成交前的 104 當成已經賺到，追蹤停損鎖住獲利');
  const [fine] = runSignals([sig], candlesBy, { subBars: true });
  assert.equal(fine.exitReason, 'stop');
  assert.ok(Math.abs(fine.r + 1) < 1e-9, '5 分鐘逐根跑：成交後一路跌到停損');
});
