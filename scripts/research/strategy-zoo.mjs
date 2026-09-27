/**
 * 策略庫：市面上常見、規則寫得清楚的交易策略（研究用），給 alt-strategies.mjs 一起回測。
 *
 * 每個策略都是 (x, i) => { dir, stopAtr } | null：只用第 i 根收盤以前的資料判斷，
 * 下一根開盤市價進場，停損 = stopAtr × ATR(14)。x 是 prepare() 預先算好的指標。
 * 「順勢」的大多加了 EMA200 同側的過濾；交叉類只取剛交叉的那一根。
 */

import { ema, sma, atr, rsi } from '../../src/core/indicators.js';

const L = 'long';
const S = 'short';

/** 滾動標準差 */
function stdev(values, period) {
  const out = new Array(values.length).fill(null);
  for (let i = period - 1; i < values.length; i++) {
    let m = 0;
    for (let j = i - period + 1; j <= i; j++) m += values[j];
    m /= period;
    let v = 0;
    for (let j = i - period + 1; j <= i; j++) v += (values[j] - m) ** 2;
    out[i] = Math.sqrt(v / period);
  }
  return out;
}

const hh = (arr, i, n) => { let m = -Infinity; for (let j = i - n + 1; j <= i; j++) m = Math.max(m, arr[j]); return m; };
const ll = (arr, i, n) => { let m = Infinity; for (let j = i - n + 1; j <= i; j++) m = Math.min(m, arr[j]); return m; };

/** Wilder ADX／+DI／−DI */
function adx(c, period = 14) {
  const n = c.length;
  const plus = new Array(n).fill(0), minus = new Array(n).fill(0), tr = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    const up = c[i].high - c[i - 1].high, dn = c[i - 1].low - c[i].low;
    plus[i] = up > dn && up > 0 ? up : 0;
    minus[i] = dn > up && dn > 0 ? dn : 0;
    tr[i] = Math.max(c[i].high - c[i].low, Math.abs(c[i].high - c[i - 1].close), Math.abs(c[i].low - c[i - 1].close));
  }
  const pdi = new Array(n).fill(null), mdi = new Array(n).fill(null), ax = new Array(n).fill(null);
  let sTr = 0, sP = 0, sM = 0, dxs = [], adxPrev = null;
  for (let i = 1; i < n; i++) {
    if (i <= period) { sTr += tr[i]; sP += plus[i]; sM += minus[i]; if (i < period) continue; }
    else { sTr = sTr - sTr / period + tr[i]; sP = sP - sP / period + plus[i]; sM = sM - sM / period + minus[i]; }
    pdi[i] = sTr ? (100 * sP) / sTr : 0;
    mdi[i] = sTr ? (100 * sM) / sTr : 0;
    const dx = pdi[i] + mdi[i] ? (100 * Math.abs(pdi[i] - mdi[i])) / (pdi[i] + mdi[i]) : 0;
    if (adxPrev == null) { dxs.push(dx); if (dxs.length === period) { adxPrev = dxs.reduce((a, b) => a + b, 0) / period; ax[i] = adxPrev; } }
    else { adxPrev = (adxPrev * (period - 1) + dx) / period; ax[i] = adxPrev; }
  }
  return { pdi, mdi, adx: ax };
}

/** Supertrend 方向（1＝多、−1＝空） */
function supertrend(c, a, mult = 3) {
  const n = c.length;
  const dir = new Array(n).fill(null);
  let up = null, dn = null, d = 1;
  for (let i = 0; i < n; i++) {
    if (a[i] == null) continue;
    const mid = (c[i].high + c[i].low) / 2;
    let bu = mid - mult * a[i], bd = mid + mult * a[i];
    if (up != null && c[i - 1].close > up) bu = Math.max(bu, up);
    if (dn != null && c[i - 1].close < dn) bd = Math.min(bd, dn);
    if (up != null) {
      if (d === 1 && c[i].close < up) d = -1;
      else if (d === -1 && c[i].close > dn) d = 1;
    }
    up = bu; dn = bd; dir[i] = d;
  }
  return dir;
}

