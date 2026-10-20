/**
 * 第二批順勢策略（2026-10-20，教練自動下單關掉後找替代品）：給 alt-strategies.mjs 一起回測，研究用。
 *
 * 超級趨勢（線上 4h 版目前 Demo 表現最好）的變化版：
 *   ST_M2／ST_M4      ATR14 × 2／× 4（線上是 × 3）
 *   ST_P10M3          ATR10 × 3（TradingView 預設）
 *   ST_E200           翻轉那根要收在 EMA200 同一側
 *   ST_ADX            翻轉時 ADX(14) > 20（有趨勢才做）
 *   ST_HTF            收在「日線 EMA50」同一側（用本週期換算長度的 EMA 近似）
 *   ST_BTC            BTC 也在 EMA200 同一側（大盤同方向）
 *   ST_DUAL           快線（× 3）翻轉、而且慢線（× 6）已經是同方向
 *   ST_VOL            翻轉那根成交量 ≥ 前 20 根平均 1.5 倍
 *   ST_LINE           停損放在超級趨勢線上（不是固定 2 ATR）
 *   ST_PB             已經翻多（空）至少 5 根後，回踩到線附近（0.5 ATR 內）又收回去才進——趨勢中途的回檔單
 * 其他沒測過的順勢做法：
 *   HMA_FLIP          Hull MA(55) 斜率翻上／翻下，在 EMA200 同側（_35／_45／_70／_90 換長度、_NOE 不看 EMA200）
 *   AROON             Aroon(25) 上線穿過下線而且 > 70，在 EMA200 同側
 *   ROC_MOM           50 根漲跌幅（ROC）穿過 0，在 EMA200 同側（時間序列動能）
 *   CHANDELIER        吊燈停損（22 根、3 ATR）翻多／翻空
 *   EMA_ALIGN         EMA20 > 50 > 200 剛排好（空單相反）
 * 每個都是 (x, i) => { dir, stopAtr | stopPrice } | null：只用第 i 根收盤以前的資料，下一根開盤市價進場。
 */

import { ema, atr } from '../../src/core/indicators.js';

const L = 'long';
const S = 'short';
const ok = (...v) => v.every((x) => x != null && Number.isFinite(x));
const sig = (dir, stopAtr) => ({ dir, stopAtr });

/** 超級趨勢方向＋線的位置（跟 strategy-zoo.mjs／src/strategies/trend-extra.js 同一個算法，多回傳線） */
export function supertrendLine(c, a, mult = 3) {
  const n = c.length;
  const dir = new Array(n).fill(null), line = new Array(n).fill(null);
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
    up = bu; dn = bd; dir[i] = d; line[i] = d === 1 ? bu : bd;
  }
  return { dir, line };
}

function wma(values, n) {
  const out = new Array(values.length).fill(null);
  const den = (n * (n + 1)) / 2;
  for (let i = n - 1; i < values.length; i++) {
    let s = 0, bad = false;
    for (let k = 0; k < n; k++) { const v = values[i - k]; if (v == null) { bad = true; break; } s += v * (n - k); }
    if (!bad) out[i] = s / den;
  }
  return out;
}

function hma(values, n) {
  const half = wma(values, Math.round(n / 2)), full = wma(values, n);
  const diff = values.map((_, i) => (half[i] == null || full[i] == null ? null : 2 * half[i] - full[i]));
  return wma(diff, Math.round(Math.sqrt(n)));
}

/** Aroon(n)：上線＝離 n 根內最高點幾根、下線＝離最低點幾根 */
function aroon(c, n = 25) {
  const up = new Array(c.length).fill(null), dn = new Array(c.length).fill(null);
  for (let i = n; i < c.length; i++) {
    let hi = i, lo = i;
    for (let j = i - n; j <= i; j++) { if (c[j].high >= c[hi].high) hi = j; if (c[j].low <= c[lo].low) lo = j; }
    up[i] = (100 * (n - (i - hi))) / n;
    dn[i] = (100 * (n - (i - lo))) / n;
  }
  return { up, dn };
}

/** 吊燈停損方向（n 根、mult ATR(n)），停損只會往有利方向移 */
function chandelier(c, n = 22, mult = 3) {
  const a = atr(c, n);
  const dir = new Array(c.length).fill(null);
  let ls = null, ss = null, d = 1;
  for (let i = n; i < c.length; i++) {
    if (a[i] == null) continue;
    let hh = -Infinity, lw = Infinity;
    for (let j = i - n + 1; j <= i; j++) { hh = Math.max(hh, c[j].high); lw = Math.min(lw, c[j].low); }
    let l = hh - mult * a[i], s = lw + mult * a[i];
    if (ls != null && c[i - 1].close > ls) l = Math.max(l, ls);
    if (ss != null && c[i - 1].close < ss) s = Math.min(s, ss);
    if (ls != null) { if (c[i].close > ss) d = 1; else if (c[i].close < ls) d = -1; }
    ls = l; ss = s; dir[i] = d;
  }
  return dir;
}

/** 指標用到才算，算一次就存在 x 上 */
const lazy = (x, key, fn) => (x[key] ??= fn());
const flip = (dir, i) => (dir[i] === 1 && dir[i - 1] === -1 ? 1 : dir[i] === -1 && dir[i - 1] === 1 ? -1 : 0);
const side200 = (x, i, d) => ok(x.e200[i]) && (x.close[i] - x.e200[i]) * d > 0;
const toSig = (d, stopAtr = 2) => (d > 0 ? sig(L, stopAtr) : d < 0 ? sig(S, stopAtr) : null);

