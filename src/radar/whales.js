/**
 * 大戶動向（2026-10-07 使用者要的「巨鯨機構在哪埋單」）：交易所不公開掛單是誰的，
 * 這裡只用公開資料把「金額特別大」的單抓出來——全部是純函式，coin/ 網頁跟測試共用。
 *
 *   大單牆   掛單簿依價格分格加總，比附近一般水準大很多倍的格子；同一格連續好幾次都在＝比較可能是真的
 *   大額成交 單筆成交金額超過門檻（依幣種成交量自動調整），看大戶在買還是在賣、累積買賣差（CVD）
 *   大戶多空 Binance 大戶持倉多空比 vs 全部帳戶多空比，兩邊方向相反時特別值得注意
 */

/** 大額成交門檻（USDT）：BTC 50 萬、ETH 20 萬，其他依 24h 成交額（約萬分之 2），夾在 1 萬～20 萬 */
export function bigTradeThreshold(symbol, turnover24h) {
  if (/^BTC/.test(symbol)) return 500_000;
  if (/^ETH/.test(symbol)) return 200_000;
  const t = Number(turnover24h) || 0;
  const raw = t * 0.0002;
  const nice = [10_000, 20_000, 30_000, 50_000, 100_000, 150_000, 200_000];
  return nice.reduce((best, v) => (v <= Math.max(raw, nice[0]) ? v : best), nice[0]);
}

/**
 * 掛單簿分格：每格寬 binPct（％），回傳 [{ price（格子中間）, notional（USDT）, qty }]，買單由高到低、賣單由低到高。
 * book: { bids: [[price, qty]...], asks: [[price, qty]...] }
 */
export function binBook(book, price, { binPct = 0.05 } = {}) {
  const step = price * (binPct / 100);
  const bin = (rows, side) => {
    const m = new Map();
    for (const [p, q] of rows) {
      const px = Number(p), qty = Number(q);
      if (!(px > 0 && qty > 0)) continue;
      const k = side === 'bid' ? Math.floor(px / step) : Math.ceil(px / step);
      const cur = m.get(k) ?? { price: k * step, notional: 0, qty: 0, best: px };
      cur.notional += px * qty;
      cur.qty += qty;
      cur.best = side === 'bid' ? Math.max(cur.best, px) : Math.min(cur.best, px);
      m.set(k, cur);
    }
    return [...m.values()].sort((a, b) => (side === 'bid' ? b.price - a.price : a.price - b.price));
  };
  return { bids: bin(book.bids ?? [], 'bid'), asks: bin(book.asks ?? [], 'ask'), step };
}

const median = (xs) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

/**
 * 找大單牆：分格之後，金額 ≥ 該側中位數 × ratio，而且 ≥ minNotional 的格子，各側取最大的 maxPerSide 個。
 * 回傳 [{ side: 'bid'|'ask', price, notional, distPct, times }]
 */
export function detectWalls(book, price, { binPct = 0.05, ratio = 5, minNotional = 0, maxPerSide = 6 } = {}) {
  const { bids, asks } = binBook(book, price, { binPct });
  const pick = (rows, side) => {
    const med = median(rows.map((r) => r.notional));
    return rows
      .filter((r) => r.notional >= med * ratio && r.notional >= minNotional)
      .sort((a, b) => b.notional - a.notional)
      .slice(0, maxPerSide)
      .map((r) => ({ side, price: r.best, notional: r.notional, times: +(r.notional / (med || 1)).toFixed(1), distPct: ((r.best - price) / price) * 100 }));
  };
  return [...pick(bids, 'bid'), ...pick(asks, 'ask')];
}

/**
 * 大單牆持續追蹤：每次抓掛單簿後呼叫，同一側、價格在 tolPct 內的牆視為同一道。
 * 一直都在的牆比較可能是真的；一閃即逝的多半是假掛單（spoofing）。
 * tracker: Map（呼叫端保存），回傳目前還在的牆（附 firstSeen、seenCount、maxNotional）。
 */
