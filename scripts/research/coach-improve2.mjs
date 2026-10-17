#!/usr/bin/env node
/**
 * 教練劇本「還能怎麼改」第二輪（2026-10-17）：不只出場，連週期、進場、停損、篩選一起試。
 *   週期：15m／30m／1h／2h／4h
 *   進場：E＝掛 POI 邊緣（線上）、M＝掛 POI 中間、K＝回踩那根收盤市價進
 *   停損：P＝原本（掃出來的極值外 0.15 ATR）、W＝再多放 0.5 ATR
 *   出場：S 結構目標、T1／T15／T2 固定 R、P 1R 平一半＋保本、剩下結構目標
 *   另外記：1h 結構方向（給 15m／30m 看）、BTC 4h 方向、ATR／價格（波動）、台灣時間幾點
 * 5 分鐘 K 棒逐根精算、扣手續費（掛單 0.02%、吃單 0.055%），存 JSON 之後本機組合比較。
 */
import fs from 'node:fs';
import { analyze, structure, atrOf, coachState } from './coach-core.mjs';
import { opt as optFrom, klines } from './lib.mjs';
import { sessionOf } from '../../src/smc/sessions.js';

const ARGS = process.argv.slice(2);
const opt = (n, d) => optFrom(ARGS, n, d);
const SYMBOLS = opt('symbols', 'BTCUSDT,ETHUSDT').split(',').map((s) => s.trim()).filter(Boolean);
const INTERVALS = opt('intervals', '15m,30m,1h,2h,4h').split(',').filter(Boolean);
const DAYS = Number(opt('days', 150));
const WIN = 500, VALID = 12, MAX_HOLD = 300, MAKER = 0.0002, TAKER = 0.00055;
const OUT = opt('out', 'data/research/coach-improve2.json');
const MS = { '5m': 3e5, '15m': 9e5, '30m': 18e5, '1h': 36e5, '2h': 72e5, '4h': 144e5 };
const toC = (k) => ({ t: k.time / 1000, time: k.time, o: k.open, h: k.high, l: k.low, c: k.close });
const EXITS = ['S', 'T1', 'T15', 'T2', 'P'];

function firstSub(sub, ms) { let lo = 0, hi = sub.length; while (lo < hi) { const m = (lo + hi) >> 1; if (sub[m].time < ms) lo = m + 1; else hi = m; } return lo; }
function fillLimit(sub, startMs, endMs, d, en, tp) {
  for (let i = firstSub(sub, startMs); i < sub.length && sub[i].time < endMs; i++) {
    const k = sub[i];
    if (d > 0 ? k.h >= tp : k.l <= tp) return null;
    if (d > 0 ? k.l <= en : k.h >= en) return { fillI: i, fill: d > 0 ? Math.min(en, k.o) : Math.max(en, k.o), feeIn: MAKER };
  }
  return null;
}
function runExit(sub, fillI, fill, feeIn, d, sl0, tpS, maxMs, ex, sameBar) {
  const risk = d * (fill - sl0); if (!(risk > 0)) return null;
  const at = (R) => fill + d * risk * R;
  const fixed = { T1: 1, T15: 1.5, T2: 2 }[ex];
  const tp = fixed ? at(fixed) : tpS;
  if (!(d * (tp - fill) > 0)) return null;
  let sl = sl0, maxFav = 0, half = false, banked = 0;
  const R = (px, feeOut, part = 1) => part * (d * (px - fill) - fill * feeIn - px * feeOut) / risk;
  for (let u = fillI; u < sub.length; u++) {
    const k = sub[u];
    if (k.time > maxMs) return [banked + R(k.o, TAKER, half ? 0.5 : 1), k.time];
    if (u > fillI || sameBar) {
      if (d > 0 ? k.l <= sl : k.h >= sl) { const px = u === fillI ? sl : (d > 0 ? Math.min(sl, k.o) : Math.max(sl, k.o)); return [banked + R(px, TAKER, half ? 0.5 : 1), k.time]; }
    }
    if (u === fillI) continue;
    if (d > 0 ? k.h >= tp : k.l <= tp) return [banked + R(tp, MAKER, half ? 0.5 : 1), k.time];
    const fav = d > 0 ? (k.h - fill) / risk : (fill - k.l) / risk;
    if (fav > maxFav) maxFav = fav;
    if (ex === 'P' && !half && maxFav >= 1) { half = true; banked = R(at(1), MAKER, 0.5); const be = fill + d * risk * 0.05; if (d * (be - sl) > 0) sl = be; }
  }
  return null;
}

