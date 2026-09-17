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

/** 保守假設：同一根 K 棒同時觸及停損與目標時，算停損 */
export function advanceTrade(trade, candles, opts = {}) {
  const { entryWindowBars = 24, maxHoldBars = 200 } = opts;
  const t = { ...trade, hitTargets: [...(trade.hitTargets ?? [])], events: [] };
  if (t.status === 'target' || t.status === 'stop' || t.status === 'expired') return t;

  const long = t.dir === 'long';
  const risk = Math.abs(t.entry - t.stop) || 1;
  const from = candles.findIndex((c) => c.time > (t.lastCheckedTime ?? t.openTime));
  if (from < 0) return t;

  for (let i = from; i < candles.length; i++) {
    const c = candles[i];
    t.lastCheckedTime = c.time;
    t.barsSinceOpen = (t.barsSinceOpen ?? 0) + 1;

    if (t.status === 'pending') {
      const filled = long ? c.low <= t.entry : c.high >= t.entry;
      if (filled) {
        t.status = 'active';
        t.filledTime = c.time;
        t.barsSinceFill = 0;
        t.events.push({ type: 'filled', time: c.time, price: t.entry });
      } else {
        // 等太久都沒被碰到 → 作廢。
        // （不需要另外判斷「跌破停損」：停損必在進場價的另一側，
        //   價格要到停損一定先經過進場價，也就一定會先成交。）
        if (t.barsSinceOpen > entryWindowBars) {
          t.status = 'expired';
          t.closedTime = c.time;
          t.exitPrice = c.close;
          t.r = 0;
          t.events.push({ type: 'expired', time: c.time, reason: 'timeout' });
          return t;
        }
        continue;
      }
    }

    if (t.status !== 'active') continue;
    t.barsSinceFill = (t.barsSinceFill ?? 0) + 1;

    // 記錄最大有利／不利幅度（用來評估「有沒有先到過某個 R 再被打掉」）
    const favorable = long ? (c.high - t.entry) / risk : (t.entry - c.low) / risk;
    const adverse = long ? (c.low - t.entry) / risk : (t.entry - c.high) / risk;
    t.maxFavorableR = Math.max(t.maxFavorableR ?? 0, favorable);
    t.maxAdverseR = Math.min(t.maxAdverseR ?? 0, adverse);

    const hitStop = long ? c.low <= t.stop : c.high >= t.stop;
    if (hitStop) {
      t.status = 'stop';
      t.closedTime = c.time;
      t.exitPrice = t.stop;
      t.r = t.hitTargets.length ? partialR(t) : -1;
      t.events.push({ type: 'stop', time: c.time, price: t.stop });
      return t;
    }

    for (const tp of t.targets) {
      if (t.hitTargets.includes(tp.name)) continue;
      const hit = long ? c.high >= tp.price : c.low <= tp.price;
      if (!hit) continue;
      t.hitTargets.push(tp.name);
      t.events.push({ type: 'target', name: tp.name, time: c.time, price: tp.price, rr: tp.rr });
      // 打到第一個目標後把停損移到成本價（模擬「保本」的常見做法）
      if (t.hitTargets.length === 1) {
        t.stop = t.entry;
        t.events.push({ type: 'breakeven', time: c.time, price: t.entry });
      }
      if (t.hitTargets.length === t.targets.length) {
        t.status = 'target';
        t.closedTime = c.time;
        t.exitPrice = tp.price;
        t.r = tp.rr;
        return t;
      }
    }

    if (t.barsSinceFill > maxHoldBars) {
      t.status = 'expired';
      t.closedTime = c.time;
      t.exitPrice = c.close;
      t.r = (long ? c.close - t.entry : t.entry - c.close) / risk;
      t.events.push({ type: 'expired', time: c.time, reason: 'maxHold' });
      return t;
    }
  }
  return t;
}

/** 已經打到部分目標後才被停損（停損已移到成本價）→ 以最後達成的目標計 R */
function partialR(t) {
  const last = t.targets.find((x) => x.name === t.hitTargets[t.hitTargets.length - 1]);
  return last ? last.rr * 0.5 : 0; // 保守：只認一半，因為實際會分批出場
}

/** 統計績效。expired（未進場）不計入勝率，只單獨列出 */
export function computeStats(closed) {
  const traded = closed.filter((t) => t.status === 'target' || t.status === 'stop');
  const expired = closed.filter((t) => t.status === 'expired');
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
export function tradeFromSetup({ id, symbol, interval, setup, candleTime, grade, score }) {
  return {
    id,
    symbol,
    interval,
    dir: setup.dir,
    entry: setup.entry,
    stop: setup.stop,
    targets: setup.targets.map((t) => ({ name: t.name, price: t.price, rr: t.rr, label: t.label })),
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
    maxFavorableR: 0,
    maxAdverseR: 0,
  };
}
