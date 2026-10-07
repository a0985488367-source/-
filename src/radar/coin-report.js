/**
 * 單一幣種「全週期報告」（2026-10-07 使用者要的：搜一個幣，15m～1w 每個週期的流動性、獵取、
 * 關鍵點位、進場計畫、合約數據都列出來，最上面給多空總結＋最值得看的週期）。
 *
 * 全部是純函式：傳入各週期「已收盤」的 K 棒（時間升冪），網頁（coin/）跟測試共用。
 * SMC 計畫跟 App／TradingView／Discord 同一套：每個週期最近 499 根已收盤 K 棒，
 * 高週期偏向照 tfSuite（15m／30m→4h、1h／2h／4h→1d、6h／1d→1w）。
 */

import { analyze } from '../smc/engine.js';
import { aggregateBias, tfSuite, TF_WEIGHT } from '../smc/mtf.js';
import { keyLevels } from '../smc/sessions.js';
import { breakoutSignal, breakoutIndicators } from '../strategies/breakout.js';
import { emaCrossSignal, emaCrossIndicators } from '../strategies/ema-cross.js';
import { macdZeroSignal, macdZeroIndicators } from '../strategies/macd-zero.js';
import { trendExtraSignal, trendExtraIndicators } from '../strategies/trend-extra.js';

export const REPORT_TFS = ['15m', '30m', '1h', '2h', '4h', '6h', '1d', '1w'];
export const ANALYZE_BARS = 499;

const pctFrom = (p, price) => ((p - price) / price) * 100;
const round = (v, d = 2) => (Number.isFinite(v) ? Math.round(v * 10 ** d) / 10 ** d : null);

/** 6 個順勢策略（線上自動下單那套）在這個週期「最近一次訊號」是什麼時候、方向，以及現在的指標狀態 */
export function trendState(candles, { lookback = 120 } = {}) {
  const n = candles.length;
  if (n < 210) return null;
  const pre = {
    breakout: breakoutIndicators(candles, { lookback: 55, stopAtr: 2 }),
    ema: emaCrossIndicators(candles, { fast: 20, slow: 50, stopAtr: 2 }),
    macd: macdZeroIndicators(candles, { stopAtr: 2 }),
    extra: trendExtraIndicators(candles),
  };
  const fns = {
    breakout: (i) => breakoutSignal(candles, { lookback: 55, stopAtr: 2 }, i, pre.breakout),
    ema: (i) => emaCrossSignal(candles, { fast: 20, slow: 50, stopAtr: 2 }, i, pre.ema),
    macd: (i) => macdZeroSignal(candles, { stopAtr: 2 }, i, pre.macd),
    vol: (i) => trendExtraSignal('vol', candles, i, pre.extra),
    st: (i) => trendExtraSignal('st', candles, i, pre.extra),
    gc: (i) => trendExtraSignal('gc', candles, i, pre.extra),
  };
  const last = {};
  for (const [k, f] of Object.entries(fns)) {
    last[k] = null;
    for (let i = n - 1; i >= Math.max(1, n - lookback); i--) {
      const s = f(i);
      if (s) { last[k] = { dir: s.dir, barsAgo: n - 1 - i, time: candles[i].time, stopDistance: s.stopDistance, close: candles[i].close }; break; }
    }
  }
  const x = pre.extra;
  const e = pre.ema;
  const i = n - 1;
  const hi55 = Math.max(...candles.slice(-56, -1).map((c) => c.high));
  const lo55 = Math.min(...candles.slice(-56, -1).map((c) => c.low));
  return {
    last,
    supertrend: x.st[i] ?? null,
    emaFastAbove: e.fast?.[i] != null && e.slow?.[i] != null ? e.fast[i] > e.slow[i] : null,
    aboveEma200: x.e200[i] != null ? x.close[i] > x.e200[i] : null,
    sma50Above200: x.s50[i] != null && x.s200[i] != null ? x.s50[i] > x.s200[i] : null,
    macdAboveZero: pre.macd.macd?.[i] != null ? pre.macd.macd[i] > 0 : null,
    donchian55: { high: hi55, low: lo55 },
  };
}

