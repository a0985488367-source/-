/**
 * 部位管理規則 A/B 實測
 *
 *   node scripts/research/ab-test.mjs --symbols=BTCUSDT,ETHUSDT --intervals=15m,1h
 *
 * 做法：先用「逐步重算」產生一份訊號清單（避免未來函數），
 * 然後讓每一組管理規則去跑「同一份訊號」，所以唯一的變數就是規則本身。
 * 訊號之間用固定冷卻期去重，冷卻期與規則無關，確保各組看到的訊號完全相同。
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { analyze } from '../../src/smc/engine.js';
import { ema } from '../../src/core/indicators.js';
import { opt as optFrom, klines as fetchKlines, runSignals, summarize, pct, r2, printTable } from './lib.mjs';

const ARGS = process.argv.slice(2);
const opt = (n, d) => optFrom(ARGS, n, d);

const SYMBOLS = opt('symbols', 'BTCUSDT,ETHUSDT,SOLUSDT,BNBUSDT,XRPUSDT,DOGEUSDT,ADAUSDT,AVAXUSDT,LINKUSDT,LTCUSDT').split(',');
const INTERVALS = opt('intervals', '15m,1h').split(',');
const LIMIT = Number(opt('limit', 1000));
const STEP = Number(opt('step', 4));
const WARMUP = Number(opt('warmup', 320));
const MIN_SCORE = Number(opt('min-score', 55));
const COOLDOWN = Number(opt('cooldown', 12));
const OUT = opt('out', 'data/research/ab-test.json');
const ONLY = opt('only', '').split(',').filter(Boolean);
const LIVE_MIN_SCORE = Number(opt('live-min-score', 65));
const ROUND_TRIP_FEE = 0.0011;
const BTC_EMA = Number(opt('btc-ema', 200));

/** 受測的管理規則組合。base 是目前線上的行為（只有結構停損 + 最終目標）。 */
const VARIANTS = {
  base:            { },
  be1R:            { breakevenAtR: 1 },
  scalp05:         { scalpR: 0.5, scalpFraction: 0.34 },
  scalp05_be:      { scalpR: 0.5, scalpFraction: 0.34, breakevenAtR: 0.5 },
  scalp05_be1:     { scalpR: 0.5, scalpFraction: 0.34, breakevenAtR: 1.0 },
  scalp08_be1:     { scalpR: 0.8, scalpFraction: 0.34, breakevenAtR: 1.0 },
  scratch075:      { scratchR: 0.75 },
  scalp05_scratch: { scalpR: 0.5, scalpFraction: 0.34, breakevenAtR: 1.0, scratchR: 0.75 },
  trail:           { scalpR: 0.5, scalpFraction: 0.34, trailFromR: 1.5, trailGapR: 1.0 },
  full:            { scalpR: 0.5, scalpFraction: 0.34, breakevenAtR: 1.0, scratchR: 0.75, trailFromR: 2, trailGapR: 1 },
  // ── 圍繞目前最佳解（scalp05_be）的參數微調 ──
  scalp04_be:      { scalpR: 0.4, scalpFraction: 0.34, breakevenAtR: 0.4 },
  scalp06_be:      { scalpR: 0.6, scalpFraction: 0.34, breakevenAtR: 0.6 },
  scalp05_be_f25:  { scalpR: 0.5, scalpFraction: 0.25, breakevenAtR: 0.5 },
  scalp05_be_f50:  { scalpR: 0.5, scalpFraction: 0.50, breakevenAtR: 0.5 },
  scalp05_be_off:  { scalpR: 0.5, scalpFraction: 0.34, breakevenAtR: 0.5, breakevenOffsetR: 0.05 },
  // 保本之後讓剩餘部位用追蹤停損跑，試著把「小勝多、大勝少」補回來
  scalp05_be_tr:   { scalpR: 0.5, scalpFraction: 0.34, breakevenAtR: 0.5, trailFromR: 2, trailGapR: 1.2 },
  scalp05_be_tr15: { scalpR: 0.5, scalpFraction: 0.34, breakevenAtR: 0.5, trailFromR: 1.5, trailGapR: 0.8 },
  // 最終候選：保本鏢 + 成本價（含手續費緩衝）+ 追蹤停損
  FINAL:           { scalpR: 0.5, scalpFraction: 0.34, breakevenAtR: 0.5, breakevenOffsetR: 0.05, trailFromR: 1.5, trailGapR: 0.8 },
  FINAL_f50:       { scalpR: 0.5, scalpFraction: 0.50, breakevenAtR: 0.5, breakevenOffsetR: 0.05, trailFromR: 1.5, trailGapR: 0.8 },
  // ── 進場後「發現不對」提早出場（收盤判斷）──
  FINAL_stall6:    { stallBars: 6, stallMinR: 0.3 },
  FINAL_stall12:   { stallBars: 12, stallMinR: 0.3 },
  FINAL_stall24:   { stallBars: 24, stallMinR: 0.3 },
  FINAL_zone:      { zoneCloseExit: true },
  FINAL_zone_st12: { zoneCloseExit: true, stallBars: 12, stallMinR: 0.3 },
  // ── 保本／追蹤停損的時機（其餘同 FINAL）──
  BE075:           { breakevenAtR: 0.75 },
  BE1:             { breakevenAtR: 1.0 },
  BE_off:          { breakevenAtR: 0 },
  TR2_1:           { trailFromR: 2, trailGapR: 1.0 },
  TR1_05:          { trailFromR: 1, trailGapR: 0.5 },
  TR_off:          { trailFromR: 0 },
  BE1_TR2_1:       { breakevenAtR: 1.0, trailFromR: 2, trailGapR: 1.0 },
  // ── 目前線上（DEFAULT_MANAGEMENT 原樣）與保本鏢出場比例 ──
  NOW:             {},
  SC20:            { scalpFraction: 0.2 },
  SC10:            { scalpFraction: 0.1 },
  SC0:             { scalpR: 0 },
};

