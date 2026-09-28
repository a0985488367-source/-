#!/usr/bin/env node
/**
 * 突破後兩條路（2026-09 使用者提的做法）：
 *   假突破 → 出現 MSS（收盤跌破最近的小波段低點、又回到突破線內）就反手
 *   確定延續 → 突破後回檔形成小波段低點、再收盤突破回檔前的高點（BOS），
 *              對「回檔低點 → 最新高點」拉斐波那契，在 OTE 區掛限價單進場
 *
 * 規則（做多突破為例，做空反過來；全部只用當下已經收盤、已經確認的 K 棒）：
 *   突破線   D55＝近 55 根最高點（跟線上突破策略同一個判斷，含 EMA200 同側）
 *            SW ＝最近一個已確認、還沒被收盤突破過的結構高點（左右各 --swing 根）
 *   小波段   左右各 --k 根的分形高低點，要等右邊 k 根收完才算確認
 *   延續     突破後 --window 根內：確認了一個小波段低點 PL，之後收盤高過「突破到 PL 之間的最高點」
 *            → 從下一根開始，限價買在 高點 −f×(高點−PL)，高點隨新高更新（斐波那契跟著重拉）；
 *              --fill-bars 根內沒成交就放棄。停損 PL 下方 --buf 倍 ATR
 *   MSS 反手 延續出現之前，收盤跌破最近一個已確認的小波段低點、而且收回突破線內
 *            MKT：下一根開盤市價做空；OTE：對「假突破最高點 → 之後最低點」拉斐波那契，
 *            限價空在 低點＋f×(高點−低點)，低點隨新低更新。停損都在假突破最高點上方 --buf 倍 ATR
 *   止盈     T0＝斐波那契 0（高點／低點）、T-0.27＝延伸 −0.27、1R、2R 固定
 *   手續費   限價進場＝maker、市價＝taker；止盈限價＝maker、停損＝taker
 *
 * 另外印一組對照：BASE（線上原本的突破：D55 收盤市價進、2 ATR 停損、1R 止盈）。
 *
 * 用法：node scripts/research/fakeout-ote.mjs --symbols=BTCUSDT,ETHUSDT --intervals=15m,1h,4h,6h
 *        --limit=5000 --limits=15m:15000 --sub=5m --sub-days=150
 */

import { opt as optFrom, klines, runSignals, r2, pct, printTable } from './lib.mjs';
import { fakeoutEvents } from '../../src/strategies/fakeout.js';
import { prepare } from './strategy-zoo.mjs';

const ARGS = process.argv.slice(2);
const opt = (n, d) => optFrom(ARGS, n, d);
const SYMBOLS = opt('symbols', 'BTCUSDT,ETHUSDT,SOLUSDT,BNBUSDT,XRPUSDT,DOGEUSDT,ADAUSDT,AVAXUSDT,LINKUSDT,LTCUSDT,DOTUSDT,NEARUSDT,APTUSDT,ARBUSDT,OPUSDT').split(',');
const INTERVALS = opt('intervals', '15m,1h,4h,6h').split(',');
const LIMIT = Number(opt('limit', 5000));
// --limits=15m:15000 個別週期抓更多根（15 分鐘 5000 根只有 52 天）
const LIMITS = Object.fromEntries(opt('limits', '15m:15000').split(',').filter(Boolean).map((x) => x.split(':')).map(([k, v]) => [k, Number(v)]));
const SUB = opt('sub', '5m');
const SUB_DAYS = Number(opt('sub-days', 150));
const MAKER = Number(opt('maker-fee', 0.0002));
const TAKER = Number(opt('taker-fee', 0.00055));
const K = Number(opt('k', 2));
const SWING = Number(opt('swing', 5));
const WINDOW = Number(opt('window', 20));
const FILL_BARS = Number(opt('fill-bars', 10));
const BUF = Number(opt('buf', 0.1));
const MIN_RISK_ATR = Number(opt('min-risk-atr', 0.3));
const FIBS = opt('fibs', '0.618,0.705,0.79').split(',').map(Number);
const MODES = opt('modes', 'D55,SW').split(',');
const WARMUP = 210;
const log = (...a) => console.log(...a);

const EXITS = ['T0', 'T-0.27', '1R', '2R'];

/**
 * 找出一個幣／週期的所有交易設定。回傳訊號陣列（給 runSignals）：
 *   setup 名稱 = `${mode}_CONT_OTE${f}`／`${mode}_MSS_MKT`／`${mode}_MSS_OTE${f}`，exit 另外帶
 * 突破／延續／MSS 的判斷在 src/strategies/fakeout.js（線上 Worker 用同一份）
 */
