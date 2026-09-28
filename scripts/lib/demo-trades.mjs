/**
 * 把 Bybit 成交明細（Executor GET /history 的 executions）還原成一筆一筆的交易，再依策略統計。
 *
 * 還原方式：同一個幣照時間逐筆累加部位（買＋、賣－），部位從 0 開始的那一筆是「開倉」，
 * 回到 0 就是「平倉」；損益＝每次減倉的（成交價 − 平均成本）× 數量，再扣掉這筆交易所有的手續費。
 * 策略看開倉那筆的 orderLinkId（下單時的 signal_id）：
 *   bo:… 突破、ema:… EMA 交叉、macd:… MACD 零軸、fo:… 假突破反手、vb:… 放量突破、st:… 超級趨勢、
 *   gc:… 黃金交叉、其他非空的是 SMC（幣名大寫開頭）、空的是手動或不明。
 * 查詢區間開始前就已經開著的部位（第一筆就是減倉）會略過，只算完整開平的交易。
 */

export function strategyOf(orderLinkId) {
  const id = String(orderLinkId ?? '');
  if (id.startsWith('bo:')) return 'breakout';
  if (id.startsWith('ema:')) return 'ema';
  if (id.startsWith('macd:')) return 'macd';
  if (id.startsWith('fo:')) return 'fakeout';
  if (id.startsWith('vb:')) return 'vol';
  if (id.startsWith('st:')) return 'st';
  if (id.startsWith('gc:')) return 'gc';
  if (id) return 'smc';
  return 'manual';
}

export const STRATEGY_NAMES = {
  smc: 'SMC', breakout: '突破', ema: 'EMA 交叉', macd: 'MACD 零軸', fakeout: '假突破反手',
  vol: '放量突破', st: '超級趨勢', gc: '黃金交叉', manual: '手動／不明',
};

export function rebuildTrades(executions) {
  const fills = executions
    .filter((e) => (e.execType ?? 'Trade') === 'Trade' && Number(e.execQty) > 0)
    .sort((a, b) => a.execTime - b.execTime);
  const open = new Map();
  const trades = [];
  for (const f of fills) {
    const qty = Number(f.execQty) * (f.side === 'Buy' ? 1 : -1);
    const price = Number(f.execPrice);
    const fee = Number(f.execFee) || 0;
    let t = open.get(f.symbol);
    if (!t) {
      // 區間開始前就開著的部位：第一筆就是減倉，沒辦法算完整損益，略過
      if (Number(f.closedSize) > 0) continue;
      t = {
        symbol: f.symbol, dir: qty > 0 ? 'long' : 'short', strategy: strategyOf(f.orderLinkId),
        orderLinkId: f.orderLinkId ?? '', openTime: f.execTime, size: 0, avg: 0, gross: 0, fees: 0, maxSize: 0,
      };
      open.set(f.symbol, t);
    }
    t.fees += fee;
    const sameDir = t.size === 0 || Math.sign(qty) === Math.sign(t.size);
    if (sameDir) {
      const newSize = t.size + qty;
      t.avg = (t.avg * Math.abs(t.size) + price * Math.abs(qty)) / Math.abs(newSize);
      t.size = newSize;
      t.maxSize = Math.max(t.maxSize, Math.abs(t.size));
      continue;
    }
    const closeQty = Math.min(Math.abs(qty), Math.abs(t.size));
    t.gross += (price - t.avg) * closeQty * Math.sign(t.size);
    t.size += Math.sign(qty) * closeQty;
    if (Math.abs(t.size) <= t.maxSize * 1e-9) {
      t.closeTime = f.execTime;
      t.exitPrice = price;
      t.pnl = t.gross - t.fees;
      trades.push(t);
      open.delete(f.symbol);
      // 一筆成交直接反手（很少見）：剩下的數量當新的一筆開倉
      const rest = Math.abs(qty) - closeQty;
      if (rest > 0) {
        open.set(f.symbol, {
          symbol: f.symbol, dir: qty > 0 ? 'long' : 'short', strategy: 'manual', orderLinkId: '',
          openTime: f.execTime, size: Math.sign(qty) * rest, avg: price, gross: 0, fees: 0, maxSize: rest,
        });
      }
    }
  }
  return { trades, stillOpen: [...open.values()] };
}

export function summarize(trades) {
  const n = trades.length;
  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl <= 0);
  const sum = (xs) => xs.reduce((a, t) => a + t.pnl, 0);
  let streak = 0, worstStreak = 0;
  for (const t of [...trades].sort((a, b) => a.closeTime - b.closeTime)) {
    if (t.pnl <= 0) { streak++; worstStreak = Math.max(worstStreak, streak); } else streak = 0;
  }
  const grossWin = sum(wins), grossLoss = -sum(losses);
  return {
    n,
    winRate: n ? wins.length / n : 0,
    net: sum(trades),
    avgWin: wins.length ? grossWin / wins.length : 0,
    avgLoss: losses.length ? -grossLoss / losses.length : 0,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : null,
    fees: trades.reduce((a, t) => a + t.fees, 0),
    worstTrade: n ? Math.min(...trades.map((t) => t.pnl)) : 0,
    bestTrade: n ? Math.max(...trades.map((t) => t.pnl)) : 0,
    worstStreak,
  };
}
