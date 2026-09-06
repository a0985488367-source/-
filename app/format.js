/**
 * format — 共用數值格式化
 *
 * 畫面（render.js）與通知（discord.js）都要把同一批數字寫成字串。
 * 抽在這裡，兩邊格式一致，也避免內嵌成單一作用域時重複宣告。
 */

/** 依價格量級決定小數位數，避免低價幣顯示成 0.0000 */
export function priceDigits(p) {
  if (!Number.isFinite(p)) return 4;
  if (p >= 1000) return 1;
  if (p >= 10) return 3;
  if (p >= 1) return 4;
  if (p >= 0.01) return 5;
  return 7;
}

export const fx = (v, d) => (Number.isFinite(v) ? v.toFixed(d ?? 4) : '—');

export const fpct = (v) => (Number.isFinite(v) ? (v >= 0 ? '+' : '') + v.toFixed(2) + '%' : '—');

export const fmoney = (v) => (Number.isFinite(v) ? (v >= 0 ? '' : '-') + Math.abs(v).toFixed(2) : '—');

export function fusd(v) {
  if (!Number.isFinite(v) || v <= 0) return '—';
  if (v >= 1e9) return (v / 1e9).toFixed(2) + 'B';
  if (v >= 1e6) return (v / 1e6).toFixed(2) + 'M';
  if (v >= 1e3) return (v / 1e3).toFixed(1) + 'K';
  return v.toFixed(0);
}

/** CSS class 用的正負號 */
export const sgn = (v) => (Number.isFinite(v) ? (v >= 0 ? 'pos' : 'neg') : '');

export function ago(ts, now) {
  if (!ts) return '尚未掃描';
  const s = Math.max(0, Math.round(((now ?? Date.now()) - ts) / 1000));
  if (s < 60) return s + ' 秒前';
  return Math.round(s / 60) + ' 分鐘前';
}