function scan(symbol, interval, c, mode) {
  const x = prepare(c);
  const n = c.length;
  const out = [];
  const half = (i) => (i < (WARMUP + n) / 2 ? 0 : 1);
  const base = { symbol, interval };
  const push = (setup, sig, extremes) => {
    for (const exit of EXITS) {
      if (setup.endsWith('MKT') && exit.startsWith('T')) continue;
      const risk = Math.abs(sig.entry - sig.stop);
      const long = sig.dir === 'long';
      let tp;
      if (exit === '1R') tp = sig.entry + (long ? 1 : -1) * risk;
      else if (exit === '2R') tp = sig.entry + (long ? 2 : -2) * risk;
      else if (exit === 'T0') tp = extremes.t0;
      else tp = extremes.t0 + (long ? 1 : -1) * 0.27 * extremes.leg;
      const rr = Math.abs(tp - sig.entry) / risk;
      if (!(rr > 0.2)) continue;
      out.push({ ...base, ...sig, setup, exit, targets: [{ name: 'TP1', price: tp, rr }], stopPct: risk / sig.entry, half: half(sig.index) });
    }
  };

  const events = fakeoutEvents(c, { mode, k: K, swing: SWING, window: WINDOW, buf: BUF, from: WARMUP, lastBar: n - 2 }, { atr: x.a, ema: x.e200 });
  for (const ev of events) {
    const L = ev.dir === 'long';
    const d = L ? 1 : -1;
    const ext = (k) => (L ? c[k].high : c[k].low); // 突破方向的極值
    const opp = (k) => (L ? c[k].low : c[k].high);
    const better = (p, q) => (L ? p > q : p < q);

    if (ev.type === 'breakout') {
      // BASE：原本的突破單（只有 D55 才有；不受「同時只追一個設定」影響，跟線上一樣）
      if (mode !== 'D55') continue;
      const b = ev.index;
      const entry = c[b + 1].open;
      const risk = 2 * x.a[b];
      out.push({ ...base, setup: 'BASE', exit: '1R', index: b, time: c[b].time, dir: ev.dir, entry, stop: entry - d * risk,
        entryType: 'market', filledTime: c[b + 1].time, targets: [{ name: 'TP1', price: entry + d * risk, rr: 1 }], stopPct: risk / entry, half: half(b) });
      continue;
    }

    const j = ev.index;
    if (ev.type === 'cont') {
      // 延續：從下一根開始，限價買在 高點 −f×(高點−PL)，高點隨新高更新
      const PL = ev.pl;
      const stop = PL.price - d * BUF * x.a[j];
      for (const f of FIBS) {
        let hi = ev.H;
        for (let q = PL.index; q <= j; q++) if (better(ext(q), hi)) hi = ext(q);
        for (let q = j + 1; q <= Math.min(j + FILL_BARS, n - 1); q++) {
          const leg = Math.abs(hi - PL.price);
          const entry = hi - d * f * leg;
          const risk = Math.abs(entry - stop);
          const touched = L ? c[q].low <= entry : c[q].high >= entry;
          if (touched) {
            if (risk >= MIN_RISK_ATR * x.a[j]) {
              push(`${mode}_CONT_OTE${f}`, { index: q - 1, time: c[j].time, dir: ev.dir, entry, stop, entryType: 'limit' }, { t0: hi, leg });
            }
            break;
          }
          if (better(ext(q), hi)) hi = ext(q);
        }
      }
      continue;
    }

    // MSS 反手
    const { H, Hidx, stop, rdir: rd } = ev;
    const rs = -d;
    // MKT：下一根開盤市價
    const entry = c[j + 1].open;
    if ((stop - entry) * d > MIN_RISK_ATR * x.a[j]) {
      push(`${mode}_MSS_MKT`, { index: j, time: c[j].time, dir: rd, entry, stop, entryType: 'market', filledTime: c[j + 1].time }, null);
    }
    // OTE：假突破最高點 → 之後最低點
    for (const f of FIBS) {
      let lo = opp(Hidx);
      for (let q = Hidx; q <= j; q++) if (rs > 0 ? c[q].high > lo : c[q].low < lo) lo = rs > 0 ? c[q].high : c[q].low;
      for (let q = j + 1; q <= Math.min(j + FILL_BARS, n - 1); q++) {
        const leg = Math.abs(H - lo);
        const e = lo + d * f * leg;
        const risk = Math.abs(stop - e);
        const touched = L ? c[q].high >= e : c[q].low <= e;
        if (touched) {
          if (risk >= MIN_RISK_ATR * x.a[j]) {
            push(`${mode}_MSS_OTE${f}`, { index: q - 1, time: c[j].time, dir: rd, entry: e, stop, entryType: 'limit' }, { t0: lo, leg });
          }
          break;
        }
        if (rs > 0 ? c[q].high > lo : c[q].low < lo) lo = rs > 0 ? c[q].high : c[q].low;
      }
    }
  }
  return out;
}

