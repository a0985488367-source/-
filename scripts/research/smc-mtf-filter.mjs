#!/usr/bin/env node
/**
 * SMC 推播「統整週期」過濾回測（2026-10-13 使用者要的：15m 叫做空、1h／4h 卻還在回調 → 常常吃損）。
 *
 *   node scripts/research/smc-mtf-filter.mjs --days=150 --sub=5m
 *
 * 基準＝現在線上的 SMC 推播（跟 recent-signals.mjs 同一套：SMC_SYMBOLS × 15m～1d、分數 ≥ 65、要等回踩的有效計畫、
 * 計畫只活一根、碰到進場價才算推播＋進場、同幣／週期／方向／進場價 6 小時內只推一次），
 * 再比較加上「上面兩層週期」過濾後的結果：
 *   上面兩層：15m／30m → 1h、4h；1h／2h → 4h、1d；4h／6h → 1d、1w；1d → 1w
 *   A 結構同向     上面兩層的大結構（swing trend）都跟訊號同方向
 *   B 結構＋沒回調  A＋緊鄰上一層的小結構（internal trend）也同方向（代表上一層的回調已經結束）← 使用者選的
 *   C 只看上一層    上一層的大結構＋小結構同方向（不看第二層），當對照
 * 上面週期都只用訊號那一刻「已經收盤」的 K 棒（最近 300 根），沒有未來函數。
 * 每筆用 5 分鐘 K 棒精算、扣手續費（掛單 0.02%、吃單 0.055%）；前後半段分開看。
 * 合併後則數＝同一個幣、同方向、1 小時內的推播算一則（合併成一則訊息後實際會收到幾則）。
 */

import fs from 'node:fs';
import { analyze } from '../../src/smc/engine.js';
import { aggregateBias, tfSuite } from '../../src/smc/mtf.js';
import { opt as optFrom, klines, runSignals, r2, pct, printTable } from './lib.mjs';

const ARGS = process.argv.slice(2);
const opt = (n, d) => optFrom(ARGS, n, d);
const DAYS = Number(opt('days', 150));
const SUB = opt('sub', '5m');
const MAKER = Number(opt('maker-fee', 0.0002));
const TAKER = Number(opt('taker-fee', 0.00055));
const MIN_SCORE = Number(opt('smc-min-score', 65));
const OUT = opt('out', 'data/research/smc-mtf-filter.json');
const SYMBOLS = opt('smc-symbols', 'BTCUSDT,ETHUSDT,XRPUSDT,BNBUSDT,SOLUSDT,DOGEUSDT,ADAUSDT,TRXUSDT,LINKUSDT,AVAXUSDT').split(',').filter(Boolean);
const INTERVALS = opt('smc-intervals', '15m,30m,1h,2h,4h,6h,1d').split(',').filter(Boolean);
const ALERT_TTL = Number(opt('alert-ttl-h', 6)) * 3_600_000;
const UPPER_BARS = 300;
const log = (...a) => console.log(...a);

const UPPER = { '15m': ['1h', '4h'], '30m': ['1h', '4h'], '1h': ['4h', '1d'], '2h': ['4h', '1d'], '4h': ['1d', '1w'], '6h': ['1d', '1w'], '1d': ['1w'] };
const MS = { '15m': 9e5, '30m': 18e5, '1h': 36e5, '2h': 72e5, '4h': 144e5, '6h': 216e5, '1d': 864e5, '1w': 6048e5 };
const DAY = 864e5;
const now = Date.now();
const start = now - DAYS * DAY;
const barsFor = (iv, extra) => Math.ceil((DAYS * DAY) / MS[iv]) + extra;

function feeOf(t) {
  const entryFee = t.entryType === 'market' ? TAKER : MAKER;
  const makerExit = t.status === 'target' ? 1 : t.events.filter((e) => e.type === 'target' && e.partial).reduce((a, e) => a + e.partial, 0);
  return entryFee + makerExit * MAKER + (1 - makerExit) * TAKER;
}
const netR = (t) => t.r - feeOf(t) / t.stopPct;

function closedIdx(list, ms, t) {
  let lo = 0, hi = list.length - 1, idx = -1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (list[m].time + ms <= t) { idx = m; lo = m + 1; } else hi = m - 1;
  }
  return idx;
}

const TREND_DIR = { bullish: 'long', bearish: 'short' };

