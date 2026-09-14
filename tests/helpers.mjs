/** 測試用的合成 K 線工具 */

export function mkCandles(spec, { start = Date.UTC(2024, 0, 1), step = 900000, volume = 100 } = {}) {
  return spec.map(([o, h, l, c], i) => ({
    time: start + i * step,
    open: o, high: h, low: l, close: c,
    volume: Array.isArray(volume) ? volume[i] : volume,
  }));
}

/** 依收盤價序列造出合理的 OHLC（影線 ±0.3%） */
export function fromCloses(closes, opts = {}) {
  const spec = closes.map((c, i) => {
    const o = i === 0 ? c : closes[i - 1];
    const hi = Math.max(o, c) * 1.003;
    const lo = Math.min(o, c) * 0.997;
    return [o, hi, lo, c];
  });
  return mkCandles(spec, opts);
}

/** 上升趨勢 + 回調 + 再上升，用於結構測試 */
export function zigzag(points, barsPerLeg = 10, startPrice = 100) {
  const closes = [];
  let price = startPrice;
  for (const target of points) {
    for (let i = 1; i <= barsPerLeg; i++) {
      closes.push(price + ((target - price) * i) / barsPerLeg);
    }
    price = target;
  }
  return fromCloses(closes);
}
