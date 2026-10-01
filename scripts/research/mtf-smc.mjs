#!/usr/bin/env node
/**
 * 多週期 SMC（src/smc/mtf-plan.js：日線 → 4h → 1h → 15m 四層同向才進場、PO3／MMXM 加分、成交量分布抓進出場）回測。
 *
 *   node scripts/research/mtf-smc.mjs --symbols=BTCUSDT,ETHUSDT --days=365 --sub=5m --sub-days=150
 *
 * 做法：每根 1h 收盤時，只用「當下已收盤」的日線／4h／1h／15m 重算一次計畫（沒有未來函數）。
 * 同時比較幾種去重／進場版本（VARIANTS）：上次的「同一個極值」去重、同一個 4h 區只做一次、
 * 再加「15m（和 1h）轉向要發生在碰到進場區之後」、再加「同一個幣一次只做一單」。訊號用線上同一套部位管理（DEFAULT_MANAGEMENT）在 15m K 棒上跑，
 * 最近 --sub-days 天另外用 5 分鐘 K 棒精算（限價單成交那根不偷看）。手續費：掛單 0.02%、吃單 0.055%。
 * 印出前後半段、5M 精準版前後半段的每筆淨 R，以及考試規則下的過關速度（跟舊版 SMC、順勢策略同一張表）。
 */

import { buildMtfPlan } from '../../src/smc/mtf-plan.js';
import { analyze } from '../../src/smc/engine.js';
import { opt as optFrom, klines, runSignals, r2, pct, printTable, propCompare } from './lib.mjs';

const ARGS = process.argv.slice(2);
const opt = (n, d) => optFrom(ARGS, n, d);
const SYMBOLS = opt('symbols', 'BTCUSDT,ETHUSDT,XRPUSDT,BNBUSDT,SOLUSDT,DOGEUSDT,ADAUSDT,TRXUSDT,LINKUSDT,AVAXUSDT').split(',').filter(Boolean);
const DAYS = Number(opt('days', 365));
const SUB = opt('sub', '5m');
const SUB_DAYS = Number(opt('sub-days', 150));
const MAKER = Number(opt('maker-fee', 0.0002));
const TAKER = Number(opt('taker-fee', 0.00055));
const log = (...a) => console.log(...a);

const HOUR = 3_600_000, M15 = 900_000, H4 = 4 * HOUR, D1 = 24 * HOUR;

/** 要比較的版本：key＝去重用哪個 id；ok＝額外條件；oneAtATime＝同一個幣上一單結束前不開新單 */
const VARIANTS = [
  { name: '① 上次版本（同一個極值去重）', key: 'touchId', ok: () => true },
  { name: '② 同一個 4h 區只做一次', key: 'id', ok: () => true },
  { name: '③ ②＋15m 碰區後才轉向', key: 'id', ok: (p) => p.fresh.m15 },
  { name: '④ ③＋1h 也碰區後才轉向', key: 'id', ok: (p) => p.fresh.m15 && p.fresh.h1 },
  { name: '⑤ ③＋同一個幣一次一單', key: 'id', ok: (p) => p.fresh.m15, oneAtATime: true },
];

/** 最後一根「在 t 之前已經收盤」的 K 棒位置 */
function closedIdx(list, ms, t) {
  let lo = 0, hi = list.length - 1, idx = -1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (list[m].time + ms <= t) { idx = m; lo = m + 1; } else hi = m - 1;
  }
  return idx;
}

function feeOf(t) {
  const entryFee = t.entryType === 'market' ? TAKER : MAKER;
  const makerExit = t.status === 'target' ? 1 : t.events.filter((e) => e.type === 'target' && e.partial).reduce((a, e) => a + e.partial, 0);
  return entryFee + makerExit * MAKER + (1 - makerExit) * TAKER;
}
const netR = (t) => t.r - feeOf(t) / t.stopPct;