/** 一個週期的完整報告 */
function tfReport(interval, a, candles, htfBias) {
  const price = a.price;
  const pool = (p) => ({ price: p.price, touches: p.touches, equal: p.equal, distPct: round(pctFrom(p.price, price), 3), time: p.time });
  const n = candles.length;
  const sweeps = (a.sweeps ?? []).slice(-4).reverse().map((s) => ({
    side: s.side, dir: s.dir, level: s.level, extreme: s.extreme, time: s.time, barsAgo: n - 1 - s.index, depthAtr: round(s.depthAtr),
  }));
  const s = a.setup;
  const setup = !s || s.none
    ? { none: true, dir: s?.dir ?? null, reasonZh: s?.reasonZh ?? '沒有可用的計畫' }
    : {
      dir: s.dir, entry: s.entry, stop: s.stop, entryType: s.entryType, score: s.score, grade: s.grade, valid: s.valid,
      riskPct: round(s.riskPct), distPct: round(pctFrom(s.entry, price), 3), rrFinal: round(s.rrFinal),
      targets: s.targets.map((t) => ({ name: t.name, price: t.price, rr: round(t.rr), label: t.label })),
      poi: s.poi ? { type: s.poi.type, top: s.poi.top, bottom: s.poi.bottom } : null,
      zone: s.entryZone ?? null,
      checklist: (s.checklist ?? []).map((c) => ({ key: c.key, zh: c.zh ?? c.label ?? c.key, ok: c.ok })),
      invalidation: s.invalidation ?? null,
    };
  const ev = [
    ...a.structure.swing.events.map((e) => ({ ...e, scope: 'swing' })),
    ...a.structure.internal.events.map((e) => ({ ...e, scope: 'internal' })),
  ].sort((x, y) => x.breakIndex - y.breakIndex).slice(-4).reverse()
    .map((e) => ({ type: e.type, dir: e.dir, price: e.price, time: candles[e.breakIndex]?.time ?? null, barsAgo: n - 1 - e.breakIndex, scope: e.scope }));
  const vp = a.indicators?.volumeProfile;
  const ind = a.indicators;
  return {
    interval,
    price,
    atr: a.atrValue,
    atrPct: round((a.atrValue / price) * 100, 3),
    bias: { score: a.bias.score, label: a.bias.label },
    htfBias: htfBias ? { score: htfBias.score, label: htfBias.label } : null,
    swingTrend: a.structure.swing.trendLabel,
    internalTrend: a.structure.internal.trendLabel,
    events: ev,
    liquidity: {
      above: (a.liq?.above ?? []).slice(0, 4).map(pool),
      below: (a.liq?.below ?? []).slice(0, 4).map(pool),
      sweeps,
      inducement: a.inducement ? { price: a.inducement.price, dir: a.inducement.dir ?? null, taken: !!a.inducement.taken } : null,
    },
    pd: a.pd ? { zone: a.pd.zone, pct: round(a.pd.pct, 1), high: a.pd.high, low: a.pd.low, eq: a.pd.eq } : null,
    ote: a.ote ? { dir: a.ote.dir, top: a.ote.top, bottom: a.ote.bottom, sweet: a.ote.sweet } : null,
    vp: vp ? { poc: vp.poc, vah: vp.vah, val: vp.val } : null,
    ema: { e20: ind.ema20.at(-1), e50: ind.ema50.at(-1), e200: ind.ema200.at(-1) },
    rsi: round(ind.rsi.at(-1), 1),
    pois: (a.pois ?? []).filter((p) => p.type !== 'OTE').slice(0, 6).map((p) => ({
      type: p.type, dir: p.dir, top: p.top, bottom: p.bottom, state: p.state, distPct: round(pctFrom(p.mid, price), 3),
    })),
    setup,
    trend: trendState(candles),
  };
}

/**
 * 估算爆倉密集區（只是估算：交易所不公開每個人的開倉價和槓桿）。
 * 假設最近每根 1h K 棒都有人用 10／25／50／100 倍開多開空（量越大開越多），
 * 算出各自的強平價；之後價格已經走過去的就當作已經爆掉、不算。
 */
export function liquidationClusters(candles, price, { bars = 168, levers = [[10, 0.35], [25, 0.3], [50, 0.2], [100, 0.15]], bins = 80, mm = 0.005 } = {}) {
  const xs = candles.slice(-bars);
  if (xs.length < 24) return null;
  const lo = price * 0.75, hi = price * 1.25;
  const step = (hi - lo) / bins;
  const longs = new Array(bins).fill(0), shorts = new Array(bins).fill(0);
  // 之後最低／最高價（含自己這根）：強平價已經被走過的就算爆掉了
  const minAfter = new Array(xs.length), maxAfter = new Array(xs.length);
  for (let k = xs.length - 1; k >= 0; k--) {
    minAfter[k] = Math.min(xs[k].low, k + 1 < xs.length ? minAfter[k + 1] : Infinity);
    maxAfter[k] = Math.max(xs[k].high, k + 1 < xs.length ? maxAfter[k + 1] : -Infinity);
  }
  for (let k = 0; k < xs.length; k++) {
    const c = xs[k];
    const p = (c.high + c.low + c.close) / 3;
    for (const [lev, w] of levers) {
      const vol = c.volume * w;
      const liqL = p * (1 - 1 / lev + mm);
      const liqS = p * (1 + 1 / lev - mm);
      const longAlive = liqL < minAfter[k];
      const shortAlive = liqS > maxAfter[k];
      if (longAlive && liqL >= lo && liqL < hi) longs[Math.floor((liqL - lo) / step)] += vol;
      if (shortAlive && liqS >= lo && liqS < hi) shorts[Math.floor((liqS - lo) / step)] += vol;
    }
  }
  const pack = (arr, side) => arr.map((v, b) => ({ side, price: lo + step * (b + 0.5), weight: v }))
    .filter((x) => x.weight > 0 && (side === 'long' ? x.price < price : x.price > price));
  const all = [...pack(longs, 'long'), ...pack(shorts, 'short')];
  const max = Math.max(1, ...all.map((x) => x.weight));
  const top = (side) => all.filter((x) => x.side === side).sort((a, b) => b.weight - a.weight).slice(0, 4)
    .map((x) => ({ ...x, strength: Math.round((x.weight / max) * 100), distPct: round(pctFrom(x.price, price), 2) }))
    .sort((a, b) => Math.abs(a.distPct) - Math.abs(b.distPct));
  return { longs: top('long'), shorts: top('short'), binPct: round((step / price) * 100, 2) };
}

