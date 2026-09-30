/**
 * 多週期 SMC 計畫（2026-09-30 使用者要求的新版）：日線 → 4h → 1h → 15m 一路往下看，每個幣只給一個進場點。
 *
 *   1. 日線：定多空（引擎偏向分數），並在日線交易區間（最近的擺動高低點）畫「固定範圍成交量分布」，
 *      取 POC／VAH／VAL 三條線當出場目標（用 4h K 棒算分布，比日線 K 棒細）。
 *   2. 4h ：找跟日線同方向、還有效的進場區（OB／FVG／Breaker…）。
 *   3. 1h ：PO3／造市者模型（MMXM）當進場條件——
 *        吸籌（Accumulation）：掃流動性之前那段盤整區間
 *        操縱（Manipulation）：掃掉盤整區間另一側的流動性（做多＝往下掃低點），而且掃的地方要碰到 4h 進場區
 *        派發（Distribution）：掃完之後出現同方向的結構轉向（MSS：BOS／CHoCH），價格開始往目標走
 *      三段都成立才給計畫。
 *   4. 15m：在「操縱低點 → 現在」這段走勢畫成交量分布，進場掛在 POC（價格已經在 POC 以下就用 VAL，
 *      兩個都跌破就市價），停損放在操縱極值外。
 *
 * 全部是純函式：傳入各週期「已收盤」的 K 棒（時間升冪），回測跟 App 共用。
 */

import { analyze } from './engine.js';
import { volumeProfile } from '../core/indicators.js';

export const MTF_CHAIN = ['1d', '4h', '1h', '15m'];

export const MTF_DEFAULTS = {
  biasMin: 20,            // 日線偏向分數至少要這麼多才有方向（-100～100）
  sweepLookback: 48,      // 1h 最近幾根內要有「掃流動性」
  mssWithin: 24,          // 掃完之後幾根 1h 內要出現結構轉向
  accumBars: 12,          // 掃之前幾根 1h 當作吸籌區間
  poiTolAtr: 0.5,         // 操縱極值離 4h 進場區多遠（4h ATR 倍數）還算碰到
  stopBufferAtr: 0.25,    // 停損放在操縱極值外多少（1h ATR 倍數）
  minRR: 2,               // 最後一個目標至少幾 R 才算有效計畫
  profileBins: 48,
};