/**
 * deps：BTC_TREND（週期 → Map(K 棒時間 → 1／−1)）、TF_MIN（週期 → 分鐘），跟 alt-strategies.mjs 共用
 */
export function makeTrend2({ BTC_TREND, TF_MIN }) {
  const st = (x, mult, period = 14) => lazy(x, `st_${period}_${mult}`, () => supertrendLine(x.c, period === 14 ? x.a : atr(x.c, period), mult));
  const base = (x, i) => flip(st(x, 3).dir, i);
  const hmaFlip = (x, i, n, use200 = true) => {
    const h = lazy(x, `hma${n}`, () => hma(x.close, n));
    if (!ok(h[i], h[i - 1], h[i - 2])) return null;
    const now = Math.sign(h[i] - h[i - 1]), prev = Math.sign(h[i - 1] - h[i - 2]);
    const d = now !== 0 && now !== prev && prev !== 0 ? now : 0;
    return d && (!use200 || side200(x, i, d)) ? toSig(d) : null;
  };
  return {
    ST_M2: (x, i) => toSig(flip(st(x, 2).dir, i)),
    ST_M4: (x, i) => toSig(flip(st(x, 4).dir, i)),
    ST_P10M3: (x, i) => toSig(flip(st(x, 3, 10).dir, i)),
    ST_E200: (x, i) => { const d = base(x, i); return d && side200(x, i, d) ? toSig(d) : null; },
    ST_ADX: (x, i) => { const d = base(x, i); return d && x.adx[i] > 20 ? toSig(d) : null; },
    ST_HTF: (x, i) => {
      const d = base(x, i);
      if (!d) return null;
      const h = lazy(x, 'htf', () => ema(x.close, Math.round((50 * 1440) / (TF_MIN[x.interval] ?? 240))));
      return h[i] != null && (x.close[i] - h[i]) * d > 0 ? toSig(d) : null;
    },
    ST_BTC: (x, i) => { const d = base(x, i); return d && (BTC_TREND.get(x.interval)?.get(x.c[i].time) ?? 0) === d ? toSig(d) : null; },
    ST_DUAL: (x, i) => { const d = base(x, i); return d && st(x, 6).dir[i] === d ? toSig(d) : null; },
    ST_VOL: (x, i) => { const d = base(x, i); return d && x.volS[i - 1] > 0 && x.vol[i] >= 1.5 * x.volS[i - 1] ? toSig(d) : null; },
    ST_LINE: (x, i) => {
      const d = base(x, i);
      if (!d) return null;
      const ln = st(x, 3).line[i];
      return ok(ln) ? { dir: d > 0 ? L : S, stopPrice: ln } : null;
    },
    ST_PB: (x, i) => {
      const { dir, line } = st(x, 3);
      const d = dir[i];
      if (!d || i < 6) return null;
      for (let j = i - 5; j < i; j++) if (dir[j] !== d) return null;
      const near = (k) => ok(line[k], x.a[k]) && (d > 0 ? x.c[k].low <= line[k] + 0.5 * x.a[k] : x.c[k].high >= line[k] - 0.5 * x.a[k]);
      const k = x.c[i];
      const back = d > 0 ? k.close > line[i] && k.close > k.open : k.close < line[i] && k.close < k.open;
      return near(i) && back && !near(i - 1) ? toSig(d) : null;
    },
    HMA_FLIP: (x, i) => hmaFlip(x, i, 55),
    // 長度敏感度（2026-10-20）：55 換成別的長度還賺不賺；NOE＝不看 EMA200
    HMA_FLIP_35: (x, i) => hmaFlip(x, i, 35),
    HMA_FLIP_45: (x, i) => hmaFlip(x, i, 45),
    HMA_FLIP_70: (x, i) => hmaFlip(x, i, 70),
    HMA_FLIP_90: (x, i) => hmaFlip(x, i, 90),
    HMA_FLIP_NOE: (x, i) => hmaFlip(x, i, 55, false),
    AROON: (x, i) => {
      const { up, dn } = lazy(x, 'aroon25', () => aroon(x.c, 25));
      if (!ok(up[i], dn[i], up[i - 1], dn[i - 1])) return null;
      if (up[i] > dn[i] && up[i - 1] <= dn[i - 1] && up[i] > 70 && side200(x, i, 1)) return toSig(1);
      if (dn[i] > up[i] && dn[i - 1] <= up[i - 1] && dn[i] > 70 && side200(x, i, -1)) return toSig(-1);
      return null;
    },
    ROC_MOM: (x, i) => {
      if (i < 51) return null;
      const r = x.close[i] / x.close[i - 50] - 1, p = x.close[i - 1] / x.close[i - 51] - 1;
      const d = r > 0 && p <= 0 ? 1 : r < 0 && p >= 0 ? -1 : 0;
      return d && side200(x, i, d) ? toSig(d) : null;
    },
    CHANDELIER: (x, i) => toSig(flip(lazy(x, 'ce22', () => chandelier(x.c, 22, 3)), i)),
    EMA_ALIGN: (x, i) => {
      const up = (k) => ok(x.e20[k], x.e50[k], x.e200[k]) && x.e20[k] > x.e50[k] && x.e50[k] > x.e200[k];
      const dn = (k) => ok(x.e20[k], x.e50[k], x.e200[k]) && x.e20[k] < x.e50[k] && x.e50[k] < x.e200[k];
      return up(i) && !up(i - 1) ? toSig(1) : dn(i) && !dn(i - 1) ? toSig(-1) : null;
    },
  };
}