/** 把各週期的流動性合在一起：價格很近（0.15% 內）的併成一個，記下是哪幾個週期都看得到 */
function mergeLevels(items, price, tolPct = 0.15) {
  const sorted = [...items].sort((a, b) => a.price - b.price);
  const out = [];
  for (const it of sorted) {
    const last = out[out.length - 1];
    if (last && Math.abs(pctFrom(it.price, last.price)) <= tolPct) {
      last.tfs.add(it.tf);
      last.touches += it.touches ?? 1;
      last.weight += TF_WEIGHT[it.tf] ?? 1;
    } else out.push({ price: it.price, tfs: new Set([it.tf]), touches: it.touches ?? 1, weight: TF_WEIGHT[it.tf] ?? 1 });
  }
  return out.map((x) => ({ price: x.price, tfs: [...x.tfs], touches: x.touches, weight: round(x.weight, 1), distPct: round(pctFrom(x.price, price), 3) }));
}

/**
 * @param {{[tf:string]: any[]}} tfCandles 各週期「已收盤」K 棒
 * @param {object} [opts] { daily: 含盤中那根的日線（算前日／前週／前月高低）, h1: 1h 已收盤（爆倉估算）, price: 最新價, derivatives, lsRatio }
 */
export function buildCoinReport(tfCandles, opts = {}) {
  const tfs = REPORT_TFS.filter((tf) => tfCandles[tf]?.length >= 60);
  // 第一輪：各週期自己的偏向（＝線上當成「高週期偏向」用的那個）
  const first = {};
  for (const tf of tfs) first[tf] = analyze(tfCandles[tf].slice(-ANALYZE_BARS));
  // 第二輪：帶高週期偏向重算（跟 App／Discord 一樣）
  const reports = [];
  for (const tf of tfs) {
    const htf = tfSuite(tf).htf;
    const hb = htf !== tf && first[htf] && !first[htf].empty ? aggregateBias([{ interval: htf, bias: first[htf].bias }]) : null;
    const a = hb ? analyze(tfCandles[tf].slice(-ANALYZE_BARS), { htfBias: hb }) : first[tf];
    if (a.empty) continue;
    reports.push(tfReport(tf, a, tfCandles[tf].slice(-ANALYZE_BARS), hb));
  }
  if (!reports.length) return { empty: true };
  const price = opts.price ?? reports[0].price;

  const agg = aggregateBias(reports.map((r) => ({ interval: r.interval, bias: r.bias })));
  const want = agg.label === 'bullish' ? 'long' : agg.label === 'bearish' ? 'short' : null;
  const plans = reports.filter((r) => !r.setup.none).map((r) => ({ tf: r.interval, ...r.setup, distPct: round(pctFrom(r.setup.entry, price), 3) }));
  const validPlans = plans.filter((p) => p.valid);
  // 最值得看的週期：計畫有效、方向跟整體偏向一致（中性時不限）、分數高、離現價近
  const ranked = validPlans
    .map((p) => ({ ...p, rank: p.score + (want ? (p.dir === want ? 15 : -20) : 0) - Math.min(30, Math.abs(p.distPct) * 6) + (TF_WEIGHT[p.tf] ?? 1) * 2 }))
    .sort((x, y) => y.rank - x.rank);
  const best = ranked[0] ?? null;

  const liqAbove = mergeLevels(reports.flatMap((r) => r.liquidity.above.map((p) => ({ ...p, tf: r.interval }))), price)
    .filter((x) => x.price > price).sort((a, b) => a.price - b.price).slice(0, 6);
  const liqBelow = mergeLevels(reports.flatMap((r) => r.liquidity.below.map((p) => ({ ...p, tf: r.interval }))), price)
    .filter((x) => x.price < price).sort((a, b) => b.price - a.price).slice(0, 6);
  const recentSweeps = reports.flatMap((r) => r.liquidity.sweeps.map((s) => ({ ...s, tf: r.interval })))
    .sort((a, b) => b.time - a.time).slice(0, 8);

  const levels = opts.daily?.length ? keyLevels(opts.daily).map((l) => ({ code: l.code, zh: l.zh, price: l.price, distPct: round(pctFrom(l.price, price), 3) })) : [];
  const liquidation = opts.h1?.length ? liquidationClusters(opts.h1, price) : null;

  return {
    price,
    generatedAt: Date.now(),
    agg: { score: agg.score, label: agg.label, labelZh: agg.labelZh, alignment: agg.alignment, bulls: agg.bulls, bears: agg.bears, neutrals: agg.neutrals, conflict: agg.conflict },
    best,
    plans: plans.sort((a, b) => Math.abs(a.distPct) - Math.abs(b.distPct)),
    liqAbove,
    liqBelow,
    recentSweeps,
    levels,
    liquidation,
    tfs: reports,
    narrative: narrativeZh({ agg, reports, best, liqAbove, liqBelow, price, derivatives: opts.derivatives, lsRatio: opts.lsRatio }),
  };
}

