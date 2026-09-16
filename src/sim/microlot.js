/**
 * 微手數／高槓桿帳戶的蒙地卡羅生存模擬。
 *
 * 用途：回答「小本金 + 極高槓桿疊單 + 不設停損」這種操作方式，
 * 在 N 次獨立帳戶歷程中的實際結果分布（破產率、存活交易數、峰值假象）。
 *
 * 模型刻意保持保守：零依賴、可重現（固定種子）、參數全部外露可調。
 * 本檔為純函式模組，瀏覽器與 Node 皆可 import。
 */

/* ------------------------------------------------------------ 亂數 */

/** xoshiro128** — 快速且可重現的 PRNG，回傳 [0,1) */
export function makeRng(seed = 1) {
  let s0 = seed >>> 0 || 1;
  let s1 = (seed * 0x9e3779b9) >>> 0 || 2;
  let s2 = (seed ^ 0x85ebca6b) >>> 0 || 3;
  let s3 = (seed + 0xc2b2ae35) >>> 0 || 4;
  const rotl = (x, k) => ((x << k) | (x >>> (32 - k))) >>> 0;
  return function next() {
    const r = (Math.imul(rotl((Math.imul(s1, 5) >>> 0), 7), 9) >>> 0);
    const t = (s1 << 9) >>> 0;
    s2 ^= s0; s3 ^= s1; s1 ^= s2; s0 ^= s3; s2 ^= t;
    s3 = rotl(s3, 11);
    return r / 4294967296;
  };
}

/** 標準常態（Box–Muller，快取備用值） */
export function makeGaussian(rng) {
  let spare = null;
  return function gaussian() {
    if (spare !== null) { const v = spare; spare = null; return v; }
    let u = 0, v = 0, s = 0;
    do {
      u = rng() * 2 - 1;
      v = rng() * 2 - 1;
      s = u * u + v * v;
    } while (s === 0 || s >= 1);
    const f = Math.sqrt((-2 * Math.log(s)) / s);
    spare = v * f;
    return u * f;
  };
}

/**
 * 厚尾報酬取樣：常態尺度混合（90% 常態 / 10% 放大），
 * 除以 sqrt(E[mix]) 以維持單位變異數，只加厚尾不改變整體波動率。
 */
export function makeInnovation(rng, { fatTail = true } = {}) {
  const gaussian = makeGaussian(rng);
  if (!fatTail) return gaussian;
  const mixHi = 6.25, pHi = 0.1;
  const norm = Math.sqrt((1 - pHi) * 1 + pHi * mixHi);
  return function innovation() {
    const scale = rng() < pHi ? Math.sqrt(mixHi) : 1;
    return (gaussian() * scale) / norm;
  };
}

/* ------------------------------------------------------------ 參數 */

/**
 * 預設值取自影片（traderspin_sakhile，MT5 / XAUUSDm）：
 *  6:08 Balance 4.52 → 3 張 0.01；6:08 Balance 7.20 → 5 張 0.01
 *  → 張數 ≈ round(balance / 1.5)，兩個時間點都吻合。
 *  6:10 五張合計 +5.78 USD，平均每張 +1.16 → 毛價格波動約 +1.35/oz（扣點差後相符）。
 * 黃金 0.01 手 = 1 金衡盎司，金價每動 1 USD → 損益 1 USD（影片可驗證：
 *  4385.435 → 4386.784 = +1.349，介面顯示 1.34）。
 */
export const DEFAULT_CONFIG = {
  price: 4385,            // 起始金價
  balance: 7.20,          // 起始本金（USD）
  volDaily: 0.010,        // 每日對數報酬標準差（黃金常態區間約 1%）
  minutesPerDay: 1440,    // 外匯／黃金近似 24 小時交易
  volClustering: 0.35,    // 每筆交易的波動率對數常態擾動（0 = 關閉）
  fatTail: true,
  spread: 0.20,           // 點差（USD/oz），開倉時一次付清
  commission: 0,          // 每盎司來回佣金
  sizing: 'video',        // 'video'（隨本金加碼）| 'fixed'
  lotDivisor: 1.5,        // video 模式：張數 = round(balance / lotDivisor)
  fixedLots: 5,
  maxLots: 20000,        // 券商單筆手數上限（200 標準手 = 20000 張 0.01）
  takeProfitMove: 1.35,   // 出場：順向價格波動（USD/oz）
  stopLossMove: null,     // 停損：逆向價格波動（USD/oz）；null = 不設（影片如此）
  edgeWinRate: 0.50,      // 方向勝率（0.5 = 無任何優勢），定義於對稱 ±takeProfitMove 障壁
  driftPerMinute: null,   // 直接指定順向漂移（USD/oz/分鐘）；設定後即忽略 edgeWinRate
  maxHoldMinutes: 240,    // 單筆最長持有
  maxTrades: 200,         // 帳戶模擬上限（約數個交易日的操作量）
  ruinBalance: 1.00,      // 低於此金額視為實質陣亡
};

