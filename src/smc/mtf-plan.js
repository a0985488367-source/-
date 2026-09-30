/**
 * 多週期 SMC 計畫（2026-09-30 使用者要求的新版）：日線 → 4h → 1h → 15m 一路往下看，每個幣只給一個進場點。
 *
 * 進場條件（四層都要同方向）：
 *   1. 日線：定多空（引擎偏向分數），並在日線交易區間（最近的擺動高低點）畫「固定範圍成交量分布」，
 *      取 POC／VAH／VAL 三條線當出場目標（用 4h K 棒算分布，比日線 K 棒細）。
 *   2. 4h ：價格回到跟日線同方向、還有效的進場區（OB／FVG／Breaker…）。
 *   3. 1h ：最近一次結構突破（BOS／CHoCH）跟日線同方向。
 *   4. 15m：最近一次結構突破也跟日線同方向（低週期也轉過來了）；
 *      在「回到 4h 進場區的那個極值 → 現在」這段畫成交量分布，進場掛在 POC（不行就 VAL／VAH，都不行就市價），
 *      停損放在極值跟 4h 進場區外緣更外面的那個再加緩衝。
 *
 * 加分模型（有的話分數更高，沒有也能進場）：
 *   PO3（吸籌 → 操縱 → 派發）：掃流動性之前的盤整區間被另一側掃掉，而且掃的地方碰到 4h 進場區
 *   造市者模型（MMXM）：掃流動性之後 mssWithin 根 1h 內出現同方向結構轉向（聰明錢反轉）
 *
 * 全部是純函式：傳入各週期「已收盤」的 K 棒（時間升冪），回測跟 App 共用。
 */

import { analyze } from './engine.js';
import { volumeProfile } from '../core/indicators.js';

export const MTF_CHAIN = ['1d', '4h', '1h', '15m'];

export const MTF_DEFAULTS = {
  biasMin: 20,            // 日線偏向分數至少要這麼多才有方向（-100～100）
  touchLookback: 24,      // 最近幾根 1h 內價格要回到 4h 進場區
  sweepLookback: 48,      // PO3／MMXM：1h 最近幾根內的「掃流動性」
  mssWithin: 24,          // MMXM：掃完之後幾根 1h 內要出現結構轉向
  accumBars: 12,          // PO3：掃之前幾根 1h 當作吸籌區間
  poiTolAtr: 0.5,         // 離 4h 進場區多遠（4h ATR 倍數）還算碰到
  stopBufferAtr: 0.25,    // 停損放在極值外多少（1h ATR 倍數）
  minRR: 2,               // 最後一個目標至少幾 R 才算有效計畫
  profileBins: 48,
};

const CHECKS = [
  { key: 'htfBias', weight: 16, zh: '日線方向明確', gate: true },
  { key: 'poi4h', weight: 14, zh: '價格回到 4h 進場區', gate: true },
  { key: 'structure1h', weight: 12, zh: '1h 結構跟日線同向', gate: true },
  { key: 'structure15m', weight: 10, zh: '15m 結構也轉過來', gate: true },
  { key: 'rr', weight: 8, zh: '風報比達標', gate: true },
  { key: 'po3', weight: 12, zh: '加分：PO3（吸籌→操縱掃流動性→派發）' },
  { key: 'mmxm', weight: 12, zh: '加分：造市者模型（掃流動性後結構轉向）' },
  { key: 'pdSide', weight: 8, zh: '在日線折價（多）／溢價（空）側' },
  { key: 'ltfNode', weight: 8, zh: '15m 進場價在成交量節點（POC／VAL／VAH）' },
];
const TOTAL = CHECKS.reduce((a, c) => a + c.weight, 0);

const lastIndexBefore = (candles, time) => {
  let lo = 0, hi = candles.length - 1, idx = -1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (candles[m].time <= time) { idx = m; lo = m + 1; } else hi = m - 1;
  }
  return idx;
};

const lastEventOf = (a) => {
  const ev = [...(a.structure?.internal?.events ?? []), ...(a.structure?.swing?.events ?? [])].sort((x, y) => x.breakIndex - y.breakIndex);
  return { events: ev, last: ev[ev.length - 1] ?? null };
};

