import test from 'node:test';
import assert from 'node:assert/strict';

import {
  makeRng, makeGaussian, makeInnovation, driftForWinRate,
  lotsFor, simulateAccount, runMonteCarlo, quantile, minimumViableAccount,
  DEFAULT_CONFIG,
} from '../src/sim/microlot.js';

/* ------------------------------------------------------------ 亂數品質 */

test('makeRng 同種子可重現、異種子不同', () => {
  const a = makeRng(42), b = makeRng(42), c = makeRng(43);
  const seqA = Array.from({ length: 8 }, a);
  const seqB = Array.from({ length: 8 }, b);
  const seqC = Array.from({ length: 8 }, c);
  assert.deepEqual(seqA, seqB);
  assert.notDeepEqual(seqA, seqC);
  assert.ok(seqA.every((x) => x >= 0 && x < 1));
});

test('相鄰種子產生的序列彼此獨立（迴歸測試）', () => {
  // 每次模擬開一個新種子是本專案的用法；若種子未經 splitmix32 展開，
  // seed + i·k 這種序列會高度相關，曾使公平賭局的達標率從 1.0% 灌水到 3.4%。
  const N = 40000, k = 2654435761;
  // 邊際分布
  const firsts = Array.from({ length: N }, (_, i) => makeRng(12345 + i * k)());
  const heads = firsts.filter((x) => x < 0.5).length / N;
  assert.ok(Math.abs(heads - 0.5) < 0.01, `marginal=${heads}`);
  // 聯合分布：連續 7 次 < 0.5 的比例應接近 1/128
  let runs7 = 0;
  for (let i = 0; i < N; i++) {
    const r = makeRng(999 + i * k);
    let ok = true;
    for (let j = 0; j < 7; j++) if (!(r() < 0.5)) { ok = false; break; }
    if (ok) runs7 += 1;
  }
  const rate = runs7 / N;
  assert.ok(Math.abs(rate - 1 / 128) < 0.004, `7連續=${rate}，理論 ${1 / 128}`);
});

test('makeGaussian 的均值與變異數接近 0 / 1', () => {
  const g = makeGaussian(makeRng(7));
  const n = 200000;
  let sum = 0, sumSq = 0;
  for (let i = 0; i < n; i++) { const x = g(); sum += x; sumSq += x * x; }
  const mean = sum / n;
  assert.ok(Math.abs(mean) < 0.02, `mean=${mean}`);
  assert.ok(Math.abs(sumSq / n - mean * mean - 1) < 0.02);
});

test('厚尾取樣維持單位變異數但提高峰度', () => {
  const n = 200000;
  const sample = (fn) => {
    let sumSq = 0, sum4 = 0;
    for (let i = 0; i < n; i++) { const x = fn(); sumSq += x * x; sum4 += x ** 4; }
    return { varr: sumSq / n, kurt: (sum4 / n) / (sumSq / n) ** 2 };
  };
  const normal = sample(makeInnovation(makeRng(11), { fatTail: false }));
  const fat = sample(makeInnovation(makeRng(11), { fatTail: true }));
  assert.ok(Math.abs(fat.varr - 1) < 0.05, `var=${fat.varr}`);
  assert.ok(fat.kurt > normal.kurt + 1, `kurt ${fat.kurt} vs ${normal.kurt}`);
});

/* ------------------------------------------------------ 優勢漂移校準 */

test('driftForWinRate 在對稱障壁下確實產生目標勝率', () => {
  const sigma = 1, barrier = 5, target = 0.6;
  const drift = driftForWinRate(target, sigma, barrier);
  const rng = makeRng(99);
  const innovation = makeInnovation(rng, { fatTail: false });
  let up = 0;
  const trials = 20000;
  for (let i = 0; i < trials; i++) {
    let move = 0;
    for (let t = 0; t < 4000; t++) {
      move += drift + sigma * innovation();
      if (move >= barrier) { up += 1; break; }
      if (move <= -barrier) break;
    }
  }
  assert.ok(Math.abs(up / trials - target) < 0.02, `realised=${up / trials}`);
});

test('無優勢時漂移為 0', () => {
  assert.equal(driftForWinRate(0.5, 1, 1), 0);
  assert.equal(driftForWinRate(0.4, 1, 1), 0);
});

/* ------------------------------------------------------------ 倉位規則 */

test('video 倉位規則重現影片兩個時間點的張數', () => {
  // 影片：Balance 4.52 → 3 張；Balance 7.20 → 5 張
  assert.equal(lotsFor(4.52, DEFAULT_CONFIG), 3);
  assert.equal(lotsFor(7.20, DEFAULT_CONFIG), 5);
});

