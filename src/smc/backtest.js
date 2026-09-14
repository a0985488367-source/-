/**
 * 訊號回測（Signal Backtest）
 *
 * 以「逐步重算」的方式驗證本引擎產生的計畫在歷史上的表現：
 *  - 每隔 step 根 K 棒，用當下可見的資料重新分析（避免未來函數）
 *  - 若產生有效計畫：市價單立即成交；限價單則等待價格回到進場區（最多 entryWindow 根）
 *  - 成交後模擬價格先碰 TP1 還是先碰 SL
 *  - 統計勝率、平均 R、期望值、最大連敗
 *
 * 注意：這是「訊號品質檢驗」而非完整策略回測，不含手續費滑價與部位管理。
 */

import { analyze } from './engine.js';

/**
 * @param {any[]} candles
 * @param {object} opts
 * @param {(p:{done:number,total:number})=>void} [onProgress]
 */
export async function backtest(candles, opts = {}, onProgress) {
  const {
    warmup = 260,
    step = 5,
    horizon = 90,
    minScore = 55,
    entryWindow = 24,
    settings = {},
    chunkSize = 12,
  } = opts;

  const trades = [];
  const starts = [];
  for (let i = warmup; i < candles.length - 5; i += step) starts.push(i);

  let processed = 0;
  let lastExitIndex = -1;

  for (let c = 0; c < starts.length; c += chunkSize) {
    const slice = starts.slice(c, c + chunkSize);
    for (const i of slice) {
      processed++;
      if (i <= lastExitIndex) continue; // 同一時間只持有一筆，避免重複計數
      const visible = candles.slice(Math.max(0, i - 600), i + 1);
      const res = analyze(visible, settings);
      const setup = res.setup;
      if (!setup || setup.none || !setup.valid || setup.score < minScore) continue;

      const dir = setup.dir;
      const entry = setup.entry;
      const stop = setup.stop;
      const tp = setup.targets[0]?.price;
      if (!tp) continue;

      // 限價單：等待價格回到進場區（最多 entryWindow 根）。沒等到就不算一筆交易。
      let entryIndex = i;
      if (setup.entryType !== 'market') {
        entryIndex = null;
        for (let j = i + 1; j <= Math.min(candles.length - 1, i + entryWindow); j++) {
          const k = candles[j];
          const filled = dir === 'long' ? k.low <= entry : k.high >= entry;
          // 進場前就先反向跑掉（劇本失效）→ 放棄
          const invalidated = dir === 'long' ? k.close < stop : k.close > stop;
          if (filled) { entryIndex = j; break; }
          if (invalidated) break;
        }
        if (entryIndex == null) continue;
      }

      let outcome = null;
      let exitIndex = null;
      for (let j = entryIndex + 1; j <= Math.min(candles.length - 1, entryIndex + horizon); j++) {
        const k = candles[j];
        const hitStop = dir === 'long' ? k.low <= stop : k.high >= stop;
        const hitTp = dir === 'long' ? k.high >= tp : k.low <= tp;
        if (hitStop) { outcome = 'stop'; exitIndex = j; break; } // 同根同時觸及時保守假設先停損
        if (hitTp) { outcome = 'target'; exitIndex = j; break; }
      }
      if (!outcome) { outcome = 'timeout'; exitIndex = Math.min(candles.length - 1, entryIndex + horizon); }
      const risk = Math.abs(entry - stop) || 1;
      const exitPrice = outcome === 'target' ? tp : outcome === 'stop' ? stop : candles[exitIndex].close;
      const r = (dir === 'long' ? exitPrice - entry : entry - exitPrice) / risk;
      lastExitIndex = exitIndex;
      trades.push({
        index: i,
        entryIndex,
        time: candles[entryIndex].time,
        dir,
        entryType: setup.entryType,
        entry,
        stop,
        target: tp,
        outcome,
        r,
        score: setup.score,
        grade: setup.grade,
        exitIndex,
        exitTime: candles[exitIndex].time,
        bars: exitIndex - entryIndex,
      });
    }
    if (onProgress) onProgress({ done: processed, total: starts.length });
    await new Promise((r) => setTimeout(r, 0)); // 讓出主執行緒，保持 UI 流暢
  }

  return { trades, stats: summarize(trades) };
}

export function summarize(trades) {
  const n = trades.length;
  if (!n) return { count: 0 };
  const wins = trades.filter((t) => t.r > 0);
  const losses = trades.filter((t) => t.r <= 0);
  const totalR = trades.reduce((s, t) => s + t.r, 0);
  const grossWin = wins.reduce((s, t) => s + t.r, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.r, 0));
  let equity = 0;
  let peak = 0;
  let maxDd = 0;
  let streak = 0;
  let worstStreak = 0;
  const curve = [];
  for (const t of trades) {
    equity += t.r;
    curve.push({ time: t.exitTime, equity });
    peak = Math.max(peak, equity);
    maxDd = Math.max(maxDd, peak - equity);
    if (t.r <= 0) { streak++; worstStreak = Math.max(worstStreak, streak); }
    else streak = 0;
  }
  return {
    count: n,
    wins: wins.length,
    losses: losses.length,
    winRate: (wins.length / n) * 100,
    totalR,
    expectancy: totalR / n,
    avgWin: wins.length ? grossWin / wins.length : 0,
    avgLoss: losses.length ? -grossLoss / losses.length : 0,
    profitFactor: grossLoss ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0,
    maxDrawdownR: maxDd,
    maxLossStreak: worstStreak,
    avgBars: trades.reduce((s, t) => s + t.bars, 0) / n,
    curve,
    byGrade: groupBy(trades, (t) => t.grade),
    byDir: groupBy(trades, (t) => t.dir),
  };
}

function groupBy(trades, fn) {
  const map = new Map();
  for (const t of trades) {
    const k = fn(t);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(t);
  }
  return [...map.entries()]
    .map(([k, list]) => ({
      key: k,
      count: list.length,
      winRate: (list.filter((t) => t.r > 0).length / list.length) * 100,
      avgR: list.reduce((s, t) => s + t.r, 0) / list.length,
    }))
    .sort((a, b) => b.count - a.count);
}
