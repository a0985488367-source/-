/**
 * 目標導向的成長模擬：在破產之前摸到 N 倍的機率有多高？
 *
 * 與 microlot.js（生存模擬）不同，這裡問的是最佳化問題：
 *   給定優勢、下注比例與時間長度，P(先到達 N 倍) 是多少？最佳下注比例在哪？
 *
 * 兩個理論錨點，模擬結果應該與之相符：
 *  1. 公平賭局上限（Optional Stopping Theorem）：無優勢、無成本時，
 *     任何策略從 x 出發、在碰到 T 時停止，P(到達 T) ≤ x/T。
 *     100 倍 → 上限恰為 1%，且由「大膽下注」（bold play）達成。
 *  2. 凱利成長率：有優勢時，長期對數成長率 g(f) = p·ln(1+f·b) + (1−p)·ln(1−f)，
 *     達成 N 倍所需的交易筆數約為 ln(N) / g(f*)。
 */

import { makeRng, makeGaussian } from './microlot.js';

/* ------------------------------------------------------------ 解析解 */

/** 凱利最佳下注比例（勝率 p，賠率 b：贏賺 b 倍賭注，輸賠 1 倍） */
export function kellyFraction(p, b = 1) {
  const f = (p * (b + 1) - 1) / b;
  return Math.max(0, Math.min(1, f));
}

/** 每筆交易的對數成長率 */
export function logGrowth(p, b, f) {
  if (f <= 0) return 0;
  if (f >= 1) return -Infinity;               // 輸一次即歸零
  return p * Math.log(1 + f * b) + (1 - p) * Math.log(1 - f);
}

/** 以比例 f 下注時，達成 multiple 倍所需的交易筆數（期望值意義） */
export function tradesToTarget(p, b, f, multiple) {
  const g = logGrowth(p, b, f);
  if (!(g > 0)) return Infinity;
  return Math.log(multiple) / g;
}

/**
 * 公平賭局下 P(到達 N 倍) 的理論上限。
 * 無成本時為 1/multiple；每筆交易的成本會讓實際值嚴格更低。
 */
export function fairGameCeiling(multiple) {
  return 1 / multiple;
}

/* ------------------------------------------------------------ 模擬 */

export const TARGET_DEFAULTS = {
  balance: 1000,
  multiple: 100,          // 目標倍數
  trades: 250,            // 時間長度（三個月約 63 個交易日）
  winProb: 0.50,          // 方向勝率
  payoff: 1,              // 賠率 b（1 = 1:1）
  fraction: 0.5,          // 每筆下注比例
  costPerTrade: 0.0,      // 每筆成本，以「賭注」的比例計（點差／手續費）
  ruinFloor: 0.01,        // 低於起始本金的此比例即視為破產
  winProbSd: 0,           // 優勢估計誤差：每條路徑的真實勝率 ~ N(winProb, sd)
  capStake: true,         // 大膽下注的正確形式：絕不下超過「達標所需」的注
};

/** 單一路徑：回傳是否達標、是否破產、期末本金、用掉幾筆交易 */
export function simulateTargetRun(cfg, rng) {
  const c = { ...TARGET_DEFAULTS, ...cfg };
  const target = c.balance * c.multiple;
  const floor = c.balance * c.ruinFloor;
  let balance = c.balance;
  let peak = balance;

  for (let i = 0; i < c.trades; i++) {
    let stake = c.fraction * balance;
    if (c.capStake) {
      const needed = (target - balance) / c.payoff;   // 贏了剛好到達目標的賭注
      stake = Math.min(stake, needed);
    }
    if (stake <= 0) break;

    const cost = stake * c.costPerTrade;
    balance += rng() < c.winProb ? stake * c.payoff - cost : -stake - cost;

    if (balance > peak) peak = balance;
    if (balance >= target) return { hit: true, ruined: false, balance, peak, trades: i + 1 };
    if (balance <= floor) return { hit: false, ruined: true, balance: 0, peak, trades: i + 1 };
  }
  return { hit: false, ruined: false, balance, peak, trades: c.trades };
}

/** 批次模擬，回傳達標率、破產率與本金分布 */
export function runTargetMonteCarlo(cfg, { runs = 10000, seed = 20260917 } = {}) {
  const c = { ...TARGET_DEFAULTS, ...cfg };
  let hit = 0, ruined = 0, sumTradesToHit = 0;
  const balances = [];

  for (let i = 0; i < runs; i++) {
    const rng = makeRng(seed + i * 2654435761);
    // 優勢估計誤差：下注比例照「自以為的」勝率算，實際擲骰用真實勝率
    const cfgRun = c.winProbSd > 0
      ? { ...c, winProb: Math.max(0, Math.min(1, c.winProb + makeGaussian(rng)() * c.winProbSd)) }
      : c;
    const r = simulateTargetRun(cfgRun, rng);
    if (r.hit) { hit += 1; sumTradesToHit += r.trades; }
    if (r.ruined) ruined += 1;
    balances.push(r.balance);
  }
  balances.sort((a, b) => a - b);
  const q = (p) => balances[Math.min(balances.length - 1, Math.floor((balances.length - 1) * p))];

  return {
    config: c,
    runs,
    hitRate: hit / runs,
    ruinRate: ruined / runs,
    medianBalance: q(0.5),
    p95Balance: q(0.95),
    meanTradesToHit: hit ? sumTradesToHit / hit : NaN,
    kelly: kellyFraction(c.winProb, c.payoff),
    growthPerTrade: logGrowth(c.winProb, c.payoff, c.fraction),
    tradesNeeded: tradesToTarget(c.winProb, c.payoff, c.fraction, c.multiple),
  };
}

/** 掃描下注比例，找出讓 P(達標) 最大的 f */
export function sweepFraction(cfg, fractions, opts = {}) {
  return fractions.map((fraction) => {
    const res = runTargetMonteCarlo({ ...cfg, fraction }, opts);
    return { fraction, hitRate: res.hitRate, ruinRate: res.ruinRate, medianBalance: res.medianBalance };
  });
}

/**
 * 自營商（prop firm）挑戰賽的結構化報酬。
 * 這是唯一「下檔有硬上限」的結構：最多輸掉報名費，過關則操作大額資金並分潤。
 * 回傳相對於報名費的倍數與期望值。
 */
export function propFirmPayoff({
  fee = 250, accountSize = 100000, profitTargetPct = 10, splitPct = 80,
  passRate = 0.08, payoutRate = 0.9, attempts = 1,
} = {}) {
  const grossPerPass = accountSize * (profitTargetPct / 100) * (splitPct / 100);
  const multiplePerPass = (grossPerPass * payoutRate) / fee;
  const pAny = 1 - (1 - passRate) ** attempts;
  return {
    fee, totalCost: fee * attempts,
    grossPerPass,
    multiplePerPass,
    multipleOnTotalCost: (grossPerPass * payoutRate) / (fee * attempts),
    pAtLeastOnePass: pAny,
    expectedMultiple: (pAny * grossPerPass * payoutRate) / (fee * attempts),
  };
}
