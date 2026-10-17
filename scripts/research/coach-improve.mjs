#!/usr/bin/env node
/**
 * 教練劇本「怎麼改比較好」研究（2026-10-17 使用者：教練最近戰績很差，想辦法把勝率、戰績拉上來）。
 *
 * 訊號跟線上一樣（src/smc/coach.js，回踩在結構轉向之後），每個訊號用 5 分鐘 K 棒把好幾種出場方式都跑一遍，
 * 全部存成 JSON，篩選條件（順逆勢、週期、盈虧比、同方向張數上限…）之後在本機組合比較：
 *   S    原本：結構目標（最近還沒被掃的對面擺動點）
 *   T1／T15／T2／T3   固定 1R／1.5R／2R／3R 止盈
 *   SB   結構目標，賺到 1R 停損移到成本＋0.05R
 *   P    賺到 1R 先平一半、停損移成本，另一半照結構目標
 *   TR   不設止盈，賺到 1R 保本、1.5R 之後停損追在「最高獲利 − 1R」
 * 進場：掛限價在 POI 邊緣（跟線上一樣），訊號後 VALID 根內碰到才成交；成交前先到結構目標就取消。
 * 扣手續費（掛單 0.02%、吃單 0.055%），同一根 5m 先算停損。
 *
 *   node scripts/research/coach-improve.mjs --symbols=... --intervals=15m,30m,1h --days=150 --out=data/research/coach-improve-g1.json
 */
import fs from 'node:fs';
import { analyze, structure, atrOf, coachState } from './coach-core.mjs';
import { opt as optFrom, klines } from './lib.mjs';
import { sessionOf } from '../../src/smc/sessions.js';

const ARGS = process.argv.slice(2);
const opt = (n, d) => optFrom(ARGS, n, d);
const SYMBOLS = opt('symbols', 'BTCUSDT,ETHUSDT').split(',').map((s) => s.trim()).filter(Boolean);
const INTERVALS = opt('intervals', '15m,30m,1h').split(',').filter(Boolean);
const DAYS = Number(opt('days', 150));
const SUB = opt('sub', '5m') || '5m';
const WIN = 500, VALID = 12, MAX_HOLD = 300, MAKER = 0.0002, TAKER = 0.00055;
const OUT = opt('out', 'data/research/coach-improve.json');
const MS = { '5m': 3e5, '15m': 9e5, '30m': 18e5, '1h': 36e5, '4h': 144e5 };
const toC = (k) => ({ t: k.time / 1000, time: k.time, o: k.open, h: k.high, l: k.low, c: k.close });
const EXITS = ['S', 'T1', 'T15', 'T2', 'T3', 'SB', 'P', 'TR'];

function firstSub(sub, ms) { let lo = 0, hi = sub.length; while (lo < hi) { const m = (lo + hi) >> 1; if (sub[m].time < ms) lo = m + 1; else hi = m; } return lo; }

/** 限價成交：回傳 { fillI, fill } 或 { skip } */
function fillLimit(sub, startMs, endMs, d, en, tp) {
  for (let i = firstSub(sub, startMs); i < sub.length && sub[i].time < endMs; i++) {
    const k = sub[i];
    if (d > 0 ? k.h >= tp : k.l <= tp) return { skip: '先到目標' };
    if (d > 0 ? k.l <= en : k.h >= en) return { fillI: i, fill: d > 0 ? Math.min(en, k.o) : Math.max(en, k.o) };
  }
  return { skip: '沒成交' };
}

/** 成交後照某種出場方式走，回傳 { r, why, exitMs } 或 null（資料不夠） */
function runExit(sub, fillI, fill, d, sl0, tpS, maxMs, ex) {
  const risk = d * (fill - sl0); if (!(risk > 0)) return null;
  const at = (R) => fill + d * risk * R;
  const fixed = { T1: 1, T15: 1.5, T2: 2, T3: 3 }[ex];
  const tp = fixed ? at(fixed) : ex === 'TR' ? null : tpS;
  let sl = sl0, maxFav = 0, half = false, banked = 0;
  const R = (px, feeOut, part = 1) => part * (d * (px - fill) - fill * MAKER - px * feeOut) / risk;
  for (let u = fillI; u < sub.length; u++) {
    const k = sub[u];
    if (k.time > maxMs) return { r: banked + R(k.o, TAKER, half ? 0.5 : 1), why: '到期', exitMs: k.time };
    const slHit = d > 0 ? k.l <= sl : k.h >= sl;
    if (slHit) { const px = u === fillI ? sl : (d > 0 ? Math.min(sl, k.o) : Math.max(sl, k.o)); return { r: banked + R(px, TAKER, half ? 0.5 : 1), why: sl === sl0 ? '停損' : '保本／追蹤', exitMs: k.time }; }
    if (u > fillI && tp != null && (d > 0 ? k.h >= tp : k.l <= tp)) return { r: banked + R(tp, MAKER, half ? 0.5 : 1), why: '目標', exitMs: k.time };
    if (u === fillI) continue;
    const fav = d > 0 ? (k.h - fill) / risk : (fill - k.l) / risk;
    if (fav > maxFav) maxFav = fav;
    if (ex === 'P' && !half && maxFav >= 1) { half = true; banked = R(at(1), MAKER, 0.5); }
    if ((ex === 'SB' || ex === 'P' || ex === 'TR') && maxFav >= 1) { const be = fill + d * risk * 0.05; if (d * (be - sl) > 0) sl = be; }
    if (ex === 'TR' && maxFav >= 1.5) { const t = at(maxFav - 1); if (d * (t - sl) > 0) sl = t; }
  }
  return null;
}

