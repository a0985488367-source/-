/**
 * 市場結構（Market Structure）：BOS / CHoCH / 強弱高低點
 *
 * 定義（本專案採用的嚴謹版本）：
 *  - BOS  (Break of Structure)     : 沿著「既有趨勢方向」突破前一個擺動點 → 趨勢延續。
 *  - CHoCH(Change of Character)    : 逆著「既有趨勢方向」突破前一個擺動點 → 趨勢可能反轉，
 *                                    也是 SMC 中最重要的反轉訊號。
 *  - Strong High / Low             : 造成 BOS 的那個擺動點（機構防守，不易被破）。
 *  - Weak High / Low               : 被推開、尚未取得流動性的擺動點（後續容易被掃）。
 *
 * 突破判定可選 close（收盤價，較嚴謹）或 wick（影線，較敏感）。
 */

import { detectSwings, alternateSwings } from './swings.js';

/** @typedef {import('./swings.js').Swing} Swing */

/**
 * @param {import('./swings.js').Swing[]} rawSwings
 * @param {any[]} candles
 * @param {{strength:number, breakBy?:'close'|'wick', scale?:'internal'|'swing'}} opts
 */
export function analyzeStructure(candles, opts = {}) {
  const { strength = 3, breakBy = 'close', scale = 'swing' } = opts;
  const swings = alternateSwings(detectSwings(candles, strength));

  /** 依「確認 index」分組，模擬實時：擺動點要 strength 根之後才成立 */
  const byConfirm = new Map();
  for (const s of swings) {
    const ci = s.index + strength;
    if (!byConfirm.has(ci)) byConfirm.set(ci, []);
    byConfirm.get(ci).push(s);
  }

  /** @type {any[]} */
  const events = [];
  let trend = 0; // 1 = bull, -1 = bear, 0 = 未定
  let pendingHigh = null;
  let pendingLow = null;
  let strongLow = null;
  let strongHigh = null;

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const confirmed = byConfirm.get(i);
    if (confirmed) {
      for (const s of confirmed) {
        if (s.type === 'high') {
          if (!pendingHigh || s.index > pendingHigh.index) pendingHigh = s;
        } else if (!pendingLow || s.index > pendingLow.index) {
          pendingLow = s;
        }
      }
    }

    const upLevel = breakBy === 'close' ? c.close : c.high;
    const downLevel = breakBy === 'close' ? c.close : c.low;

    if (pendingHigh && upLevel > pendingHigh.price) {
      const type = trend === -1 ? 'CHoCH' : 'BOS';
      events.push({
        id: `${scale}-${type}-${i}`,
        scale,
        type,
        dir: 'bull',
        price: pendingHigh.price,
        fromIndex: pendingHigh.index,
        fromTime: pendingHigh.time,
        breakIndex: i,
        breakTime: c.time,
        swept: pendingHigh,
      });
      trend = 1;
      strongLow = lowestBetween(candles, pendingHigh.index, i);
      strongHigh = null;
      pendingLow = strongLow
        ? { index: strongLow.index, time: candles[strongLow.index].time, price: strongLow.price, type: 'low' }
        : pendingLow;
      pendingHigh = null;
    } else if (pendingLow && downLevel < pendingLow.price) {
      const type = trend === 1 ? 'CHoCH' : 'BOS';
      events.push({
        id: `${scale}-${type}-${i}`,
        scale,
        type,
        dir: 'bear',
        price: pendingLow.price,
        fromIndex: pendingLow.index,
        fromTime: pendingLow.time,
        breakIndex: i,
        breakTime: c.time,
        swept: pendingLow,
      });
      trend = -1;
      strongHigh = highestBetween(candles, pendingLow.index, i);
      strongLow = null;
      pendingHigh = strongHigh
        ? { index: strongHigh.index, time: candles[strongHigh.index].time, price: strongHigh.price, type: 'high' }
        : pendingHigh;
      pendingLow = null;
    }
  }

  return {
    scale,
    strength,
    swings,
    events,
    trend,
    trendLabel: trend === 1 ? 'bullish' : trend === -1 ? 'bearish' : 'ranging',
    lastEvent: events[events.length - 1] || null,
    protectedHigh: strongHigh ? { price: strongHigh.price, index: strongHigh.index, kind: 'strong' } : (pendingHigh ? { price: pendingHigh.price, index: pendingHigh.index, kind: 'weak' } : null),
    protectedLow: strongLow ? { price: strongLow.price, index: strongLow.index, kind: 'strong' } : (pendingLow ? { price: pendingLow.price, index: pendingLow.index, kind: 'weak' } : null),
    pendingHigh,
    pendingLow,
  };
}

function lowestBetween(candles, a, b) {
  let best = null;
  for (let i = Math.max(0, a); i <= Math.min(candles.length - 1, b); i++) {
    if (!best || candles[i].low < best.price) best = { index: i, price: candles[i].low };
  }
  return best;
}

function highestBetween(candles, a, b) {
  let best = null;
  for (let i = Math.max(0, a); i <= Math.min(candles.length - 1, b); i++) {
    if (!best || candles[i].high > best.price) best = { index: i, price: candles[i].high };
  }
  return best;
}

/**
 * 雙尺度結構：同時計算「內部結構（Internal）」與「擺動結構（Swing）」。
 * SMC 的標準操作：以 Swing 結構定方向，以 Internal 結構找進場。
 */
export function dualStructure(candles, { internalStrength = 2, swingStrength = 7, breakBy = 'close' } = {}) {
  return {
    internal: analyzeStructure(candles, { strength: internalStrength, breakBy, scale: 'internal' }),
    swing: analyzeStructure(candles, { strength: swingStrength, breakBy, scale: 'swing' }),
  };
}

/** 最近 n 筆結構事件（新到舊） */
export function recentEvents(structure, n = 6) {
  return [...structure.events].slice(-n).reverse();
}
