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
import { opt as optFrom, klines as fetchKlines, runSignals, summarize, pct, r2, printTable, simulatePortfolio } from './lib.mjs';

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
// 精準驗證：另外抓最近 SUB_DAYS 天的細 K 棒（例如 5m），*_5M 變體進場後改用細 K 棒逐根跑
const SUB = opt('sub', '');
const SUB_DAYS = Number(opt('sub-days', 150));
const ONLY = opt('only', '').split(',').filter(Boolean);
const LIVE_MIN_SCORE = Number(opt('live-min-score', 65));
// 一進一出的成本（占倉位價值）：吃單手續費 0.11%；流動性差的幣可以另外加滑價
const ROUND_TRIP_FEE = Number(opt('fee', 0.0011));
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
  // ── 止盈目標是不是設太遠（保本／追蹤停損照舊）──
  TPX1:            { fixedTpR: 1 },
  TPX15:           { fixedTpR: 1.5 },
  TPX2:            { fixedTpR: 2 },
  TPX3:            { fixedTpR: 3 },
  TPS05:           { tpScale: 0.5 },
  TPS075:          { tpScale: 0.75 },
  HALF1:           { scalpR: 1, scalpFraction: 0.5 },
  HALF15:          { scalpR: 1.5, scalpFraction: 0.5 },
  // ── 精準驗證：進場後用 5 分鐘 K 棒逐根跑（需要 --sub=5m）──
  NOW_5M:          { subBars: true },
  NOW_5M_P:        { subBars: true, fillBarPath: true },
  BE075_5M:        { subBars: true, fillBarPath: true, breakevenAtR: 0.75 },
  BE_OFF_5M:       { subBars: true, fillBarPath: true, breakevenAtR: 0 },
  TR15_5M:         { subBars: true, fillBarPath: true, trailFromR: 1.5, trailGapR: 0.8 },
  TR_OFF_5M:       { subBars: true, fillBarPath: true, trailFromR: 0 },
  // ── 停損拉近（保本／追蹤停損照舊）──
  SLK07:           { tightStopKeepSize: 0.7 },   // 倉位不變，停損拉到 7 成 → 打到虧 0.7R
  SLK05:           { tightStopKeepSize: 0.5 },   // 倉位不變，停損拉到一半 → 打到虧 0.5R
  SLR07:           { tightStopResize: 0.7 },     // 一樣虧 1R，停損 7 成、倉位放大
  SLR05:           { tightStopResize: 0.5 },     // 一樣虧 1R，停損一半、倉位放大一倍
  CUT05:           { scratchR: 0.5 },            // 停損不動，逆行到 0.5R 就先出場
  CUT075:          { scratchR: 0.75 },           // 停損不動，逆行到 0.75R 就先出場
  // ── 同上，但成交那根 K 棒只算停損、不算獲利（檢查回測有沒有高估）──
  NOW_S:           { fillBarConservative: true },
  SLK07_S:         { fillBarConservative: true, tightStopKeepSize: 0.7 },
  SLR07_S:         { fillBarConservative: true, tightStopResize: 0.7 },
  SLR05_S:         { fillBarConservative: true, tightStopResize: 0.5 },
  CUT075_S:        { fillBarConservative: true, scratchR: 0.75 },
  // ── 成交那根照 OHLC 路徑假設（比較接近實際）──
  NOW_P:           { fillBarPath: true },
  SLK07_P:         { fillBarPath: true, tightStopKeepSize: 0.7 },
  SLR07_P:         { fillBarPath: true, tightStopResize: 0.7 },
  SLR05_P:         { fillBarPath: true, tightStopResize: 0.5 },
  BE_OFF_P:        { fillBarPath: true, breakevenAtR: 0 },
  BE1_P:           { fillBarPath: true, breakevenAtR: 1 },
  TR_OFF_P:        { fillBarPath: true, trailFromR: 0 },
};

