#!/usr/bin/env node
/**
 * 多週期 SMC（src/smc/mtf-plan.js：日線 → 4h → 1h → 15m、PO3／MMXM 當進場條件、成交量分布抓進出場）回測。
 *
 *   node scripts/research/mtf-smc.mjs --symbols=BTCUSDT,ETHUSDT --days=365 --sub=5m --sub-days=150
 *
 * 做法：每根 1h 收盤時，只用「當下已收盤」的日線／4h／1h／15m 重算一次計畫（沒有未來函數）；
 * 同一段「掃流動性＋結構轉向」只算一個訊號。訊號用線上同一套部位管理（DEFAULT_MANAGEMENT）在 15m K 棒上跑，
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
  const signals = [];
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
    const seen = new Set();
    let n = 0;
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
      if (seen.has(plan.id)) continue;
      seen.add(plan.id);
      n++;
      signals.push({
        symbol, interval: '15m', index: i15, time: t,
        dir: plan.dir, entry: plan.entry, stop: plan.stop, entryType: plan.entryType,
        targets: plan.targets.map((x) => ({ name: x.name, price: x.price, rr: x.rr, label: x.label })),
        stopPct: plan.risk / plan.entry, grade: plan.grade, score: plan.score, poiType: plan.poi.type,
        entryNode: plan.entryNode, expansion: plan.po3.expansion,
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
    log(`  ${symbol}：${n} 個訊號`);
  }
  log(`\n訊號總數：${signals.length}；每小時重算時沒有計畫的原因：${JSON.stringify(stageCount)}`);
  if (!signals.length) { log('\nMTF_JSON {}'); return; }

  const firstT = Math.min(...signals.map((s) => s.time));
  const lastT = Math.max(...signals.map((s) => s.time));
  const midT = (firstT + lastT) / 2;
  const subMid = (subStart + subEnd) / 2;
  const traded = (xs) => xs.filter((t) => !(t.status === 'expired' && t.exitReason === 'timeout'));
  const net = (xs) => xs.map((t) => ({ ...t, r: netR(t), filledTime: t.filledTime ?? t.time }));
  const coarse = net(traded(runSignals(signals, candlesBy, {})));
  const fine = SUB ? net(traded(runSignals(signals, candlesBy, { subBars: true, fillBarPath: true }))) : [];
  const unfilled = signals.length - traded(runSignals(signals, candlesBy, {})).length;

  const stat = (xs) => {
    if (!xs.length) return { n: 0 };
    const avg = xs.reduce((a, t) => a + t.r, 0) / xs.length;
    return { n: xs.length, avg, win: xs.filter((t) => t.r > 0).length / xs.length, sum: xs.reduce((a, t) => a + t.r, 0) };
  };
  const cell = (s) => (s.n ? `${r2(s.avg)}（${s.n}，勝率 ${pct(s.win * 100)}）` : '-');
  const groups = [
    ['全部', () => true],
    ['多單', (t) => t.dir === 'long'],
    ['空單', (t) => t.dir === 'short'],
    ['掛單（成交量節點）', (t) => t.entryType === 'limit'],
    ['市價', (t) => t.entryType === 'market'],
    ['A+／A 級', (t) => t.grade === 'A+' || t.grade === 'A'],
    ['B 級以下', (t) => !(t.grade === 'A+' || t.grade === 'A')],
    ['已擴張才進', (t) => t.expansion],
    ['還在吸籌區間內', (t) => !t.expansion],
  ];
  const rows = [];
  const json = [];
  for (const [name, f] of groups) {
    const four = [
      stat(coarse.filter((t) => t.filledTime < midT && f(t))),
      stat(coarse.filter((t) => t.filledTime >= midT && f(t))),
      stat(fine.filter((t) => t.filledTime < subMid && f(t))),
      stat(fine.filter((t) => t.filledTime >= subMid && f(t))),
    ];
    rows.push([name, ...four.map(cell)]);
    json.push({ g: name, f: four.map((s) => (s.n ? Math.round(s.avg * 1000) / 1000 : null)), n: four.map((s) => s.n) });
  }
  const weeks = (lastT - firstT) / (7 * D1);
  log(`\n■ 多週期 SMC（${SYMBOLS.length} 檔、約 ${DAYS} 天；每週約 ${(signals.length / weeks).toFixed(1)} 個訊號，其中限價沒成交 ${unfilled} 個）`);
  log('  每格＝每筆淨 R（扣手續費）、筆數、勝率；5M＝最近幾個月用 5 分鐘 K 棒精算');
  printTable(log, ['分組', '原週期 前半', '原週期 後半', '5M 前半', '5M 後半'], rows);

  log('\n■ 考試規則下的過關速度');
  const prop = propCompare([
    { name: '多週期 SMC（原週期）', trades: coarse },
    { name: '多週期 SMC（5M 精準版）', trades: fine },
  ], { log });

  log('\nMTF_JSON ' + JSON.stringify({ signals: signals.length, unfilled, stages: stageCount, groups: json, prop }));
})();
