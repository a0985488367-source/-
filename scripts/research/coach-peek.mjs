#!/usr/bin/env node
/**
 * 看一個幣現在的教練狀態（15m／30m／1h／4h）：結構方向、最近高低點、多空劇本走到第幾步、計畫價位。
 * 用法：node scripts/research/coach-peek.mjs --sym=TRUMPUSDT
 * 只是描述現在的結構，不是預測。
 */
import { PROVIDERS } from '../../src/data/providers.js';
import { pagedKlines, klines as anyK, opt } from './lib.mjs';
import { analyze, structure, atrOf, coachState, coachFollow } from '../../src/smc/coach.js';

const sym = opt(process.argv, 'sym', 'TRUMPUSDT');
const MS = { '15m': 9e5, '30m': 18e5, '1h': 36e5, '4h': 144e5 };
const get = (iv, n) => pagedKlines(PROVIDERS.bybit, sym, iv, n).catch(() => anyK(sym, iv, n));
const toW = (rows, ms) => rows.filter((c) => c.time + ms <= Date.now()).map((c) => ({ t: c.time / 1000, o: +c.open, h: +c.high, l: +c.low, c: +c.close }));
const f = (p) => (p == null ? '—' : +p.toPrecision(5));
const tpe = (s) => new Date(s * 1000 + 8 * 3600e3).toISOString().slice(5, 16).replace('T', ' ');
const out = [];
const H = toW(await get('4h', 300), MS['4h']);
const htr = structure(H, 3, atrOf(H)).trend;
const bias = htr[H.length - 1] || 0;
const last = await get('15m', 2);
out.push(`${sym} 現價 ${f(+last.at(-1).close)}｜4h 結構：${bias > 0 ? '偏多' : bias < 0 ? '偏空' : '未定'}｜4h 近 30 根高 ${f(Math.max(...H.slice(-30).map((k) => k.h)))} 低 ${f(Math.min(...H.slice(-30).map((k) => k.l)))}`);
for (const iv of ['15m', '30m', '1h']) {
  const W = toW(await get(iv, 501), MS[iv]).slice(-500);
  const A = analyze(W, 4, 2), st = coachState(W, A, bias);
  const tr = structure(W, 3, atrOf(W)).trend[W.length - 1] || 0;
  out.push(`— ${iv}：結構${tr > 0 ? '偏多' : tr < 0 ? '偏空' : '未定'}，最近 20 根高 ${f(Math.max(...W.slice(-20).map((k) => k.h)))} 低 ${f(Math.min(...W.slice(-20).map((k) => k.l)))}`);
  for (const s of ['L', 'S']) {
    const r = st[s], fo = coachFollow(W, A, r), p = fo.plan;
    out.push(`   ${s === 'L' ? '多' : '空'}單劇本：${r.ready ? 5 : r.stage}/5 ${fo.status}${r.sweep ? `・掃 ${f(r.sweep.p)}@${tpe(W[r.sweep.u].t)}` : ''}${p ? `・進 ${f(p.en)} 停 ${f(p.sl)} 目 ${f(p.tp)}（${p.rr.toFixed(1)}R）` : ''}${fo.cur != null ? `・現在 ${fo.cur.toFixed(2)}R` : ''}｜下一個：多等掃 ${f(fo.next.ssl)}、空等掃 ${f(fo.next.bsl)}`);
  }
}
for (const l of out) console.log(l);
const enc = (x) => x.replace(/%/g, '%25').replace(/\n/g, '%0A');
console.log(`::notice title=${sym} 教練狀態::${enc(out.join('\n'))}`);