const live = (t) => t.score >= LIVE_MIN_SCORE && t.tp1R >= 1.5;
// 目前線上完整規則：再加上 BTC 漲勢（或讀不到）不做空
const liveNow = (t) => live(t) && (t.dir === 'long' || t.btcUp === false);
const RISK_PCT = Number(opt('risk-pct', 5));
const twHour = (ms) => new Date(ms + 8 * 3_600_000).getUTCHours();
const PORTFOLIO_RULES = [
  ['不限制（現在）', {}],
  ['同幣不加碼', { oneBySymbol: true }],
  ['未保本最多 3 筆', { maxAtRisk: 3 }],
  ['未保本最多 4 筆', { maxAtRisk: 4 }],
  ['未保本最多 5 筆', { maxAtRisk: 5 }],
  ['同幣不加碼＋未保本最多 4 筆', { oneBySymbol: true, maxAtRisk: 4 }],
  // 一次好幾張一起停損：同方向上限、每小時新單上限、疊單縮小、單日停損、BTC 急跌不開多
  ['同方向未保本最多 2 筆', { maxSameDirAtRisk: 2 }],
  ['同方向未保本最多 3 筆', { maxSameDirAtRisk: 3 }],
  ['每小時最多新開 1 筆', { maxNewPerHour: 1 }],
  ['每小時最多新開 2 筆', { maxNewPerHour: 2 }],
  ['疊單時風險 ×0.5', { stackScale: 0.5 }],
  ['疊單時風險 ×0.7', { stackScale: 0.7 }],
  ['單日虧 10% 停手', { dailyStopPct: 10 }],
  ['單日虧 15% 停手', { dailyStopPct: 15 }],
  ['BTC 剛跌 >0.5% 不開多', { skip: (t) => t.dir === 'long' && t.btcChg != null && t.btcChg <= -0.5 }],
  ['BTC 剛跌 >1% 不開多', { skip: (t) => t.dir === 'long' && t.btcChg != null && t.btcChg <= -1 }],
  // 每單風險 % 對速度與回撤的影響（其餘不限制）
  ...[2, 3, 4, 5, 6].map((r) => [`每單 ${r}%`, { riskPct: r }]),
];
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
  // 候選規則：BTC 漲勢時不做空（其餘照舊）
  ['線上＋BTC漲勢不做空 前半', (t) => live(t) && !(t.dir === 'short' && t.btcUp === true) && t.half === 0],
  ['線上＋BTC漲勢不做空 後半', (t) => live(t) && !(t.dir === 'short' && t.btcUp === true) && t.half === 1],
  ['線上 空單 BTC漲勢 前半', (t) => live(t) && t.dir === 'short' && t.btcUp === true && t.half === 0],
  ['線上 空單 BTC漲勢 後半', (t) => live(t) && t.dir === 'short' && t.btcUp === true && t.half === 1],
  ['線上 空單 BTC跌勢 前半', (t) => live(t) && t.dir === 'short' && t.btcUp === false && t.half === 0],
  ['線上 空單 BTC跌勢 後半', (t) => live(t) && t.dir === 'short' && t.btcUp === false && t.half === 1],
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
  // 進場前 BTC 剛剛的漲跌（30m／1h 單看最近一小時，4h 單看最近一根）：多單遇到 BTC 急跌是不是特別容易停損
  ...[['跌 >1%', (x) => x <= -1], ['跌 0.5～1%', (x) => x > -1 && x <= -0.5], ['其他', (x) => x > -0.5]].flatMap(([n, f]) => [
    [`線上 多單 BTC剛${n} 前半`, (t) => liveNow(t) && t.dir === 'long' && t.btcChg != null && f(t.btcChg) && t.half === 0],
    [`線上 多單 BTC剛${n} 後半`, (t) => liveNow(t) && t.dir === 'long' && t.btcChg != null && f(t.btcChg) && t.half === 1],
  ]),
  // 進場時段（台灣時間）
  ...[[0, 6], [6, 12], [12, 18], [18, 24]].flatMap(([a, b]) => [
    [`線上 台灣${a}-${b}點 前半`, (t) => liveNow(t) && t.filledTime && twHour(t.filledTime) >= a && twHour(t.filledTime) < b && t.half === 0],
    [`線上 台灣${a}-${b}點 後半`, (t) => liveNow(t) && t.filledTime && twHour(t.filledTime) >= a && twHour(t.filledTime) < b && t.half === 1],
  ]),
  // 精準驗證區間（有細 K 棒的最近 SUB_DAYS 天）：同一批訊號拿來比「原週期算法」和「細 K 棒逐根跑」
  ...(SUB ? [
    ['細K區間 線上', (t) => liveNow(t) && t.inSub],
    ['細K區間 線上 前半', (t) => liveNow(t) && t.inSub && t.subHalf === 0],
    ['細K區間 線上 後半', (t) => liveNow(t) && t.inSub && t.subHalf === 1],
    ...['30m', '1h', '4h'].map((tf) => [`細K區間 線上 ${tf}`, (t) => liveNow(t) && t.inSub && t.interval === tf]),
    ['細K區間 全部', (t) => t.inSub],
  ] : []),
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
      checks: Object.fromEntries((s.checklist ?? []).map((c) => [c.key, c.ok])),
      extras: s.extras ?? {}, rrFinal: s.rrFinal,
      stopPct: Math.abs(s.entry - s.stop) / s.entry,
      tp1R: s.targets[0].rr,
      half: i < (WARMUP + candles.length) / 2 ? 0 : 1,
    });
    cooldownUntil = i + COOLDOWN;
  }
  return out;
}

