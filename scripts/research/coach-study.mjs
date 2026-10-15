#!/usr/bin/env node
/**
 * 看盤教室「教練劇本」回測（2026-10-14 使用者想把 Discord 推播改成教練這套、幣種多一點）。
 *
 *   node scripts/research/coach-study.mjs --symbols=BTCUSDT,ETHUSDT --intervals=15m,30m,1h --days=150 --sub=5m
 *
 * 規則在 coach-core.mjs（跟 dojo/ 看盤教室同一套）：掃流動性 → 外部結構轉向 → 留下 FVG／OB → 回踩 → 計畫。
 * 每根 K 棒收盤用最近 WIN 根重算一次（不偷看未來）；同一次掃蕩只出一次訊號。
 * 進場：掛限價在 POI 邊緣，訊號後 VALID 根內碰到才成交；成交前先碰到目標或停損就取消。
 * 出場：停損＝掃出來的極值外 0.15 ATR、目標＝最近還沒被掃的對面擺動點；最多抱 MAX_HOLD 根，到期市價平。
 * 一律用 5 分鐘 K 棒逐根精算（同一根 5m 先算停損）、扣手續費（掛單 0.02%、吃單 0.055%）、前後半段分開。
 *
 * 變體：
 *   all      全部教練訊號（盈虧比 ≥ MIN_RR）
 *   bias     ＋大週期（4h）結構同向
 *   bias+pd  ＋大週期同向＋在折價（做多）／溢價（做空）區
 *   market   跟 all 一樣但在訊號那根收盤直接市價進（重算盈虧比，≥ 1.5 才做）
 */

import fs from 'node:fs';
import { analyze, structure, atrOf, coachState } from './coach-core.mjs';
import { opt as optFrom, klines, printTable } from './lib.mjs';
import { sessionOf } from '../../src/smc/sessions.js';

const ARGS = process.argv.slice(2);
const opt = (n, d) => optFrom(ARGS, n, d);
const SYMBOLS = opt('symbols', 'BTCUSDT,ETHUSDT,XRPUSDT,BNBUSDT,SOLUSDT,DOGEUSDT,ADAUSDT,TRXUSDT,LINKUSDT,AVAXUSDT').split(',').map((s) => s.trim()).filter(Boolean);
const INTERVALS = opt('intervals', '15m,30m,1h').split(',').filter(Boolean);
const DAYS = Number(opt('days', 150));
const SUB = opt('sub', '5m') || '5m';
const HTF = opt('htf', '4h');
const WIN = Number(opt('win', 500));
const VALID = Number(opt('valid', 12));
const MAX_HOLD = Number(opt('max-hold', 300));
const MIN_RR = Number(opt('min-rr', 2));
const MAKER = Number(opt('maker-fee', 0.0002));
const TAKER = Number(opt('taker-fee', 0.00055));
const OUT = opt('out', 'data/research/coach-study.json');
const AFTER_SHIFT = opt('after-shift', '1') === '1'; // 回踩一定要在結構轉向之後（2026-10-15 ADA 15m 推播比顯示晚的問題）
const MS = { '5m': 3e5, '15m': 9e5, '30m': 18e5, '1h': 36e5, '2h': 72e5, '4h': 144e5, '6h': 216e5, '1d': 864e5 };
const log = (...a) => console.log(...a);
const toC = (k) => ({ t: k.time / 1000, time: k.time, o: k.open, h: k.high, l: k.low, c: k.close });

/** 5m 路徑：從 startMs（含）開始，回傳第一根 index */
function firstSub(sub, startMs) { let lo = 0, hi = sub.length; while (lo < hi) { const m = (lo + hi) >> 1; if (sub[m].time < startMs) lo = m + 1; else hi = m; } return lo; }