/**
 * PO3／MMXM 偵測（加分用）：最近 sweepLookback 根 1h 內往回找「掃流動性 → 同方向結構轉向」。
 * 回傳 { mmxm, po3, sweep, mss, accumulation, extreme, extremeTime, expansion, poi } 或 null。
 */
function detectModel(h1, a1, { want, long, price, pois4, tol4, o }) {
  const n1 = h1.length;
  const sweeps = (a1.sweeps ?? []).filter((s) => s.dir === want && n1 - 1 - s.index <= o.sweepLookback);
  const { events, last } = lastEventOf(a1);
  for (let k = sweeps.length - 1; k >= 0; k--) {
    const s = sweeps[k];
    const mss = events.find((e) => e.dir === want && e.breakIndex > s.index && e.breakIndex - s.index <= o.mssWithin);
    if (!mss || (last && last.dir !== want)) continue; // 轉向之後又被反向突破：模型失效
    const accFrom = Math.max(0, s.index - o.accumBars);
    const acc = h1.slice(accFrom, s.index);
    if (acc.length < 3) continue;
    const accHigh = Math.max(...acc.map((c) => c.high));
    const accLow = Math.min(...acc.map((c) => c.low));
    const legBars = h1.slice(Math.max(0, s.index - 2), mss.breakIndex + 1);
    const extreme = long ? Math.min(...legBars.map((c) => c.low)) : Math.max(...legBars.map((c) => c.high));
    const extremeBar = legBars.find((c) => (long ? c.low === extreme : c.high === extreme));
    const poi = pois4.find((p) => extreme <= p.top + tol4 && extreme >= p.bottom - tol4) ?? null;
    const manipulated = long ? extreme < accLow : extreme > accHigh;
    return {
      mmxm: true,
      po3: manipulated && !!poi,
      sweep: { index: s.index, time: h1[s.index].time, level: s.level },
      mss: { type: mss.type, index: mss.breakIndex, time: h1[mss.breakIndex].time, price: mss.price, barsAgo: n1 - 1 - mss.breakIndex },
      accumulation: { high: accHigh, low: accLow, from: h1[accFrom].time, to: h1[s.index - 1]?.time ?? h1[s.index].time },
      extreme, extremeTime: extremeBar?.time ?? h1[s.index].time, poi, manipulated,
      expansion: long ? price > accHigh : price < accLow,
    };
  }
  return null;
}

/**
 * @param {{d1:any[], h4:any[], h1:any[], m15:any[]}} tf 各週期已收盤 K 棒
 * @param {object} [opts] 覆寫 MTF_DEFAULTS；也可以傳 cache: { d1: analyze結果, h4: analyze結果 }（回測省時間）
 * @returns 計畫物件；沒有計畫時 { none: true, stage, reasonZh, ... } 並附上已經算出來的部分（給畫面顯示）
 */