async function main() {
  const now = Date.now(), from = now - DAYS * 864e5;
  const sigs = [];
  let btc4 = null;
  try { const b = (await klines('BTCUSDT', '4h', Math.ceil(DAYS * 6) + 300)).map(toC); btc4 = { c: b.map((k) => k.time + MS['4h']), tr: structure(b, 3, atrOf(b)).trend }; } catch { /* 沒有就算了 */ }
  for (const sym of SYMBOLS) {
    let sub, h4, h1;
    try {
      sub = (await klines(sym, '5m', Math.ceil(DAYS * 288) + 50)).map(toC);
      h4 = (await klines(sym, '4h', Math.ceil(DAYS * 6) + 300)).map(toC);
      h1 = (await klines(sym, '1h', Math.ceil(DAYS * 24) + 300)).map(toC);
    } catch (e) { console.log(`${sym} 抓資料失敗：${e.message}`); continue; }
    const t4 = structure(h4, 3, atrOf(h4)).trend, c4 = h4.map((k) => k.time + MS['4h']);
    const t1 = structure(h1, 3, atrOf(h1)).trend, c1 = h1.map((k) => k.time + MS['1h']);
    const idxAt = (closes, ms) => { let lo = 0, hi = closes.length - 1, r = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (closes[m] <= ms) { r = m; lo = m + 1; } else hi = m - 1; } return r; };
    for (const iv of INTERVALS) {
      let C;
      try { C = (await klines(sym, iv, Math.ceil(DAYS * 864e5 / MS[iv]) + WIN)).map(toC); } catch { console.log(`${sym} ${iv} 抓資料失敗`); continue; }
      const seen = new Set(); let n = 0;
      for (let j = WIN; j < C.length - 1; j++) {
        const closeMs = C[j].time + MS[iv];
        if (closeMs < from) continue;
        const i4 = idxAt(c4, closeMs), bias = i4 >= 0 ? t4[i4] : 0;
        const W = C.slice(j - WIN + 1, j + 1), A = analyze(W, 4, 2), st = coachState(W, A, bias);
        for (const side of ['L', 'S']) {
          const r = st[side];
          if (!r.ready || !(r.plan.rr > 0) || !r.poi) continue;
          const key = side + (r.plan.swU + j - WIN + 1);
          if (seen.has(key)) continue;
          seen.add(key);
          const d = r.d, { en, sl, tp, rr, kind } = r.plan, atr = A.atr[W.length - 1];
          const mid = (r.poi.top + r.poi.bot) / 2;
          const res = {};
          for (const [eKey, eFill] of [
            ['E', () => fillLimit(sub, closeMs, closeMs + VALID * MS[iv], d, en, tp)],
            ['M', () => (d * (mid - sl) > 0 ? fillLimit(sub, closeMs, closeMs + VALID * MS[iv], d, mid, tp) : null)],
            ['K', () => { const i = firstSub(sub, closeMs); return i < sub.length && d * (C[j].c - sl) > 0 ? { fillI: i, fill: sub[i].o, feeIn: TAKER, mkt: true } : null; }],
          ]) {
            const f = eFill(); if (!f) continue;
            for (const [sKey, slv] of [['P', sl], ['W', sl - d * 0.5 * atr]]) {
              for (const ex of EXITS) {
                const x = runExit(sub, f.fillI, f.fill, f.feeIn, d, slv, tp, closeMs + MAX_HOLD * MS[iv], ex, true);
                if (x) res[eKey + sKey + ex] = [Math.round(x[0] * 1000) / 1000, x[1], sub[f.fillI].time];
              }
            }
          }
          if (!Object.keys(res).length) continue;
          const i1 = idxAt(c1, closeMs), ib = btc4 ? idxAt(btc4.c, closeMs) : -1;
          sigs.push({
            sym, iv, dir: d > 0 ? 'long' : 'short', sigMs: closeMs, rr: Math.round(rr * 100) / 100, bias: r.bias, disc: r.disc, kind,
            h1: i1 >= 0 ? t1[i1] * d : 0, btc: ib >= 0 ? btc4.tr[ib] * d : 0, // 1＝同向、-1＝逆向
            sess: (sessionOf(W[r.plan.swU].time) || { id: 'none' }).id, hour: new Date(closeMs + 8 * 3600e3).getUTCHours(),
            atrPct: Math.round(atr / C[j].c * 10000) / 100, stopAtr: Math.round(Math.abs(en - sl) / atr * 100) / 100, res,
          });
          n++;
        }
      }
      console.log(`${sym} ${iv}：${n} 個訊號`);
    }
  }
  fs.mkdirSync('data/research', { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), days: DAYS, symbols: SYMBOLS, intervals: INTERVALS, from, sigs }));
  console.log(`結果存到 ${OUT}，${sigs.length} 個訊號`);
}
main().catch((e) => { console.error(e); process.exit(1); });