/**
 * 出場原因分析：線上會下的單最後是怎麼出場的，以及「保本／追蹤停損出場之後，價格有沒有又走到 TP1」
 * （之後的走勢用原本的停損當判斷：先碰 TP1 算「錯過」，先碰原停損或抱滿 maxHold 根都沒碰到算「還好有走」）
 */
function exitBreakdown(trades, candlesBy, maxHold = 200) {
  const KIND = [
    ['全額停損', (t) => t.exitReason === 'stop'],
    ['保本出場', (t) => t.exitReason === 'breakeven'],
    ['追蹤停損（沒到 TP1）', (t) => t.exitReason === 'trail' && !t.hitTargets.length],
    ['追蹤停損（有到 TP1）', (t) => t.exitReason === 'trail' && t.hitTargets.length > 0],
    ['打到最後目標', (t) => t.exitReason === 'target'],
    ['抱太久平倉', (t) => t.exitReason === 'maxHold'],
  ];
  const after = (t) => {
    const c = candlesBy.get(`${t.symbol}|${t.interval}`);
    const long = t.dir === 'long';
    const risk = Math.abs(t.entry - t.initialStop);
    const tp1 = long ? t.entry + risk * t.tp1R : t.entry - risk * t.tp1R;
    let j = c.findIndex((k) => k.time > t.closedTime);
    if (j < 0) return null;
    for (const end = Math.min(c.length, j + maxHold); j < end; j++) {
      const k = c[j];
      if (long ? k.low <= t.initialStop : k.high >= t.initialStop) return 'stop';
      if (long ? k.high >= tp1 : k.low <= tp1) return 'tp1';
    }
    return j >= c.length ? null : 'none';
  };
  const rows = KIND.map(([name, f]) => {
    const hit = trades.filter(f);
    const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
    const later = name === '保本出場' || name === '追蹤停損（沒到 TP1）' ? hit.map(after).filter(Boolean) : [];
    const missed = later.filter((x) => x === 'tp1').length;
    return [
      name, String(hit.length), pct((hit.length / trades.length) * 100),
      r2(avg(hit.map((t) => t.r))), r2(avg(hit.map((t) => t.maxFavorableR))),
      later.length ? `${pct((missed / later.length) * 100)}（${missed}/${later.length}）` : '-',
    ];
  });
  log('\n■ 出場原因（線上完整過濾、已扣手續費）');
  printTable(log, ['出場方式', '筆數', '佔比', '平均R', '最多曾賺到R', '出場後又走到TP1'], rows);
}

/**
 * 找進場優勢：把「細K區間」的交易按各種條件拆開，看扣完手續費每筆賺多少（前半／後半／全部）。
 * 用 5 分鐘精準版的結果（*_5M 變體），分數門檻用 MIN_SCORE（比線上寬，樣本比較多）。
 */
