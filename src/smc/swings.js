/**
 * 擺動點偵測（Swing / Fractal Pivots）
 * SMC 的一切都建立在「結構點」上：沒有正確的擺動高低點，就沒有正確的 BOS / CHoCH。
 *
 * 本模組提供：
 *  - detectSwings()      : n 根對稱分形法找出未來已確認的擺動點
 *  - alternateSwings()   : 強制高低交替（同向相鄰時保留更極端者），避免結構雜訊
 *  - labelSwings()       : 標記 HH / HL / LH / LL
 */

/** @typedef {{time:number,open:number,high:number,low:number,close:number,volume:number}} Candle */
/** @typedef {{index:number,time:number,price:number,type:'high'|'low',label?:string,confirmedAt?:number}} Swing */

/**
 * @param {Candle[]} candles
 * @param {number} strength 左右各需比較的 K 棒數（越大 = 越高級別的結構）
 * @returns {Swing[]} 依時間排序
 */
export function detectSwings(candles, strength = 3) {
  const swings = [];
  if (candles.length < strength * 2 + 1) return swings;
  for (let i = strength; i < candles.length - strength; i++) {
    const c = candles[i];
    let isHigh = true;
    let isLow = true;
    for (let j = 1; j <= strength; j++) {
      const l = candles[i - j];
      const r = candles[i + j];
      // 左側嚴格、右側容許等值 → 避免雙頂時抓不到點
      if (l.high >= c.high || r.high > c.high) isHigh = false;
      if (l.low <= c.low || r.low < c.low) isLow = false;
      if (!isHigh && !isLow) break;
    }
    if (isHigh) {
      swings.push({ index: i, time: c.time, price: c.high, type: 'high', confirmedAt: candles[i + strength].time });
    }
    if (isLow) {
      swings.push({ index: i, time: c.time, price: c.low, type: 'low', confirmedAt: candles[i + strength].time });
    }
  }
  swings.sort((a, b) => a.index - b.index || (a.type === 'low' ? -1 : 1));
  return swings;
}

/**
 * 高低交替化：相鄰同型別的擺動點只保留最極端者。
 * 這一步是 SMC 結構分析的關鍵前處理（LuxAlgo / ICT 皆採用類似邏輯）。
 * @param {Swing[]} swings
 * @returns {Swing[]}
 */
export function alternateSwings(swings) {
  const out = [];
  for (const s of swings) {
    const prev = out[out.length - 1];
    if (!prev) { out.push({ ...s }); continue; }
    if (prev.type === s.type) {
      const keepNew = s.type === 'high' ? s.price >= prev.price : s.price <= prev.price;
      if (keepNew) out[out.length - 1] = { ...s };
    } else {
      out.push({ ...s });
    }
  }
  return out;
}

/**
 * 標記 HH / HL / LH / LL（Higher High…），用於快速閱讀趨勢。
 * @param {Swing[]} swings
 */
export function labelSwings(swings) {
  let lastHigh = null;
  let lastLow = null;
  return swings.map((s) => {
    let label = '';
    if (s.type === 'high') {
      if (lastHigh != null) label = s.price > lastHigh ? 'HH' : 'LH';
      lastHigh = s.price;
    } else {
      if (lastLow != null) label = s.price < lastLow ? 'LL' : 'HL';
      lastLow = s.price;
    }
    return { ...s, label };
  });
}

/** 取得結構化的擺動點（偵測 → 交替 → 標記） */
export function structuredSwings(candles, strength = 3) {
  return labelSwings(alternateSwings(detectSwings(candles, strength)));
}

/** 最後一個指定型別的擺動點 */
export function lastSwing(swings, type) {
  for (let i = swings.length - 1; i >= 0; i--) if (swings[i].type === type) return swings[i];
  return null;
}

/**
 * 交易區間（Dealing Range）：由最近一組「已確認的擺動高 + 擺動低」構成，
 * 是判斷溢價（Premium）／折價（Discount）的基準。
 */
export function dealingRange(swings, candles = null) {
  const high = lastSwing(swings, 'high');
  const low = lastSwing(swings, 'low');
  if (!high || !low) return null;
  let hi = high.price;
  let lo = low.price;
  let hiIndex = high.index;
  let loIndex = low.index;
  // 價格若已突破舊區間，區間隨之延伸到新的極值（否則折溢價會算出 >100% 的怪數字）
  if (candles) {
    for (let i = Math.max(high.index, low.index); i < candles.length; i++) {
      if (candles[i].high > hi) { hi = candles[i].high; hiIndex = i; }
      if (candles[i].low < lo) { lo = candles[i].low; loIndex = i; }
    }
  }
  return {
    high: hi,
    low: lo,
    highIndex: hiIndex,
    lowIndex: loIndex,
    swingHigh: high.price,
    swingLow: low.price,
    equilibrium: (hi + lo) / 2,
    startIndex: Math.min(high.index, low.index),
    direction: hiIndex > loIndex ? 'up' : 'down',
  };
}