async function main() {
  const now = Date.now(), from = now - DAYS * 864e5;
  const sigs = [];
  for (const sym of SYMBOLS) {
    let sub, htf;
    try {
      sub = (await klines(sym, SUB, Math.ceil(DAYS * 864e5 / MS[SUB]) + 50)).map(toC);
      htf = (await klines(sym, '4h', Math.ceil(DAYS * 864e5 / MS['4h']) + 300)).map(toC);
    } catch (e) { console.log(`${sym} 抓資料失敗：${e.message}`); continue; }
    const hTrend = structure(htf, 3, atrOf(htf)).trend, hClose = htf.map((k) => k.time + MS['4h']);
    for (const iv of INTERVALS) {
      let C;
      try { C = (await klines(sym, iv, Math.ceil(DAYS * 864e5 / MS[iv]) + WIN)).map(toC); } catch { console.log(`${sym} ${iv} 抓資料失敗`); continue; }
      const seen = new Set(); let hk = -1, n = 0;
      for (let j = WIN; j < C.length - 1; j++) {
        const closeMs = C[j].time + MS[iv];
        if (closeMs < from) continue;
        while (hk + 1 < htf.length && hClose[hk + 1] <= closeMs) hk++;
        const bias = hk >= 0 ? hTrend[hk] : 0;
        const W = C.slice(j - WIN + 1, j + 1), A = analyze(W, 4, 2), st = coachState(W, A, bias);
        for (const side of ['L', 'S']) {
          const r = st[side];
          if (!r.ready || !(r.plan.rr > 0)) continue;
          const key = side + (r.plan.swU + j - WIN + 1);
          if (seen.has(key)) continue;
          seen.add(key);
          const { en, sl, tp, rr, kind } = r.plan, d = r.d;
          const f = fillLimit(sub, closeMs, closeMs + VALID * MS[iv], d, en, tp);
          if (f.skip) continue;
          const res = {};
          for (const ex of EXITS) { const x = runExit(sub, f.fillI, f.fill, d, sl, tp, closeMs + MAX_HOLD * MS[iv], ex); if (x) res[ex] = [Math.round(x.r * 1000) / 1000, x.why, x.exitMs]; }
          if (!res.S) continue;
          const atr = A.atr[W.length - 1];
          sigs.push({
            sym, iv, dir: d > 0 ? 'long' : 'short', sigMs: closeMs, fillMs: sub[f.fillI].time, rr: Math.round(rr * 100) / 100, bias: r.bias, disc: r.disc, kind,
            sess: (sessionOf(W[r.plan.swU].time) || { id: 'none' }).id, sessSig: (sessionOf(closeMs - 1) || { id: 'none' }).id,
            stopAtr: Math.round(Math.abs(en - sl) / atr * 100) / 100, stopPct: Math.round(Math.abs(en - sl) / en * 10000) / 100, res,
          });
          n++;
        }
      }
      console.log(`${sym} ${iv}：${n} 筆成交的訊號`);
    }
  }
  fs.mkdirSync('data/research', { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), days: DAYS, symbols: SYMBOLS, intervals: INTERVALS, exits: EXITS, from, sigs }));
  const avg = (ex, l) => (l.length ? l.reduce((a, s) => a + s.res[ex][0], 0) / l.length : 0);
  for (const ex of EXITS) { const l = sigs.filter((s) => s.res[ex]); console.log(`${ex}：${l.length} 筆 平均 ${avg(ex, l).toFixed(3)}R 勝率 ${Math.round(l.filter((s) => s.res[ex][0] > 0).length / l.length * 100)}%`); }
  console.log(`結果存到 ${OUT}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
