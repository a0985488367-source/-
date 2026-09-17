import test from 'node:test';
import assert from 'node:assert/strict';

import { makeRng } from '../src/sim/microlot.js';
import {
  kellyFraction, logGrowth, tradesToTarget, fairGameCeiling,
  simulateTargetRun, runTargetMonteCarlo, sweepFraction, propFirmPayoff,
  simulateMilestones, runMilestones,
} from '../src/sim/target.js';

/* -------------------------------------------------------- 理論錨點 */

test('公平賭局的大膽下注達到 1/N 上限（Optional Stopping）', () => {
  // 這是整份分析的理論錨點：無優勢、無成本時，P(到達 100 倍) 必須等於 1%。
  // 模擬若超過此值，代表模擬本身有錯（曾用此測試抓到 PRNG 種子相關性的 bug）。
  const res = runTargetMonteCarlo(
    { balance: 1000, multiple: 100, winProb: 0.5, payoff: 1, fraction: 1.0, costPerTrade: 0, trades: 400 },
    { runs: 60000, seed: 31337 },
  );
  assert.ok(Math.abs(res.hitRate - 0.01) < 0.0015, `hitRate=${res.hitRate}`);
  assert.ok(res.hitRate <= fairGameCeiling(100) + 0.0015, '不得超過理論上限');
});

test('公平賭局下，任何下注比例都無法超過 1/N 上限', () => {
  const rows = sweepFraction(
    { balance: 1000, multiple: 100, winProb: 0.5, payoff: 1, costPerTrade: 0, trades: 400 },
    [0.1, 0.25, 0.5, 1.0],
    { runs: 20000, seed: 8675309 },
  );
  for (const r of rows) {
    assert.ok(r.hitRate <= fairGameCeiling(100) + 0.002, `f=${r.fraction} hitRate=${r.hitRate}`);
  }
  // 且下注越大越接近上限
  assert.ok(rows[rows.length - 1].hitRate > rows[0].hitRate);
});

test('交易成本使達標率嚴格下降', () => {
  const opts = { runs: 20000, seed: 555 };
  const base = { balance: 1000, multiple: 100, winProb: 0.5, fraction: 1.0, trades: 400 };
  const free = runTargetMonteCarlo({ ...base, costPerTrade: 0 }, opts).hitRate;
  const dear = runTargetMonteCarlo({ ...base, costPerTrade: 0.05 }, opts).hitRate;
  assert.ok(dear < free, `${dear} 應小於 ${free}`);
});

/* -------------------------------------------------------- 凱利公式 */

test('kellyFraction 與已知值相符', () => {
  assert.ok(Math.abs(kellyFraction(0.6, 1) - 0.2) < 1e-12);
  assert.ok(Math.abs(kellyFraction(0.55, 1) - 0.1) < 1e-12);
  assert.equal(kellyFraction(0.4, 1), 0);           // 無優勢 → 不下注
  assert.ok(Math.abs(kellyFraction(0.5, 2) - 0.25) < 1e-12);
});

test('凱利比例確實是對數成長率的極大值', () => {
  const p = 0.6, b = 1;
  const f = kellyFraction(p, b);
  const g = logGrowth(p, b, f);
  for (const d of [-0.08, -0.03, 0.03, 0.08]) {
    assert.ok(logGrowth(p, b, f + d) < g, `f=${f + d} 的成長率不應超過凱利`);
  }
  assert.equal(logGrowth(p, b, 1), -Infinity);      // 全押必然歸零
});

test('tradesToTarget 與對數成長率一致', () => {
  const p = 0.6, b = 1, f = kellyFraction(p, b);
  const n = tradesToTarget(p, b, f, 100);
  assert.ok(Math.abs(n * logGrowth(p, b, f) - Math.log(100)) < 1e-9);
  assert.equal(tradesToTarget(0.5, 1, 0.2, 100), Infinity);  // 無優勢 → 永遠達不到
});

/* -------------------------------------------------------- 模擬機制 */

