#!/usr/bin/env node
/**
 * 最近幾天線上「會出現的訊號」逐筆重播：哪些賺、哪些虧（2026-10-05 使用者要的）。
 *
 *   node scripts/research/recent-signals.mjs --days=90 --sub=5m
 *
 * 兩套都照線上同一套判斷重跑（沒有未來函數，每根 K 棒收盤時只用當下已收盤的資料）：
 *   SMC 計畫  SMC_SYMBOLS 10 檔 × 15m～1d 七個週期；每根收盤重算（最近 499 根＋高週期偏向，跟 App／TV／Worker 一樣），
 *             分數 ≥ MIN_SCORE、要等回踩的有效計畫＝Discord 會推播的那種；同一個幣／週期／方向／進場價只算一次；
 *             之後價格碰到進場價才算進場，用 DEFAULT_MANAGEMENT（線上同一套）管理到出場。
 *   順勢策略  6 個 4h／6h 策略（src/strategies，跟 Worker 共用），74 檔；收盤後下一根開盤市價進場，
 *             同一個幣同時只抱一張、全部最多同時 5 張（跟 Demo 自動下單一樣），出場規則照線上設定。
 * 每筆都用 5 分鐘 K 棒精算（限價單成交那根不偷看），扣手續費（掛單 0.02%、吃單 0.055%）。
 * 逐筆清單寫到 data/research/recent-signals.json，摘要印在 log。
 */

import fs from 'node:fs';
import { analyze } from '../../src/smc/engine.js';
import { aggregateBias, tfSuite } from '../../src/smc/mtf.js';
import { breakoutSignal, breakoutIndicators } from '../../src/strategies/breakout.js';
import { emaCrossSignal, emaCrossIndicators } from '../../src/strategies/ema-cross.js';
import { macdZeroSignal, macdZeroIndicators } from '../../src/strategies/macd-zero.js';
import { trendExtraSignal, trendExtraIndicators } from '../../src/strategies/trend-extra.js';
import { opt as optFrom, klines, runSignals, r2, pct, printTable } from './lib.mjs';

const ARGS = process.argv.slice(2);
const opt = (n, d) => optFrom(ARGS, n, d);
const DAYS = Number(opt('days', 90));
const SUB = opt('sub', '5m');
const MAKER = Number(opt('maker-fee', 0.0002));
const TAKER = Number(opt('taker-fee', 0.00055));
const MIN_SCORE = Number(opt('smc-min-score', 65));
const OUT = opt('out', 'data/research/recent-signals.json');
const log = (...a) => console.log(...a);

// worker/wrangler.toml 的 SMC_SYMBOLS／WORKER_SCAN_INTERVAL
const SMC_SYMBOLS = opt('smc-symbols', 'BTCUSDT,ETHUSDT,XRPUSDT,BNBUSDT,SOLUSDT,DOGEUSDT,ADAUSDT,TRXUSDT,LINKUSDT,AVAXUSDT').split(',').filter(Boolean);
const SMC_INTERVALS = opt('smc-intervals', '15m,30m,1h,2h,4h,6h,1d').split(',').filter(Boolean);
// worker/index.js 的 BREAKOUT_DEFAULT_SYMBOLS（74 檔）
const TREND_SYMBOLS = opt('trend-symbols', [
  'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'DOGEUSDT', 'ADAUSDT', 'AVAXUSDT', 'LINKUSDT', 'LTCUSDT',
  'DOTUSDT', 'NEARUSDT', 'APTUSDT', 'ARBUSDT', 'OPUSDT',
  'SUIUSDT', 'TRXUSDT', 'ATOMUSDT', 'FILUSDT', 'INJUSDT', 'SEIUSDT', 'TIAUSDT', 'WLDUSDT', 'AAVEUSDT', 'UNIUSDT',
  'ETCUSDT', 'BCHUSDT', 'HBARUSDT', 'ICPUSDT',
  'FETUSDT', 'RENDERUSDT', 'STXUSDT', 'IMXUSDT', 'GRTUSDT', 'ALGOUSDT', 'SANDUSDT', 'MANAUSDT', 'AXSUSDT', 'CRVUSDT',
  'LDOUSDT', 'DYDXUSDT', 'JUPUSDT', 'ENAUSDT', 'ORDIUSDT',
  'XLMUSDT', 'VETUSDT', 'EGLDUSDT', 'THETAUSDT', 'XTZUSDT', 'NEOUSDT', 'KAVAUSDT', 'ZECUSDT', 'DASHUSDT', 'COMPUSDT',
  'SNXUSDT', 'IOTAUSDT', 'YFIUSDT', 'SUSHIUSDT', '1INCHUSDT',
  'GALAUSDT', 'CHZUSDT', 'ENSUSDT', 'APEUSDT', 'BLURUSDT', 'PENDLEUSDT', 'GMXUSDT', 'RUNEUSDT', 'KSMUSDT', 'ROSEUSDT',
  'CFXUSDT', 'ARUSDT', 'MINAUSDT', 'ONEUSDT', 'ZILUSDT',
].join(',')).split(',').filter(Boolean);
// worker/wrangler.toml 的 <前綴>_TF、止盈、管理方式（ema／macd／st／gc：賺 1R 移到成本、1.5R 後追蹤 1.5R、不設止盈）
const TREND = [
  { key: 'breakout', zh: '唐奇安 55 突破', tf: '6h', tpR: 1 },
  { key: 'ema', zh: 'EMA20／50 交叉', tf: '6h', trail: true },
  { key: 'macd', zh: 'MACD 穿零軸', tf: '6h', trail: true },
  { key: 'vol', zh: '放量突破', tf: '6h', tpR: 2 },
  { key: 'st', zh: '超級趨勢', tf: '4h', trail: true },
  { key: 'gc', zh: '黃金／死亡交叉', tf: '6h', trail: true },
];
const TREND_MAX_OPEN = Number(opt('trend-max-open', 5));
const TREND_WINDOW = 300; // Worker 每次抓 300 根