/** Parabolic SAR 方向（1＝多、−1＝空） */
function psar(c, step = 0.02, max = 0.2) {
  const n = c.length;
  const dir = new Array(n).fill(null);
  if (n < 2) return dir;
  let long = c[1].close >= c[0].close, af = step, ep = long ? c[1].high : c[1].low, sar = long ? c[0].low : c[0].high;
  for (let i = 2; i < n; i++) {
    sar = sar + af * (ep - sar);
    if (long) {
      sar = Math.min(sar, c[i - 1].low, c[i - 2].low);
      if (c[i].low < sar) { long = false; sar = ep; ep = c[i].low; af = step; }
      else if (c[i].high > ep) { ep = c[i].high; af = Math.min(max, af + step); }
    } else {
      sar = Math.max(sar, c[i - 1].high, c[i - 2].high);
      if (c[i].high > sar) { long = true; sar = ep; ep = c[i].high; af = step; }
      else if (c[i].low < ep) { ep = c[i].low; af = Math.min(max, af + step); }
    }
    dir[i] = long ? 1 : -1;
  }
  return dir;
}

/** 一次算好所有策略要用的指標 */
export function prepare(c) {
  const close = c.map((k) => k.close), high = c.map((k) => k.high), low = c.map((k) => k.low), vol = c.map((k) => k.volume);
  const a = atr(c, 14);
  const e12 = ema(close, 12), e26 = ema(close, 26);
  const macd = close.map((_, i) => (e12[i] != null && e26[i] != null ? e12[i] - e26[i] : null));
  const macdSig = new Array(c.length).fill(null);
  { const first = macd.findIndex((v) => v != null); const s = ema(macd.slice(first), 9); s.forEach((v, k) => { macdSig[first + k] = v; }); }
  const s20 = sma(close, 20), sd20 = stdev(close, 20), e20 = ema(close, 20);
  const tp = c.map((k) => (k.high + k.low + k.close) / 3);
  const tpS = sma(tp, 20);
  const cci = tp.map((v, i) => {
    if (i < 19 || tpS[i] == null) return null;
    let md = 0; for (let j = i - 19; j <= i; j++) md += Math.abs(tp[j] - tpS[i]);
    md /= 20; return md ? (v - tpS[i]) / (0.015 * md) : 0;
  });
  const stochK = c.map((k, i) => (i < 13 ? null : (hh(high, i, 14) - ll(low, i, 14) ? (100 * (k.close - ll(low, i, 14))) / (hh(high, i, 14) - ll(low, i, 14)) : 50)));
  const stochKs = sma(stochK.map((v) => v ?? 50), 3);
  const stochD = sma(stochKs, 3);
  const willr = c.map((k, i) => (i < 13 ? null : (hh(high, i, 14) - ll(low, i, 14) ? (-100 * (hh(high, i, 14) - k.close)) / (hh(high, i, 14) - ll(low, i, 14)) : -50)));
  const tenkan = c.map((_, i) => (i < 8 ? null : (hh(high, i, 9) + ll(low, i, 9)) / 2));
  const kijun = c.map((_, i) => (i < 25 ? null : (hh(high, i, 26) + ll(low, i, 26)) / 2));
  // 雲：第 i 根看到的雲是 26 根前算出來的先行帶（不偷看未來）
  const spanA = c.map((_, i) => (i < 51 ? null : (tenkan[i - 26] + kijun[i - 26]) / 2));
  const spanB = c.map((_, i) => (i < 77 ? null : (hh(high, i - 26, 52) + ll(low, i - 26, 52)) / 2));
  const { pdi, mdi, adx: ax } = adx(c, 14);
  return {
    c, close, high, low, vol, a,
    e9: ema(close, 9), e20, e21: ema(close, 21), e50: ema(close, 50), e200: ema(close, 200),
    s50: sma(close, 50), s200: sma(close, 200), volS: sma(vol, 20),
    r14: rsi(c, 14), r2v: rsi(c, 2),
    macd, macdSig,
    bbU: s20.map((m, i) => (m == null || sd20[i] == null ? null : m + 2 * sd20[i])),
    bbL: s20.map((m, i) => (m == null || sd20[i] == null ? null : m - 2 * sd20[i])),
    kcU: e20.map((m, i) => (m == null || a[i] == null ? null : m + 1.5 * a[i])),
    kcL: e20.map((m, i) => (m == null || a[i] == null ? null : m - 1.5 * a[i])),
    cci, stochK: stochKs, stochD, willr, tenkan, kijun, spanA, spanB, pdi, mdi, adx: ax,
    st: supertrend(c, a, 3), psar: psar(c),
  };
}

