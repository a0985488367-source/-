/**
 * 訂單塊（Order Block）／破壞塊（Breaker Block）／減壓塊（Mitigation Block）
 *
 * 定義：
 *  - Order Block : 造成結構突破（BOS/CHoCH）之前的「最後一根反向 K 棒」，
 *                  代表機構在此累積訂單，價格回測時常見反應。
 *  - Breaker     : 失效的 OB（價格收盤穿越），角色反轉 → 支撐變壓力（或相反）。
 *  - Mitigation  : 已被部分回測（Tapped）但尚未失效的 OB。
 *
 * 品質評分（0–100）考量：位移強度、量能、是否內含 FVG、是否掃過流動性、新鮮度。
 */

import { atr, relativeVolume } from '../core/indicators.js';

/**
 * @param {any[]} candles
 * @param {any[]} events 來自 structure.analyzeStructure 的事件
 * @param {object} opts
 */
export function detectOrderBlocks(candles, events, opts = {}) {
  const {
    zoneMode = 'wick',        // 'wick' = 高低點；'body' = 實體
    minDisplacementAtr = 1.0, // 突破腿至少要有幾倍 ATR 的位移
    maxAgeBars = 600,
    fvgList = [],
    sweeps = [],
  } = opts;

  const a = atr(candles, 14);
  const rvol = relativeVolume(candles, 20);
  const blocks = [];

  for (const ev of events) {
    const isBull = ev.dir === 'bull';
    const legStart = isBull
      ? lowestIndex(candles, ev.fromIndex, ev.breakIndex)
      : highestIndex(candles, ev.fromIndex, ev.breakIndex);
    if (legStart == null) continue;

    let obIndex = null;
    for (let i = ev.breakIndex; i >= Math.max(0, legStart - 3); i--) {
      const c = candles[i];
      if (isBull && c.close < c.open) { obIndex = i; break; }
      if (!isBull && c.close > c.open) { obIndex = i; break; }
    }
    if (obIndex == null) obIndex = legStart;

    const ob = candles[obIndex];
    const legRange = isBull
      ? candles[ev.breakIndex].high - candles[legStart].low
      : candles[legStart].high - candles[ev.breakIndex].low;
    const atrRef = a[ev.breakIndex] || a[obIndex] || legRange / 4 || 1;
    const displacementAtr = legRange / atrRef;
    if (displacementAtr < minDisplacementAtr) continue;
    if (candles.length - obIndex > maxAgeBars) continue;

    const top = zoneMode === 'body' ? Math.max(ob.open, ob.close) : ob.high;
    const bottom = zoneMode === 'body' ? Math.min(ob.open, ob.close) : ob.low;
    if (!(top > bottom)) continue;

    const id = `ob-${ev.scale}-${ev.dir}-${obIndex}`;
    if (blocks.some((b) => b.id === id)) continue;

    const containsFvg = fvgList.some(
      (f) => f.dir === (isBull ? 'bull' : 'bear') && f.index >= obIndex && f.index <= obIndex + 3,
    );
    const sweptBefore = sweeps.some(
      (s) => Math.abs(s.index - obIndex) <= 5 && s.dir === (isBull ? 'bull' : 'bear'),
    );

    const block = {
      id,
      kind: 'orderblock',
      dir: isBull ? 'bull' : 'bear',
      scale: ev.scale,
      index: obIndex,
      time: ob.time,
      top,
      bottom,
      mid: (top + bottom) / 2,
      causedBy: ev.type,
      breakIndex: ev.breakIndex,
      displacementAtr,
      rvol: rvol[obIndex] || 1,
      containsFvg,
      sweptBefore,
      state: 'fresh',
      touches: 0,
      mitigationPct: 0,
      firstTouchIndex: null,
      brokenIndex: null,
    };
    evaluateLifecycle(block, candles);
    block.score = scoreBlock(block, candles);
    blocks.push(block);
  }

  // 移除被更新、更靠近價格且同向且重疊的舊 OB（保留較新者），避免圖面雜訊
  return dedupeZones(blocks);
}

