/**
 * 公允價值缺口（Fair Value Gap, FVG）／不平衡（Imbalance）
 *
 *  - Bullish FVG : low[i] > high[i-2]，中間那根為位移 K 棒 → 下方留下未成交區。
 *  - Bearish FVG : high[i] < low[i-2]。
 *  - IFVG (Inverse FVG) : FVG 被完全穿越並收盤於另一側後，角色反轉成反向的關鍵區。
 *  - Volume Imbalance   : 實體之間有缺口但影線重疊（較小級別的不平衡）。
 *
 * 每個缺口都會追蹤「填補率（fill%）」與狀態（fresh / partial / filled / inverted）。
 */

import { atr } from '../core/indicators.js';

export function detectFVG(candles, opts = {}) {
  const {
    minSizeAtr = 0.12,   // 過濾雜訊：缺口至少要有 ATR 的幾倍
    maxAgeBars = 600,
    includeVolumeImbalance = true,
  } = opts;
  const a = atr(candles, 14);
  const out = [];

  for (let i = 2; i < candles.length; i++) {
    const c0 = candles[i - 2];
    const c1 = candles[i - 1];
    const c2 = candles[i];
    if (candles.length - i > maxAgeBars) continue;
    const ref = a[i] || (c2.high - c2.low) || 1;

    if (c2.low > c0.high) {
      const size = c2.low - c0.high;
      if (size / ref >= minSizeAtr) {
        out.push(makeGap('fvg', 'bull', i, c0.high, c2.low, candles, { ref, driver: c1 }));
      }
    } else if (c2.high < c0.low) {
      const size = c0.low - c2.high;
      if (size / ref >= minSizeAtr) {
        out.push(makeGap('fvg', 'bear', i, c2.high, c0.low, candles, { ref, driver: c1 }));
      }
    } else if (includeVolumeImbalance) {
      // 量能不平衡：前一根收盤與本根開盤之間的空隙（影線仍重疊）
      const prevTopBody = Math.max(c1.open, c1.close);
      const prevBotBody = Math.min(c1.open, c1.close);
      const curTopBody = Math.max(c2.open, c2.close);
      const curBotBody = Math.min(c2.open, c2.close);
      if (curBotBody > prevTopBody && (curBotBody - prevTopBody) / ref >= minSizeAtr * 1.5) {
        out.push(makeGap('vi', 'bull', i, prevTopBody, curBotBody, candles, { ref, driver: c2 }));
      } else if (curTopBody < prevBotBody && (prevBotBody - curTopBody) / ref >= minSizeAtr * 1.5) {
        out.push(makeGap('vi', 'bear', i, curTopBody, prevBotBody, candles, { ref, driver: c2 }));
      }
    }
  }
  return out;
}

function makeGap(kind, dir, index, bottom, top, candles, { ref, driver }) {
  const gap = {
    id: `${kind}-${dir}-${index}`,
    kind,
    dir,
    index,
    time: candles[index].time,
    top,
    bottom,
    mid: (top + bottom) / 2,
    size: top - bottom,
    sizeAtr: (top - bottom) / ref,
    displacement: driver ? Math.abs(driver.close - driver.open) / ref : 0,
    state: 'fresh',
    fill: 0,
    filledIndex: null,
    invertedIndex: null,
  };
  trackFill(gap, candles);
  gap.score = scoreGap(gap, candles);
  return gap;
}

/** 追蹤填補與反轉（IFVG） */
function trackFill(gap, candles) {
  const height = gap.top - gap.bottom || 1;
  for (let i = gap.index + 1; i < candles.length; i++) {
    const c = candles[i];
    if (gap.dir === 'bull') {
      if (c.low < gap.top) {
        const pen = (gap.top - Math.max(gap.bottom, c.low)) / height;
        gap.fill = Math.max(gap.fill, Math.min(1, pen));
        if (gap.state === 'fresh') gap.state = 'partial';
      }
      if (c.close < gap.bottom) {
        gap.state = 'inverted';
        gap.invertedIndex = i;
        gap.fill = 1;
        gap.invertedDir = 'bear';
        break;
      }
      if (gap.fill >= 0.999 && gap.state !== 'inverted') { gap.state = 'filled'; gap.filledIndex ??= i; }
    } else {
      if (c.high > gap.bottom) {
        const pen = (Math.min(gap.top, c.high) - gap.bottom) / height;
        gap.fill = Math.max(gap.fill, Math.min(1, pen));
        if (gap.state === 'fresh') gap.state = 'partial';
      }
      if (c.close > gap.top) {
        gap.state = 'inverted';
        gap.invertedIndex = i;
        gap.fill = 1;
        gap.invertedDir = 'bull';
        break;
      }
      if (gap.fill >= 0.999 && gap.state !== 'inverted') { gap.state = 'filled'; gap.filledIndex ??= i; }
    }
  }
}

function scoreGap(gap, candles) {
  let s = 35;
  s += Math.min(25, gap.sizeAtr * 30);
  s += Math.min(15, gap.displacement * 12);
  if (gap.state === 'fresh') s += 18;
  else if (gap.state === 'partial') s += 8;
  else if (gap.state === 'filled') s -= 20;
  if (gap.kind === 'vi') s -= 10;
  if (gap.state === 'inverted') s += 4;
  s -= Math.min(10, (candles.length - gap.index) / 80);
  return Math.max(0, Math.min(100, Math.round(s)));
}

/**
 * 消耗缺口（Consequent Encroachment, CE）= FVG 的 50% 中線，
 * ICT 常用來作為精準進場價。
 */
export const ce = (gap) => gap.mid;

/** 未填補（可交易）的缺口，依距離現價排序 */
export function activeGaps(gaps, price) {
  return gaps
    .filter((g) => g.state === 'fresh' || g.state === 'partial' || g.state === 'inverted')
    .map((g) => ({ ...g, effectiveDir: g.state === 'inverted' ? g.invertedDir : g.dir }))
    .filter((g) => (g.effectiveDir === 'bull' ? g.bottom <= price * 1.001 : g.top >= price * 0.999))
    .sort((a, b) => Math.abs(a.mid - price) - Math.abs(b.mid - price));
}
