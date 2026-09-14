/**
 * 傳統技術指標 — 作為 SMC 的輔助濾網（動能、波動度、成交量）
 * Classic indicators used as confluence filters for the SMC engine.
 * 所有函式皆回傳與輸入等長的陣列，前端不足處以 null 填充。
 */

/** @typedef {{time:number,open:number,high:number,low:number,close:number,volume:number}} Candle */

export function sma(values, period) {
  const out = new Array(values.length).fill(null);
  let acc = 0;
  for (let i = 0; i < values.length; i++) {
    acc += values[i];
    if (i >= period) acc -= values[i - period];
    if (i >= period - 1) out[i] = acc / period;
  }
  return out;
}

export function ema(values, period) {
  const out = new Array(values.length).fill(null);
  if (values.length < period) return out;
  const k = 2 / (period + 1);
  let prev = 0;
  for (let i = 0; i < period; i++) prev += values[i];
  prev /= period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

export function rma(values, period) {
  const out = new Array(values.length).fill(null);
  if (values.length < period) return out;
  let prev = 0;
  for (let i = 0; i < period; i++) prev += values[i];
  prev /= period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = (prev * (period - 1) + values[i]) / period;
    out[i] = prev;
  }
  return out;
}

/** True Range 序列 */
export function trueRange(candles) {
  return candles.map((c, i) => {
    if (i === 0) return c.high - c.low;
    const p = candles[i - 1].close;
    return Math.max(c.high - c.low, Math.abs(c.high - p), Math.abs(c.low - p));
  });
}

/** ATR（Wilder 平滑） */
export function atr(candles, period = 14) {
  return rma(trueRange(candles), period);
}

export function rsi(candles, period = 14) {
  const closes = candles.map((c) => c.close);
  const gains = [0];
  const losses = [0];
  for (let i = 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    gains.push(Math.max(0, d));
    losses.push(Math.max(0, -d));
  }
  const ag = rma(gains, period);
  const al = rma(losses, period);
  return closes.map((_, i) => {
    if (ag[i] == null || al[i] == null) return null;
    if (al[i] === 0) return 100;
    const rs = ag[i] / al[i];
    return 100 - 100 / (1 + rs);
  });
}

/** 以「自然日（UTC）」錨定的 VWAP，含 ±1/±2 標準差通道 */
export function sessionVwap(candles, { anchor = 'day' } = {}) {
  const vwap = new Array(candles.length).fill(null);
  const upper1 = new Array(candles.length).fill(null);
  const lower1 = new Array(candles.length).fill(null);
  const upper2 = new Array(candles.length).fill(null);
  const lower2 = new Array(candles.length).fill(null);
  let pv = 0, vol = 0, pv2 = 0, key = null;
  const keyOf = (ts) => {
    const d = new Date(ts);
    if (anchor === 'week') {
      const day = d.getUTCDay();
      const monday = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - ((day + 6) % 7));
      return monday;
    }
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  };
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const k = keyOf(c.time);
    if (k !== key) { key = k; pv = 0; vol = 0; pv2 = 0; }
    const tp = (c.high + c.low + c.close) / 3;
    const v = c.volume || 1;
    pv += tp * v;
    pv2 += tp * tp * v;
    vol += v;
    const vw = pv / vol;
    const variance = Math.max(0, pv2 / vol - vw * vw);
    const sd = Math.sqrt(variance);
    vwap[i] = vw;
    upper1[i] = vw + sd;
    lower1[i] = vw - sd;
    upper2[i] = vw + 2 * sd;
    lower2[i] = vw - 2 * sd;
  }
  return { vwap, upper1, lower1, upper2, lower2 };
}

/**
 * 成交量分佈（Volume Profile）— 以指定區間計算 POC / VAH / VAL
 * 用於辨識「高成交量節點（HVN）」與「低成交量節點（LVN，價格容易快速穿越）」
 */
export function volumeProfile(candles, { bins = 48, valueAreaPct = 0.7 } = {}) {
  if (!candles.length) return null;
  let hi = -Infinity, lo = Infinity;
  for (const c of candles) { if (c.high > hi) hi = c.high; if (c.low < lo) lo = c.low; }
  if (!(hi > lo)) return null;
  const step = (hi - lo) / bins;
  const buckets = new Array(bins).fill(0);
  for (const c of candles) {
    const a = Math.max(0, Math.min(bins - 1, Math.floor((c.low - lo) / step)));
    const b = Math.max(0, Math.min(bins - 1, Math.floor((c.high - lo) / step)));
    const span = b - a + 1;
    const share = (c.volume || 1) / span;
    for (let i = a; i <= b; i++) buckets[i] += share;
  }
  const total = buckets.reduce((s, v) => s + v, 0) || 1;
  let pocIdx = 0;
  buckets.forEach((v, i) => { if (v > buckets[pocIdx]) pocIdx = i; });
  // 由 POC 向兩側擴張直到覆蓋 valueAreaPct 的量能
  let lowIdx = pocIdx, highIdx = pocIdx, acc = buckets[pocIdx];
  while (acc / total < valueAreaPct && (lowIdx > 0 || highIdx < bins - 1)) {
    const down = lowIdx > 0 ? buckets[lowIdx - 1] : -1;
    const up = highIdx < bins - 1 ? buckets[highIdx + 1] : -1;
    if (up >= down) { highIdx++; acc += Math.max(0, up); }
    else { lowIdx--; acc += Math.max(0, down); }
  }
  const priceAt = (i) => lo + step * (i + 0.5);
  const maxVol = Math.max(...buckets);
  return {
    low: lo,
    high: hi,
    step,
    bins: buckets.map((v, i) => ({ price: priceAt(i), volume: v, ratio: v / maxVol })),
    poc: priceAt(pocIdx),
    vah: priceAt(highIdx),
    val: priceAt(lowIdx),
    lvn: buckets
      .map((v, i) => ({ price: priceAt(i), ratio: v / maxVol }))
      .filter((b) => b.ratio < 0.18),
  };
}

/** 相對量能：目前 K 棒量能相對過去 n 根平均的倍數 */
export function relativeVolume(candles, period = 20) {
  const vols = candles.map((c) => c.volume || 0);
  const avg = sma(vols, period);
  return vols.map((v, i) => (avg[i] ? v / avg[i] : null));
}

/** 位移強度：K 棒實體相對 ATR 的倍數，用來判斷是否為 institutional displacement */
export function displacement(candles, period = 14) {
  const a = atr(candles, period);
  return candles.map((c, i) => {
    if (!a[i]) return null;
    return (c.close - c.open) / a[i];
  });
}