(async () => {
  const candlesBy = new Map();
  const signalsBy = VARIANTS.map(() => []);
  const stageCount = {};
  let subStart = Infinity, subEnd = -Infinity;
  for (const symbol of SYMBOLS) {
    let d1, h4, h1, m15;
    try {
      d1 = await klines(symbol, '1d', DAYS + 420);
      h4 = await klines(symbol, '4h', DAYS * 6 + 520);
      h1 = await klines(symbol, '1h', DAYS * 24 + 520);
      m15 = await klines(symbol, '15m', DAYS * 96 + 420);
    } catch (e) { log(`  ${symbol}: 取得資料失敗（${e.message}）`); continue; }
    candlesBy.set(`${symbol}|15m`, m15);
    const cacheD = new Map();
    const cacheH4 = new Map();
    const seen = VARIANTS.map(() => new Set());
    const counts = VARIANTS.map(() => 0);
    const start = Math.max(m15[400]?.time ?? Infinity, h1[500]?.time ?? Infinity, h4[120]?.time ?? Infinity, d1[80]?.time ?? Infinity);
    const end = m15[m15.length - 1].time;
    for (let t = Math.ceil(start / HOUR) * HOUR; t <= end; t += HOUR) {
      const iD = closedIdx(d1, D1, t), i4 = closedIdx(h4, H4, t), i1 = closedIdx(h1, HOUR, t), i15 = closedIdx(m15, M15, t);
      if (iD < 60 || i4 < 100 || i1 < 100 || i15 < 50) continue;
      const tf = {
        d1: d1.slice(Math.max(0, iD - 399), iD + 1),
        h4: h4.slice(Math.max(0, i4 - 499), i4 + 1),
        h1: h1.slice(Math.max(0, i1 - 499), i1 + 1),
        m15: m15.slice(Math.max(0, i15 - 399), i15 + 1),
      };
      // 日線、4h 的分析只在新 K 棒收盤時重算（跟線上一樣，同一根收盤前結果不變）
      let aD = cacheD.get(iD);
      if (!aD) { aD = analyze(tf.d1); cacheD.clear(); cacheD.set(iD, aD); }
      const k4 = `${iD}|${i4}`;
      let a4 = cacheH4.get(k4);
      if (!a4) { a4 = analyze(tf.h4, { htfBias: aD.bias }); cacheH4.clear(); cacheH4.set(k4, a4); }
      const plan = buildMtfPlan(tf, { cache: { d1: aD, h4: a4 } });
      if (plan.none) { stageCount[plan.stage] = (stageCount[plan.stage] ?? 0) + 1; continue; }
      if (!plan.valid) { stageCount.invalid = (stageCount.invalid ?? 0) + 1; continue; }
      const sig = {
        symbol, interval: '15m', index: i15, time: t,
        dir: plan.dir, entry: plan.entry, stop: plan.stop, entryType: plan.entryType,
        targets: plan.targets.map((x) => ({ name: x.name, price: x.price, rr: x.rr, label: x.label })),
        stopPct: plan.risk / plan.entry, grade: plan.grade, score: plan.score, poiType: plan.poi.type,
        entryNode: plan.entryNode, po3Hit: !!plan.po3.po3, mmxmHit: !!plan.po3.mmxm,
      };
      VARIANTS.forEach((v, k) => {
        if (!v.ok(plan) || seen[k].has(plan[v.key])) return;
        seen[k].add(plan[v.key]);
        counts[k]++;
        signalsBy[k].push(sig);
      });
    }
    if (SUB) {
      try {
        const s = await klines(symbol, SUB, Math.ceil((SUB_DAYS * 1440) / ({ '1m': 1, '5m': 5, '15m': 15 }[SUB] ?? 5)));
        candlesBy.set(`${symbol}|sub`, s);
        subStart = Math.min(subStart, s[0].time);
        subEnd = Math.max(subEnd, s[s.length - 1].time);
      } catch (e) { log(`  ${symbol} ${SUB}: 取得資料失敗（${e.message}）`); }
    }
    log(`  ${symbol}：${VARIANTS.map((v, k) => `${v.name.slice(0, 1)} ${counts[k]}`).join('、')} 個訊號`);
  }
  log(`\n每小時重算時沒有計畫的原因：${JSON.stringify(stageCount)}`);
  if (!signalsBy[0].length) { log('\nMTF_JSON {}'); return; }

  const all = signalsBy.flat();
  const firstT = Math.min(...all.map((s) => s.time));
  const lastT = Math.max(...all.map((s) => s.time));
  const midT = (firstT + lastT) / 2;
  const subMid = (subStart + subEnd) / 2;
  const weeks = (lastT - firstT) / (7 * D1);
  const traded = (xs) => xs.filter((t) => !(t.status === 'expired' && t.exitReason === 'timeout'));
  const net = (xs) => xs.map((t) => ({ ...t, r: netR(t), filledTime: t.filledTime ?? t.time }));
  // 同一個幣上一單還沒結束（掛單沒成交也算還在等）就不接新訊號
  const oneAtATime = (xs) => {
    const busy = new Map();
    return [...xs].sort((a, b) => a.time - b.time).filter((t) => {
      if ((busy.get(t.symbol) ?? -Infinity) > t.time) return false;
      busy.set(t.symbol, t.closedTime ?? t.time);
      return true;
    });
  };

  const stat = (xs) => {
    if (!xs.length) return { n: 0 };
    const avg = xs.reduce((a, t) => a + t.r, 0) / xs.length;
    return { n: xs.length, avg, win: xs.filter((t) => t.r > 0).length / xs.length, sum: xs.reduce((a, t) => a + t.r, 0) };
  };
  const cell = (s) => (s.n ? `${r2(s.avg)}（${s.n}，勝率 ${pct(s.win * 100)}）` : '-');
  const halves = (coarse, fine, f) => [
    stat(coarse.filter((t) => t.filledTime < midT && f(t))),
    stat(coarse.filter((t) => t.filledTime >= midT && f(t))),
    stat(fine.filter((t) => t.filledTime < subMid && f(t))),
    stat(fine.filter((t) => t.filledTime >= subMid && f(t))),
  ];
  const groups = [
    ['全部', () => true],
    ['多單', (t) => t.dir === 'long'],
    ['空單', (t) => t.dir === 'short'],
    ['掛單（成交量節點）', (t) => t.entryType === 'limit'],
    ['市價', (t) => t.entryType === 'market'],
    ['A+／A 級', (t) => t.grade === 'A+' || t.grade === 'A'],
    ['B 級以下', (t) => !(t.grade === 'A+' || t.grade === 'A')],
    ['有 PO3', (t) => t.po3Hit],
    ['有造市者模型（MMXM）', (t) => t.mmxmHit],
    ['PO3／MMXM 都沒有', (t) => !t.po3Hit && !t.mmxmHit],
  ];

  const summary = [];
  const json = [];
  const propGroups = [];
  VARIANTS.forEach((v, k) => {
    const signals = signalsBy[k];
    if (!signals.length) { summary.push([v.name, '0', '-', '-', '-', '-']); return; }
    let coarse = net(traded(runSignals(signals, candlesBy, {})));
    let fine = SUB ? net(traded(runSignals(signals, candlesBy, { subBars: true, fillBarPath: true }))) : [];
    if (v.oneAtATime) { coarse = oneAtATime(coarse); fine = oneAtATime(fine); }
    const perWeek = (v.oneAtATime ? coarse.length : signals.length) / weeks;
    const all4 = halves(coarse, fine, () => true);
    summary.push([v.name, perWeek.toFixed(1), ...all4.map(cell)]);
    const rows = groups.map(([name, f]) => [name, ...halves(coarse, fine, f).map(cell)]);
    log(`\n■ ${v.name}：每週約 ${perWeek.toFixed(1)} 個訊號`);
    printTable(log, ['分組', '原週期 前半', '原週期 後半', '5M 前半', '5M 後半'], rows);
    json.push({
      v: v.name, perWeek: Math.round(perWeek * 10) / 10,
      groups: groups.map(([name, f]) => ({ g: name, f: halves(coarse, fine, f).map((s) => (s.n ? Math.round(s.avg * 1000) / 1000 : null)), n: halves(coarse, fine, f).map((s) => s.n) })),
    });
    propGroups.push({ name: `${v.name.slice(0, 1)} 原週期`, trades: coarse }, { name: `${v.name.slice(0, 1)} 5M`, trades: fine });
  });

  log('\n■ 各版本總表（每格＝每筆淨 R（扣手續費）、筆數、勝率；5M＝最近幾個月用 5 分鐘 K 棒精算）');
  printTable(log, ['版本', '每週訊號', '原週期 前半', '原週期 後半', '5M 前半', '5M 後半'], summary);

  log('\n■ 考試規則下的過關速度');
  const prop = propCompare(propGroups, { log });

  log('\nMTF_JSON ' + JSON.stringify({ stages: stageCount, variants: json, prop }));
})();