(async () => {
  const candlesBy = new Map();
  const signals = [];
  const allTfs = [...new Set([...INTERVALS, ...INTERVALS.flatMap((iv) => UPPER[iv] ?? []), ...INTERVALS.map((iv) => tfSuite(iv).htf)])];

  for (const symbol of SYMBOLS) {
    const data = {};
    for (const iv of allTfs) {
      try { data[iv] = await klines(symbol, iv, barsFor(iv, 520)); } catch (e) { log(`  ${symbol} ${iv}: 取得資料失敗（${e.message}）`); }
    }
    // 上面週期在某根收盤時的結構（同一根只算一次）
    const structCache = new Map();
    const structAt = (iv, t) => {
      const list = data[iv];
      if (!list) return null;
      const i = closedIdx(list, MS[iv], t);
      if (i < 60) return null;
      const k = `${iv}|${i}`;
      if (!structCache.has(k)) {
        const a = analyze(list.slice(Math.max(0, i - UPPER_BARS + 1), i + 1));
        structCache.set(k, a.empty ? null : { swing: TREND_DIR[a.structure.swing.trendLabel] ?? null, internal: TREND_DIR[a.structure.internal.trendLabel] ?? null });
      }
      return structCache.get(k);
    };

    for (const interval of INTERVALS) {
      const c = data[interval];
      if (!c) continue;
      candlesBy.set(`${symbol}|${interval}`, c);
      const ms = MS[interval];
      const htfIv = tfSuite(interval).htf;
      const h = data[htfIv];
      const htfCache = new Map();
      let n = 0;
      for (let i = 498; i < c.length; i++) {
        const closeAt = c[i].time + ms;
        if (closeAt < start || closeAt > now) continue;
        let htf = null;
        const hi = h ? closedIdx(h, MS[htfIv], closeAt) : -1;
        if (hi >= 60) {
          if (!htfCache.has(hi)) {
            htfCache.clear();
            const ha = analyze(h.slice(Math.max(0, hi - 258), hi + 1));
            htfCache.set(hi, ha.empty ? null : aggregateBias([{ interval: htfIv, bias: ha.bias }]));
          }
          htf = htfCache.get(hi);
        }
        let a;
        try { a = analyze(c.slice(i - 498, i + 1), { htfBias: htf }); } catch { continue; }
        const s = a.setup;
        if (!s || s.none || !s.valid || s.score < MIN_SCORE || s.entryType === 'market' || !s.targets?.length) continue;
        const [u1, u2] = UPPER[interval] ?? [];
        const s1 = u1 ? structAt(u1, closeAt) : null;
        const s2 = u2 ? structAt(u2, closeAt) : null;
        n++;
        signals.push({
          kind: 'smc', strategy: 'SMC 計畫', symbol, interval, index: i, time: closeAt,
          dir: s.dir, entry: s.entry, stop: s.stop, entryType: s.entryType,
          targets: s.targets.map((t) => ({ name: t.name, price: t.price, rr: t.rr, label: t.label })),
          stopPct: Math.abs(s.entry - s.stop) / s.entry, grade: s.grade, score: s.score,
          up: { u1, u2: u2 ?? null, s1, s2 },
        });
      }
      log(`  ${symbol} ${interval}：${n} 根收盤有可推播的計畫`);
    }
    if (SUB) {
      try { candlesBy.set(`${symbol}|sub`, await klines(symbol, SUB, Math.ceil(((DAYS + 3) * 1440) / 5))); } catch (e) { log(`  ${symbol} ${SUB}: 取得資料失敗（${e.message}）`); }
    }
  }

  // 跑出場（5 分鐘精算；沒有細 K 棒的退回原週期）
  const fine = SUB ? runSignals(signals, candlesBy, { entryWindowBars: 1, subBars: true, fillBarPath: true }) : [];
  const key = (t) => `${t.symbol}|${t.interval}|${t.time}|${t.dir}`;
  const done = new Set(fine.map(key));
  const coarse = runSignals(signals.filter((s) => !done.has(key(s))), candlesBy, { entryWindowBars: 1, fillBarPath: true });
  const trades = [...fine.map((t) => ({ ...t, precise: true })), ...coarse.map((t) => ({ ...t, precise: false }))]
    .filter((t) => !(t.status === 'expired' && t.exitReason === 'timeout'))
    .sort((a, b) => a.filledTime - b.filledTime);

  const ok = (st, dir, field) => !st || st[field] === dir; // 沒有上面週期資料（例如 1d 沒有第二層）就不擋
  const VARIANTS = [
    { key: 'base', zh: '現在（不過濾）', pass: () => true },
    { key: 'A', zh: 'A 上兩層大結構同向', pass: (t) => ok(t.up.s1, t.dir, 'swing') && ok(t.up.s2, t.dir, 'swing') && !!t.up.s1 },
    { key: 'B', zh: 'B 上兩層大結構＋上一層沒回調', pass: (t) => ok(t.up.s1, t.dir, 'swing') && ok(t.up.s2, t.dir, 'swing') && ok(t.up.s1, t.dir, 'internal') && !!t.up.s1 },
    { key: 'C', zh: 'C 只看上一層（大＋小結構）', pass: (t) => !!t.up.s1 && ok(t.up.s1, t.dir, 'swing') && ok(t.up.s1, t.dir, 'internal') },
  ];
  // 線上的去重（6 小時內同幣／週期／方向／進場價只推一次）要在過濾之後做：被擋掉的不會佔去重的位子
  const dedupe = (xs) => {
    const last = new Map();
    return xs.filter((t) => {
      const k = `${t.symbol}|${t.interval}|${t.dir}|${t.entry}`;
      if (t.filledTime - (last.get(k) ?? -Infinity) < ALERT_TTL) return false;
      last.set(k, t.filledTime);
      return true;
    });
  };
  const merged = (xs) => {
    const last = new Map();
    let n = 0;
    for (const t of xs) {
      const k = `${t.symbol}|${t.dir}`;
      if (t.filledTime - (last.get(k) ?? -Infinity) >= 3_600_000) n++;
      last.set(k, t.filledTime);
    }
    return n;
  };
  const sets = Object.fromEntries(VARIANTS.map((v) => [v.key, dedupe(trades.filter(v.pass))]));

  const mid = start + (now - start) / 2;
  const rowOf = (name, xs) => {
    if (!xs.length) return [name, '0', '-', '-', '-', '-', '-'];
    const rs = xs.map(netR);
    const sum = rs.reduce((a, b) => a + b, 0);
    const h1 = xs.filter((t) => t.filledTime < mid).map(netR);
    const h2 = xs.filter((t) => t.filledTime >= mid).map(netR);
    const avg = (a) => (a.length ? r2(a.reduce((x, y) => x + y, 0) / a.length) : '-');
    return [name, String(xs.length), pct((rs.filter((r) => r > 0).length / xs.length) * 100), r2(sum), r2(sum / xs.length), avg(h1), avg(h2)];
  };
  const head = ['分組', '筆數', '勝率', '合計 R', '每筆 R', '前半每筆', '後半每筆'];
  log(`\n■ 最近 ${DAYS} 天（${new Date(start).toISOString().slice(0, 10)} ～ ${new Date(now).toISOString().slice(0, 10)}），${SYMBOLS.length} 檔 × ${INTERVALS.join('/')}，每筆 R 已扣手續費；前半／後半以 ${new Date(mid).toISOString().slice(0, 10)} 切開`);
  log(`  有計畫的收盤 ${signals.length} 次；用 5 分鐘精算的 ${trades.filter((t) => t.precise).length} 筆、原週期 ${trades.filter((t) => !t.precise).length} 筆`);
  log('\n● 各過濾方式（全部週期）');
  printTable(log, [...head, '合併後則數'], VARIANTS.map((v) => [...rowOf(v.zh, sets[v.key]), String(merged(sets[v.key]))]));
  for (const v of VARIANTS) {
    log(`\n● ${v.zh}：各週期`);
    printTable(log, head, [
      ...INTERVALS.map((iv) => rowOf(iv, sets[v.key].filter((t) => t.interval === iv))),
      rowOf('多單', sets[v.key].filter((t) => t.dir === 'long')),
      rowOf('空單', sets[v.key].filter((t) => t.dir === 'short')),
    ]);
  }
  // 被 B 擋掉的那些本來表現如何（擋得對不對）
  const bKeys = new Set(sets.B.map(key));
  log('\n● 被 B 擋掉的推播（本來會進場的）');
  printTable(log, head, [rowOf('被擋掉的', sets.base.filter((t) => !bKeys.has(key(t))))]);

  const pack = (t) => ({
    sym: t.symbol, iv: t.interval, dir: t.dir, sig: t.time, fill: t.filledTime, r: Math.round(netR(t) * 1000) / 1000,
    grade: t.grade, score: t.score, u1: t.up.u1, u2: t.up.u2, s1: t.up.s1, s2: t.up.s2,
    pass: Object.fromEntries(VARIANTS.slice(1).map((v) => [v.key, v.pass(t)])), precise: t.precise,
  });
  fs.mkdirSync('data/research', { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({ generatedAt: new Date(now).toISOString(), days: DAYS, symbols: SYMBOLS, intervals: INTERVALS, minScore: MIN_SCORE, trades: sets.base.map(pack) }));
  log(`\n逐筆清單已寫到 ${OUT}（基準 ${sets.base.length} 筆，各筆附上面兩層結構和是否通過 A／B／C）`);
})();
