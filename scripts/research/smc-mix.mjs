#!/usr/bin/env node
/**
 * SMC 訊號條件「單項＋兩兩組合」回測（2026-09-28 使用者想知道：FVG＋斐波那契同時出現才進場之類的組合有沒有比較好）
 *
 *   node scripts/research/smc-mix.mjs --symbols=BTCUSDT,ETHUSDT --intervals=30m,1h,4h --limit=5000 --sub=5m --sub-days=150
 *
 * 做法：
 *   1. 跟 ab-test 一樣逐步重算 SMC 引擎（沒有未來函數），收集分數 ≥ --min-score 的訊號，
 *      每個訊號記下：進場區種類（FVG／OB／Breaker…）、進場區有沒有跟其他區塊重疊（FVG／OB／OTE）、
 *      斐波那契回撤位、成交量分布（HVN／價值區邊緣／LVN）、評分表 10 項、多空、BTC 趨勢、市價／限價。
 *   2. 用線上同一套部位管理（DEFAULT_MANAGEMENT）跑兩種進場：
 *        EDGE＝現在的做法（進場區邊緣，第一次碰到就進）
 *        MID ＝改在進場區中間掛單（停損、目標價不變；價格已經在區內的照樣市價）
 *      原週期（5000 根，前後半）和 5 分鐘精準版（最近 --sub-days 天，前後半）四段都算，手續費分掛單／吃單。
 *   3. 每個單項、每兩個條件同時成立的組合，都列出四段的每筆淨 R；
 *      四段都賺、而且精準版前後半各至少 --min-n 筆的組合，照最差那一段排序印出來。
 */

import { analyze } from '../../src/smc/engine.js';
import { ema } from '../../src/core/indicators.js';
import { opt as optFrom, klines, runSignals, r2, pct, printTable, propCompare } from './lib.mjs';

const ARGS = process.argv.slice(2);
const opt = (n, d) => optFrom(ARGS, n, d);
const SYMBOLS = opt('symbols', 'BTCUSDT,ETHUSDT,SOLUSDT,BNBUSDT,XRPUSDT,DOGEUSDT,ADAUSDT,AVAXUSDT,LINKUSDT,LTCUSDT,DOTUSDT,NEARUSDT,APTUSDT,ARBUSDT,OPUSDT').split(',');
const INTERVALS = opt('intervals', '30m,1h,4h').split(',');
const LIMIT = Number(opt('limit', 5000));
const STEP = Number(opt('step', 4));
const WARMUP = Number(opt('warmup', 320));
const MIN_SCORE = Number(opt('min-score', 55));
const LIVE_MIN_SCORE = Number(opt('live-min-score', 65));
const COOLDOWN = Number(opt('cooldown', 12));
const SUB = opt('sub', '5m');
const SUB_DAYS = Number(opt('sub-days', 150));
const MIN_N = Number(opt('min-n', 20));
const MAKER = Number(opt('maker-fee', 0.0002));
const TAKER = Number(opt('taker-fee', 0.00055));
const BTC_EMA = Number(opt('btc-ema', 200));
const log = (...a) => console.log(...a);

const overlaps = (a, b) => a.bottom <= b.top && b.bottom <= a.top;

function collectSignals(candles, symbol, interval) {
  const out = [];
  let cooldownUntil = -1;
  for (let i = WARMUP; i < candles.length - 30; i += STEP) {
    if (i < cooldownUntil) continue;
    let res;
    try { res = analyze(candles.slice(Math.max(0, i - 600), i + 1), {}); } catch { continue; }
    const s = res.setup;
    if (!s || s.none || !s.valid || s.score < MIN_SCORE || !s.targets?.length) continue;
    // 進場區跟同方向的其他區塊有沒有重疊（例如 OB 裡面剛好有 FVG、或落在 OTE 回撤區）
    const others = (res.pois ?? []).filter((p) => p !== s.poi && p.dir === s.poi.dir && overlaps(p, s.poi)).map((p) => p.type);
    out.push({
      symbol, interval, index: i, time: candles[i].time,
      dir: s.dir, entry: s.entry, stop: s.stop, entryType: s.entryType, zone: s.entryZone,
      targets: s.targets.map((t) => ({ name: t.name, price: t.price, rr: t.rr, label: t.label })),
      score: s.score, poiType: s.poi.type, withTypes: others,
      checks: Object.fromEntries((s.checklist ?? []).map((c) => [c.key, c.ok])),
      extras: s.extras ?? {}, tp1R: s.targets[0].rr,
      stopPct: Math.abs(s.entry - s.stop) / s.entry,
      half: i < (WARMUP + candles.length) / 2 ? 0 : 1,
    });
    cooldownUntil = i + COOLDOWN;
  }
  return out;
}