/* --------------------------------------------------- 優勢（漂移）校準 */

/**
 * 把「方向勝率」轉成價格漂移。
 * 對稱障壁 ±a 的布朗運動，命中上緣的機率
 *   P = 1 / (1 + exp(-2·μ·a / σ²))
 * 反解 μ。σ、μ 皆為每分鐘的 USD/oz。
 */
export function driftForWinRate(winRate, sigma, barrier) {
  if (!(winRate > 0.5)) return 0;
  const p = Math.min(0.999, winRate);
  return (Math.log(p / (1 - p)) * sigma * sigma) / (2 * barrier);
}

/* ------------------------------------------------------------ 單一帳戶 */

/** 依本金決定張數（1 張 = 0.01 手 = 1 盎司） */
export function lotsFor(balance, cfg) {
  if (cfg.sizing === 'fixed') return cfg.fixedLots;
  return Math.max(1, Math.min(cfg.maxLots, Math.round(balance / cfg.lotDivisor)));
}

/**
 * 模擬單一帳戶，直到破產、達到交易次數上限，或本金跌破實質陣亡線。
 * 回傳該帳戶的完整歷程摘要。
 */
export function simulateAccount(cfg, rng) {
  const c = { ...DEFAULT_CONFIG, ...cfg };
  const innovation = makeInnovation(rng, { fatTail: c.fatTail });
  const gaussian = makeGaussian(rng);
  const sigmaBase = (c.price * c.volDaily) / Math.sqrt(c.minutesPerDay); // USD/oz 每分鐘

  let balance = c.balance;
  let peak = balance;
  let trades = 0;
  let minutes = 0;
  let wins = 0;
  let firstTradeWon = false;
  let ruined = false;
  let stoppedOut = false;       // equity ≤ 0，被券商強制平倉
  let doubled = false;          // 帳面是否曾經翻倍（拍片的素材）
  let tripled = false;
  let hitLotCap = false;        // 是否碰到券商手數上限（等於被迫脫離加碼規則）

  while (trades < c.maxTrades) {
    const lots = lotsFor(balance, c);
    if (c.sizing === 'video' && lots >= c.maxLots) hitLotCap = true;
    const qty = lots;                                   // 盎司
    const cost = qty * (c.spread + c.commission);       // 開倉即付
    // 逆向多少會歸零：equity = balance + qty·move − cost ≤ 0
    const ruinMove = (balance - cost) / qty;

    // 本筆交易的波動率（波動聚集：安靜盤 / 活躍盤）
    const volMult = c.volClustering > 0
      ? Math.exp(gaussian() * c.volClustering - (c.volClustering ** 2) / 2)
      : 1;
    const sigma = sigmaBase * volMult;
    const drift = c.driftPerMinute != null
      ? c.driftPerMinute
      : driftForWinRate(c.edgeWinRate, sigma, c.takeProfitMove);

    let move = 0;                                       // 順向為正（USD/oz）
    let closed = false;
    let held = 0;

    while (held < c.maxHoldMinutes) {
      held += 1;
      move += drift + sigma * innovation();
      const pnl = qty * move - cost;

      if (balance + pnl <= 0) {                         // 無限槓桿 → 0% 強平
        balance = 0;
        ruined = true;
        stoppedOut = true;
        closed = true;
        break;
      }
      if (move >= c.takeProfitMove) {
        balance += pnl; wins += 1; if (trades === 0) firstTradeWon = true; closed = true; break;
      }
      if (c.stopLossMove != null && move <= -c.stopLossMove) {
        balance += pnl; closed = true; break;
      }
    }
    if (!closed) balance += qty * move - cost;          // 逾時平倉

    trades += 1;
    minutes += held;
    if (balance > peak) peak = balance;
    if (peak >= c.balance * 2) doubled = true;
    if (peak >= c.balance * 3) tripled = true;

    if (ruined) break;
    if (balance < c.ruinBalance) { ruined = true; break; }
  }

  return {
    balance, peak, trades, minutes, wins, ruined, stoppedOut, doubled, tripled, hitLotCap, firstTradeWon,
    tradeWinRate: trades ? wins / trades : 0,
    survived: !ruined,
  };
}

