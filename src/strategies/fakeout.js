/**
 * 突破之後的兩條路（2026-09 研究，scripts/research/fakeout-ote.mjs 跟線上 Worker 共用這個判斷）：
 *   延續（cont）：突破後回檔形成小波段低點 PL，之後收盤突破「突破到 PL 之間的最高點」（BOS）
 *   假突破（mss）：延續出現之前，收盤跌破最近一個已確認的小波段低點、而且收回突破線內 → 反手
 * （做多突破為例，做空反過來。）
 *
 * 突破線兩種：
 *   SW ＝最近一個已確認、還沒被收盤突破過的結構高／低點（左右各 swing 根的分形）
 *   D55＝近 55 根最高／低點（跟 src/strategies/breakout.js 同一個判斷，含 EMA200 同側）
 * 小波段是左右各 k 根的分形，要等右邊 k 根收完才算確認；同一個幣同一時間只追一個突破設定。
 * 全部只用當下已經收盤、已經確認的 K 棒。
 */

import { detectSwings } from '../smc/swings.js';
import { atr, ema } from '../core/indicators.js';
import { breakoutSignal } from './breakout.js';

export const FAKEOUT_DEFAULTS = { mode: 'SW', k: 2, swing: 5, window: 20, buf: 0.1, minRiskAtr: 0.3, from: 210 };

/** 每根 K 棒收盤時「最近一個已確認」的波段點（index + strength ≤ 這根） */
function lastConfirmed(swings, n, strength, type) {
  const out = new Array(n).fill(null);
  const list = swings.filter((s) => s.type === type);
  let cur = null, p = 0;
  for (let j = 0; j < n; j++) {
    while (p < list.length && list[p].index + strength <= j) { cur = list[p]; p++; }
    out[j] = cur;
  }
  return out;
}

function breakoutAt(o, c, i, ctx) {
  if (o.mode === 'D55') {
    const s = breakoutSignal(c, { lookback: 55 }, i, { ema: ctx.e200, atr: ctx.a });
    return s ? { dir: s.dir, level: s.level } : null;
  }
  // SW：收盤第一次越過最近一個已確認的結構高／低點
  for (const [dir, arr, above] of [['long', ctx.sHigh, 1], ['short', ctx.sLow, -1]]) {
    const s = arr[i];
    if (!s) continue;
    if ((c[i].close - s.price) * above <= 0) continue;
    let broken = false;
    for (let j = s.index + 1; j < i; j++) if ((c[j].close - s.price) * above > 0) { broken = true; break; }
    if (!broken) return { dir, level: s.price };
  }
  return null;
}

/**
 * 跑一遍整段 K 棒，回傳事件：
 *   { type: 'breakout', index, dir, level, busy }            busy＝還在追前一個設定，這次不追
 *   { type: 'cont', index, b, dir, level, pl, H }             pl＝回檔小波段、H＝目前突破方向的極值
 *   { type: 'mss', index, b, dir, rdir, level, H, Hidx, stop } rdir＝反手方向、stop＝H 外 buf 倍 ATR
 * opts.lastBar：延續／MSS 最晚判斷到第幾根（回測要留下一根進場，傳 n-2；線上傳 n-1）
 */
export function fakeoutEvents(candles, opts = {}, pre = {}) {
  const o = { ...FAKEOUT_DEFAULTS, ...opts };
  const c = candles;
  const n = c.length;
  const lastBar = o.lastBar ?? n - 1;
  const a = pre.atr ?? atr(c, 14);
  const inner = detectSwings(c, o.k);
  const ctx = { a, lowK: lastConfirmed(inner, n, o.k, 'low'), highK: lastConfirmed(inner, n, o.k, 'high') };
  if (o.mode === 'SW') {
    const outer = detectSwings(c, o.swing);
    ctx.sHigh = lastConfirmed(outer, n, o.swing, 'high');
    ctx.sLow = lastConfirmed(outer, n, o.swing, 'low');
  } else {
    ctx.e200 = pre.ema ?? ema(c.map((k) => k.close), 200);
  }

  const events = [];
  let busyUntil = -1;
  for (let b = o.from; b < lastBar; b++) {
    const br = breakoutAt(o, c, b, ctx);
    if (!br || !(a[b] > 0)) continue;
    const busy = b <= busyUntil;
    events.push({ type: 'breakout', index: b, dir: br.dir, level: br.level, busy });
    if (busy) continue;
    const L = br.dir === 'long';
    const d = L ? 1 : -1;
    const ext = (k) => (L ? c[k].high : c[k].low); // 突破方向的極值
    const better = (p, q) => (L ? p > q : p < q); // p 比 q 更往突破方向
    const pivots = L ? ctx.lowK : ctx.highK; // 回檔形成的小波段（做多看低點）

    let H = ext(b), Hidx = b, PL = null, Hpre = null, done = false;
    for (let j = b + 1; j <= Math.min(b + o.window, lastBar) && !done; j++) {
      if (better(ext(j), H)) { H = ext(j); Hidx = j; }
      const pv = pivots[j];
      if (!PL && pv && pv.index > b) {
        PL = pv;
        Hpre = ext(b);
        for (let k = b; k <= pv.index; k++) if (better(ext(k), Hpre)) Hpre = ext(k);
      }
      const close = c[j].close;
      if (PL && j > PL.index + o.k - 1 && better(close, Hpre)) {
        done = true; busyUntil = j;
        events.push({ type: 'cont', index: j, b, dir: br.dir, level: br.level, pl: PL, H });
        break;
      }
      const ms = pivots[j];
      if (ms && !better(close, ms.price) && close !== ms.price && !better(close, br.level)) {
        done = true; busyUntil = j;
        events.push({ type: 'mss', index: j, b, dir: br.dir, rdir: L ? 'short' : 'long', level: br.level, H, Hidx, stop: H + d * o.buf * a[j] });
      }
    }
    if (!done) busyUntil = Math.min(b + o.window, n);
  }
  return events;
}

/**
 * 線上用：最後一根（剛收盤）是不是假突破 MSS → 回傳反手訊號，否則 null。
 * 停損是絕對價格（假突破極值外 buf 倍 ATR），進場價離停損不到 minRiskAtr 倍 ATR 就不做（回測同樣規則）。
 */
export function fakeoutSignal(candles, opts = {}) {
  const n = candles.length;
  const o = { ...FAKEOUT_DEFAULTS, ...opts };
  if (n < 60) return null;
  const from = opts.from ?? Math.max(30, Math.min(o.from, n - 90));
  const a = atr(candles, 14);
  const ev = fakeoutEvents(candles, { ...o, from, lastBar: n - 1 }, { atr: a }).find((e) => e.type === 'mss' && e.index === n - 1);
  if (!ev) return null;
  const close = candles[n - 1].close;
  const dist = Math.abs(ev.stop - close);
  const side = ev.rdir === 'long' ? close - ev.stop : ev.stop - close;
  if (!(side > o.minRiskAtr * a[n - 1])) return null;
  return {
    dir: ev.rdir, stopPrice: ev.stop, stopDistance: dist, atr: a[n - 1], close,
    time: candles[n - 1].time, level: ev.level, extreme: ev.H, breakoutDir: ev.dir,
  };
}
