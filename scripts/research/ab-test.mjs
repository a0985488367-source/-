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
};

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
      grade: s.grade, score: s.score,
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
  log(`\n訊號總數：${signals.length}（所有變體共用同一份）\n`);
  if (!signals.length) { log('沒有訊號可測。'); process.exit(1); }

  const rows = [];
  for (const [name, cfg] of Object.entries(VARIANTS)) {
    const s = summarize(runSignals(signals, candlesBy, cfg));
    rows.push({ name, cfg, ...s });
  }

  const head = ['規則', '筆數', '勝率', '總R', '期望值', '平均獲利', '平均虧損', '獲利因子', '最大回撤'];
  const body = rows.map((r) => [
    r.name, String(r.n), pct(r.winRate ?? 0), r2(r.totalR ?? 0), r2(r.expectancy ?? 0),
    r2(r.avgWin ?? 0), r2(r.avgLoss ?? 0), (r.profitFactor ?? 0).toFixed(2), (r.maxDdR ?? 0).toFixed(1),
  ]);
  printTable(log, head, body);

  await mkdir(OUT.split('/').slice(0, -1).join('/'), { recursive: true });
  await writeFile(OUT, JSON.stringify({ generatedAt: Date.now(), symbols: SYMBOLS, intervals: INTERVALS, signals: signals.length, rows }, null, 2));
  log(`\n已寫入 ${OUT}`);
})();
