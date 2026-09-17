#!/usr/bin/env node
/**
 * 測量 SMC 策略的實際優勢
 *
 *   node scripts/measure-edge.mjs --source null --series 120   # 空值檢定（隨機漫步）
 *   node scripts/measure-edge.mjs --source demo --series 20    # repo 內建示範資料
 *   node scripts/measure-edge.mjs --source csv --file data.csv # 真實行情
 *
 * 空值檢定是重點：在零漂移隨機漫步上，任何策略的期望值（以 R 計）
 * 都必須在統計誤差內等於 0。若顯著大於 0，代表引擎有未來函數或統計有誤，
 * 而不是策略有優勢。
 */
import { readFileSync } from 'node:fs';
import { backtest } from '../src/smc/backtest.js';
import { randomWalkCandles } from '../src/sim/synthetic.js';
import { parseCandleCsv, parseBybitKline, validateCandles } from '../src/sim/candle-io.js';
import { generateDemoCandles } from '../src/data/providers.js';

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const SOURCE = flag('source', 'null');
const SERIES = Number(flag('series', 120));
const COUNT = Number(flag('count', 1200));
const MIN_SCORE = Number(flag('min-score', 55));
const FILE = flag('file', null);
const SEED = Number(flag('seed', 777));

/* ------------------------------------------------------------ 統計工具 */

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
const sd = (xs) => {
  if (xs.length < 2) return NaN;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
};

/** 比例的 Wilson 95% 信賴區間（小樣本比常態近似可靠） */
function wilson(successes, n, z = 1.96) {
  if (!n) return [NaN, NaN];
  const p = successes / n;
  const d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d;
  const h = (z / d) * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [Math.max(0, c - h), Math.min(1, c + h)];
}

/** 偵測某個期望值所需的樣本數（雙尾 95%、檢定力 80%） */
function requiredN(effect, stdev) {
  return Math.ceil((7.849 * stdev * stdev) / (effect * effect));
}

/* ------------------------------------------------------------ 取得資料 */

function loadSeries() {
  if (SOURCE === 'csv') {
    if (!FILE) throw new Error('--source csv 需要 --file <路徑>');
    const text = readFileSync(FILE, 'utf8');
    // 自動辨識：Bybit v5 kline JSON 或一般 OHLC CSV
    const raw = text.trimStart().startsWith('{') || text.trimStart().startsWith('[')
      ? parseBybitKline(text)
      : parseCandleCsv(text);
    const { candles, issues, stepMs, gaps } = validateCandles(raw);
    console.log(`  載入 ${candles.length} 根 K 棒，間隔 ${stepMs / 60000} 分鐘`);
    console.log(`  期間 ${new Date(candles[0].time).toISOString().slice(0, 16)} → ${new Date(candles[candles.length - 1].time).toISOString().slice(0, 16)}`);
    for (const m of issues) console.log(`  · ${m}`);
    if (!issues.length) console.log('  · 資料品質檢查：無缺口、無重複、OHLC 自洽');
    if (gaps.length) {
      // 缺口處切成獨立區段，避免把「跨越缺口」當成連續價格走勢
      const segs = [];
      let start = 0;
      for (const g of gaps) {
        const idx = candles.findIndex((k) => k.time === g.afterTime);
        if (idx - start >= 400) segs.push(candles.slice(start, idx + 1));
        start = idx + 1;
      }
      if (candles.length - start >= 400) segs.push(candles.slice(start));
      if (segs.length > 1) {
        console.log(`  · 依缺口切成 ${segs.length} 個連續區段分別回測`);
        return segs.map((c, i) => ({ label: `${FILE}#${i}`, candles: c }));
      }
    }
    if (candles.length < 400) throw new Error(`只有 ${candles.length} 根 K 棒，至少需要 400 根`);
    return [{ label: FILE, candles }];
  }
  if (SOURCE === 'demo') {
    // repo 內建示範資料：內含人為的趨勢／回調結構，僅供對照
    return Array.from({ length: SERIES }, (_, i) => ({
      label: `demo#${i}`,
      candles: generateDemoCandles('BTCUSDT', '15m', COUNT, Date.UTC(2024, 0, 1) + i * 864e5),
    }));
  }
  return Array.from({ length: SERIES }, (_, i) => ({
    label: `rw#${i}`,
    candles: randomWalkCandles({ seed: SEED + i * 7919, count: COUNT }),
  }));
}

/* ------------------------------------------------------------ 主流程 */

const SOURCE_NAME = {
  null: '零漂移隨機漫步（空值檢定：依建構方式不存在優勢）',
  demo: 'repo 內建示範資料（含人為趨勢結構，僅供對照）',
  csv: '真實行情 CSV',
};