export function trackWalls(tracker, walls, now = Date.now(), { tolPct = 0.08, forgetMs = 60_000 } = {}) {
  for (const w of walls) {
    let hit = null;
    for (const t of tracker.values()) {
      if (t.side === w.side && Math.abs((t.price - w.price) / w.price) * 100 <= tolPct) { hit = t; break; }
    }
    if (hit) {
      Object.assign(hit, { price: w.price, notional: w.notional, times: w.times, distPct: w.distPct, lastSeen: now, ex: w.ex ?? hit.ex });
      hit.seenCount += 1;
      hit.maxNotional = Math.max(hit.maxNotional, w.notional);
    } else {
      const id = `${w.side}:${w.price}:${now}`;
      tracker.set(id, { ...w, id, firstSeen: now, lastSeen: now, seenCount: 1, maxNotional: w.notional });
    }
  }
  for (const [id, t] of tracker) if (now - t.lastSeen > forgetMs) tracker.delete(id);
  return [...tracker.values()].filter((t) => t.lastSeen === now);
}

/**
 * 成交統計：trades = [{ time, price, qty, side: 'buy'|'sell'（主動方）, ex }]
 * 回傳門檻以上的大單（新到舊）、各時間窗的大單買賣金額、CVD 序列（全部成交，不只大單）。
 */
export function tradeStats(trades, threshold, now = Date.now(), { windowsMin = [5, 15, 60] } = {}) {
  const xs = [...trades].sort((a, b) => a.time - b.time);
  const big = xs.filter((t) => t.price * t.qty >= threshold).map((t) => ({ ...t, notional: t.price * t.qty }));
  const windows = windowsMin.map((m) => {
    const from = now - m * 60_000;
    const inW = big.filter((t) => t.time >= from);
    const buy = inW.filter((t) => t.side === 'buy').reduce((a, t) => a + t.notional, 0);
    const sell = inW.filter((t) => t.side === 'sell').reduce((a, t) => a + t.notional, 0);
    const all = xs.filter((t) => t.time >= from);
    const allBuy = all.filter((t) => t.side === 'buy').reduce((a, t) => a + t.price * t.qty, 0);
    const allSell = all.filter((t) => t.side === 'sell').reduce((a, t) => a + t.price * t.qty, 0);
    return { minutes: m, bigBuy: buy, bigSell: sell, bigCount: inW.length, buy: allBuy, sell: allSell };
  });
  let cum = 0;
  const cvd = xs.map((t) => { cum += (t.side === 'buy' ? 1 : -1) * t.price * t.qty; return { time: t.time, value: cum }; });
  return { big: big.reverse(), windows, cvd };
}

/** 大戶 vs 全部帳戶多空比的解讀：top / global = [{ time, long, short }]（比例 0～1） */
export function whaleVsCrowd(top, global) {
  if (!top?.length) return null;
  const t = top[top.length - 1];
  const g = global?.length ? global[global.length - 1] : null;
  const t0 = top[0];
  const trend = t.long - t0.long; // 這段期間大戶多單比例變化
  let zh;
  if (g && t.long > 0.55 && g.long < 0.5) zh = '大戶偏多、散戶偏空：大戶跟散戶對作，偏多看待';
  else if (g && t.long < 0.45 && g.long > 0.5) zh = '大戶偏空、散戶偏多：小心大戶往下掃散戶多單';
  else if (t.long > 0.55) zh = '大戶多單比較多';
  else if (t.long < 0.45) zh = '大戶空單比較多';
  else zh = '大戶多空差不多';
  if (Math.abs(trend) >= 0.03) zh += `；最近大戶${trend > 0 ? '在加多' : '在加空'}（多單比例 ${trend > 0 ? '+' : ''}${(trend * 100).toFixed(1)} 個百分點）`;
  return { top: t, global: g, trend, zh };
}
