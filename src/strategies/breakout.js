/**
 * 4 小時突破策略（唐奇安通道）的訊號判斷——回測（scripts/research/alt-strategies.mjs）
 * 跟線上自動下單（worker/index.js）共用這一份，確保兩邊判斷完全一致。
 *
 * 規則（只看第 i 根收盤以前的資料）：
 *   做多  第 i 根收盤突破前 lookback 根的最高點，而且收在 EMA(emaPeriod) 之上；
 *         只取「剛突破的第一根」（第 i-1 根還沒突破它自己的前 lookback 根高點）
 *   做空  反過來：收盤跌破前 lookback 根最低點、收在 EMA 之下
 *   停損  距離 = stopAtr × ATR(atrPeriod)（第 i 根的值），下一根開盤市價進場
 *
 * 2026-09 回測（三組各 15 幣、4h、5000 根歷史＋最近 150 天 5 分鐘精準版、同一個幣同時只抱一張）：
 * lookback 55、停損 2 ATR、止盈固定 1R → 12 格（3 組 × 前後半段 × 兩種算法）全部為正，
 * 扣手續費每筆約 +0.04～+0.11R，勝率約 53～57%。
 */

import { ema, atr } from '../core/indicators.js';

export const BREAKOUT_DEFAULTS = { lookback: 55, emaPeriod: 200, atrPeriod: 14, stopAtr: 2 };

/** 預先算好整段 K 棒的 EMA／ATR（回測逐根判斷時避免重算） */
export function breakoutIndicators(candles, opts = {}) {
  const o = { ...BREAKOUT_DEFAULTS, ...opts };
  return {
    ema: ema(candles.map((k) => k.close), o.emaPeriod),
    atr: atr(candles, o.atrPeriod),
  };
}

/**
 * 第 i 根收盤時有沒有突破訊號。回傳 { dir, stopDistance, atr, close, time } 或 null。
 * pre 可以傳 breakoutIndicators() 的結果；不傳就現算。
 */
export function breakoutSignal(candles, opts = {}, i = candles.length - 1, pre = null) {
  const o = { ...BREAKOUT_DEFAULTS, ...opts };
  const n = o.lookback;
  if (i < n + 1 || i >= candles.length) return null;
  const ind = pre ?? breakoutIndicators(candles, o);
  const e = ind.ema[i];
  const a = ind.atr[i];
  if (e == null || !(a > 0)) return null;

  let hi = -Infinity, lo = Infinity, hiPrev = -Infinity, loPrev = Infinity;
  for (let j = i - n; j < i; j++) { hi = Math.max(hi, candles[j].high); lo = Math.min(lo, candles[j].low); }
  for (let j = i - n - 1; j < i - 1; j++) { hiPrev = Math.max(hiPrev, candles[j].high); loPrev = Math.min(loPrev, candles[j].low); }

  const c = candles[i].close;
  const prev = candles[i - 1].close;
  let dir = null;
  if (c > hi && c > e && !(prev > hiPrev)) dir = 'long';
  else if (c < lo && c < e && !(prev < loPrev)) dir = 'short';
  if (!dir) return null;
  // level：被突破的那條線（做多＝前 n 根最高點、做空＝最低點），回測「突破回踩」進場用
  return { dir, stopDistance: a * o.stopAtr, atr: a, close: c, time: candles[i].time, level: dir === 'long' ? hi : lo };
}
