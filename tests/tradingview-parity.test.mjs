/**
 * TradingView 指標（tradingview/smc-plan.pine）跟原版 SMC 引擎（src/smc/）逐項比對。
 *
 * 做法：tradingview/pine2js.py 把 Pine 原始碼轉成 JS（只轉分析邏輯，畫圖／表格略過），
 * 同一批 K 棒分別丟給 Pine 版跟 analyze()，比對偏向分數、方向、進場、停損、目標、
 * 評分、評級、10 項匯流檢查。改了 src/smc/ 卻沒同步改 Pine 版，這裡就會失敗。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { analyze } from '../src/smc/engine.js';
import { generateDemoCandles } from '../src/data/providers.js';

const ROOT = new URL('..', import.meta.url);
const pineJs = execFileSync('python3', [new URL('tradingview/pine2js.py', ROOT).pathname, new URL('tradingview/smc-plan.pine', ROOT).pathname], { encoding: 'utf8' });

const PRELUDE = `
const NaN_ = NaN;
function isNa(x) { return x === null || x === undefined || (typeof x === 'number' && Number.isNaN(x)); }
function newArr(n, v) { return Array.from({ length: n }, () => (v === undefined ? NaN : v)); }
function arrFrom(...a) { return a; }
function strToString(x, f) { return f === '#.########' ? Number(x).toFixed(8) : String(x); }
function utc_hour(t) { return new Date(t).getUTCHours(); }
function utc_minute(t) { return new Date(t).getUTCMinutes(); }
function utc_dayofweek(t) { return new Date(t).getUTCDay() + 1; }
function utc_year(t) { return new Date(t).getUTCFullYear(); }
function utc_month(t) { return new Date(t).getUTCMonth() + 1; }
if (!Array.prototype.get) {
  Object.defineProperty(Array.prototype, 'get', { value(i) { return this[i]; } });
  Object.defineProperty(Array.prototype, 'set', { value(i, v) { this[i] = v; } });
  Object.defineProperty(Array.prototype, 'size', { value() { return this.length; } });
  Object.defineProperty(Array.prototype, 'insert', { value(i, v) { this.splice(i, 0, v); } });
}
const noop = () => ({ delete() {} });
const stub = new Proxy({}, { get: () => 0 });
`;

const dir = mkdtempSync(join(tmpdir(), 'pine-'));
const file = join(dir, 'pine.mjs');
writeFileSync(file, `${PRELUDE}
export function runPine(env) {
  const { candles, htfScore, mode } = env;
  const iBars = 500, iUseHtf = true, iShowPois = true, iShowStruct = true, iShowTable = true, iAlertScore = 65, iNearPct = 0.08;
  const barstate = { islast: true, isconfirmed: !!env.confirmed };
  const bar_index = candles.length - 1;
  const close = candles[candles.length - 1].close;
  const timenow = 0, time_close = 0;
  const box = { all: [] }, line = { all: [], style_dashed: 0, style_dotted: 0, style_solid: 0 }, label = { all: [], style_label_left: 0, style_label_down: 0, style_label_up: 0 };
  const color = { new: () => 0, white: 0 }, size = stub, text = stub, format = stub, position = stub, syminfo = stub, timeframe = stub;
  const __out = {};
  function getWindow(n, off) {
    const w = candles.slice(candles.length - off - n, candles.length - off);
    return [w.map((c) => c.open), w.map((c) => c.high), w.map((c) => c.low), w.map((c) => c.close), w.map((c) => c.volume || 0), w.map((c) => c.time)];
  }
${pineJs}
  if (mode === 'htf') return htfBiasCalc(env.nBars, 0);
  return __out.result;
}
`);
const { runPine } = await import(pathToFileURL(file).href);

/** 固定種子的隨機漫步 K 線：有趨勢、盤整、跳空，補足 demo 資料沒涵蓋到的情境 */
function randomCandles(seed, n, stepMs, start = Date.UTC(2026, 0, 5)) {
  let s = seed >>> 0;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
  let price = 50 + rnd() * 50000;
  let drift = 0;
  const out = [];
  for (let i = 0; i < n; i++) {
    if (i % 60 === 0) drift = (rnd() - 0.5) * 0.004;
    const vol = 0.002 + rnd() * 0.012;
    const open = rnd() < 0.05 ? price * (1 + (rnd() - 0.5) * vol * 3) : price;
    const close = open * (1 + drift + (rnd() - 0.5) * vol * 2);
    const high = Math.max(open, close) * (1 + rnd() * vol);
    const low = Math.min(open, close) * (1 - rnd() * vol);
    out.push({ time: start + i * stepMs, open, high, low, close, volume: Math.round(rnd() * 1e6) });
    price = close;
  }
  return out;
}