test('capStake 讓最後一注不會超額下注', () => {
  const r = simulateTargetRun(
    { balance: 1000, multiple: 2, winProb: 1, fraction: 1.0, costPerTrade: 0, trades: 5 },
    makeRng(1),
  );
  assert.equal(r.hit, true);
  assert.equal(r.balance, 2000, '應剛好停在目標，不overshoot');
  assert.equal(r.trades, 1);
});

test('必輸的賭局會在第一筆全押後破產', () => {
  const r = simulateTargetRun(
    { balance: 1000, multiple: 100, winProb: 0, fraction: 1.0, trades: 50 },
    makeRng(2),
  );
  assert.equal(r.ruined, true);
  assert.equal(r.balance, 0);
  assert.equal(r.trades, 1);
});

test('同種子可重現', () => {
  const cfg = { winProb: 0.55, fraction: 0.1 };
  const a = runTargetMonteCarlo(cfg, { runs: 500, seed: 42 });
  const b = runTargetMonteCarlo(cfg, { runs: 500, seed: 42 });
  assert.equal(a.hitRate, b.hitRate);
  assert.equal(a.medianBalance, b.medianBalance);
});

/* -------------------------------------------------------- 自營商結構 */

test('propFirmPayoff 的倍數與期望值計算正確', () => {
  const r = propFirmPayoff({ fee: 250, accountSize: 100000, profitTargetPct: 10, splitPct: 80, passRate: 0.08, payoutRate: 1, attempts: 1 });
  assert.equal(r.grossPerPass, 8000);              // 100k × 10% × 80%
  assert.equal(r.multiplePerPass, 32);             // 8000 / 250
  assert.ok(Math.abs(r.expectedMultiple - 0.08 * 32) < 1e-9);
  // 多次嘗試會提高過關機率，但成本同步上升
  const three = propFirmPayoff({ fee: 250, accountSize: 100000, passRate: 0.08, attempts: 3, payoutRate: 1 });
  assert.ok(three.pAtLeastOnePass > r.pAtLeastOnePass);
  assert.ok(three.multipleOnTotalCost < r.multiplePerPass);
});

/* -------------------------------------------------------- 里程碑 */

test('全凱利的回撤性質：P(曾跌到初始的 x 倍) ≈ x', () => {
  // 已知結果，與優勢大小無關。用來把關里程碑模擬的正確性。
  for (const p of [0.55, 0.60, 0.65]) {
    const res = runMilestones(
      { balance: 100, winProb: p, fraction: kellyFraction(p, 1), costPerTrade: 0, trades: 4000, ruinFloor: 0.2 },
      [1e9],                                    // 遙不可及的目標 → 只量回撤
      { runs: 8000, seed: 2468 },
    );
    assert.ok(Math.abs(res.ruinRate - 0.2) < 0.05, `p=${p} ruinRate=${res.ruinRate}，理論 0.2`);
  }
});

test('里程碑依序記錄，且時間隨目標單調遞增', () => {
  const res = runMilestones(
    { balance: 100, winProb: 0.6, fraction: 0.2, costPerTrade: 0.002, trades: 2000, ruinFloor: 0.1 },
    [200, 500, 1000, 10000],
    { runs: 3000, seed: 1357 },
  );
  const t = res.targets;
  for (let i = 1; i < t.length; i++) {
    assert.ok(t[i].medianTrades >= t[i - 1].medianTrades, '較遠的目標不可能較早達成');
    assert.ok(t[i].reachRate <= t[i - 1].reachRate, '較遠的目標達成率不可能較高');
  }
  assert.ok(t[0].reachRate > 0.8);
});

test('必勝路徑上，里程碑時間與複利公式相符', () => {
  // 勝率 100%、比例 100%、無成本 → 每筆剛好翻倍
  const { hits } = simulateMilestones(
    { balance: 100, winProb: 1, fraction: 1, costPerTrade: 0, trades: 20, ruinFloor: 0 },
    makeRng(1),
    [200, 400, 800, 1600],
  );
  assert.deepEqual(hits, [1, 2, 3, 4]);
});
