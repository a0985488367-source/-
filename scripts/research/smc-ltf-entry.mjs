#!/usr/bin/env node
/**
 * SMC「由低週期進場」兩種做法的比較回測（2026-10-13 使用者要的：高週期進場停損寬、起起伏伏，想用低週期進場）。
 *
 *   node scripts/research/smc-ltf-entry.mjs --days=150 --sub=5m
 *
 * 做法一  只推低週期：15m／30m／1h 自己的 SMC 計畫（跟線上一樣：分數 ≥ 65、要等回踩、計畫只活一根、碰到進場價才算），
 *         再加上線上的「統整週期」過濾 B（上面兩層大結構同向＋上一層小結構同向）。2h 以上不推、只當方向。
 * 做法二  高週期給位置、低週期確認：1h／2h／4h／6h／1d 的 SMC 計畫給出進場區（POI 上下緣）時先不進場，
 *         等價格碰到進場區後，低週期（1h/2h/4h→15m、6h→30m、1d→1h）在區域裡做出反向高／低點、
 *         再收盤跌破（做空）／突破（做多）那個高／低點前面的轉折點（CHoCH）才進場：下一根開盤市價進、
 *         停損放在區域裡做出來的極值外面 0.1 ATR，比高週期的停損小很多。
 *         進場區活 3 根高週期 K 棒；碰到後最多等 2 根高週期 K 棒的確認；收盤穿過高週期停損就作廢；同一個進場區只做一次。
 *         目標：(a) 高週期計畫的結構目標（跟 SMC 一樣的管理）、(b) 固定 2R。另外看 (c) 再加過濾 B（用低週期的上面兩層）。
 * 都用 5 分鐘 K 棒精算、扣手續費（掛單 0.02%、吃單 0.055%）、前後半段分開；附每天平均推幾則。
 */

import fs from 'node:fs';
import { analyze } from '../../src/smc/engine.js';
import { aggregateBias, tfSuite } from '../../src/smc/mtf.js';
import { atr } from '../../src/core/indicators.js';
import { opt as optFrom, klines, runSignals, r2, pct, printTable } from './lib.mjs';

const ARGS = process.argv.slice(2);
const opt = (n, d) => optFrom(ARGS, n, d);
const DAYS = Number(opt('days', 150));
const SUB = opt('sub', '5m');
const MAKER = Number(opt('maker-fee', 0.0002));
const TAKER = Number(opt('taker-fee', 0.00055));
const MIN_SCORE = Number(opt('smc-min-score', 65));
const OUT = opt('out', 'data/research/smc-ltf-entry.json');
const SYMBOLS = opt('smc-symbols', 'BTCUSDT,ETHUSDT,XRPUSDT,BNBUSDT,SOLUSDT,DOGEUSDT,ADAUSDT,TRXUSDT,LINKUSDT,AVAXUSDT').split(',').filter(Boolean);
const LTFS = ['15m', '30m', '1h'];
const PAIRS = [['1h', '15m'], ['2h', '15m'], ['4h', '15m'], ['6h', '30m'], ['1d', '1h']];
const ZONE_LIFE = 3;   // 進場區活幾根高週期 K 棒
const CONFIRM_HTF = 2; // 碰到之後最多等幾根高週期 K 棒的確認
const PIVOT = 2;       // 轉折點左右各幾根
const MIN_STOP_PCT = 0.0015;
const ALERT_TTL = 6 * 3_600_000;
const UPPER_BARS = 300;
const log = (...a) => console.log(...a);

const UPPER = { '15m': ['1h', '4h'], '30m': ['1h', '4h'], '1h': ['4h', '1d'], '2h': ['4h', '1d'], '4h': ['1d', '1w'], '6h': ['1d', '1w'], '1d': ['1w'] };
const MS = { '15m': 9e5, '30m': 18e5, '1h': 36e5, '2h': 72e5, '4h': 144e5, '6h': 216e5, '1d': 864e5, '1w': 6048e5 };
const DAY = 864e5;
const now = Date.now();
const start = now - DAYS * DAY;
const barsFor = (iv, extra) => Math.ceil((DAYS * DAY) / MS[iv]) + extra;
const TREND_DIR = { bullish: 'long', bearish: 'short' };

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
function firstAtOrAfter(list, t) {
  let lo = 0, hi = list.length - 1, idx = -1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (list[m].time >= t) { idx = m; hi = m - 1; } else lo = m + 1;
  }
  return idx;
}