const near = (a, b) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));

function compare(label, candles, htfScore) {
  // 原版：跟 Worker 一樣，最後一根當成盤中那根去掉，取 499 根已收盤的
  const closed = candles.slice(0, -1).slice(-499);
  const a = analyze(closed, { htfBias: Number.isNaN(htfScore) ? null : { score: htfScore } });
  const p = runPine({ candles, htfScore });
  assert.equal(p.n, closed.length, `${label}：分析根數`);
  assert.equal(p.localScore + 0, a.bias.score + 0, `${label}：偏向分數`); // +0：把 -0 當成 0
  const s = a.setup;
  if (!s || s.none) {
    assert.equal(p.hasPlan, false, `${label}：原版沒有計畫，Pine 版卻有`);
    return 'none';
  }
  assert.equal(p.hasPlan, true, `${label}：原版有計畫，Pine 版卻沒有（${p.noneReason}）`);
  assert.equal(p.dirPlan, s.dir === 'long' ? 1 : -1, `${label}：方向`);
  assert.ok(near(p.entry, s.entry), `${label}：進場 ${p.entry} vs ${s.entry}`);
  assert.ok(near(p.stop, s.stop), `${label}：停損 ${p.stop} vs ${s.stop}`);
  assert.deepEqual(p.targets.map((t) => +t.price.toPrecision(12)), s.targets.map((t) => +t.price.toPrecision(12)), `${label}：目標價`);
  assert.deepEqual(p.targets.map((t) => t.name), s.targets.map((t) => t.label), `${label}：目標名稱`);
  assert.deepEqual(p.checks, s.checklist.map((c) => c.ok), `${label}：匯流檢查`);
  assert.equal(p.scorePlan, s.score, `${label}：評分`);
  assert.equal(p.gradePlan, s.grade, `${label}：評級`);
  assert.equal(p.validPlan, s.valid, `${label}：有效`);
  return s.dir;
}

const HTF_SCORES = [NaN, -70, -30, -6, 0, 6, 12, 45, 90];
const INTERVALS = { '15m': 900e3, '30m': 1800e3, '1h': 3600e3, '4h': 14400e3, '1d': 86400e3 };

test('Pine 版跟原版 SMC 引擎：demo K 線，各週期各時間點的計畫完全一樣', () => {
  const tally = { none: 0, long: 0, short: 0 };
  let k = 0;
  for (const symbol of ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'DOGEUSDT']) {
    for (const [iv, ms] of Object.entries(INTERVALS)) {
      for (const shift of [0, 7, 31, 90, 177]) {
        const end = Date.UTC(2026, 8, 29) - shift * ms;
        const candles = generateDemoCandles(symbol, iv, 520, end);
        const htf = HTF_SCORES[k++ % HTF_SCORES.length];
        tally[compare(`${symbol} ${iv} -${shift}根 htf=${htf}`, candles, htf)]++;
      }
    }
  }
  // 確認真的有比到有計畫的情況，不是全部都「沒計畫」剛好一樣
  assert.ok(tally.long + tally.short > 20, JSON.stringify(tally));
});

test('Pine 版跟原版 SMC 引擎：隨機漫步 K 線（趨勢／盤整／跳空）', () => {
  const tally = { none: 0, long: 0, short: 0 };
  for (let seed = 1; seed <= 60; seed++) {
    const ms = Object.values(INTERVALS)[seed % 5];
    const candles = randomCandles(seed * 7919, 560, ms);
    tally[compare(`seed ${seed}`, candles, HTF_SCORES[seed % HTF_SCORES.length])]++;
  }
  assert.ok(tally.long > 5 && tally.short > 5, JSON.stringify(tally));
});

test('Pine 版的高週期偏向跟原版一樣（259 根已收盤 K 棒的偏向分數）', () => {
  for (let seed = 1; seed <= 30; seed++) {
    const candles = randomCandles(seed * 104729, 259, 14400e3);
    const want = analyze(candles).bias.score;
    const got = runPine({ candles: [...candles, candles.at(-1)], htfScore: NaN, mode: 'htf', nBars: 259 });
    // htf 模式的 getWindow 從最後面取；多塞一根當墊底再用 off=0 會取錯，所以直接比對 259 根的版本
    const got2 = runPine({ candles, htfScore: NaN, mode: 'htf', nBars: 259 });
    assert.equal(got2 + 0, want + 0, `seed ${seed}`);
    assert.equal(typeof got, 'number');
  }
});