const MS = { '15m': 9e5, '30m': 18e5, '1h': 36e5, '2h': 72e5, '4h': 144e5, '6h': 216e5, '1d': 864e5, '1w': 6048e5 };
const DAY = 864e5;
const now = Date.now();
const start = now - DAYS * DAY;

function feeOf(t) {
  const entryFee = t.entryType === 'market' ? TAKER : MAKER;
  const makerExit = t.status === 'target' ? 1 : t.events.filter((e) => e.type === 'target' && e.partial).reduce((a, e) => a + e.partial, 0);
  return entryFee + makerExit * MAKER + (1 - makerExit) * TAKER;
}
const netR = (t) => t.r - feeOf(t) / t.stopPct;
const barsFor = (iv, extra) => Math.ceil((DAYS * DAY) / MS[iv]) + extra;

/** 最後一根「在 t 之前已經收盤」的位置 */
function closedIdx(list, ms, t) {
  let lo = 0, hi = list.length - 1, idx = -1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (list[m].time + ms <= t) { idx = m; lo = m + 1; } else hi = m - 1;
  }
  return idx;
}

/** 出場原因（給人看的） */
function exitZh(t) {
  const hit = t.hitTargets?.length ?? 0;
  if (t.status === 'target') return `全部止盈（${hit} 個目標）`;
  if (t.exitReason === 'maxHold') return '持有太久收盤出場';
  const after = hit ? `打到第 ${hit} 個目標後` : '';
  if (t.exitReason === 'trail') return `${after}追蹤停損出場`;
  if (t.exitReason === 'breakeven') return `${after}保本出場`;
  if (t.exitReason === 'stop') return `${after}停損`;
  if (t.exitReason === 'stall' || t.exitReason === 'zoneBreak') return '走不動提早出場';
  return t.exitReason ?? t.status;
}

