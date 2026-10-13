/**
 * SMC 推播的「統整週期」過濾（2026-10-13 使用者要的：15m 叫做空、1h／4h 還在回調 → 常常吃損）。
 *
 * 訊號週期的上面兩層：15m／30m → 1h、4h；1h／2h → 4h、1d；4h／6h → 1d、1w；1d → 1w。
 * 規則（回測 smc-mtf-filter 的 B）：
 *   上面兩層的大結構（swing trend）都跟訊號同方向，而且緊鄰上一層的小結構（internal trend）也同方向
 *   （＝上一層的回調已經結束，不是還在往反方向走）。
 * 回測 150 天：推播少約一半、吃損次數少一半，但每筆期望值只從 -0.08R 變 -0.07R——只是少虧、少吵，不是變賺。
 */

import { analyze } from './engine.js';

export const UPPER_TFS = { '15m': ['1h', '4h'], '30m': ['1h', '4h'], '1h': ['4h', '1d'], '2h': ['4h', '1d'], '4h': ['1d', '1w'], '6h': ['1d', '1w'], '1d': ['1w'] };
/** 上面週期用幾根「已收盤」K 棒判斷結構（跟回測一樣） */
export const GATE_BARS = 300;

const DIR = { bullish: 'long', bearish: 'short' };

/** 一個週期現在的大／小結構方向（long／short／null＝盤整） */
export function structureOf(closedCandles) {
  if (!closedCandles || closedCandles.length < 60) return null;
  const a = analyze(closedCandles.slice(-GATE_BARS));
  if (a.empty) return null;
  return { swing: DIR[a.structure.swing.trendLabel] ?? null, internal: DIR[a.structure.internal.trendLabel] ?? null };
}

/**
 * @param {'long'|'short'} dir 訊號方向
 * @param {Array<{ tf: string, st: { swing, internal } | null, error?: string }>} upper 上面兩層（照順序：緊鄰的在前）；error＝抓不到的原因
 * @returns {{ pass: boolean, unknown: boolean, lines: string[] }}
 *   unknown＝上一層讀不到資料：不擋（寧可多推一則，也不要因為抓不到資料漏掉），訊息裡會註明
 */
export function mtfGate(dir, upper) {
  const zh = (d) => (d === 'long' ? '多' : d === 'short' ? '空' : '盤整');
  const mark = (d) => (d === dir ? '✅' : '❌');
  const lines = [];
  let pass = true;
  let unknown = false;
  upper.forEach(({ tf, st, error }, i) => {
    if (!st) {
      lines.push(`${tf} 讀不到資料${error ? `（${error}）` : ''}`);
      if (i === 0) unknown = true;
      return;
    }
    const okSwing = st.swing === dir;
    const okInternal = i > 0 || st.internal === dir;
    if (!okSwing || !okInternal) pass = false;
    lines.push(i === 0
      ? `${tf} 大結構${zh(st.swing)} ${mark(st.swing)}・小結構${zh(st.internal)} ${mark(st.internal)}${st.swing === dir && st.internal !== dir ? '（還在回調）' : ''}`
      : `${tf} 大結構${zh(st.swing)} ${mark(st.swing)}`);
  });
  if (unknown) pass = true;
  return { pass, unknown, lines };
}
