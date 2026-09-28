/**
 * 2026-09-28 全策略回測挑出來、跟突破／EMA 交叉／MACD 零軸一起上線的三個順勢策略。
 * 規則跟 scripts/research/strategy-zoo.mjs 的 VOL_BREAK、SUPERTREND、GOLDEN_CROSS 完全一樣
 * （tests/trend-extra.test.mjs 逐根比對），線上 Worker 用這一份判斷。
 *
 *   放量突破 VOL_BREAK   這根量 > 前 20 根均量 2 倍，收盤突破前 20 根最高（低）點，而且在 EMA200 同側；停損 2 ATR
 *   超級趨勢 SUPERTREND  Supertrend(ATR14, 3 倍) 翻多／翻空的那一根；停損 2 ATR
 *   黃金交叉 GOLDEN_CROSS SMA50 上穿（下穿）SMA200；停損 3 ATR
 * 都是第 i 根收盤判斷、下一根開盤市價進場，只用第 i 根以前的資料。
 */

import { ema, sma, atr } from '../core/indicators.js';

export const TREND_EXTRA_STOP_ATR = { vol: 2, st: 2, gc: 3 };

const ok = (...v) => v.every((x) => x != null && Number.isFinite(x));
const hh = (arr, i, n) => { let m = -Infinity; for (let j = i - n + 1; j <= i; j++) m = Math.max(m, arr[j]); return m; };
const ll = (arr, i, n) => { let m = Infinity; for (let j = i - n + 1; j <= i; j++) m = Math.min(m, arr[j]); return m; };

/** Supertrend 方向（1＝多、−1＝空）；跟 strategy-zoo.mjs 同一個算法 */
export function supertrendDir(c, a, mult = 3) {
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

/** 一次算好三個策略要用的指標（回測逐根判斷時避免重算） */
export function trendExtraIndicators(candles) {
  const close = candles.map((k) => k.close);
  const a = atr(candles, 14);
  return {
    close,
    high: candles.map((k) => k.high),
    low: candles.map((k) => k.low),
    vol: candles.map((k) => k.volume),
    volS: sma(candles.map((k) => k.volume), 20),
    e200: ema(close, 200),
    s50: sma(close, 50),
    s200: sma(close, 200),
    a,
    st: supertrendDir(candles, a, 3),
  };
}

const RULES = {
  vol: (x, i) => {
    if (i < 22 || !ok(x.volS[i - 1], x.e200[i]) || !(x.vol[i] > 2 * x.volS[i - 1])) return null;
    if (x.close[i] > hh(x.high, i - 1, 20) && x.close[i] > x.e200[i]) return 'long';
    if (x.close[i] < ll(x.low, i - 1, 20) && x.close[i] < x.e200[i]) return 'short';
    return null;
  },
  st: (x, i) => (x.st[i] === 1 && x.st[i - 1] === -1 ? 'long' : x.st[i] === -1 && x.st[i - 1] === 1 ? 'short' : null),
  gc: (x, i) => {
    const f = x.s50, s = x.s200;
    if (!ok(f[i], s[i], f[i - 1], s[i - 1])) return null;
    if (f[i] > s[i] && f[i - 1] <= s[i - 1]) return 'long';
    if (f[i] < s[i] && f[i - 1] >= s[i - 1]) return 'short';
    return null;
  },
};

/**
 * 第 i 根收盤時 strategy（'vol'／'st'／'gc'）有沒有訊號。
 * 回傳 { dir, stopDistance, atr, close, time } 或 null；pre 可傳 trendExtraIndicators() 的結果。
 */
export function trendExtraSignal(strategy, candles, i = candles.length - 1, pre = null) {
  if (!RULES[strategy] || i < 1 || i >= candles.length) return null;
  const x = pre ?? trendExtraIndicators(candles);
  const a = x.a[i];
  if (!(a > 0)) return null;
  const dir = RULES[strategy](x, i);
  if (!dir) return null;
  return { dir, stopDistance: a * TREND_EXTRA_STOP_ATR[strategy], atr: a, close: candles[i].close, time: candles[i].time };
}