const ok = (...v) => v.every((x) => x != null && Number.isFinite(x));
const crossUp = (a, b, i) => ok(a[i], b[i], a[i - 1], b[i - 1]) && a[i] > b[i] && a[i - 1] <= b[i - 1];
const crossDn = (a, b, i) => ok(a[i], b[i], a[i - 1], b[i - 1]) && a[i] < b[i] && a[i - 1] >= b[i - 1];
const lvlUp = (a, lv, i) => ok(a[i], a[i - 1]) && a[i] > lv && a[i - 1] <= lv;
const lvlDn = (a, lv, i) => ok(a[i], a[i - 1]) && a[i] < lv && a[i - 1] >= lv;
const above200 = (x, i) => ok(x.e200[i]) && x.close[i] > x.e200[i];
const below200 = (x, i) => ok(x.e200[i]) && x.close[i] < x.e200[i];
const sig = (dir, stopAtr) => ({ dir, stopAtr });

export const ZOO = {
  /* ---------- 順勢／均線 ---------- */
  EMA_9_21: (x, i) => (crossUp(x.e9, x.e21, i) && above200(x, i) ? sig(L, 1.5) : crossDn(x.e9, x.e21, i) && below200(x, i) ? sig(S, 1.5) : null),
  EMA_20_50: (x, i) => (crossUp(x.e20, x.e50, i) && above200(x, i) ? sig(L, 2) : crossDn(x.e20, x.e50, i) && below200(x, i) ? sig(S, 2) : null),
  GOLDEN_CROSS: (x, i) => (crossUp(x.s50, x.s200, i) ? sig(L, 3) : crossDn(x.s50, x.s200, i) ? sig(S, 3) : null),
  MACD: (x, i) => (crossUp(x.macd, x.macdSig, i) && above200(x, i) ? sig(L, 2) : crossDn(x.macd, x.macdSig, i) && below200(x, i) ? sig(S, 2) : null),
  MACD_ZERO: (x, i) => (lvlUp(x.macd, 0, i) && above200(x, i) ? sig(L, 2) : lvlDn(x.macd, 0, i) && below200(x, i) ? sig(S, 2) : null),
  SUPERTREND: (x, i) => (x.st[i] === 1 && x.st[i - 1] === -1 ? sig(L, 2) : x.st[i] === -1 && x.st[i - 1] === 1 ? sig(S, 2) : null),
  PSAR: (x, i) => (x.psar[i] === 1 && x.psar[i - 1] === -1 && above200(x, i) ? sig(L, 2) : x.psar[i] === -1 && x.psar[i - 1] === 1 && below200(x, i) ? sig(S, 2) : null),
  ADX_DI: (x, i) => (ok(x.adx[i]) && x.adx[i] > 25 && crossUp(x.pdi, x.mdi, i) ? sig(L, 2) : ok(x.adx[i]) && x.adx[i] > 25 && crossDn(x.pdi, x.mdi, i) ? sig(S, 2) : null),
  ICHIMOKU: (x, i) => {
    if (!ok(x.spanA[i], x.spanB[i])) return null;
    const top = Math.max(x.spanA[i], x.spanB[i]), bot = Math.min(x.spanA[i], x.spanB[i]);
    if (crossUp(x.tenkan, x.kijun, i) && x.close[i] > top) return sig(L, 2);
    if (crossDn(x.tenkan, x.kijun, i) && x.close[i] < bot) return sig(S, 2);
    return null;
  },
  /* ---------- 突破 ---------- */
  BB_BREAK: (x, i) => (crossUp(x.close, x.bbU, i) && above200(x, i) ? sig(L, 2) : crossDn(x.close, x.bbL, i) && below200(x, i) ? sig(S, 2) : null),
  KC_BREAK: (x, i) => (crossUp(x.close, x.kcU, i) && above200(x, i) ? sig(L, 2) : crossDn(x.close, x.kcL, i) && below200(x, i) ? sig(S, 2) : null),
  SQUEEZE: (x, i) => {
    // 布林通道縮進肯特納通道裡至少 6 根（盤整擠壓），這根收盤突破布林上／下軌
    if (i < 8) return null;
    for (let j = i - 6; j < i; j++) if (!ok(x.bbU[j], x.kcU[j], x.bbL[j], x.kcL[j]) || !(x.bbU[j] < x.kcU[j] && x.bbL[j] > x.kcL[j])) return null;
    if (ok(x.bbU[i]) && x.close[i] > x.bbU[i]) return sig(L, 2);
    if (ok(x.bbL[i]) && x.close[i] < x.bbL[i]) return sig(S, 2);
    return null;
  },
  VOL_BREAK: (x, i) => {
    if (i < 22 || !ok(x.volS[i - 1]) || !(x.vol[i] > 2 * x.volS[i - 1])) return null;
    if (x.close[i] > hh(x.high, i - 1, 20) && above200(x, i)) return sig(L, 2);
    if (x.close[i] < ll(x.low, i - 1, 20) && below200(x, i)) return sig(S, 2);
    return null;
  },
  INSIDE_BAR: (x, i) => {
    const c = x.c;
    if (i < 3 || !(c[i - 1].high <= c[i - 2].high && c[i - 1].low >= c[i - 2].low)) return null;
    if (c[i].close > c[i - 1].high && above200(x, i)) return sig(L, 1.5);
    if (c[i].close < c[i - 1].low && below200(x, i)) return sig(S, 1.5);
    return null;
  },
  NR7: (x, i) => {
    const c = x.c;
    if (i < 9) return null;
    const r = (k) => c[k].high - c[k].low;
    for (let j = i - 7; j < i - 1; j++) if (r(j) <= r(i - 1)) return null;
    if (c[i].close > c[i - 1].high && above200(x, i)) return sig(L, 1.5);
    if (c[i].close < c[i - 1].low && below200(x, i)) return sig(S, 1.5);
    return null;
  },
  /* ---------- 反轉／均值回歸 ---------- */
  RSI_30_70: (x, i) => (lvlUp(x.r14, 30, i) && above200(x, i) ? sig(L, 2) : lvlDn(x.r14, 70, i) && below200(x, i) ? sig(S, 2) : null),
  RSI_30_70_ANY: (x, i) => (lvlUp(x.r14, 30, i) ? sig(L, 2) : lvlDn(x.r14, 70, i) ? sig(S, 2) : null),
  BB_REVERT: (x, i) => (crossUp(x.close, x.bbL, i) && above200(x, i) ? sig(L, 1.5) : crossDn(x.close, x.bbU, i) && below200(x, i) ? sig(S, 1.5) : null),
  STOCH: (x, i) => (crossUp(x.stochK, x.stochD, i) && x.stochK[i] < 20 && above200(x, i) ? sig(L, 1.5)
    : crossDn(x.stochK, x.stochD, i) && x.stochK[i] > 80 && below200(x, i) ? sig(S, 1.5) : null),
  WILLIAMS_R: (x, i) => (lvlUp(x.willr, -80, i) && above200(x, i) ? sig(L, 1.5) : lvlDn(x.willr, -20, i) && below200(x, i) ? sig(S, 1.5) : null),
  CCI: (x, i) => (lvlUp(x.cci, -100, i) && above200(x, i) ? sig(L, 1.5) : lvlDn(x.cci, 100, i) && below200(x, i) ? sig(S, 1.5) : null),
  ENGULF: (x, i) => {
    // 在近 20 根低（高）點出現吞噬 K 棒
    const c = x.c;
    if (i < 22) return null;
    const bull = c[i].close > c[i].open && c[i - 1].close < c[i - 1].open && c[i].close >= c[i - 1].open && c[i].open <= c[i - 1].close;
    const bear = c[i].close < c[i].open && c[i - 1].close > c[i - 1].open && c[i].close <= c[i - 1].open && c[i].open >= c[i - 1].close;
    if (bull && Math.min(c[i].low, c[i - 1].low) <= ll(x.low, i - 2, 20)) return sig(L, 1.5);
    if (bear && Math.max(c[i].high, c[i - 1].high) >= hh(x.high, i - 2, 20)) return sig(S, 1.5);
    return null;
  },
};