function simulate(sub, startMs, endValidMs, maxMs, d, en, sl, tp, market) {
  let i = firstSub(sub, startMs), fill = null, fillI = -1;
  if (i >= sub.length) return null;
  if (market) { fill = en; fillI = i - 1; }
  else {
    for (; i < sub.length && sub[i].time < endValidMs; i++) {
      const k = sub[i];
      if (d > 0 ? k.h >= tp : k.l <= tp) return { skip: '先到目標' };
      if (d > 0 ? k.l <= en : k.h >= en) { fill = d > 0 ? Math.min(en, k.o) : Math.max(en, k.o); fillI = i; break; }
    }
    if (fill == null) return i >= sub.length ? null : { skip: '沒成交' };
    const k = sub[fillI];
    if (d > 0 ? k.l <= sl : k.h >= sl) return done(sl, TAKER, '停損', k.time);
  }
  for (let u = fillI + 1; u < sub.length; u++) {
    const k = sub[u];
    if (k.time > maxMs) return done(k.o, TAKER, '到期', k.time);
    if (d > 0 ? k.l <= sl : k.h >= sl) return done(d > 0 ? Math.min(sl, k.o) : Math.max(sl, k.o), TAKER, '停損', k.time);
    if (d > 0 ? k.h >= tp : k.l <= tp) return done(tp, MAKER, '目標', k.time);
  }
  return null; // 還沒結束
  function done(px, feeOut, why, t) {
    const feeIn = market ? TAKER : MAKER, risk = d * (en - sl);
    const r = (d * (px - fill) - fill * feeIn - px * feeOut) / risk;
    return { r, why, fillMs: sub[Math.max(0, fillI)].time, exitMs: t };
  }
}

