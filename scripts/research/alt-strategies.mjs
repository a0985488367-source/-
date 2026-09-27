#!/usr/bin/env node
/**
 * 別種做法的回測：幾個簡單、常見的順勢／回檔策略，跟 SMC 用同一套精準回測比較。
 *
 * 所有策略都在 K 棒收盤時判斷，下一根開盤用市價進場（沒有限價單「成交那根」的問題），
 * 停損用 ATR；出場規則另外組合（固定止盈、追蹤停損、目前 SMC 的保本＋追蹤）。
 *
 * 兩種算法都印：
 *   原週期  用 5000 根 K 棒的完整歷史（前後半段）
 *   5M     最近 --sub-days 天改用 5 分鐘 K 棒逐根跑（最準，前後半段）
 *
 * 用法：node scripts/research/alt-strategies.mjs --symbols=BTCUSDT,ETHUSDT --intervals=1h,4h --limit=5000 --sub=5m --sub-days=150
 */

import { opt as optFrom, klines, runSignals, r2, printTable } from './lib.mjs';
import { ema, atr, rsi } from '../../src/core/indicators.js';

const ARGS = process.argv.slice(2);
const opt = (n, d) => optFrom(ARGS, n, d);
const SYMBOLS = opt('symbols', 'BTCUSDT,ETHUSDT,SOLUSDT,BNBUSDT,XRPUSDT,DOGEUSDT,ADAUSDT,AVAXUSDT,LINKUSDT,LTCUSDT,DOTUSDT,NEARUSDT,APTUSDT,ARBUSDT,OPUSDT').split(',');
const INTERVALS = opt('intervals', '1h,4h').split(',');
const LIMIT = Number(opt('limit', 5000));
const SUB = opt('sub', '5m');
const SUB_DAYS = Number(opt('sub-days', 150));
const FEE = Number(opt('fee', 0.0011));
const WARMUP = 210;
const log = (...a) => console.log(...a);

/** 策略：在第 i 根收盤判斷，回傳 { dir, stopAtr } 或 null（只用第 i 根以前的資料） */
const STRATEGIES = {
  // 唐奇安通道突破：收盤突破前 N 根最高（低）點，而且在 EMA200 同一側；只取剛突破的第一根
  DONCH20: (x, i) => donchian(x, i, 20),
  DONCH55: (x, i) => donchian(x, i, 55),
  // 順勢回檔：EMA50 在 EMA200 之上（下），這根碰到 EMA20 又收回、收陽（陰）
  EMA_PB: (x, i) => {
    const { c, e20, e50, e200 } = x;
    const k = c[i];
    if (e200[i] == null || e20[i] == null) return null;
    if (e50[i] > e200[i] && k.close > e200[i] && k.low <= e20[i] && k.close > e20[i] && k.close > k.open) return { dir: 'long', stopAtr: 1.5 };
    if (e50[i] < e200[i] && k.close < e200[i] && k.high >= e20[i] && k.close < e20[i] && k.close < k.open) return { dir: 'short', stopAtr: 1.5 };
    return null;
  },
  // 順勢短線超跌／超漲：EMA200 之上 RSI(2) < 10 做多，之下 > 90 做空
  RSI2: (x, i) => {
    const { c, e200, r2v } = x;
    if (e200[i] == null || r2v[i] == null) return null;
    if (c[i].close > e200[i] && r2v[i] < 10 && !(r2v[i - 1] < 10)) return { dir: 'long', stopAtr: 2 };
    if (c[i].close < e200[i] && r2v[i] > 90 && !(r2v[i - 1] > 90)) return { dir: 'short', stopAtr: 2 };
    return null;
  },
};

function donchian(x, i, n) {
  const { c, e200 } = x;
  if (i < n + 1 || e200[i] == null) return null;
  let hi = -Infinity, lo = Infinity, hiPrev = -Infinity, loPrev = Infinity;
  for (let j = i - n; j < i; j++) { hi = Math.max(hi, c[j].high); lo = Math.min(lo, c[j].low); }
  for (let j = i - n - 1; j < i - 1; j++) { hiPrev = Math.max(hiPrev, c[j].high); loPrev = Math.min(loPrev, c[j].low); }
  if (c[i].close > hi && c[i].close > e200[i] && !(c[i - 1].close > hiPrev)) return { dir: 'long', stopAtr: 2 };
  if (c[i].close < lo && c[i].close < e200[i] && !(c[i - 1].close < loPrev)) return { dir: 'short', stopAtr: 2 };
  return null;
}