const CHECKS = [
  { key: 'htfBias', weight: 18, zh: '日線方向明確', gate: true },
  { key: 'poi4h', weight: 16, zh: '操縱掃到 4h 進場區', gate: true },
  { key: 'manipulation', weight: 16, zh: 'PO3 操縱：掃掉吸籌區間的流動性', gate: true },
  { key: 'mss', weight: 16, zh: '派發開始：1h 結構轉向（MSS）', gate: true },
  { key: 'rr', weight: 10, zh: `風報比達標`, gate: true },
  { key: 'pdSide', weight: 8, zh: '在日線折價（多）／溢價（空）側' },
  { key: 'ltfNode', weight: 8, zh: '15m 進場價在成交量節點（POC／VAL）' },
  { key: 'expansion', weight: 8, zh: '已經離開吸籌區間（擴張中）' },
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

  // ── 2. 4h：同方向還有效的進場區
  const a4 = opts.cache?.h4 ?? analyze(h4, { htfBias: aD.bias });
  const pois4 = (a4.pois ?? []).filter((p) => p.dir === want && p.state !== 'mitigated' && p.state !== 'filled' && p.type !== 'OTE');
  const tol4 = (a4.atrValue || price * 0.01) * o.poiTolAtr;

  // ── 3. 1h：PO3／MMXM（吸籌 → 操縱掃流動性 → 結構轉向）
  const a1 = analyze(h1);
  const n1 = h1.length;
  const atr1 = a1.atrValue || price * 0.005;
  const sweeps = (a1.sweeps ?? []).filter((s) => s.dir === want && n1 - 1 - s.index <= o.sweepLookback);
  const events = [...(a1.structure?.internal?.events ?? []), ...(a1.structure?.swing?.events ?? [])].sort((a, b) => a.breakIndex - b.breakIndex);
  const lastEvent = events[events.length - 1] ?? null;
  let model = null;
  // 從最近的掃流動性往回找：掃完之後 mssWithin 根內有同方向結構轉向，而且之後結構沒有再反轉
  for (let k = sweeps.length - 1; k >= 0 && !model; k--) {
    const s = sweeps[k];
    const mss = events.find((e) => e.dir === want && e.breakIndex > s.index && e.breakIndex - s.index <= o.mssWithin);
    if (!mss) continue;
    if (lastEvent && lastEvent.dir !== want) continue; // 轉向之後又被反向突破：模型失效
    const accFrom = Math.max(0, s.index - o.accumBars);
    const acc = h1.slice(accFrom, s.index);
    if (acc.length < 3) continue;
    const accHigh = Math.max(...acc.map((c) => c.high));
    const accLow = Math.min(...acc.map((c) => c.low));
    // 操縱極值：掃之前兩根到結構轉向之間的最低（多）／最高（空）點
    const legBars = h1.slice(Math.max(0, s.index - 2), mss.breakIndex + 1);
    const extreme = long ? Math.min(...legBars.map((c) => c.low)) : Math.max(...legBars.map((c) => c.high));
    const extremeBar = legBars.find((c) => (long ? c.low === extreme : c.high === extreme));
    const manipulated = long ? extreme < accLow : extreme > accHigh;
    const poi = pois4.find((p) => extreme <= p.top + tol4 && extreme >= p.bottom - tol4) ?? null;
    model = {
      sweep: { index: s.index, time: h1[s.index].time, level: s.level },
      mss: { type: mss.type, index: mss.breakIndex, time: h1[mss.breakIndex].time, price: mss.price, barsAgo: n1 - 1 - mss.breakIndex },
      accumulation: { high: accHigh, low: accLow, from: h1[accFrom].time, to: h1[s.index - 1]?.time ?? h1[s.index].time },
      extreme, extremeTime: extremeBar?.time ?? h1[s.index].time,
      manipulated, poi,
      expansion: long ? price > accHigh : price < accLow,
    };
  }
  const po3 = model
    ? { phase: model.expansion ? '派發（擴張中）' : '派發開始（回到吸籌區間內）', ...model }
    : { phase: sweeps.length ? '操縱中（掃了流動性，還沒結構轉向）' : '吸籌／等待操縱' };
  const withModel = { ...base, po3, poi4h: pois4.slice(0, 3).map((p) => ({ type: p.type, top: p.top, bottom: p.bottom, state: p.state })) };
  if (!model) {
    return { ...withModel, dir, none: true, stage: 'po3', reasonZh: `日線偏${long ? '多' : '空'}，1h 還沒出現「掃流動性 → 結構轉向」（${po3.phase}）：等` };
  }
  if (!model.manipulated) {
    return { ...withModel, dir, none: true, stage: 'po3', reasonZh: '有結構轉向，但操縱沒有掃掉吸籌區間的流動性：不算 PO3' };
  }
  if (!model.poi) {
    return { ...withModel, dir, none: true, stage: 'poi', reasonZh: `操縱${long ? '低' : '高'}點沒有碰到 4h 進場區：不做` };
  }
  if (model.mss.barsAgo > o.mssWithin) {
    return { ...withModel, dir, none: true, stage: 'stale', reasonZh: '結構轉向已經是太久以前的事：這一段錯過了' };
  }

  // ── 4. 15m：操縱極值之後這段走勢的成交量分布 → 進場價
  const legStart = lastIndexBefore(m15, model.extremeTime);
  const leg = m15.slice(Math.max(0, legStart));
  const vpL = volumeProfile(leg.length >= 8 ? leg : m15.slice(-32), { bins: 32 });
  const buffer = atr1 * o.stopBufferAtr;
  const stop = long ? model.extreme - buffer : model.extreme + buffer;
  let entry, entryType, entryNode;
  const better = (p) => (long ? p < price : p > price);
  const safe = (p) => (long ? p > stop : p < stop);
  if (vpL && better(vpL.poc) && safe(vpL.poc)) { entry = vpL.poc; entryType = 'limit'; entryNode = 'POC'; }
  else if (vpL && better(vpL.val) && safe(vpL.val) && long) { entry = vpL.val; entryType = 'limit'; entryNode = 'VAL'; }
  else if (vpL && better(vpL.vah) && safe(vpL.vah) && !long) { entry = vpL.vah; entryType = 'limit'; entryNode = 'VAH'; }
  else { entry = price; entryType = 'market'; entryNode = null; }
  const risk = Math.abs(entry - stop);
  if (!(risk > 0) || !safe(entry)) {
    return { ...withModel, dir, none: true, stage: 'entry', reasonZh: '價格已經跑到停損外：這一段失效' };
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
    manipulation: true,
    mss: true,
    rr: rrFinal >= o.minRR,
    pdSide: pdRatio != null && (long ? pdRatio < 0.5 : pdRatio > 0.5),
    ltfNode: entryNode != null,
    expansion: model.expansion,
  };
  const checklist = CHECKS.map((c) => ({ ...c, ok: !!results[c.key] }));
  const score = Math.round((checklist.reduce((a, c) => a + (c.ok ? c.weight : 0), 0) / TOTAL) * 100);
  const grade = score >= 80 ? 'A+' : score >= 68 ? 'A' : score >= 55 ? 'B' : score >= 42 ? 'C' : 'D';
  const valid = checklist.filter((c) => c.gate).every((c) => c.ok) && targets.length > 0;

  return {
    ...withModel,
    dir,
    valid,
    entry, entryType, entryNode,
    stop, risk, riskPct: (risk / entry) * 100,
    targets, rrFinal, rr1: targets[0]?.rr ?? 0,
    score, grade, checklist,
    poi: { type: model.poi.type, top: model.poi.top, bottom: model.poi.bottom, state: model.poi.state },
    ltf: vpL ? { poc: vpL.poc, vah: vpL.vah, val: vpL.val, from: leg[0]?.time ?? null } : null,
    // 同一段操縱＋結構轉向只算一個計畫（回測去重、推播去重用）
    id: `${dir}:${model.sweep.time}:${model.mss.time}`,
  };
}
