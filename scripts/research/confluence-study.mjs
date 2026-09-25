/**
 * 斐波那契／成交量分布匯流實測
 *
 *   node scripts/research/confluence-study.mjs --symbols=BTCUSDT,ETHUSDT --intervals=30m,1h,4h
 *
 * 用逐步重算產生歷史訊號（沒有未來函數），每個訊號記下 setup.extras 的匯流旗標，
 * 全部用線上同一套部位管理規則（DEFAULT_MANAGEMENT）跑完，再依旗標分組比較。
 * 目的是先證明這些條件真的能分出好壞訊號，再決定要不要計入分數或當下單過濾。
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { analyze } from '../../src/smc/engine.js';
import { DEFAULT_MANAGEMENT } from '../../src/smc/manage.js';
import { opt as optFrom, klines, runSignals, summarize, pct, r2, printTable } from './lib.mjs';

const ARGS = process.argv.slice(2);
const opt = (n, d) => optFrom(ARGS, n, d);

const SYMBOLS = opt('symbols', 'BTCUSDT,ETHUSDT,SOLUSDT,BNBUSDT,XRPUSDT,DOGEUSDT,ADAUSDT,AVAXUSDT,LINKUSDT,LTCUSDT').split(',');
const INTERVALS = opt('intervals', '30m,1h,4h').split(',');
const LIMIT = Number(opt('limit', 1000));
const STEP = Number(opt('step', 4));
const WARMUP = Number(opt('warmup', 320));
const MIN_SCORE = Number(opt('min-score', 55));
const LIVE_MIN_SCORE = Number(opt('live-min-score', 65));
const COOLDOWN = Number(opt('cooldown', 12));
const OUT = opt('out', 'data/research/confluence-study.json');
// 保守估計：進場跟出場都算吃單手續費（Bybit 永續 0.055%），換算成「每筆吃掉幾 R」
const ROUND_TRIP_FEE = Number(opt('fee', 0.0011));

const log = (...a) => console.log(...a);

function collectSignals(candles, symbol, interval) {
  const out = [];
  let cooldownUntil = -1;
  for (let i = WARMUP; i < candles.length - 30; i += STEP) {
    if (i < cooldownUntil) continue;
    let res;
    try { res = analyze(candles.slice(Math.max(0, i - 600), i + 1), {}); } catch { continue; }
    const s = res.setup;
    if (!s || s.none || !s.valid || s.score < MIN_SCORE || !s.targets?.length) continue;
    out.push({
      symbol, interval, index: i, time: candles[i].time,
      dir: s.dir, entry: s.entry, stop: s.stop, entryType: s.entryType,
      targets: s.targets.map((t) => ({ name: t.name, price: t.price, rr: t.rr, label: t.label })),
      grade: s.grade, score: s.score, poiType: s.poi.type,
      fib: s.extras.fib, hvn: s.extras.hvn, valueEdge: s.extras.valueEdge, lvn: s.extras.lvn,
      checks: Object.fromEntries(s.checklist.map((c) => [c.key, c.ok])),
      stopPct: Math.abs(s.entry - s.stop) / s.entry,
      half: i < (WARMUP + candles.length) / 2 ? 0 : 1,
    });
    cooldownUntil = i + COOLDOWN;
  }
  return out;
}

const live = (t) => t.poiType !== 'Order Block' && t.score >= LIVE_MIN_SCORE;

// 評分權重候選：只改權重重新算分數，不動引擎，拿來跟現行分數比
const WEIGHTS_OLD = { htfAlign: 18, structure: 15, pdSide: 12, poiFresh: 12, sweep: 12, stacked: 10, rr: 10, target: 10, momentum: 8, killzone: 5 };
const WEIGHT_VARIANTS = {
  舊版: WEIGHTS_OLD,
  現行: { ...WEIGHTS_OLD, poiFresh: 20, sweep: 4 },
  新鮮POI加倍_掃除歸零: { ...WEIGHTS_OLD, poiFresh: 24, sweep: 0 },
};
const scoreWith = (w, checks) => {
  const total = Object.values(w).reduce((a, b) => a + b, 0);
  return Math.round((Object.entries(w).reduce((s, [k, v]) => s + (checks[k] ? v : 0), 0) / total) * 100);
};
const liveWith = (w) => (t) => t.poiType !== 'Order Block' && scoreWith(w, t.checks) >= LIVE_MIN_SCORE;

const CHECK_KEYS = ['htfAlign', 'structure', 'pdSide', 'poiFresh', 'sweep', 'stacked', 'rr', 'target', 'momentum', 'killzone'];
const STOP_BUCKETS = [[0, 0.005], [0.005, 0.01], [0.01, 0.02], [0.02, 0.04], [0.04, 1]];

const SECTIONS = [
  ['斐波那契／成交量分布', [
    ['全部', () => true],
    ['斐波那契 有', (t) => t.fib != null],
    ['斐波那契 無', (t) => t.fib == null],
    ['高量節點 有', (t) => t.hvn],
    ['高量節點 無', (t) => !t.hvn],
    ['價值區邊緣外 是', (t) => t.valueEdge],
    ['價值區邊緣外 否', (t) => !t.valueEdge],
    ['低量節點 是', (t) => t.lvn],
    ['低量節點 否', (t) => !t.lvn],
    ['線上過濾（非OB、≥分數門檻，多空都算）', live],
    ['線上過濾＋斐波那契', (t) => live(t) && t.fib != null],
    ['線上過濾＋高量節點', (t) => live(t) && t.hvn],
  ]],
  ['評分表逐項（全部訊號）', CHECK_KEYS.flatMap((k) => [
    [`${k} ✓`, (t) => t.checks[k]],
    [`${k} ✗`, (t) => !t.checks[k]],
  ])],
  ['評分表逐項（線上過濾後）', CHECK_KEYS.flatMap((k) => [
    [`${k} ✓`, (t) => live(t) && t.checks[k]],
    [`${k} ✗`, (t) => live(t) && !t.checks[k]],
  ])],
  // 同一個效果在前半段、後半段資料都成立，才比較不是巧合
  ['穩定性：前半段 vs 後半段（全部訊號）', ['poiFresh', 'sweep', 'pdSide', 'killzone', 'structure'].flatMap((k) => [
    [`前 ${k} ✓`, (t) => t.half === 0 && t.checks[k]],
    [`前 ${k} ✗`, (t) => t.half === 0 && !t.checks[k]],
    [`後 ${k} ✓`, (t) => t.half === 1 && t.checks[k]],
    [`後 ${k} ✗`, (t) => t.half === 1 && !t.checks[k]],
  ]).concat([
    ['前 停損≥1%', (t) => t.half === 0 && t.stopPct >= 0.01],
    ['前 停損<1%', (t) => t.half === 0 && t.stopPct < 0.01],
    ['後 停損≥1%', (t) => t.half === 1 && t.stopPct >= 0.01],
    ['後 停損<1%', (t) => t.half === 1 && t.stopPct < 0.01],
  ])],
  ['評分權重候選（線上過濾，用各自的分數套門檻）', Object.entries(WEIGHT_VARIANTS).flatMap(([name, w]) => [
    [`${name} 全部`, liveWith(w)],
    [`${name} 前半`, (t) => t.half === 0 && liveWith(w)(t)],
    [`${name} 後半`, (t) => t.half === 1 && liveWith(w)(t)],
    [`${name} ＋停損≥1%`, (t) => t.stopPct >= 0.01 && liveWith(w)(t)],
  ])],
  ['停損距離（線上過濾後；距離愈近，手續費吃掉的 R 愈多）', STOP_BUCKETS.map(([lo, hi]) => [
    `${(lo * 100).toFixed(1)}%–${(hi * 100).toFixed(1)}%`, (t) => live(t) && t.stopPct >= lo && t.stopPct < hi,
  ])],
];

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
        log(`  ${symbol} ${interval}: ${c.length} 根 K 棒 → ${s.length} 個訊號`);
      } catch (e) { log(`  ${symbol} ${interval}: 取得資料失敗（${e.message}）`); }
    }
  }
  log(`\n訊號總數：${signals.length}\n`);
  if (!signals.length) { log('沒有訊號可測。'); process.exit(1); }

  const closed = runSignals(signals, candlesBy, DEFAULT_MANAGEMENT);
  const net = (t) => ({ ...t, r: t.r - ROUND_TRIP_FEE / t.stopPct });
  const rows = [];
  for (const [title, groups] of SECTIONS) {
    const section = groups.map(([name, f]) => {
      const hit = closed.filter(f);
      return { section: title, name, ...summarize(hit), netExpectancy: summarize(hit.map(net)).expectancy ?? 0 };
    });
    rows.push(...section);
    log(`\n■ ${title}`);
    printTable(log, ['分組', '筆數', '勝率', '期望值', '扣手續費後', '獲利因子', '最大回撤'], section.map((r) => [
      r.name, String(r.n), pct(r.winRate ?? 0), r2(r.expectancy ?? 0), r2(r.netExpectancy),
      (r.profitFactor ?? 0).toFixed(2), (r.maxDdR ?? 0).toFixed(1),
    ]));
  }

  await mkdir(OUT.split('/').slice(0, -1).join('/'), { recursive: true });
  await writeFile(OUT, JSON.stringify({ generatedAt: Date.now(), symbols: SYMBOLS, intervals: INTERVALS, minScore: MIN_SCORE, fee: ROUND_TRIP_FEE, signals: signals.length, rows }, null, 2));
  log(`\n已寫入 ${OUT}`);
})();