/** 同一個幣同時只抱一張（同一種設定＋出場裡） */
function onePerSymbol(trades) {
  const lastClose = new Map();
  return [...trades].sort((a, b) => a.filledTime - b.filledTime).filter((t) => {
    const key = `${t.symbol}|${t.interval}`;
    if (t.filledTime < (lastClose.get(key) ?? -Infinity)) return false;
    lastClose.set(key, t.closedTime);
    return true;
  });
}

function feeOf(t) {
  const entryFee = t.entryType === 'limit' ? MAKER : TAKER;
  const makerExit = t.status === 'target' ? 1 : t.events.filter((e) => e.type === 'target' && e.partial).reduce((a, e) => a + e.partial, 0);
  return entryFee + makerExit * MAKER + (1 - makerExit) * TAKER;
}

const CFG = { breakevenAtR: 0, trailFromR: 0, scalpR: 0, entryWindowBars: 1, fillBarPath: true };
function runSet(sigs, candlesBy, cfg) {
  return onePerSymbol(runSignals(sigs, candlesBy, cfg).filter((t) => !(t.status === 'expired' && t.exitReason === 'timeout')));
}

(async () => {
  const candlesBy = new Map();
  let subStart = Infinity, subEnd = -Infinity;
  for (const symbol of SYMBOLS) {
    for (const interval of INTERVALS) {
      try {
        candlesBy.set(`${symbol}|${interval}`, await klines(symbol, interval, LIMITS[interval] ?? LIMIT));
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
  const netR = (t) => t.r - feeOf(t) / t.stopPct;
  const weeks = SUB_DAYS / 7;
  const avg = (xs) => (xs.length ? xs.reduce((a, t) => a + netR(t), 0) / xs.length : NaN);
  const cell = (xs) => (xs.length ? `${r2(avg(xs))}（${xs.length}）` : '-');

  const summary = [];
  for (const interval of INTERVALS) {
    const sigs = [];
    for (const symbol of SYMBOLS) {
      const c = candlesBy.get(`${symbol}|${interval}`);
      if (!c || c.length < WARMUP + 50) continue;
      for (const mode of MODES) sigs.push(...scan(symbol, interval, c, mode));
    }
    const groups = new Map();
    for (const s of sigs) {
      const key = `${s.setup}|${s.exit}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(s);
    }
    const rows = [];
    for (const [key, list] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
      const [setup, exit] = key.split('|');
      const coarse = runSet(list, candlesBy, CFG);
      const fine = SUB ? runSet(list, candlesBy, { ...CFG, subBars: true }) : [];
      const fh = (h) => fine.filter((t) => (t.filledTime < mid ? 0 : 1) === h);
      const four = [avg(coarse.filter((t) => t.half === 0)), avg(coarse.filter((t) => t.half === 1)), avg(fh(0)), avg(fh(1))];
      const win = fine.length ? fine.filter((t) => netR(t) > 0).length / fine.length : NaN;
      const avgRR = list.length ? list.reduce((a, s) => a + s.targets[0].rr, 0) / list.length : 0;
      rows.push([setup, exit, cell(coarse.filter((t) => t.half === 0)), cell(coarse.filter((t) => t.half === 1)), cell(fh(0)), cell(fh(1)),
        Number.isFinite(win) ? pct(win * 100) : '-', (fine.length / weeks).toFixed(1), avgRR.toFixed(2)]);
      summary.push({ i: interval, s: setup, e: exit, f: four.map((v) => (Number.isFinite(v) ? Math.round(v * 1000) / 1000 : null)),
        w: Number.isFinite(win) ? Math.round(win * 1000) / 1000 : null, pw: Math.round((fine.length / weeks) * 10) / 10,
        n: [coarse.filter((t) => t.half === 0).length, coarse.filter((t) => t.half === 1).length, fh(0).length, fh(1).length], rr: Math.round(avgRR * 100) / 100 });
    }
    log(`\n■ ${interval}（扣手續費每筆 R，括號是筆數；5M＝最近 ${SUB_DAYS} 天用 5 分鐘 K 棒逐根跑）`);
    printTable(log, ['設定', '止盈', '原週期 前半', '原週期 後半', '5M 前半', '5M 後半', '5M 勝率', '5M 每週幾張', '平均盈虧比'], rows);
  }
  const robust = summary.filter((r) => r.f.every((v) => v > 0)).sort((a, b) => Math.min(...b.f) - Math.min(...a.f));
  log(`\n■ 四格都賺的組合（共 ${robust.length} 個／${summary.length} 個）`);
  printTable(log, ['週期', '設定', '止盈', '原週期 前半', '原週期 後半', '5M 前半', '5M 後半', '5M 勝率', '5M 每週幾張'],
    robust.map((r) => [r.i, r.s, r.e, ...r.f.map(r2), pct(r.w * 100), String(r.pw)]));
  log('\nSUMMARY_JSON ' + JSON.stringify(summary));
})();