/** 改在進場區中間掛單（價格已經在區內＝市價進場的照舊） */
function midEntry(sig) {
  if (sig.entryType === 'market' || !sig.zone) return sig;
  const entry = sig.zone.mid;
  const long = sig.dir === 'long';
  if (long ? !(entry > sig.stop && entry < sig.entry) : !(entry < sig.stop && entry > sig.entry)) return sig;
  const risk = Math.abs(entry - sig.stop);
  return {
    ...sig, entry, stopPct: risk / entry,
    targets: sig.targets.map((t) => ({ ...t, rr: Math.abs(t.price - entry) / risk })),
    tp1R: Math.abs(sig.targets[0].price - entry) / risk,
  };
}

/** 一進一出的手續費（占倉位價值）：限價進場＝掛單、市價＝吃單；止盈限價＝掛單、停損＝吃單 */
function feeOf(t) {
  const entryFee = t.entryType === 'market' ? TAKER : MAKER;
  const makerExit = t.status === 'target' ? 1 : t.events.filter((e) => e.type === 'target' && e.partial).reduce((a, e) => a + e.partial, 0);
  return entryFee + makerExit * MAKER + (1 - makerExit) * TAKER;
}
const netR = (t) => t.r - feeOf(t) / t.stopPct;

const has = (t, type) => t.poiType === type || t.withTypes.includes(type);
/** 可以拿來組合的條件（都是訊號當下就看得到的） */
const FEATURES = [
  ['進場區是 FVG', (t) => t.poiType === 'FVG'],
  ['進場區是 OB', (t) => t.poiType === 'Order Block'],
  ['進場區是 Breaker', (t) => t.poiType === 'Breaker'],
  ['進場區是反轉 FVG', (t) => t.poiType === 'Inversion FVG'],
  ['進場區是 OTE', (t) => t.poiType === 'OTE'],
  ['有 FVG（本身或重疊）', (t) => has(t, 'FVG')],
  ['有 OB（本身或重疊）', (t) => has(t, 'Order Block')],
  ['有 OTE 回撤區', (t) => has(t, 'OTE')],
  ['斐波那契回撤位在區內', (t) => t.extras.fib != null],
  ['斐波那契 0.618 以上', (t) => t.extras.fib >= 0.618],
  ['高量節點在區內', (t) => !!t.extras.hvn],
  ['價值區邊緣外', (t) => !!t.extras.valueEdge],
  ['不是低量節點', (t) => t.extras.lvn === false],
  ['高週期同向', (t) => t.checks.htfAlign],
  ['結構確認', (t) => t.checks.structure],
  ['折價／溢價側', (t) => t.checks.pdSide],
  ['進場區新鮮', (t) => t.checks.poiFresh],
  ['掃過流動性', (t) => t.checks.sweep],
  ['多重匯流', (t) => t.checks.stacked],
  ['動能同向', (t) => t.checks.momentum],
  ['在 killzone', (t) => t.checks.killzone],
  ['順 BTC 趨勢', (t) => t.withBtc === true],
  ['多單', (t) => t.dir === 'long'],
  ['空單', (t) => t.dir === 'short'],
  ['限價等回踩', (t) => t.entryType !== 'market'],
  ['分數 ≥65', (t) => t.score >= LIVE_MIN_SCORE],
  ['TP1 ≥1.5R', (t) => t.tp1R >= 1.5],
  ['停損 ≥1%', (t) => t.stopPct >= 0.01],
  ...INTERVALS.map((tf) => [`週期 ${tf}`, (t) => t.interval === tf]),
];
// 線上現在的規則：分數 ≥65、TP1 ≥1.5R、BTC 漲勢不做空
const LIVE = (t) => t.score >= LIVE_MIN_SCORE && t.tp1R >= 1.5 && !(t.dir === 'short' && t.btcUp !== false);