/** 出場規則（stepTrade 的設定＋止盈 R） */
const EXITS = {
  '固定 1R': { tpR: 1, cfg: { breakevenAtR: 0, trailFromR: 0 } },
  '固定 2R': { tpR: 2, cfg: { breakevenAtR: 0, trailFromR: 0 } },
  '1.5R 後追蹤 1.5R': { tpR: 20, cfg: { breakevenAtR: 0, trailFromR: 1.5, trailGapR: 1.5 } },
  '目前 SMC 保本＋追蹤': { tpR: 20, cfg: {} },
};

function buildSignals(symbol, interval, c, name) {
  const x = {
    c,
    e20: ema(c.map((k) => k.close), 20),
    e50: ema(c.map((k) => k.close), 50),
    e200: ema(c.map((k) => k.close), 200),
    a: atr(c, 14),
    r2v: rsi(c, 2),
  };
  const out = [];
  for (let i = WARMUP; i < c.length - 1; i++) {
    const s = STRATEGIES[name](x, i);
    if (!s || !(x.a[i] > 0)) continue;
    const entry = c[i + 1].open;
    const risk = x.a[i] * s.stopAtr;
    const stop = s.dir === 'long' ? entry - risk : entry + risk;
    out.push({
      symbol, interval, index: i, time: c[i].time, dir: s.dir, entry, stop, entryType: 'market',
      filledTime: c[i + 1].time, stopPct: risk / entry, strategy: name,
      half: i < (WARMUP + c.length) / 2 ? 0 : 1,
    });
  }
  return out;
}

const withTargets = (sigs, tpR) => sigs.map((s) => ({
  ...s,
  targets: [{ name: 'TP1', price: s.dir === 'long' ? s.entry + (s.entry - s.stop) * tpR : s.entry - (s.stop - s.entry) * tpR, rr: tpR }],
}));

(async () => {
  const candlesBy = new Map();
  let subStart = Infinity, subEnd = -Infinity;
  for (const symbol of SYMBOLS) {
    for (const interval of INTERVALS) {
      try {
        candlesBy.set(`${symbol}|${interval}`, await klines(symbol, interval, LIMIT));
      } catch (e) { log(`  ${symbol} ${interval}: 取得資料失敗（${e.message}）`); }
    }
    if (SUB) {
      try {
        const s = await klines(symbol, SUB, Math.ceil((SUB_DAYS * 1440) / ({ '1m': 1, '5m': 5, '15m': 15 }[SUB] ?? 5)));
        candlesBy.set(`${symbol}|sub`, s);
        subStart = Math.min(subStart, s[0].time);
        subEnd = Math.max(subEnd, s[s.length - 1].time);
      } catch (e) { log(`  ${symbol} ${SUB}: 取得資料失敗（${e.message}）`); }
    }
    log(`  ${symbol} 資料完成`);
  }
  const mid = (subStart + subEnd) / 2;
  const netR = (t) => t.r - FEE / t.stopPct;
  const cell = (xs) => (xs.length ? `${r2(xs.reduce((a, t) => a + netR(t), 0) / xs.length)}（${xs.length}）` : '-');
  const weeks = SUB_DAYS / 7;

  for (const interval of INTERVALS) {
    const rows = [];
    for (const name of Object.keys(STRATEGIES)) {
      const sigs = SYMBOLS.flatMap((sym) => {
        const c = candlesBy.get(`${sym}|${interval}`);
        return c ? buildSignals(sym, interval, c, name) : [];
      });
      for (const [exitName, { tpR, cfg }] of Object.entries(EXITS)) {
        const s = withTargets(sigs, tpR);
        const coarse = runSignals(s, candlesBy, cfg);
        const fine = SUB ? runSignals(s, candlesBy, { ...cfg, subBars: true }) : [];
        const fineHalf = (h) => fine.filter((t) => (t.filledTime < mid ? 0 : 1) === h);
        rows.push([
          name, exitName,
          cell(coarse.filter((t) => t.half === 0)), cell(coarse.filter((t) => t.half === 1)),
          cell(fineHalf(0)), cell(fineHalf(1)),
          (fine.length / weeks).toFixed(1),
        ]);
      }
    }
    log(`\n■ ${interval}（扣手續費每筆 R，括號是筆數；5M＝最近 ${SUB_DAYS} 天用 5 分鐘 K 棒逐根跑）`);
    printTable(log, ['策略', '出場', '原週期 前半', '原週期 後半', '5M 前半', '5M 後半', '5M 每週幾張'], rows);
  }
})();