/* ------------------------------------------------------------ 批次統計 */

export function quantile(sortedAsc, q) {
  if (!sortedAsc.length) return NaN;
  const pos = (sortedAsc.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  if (lo === hi) return sortedAsc[lo];
  return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (pos - lo);
}

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);

/** 跑 runs 次獨立帳戶，回傳彙總統計與存活曲線 */
export function runMonteCarlo(cfg, { runs = 10000, seed = 20260915 } = {}) {
  const c = { ...DEFAULT_CONFIG, ...cfg };
  const results = [];
  for (let i = 0; i < runs; i++) {
    // 每個帳戶獨立種子 → 可個別重現
    results.push(simulateAccount(c, makeRng(seed + i * 2654435761)));
  }

  const balances = results.map((r) => r.balance).sort((a, b) => a - b);
  const peaks = results.map((r) => r.peak).sort((a, b) => a - b);
  const ruinedTrades = results.filter((r) => r.ruined).map((r) => r.trades).sort((a, b) => a - b);
  const ruinedMinutes = results.filter((r) => r.ruined).map((r) => r.minutes).sort((a, b) => a - b);

  // 存活曲線：撐過 k 筆交易仍未破產的比例
  const marks = [1, 5, 10, 20, 50, 100, 200].filter((m) => m <= c.maxTrades);
  const survival = marks.map((m) => ({
    trades: m,
    alive: results.filter((r) => !r.ruined || r.trades > m).length / runs,
  }));

  const ruinCount = results.filter((r) => r.ruined).length;
  const doubledCount = results.filter((r) => r.doubled).length;
  const doubledThenRuined = results.filter((r) => r.doubled && r.ruined).length;

  return {
    config: c,
    runs,
    ruinRate: ruinCount / runs,
    stopOutRate: results.filter((r) => r.stoppedOut).length / runs,
    endBalance: {
      mean: mean(balances),
      p05: quantile(balances, 0.05),
      p25: quantile(balances, 0.25),
      median: quantile(balances, 0.5),
      p75: quantile(balances, 0.75),
      p95: quantile(balances, 0.95),
      max: balances[balances.length - 1],
    },
    peakBalance: { median: quantile(peaks, 0.5), p95: quantile(peaks, 0.95), max: peaks[peaks.length - 1] },
    tradesToRuin: {
      median: quantile(ruinedTrades, 0.5),
      p25: quantile(ruinedTrades, 0.25),
      p75: quantile(ruinedTrades, 0.75),
      mean: mean(ruinedTrades),
    },
    minutesToRuin: { median: quantile(ruinedMinutes, 0.5), mean: mean(ruinedMinutes) },
    everDoubled: doubledCount / runs,
    doubledThenRuined: doubledCount ? doubledThenRuined / doubledCount : 0,
    everTripled: results.filter((r) => r.tripled).length / runs,
    hitLotCapRate: results.filter((r) => r.hitLotCap).length / runs,
    // 首筆交易勝率：不受「存活者做了更多筆」的加權汙染，跨情境可直接比較
    firstTradeWinRate: results.filter((r) => r.firstTradeWon).length / runs,
    firstTradeRuinRate: results.filter((r) => r.stoppedOut && r.trades === 1).length / runs,
    profitable: results.filter((r) => r.balance > c.balance).length / runs,
    totalTrades: results.reduce((a, r) => a + r.trades, 0),
    // 所有帳戶合計的單筆勝率（非各帳戶勝率的平均，避免短命帳戶被過度加權）
    realizedWinRate: results.reduce((a, r) => a + r.wins, 0) / Math.max(1, results.reduce((a, r) => a + r.trades, 0)),
    survival,
  };
}

/**
 * 以最小交易單位回推「風險可控」所需的最低本金。
 * 黃金最小 0.01 手 = 1 盎司，停損 stopUsd（USD/oz）即代表每筆至少虧 stopUsd。
 */
export function minimumViableAccount(stopUsd, riskPct = 1) {
  return (stopUsd * 100) / riskPct;
}