const live = (t) => t.score >= LIVE_MIN_SCORE && t.tp1R >= 1.5;
const GROUPS = [
  ['全部', () => true],
  ['線上過濾', live],
  ['線上 前半', (t) => live(t) && t.half === 0],
  ['線上 後半', (t) => live(t) && t.half === 1],
  ['線上 多單', (t) => live(t) && t.dir === 'long'],
  // 各時間週期分開看
  ...['30m', '1h', '4h'].flatMap((tf) => [
    [`線上 ${tf} 前半`, (t) => live(t) && t.interval === tf && t.half === 0],
    [`線上 ${tf} 後半`, (t) => live(t) && t.interval === tf && t.half === 1],
  ]),
  // BTC 大盤方向（同週期收盤價在 EMA 之上＝漲勢）：順勢＝多單配漲勢、空單配跌勢
  ['線上 順勢 前半', (t) => live(t) && t.withBtc === true && t.half === 0],
  ['線上 順勢 後半', (t) => live(t) && t.withBtc === true && t.half === 1],
  ['線上 逆勢 前半', (t) => live(t) && t.withBtc === false && t.half === 0],
  ['線上 逆勢 後半', (t) => live(t) && t.withBtc === false && t.half === 1],
  ['線上 空單 BTC跌勢', (t) => live(t) && t.dir === 'short' && t.btcUp === false],
  ['線上 空單 BTC漲勢', (t) => live(t) && t.dir === 'short' && t.btcUp === true],
  ['線上 多單 BTC漲勢', (t) => live(t) && t.dir === 'long' && t.btcUp === true],
  ['線上 多單 BTC跌勢', (t) => live(t) && t.dir === 'long' && t.btcUp === false],
  // 只做第一個目標夠遠的單：「賺的時候賺多」要靠訊號本身的目標夠遠
  ...[1.5, 2, 3].flatMap((rr) => [
    [`線上 TP1≥${rr}R 前半`, (t) => live(t) && t.tp1R >= rr && t.half === 0],
    [`線上 TP1≥${rr}R 後半`, (t) => live(t) && t.tp1R >= rr && t.half === 1],
  ]),
  ['線上 空單', (t) => live(t) && t.dir === 'short'],
];

const log = (...a) => console.log(...a);