(async () => {
  const candlesBy = new Map();
  const signals = [];
  for (const symbol of SYMBOLS) {
    for (const interval of INTERVALS) {
      try {
        const c = await klines(symbol, interval, LIMIT);
        candlesBy.set(`${symbol}|${interval}`, c);
        const s = collectSignals(c, symbol, interval);
        signals.push(...s);
        log(`  ${symbol} ${interval}: ${c.length} 根 → ${s.length} 個訊號`);
      } catch (e) { log(`  ${symbol} ${interval}: 取得資料失敗（${e.message}）`); }
    }
  }
  let subStart = Infinity, subEnd = -Infinity;
  if (SUB) {
    for (const symbol of SYMBOLS) {
      try {
        const c = await klines(symbol, SUB, Math.ceil((SUB_DAYS * 1440) / ({ '1m': 1, '5m': 5, '15m': 15 }[SUB] ?? 5)));
        candlesBy.set(`${symbol}|sub`, c);
        subStart = Math.min(subStart, c[0].time);
        subEnd = Math.max(subEnd, c[c.length - 1].time);
      } catch (e) { log(`  ${symbol} ${SUB}: 取得資料失敗（${e.message}）`); }
    }
  }
  const mid = (subStart + subEnd) / 2;
  // BTC 同週期趨勢（只看訊號那根之前已收盤的 K 棒）
  for (const interval of INTERVALS) {
    const c = candlesBy.get(`BTCUSDT|${interval}`) ?? await klines('BTCUSDT', interval, LIMIT).catch(() => null);
    if (!c) continue;
    const e = ema(c.map((k) => k.close), BTC_EMA);
    for (const sig of signals.filter((x) => x.interval === interval)) {
      let lo = 0, hi = c.length - 1, idx = -1;
      while (lo <= hi) { const m = (lo + hi) >> 1; if (c[m].time <= sig.time) { idx = m; lo = m + 1; } else hi = m - 1; }
      if (idx < 0 || e[idx] == null) continue;
      sig.btcUp = c[idx].close > e[idx];
      sig.withBtc = sig.dir === 'long' ? sig.btcUp : !sig.btcUp;
    }
  }
  log(`\n訊號總數：${signals.length}（分數 ≥${MIN_SCORE}）`);
  if (!signals.length) process.exit(1);

  const weeks = SUB_DAYS / 7;
  // --prop-compare：SMC 訊號在考試規則下多快過關（線上規則、各週期、全部），跟 alt-strategies 同一張表
  if (opt('prop-compare', '') !== '') {
    const traded = (xs) => xs.filter((t) => !(t.status === 'expired' && t.exitReason === 'timeout'));
    const net = (xs) => xs.map((t) => ({ ...t, r: netR(t), filledTime: t.filledTime ?? t.time }));
    const out = [];
    for (const [pn, cfg] of [['原週期 全段', {}], ['5M 精準版', { subBars: true, fillBarPath: true }]]) {
      if (cfg.subBars && !SUB) continue;
      const all = net(traded(runSignals(signals, candlesBy, cfg)));
      const groups = [
        { name: `SMC 全部（分數 ≥${MIN_SCORE}）`, trades: all },
        { name: 'SMC 線上規則', trades: all.filter(LIVE) },
        ...INTERVALS.map((iv) => ({ name: `SMC 線上規則 ${iv}`, trades: all.filter((t) => LIVE(t) && t.interval === iv) })),
      ];
      log(`\n■ 考試規則下誰過關最快（${pn}；${SYMBOLS.length} 檔）`);
      out.push({ period: pn, rows: propCompare(groups, { log }) });
    }
    log('\nPROP_COMPARE_JSON ' + JSON.stringify(out));
    return;
  }
  const summary = [];
  for (const [variant, map] of [['EDGE', (s) => s], ['MID', midEntry]]) {
    const sigs = signals.map(map);
    // 沒成交（限價單等太久過期）的不算；市價進場的沒有 filledTime，用訊號時間分前後半
    const traded = (xs) => xs.filter((t) => !(t.status === 'expired' && t.exitReason === 'timeout'));
    const coarse = traded(runSignals(sigs, candlesBy, {}));
    const fine = SUB ? traded(runSignals(sigs, candlesBy, { subBars: true, fillBarPath: true })) : [];
    const when = (t) => t.filledTime ?? t.time;
    const cells = (f) => {
      const parts = [
        coarse.filter((t) => t.half === 0 && f(t)), coarse.filter((t) => t.half === 1 && f(t)),
        fine.filter((t) => when(t) < mid && f(t)), fine.filter((t) => when(t) >= mid && f(t)),
      ];
      const avg = (xs) => (xs.length ? xs.reduce((a, t) => a + netR(t), 0) / xs.length : NaN);
      const fineAll = [...parts[2], ...parts[3]];
      return {
        f: parts.map(avg), n: parts.map((x) => x.length),
        w: fineAll.length ? fineAll.filter((t) => netR(t) > 0).length / fineAll.length : NaN,
        pw: fineAll.length / weeks,
      };
    };
    const add = (name, f) => summary.push({ v: variant, k: name, ...cells(f) });
    add('全部（分數 ≥55）', () => true);
    add('線上規則', LIVE);
    for (const [name, f] of FEATURES) { add(name, f); add(`線上＋${name}`, (t) => LIVE(t) && f(t)); }
    for (let a = 0; a < FEATURES.length; a++) {
      for (let b = a + 1; b < FEATURES.length; b++) {
        const [na, fa] = FEATURES[a], [nb, fb] = FEATURES[b];
        add(`${na}＋${nb}`, (t) => fa(t) && fb(t));
      }
    }
  }

  const fmt = (r) => [...r.f.map((v, i) => (Number.isNaN(v) ? '-' : `${r2(v)}（${r.n[i]}）`)), Number.isNaN(r.w) ? '-' : pct(r.w * 100), r.pw.toFixed(1)];
  const head = ['原週期前半', '原週期後半', '5M 前半', '5M 後半', '5M 勝率', '5M 每週筆數'];
  const base = summary.filter((r) => ['全部（分數 ≥55）', '線上規則'].includes(r.k));
  log('\n■ 基準（扣手續費每筆 R，括號是筆數）');
  printTable(log, ['進場', '分組', ...head], base.map((r) => [r.v, r.k, ...fmt(r)]));

  for (const v of ['EDGE', 'MID']) {
    const singles = summary.filter((r) => r.v === v && FEATURES.some(([n]) => r.k === n || r.k === `線上＋${n}`));
    log(`\n■ 單項條件（${v}；扣手續費每筆 R，括號是筆數）`);
    printTable(log, ['條件', ...head], singles.map((r) => [r.k, ...fmt(r)]));
  }

  const robust = summary
    .filter((r) => r.f.every((x) => x > 0) && r.n[2] >= MIN_N && r.n[3] >= MIN_N)
    .map((r) => ({ ...r, min: Math.min(...r.f) }))
    .sort((a, b) => b.min - a.min);
  log(`\n■ 四段都賺、精準版前後半各 ≥${MIN_N} 筆的組合（共 ${robust.length} 個／${summary.length} 個，照最差那段排序）`);
  printTable(log, ['進場', '條件', ...head, '最差'], robust.slice(0, 80).map((r) => [r.v, r.k, ...fmt(r), r2(r.min)]));

  log('\nSUMMARY_JSON ' + JSON.stringify(summary.map((r) => ({ v: r.v, k: r.k, f: r.f.map((x) => (Number.isNaN(x) ? null : Math.round(x * 1000) / 1000)), n: r.n, w: Number.isNaN(r.w) ? null : Math.round(r.w * 1000) / 1000, pw: Math.round(r.pw * 10) / 10 }))));
})();
