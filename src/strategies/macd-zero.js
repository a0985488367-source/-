/**
 * MACD 穿零軸的訊號判斷——回測（scripts/research/strategy-zoo.mjs 的 MACD_ZERO）
 * 跟線上自動下單（worker/index.js）共用這一份，確保兩邊判斷完全一致。
 *
 * 規則（只看第 i 根收盤以前的資料）：
 *   做多  MACD 線（EMA12 − EMA26）剛從 0 以下（含）穿到 0 以上，而且收盤在 EMA200 之上
 *   做空  反過來：MACD 線剛從 0 以上（含）穿到 0 以下，收盤在 EMA200 之下
 *   停損  距離 = stopAtr × ATR(atrPeriod)（第 i 根的值），下一根開盤市價進場
 *   出場  跟 EMA 交叉一樣：賺到 1R 停損移到成本（+0.05R），1.5R 之後追蹤停損、距離最高獲利 1.5R，不設止盈
 *
 * 2026-09 回測（4h，五組各 15 幣、5000 根歷史＋最近 150 天 5 分鐘精準版）：
 * 原本三組 12 格全為正，另外兩組沒測過的幣 8 格裡 7 格為正；6h 也是 12 格裡 11 格為正。
 */

import { ema, atr } from '../core/indicators.js';

export const MACD_ZERO_DEFAULTS = { fast: 12, slow: 26, trend: 200, atrPeriod: 14, stopAtr: 2 };

/** 預先算好整段 K 棒的 MACD／EMA／ATR（回測逐根判斷時避免重算） */
export function macdZeroIndicators(candles, opts = {}) {
  const o = { ...MACD_ZERO_DEFAULTS, ...opts };
  const close = candles.map((k) => k.close);
  const f = ema(close, o.fast);
  const s = ema(close, o.slow);
  return {
    macd: close.map((_, i) => (f[i] != null && s[i] != null ? f[i] - s[i] : null)),
    trend: ema(close, o.trend),
    atr: atr(candles, o.atrPeriod),
  };
}

const ok = (...v) => v.every((x) => x != null && Number.isFinite(x));

/**
 * 第 i 根收盤時 MACD 有沒有剛穿過零軸。回傳 { dir, stopDistance, atr, close, time } 或 null。
 * pre 可以傳 macdZeroIndicators() 的結果；不傳就現算。
 */
export function macdZeroSignal(candles, opts = {}, i = candles.length - 1, pre = null) {
  const o = { ...MACD_ZERO_DEFAULTS, ...opts };
  if (i < 1 || i >= candles.length) return null;
  const x = pre ?? macdZeroIndicators(candles, o);
  const m = x.macd, t = x.trend[i], a = x.atr[i];
  if (!ok(m[i], m[i - 1], t) || !(a > 0)) return null;
  const c = candles[i].close;
  let dir = null;
  if (m[i] > 0 && m[i - 1] <= 0 && c > t) dir = 'long';
  else if (m[i] < 0 && m[i - 1] >= 0 && c < t) dir = 'short';
  if (!dir) return null;
  return { dir, stopDistance: a * o.stopAtr, atr: a, close: c, time: candles[i].time };
}