/** 產生訊號清單：與管理規則無關，所有變體共用 */
function collectSignals(candles, symbol, interval) {
  const out = [];
  let cooldownUntil = -1;
  for (let i = WARMUP; i < candles.length - 30; i += STEP) {
    if (i < cooldownUntil) continue;
    const visible = candles.slice(Math.max(0, i - 600), i + 1);
    let res;
    try { res = analyze(visible, {}); } catch { continue; }
    const s = res.setup;
    if (!s || s.none || !s.valid || s.score < MIN_SCORE || !s.targets?.length) continue;
    out.push({
      symbol, interval, index: i, time: candles[i].time,
      dir: s.dir, entry: s.entry, stop: s.stop, entryType: s.entryType,
      targets: s.targets.map((t) => ({ name: t.name, price: t.price, rr: t.rr, label: t.label })),
      grade: s.grade, score: s.score, poiType: s.poi.type, zone: s.entryZone,
      stopPct: Math.abs(s.entry - s.stop) / s.entry,
      tp1R: s.targets[0].rr,
      half: i < (WARMUP + candles.length) / 2 ? 0 : 1,
    });
    cooldownUntil = i + COOLDOWN;
  }
  return out;
}

(async () => {
  const candlesBy = new Map();
  const signals = [];
  for (const symbol of SYMBOLS) {
    for (const interval of INTERVALS) {
      try {
        const c = await fetchKlines(symbol, interval, LIMIT);
        candlesBy.set(`${symbol}|${interval}`, c);
        const s = collectSignals(c, symbol, interval);
        signals.push(...s);
        log(`  ${symbol} ${interval}: ${c.length} 根 K 棒 → ${s.length} 個訊號`);
      } catch (e) { log(`  ${symbol} ${interval}: 取得資料失敗（${e.message}）`); }
    }
  }
  // 每個訊號標上當下 BTC 同週期的趨勢（只看訊號那根之前已收盤的 K 棒，沒有未來函數）
  for (const interval of INTERVALS) {
    const c = candlesBy.get(`BTCUSDT|${interval}`) ?? await fetchKlines('BTCUSDT', interval, LIMIT).catch(() => null);
    if (!c) { log(`  BTCUSDT ${interval}: 取不到，這個週期不標大盤方向`); continue; }
    const e = ema(c.map((k) => k.close), BTC_EMA);
    for (const sig of signals.filter((x) => x.interval === interval)) {
      let lo = 0, hi = c.length - 1, idx = -1;
      while (lo <= hi) { const m = (lo + hi) >> 1; if (c[m].time <= sig.time) { idx = m; lo = m + 1; } else hi = m - 1; }
      if (idx < 0 || e[idx] == null) continue;
      sig.btcUp = c[idx].close > e[idx];
      sig.withBtc = sig.dir === 'long' ? sig.btcUp : !sig.btcUp;
    }
  }
  log(`\n訊號總數：${signals.length}（所有變體共用同一份）\n`);
  if (!signals.length) { log('沒有訊號可測。'); process.exit(1); }

  const net = (t) => ({ ...t, r: t.r - ROUND_TRIP_FEE / t.stopPct });
  const rows = [];
  for (const [name, cfg] of Object.entries(VARIANTS)) {
    if (ONLY.length && !ONLY.includes(name)) continue;
    const closed = runSignals(signals, candlesBy, cfg);
    for (const [group, f] of GROUPS) {
      const hit = closed.filter(f);
      rows.push({ name, group, cfg, ...summarize(hit), netExpectancy: summarize(hit.map(net)).expectancy ?? 0 });
    }
  }

  for (const [group] of GROUPS) {
    log(`\n■ ${group}`);
    printTable(log, ['規則', '筆數', '勝率', '總R', '期望值', '扣手續費後', '平均獲利', '平均虧損', '獲利因子', '最大回撤'],
      rows.filter((r) => r.group === group).map((r) => [
        r.name, String(r.n), pct(r.winRate ?? 0), r2(r.totalR ?? 0), r2(r.expectancy ?? 0), r2(r.netExpectancy),
        r2(r.avgWin ?? 0), r2(r.avgLoss ?? 0), (r.profitFactor ?? 0).toFixed(2), (r.maxDdR ?? 0).toFixed(1),
      ]));
  }

  await mkdir(OUT.split('/').slice(0, -1).join('/'), { recursive: true });
  await writeFile(OUT, JSON.stringify({ generatedAt: Date.now(), symbols: SYMBOLS, intervals: INTERVALS, signals: signals.length, rows }, null, 2));
  log(`\n已寫入 ${OUT}`);
})();