/** 做法二：一個高週期進場區，在低週期上等碰到＋轉向確認。回傳進場訊號或 null */
function ltfConfirm(L, atrArr, ltfMs, zone) {
  const { dir, top, bottom, htfStop, from, zoneMs } = zone;
  const long = dir === 'long';
  let j = firstAtOrAfter(L, from);
  if (j < 0) return null;
  const lifeEnd = from + ZONE_LIFE * zoneMs;
  // 1. 等價格碰到進場區
  let jt = -1;
  for (; j < L.length && L[j].time < lifeEnd; j++) {
    const c = L[j];
    if (long ? c.close < htfStop : c.close > htfStop) return null;
    if (long ? c.low <= top : c.high >= bottom) { jt = j; break; }
  }
  if (jt < 0) return null;
  // 2. 在區域裡等轉向確認：做空＝碰到後創的最高點之前的轉折低點被收盤跌破
  const confirmEnd = L[jt].time + CONFIRM_HTF * zoneMs;
  let ext = jt; // 碰到後的極值那根
  for (let k = jt; k < L.length - 1 && L[k].time < confirmEnd; k++) {
    const c = L[k];
    if (long ? c.close < htfStop : c.close > htfStop) return null;
    if (long ? c.low < L[ext].low : c.high > L[ext].high) ext = k;
    // 極值之前、已經確認的最後一個轉折點（左右各 PIVOT 根）
    let piv = -1;
    for (let p = Math.min(ext - 1, k - PIVOT); p >= Math.max(PIVOT, jt - 30); p--) {
      let ok = true;
      for (let q = 1; q <= PIVOT && ok; q++) {
        ok = long ? (L[p].high > L[p - q].high && L[p].high >= L[p + q].high) : (L[p].low < L[p - q].low && L[p].low <= L[p + q].low);
      }
      if (ok) { piv = p; break; }
    }
    if (piv < 0 || k <= ext) continue;
    const broke = long ? c.close > L[piv].high : c.close < L[piv].low;
    if (!broke) continue;
    const a = atrArr[k] || 0;
    const entry = L[k + 1].open;
    const stop = long ? L[ext].low - 0.1 * a : L[ext].high + 0.1 * a;
    const stopPct = Math.abs(entry - stop) / entry;
    if (!(long ? stop < entry : stop > entry) || stopPct < MIN_STOP_PCT) return null;
    return { index: k, time: L[k].time + ltfMs, filledTime: L[k + 1].time, entry, stop, stopPct, touchTime: L[jt].time };
  }
  return null;
}