function edgeBreakdown(name, trades) {
  const pool = trades.filter((t) => t.inSub);
  if (!pool.length) return;
  const netR = (t) => t.r - ROUND_TRIP_FEE / t.stopPct;
  const bucket = (label, lo, hi, f) => [label, (t) => f(t) >= lo && f(t) < hi];
  const CHECK_ZH = { htfAlign: '高週期同向', structure: '結構確認', pdSide: '折價／溢價側', poiFresh: '進場區新鮮', sweep: '掃過流動性', stacked: '多重匯流', rr: '風報比達標', target: '目標有流動性', momentum: '動能同向', killzone: '在 killzone' };
  const COND = [
    ['全部', () => true],
    ['線上過濾', liveNow],
    ...['30m', '1h', '4h'].map((tf) => [`週期 ${tf}`, (t) => t.interval === tf]),
    ['多單', (t) => t.dir === 'long'], ['空單', (t) => t.dir === 'short'],
    ['順 BTC 趨勢', (t) => t.withBtc === true], ['逆 BTC 趨勢', (t) => t.withBtc === false],
    bucket('分數 55-64', 55, 65, (t) => t.score), bucket('分數 65-74', 65, 75, (t) => t.score),
    bucket('分數 75-84', 75, 85, (t) => t.score), bucket('分數 85+', 85, 999, (t) => t.score),
    ...Object.keys(CHECK_ZH).flatMap((k) => [
      [`✔ ${CHECK_ZH[k]}`, (t) => t.checks?.[k] === true], [`✘ ${CHECK_ZH[k]}`, (t) => t.checks?.[k] === false],
    ]),
    ...[...new Set(pool.map((t) => t.poiType))].map((p) => [`進場區 ${p}`, (t) => t.poiType === p]),
    ['市價進場（已在區內）', (t) => t.entryType === 'market'], ['限價等回踩', (t) => t.entryType !== 'market'],
    bucket('停損 <0.5%', 0, 0.005, (t) => t.stopPct), bucket('停損 0.5-1%', 0.005, 0.01, (t) => t.stopPct),
    bucket('停損 1-2%', 0.01, 0.02, (t) => t.stopPct), bucket('停損 2-4%', 0.02, 0.04, (t) => t.stopPct),
    bucket('停損 4%+', 0.04, 9, (t) => t.stopPct),
    bucket('TP1 <1.5R', 0, 1.5, (t) => t.tp1R), bucket('TP1 1.5-2R', 1.5, 2, (t) => t.tp1R),
    bucket('TP1 2-3R', 2, 3, (t) => t.tp1R), bucket('TP1 3R+', 3, 999, (t) => t.tp1R),
    ['fib 在進場區', (t) => !!t.extras?.fib], ['HVN 在進場區', (t) => !!t.extras?.hvn],
    ['價值區邊緣', (t) => !!t.extras?.valueEdge], ['LVN 在進場區', (t) => !!t.extras?.lvn],
    ...[[0, 6], [6, 12], [12, 18], [18, 24]].map(([a, b]) => [`台灣 ${a}-${b} 點進場`, (t) => t.filledTime && twHour(t.filledTime) >= a && twHour(t.filledTime) < b]),
  ];
  const cell = (xs) => (xs.length ? `${r2(xs.reduce((a, t) => a + netR(t), 0) / xs.length)}（${xs.length}）` : '-');
  log(`\n■ 找進場優勢（${name}、細K區間、分數≥${MIN_SCORE}、扣手續費每筆 R，括號是筆數）`);
  printTable(log, ['條件', '前半', '後半', '全部'], COND.map(([label, f]) => {
    const hit = pool.filter(f);
    return [label, cell(hit.filter((t) => t.subHalf === 0)), cell(hit.filter((t) => t.subHalf === 1)), cell(hit)];
  }));
}

/**
 * 進場那根 K 棒開始前，BTC 最近一小時的漲跌 %（30m 看 2 根、1h 看 1 根、4h 看最近 1 根）。
 * 只用進場前已經收盤的 K 棒，跟 Worker 下單當下看得到的資訊一樣。
 */
