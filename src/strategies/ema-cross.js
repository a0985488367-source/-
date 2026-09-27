/**
 * 4 小時 EMA20／50 均線交叉的訊號判斷——回測（scripts/research/alt-strategies.mjs 的 EMA_20_50）
 * 跟線上自動下單（worker/index.js）共用這一份，確保兩邊判斷完全一致。
 *
 * 規則（只看第 i 根收盤以前的資料）：
 *   做多  第 i 根收盤時 EMA(fast) 剛上穿 EMA(slow)（前一根還在下面或相等），而且收盤在 EMA(trend) 之上
 *   做空  反過來：EMA(fast) 剛下穿 EMA(slow)，收盤在 EMA(trend) 之下
 *   停損  距離 = stopAtr × ATR(atrPeriod)（第 i 根的值），下一根開盤市價進場
 *   出場  賺到 1R 停損移到成本（+0.05R），1.5R 之後追蹤停損、距離最高獲利 1.5R，不設止盈
 *
 * 2026-09 回測（三組各 15 幣、4h、5000 根歷史＋最近 150 天 5 分鐘精準版、同一個幣同時只抱一張）：
 * 12 格（3 組 × 前後半段 × 兩種算法）全部為正，扣手續費每筆約 +0.05～+0.70R（平均約 +0.32R），
 * 勝率約 56～66%，每 15 檔每週約 6～7 張。
 */

import { ema, atr } from '../core/indicators.js';

export const EMA_CROSS_DEFAULTS = { fast: 20, slow: 50, trend: 200, atrPeriod: 14, stopAtr: 2 };

/** 預先算好整段 K 棒的 EMA／ATR（回測逐根判斷時避免重算） */
export function emaCrossIndicators(candles, opts = {}) {
  const o = { ...EMA_CROSS_DEFAULTS, ...opts };
  const close = candles.map((k) => k.close);
  return {
    fast: ema(close, o.fast),
    slow: ema(close, o.slow),
    trend: ema(close, o.trend),
    atr: atr(candles, o.atrPeriod),
  };
}

const ok = (...v) => v.every((x) => x != null && Number.isFinite(x));

/**
 * 第 i 根收盤時有沒有交叉訊號。回傳 { dir, stopDistance, atr, close, time } 或 null。
 * pre 可以傳 emaCrossIndicators() 的結果；不傳就現算。
 */
export function emaCrossSignal(candles, opts = {}, i = candles.length - 1, pre = null) {
  const o = { ...EMA_CROSS_DEFAULTS, ...opts };
  if (i < 1 || i >= candles.length) return null;
  const x = pre ?? emaCrossIndicators(candles, o);
  const f = x.fast, s = x.slow, t = x.trend[i], a = x.atr[i];
  if (!ok(f[i], s[i], f[i - 1], s[i - 1], t) || !(a > 0)) return null;
  const c = candles[i].close;
  let dir = null;
  if (f[i] > s[i] && f[i - 1] <= s[i - 1] && c > t) dir = 'long';
  else if (f[i] < s[i] && f[i - 1] >= s[i - 1] && c < t) dir = 'short';
  if (!dir) return null;
  return { dir, stopDistance: a * o.stopAtr, atr: a, close: c, time: candles[i].time };
}