export function buildMtfPlan(tf, opts = {}) {
  const o = { ...MTF_DEFAULTS, ...opts };
  const { d1, h4, h1, m15 } = tf;
  if (!(d1?.length >= 60 && h4?.length >= 100 && h1?.length >= 100 && m15?.length >= 50)) {
    return { none: true, stage: 'data', reasonZh: 'K 棒資料不夠（日線至少 60 根、4h／1h 至少 100 根、15m 至少 50 根）' };
  }
  const price = m15[m15.length - 1].close;

  // ── 1. 日線：方向＋固定範圍成交量分布（出場目標）
  const aD = opts.cache?.d1 ?? analyze(d1);
  if (aD.empty) return { none: true, stage: 'data', reasonZh: '日線資料不夠' };
  const biasScore = aD.bias.score;
  const dir = biasScore >= o.biasMin ? 'long' : biasScore <= -o.biasMin ? 'short' : null;
  const long = dir === 'long';
  const range = aD.range;
  const rangeStart = range ? d1[range.startIndex].time : d1[Math.max(0, d1.length - 60)].time;
  const htfCandles = h4.filter((c) => c.time >= rangeStart);
  const vpH = volumeProfile(htfCandles.length >= 10 ? htfCandles : d1.slice(-60), { bins: o.profileBins });
  const htf = {
    biasScore, biasLabel: aD.bias.label, dir,
    range: range ? { high: range.high, low: range.low, eq: range.equilibrium, startTime: rangeStart } : null,
    profile: vpH ? { poc: vpH.poc, vah: vpH.vah, val: vpH.val } : null,
  };
  const base = { price, htf };
  if (!dir) {
    return { ...base, none: true, stage: 'htf', reasonZh: `日線方向不明（偏向分數 ${biasScore}，要 ≥${o.biasMin} 或 ≤-${o.biasMin}）：不做` };
  }
  const want = long ? 'bull' : 'bear';

  // ── 2. 4h：同方向還有效的進場區，最近 touchLookback 根 1h 內價格有沒有回到裡面
  const a4 = opts.cache?.h4 ?? analyze(h4, { htfBias: aD.bias });
  const pois4 = (a4.pois ?? []).filter((p) => p.dir === want && p.state !== 'mitigated' && p.state !== 'filled' && p.type !== 'OTE');
  const tol4 = (a4.atrValue || price * 0.01) * o.poiTolAtr;
  const a1 = analyze(h1);
  const atr1 = a1.atrValue || price * 0.005;
  const model = detectModel(h1, a1, { want, long, price, pois4, tol4, o });

  const recent = h1.slice(-o.touchLookback);
  const touchExt = long ? Math.min(...recent.map((c) => c.low)) : Math.max(...recent.map((c) => c.high));
  const touchBar = recent.find((c) => (long ? c.low === touchExt : c.high === touchExt));
  // 價格回到進場區：極值碰到區塊、但沒有深深穿過去（穿過去收盤的話引擎會把它當成失效／反向）
  const touched = (p) => (long
    ? touchExt <= p.top + tol4 && touchExt >= p.bottom - 2 * tol4
    : touchExt >= p.bottom - tol4 && touchExt <= p.top + 2 * tol4);
  const poi = (model?.po3 && model.poi) || pois4.find(touched) || null;
  const po3 = model
    ? { phase: model.expansion ? '派發（擴張中）' : '派發開始（回到吸籌區間內）', ...model }
    : { phase: '沒有偵測到（不影響進場，只是少了加分）', mmxm: false, po3: false };
  const withCtx = { ...base, dir, po3, poi4h: pois4.slice(0, 3).map((p) => ({ type: p.type, top: p.top, bottom: p.bottom, state: p.state })) };
  if (!poi) {
    return { ...withCtx, none: true, stage: 'poi', reasonZh: `日線偏${long ? '多' : '空'}，價格最近沒有回到 4h ${long ? '需求' : '供給'}區：等回踩` };
  }

  // ── 3. 1h 結構同向
  const { last: last1 } = lastEventOf(a1);
  if (!last1 || last1.dir !== want) {
    return { ...withCtx, poi, none: true, stage: 'h1', reasonZh: `價格在 4h 進場區，但 1h 最近的結構突破還是${last1 ? (last1.dir === 'bull' ? '向上' : '向下') : '沒有'}：等 1h 轉${long ? '多' : '空'}` };
  }

  // ── 4. 15m 結構也轉過來＋成交量分布進場
  const a15 = analyze(m15);
  const { last: last15 } = lastEventOf(a15);
  if (!last15 || last15.dir !== want) {
    return { ...withCtx, poi, none: true, stage: 'm15', reasonZh: `4h 進場區＋1h 同向都有了，等 15m 結構轉${long ? '多' : '空'}` };
  }
  const extreme = model?.po3 ? model.extreme : touchExt;
  const extremeTime = model?.po3 ? model.extremeTime : touchBar?.time ?? h1[h1.length - 1].time;
  const legStart = lastIndexBefore(m15, extremeTime);
  const leg = m15.slice(Math.max(0, legStart));
  const vpL = volumeProfile(leg.length >= 8 ? leg : m15.slice(-32), { bins: 32 });
  const buffer = atr1 * o.stopBufferAtr;
  const stop = long ? Math.min(extreme, poi.bottom) - buffer : Math.max(extreme, poi.top) + buffer;
  const better = (p) => (long ? p < price : p > price);
  const safe = (p) => (long ? p > stop : p < stop);
  let entry, entryType, entryNode;
  if (vpL && better(vpL.poc) && safe(vpL.poc)) { entry = vpL.poc; entryType = 'limit'; entryNode = 'POC'; }
  else if (vpL && long && better(vpL.val) && safe(vpL.val)) { entry = vpL.val; entryType = 'limit'; entryNode = 'VAL'; }
  else if (vpL && !long && better(vpL.vah) && safe(vpL.vah)) { entry = vpL.vah; entryType = 'limit'; entryNode = 'VAH'; }
  else { entry = price; entryType = 'market'; entryNode = null; }
  const risk = Math.abs(entry - stop);
  if (!(risk > 0) || !safe(entry)) {
    return { ...withCtx, poi, none: true, stage: 'entry', reasonZh: '價格已經跑到停損外：這一段失效' };
  }

  // 出場：日線成交量分布三條線（在進場價有利方向、至少 0.5R 外），不夠就補日線區間極值
  const lines = vpH ? [['日線 VAL', vpH.val], ['日線 POC', vpH.poc], ['日線 VAH', vpH.vah]] : [];
  if (range) lines.push([long ? '日線區間高點' : '日線區間低點', long ? range.high : range.low]);
  const seen = new Set();
  const targets = lines
    .filter(([, p]) => Number.isFinite(p) && (long ? p >= entry + risk * 0.5 : p <= entry - risk * 0.5))
    .map(([label, p]) => ({ label, price: p, rr: Math.abs(p - entry) / risk }))
    .sort((a, b) => a.rr - b.rr)
    .filter((t) => { const k = t.price.toFixed(8); if (seen.has(k)) return false; seen.add(k); return true; })
    .slice(0, 3)
    .map((t, i) => ({ ...t, name: `TP${i + 1}` }));
  const rrFinal = targets.length ? targets[targets.length - 1].rr : 0;

  const pdRatio = range && range.high > range.low ? (price - range.low) / (range.high - range.low) : null;
  const results = {
    htfBias: true,
    poi4h: true,
    structure1h: true,
    structure15m: true,
    rr: rrFinal >= o.minRR,
    po3: !!model?.po3,
    mmxm: !!model?.mmxm,
    pdSide: pdRatio != null && (long ? pdRatio < 0.5 : pdRatio > 0.5),
    ltfNode: entryNode != null,
  };
  const checklist = CHECKS.map((c) => ({ ...c, ok: !!results[c.key] }));
  const score = Math.round((checklist.reduce((a, c) => a + (c.ok ? c.weight : 0), 0) / TOTAL) * 100);
  const grade = score >= 80 ? 'A+' : score >= 68 ? 'A' : score >= 55 ? 'B' : score >= 42 ? 'C' : 'D';
  const valid = checklist.filter((c) => c.gate).every((c) => c.ok) && targets.length > 0;

  return {
    ...withCtx,
    valid,
    entry, entryType, entryNode,
    stop, risk, riskPct: (risk / entry) * 100,
    targets, rrFinal, rr1: targets[0]?.rr ?? 0,
    score, grade, checklist,
    poi: { type: poi.type, top: poi.top, bottom: poi.bottom, state: poi.state },
    structure: { h1: { type: last1.type, price: last1.price }, m15: { type: last15.type, price: last15.price } },
    ltf: vpL ? { poc: vpL.poc, vah: vpL.vah, val: vpL.val, from: leg[0]?.time ?? null } : null,
    // 同一次「回到 4h 進場區」（同一個區塊、同一個極值）只算一個計畫（回測去重、推播去重用）
    id: `${dir}:${poi.type}:${poi.bottom.toPrecision(8)}:${extremeTime}`,
  };
}