const BIAS_ZH = { bullish: '偏多', bearish: '偏空', neutral: '中性' };
const fmt = (p) => (p >= 1000 ? p.toFixed(1) : p >= 1 ? p.toFixed(4) : p.toPrecision(4));

/** 給人看的總結（幾句話） */
export function narrativeZh({ agg, reports, best, liqAbove, liqBelow, price, derivatives, lsRatio }) {
  const lines = [];
  const bull = reports.filter((r) => r.bias.score > 10).map((r) => r.interval);
  const bear = reports.filter((r) => r.bias.score < -10).map((r) => r.interval);
  const hi = reports.filter((r) => ['1d', '1w'].includes(r.interval)).map((r) => `${r.interval} ${BIAS_ZH[r.bias.label]}`).join('、');
  lines.push(`整體${agg.labelZh}（${agg.score > 0 ? '+' : ''}${agg.score}），${agg.alignment}% 的週期方向一致。偏多：${bull.join('、') || '沒有'}；偏空：${bear.join('、') || '沒有'}。${hi ? `大方向看 ${hi}。` : ''}`);
  if (agg.conflict) lines.push('多空週期數差不多，方向打架：短線容易來回掃，進場要更挑、倉位小一點。');
  if (best) {
    lines.push(`最值得看：${best.tf} ${best.dir === 'long' ? '做多' : '做空'}（${best.grade} 級 ${best.score} 分），${best.entryType === 'market' ? '價格已經在進場區' : `等回到 ${fmt(best.entry)}（離現價 ${best.distPct > 0 ? '+' : ''}${best.distPct}%）`}，停損 ${fmt(best.stop)}${best.targets[0] ? `，第一目標 ${fmt(best.targets[0].price)}（${best.targets[0].rr}R）` : ''}。`);
  } else lines.push('現在沒有任何週期有「有效」的進場計畫：等價格回到進場區或結構轉向。');
  const up = liqAbove[0], dn = liqBelow[0];
  if (up || dn) {
    lines.push(`上方最近的流動性 ${up ? `${fmt(up.price)}（+${up.distPct}%，${up.tfs.join('／')} 都看得到${up.touches > 1 ? `、${up.touches} 次碰到` : ''}）` : '沒有'}；下方 ${dn ? `${fmt(dn.price)}（${dn.distPct}%，${dn.tfs.join('／')}${dn.touches > 1 ? `、${dn.touches} 次碰到` : ''}）` : '沒有'}。價格常會先去掃比較近、比較多週期重疊的那一邊。`);
  }
  if (derivatives && Number.isFinite(derivatives.fundingRate)) {
    const fr = derivatives.fundingRate * 100;
    lines.push(`資金費率 ${fr.toFixed(4)}%（每 8 小時）${fr > 0.03 ? '：多單擠，小心多殺多' : fr < -0.01 ? '：空單擠，小心軋空' : '：正常'}。`);
  }
  if (lsRatio?.length) {
    const r = lsRatio[lsRatio.length - 1];
    lines.push(`Bybit 帳戶多空比 ${(r.buy * 100).toFixed(0)}% 多／${(r.sell * 100).toFixed(0)}% 空${r.buy > 0.6 ? '：散戶大多做多，反向要小心往下掃' : r.sell > 0.6 ? '：散戶大多做空，小心往上軋' : ''}。`);
  }
  return lines;
}