async function main() {
  const now = Date.now(), from = now - DAYS * 864e5;
  const trades = [];
  for (const sym of SYMBOLS) {
    let sub, htf;
    try {
      sub = (await klines(sym, SUB, Math.ceil(DAYS * 864e5 / MS[SUB]) + 50)).map(toC);
      htf = (await klines(sym, HTF, Math.ceil(DAYS * 864e5 / MS[HTF]) + 300)).map(toC);
    } catch (e) { log(`${sym} 抓資料失敗：${e.message}`); continue; }
    const hTrend = structure(htf, 3, atrOf(htf)).trend;
    const hClose = htf.map((k) => k.time + MS[HTF]);
    for (const iv of INTERVALS) {
      let C;
      try { C = (await klines(sym, iv, Math.ceil(DAYS * 864e5 / MS[iv]) + WIN)).map(toC); } catch (e) { log(`${sym} ${iv} 抓資料失敗`); continue; }
      const seen = new Set(), busy = {};
      let hk = -1, t0 = Date.now(), sigs = 0;
      for (let j = WIN; j < C.length - 1; j++) {
        const closeMs = C[j].time + MS[iv];
        if (closeMs < from) continue;
        while (hk + 1 < htf.length && hClose[hk + 1] <= closeMs) hk++;
        const bias = hk >= 0 ? hTrend[hk] : 0;
        const W = C.slice(j - WIN + 1, j + 1), A = analyze(W, 4, 2), st = coachState(W, A, bias, { afterShift: AFTER_SHIFT });
        for (const side of ['L', 'S']) {
          const r = st[side];
          if (!r.ready) continue;
          const key = side + (r.plan.swU + j - WIN + 1);
          if (seen.has(key)) continue;
          seen.add(key);
          sigs++;
          // 時段：掃蕩那根的開盤時間、訊號（回踩到位那根收盤）的時間各落在哪個時段（UTC，跟 src/smc/sessions.js 一樣）
          const sessId = (ms) => (sessionOf(ms) || { id: 'none' }).id;
          const base = { sym, iv, dir: r.d > 0 ? 'long' : 'short', sigMs: closeMs, rr: r.plan.rr, bias: r.bias, disc: r.disc, kind: r.plan.kind, sess: sessId(W[r.plan.swU].time), sessSig: sessId(closeMs - 1) };
          const variants = [];
          if (r.plan.rr >= MIN_RR) {
            variants.push('all');
            if (r.bias === 2) variants.push('bias');
            if (r.bias === 2 && r.disc) variants.push('bias+pd');
          }
          for (const v of variants) {
            if ((busy[v] || 0) > closeMs) continue;
            const res = simulate(sub, closeMs, closeMs + VALID * MS[iv], closeMs + MAX_HOLD * MS[iv], r.d, r.plan.en, r.plan.sl, r.plan.tp, false);
            if (!res) continue;
            if (res.skip) continue;
            busy[v] = res.exitMs;
            trades.push({ ...base, v, r: Math.round(res.r * 1000) / 1000, why: res.why, fill: res.fillMs });
          }
          /* market: 收盤直接進 */
          const en = C[j].c, rrM = r.d * (r.plan.tp - en) / (r.d * (en - r.plan.sl));
          if (r.d * (en - r.plan.sl) > 0 && rrM >= 1.5 && (busy.market || 0) <= closeMs) {
            const res = simulate(sub, closeMs, 0, closeMs + MAX_HOLD * MS[iv], r.d, en, r.plan.sl, r.plan.tp, true);
            if (res && !res.skip) { busy.market = res.exitMs; trades.push({ ...base, v: 'market', rr: rrM, r: Math.round(res.r * 1000) / 1000, why: res.why, fill: res.fillMs }); }
          }
        }
      }
      log(`${sym} ${iv}：${C.length} 根、教練訊號 ${sigs} 次（${((Date.now() - t0) / 1000).toFixed(0)} 秒）`);
    }
  }

  const mid = from + (now - from) / 2;
  const stat = (list) => {
    const n = list.length; if (!n) return ['0', '-', '-', '-', '-', '-'];
    const w = list.filter((t) => t.r > 0).length, sum = list.reduce((a, t) => a + t.r, 0);
    const gp = list.filter((t) => t.r > 0).reduce((a, t) => a + t.r, 0), gl = -list.filter((t) => t.r < 0).reduce((a, t) => a + t.r, 0);
    return [String(n), (w / n * 100).toFixed(0) + '%', (sum / n).toFixed(3), sum.toFixed(1), gl ? (gp / gl).toFixed(2) : '∞', (n / DAYS).toFixed(1)];
  };
  const V = ['all', 'bias', 'bias+pd', 'market'];
  log(`\n● 回踩規則：${AFTER_SHIFT ? '一定要在結構轉向之後（新）' : 'POI 形成後碰到就算（原本）'}`);
  log(`\n● 教練劇本回測：${SYMBOLS.length} 檔 × ${INTERVALS.join('/')}，最近 ${DAYS} 天，${SUB} 精算、扣手續費`);
  printTable(log, ['變體', '筆數', '勝率', '平均R', '總R', '獲利因子', '每天幾筆'], V.map((v) => [v, ...stat(trades.filter((t) => t.v === v))]));
  log('\n● 前半段／後半段（看是不是兩段都成立）');
  printTable(log, ['變體', '前半 筆數', '前半 平均R', '後半 筆數', '後半 平均R'], V.map((v) => {
    const a = trades.filter((t) => t.v === v && t.fill < mid), b = trades.filter((t) => t.v === v && t.fill >= mid);
    const avg = (l) => l.length ? (l.reduce((x, t) => x + t.r, 0) / l.length).toFixed(3) : '-';
    return [v, String(a.length), avg(a), String(b.length), avg(b)];
  }));
  log('\n● 各週期（變體 bias）');
  printTable(log, ['週期', '筆數', '勝率', '平均R', '總R', '獲利因子', '每天幾筆'], INTERVALS.map((iv) => [iv, ...stat(trades.filter((t) => t.v === 'bias' && t.iv === iv))]));
  const SESS = [['asia', '亞洲盤 UTC0-6'], ['london', '倫敦殺區 UTC7-10'], ['nyam', '紐約早盤 UTC12-15'], ['nypm', '紐約午盤 UTC17:30-20'], ['none', '非時段']];
  const KZ = ['london', 'nyam', 'nypm'];
  for (const v of ['all', 'bias']) {
    log(`\n● 掃蕩發生的時段（變體 ${v}）`);
    printTable(log, ['時段', '筆數', '勝率', '平均R', '總R', '獲利因子', '每天幾筆', '前半 平均R', '後半 平均R'], [...SESS, ['kz', '三個殺區合計'], ['notkz', '殺區以外合計']].map(([id, nm]) => {
      const list = trades.filter((t) => t.v === v && (id === 'kz' ? KZ.includes(t.sess) : id === 'notkz' ? !KZ.includes(t.sess) : t.sess === id));
      const avg = (l) => l.length ? (l.reduce((x, t) => x + t.r, 0) / l.length).toFixed(3) : '-';
      return [nm, ...stat(list), avg(list.filter((t) => t.fill < mid)), avg(list.filter((t) => t.fill >= mid))];
    }));
    log(`\n● 訊號（回踩到位）的時段（變體 ${v}）`);
    printTable(log, ['時段', '筆數', '勝率', '平均R', '總R', '獲利因子', '每天幾筆'], SESS.map(([id, nm]) => [nm, ...stat(trades.filter((t) => t.v === v && t.sessSig === id))]));
  }
  log('\n● 各幣（變體 bias）');
  printTable(log, ['幣', '筆數', '勝率', '平均R', '總R', '獲利因子', '每天幾筆'], SYMBOLS.map((s) => [s, ...stat(trades.filter((t) => t.v === 'bias' && t.sym === s))]));

  fs.mkdirSync('data/research', { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), afterShift: AFTER_SHIFT, days: DAYS, symbols: SYMBOLS, intervals: INTERVALS, sub: SUB, htf: HTF, minRR: MIN_RR, trades }, null, 0));
  log(`\n結果存到 ${OUT}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