/** 追蹤 OB 生命週期：fresh → tapped → mitigated → breaker */
function evaluateLifecycle(block, candles) {
  const isBull = block.dir === 'bull';
  const height = block.top - block.bottom || 1;
  for (let i = block.breakIndex + 1; i < candles.length; i++) {
    const c = candles[i];
    const touched = isBull ? c.low <= block.top : c.high >= block.bottom;
    if (touched) {
      block.touches += 1;
      if (block.firstTouchIndex == null) block.firstTouchIndex = i;
      const pen = isBull
        ? (block.top - Math.max(block.bottom, c.low)) / height
        : (Math.min(block.top, c.high) - block.bottom) / height;
      block.mitigationPct = Math.max(block.mitigationPct, Math.min(1, pen));
      if (block.state === 'fresh') block.state = 'tapped';
    }
    const broken = isBull ? c.close < block.bottom : c.close > block.top;
    if (broken) {
      block.state = 'breaker';
      block.brokenIndex = i;
      block.breakerDir = isBull ? 'bear' : 'bull';
      break;
    }
    if (block.mitigationPct >= 0.98 && block.state !== 'breaker') block.state = 'mitigated';
  }
}

function scoreBlock(block, candles) {
  let s = 40;
  s += Math.min(25, block.displacementAtr * 8);           // 位移越強越可信
  s += Math.min(12, ((block.rvol || 1) - 1) * 12);        // 量能放大
  if (block.containsFvg) s += 12;                          // 內含 FVG → 高機率 OB
  if (block.sweptBefore) s += 10;                          // 形成前掃過流動性
  if (block.causedBy === 'CHoCH') s += 6;                  // 反轉級別權重
  if (block.scale === 'swing') s += 6;                     // 高級別結構
  if (block.state === 'fresh') s += 8;
  if (block.state === 'tapped') s += 2;
  if (block.state === 'mitigated') s -= 15;
  if (block.state === 'breaker') s -= 8;
  const age = candles.length - block.index;
  s -= Math.min(12, age / 60);                             // 越舊越衰減
  return Math.max(0, Math.min(100, Math.round(s)));
}

/** 同方向且重疊度 > 60% 的區塊只保留分數較高者 */
export function dedupeZones(zones) {
  const out = [];
  for (const z of [...zones].sort((x, y) => y.index - x.index)) {
    const dup = out.find((o) => o.dir === z.dir && overlapRatio(o, z) > 0.6);
    if (!dup) out.push(z);
    else if ((z.score || 0) > (dup.score || 0)) Object.assign(dup, z);
  }
  return out.sort((a, b) => a.index - b.index);
}

function overlapRatio(a, b) {
  const lo = Math.max(a.bottom, b.bottom);
  const hi = Math.min(a.top, b.top);
  if (hi <= lo) return 0;
  const inter = hi - lo;
  return inter / Math.min(a.top - a.bottom, b.top - b.bottom);
}

function lowestIndex(candles, a, b) {
  let idx = null;
  for (let i = Math.max(0, a); i <= Math.min(candles.length - 1, b); i++) {
    if (idx == null || candles[i].low < candles[idx].low) idx = i;
  }
  return idx;
}

function highestIndex(candles, a, b) {
  let idx = null;
  for (let i = Math.max(0, a); i <= Math.min(candles.length - 1, b); i++) {
    if (idx == null || candles[i].high > candles[idx].high) idx = i;
  }
  return idx;
}

/**
 * 取出「可用的興趣點（POI）」：尚未失效、且仍位於價格可回測方向的 OB。
 * @param {any[]} blocks
 * @param {number} price
 */
export function activeOrderBlocks(blocks, price) {
  return blocks
    .filter((b) => b.state !== 'mitigated')
    .map((b) => {
      const isBreaker = b.state === 'breaker';
      const dir = isBreaker ? b.breakerDir : b.dir;
      return { ...b, effectiveDir: dir };
    })
    .filter((b) => (b.effectiveDir === 'bull' ? b.bottom <= price : b.top >= price))
    .sort((a, b) => Math.abs(a.mid - price) - Math.abs(b.mid - price));
}
