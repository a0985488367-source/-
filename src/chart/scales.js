/** 座標換算：K 棒索引 ↔ 像素、價格 ↔ 像素 */

export function createScales({ width, height, padding, barsVisible, rightIndex, min, max, logScale = false }) {
  const plotW = width - padding.right;
  const plotH = height - padding.top - padding.bottom;
  const barWidth = plotW / barsVisible;
  const leftIndex = rightIndex - barsVisible;

  const toLog = (v) => Math.log(Math.max(1e-12, v));
  const lo = logScale ? toLog(min) : min;
  const hi = logScale ? toLog(max) : max;
  const span = hi - lo || 1;

  return {
    barWidth,
    leftIndex,
    rightIndex,
    plotW,
    plotH,
    x: (i) => (i - leftIndex) * barWidth + barWidth / 2,
    xToIndex: (px) => px / barWidth + leftIndex - 0.5,
    y: (p) => {
      const v = logScale ? toLog(p) : p;
      return padding.top + (1 - (v - lo) / span) * plotH;
    },
    yToPrice: (py) => {
      const t = 1 - (py - padding.top) / plotH;
      const v = lo + t * span;
      return logScale ? Math.exp(v) : v;
    },
    min,
    max,
  };
}

/**
 * 自動計算可視範圍的價格上下界。
 * extra（停損／目標等水平線）只有落在合理範圍內才納入，
 * 否則一個很遠的目標會把 K 棒壓成一條線。
 */
export function autoRange(candles, from, to, extra = [], maxExpand = 0.45) {
  let min = Infinity;
  let max = -Infinity;
  for (let i = Math.max(0, Math.floor(from)); i <= Math.min(candles.length - 1, Math.ceil(to)); i++) {
    const c = candles[i];
    if (!c) continue;
    if (c.low < min) min = c.low;
    if (c.high > max) max = c.high;
  }
  if (!isFinite(min) || !isFinite(max)) return { min: 0, max: 1 };
  const span = max - min || max * 0.02 || 1;
  const loLimit = min - span * maxExpand;
  const hiLimit = max + span * maxExpand;
  for (const v of extra) {
    if (v == null || !isFinite(v)) continue;
    if (v < loLimit || v > hiLimit) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const pad = (max - min) * 0.08 || max * 0.01 || 1;
  return { min: min - pad, max: max + pad };
}

/** 產生「好看」的價格刻度 */
export function priceTicks(min, max, count = 6) {
  const span = max - min;
  if (!(span > 0)) return [];
  const rough = span / count;
  const mag = Math.pow(10, Math.floor(Math.log10(rough)));
  const norm = rough / mag;
  const step = (norm >= 5 ? 5 : norm >= 2 ? 2 : norm >= 1 ? 1 : 0.5) * mag;
  const first = Math.ceil(min / step) * step;
  const out = [];
  for (let v = first; v <= max; v += step) out.push(v);
  return out;
}

/** 時間軸刻度：依可視跨度自動選擇間隔 */
export function timeTicks(candles, leftIndex, rightIndex, targetCount = 8) {
  const from = Math.max(0, Math.floor(leftIndex));
  const to = Math.min(candles.length - 1, Math.ceil(rightIndex));
  if (to <= from) return [];
  const visible = to - from;
  const stride = Math.max(1, Math.round(visible / targetCount));
  const out = [];
  for (let i = from; i <= to; i++) {
    if (i % stride === 0) out.push({ index: i, time: candles[i].time });
  }
  return out;
}
