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
    });
    cooldownUntil = i + COOLDOWN;
  }
  return out;
}

const live = (t) => t.dir === 'long' && t.poiType !== 'Order Block' && t.score >= LIVE_MIN_SCORE;

const GROUPS = [
  ['全部', () => true],
  ['斐波那契 有', (t) => t.fib != null],
  ['斐波那契 無', (t) => t.fib == null],
  ['高量節點 有', (t) => t.hvn],
  ['高量節點 無', (t) => !t.hvn],
  ['價值區邊緣外 是', (t) => t.valueEdge],
  ['價值區邊緣外 否', (t) => !t.valueEdge],
  ['低量節點 是', (t) => t.lvn],
  ['低量節點 否', (t) => !t.lvn],
  ['斐波那契＋高量節點', (t) => t.fib != null && t.hvn],
  ['線上過濾（只做多、非OB、≥分數門檻）', live],
  ['線上過濾＋斐波那契', (t) => live(t) && t.fib != null],
  ['線上過濾＋高量節點', (t) => live(t) && t.hvn],
  ['線上過濾＋價值區邊緣外', (t) => live(t) && t.valueEdge],
  ['線上過濾＋排除低量節點', (t) => live(t) && !t.lvn],
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
  const rows = GROUPS.map(([name, f]) => ({ name, ...summarize(closed.filter(f)) }));

  printTable(log, ['分組', '筆數', '勝率', '總R', '期望值', '獲利因子', '最大回撤'], rows.map((r) => [
    r.name, String(r.n), pct(r.winRate ?? 0), r2(r.totalR ?? 0), r2(r.expectancy ?? 0),
    (r.profitFactor ?? 0).toFixed(2), (r.maxDdR ?? 0).toFixed(1),
  ]));

  await mkdir(OUT.split('/').slice(0, -1).join('/'), { recursive: true });
  await writeFile(OUT, JSON.stringify({ generatedAt: Date.now(), symbols: SYMBOLS, intervals: INTERVALS, minScore: MIN_SCORE, signals: signals.length, rows }, null, 2));
  log(`\n已寫入 ${OUT}`);
})();