function btcChangeBeforeFill(c, t) {
  if (!c || !t.filledTime) return null;
  const bars = t.interval === '30m' ? 2 : t.interval === '15m' ? 4 : 1;
  let lo = 0, hi = c.length - 1, i = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (c[m].time < t.filledTime) { i = m; lo = m + 1; } else hi = m - 1; }
  if (i - bars < 0) return null;
  return (c[i].close / c[i - bars].close - 1) * 100;
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
  if (SUB) {
    let subStart = Infinity, subEnd = -Infinity;
    for (const symbol of SYMBOLS) {
      try {
        const c = await fetchKlines(symbol, SUB, Math.ceil((SUB_DAYS * 1440) / ({ '1m': 1, '5m': 5, '15m': 15 }[SUB] ?? 5)));
        candlesBy.set(`${symbol}|sub`, c);
        subStart = Math.min(subStart, c[0].time);
        subEnd = Math.max(subEnd, c[c.length - 1].time);
        log(`  ${symbol} ${SUB}（精準驗證用）: ${c.length} 根`);
      } catch (e) { log(`  ${symbol} ${SUB}: 取得資料失敗（${e.message}）`); }
    }
    const mid = (subStart + subEnd) / 2;
    for (const sig of signals) {
      const sub = candlesBy.get(`${sig.symbol}|sub`);
      const next = candlesBy.get(`${sig.symbol}|${sig.interval}`)[sig.index + 1];
      sig.inSub = Boolean(sub?.length && next && next.time >= sub[0].time);
      sig.subHalf = next && next.time < mid ? 0 : 1;
    }
    log(`  精準驗證區間內的訊號：${signals.filter((x) => x.inSub).length} 個`);
  }
  // 每個訊號標上當下 BTC 同週期的趨勢（只看訊號那根之前已收盤的 K 棒，沒有未來函數）
  const btcBy = new Map();
  for (const interval of INTERVALS) {
    const c = candlesBy.get(`BTCUSDT|${interval}`) ?? await fetchKlines('BTCUSDT', interval, LIMIT).catch(() => null);
    if (!c) { log(`  BTCUSDT ${interval}: 取不到，這個週期不標大盤方向`); continue; }
    btcBy.set(interval, c);
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
  const variantSims = [];
  let portfolioBase = null;
  for (const [name, cfg] of Object.entries(VARIANTS)) {
    if (ONLY.length && !ONLY.includes(name)) continue;
    const closed = runSignals(signals, candlesBy, cfg);
    for (const t of closed) t.btcChg = btcChangeBeforeFill(btcBy.get(t.interval), t);
    if (!portfolioBase) portfolioBase = { name, closed };
    variantSims.push([name, closed]);
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

  // 帳戶層級：同時持倉、複利、每筆冒當下帳戶的 RISK_PCT%
  const toSim = (t) => ({
    ...net(t),
    beTime: t.events.find((e) => e.type === 'breakeven')?.time ?? null,
  });
  const filled = portfolioBase.closed.filter((t) => t.filledTime && liveNow(t)).map(toSim);
  log(`\n■ 帳戶模擬（規則 ${portfolioBase.name}、線上完整過濾、每筆 ${RISK_PCT}% 複利、已扣手續費）`);
  const periods = [['全部', () => true], ['前半', (t) => t.half === 0], ['後半', (t) => t.half === 1]];
  const portfolioRows = PORTFOLIO_RULES.map(([name, rule]) => [name, ...periods.map(([, f]) => simulatePortfolio(filled.filter(f), { riskPct: RISK_PCT, ...rule }))]);
  printTable(log, ['做法', ...periods.flatMap(([p]) => [`${p} 筆數`, `${p} 倍數`, `${p} 最大回撤`])],
    portfolioRows.map(([name, ...res]) => [name, ...res.flatMap((x) => [String(x.taken), `${x.multiple.toFixed(2)}x`, `${x.maxDdPct.toFixed(1)}%`])]));

  if (variantSims.length > 1) {
    log(`\n■ 各規則帳戶模擬（線上完整過濾、每筆 ${RISK_PCT}% 複利、不限制持倉、已扣手續費）`);
    printTable(log, ['規則', ...periods.flatMap(([p]) => [`${p} 倍數`, `${p} 最大回撤`])],
      variantSims.map(([name, closed]) => {
        const list = closed.filter((t) => t.filledTime && liveNow(t)).map(toSim);
        return [name, ...periods.flatMap(([, f]) => {
          const x = simulatePortfolio(list.filter(f), { riskPct: RISK_PCT });
          return [`${x.multiple.toFixed(2)}x`, `${x.maxDdPct.toFixed(1)}%`];
        })];
      }));
  }

  exitBreakdown(filled, candlesBy);
  for (const [name, closed] of variantSims) if (name.endsWith('_5M')) edgeBreakdown(name, closed);

  await mkdir(OUT.split('/').slice(0, -1).join('/'), { recursive: true });
  await writeFile(OUT, JSON.stringify({ generatedAt: Date.now(), symbols: SYMBOLS, intervals: INTERVALS, signals: signals.length, rows }, null, 2));
  log(`\n已寫入 ${OUT}`);
})();