(async () => {
  const candlesBy = new Map();
  const m1 = [];         // 做法一的訊號
  const m2 = [];         // 做法二的訊號
  const allTfs = ['15m', '30m', '1h', '2h', '4h', '6h', '1d', '1w'];

  for (const symbol of SYMBOLS) {
    const data = {};
    for (const iv of allTfs) {
      try { data[iv] = await klines(symbol, iv, barsFor(iv, 520)); } catch (e) { log(`  ${symbol} ${iv}: 取得資料失敗（${e.message}）`); }
    }
    for (const iv of LTFS) if (data[iv]) candlesBy.set(`${symbol}|${iv}`, data[iv]);
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
    const gateB = (ltf, dir, t) => {
      const [u1, u2] = UPPER[ltf];
      const s1 = structAt(u1, t);
      const s2 = u2 ? structAt(u2, t) : null;
      return !!s1 && s1.swing === dir && s1.internal === dir && (!u2 || !s2 || s2.swing === dir);
    };

    // 每個週期每根收盤的 SMC 計畫（跟線上一樣帶高週期偏向）
    const plansOf = (interval) => {
      const c = data[interval];
      const out = [];
      if (!c) return out;
      const htfIv = tfSuite(interval).htf;
      const h = data[htfIv];
      const htfCache = new Map();
      for (let i = 498; i < c.length; i++) {
        const closeAt = c[i].time + MS[interval];
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
        out.push({ i, closeAt, s });
      }
      return out;
    };

    const plans = {};
    for (const iv of ['15m', '30m', '1h', '2h', '4h', '6h', '1d']) plans[iv] = plansOf(iv);

    // 做法一
    for (const iv of LTFS) {
      for (const { i, closeAt, s } of plans[iv]) {
        if (!gateB(iv, s.dir, closeAt)) continue;
        m1.push({
          kind: 'm1', strategy: 'SMC 低週期', symbol, interval: iv, index: i, time: closeAt,
          dir: s.dir, entry: s.entry, stop: s.stop, entryType: s.entryType,
          targets: s.targets.map((t) => ({ name: t.name, price: t.price, rr: t.rr, label: t.label })),
          stopPct: Math.abs(s.entry - s.stop) / s.entry,
        });
      }
    }

    // 做法二
    for (const [ziv, ltf] of PAIRS) {
      const L = data[ltf];
      if (!L) continue;
      const atrArr = atr(L, 14);
      const seen = new Set();
      let n = 0;
      for (const { closeAt, s } of plans[ziv]) {
        if (!s.poi || !(s.poi.top > s.poi.bottom)) continue;
        const zk = `${s.dir}|${s.poi.bottom}|${s.poi.top}`;
        if (seen.has(zk)) continue;
        const sig = ltfConfirm(L, atrArr, MS[ltf], { dir: s.dir, top: s.poi.top, bottom: s.poi.bottom, htfStop: s.stop, from: closeAt, zoneMs: MS[ziv] });
        if (!sig) continue;
        seen.add(zk);
        n++;
        const long = s.dir === 'long';
        const risk = Math.abs(sig.entry - sig.stop);
        const structTargets = s.targets.filter((t) => (long ? t.price > sig.entry : t.price < sig.entry))
          .map((t) => ({ name: t.name, price: t.price, rr: Math.abs(t.price - sig.entry) / risk, label: t.label }));
        const base = {
          symbol, interval: ltf, zoneTf: ziv, index: sig.index, time: sig.time, filledTime: sig.filledTime,
          dir: s.dir, entry: sig.entry, stop: sig.stop, entryType: 'market', stopPct: sig.stopPct,
          htfStopPct: Math.abs(s.entry - s.stop) / s.entry, gateB: gateB(ltf, s.dir, sig.time),
        };
        if (structTargets.length) m2.push({ ...base, kind: 'm2s', strategy: `區域 ${ziv}→${ltf} 結構目標`, targets: structTargets });
        m2.push({ ...base, kind: 'm2r', strategy: `區域 ${ziv}→${ltf} 固定 2R`, targets: [{ name: 'TP1', price: long ? sig.entry + 2 * risk : sig.entry - 2 * risk, rr: 2 }] });
      }
      log(`  ${symbol} 區域 ${ziv}→${ltf}：${n} 個進場區有低週期確認`);
    }
    log(`  ${symbol}：做法一 ${m1.filter((x) => x.symbol === symbol).length} 個計畫`);
    if (SUB) {
      try { candlesBy.set(`${symbol}|sub`, await klines(symbol, SUB, Math.ceil(((DAYS + 3) * 1440) / 5))); } catch (e) { log(`  ${symbol} ${SUB}: 取得資料失敗（${e.message}）`); }
    }
  }

  const key = (t) => `${t.symbol}|${t.interval}|${t.time}|${t.strategy}|${t.dir}`;
  const run = (sigs, cfg) => {
    const fine = SUB ? runSignals(sigs, candlesBy, { ...cfg, subBars: true, fillBarPath: true }) : [];
    const done = new Set(fine.map(key));
    const coarse = runSignals(sigs.filter((s) => !done.has(key(s))), candlesBy, { ...cfg, fillBarPath: true });
    return [...fine.map((t) => ({ ...t, precise: true })), ...coarse.map((t) => ({ ...t, precise: false }))]
      .filter((t) => !(t.status === 'expired' && t.exitReason === 'timeout'))
      .sort((a, b) => a.filledTime - b.filledTime);
  };
  // 做法一：線上的去重（6 小時內同幣／週期／方向／進場價只推一次）
  const last = new Map();
  const t1 = run(m1, { entryWindowBars: 1 }).filter((t) => {
    const k = `${t.symbol}|${t.interval}|${t.dir}|${t.entry}`;
    if (t.filledTime - (last.get(k) ?? -Infinity) < ALERT_TTL) return false;
    last.set(k, t.filledTime);
    return true;
  });
  const t2s = run(m2.filter((s) => s.kind === 'm2s'), {});
  const t2r = run(m2.filter((s) => s.kind === 'm2r'), { breakevenAtR: 0, trailFromR: 0 });

  const mid = start + (now - start) / 2;
  const perDay = (xs) => {
    const lastPush = new Map();
    let n = 0;
    for (const t of xs) {
      const k = `${t.symbol}|${t.dir}`;
      if (t.filledTime - (lastPush.get(k) ?? -Infinity) >= 3_600_000) n++;
      lastPush.set(k, t.filledTime);
    }
    return (n / DAYS).toFixed(1);
  };
  const rowOf = (name, xs) => {
    if (!xs.length) return [name, '0', '-', '-', '-', '-', '-', '-', '-'];
    const rs = xs.map(netR);
    const sum = rs.reduce((a, b) => a + b, 0);
    const avg = (a) => (a.length ? r2(a.reduce((x, y) => x + y, 0) / a.length) : '-');
    const stopAvg = xs.reduce((a, t) => a + t.stopPct, 0) / xs.length;
    return [name, String(xs.length), pct((rs.filter((r) => r > 0).length / xs.length) * 100), r2(sum), r2(sum / xs.length),
      avg(xs.filter((t) => t.filledTime < mid).map(netR)), avg(xs.filter((t) => t.filledTime >= mid).map(netR)), `${(stopAvg * 100).toFixed(2)}%`, perDay(xs)];
  };
  const head = ['分組', '筆數', '勝率', '合計 R', '每筆 R', '前半每筆', '後半每筆', '平均停損', '每天推幾則'];
  log(`\n■ 最近 ${DAYS} 天（${new Date(start).toISOString().slice(0, 10)} ～ ${new Date(now).toISOString().slice(0, 10)}），${SYMBOLS.length} 檔，每筆 R 已扣手續費；前半／後半以 ${new Date(mid).toISOString().slice(0, 10)} 切開`);
  log('\n● 總覽');
  printTable(log, head, [
    rowOf('做法一 只推 15m/30m/1h＋過濾 B', t1),
    rowOf('做法二 高週期區域＋低週期確認（結構目標）', t2s),
    rowOf('做法二（固定 2R）', t2r),
    rowOf('做法二（結構目標）＋過濾 B', t2s.filter((t) => t.gateB)),
    rowOf('做法二（固定 2R）＋過濾 B', t2r.filter((t) => t.gateB)),
  ]);
  log('\n● 做法一：各週期');
  printTable(log, head, [...LTFS.map((iv) => rowOf(iv, t1.filter((t) => t.interval === iv))), rowOf('多單', t1.filter((t) => t.dir === 'long')), rowOf('空單', t1.filter((t) => t.dir === 'short'))]);
  for (const [name, xs] of [['做法二（結構目標）', t2s], ['做法二（固定 2R）', t2r]]) {
    log(`\n● ${name}：各組合`);
    printTable(log, head, [...PAIRS.map(([z, l]) => rowOf(`${z}→${l}`, xs.filter((t) => t.zoneTf === z))), rowOf('多單', xs.filter((t) => t.dir === 'long')), rowOf('空單', xs.filter((t) => t.dir === 'short'))]);
  }
  const zoneStop = m2.filter((s) => s.kind === 'm2r');
  if (zoneStop.length) log(`\n做法二的停損平均 ${(zoneStop.reduce((a, s) => a + s.stopPct, 0) / zoneStop.length * 100).toFixed(2)}%，同一個高週期計畫原本的停損平均 ${(zoneStop.reduce((a, s) => a + s.htfStopPct, 0) / zoneStop.length * 100).toFixed(2)}%`);

  const pack = (t) => ({ k: t.kind, s: t.strategy, sym: t.symbol, iv: t.interval, z: t.zoneTf ?? null, dir: t.dir, fill: t.filledTime, r: Math.round(netR(t) * 1000) / 1000, stopPct: Math.round(t.stopPct * 1e5) / 1e3, gateB: t.gateB ?? null });
  fs.mkdirSync('data/research', { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({ generatedAt: new Date(now).toISOString(), days: DAYS, symbols: SYMBOLS, trades: [...t1, ...t2s, ...t2r].map(pack) }));
  log(`\n逐筆清單已寫到 ${OUT}`);
})();