(async () => {
  const candlesBy = new Map();
  const subBy = new Set();
  const loadSub = async (symbol) => {
    if (!SUB || subBy.has(symbol)) return;
    subBy.add(symbol);
    try {
      candlesBy.set(`${symbol}|sub`, await klines(symbol, SUB, Math.ceil(((DAYS + 3) * 1440) / 5)));
    } catch (e) { log(`  ${symbol} ${SUB}: 取得資料失敗（${e.message}）`); }
  };

  // ── SMC 計畫
  const smcSignals = [];
  for (const symbol of SMC_SYMBOLS) {
    for (const interval of SMC_INTERVALS) {
      const ms = MS[interval];
      const htfIv = tfSuite(interval).htf;
      let c, h;
      try {
        c = await klines(symbol, interval, barsFor(interval, 520));
        h = await klines(symbol, htfIv, Math.ceil((DAYS * DAY) / MS[htfIv]) + 270);
      } catch (e) { log(`  SMC ${symbol} ${interval}: 取得資料失敗（${e.message}）`); continue; }
      candlesBy.set(`${symbol}|${interval}`, c);
      const htfCache = new Map();
      let n = 0;
      for (let i = 498; i < c.length; i++) {
        const closeAt = c[i].time + ms;
        if (closeAt < start || closeAt > now) continue;
        const hi = closedIdx(h, MS[htfIv], closeAt);
        let htf = null;
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
        // 這根收盤算出的計畫只活到下一根收盤（Worker 下一次重掃就換成新計畫）：
        // 下一根碰到進場價才會推播＋進場（entryWindowBars＝1），去重放到成交之後做（跟 Worker 的 KV key 一樣）
        n++;
        smcSignals.push({
          kind: 'smc', strategy: 'SMC 計畫', symbol, interval, index: i, time: closeAt,
          dir: s.dir, entry: s.entry, stop: s.stop, entryType: s.entryType,
          targets: s.targets.map((t) => ({ name: t.name, price: t.price, rr: t.rr, label: t.label })),
          stopPct: Math.abs(s.entry - s.stop) / s.entry, grade: s.grade, score: s.score, poiType: s.poi?.type,
        });
      }
      log(`  SMC ${symbol} ${interval}：${n} 根收盤有可推播的計畫`);
    }
    await loadSub(symbol);
  }

  // ── 順勢策略（同一根 K 棒上有好幾個訊號時照 Worker 的順序：突破、EMA、MACD、放量、超級趨勢、黃金交叉）
  const trendSignals = [];
  const order = Object.fromEntries(TREND.map((s, k) => [s.key, k]));
  for (const symbol of TREND_SYMBOLS) {
    for (const tf of [...new Set(TREND.map((s) => s.tf))]) {
      const ms = MS[tf];
      // SMC 那段已經抓過同一個幣／週期的就共用同一份（runSignals 用 index 對 K 棒，兩份長度不同會對錯根）
      let c = candlesBy.get(`${symbol}|${tf}`);
      if (!c) {
        try { c = await klines(symbol, tf, barsFor(tf, TREND_WINDOW + 5)); } catch (e) { log(`  順勢 ${symbol} ${tf}: 取得資料失敗（${e.message}）`); continue; }
        candlesBy.set(`${symbol}|${tf}`, c);
      }
      for (let i = TREND_WINDOW - 1; i < c.length - 1; i++) {
        const closeAt = c[i].time + ms;
        if (closeAt < start || closeAt > now) continue;
        const w = c.slice(i - TREND_WINDOW + 1, i + 1);
        const j = w.length - 1;
        for (const st of TREND.filter((s) => s.tf === tf)) {
          let sig = null;
          if (st.key === 'breakout') sig = breakoutSignal(w, { lookback: 55, stopAtr: 2 }, j, breakoutIndicators(w, { lookback: 55, stopAtr: 2 }));
          else if (st.key === 'ema') sig = emaCrossSignal(w, { fast: 20, slow: 50, stopAtr: 2 }, j, emaCrossIndicators(w, { fast: 20, slow: 50, stopAtr: 2 }));
          else if (st.key === 'macd') sig = macdZeroSignal(w, { stopAtr: 2 }, j, macdZeroIndicators(w, { stopAtr: 2 }));
          else sig = trendExtraSignal(st.key, w, j, trendExtraIndicators(w));
          if (!sig || !(sig.stopDistance > 0)) continue;
          const long = sig.dir === 'long';
          const entry = c[i + 1].open; // 收盤後市價進場（≈ 下一根開盤）
          const stop = long ? entry - sig.stopDistance : entry + sig.stopDistance;
          trendSignals.push({
            kind: 'trend', strategy: st.zh, key: st.key, symbol, interval: tf, index: i, time: closeAt, filledTime: c[i + 1].time,
            dir: sig.dir, entry, stop, entryType: 'market', stopPct: sig.stopDistance / entry,
            targets: st.trail ? [{ name: 'TP1', price: long ? entry + sig.stopDistance * 20 : entry - sig.stopDistance * 20, rr: 20 }]
              : [{ name: 'TP1', price: long ? entry + sig.stopDistance * st.tpR : entry - sig.stopDistance * st.tpR, rr: st.tpR }],
            trail: !!st.trail,
          });
        }
      }
    }
    await loadSub(symbol);
    log(`  順勢 ${symbol} 完成`);
  }
  trendSignals.sort((a, b) => a.time - b.time || order[a.key] - order[b.key]);

  // ── 跑出場（5 分鐘精算；沒有 5 分鐘資料的退回原週期）
  const TRAIL_CFG = { breakevenAtR: 1, breakevenOffsetR: 0.05, trailFromR: 1.5, trailGapR: 1.5, maxHoldBars: 100000 };
  const FIXED_CFG = { breakevenAtR: 0, trailFromR: 0, maxHoldBars: 100000 };
  const run = (sigs, cfg) => {
    const fine = SUB ? runSignals(sigs, candlesBy, { ...cfg, subBars: true, fillBarPath: true }) : [];
    const done = new Set(fine.map((t) => `${t.symbol}|${t.interval}|${t.time}|${t.strategy}|${t.dir}`));
    const coarse = runSignals(sigs.filter((s) => !done.has(`${s.symbol}|${s.interval}|${s.time}|${s.strategy}|${s.dir}`)), candlesBy, { ...cfg, fillBarPath: true });
    return [...fine.map((t) => ({ ...t, precise: true })), ...coarse.map((t) => ({ ...t, precise: false }))];
  };
  const smcTrades = run(smcSignals, { entryWindowBars: 1 });
  // Worker 的去重：同一個幣／週期／方向／進場價推播過，ALERT_TTL（6 小時）內不再推
  const ALERT_TTL = Number(opt('alert-ttl-h', 6)) * 3_600_000;
  const lastAlert = new Map();
  const smcDone = smcTrades
    .filter((t) => !(t.status === 'expired' && t.exitReason === 'timeout'))
    .sort((a, b) => a.filledTime - b.filledTime)
    .filter((t) => {
      const k = `${t.symbol}|${t.interval}|${t.dir}|${t.entry}`;
      if (t.filledTime - (lastAlert.get(k) ?? -Infinity) < ALERT_TTL) return false;
      lastAlert.set(k, t.filledTime);
      return true;
    });
  const trendRaw = [...run(trendSignals.filter((s) => s.trail), TRAIL_CFG), ...run(trendSignals.filter((s) => !s.trail), FIXED_CFG)]
    .sort((a, b) => a.time - b.time || order[a.key] - order[b.key]);
  // 同一個幣同時只抱一張、全部最多同時 TREND_MAX_OPEN 張（還沒平倉的部位也佔位子）
  const open = [];
  const trendDone = [];
  const trendSkipped = [];
  // 還沒平倉的單也要佔位子（一直佔到現在）
  const rawKeys = new Set(trendRaw.map((t) => `${t.symbol}|${t.interval}|${t.time}|${t.strategy}|${t.dir}`));
  const trendOpenSigs = trendSignals.filter((s) => !rawKeys.has(`${s.symbol}|${s.interval}|${s.time}|${s.strategy}|${s.dir}`))
    .map((s) => ({ ...s, closedTime: Infinity, stillOpen: true }));
  const trendAll = [...trendRaw, ...trendOpenSigs].sort((a, b) => a.time - b.time || order[a.key] - order[b.key]);
  const trendOpenTaken = [];
  for (const t of trendAll) {
    for (let k = open.length - 1; k >= 0; k--) if (open[k].closedTime <= t.filledTime) open.splice(k, 1);
    if (open.some((o) => o.symbol === t.symbol)) { trendSkipped.push({ ...t, skip: '同一個幣已經有單' }); continue; }
    if (open.length >= TREND_MAX_OPEN) { trendSkipped.push({ ...t, skip: `已經 ${TREND_MAX_OPEN} 張` }); continue; }
    open.push(t);
    (t.stillOpen ? trendOpenTaken : trendDone).push(t);
  }
  // 還沒結束的：SMC＝已經進場還抱著的（或最後一根的計畫還在等），順勢＝實際會下單、還沒平倉的
  const key = (t) => `${t.symbol}|${t.interval}|${t.time}|${t.strategy}|${t.dir}`;
  const smcKeys = new Set(smcTrades.map(key));
  const stillOpen = [...smcSignals.filter((s) => !smcKeys.has(key(s))), ...trendOpenTaken];

  // ── 摘要
  const rowOf = (name, xs) => {
    if (!xs.length) return [name, '0', '-', '-', '-', '-', '-'];
    const rs = xs.map(netR);
    const wins = rs.filter((r) => r > 0);
    return [name, String(xs.length), pct((wins.length / xs.length) * 100), r2(rs.reduce((a, b) => a + b, 0)), r2(rs.reduce((a, b) => a + b, 0) / xs.length),
      r2(Math.max(...rs)), r2(Math.min(...rs))];
  };
  const head = ['分組', '筆數', '勝率', '合計 R', '每筆 R', '最好', '最差'];
  log(`\n■ 最近 ${DAYS} 天（${new Date(start).toISOString().slice(0, 10)} ～ ${new Date(now).toISOString().slice(0, 10)}），每筆 R 已扣手續費`);
  log(`\n● SMC 計畫（${SMC_SYMBOLS.length} 檔 × ${SMC_INTERVALS.join('/')}；有計畫的收盤 ${smcSignals.length} 次，價格碰到進場價＝推播＋進場 ${smcDone.length} 筆，還沒結束 ${stillOpen.filter((s) => s.kind === 'smc').length} 筆）`);
  printTable(log, head, [
    rowOf('全部', smcDone),
    ...SMC_INTERVALS.map((iv) => rowOf(iv, smcDone.filter((t) => t.interval === iv))),
    rowOf('多單', smcDone.filter((t) => t.dir === 'long')),
    rowOf('空單', smcDone.filter((t) => t.dir === 'short')),
    ...SMC_SYMBOLS.map((s) => rowOf(s, smcDone.filter((t) => t.symbol === s))),
  ]);
  log(`\n● 6 個順勢策略（${TREND_SYMBOLS.length} 檔；訊號 ${trendSignals.length} 個，實際會下單 ${trendDone.length} 筆，因為同幣已有單／滿 ${TREND_MAX_OPEN} 張沒下 ${trendSkipped.length} 個，還沒結束 ${stillOpen.filter((s) => s.kind === 'trend').length} 筆）`);
  printTable(log, head, [
    rowOf('會下單的全部', trendDone),
    ...TREND.map((s) => rowOf(`${s.zh} ${s.tf}`, trendDone.filter((t) => t.key === s.key))),
    rowOf('多單', trendDone.filter((t) => t.dir === 'long')),
    rowOf('空單', trendDone.filter((t) => t.dir === 'short')),
    rowOf('（沒下單的訊號，已結束的）', trendSkipped.filter((t) => !t.stillOpen)),
  ]);

  // 每 30 天
  const months = Array.from({ length: Math.ceil(DAYS / 30) }, (_, k) => [start + k * 30 * DAY, Math.min(now, start + (k + 1) * 30 * DAY)]);
  log('\n● 每 30 天的合計 R');
  printTable(log, ['期間', 'SMC 筆數', 'SMC 合計 R', '順勢筆數', '順勢合計 R'], months.map(([a, b]) => {
    const s = smcDone.filter((t) => t.filledTime >= a && t.filledTime < b);
    const d = trendDone.filter((t) => t.filledTime >= a && t.filledTime < b);
    const sum = (xs) => r2(xs.reduce((x, t) => x + netR(t), 0));
    return [`${new Date(a).toISOString().slice(5, 10)}～${new Date(b).toISOString().slice(5, 10)}`, String(s.length), sum(s), String(d.length), sum(d)];
  }));

  const pack = (t, extra = {}) => ({
    k: t.kind, s: t.strategy, sym: t.symbol, iv: t.interval, dir: t.dir, sig: t.time, fill: t.filledTime ?? null, close: t.closedTime ?? null,
    entry: +Number(t.entry).toPrecision(6), stop: +Number(t.initialStop ?? t.stop).toPrecision(6),
    r: t.r != null ? Math.round(netR(t) * 1000) / 1000 : null, exit: t.status ? exitZh(t) : null, grade: t.grade ?? null, score: t.score ?? null,
    poi: t.poiType ?? null, precise: t.precise ?? null, ...extra,
  });
  const out = {
    generatedAt: new Date(now).toISOString(), days: DAYS, from: start, to: now, sub: SUB,
    smc: { symbols: SMC_SYMBOLS, intervals: SMC_INTERVALS, minScore: MIN_SCORE, plans: smcSignals.length },
    trend: { symbols: TREND_SYMBOLS.length, maxOpen: TREND_MAX_OPEN, signals: trendSignals.length },
    trades: [...smcDone.map((t) => pack(t)), ...trendDone.map((t) => pack(t))].sort((a, b) => a.fill - b.fill),
    skipped: trendSkipped.map((t) => pack(t, { skip: t.skip })),
    open: stillOpen.map((t) => pack(t, { exit: '還沒結束（還在等回到進場價，或還抱著）' })),
  };
  fs.mkdirSync('data/research', { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out));
  log(`\n逐筆清單已寫到 ${OUT}（${out.trades.length} 筆已結束、${out.open.length} 筆還沒結束、${out.skipped.length} 個沒下單的順勢訊號）`);
})();