test('fixed 模式不隨本金變動，且兩種模式都受手數上限拘束', () => {
  const fixed = { ...DEFAULT_CONFIG, sizing: 'fixed', fixedLots: 5 };
  assert.equal(lotsFor(7.2, fixed), 5);
  assert.equal(lotsFor(72000, fixed), 5);
  assert.equal(lotsFor(1e9, DEFAULT_CONFIG), DEFAULT_CONFIG.maxLots);
  assert.equal(lotsFor(0.1, DEFAULT_CONFIG), 1);
});

/* ------------------------------------------------------------ 帳戶模擬 */

test('優勢漂移是波動率的函數：零波動 = 零優勢', () => {
  // μ = ln(p/(1-p))·σ²/(2a)，σ = 0 時任何勝率設定都產生不出漂移
  assert.equal(driftForWinRate(0.9, 0, 1.35), 0);
});

test('零波動但指定順向漂移時，帳戶每筆都獲利且不破產', () => {
  const r = simulateAccount(
    { volDaily: 0, volClustering: 0, fatTail: false, driftPerMinute: 0.5, maxTrades: 10 },
    makeRng(3),
  );
  assert.equal(r.wins, 10, '每筆都應打到停利');
  assert.equal(r.ruined, false);
  assert.equal(r.trades, 10);
  assert.ok(r.balance > DEFAULT_CONFIG.balance);
});

test('零波動零優勢時，帳戶只會被點差慢慢磨光', () => {
  // 沒有價格變動 → 永遠打不到停利，每筆在逾時平倉時只付點差
  const r = simulateAccount(
    { volDaily: 0, volClustering: 0, fatTail: false, edgeWinRate: 0.5, maxTrades: 200 },
    makeRng(5),
  );
  assert.equal(r.wins, 0);
  assert.ok(r.balance < DEFAULT_CONFIG.balance, '點差應使本金單調遞減');
  assert.ok(r.ruined, '純點差成本最終仍會使本金跌破實質陣亡線');
});

test('破產的帳戶本金歸零且標記為券商強平', () => {
  const r = simulateAccount({ volDaily: 0.05, maxTrades: 200 }, makeRng(17));
  assert.equal(r.ruined, true);
  assert.equal(r.stoppedOut, true);
  assert.equal(r.balance, 0);
});

test('停利價位換算後的入帳金額與影片相符（5 張約 +5.75）', () => {
  // 影片 6:10：5 張合計 +5.78 USD
  const qty = 5, tp = DEFAULT_CONFIG.takeProfitMove, spread = DEFAULT_CONFIG.spread;
  const net = qty * tp - qty * spread;
  assert.ok(Math.abs(net - 5.78) < 0.2, `net=${net}`);
});

/* ------------------------------------------------------------ 批次統計 */

test('quantile 在已排序陣列上做線性內插', () => {
  const xs = [0, 1, 2, 3, 4];
  assert.equal(quantile(xs, 0), 0);
  assert.equal(quantile(xs, 0.5), 2);
  assert.equal(quantile(xs, 1), 4);
  assert.equal(quantile(xs, 0.25), 1);
  assert.ok(Number.isNaN(quantile([], 0.5)));
});

test('runMonteCarlo 同種子可重現，且比例型指標都在 [0,1]', () => {
  const opts = { runs: 200, seed: 123 };
  const a = runMonteCarlo({}, opts);
  const b = runMonteCarlo({}, opts);
  assert.equal(a.ruinRate, b.ruinRate);
  assert.equal(a.endBalance.median, b.endBalance.median);
  for (const k of ['ruinRate', 'stopOutRate', 'everDoubled', 'profitable', 'firstTradeWinRate']) {
    assert.ok(a[k] >= 0 && a[k] <= 1, `${k}=${a[k]}`);
  }
  assert.equal(a.survival[0].trades, 1);
});

test('提高方向勝率會單調降低破產率', () => {
  const opts = { runs: 600, seed: 777 };
  const flat = runMonteCarlo({ edgeWinRate: 0.50 }, opts).ruinRate;
  const good = runMonteCarlo({ edgeWinRate: 0.60 }, opts).ruinRate;
  const elite = runMonteCarlo({ edgeWinRate: 0.75 }, opts).ruinRate;
  assert.ok(flat >= good && good >= elite, `${flat} / ${good} / ${elite}`);
  assert.ok(elite > 0.5, '即使勝率 75%，全額加碼下破產率仍應偏高');
});

test('風險可控的對照組不會破產', () => {
  const res = runMonteCarlo(
    {
      balance: 500, sizing: 'fixed', fixedLots: 1,
      stopLossMove: 4, takeProfitMove: 8, edgeWinRate: 0.55,
      maxHoldMinutes: 1440, ruinBalance: 50,
    },
    { runs: 300, seed: 4242 },
  );
  assert.equal(res.ruinRate, 0);
});

test('minimumViableAccount 由最小交易單位反推本金', () => {
  assert.equal(minimumViableAccount(4, 1), 400);
  assert.equal(minimumViableAccount(4, 2), 200);
});
