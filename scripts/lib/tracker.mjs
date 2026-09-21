/**
 * 訊號追蹤引擎（模擬盤）
 *
 * 每則推播出去的訊號都變成一筆「模擬單」，之後每次掃描都用新的 K 棒
 * 推進它的狀態：等待進場 → 已進場 → 打到目標／停損／逾時。
 *
 * 全部是純函式，不碰網路也不碰檔案，因此可以用單元測試驗證 ——
 * 這很重要，因為這裡算錯就等於勝率統計是假的。
 *
 * 狀態機：
 *   pending  尚未成交（限價單還沒被碰到）
 *   active   已進場
 *   target   打到目標（可能是 TP1／TP2／TP3）
 *   stop     停損出場
 *   expired  等太久都沒進場，作廢
 */

import { stepTrade, buildLadder, finite, DEFAULT_MANAGEMENT } from '../../src/smc/manage.js';

export { DEFAULT_MANAGEMENT, buildLadder };

/** 保守假設：同一根 K 棒同時觸及停損與目標時，算停損 */
export function advanceTrade(trade, candles, opts = {}) {
  const t = { ...trade, hitTargets: [...(trade.hitTargets ?? [])], events: [] };
  if (t.status === 'target' || t.status === 'stop' || t.status === 'expired') return t;

  const from = candles.findIndex((c) => c.time > (t.lastCheckedTime ?? t.openTime));
  if (from < 0) return t;

  // 實際的推進邏輯放在 src/smc/manage.js，與回測共用同一份程式碼 ——
  // 這樣「回測看到的改善」跟「上線後的行為」保證是同一套規則。
  for (let i = from; i < candles.length; i++) {
    if (stepTrade(t, candles[i], opts)) break;
  }
  return t;
}

/** 統計績效。expired（未進場）不計入勝率，只單獨列出 */
export function computeStats(closed) {
  // 只有「從未成交」的限價單不計入勝率（那不是一筆交易）；
  // 成交後才逾時出場的有真實損益，必須算進去。
  const unfilled = (t) => t.status === 'expired' && t.exitReason !== 'maxHold' && !t.filledTime;
  const traded = closed.filter((t) => !unfilled(t));
  const expired = closed.filter(unfilled);
  if (!traded.length) {
    return { count: 0, expired: expired.length, wins: 0, losses: 0, winRate: 0, totalR: 0, expectancy: 0, byGrade: [], bySymbol: [] };
  }
  const wins = traded.filter((t) => t.r > 0);
  const losses = traded.filter((t) => t.r <= 0);
  const totalR = traded.reduce((s, t) => s + t.r, 0);
  const grossWin = wins.reduce((s, t) => s + t.r, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.r, 0));

  let equity = 0, peak = 0, maxDd = 0, streak = 0, worst = 0;
  for (const t of traded) {
    equity += t.r;
    peak = Math.max(peak, equity);
    maxDd = Math.max(maxDd, peak - equity);
    if (t.r <= 0) { streak++; worst = Math.max(worst, streak); } else streak = 0;
  }

  return {
    count: traded.length,
    expired: expired.length,
    wins: wins.length,
    losses: losses.length,
    winRate: (wins.length / traded.length) * 100,
    totalR,
    expectancy: totalR / traded.length,
    avgWin: wins.length ? grossWin / wins.length : 0,
    avgLoss: losses.length ? -grossLoss / losses.length : 0,
    profitFactor: grossLoss ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0,
    maxDrawdownR: maxDd,
    maxLossStreak: worst,
    byGrade: groupBy(traded, (t) => t.grade || '—'),
    bySymbol: groupBy(traded, (t) => t.symbol),
    byDir: groupBy(traded, (t) => t.dir),
  };
}

function groupBy(list, keyFn) {
  const map = new Map();
  for (const t of list) {
    const k = keyFn(t);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(t);
  }
  return [...map.entries()]
    .map(([key, items]) => ({
      key,
      count: items.length,
      winRate: (items.filter((t) => t.r > 0).length / items.length) * 100,
      avgR: items.reduce((s, t) => s + t.r, 0) / items.length,
      totalR: items.reduce((s, t) => s + t.r, 0),
    }))
    .sort((a, b) => b.totalR - a.totalR);
}

/** 由分析結果建立一筆待追蹤的模擬單 */
export function tradeFromSetup({ id, symbol, interval, setup, candleTime, grade, score, management = {} }) {
  return {
    id,
    symbol,
    interval,
    dir: setup.dir,
    entry: setup.entry,
    stop: setup.stop,
    initialStop: setup.stop,
    targets: buildLadder(
      setup.entry,
      setup.stop,
      setup.targets.map((t) => ({ name: t.name, price: t.price, rr: t.rr, label: t.label })),
      management,
    ),
    grade: grade ?? setup.grade,
    score: score ?? setup.score,
    poiType: setup.poi?.type,
    status: setup.entryType === 'market' ? 'active' : 'pending',
    filledTime: setup.entryType === 'market' ? candleTime : null,
    openTime: candleTime,
    lastCheckedTime: candleTime,
    barsSinceOpen: 0,
    barsSinceFill: 0,
    hitTargets: [],
    remaining: 1,
    realizedR: 0,
    maxFavorableR: 0,
    maxAdverseR: 0,
  };
}