console.log(`資料來源：${SOURCE_NAME[SOURCE] ?? SOURCE}`);
const series = loadSeries();
console.log(`序列數 ${series.length} × 每條 ${series[0].candles.length} 根 K 棒 · minScore ${MIN_SCORE}\n`);

/**
 * 去重：不同「序列」若其實是同一條價格路徑，交易會被重複計數，
 * 使樣本數虛胖、信賴區間假性收窄（偽複製 pseudo-replication）。
 * repo 的 generateDemoCandles 就是這種情況——它的種子只取決於
 * symbol 與 interval，與 endTime 無關，因此每次呼叫回傳同一條路徑。
 */
const fingerprint = (candles) => {
  let h = 2166136261;
  for (const k of candles) {
    const v = Math.round(k.close * 1e4);
    h = Math.imul(h ^ (v & 0xffff), 16777619);
    h = Math.imul(h ^ (v >>> 16), 16777619);
  }
  return h >>> 0;
};
const seen = new Set();
const unique = [];
for (const s of series) {
  const fp = fingerprint(s.candles);
  if (seen.has(fp)) continue;
  seen.add(fp);
  unique.push(s);
}
if (unique.length !== series.length) {
  console.log(`⚠ ${series.length} 條序列中只有 ${unique.length} 條是不同的價格路徑，`
    + `其餘為重複；已去重以避免樣本數虛胖。\n`);
}

const allTrades = [];
const t0 = Date.now();
for (let i = 0; i < unique.length; i++) {
  const { trades } = await backtest(unique[i].candles, { minScore: MIN_SCORE, chunkSize: 1e9 });
  allTrades.push(...trades);
  if ((i + 1) % 20 === 0 || i === unique.length - 1) {
    process.stdout.write(`\r  進度 ${i + 1}/${unique.length}　累計交易 ${allTrades.length} 筆`);
  }
}
console.log(`\n  耗時 ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);

const n = allTrades.length;
if (!n) { console.log('沒有產生任何交易訊號。'); process.exit(0); }

const rs = allTrades.map((t) => t.r);
const wins = allTrades.filter((t) => t.r > 0);
const losses = allTrades.filter((t) => t.r <= 0);
const exp = mean(rs);
const s = sd(rs);
const se = s / Math.sqrt(n);
const [wlo, whi] = wilson(wins.length, n);
const tStat = exp / se;

console.log('══ 測量結果 ══');
console.log(`  樣本數            ${n} 筆交易`);
console.log(`  勝率              ${(wins.length / n * 100).toFixed(2)}%   95% CI [${(wlo * 100).toFixed(2)}%, ${(whi * 100).toFixed(2)}%]`);
console.log(`  平均獲利          ${mean(wins.map((t) => t.r)).toFixed(3)} R`);
console.log(`  平均虧損          ${mean(losses.map((t) => t.r)).toFixed(3)} R`);
console.log(`  每筆期望值        ${exp >= 0 ? '+' : ''}${exp.toFixed(4)} R`);
console.log(`     95% CI         [${(exp - 1.96 * se).toFixed(4)}, ${(exp + 1.96 * se).toFixed(4)}] R`);
console.log(`     單筆標準差     ${s.toFixed(3)} R`);
console.log(`     t 統計量       ${tStat.toFixed(2)}`);
const sig = Math.abs(tStat) > 1.96;
console.log(`  結論              ${sig ? (exp > 0 ? '⚠ 顯著大於 0' : '顯著小於 0') : '與 0 無法區分（統計上沒有優勢）'}`);

const outcomes = { target: 0, stop: 0, timeout: 0 };
for (const t of allTrades) outcomes[t.outcome] += 1;
console.log(`  出場分布          停利 ${outcomes.target} / 停損 ${outcomes.stop} / 逾時 ${outcomes.timeout}`);

console.log('\n══ 要證明優勢存在，需要多少樣本 ══');
console.log(`  （以本次測得的單筆標準差 ${s.toFixed(2)} R 計算，雙尾 95%、檢定力 80%）`);
for (const e of [0.05, 0.10, 0.20, 0.30]) {
  console.log(`   要偵測 ${e.toFixed(2)} R 的期望值 → 需要 ${requiredN(e, s).toLocaleString('en-US')} 筆交易`);
}

if (SOURCE === 'null') {
  console.log('\n══ 這代表什麼 ══');
  if (sig && exp > 0) {
    console.log('  ⚠ 在「依建構方式不存在優勢」的資料上測到顯著正期望值。');
    console.log('    這不是策略有效，而是引擎或統計有問題（未來函數、重複計數、或出場假設偏頗）。');
  } else {
    console.log('  ✓ 空值檢定通過：引擎在無優勢的資料上測不出優勢，沒有未來函數的跡象。');
    console.log('    也就是說這套測量流程是可信的——現在缺的只是真實行情資料。');
  }
}
