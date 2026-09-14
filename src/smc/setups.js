/**
 * 交易計畫產生器（Trade Setup Builder）
 *
 * 把所有 SMC 元件組成一個「可執行、可驗證」的計畫：
 *   方向 → 進場區（POI）→ 停損（結構失效點）→ 三段目標（流動性）→ 風報比 → 匯流評分。
 *
 * 設計原則：所有判斷都必須「可解釋」，每一項匯流條件都附上通過與否及原因。
 */

import { sessionOf } from './sessions.js';

const CHECKS = [
  { key: 'htfAlign', weight: 18, zh: '高週期偏向一致', en: 'HTF bias alignment' },
  { key: 'structure', weight: 15, zh: '進場週期已出現 CHoCH / BOS 確認', en: 'Entry TF structure confirmed' },
  { key: 'pdSide', weight: 12, zh: '價格位於正確的折價／溢價側', en: 'Correct premium/discount side' },
  { key: 'poiFresh', weight: 12, zh: '進場 POI 未被消耗（新鮮）', en: 'POI is unmitigated' },
  { key: 'sweep', weight: 12, zh: '進場前已掃除反向流動性', en: 'Liquidity swept before entry' },
  { key: 'stacked', weight: 10, zh: 'POI 具多重匯流（OB + FVG / OTE）', en: 'Stacked confluence at POI' },
  { key: 'rr', weight: 10, zh: '風報比達標', en: 'R:R meets minimum' },
  { key: 'target', weight: 10, zh: '目標方向存在未觸及流動性', en: 'Untapped liquidity at target' },
  { key: 'momentum', weight: 8, zh: '均線／動能方向支持', en: 'Momentum & MA support' },
  { key: 'killzone', weight: 5, zh: '位於高勝率交易時段（Killzone）', en: 'Inside a killzone' },
];

const TOTAL_WEIGHT = CHECKS.reduce((s, c) => s + c.weight, 0);

/**
 * @param {object} ctx 由 engine.js 提供的完整分析結果
 * @param {object} opts { minRR, htfBias, riskBufferAtr }
 */
export function buildSetup(ctx, opts = {}) {
  const { minRR = 2, htfBias = null, riskBufferAtr = 0.35 } = opts;
  const { candles, price, atrValue, pois, stacks, structure, pd, liq, sweeps, indicators } = ctx;
  if (!candles.length) return null;

  // 方向 = 高週期偏向（權重 60%）+ 進場週期偏向（40%）。
  // 高週期定敘事，但若進場週期強烈反向，分數會被拉近中性 → 傾向不給計畫。
  const localScore = ctx.bias?.score ?? 0;
  const htfScore = htfBias?.score ?? localScore;
  const dirScore = htfBias ? htfScore * 0.6 + localScore * 0.4 : localScore;
  const conflict = htfBias ? Math.sign(htfScore) !== Math.sign(localScore) && Math.abs(htfScore) > 20 && Math.abs(localScore) > 20 : false;
  let dir = dirScore > 8 ? 'long' : dirScore < -8 ? 'short' : null;

  // 無明確方向時，改用「最近一次結構事件 + 折溢價」決定戰術方向
  if (!dir) {
    const le = structure.internal.lastEvent;
    if (le) dir = le.dir === 'bull' ? 'long' : 'short';
    else dir = pd?.favors === 'long' ? 'long' : 'short';
  }

  const wantDir = dir === 'long' ? 'bull' : 'bear';
  const candidates = pois.filter((p) => p.dir === wantDir && p.state !== 'mitigated' && p.state !== 'filled');
  // 多單找現價下方（或現價所在）的 POI；空單相反
  const zonePool = candidates.filter((p) => (dir === 'long' ? p.bottom <= price * 1.004 : p.top >= price * 0.996));
  // 只採用「價格搆得到」的 POI：太遠的區塊算不上可執行的計畫
  const reach = Math.max((atrValue || price * 0.004) * 5, price * 0.035);
  const nearby = zonePool.filter((p) => Math.abs(p.mid - price) <= reach);
  const poi = nearby[0] || zonePool[0] || candidates[0];
  if (!poi) {
    // 沒有可用 POI 時，回傳「為什麼沒有計畫」而不是沉默地消失
    return {
      none: true,
      dir,
      reasonZh: `目前偏向${dir === 'long' ? '做多' : '做空'}，但圖上沒有仍然有效的${dir === 'long' ? '需求' : '供給'}區（OB／FVG）可作為進場點。等待價格形成新的結構與 POI。`,
      reasonEn: `Bias is ${dir}, but there is no unmitigated ${dir === 'long' ? 'demand' : 'supply'} zone (OB/FVG) to trade from. Wait for new structure and a fresh POI.`,
    };
  }

  const inside = price <= poi.top && price >= poi.bottom;
  const entry = inside ? price : dir === 'long' ? Math.min(poi.top, price) : Math.max(poi.bottom, price);
  const entryZone = { top: poi.top, bottom: poi.bottom, mid: poi.mid };
  const buffer = (atrValue || (price * 0.002)) * riskBufferAtr;

  const structuralStop =
    dir === 'long'
      ? Math.min(poi.bottom, structure.internal.protectedLow?.price ?? poi.bottom)
      : Math.max(poi.top, structure.internal.protectedHigh?.price ?? poi.top);
  let stop = dir === 'long' ? structuralStop - buffer : structuralStop + buffer;

  // 停損不可過窄：至少 0.3 ATR，否則風報比會被灌水成不切實際的數字
  const minRisk = (atrValue || price * 0.004) * 0.3;
  if (Math.abs(entry - stop) < minRisk) stop = dir === 'long' ? entry - minRisk : entry + minRisk;

  const risk = Math.abs(entry - stop);
  if (!(risk > 0)) return null;

  const targets = pickTargets({ dir, entry, risk, ctx });
  const rr1 = targets[0] ? Math.abs(targets[0].price - entry) / risk : 0;
  const rrFinal = targets.length ? Math.abs(targets[targets.length - 1].price - entry) / risk : 0;

  const lastSweep = sweeps[sweeps.length - 1];
  const lastEvent = structure.internal.lastEvent;
  const kz = sessionOf(candles[candles.length - 1].time);
  const ema50 = lastVal(indicators.ema50);
  const ema200 = lastVal(indicators.ema200);
  const rsiVal = lastVal(indicators.rsi);

  const results = {
    htfAlign: htfBias ? (dir === 'long' ? htfBias.score > 5 : htfBias.score < -5) : (dir === 'long' ? dirScore > 0 : dirScore < 0),
    structure: !!lastEvent && (dir === 'long' ? lastEvent.dir === 'bull' : lastEvent.dir === 'bear'),
    pdSide: dir === 'long' ? (pd ? pd.ratio < 0.5 : false) : (pd ? pd.ratio > 0.5 : false),
    poiFresh: poi.state === 'fresh' || poi.state === 'zone',
    sweep: !!lastSweep && lastSweep.dir === wantDir && candles.length - lastSweep.index <= 30,
    stacked: (stacks.find((s) => s.dir === wantDir && overlap(s, poi))?.members?.length ?? 1) > 1,
    rr: rrFinal >= minRR,
    target: dir === 'long' ? liq.above.length > 0 : liq.below.length > 0,
    momentum:
      dir === 'long'
        ? (ema50 != null && price > ema50) || (rsiVal != null && rsiVal > 50)
        : (ema50 != null && price < ema50) || (rsiVal != null && rsiVal < 50),
    killzone: !!kz,
  };

  const checklist = CHECKS.map((c) => ({ ...c, ok: !!results[c.key] }));
  const raw = checklist.reduce((s, c) => s + (c.ok ? c.weight : 0), 0);
  const score = Math.round((raw / TOTAL_WEIGHT) * 100);
  const grade = score >= 80 ? 'A+' : score >= 68 ? 'A' : score >= 55 ? 'B' : score >= 42 ? 'C' : 'D';

  return {
    dir,
    conflict,
    side: dir === 'long' ? '做多 Long' : '做空 Short',
    poi,
    entry,
    entryZone,
    entryType: inside ? 'market' : 'limit',
    stop,
    risk,
    riskPct: (risk / entry) * 100,
    targets,
    rr1,
    rrFinal,
    score,
    grade,
    checklist,
    valid: score >= 42 && rrFinal >= Math.min(1.5, minRR),
    trend: structure.swing.trendLabel,
    killzone: kz,
    invalidation:
      dir === 'long'
        ? '價格以收盤價跌破 POI 下緣／受保護低點，多方劇本失效。'
        : '價格以收盤價突破 POI 上緣／受保護高點，空方劇本失效。',
    invalidationEn:
      dir === 'long'
        ? 'A close below the POI low / protected low invalidates the long thesis.'
        : 'A close above the POI high / protected high invalidates the short thesis.',
    notes: buildNotes({ dir, poi, pd, lastEvent, lastSweep, ctx, conflict }),
  };
}

function overlap(a, b) {
  return a.bottom <= b.top && b.bottom <= a.top;
}

function lastVal(arr) {
  if (!arr) return null;
  for (let i = arr.length - 1; i >= 0; i--) if (arr[i] != null) return arr[i];
  return null;
}

/** 目標優先順序：最近未觸及流動性 → 次級流動性 → 區間反向極值 / 1:3 延伸 */
function pickTargets({ dir, entry, risk, ctx }) {
  const { liq, range, price, keyLevels } = ctx;
  const pool = dir === 'long' ? liq.above : liq.below;
  const out = [];
  const seen = new Set();
  const add = (p, label, labelEn) => {
    if (p == null || !isFinite(p)) return;
    if (dir === 'long' ? p <= entry + risk * 0.3 : p >= entry - risk * 0.3) return;
    const key = p.toFixed(8);
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ price: p, label, labelEn, rr: Math.abs(p - entry) / risk });
  };

  pool.slice(0, 2).forEach((p, i) =>
    add(p.price, p.equal ? `等${dir === 'long' ? '高' : '低'}流動性` : `擺動${dir === 'long' ? '高' : '低'}流動性`, p.equal ? 'Equal-level liquidity' : 'Swing liquidity'),
  );
  const kl = (keyLevels || [])
    .filter((l) => (dir === 'long' ? l.price > price : l.price < price))
    .sort((a, b) => (dir === 'long' ? a.price - b.price : b.price - a.price))[0];
  if (kl) add(kl.price, `${kl.zh}（${kl.code}）`, `${kl.en} (${kl.code})`);
  if (range) add(dir === 'long' ? range.high : range.low, '區間極值', 'Range extreme');
  add(dir === 'long' ? entry + risk * 3 : entry - risk * 3, '1:3 延伸目標', '1:3 extension');

  // 過濾不切實際的目標：< 0.8R 太近沒有意義，> 12R 多半代表 POI 離現價太遠
  const sorted = out.sort((a, b) => a.rr - b.rr);
  const usable = sorted.filter((t) => t.rr >= 0.8 && t.rr <= 12);
  return (usable.length ? usable : sorted.slice(0, 1))
    .slice(0, 3)
    .map((t, i) => ({ ...t, name: `TP${i + 1}` }));
}

function buildNotes({ dir, poi, pd, lastEvent, lastSweep, ctx, conflict }) {
  const zh = [];
  const en = [];
  if (conflict) {
    zh.push('⚠ 高週期與進場週期方向分歧，屬於低品質環境，建議減碼或等待表態。');
    en.push('⚠ HTF and entry timeframe disagree — low-quality environment, reduce size or wait.');
  }
  if (lastEvent) {
    zh.push(`最近一次結構事件為 ${lastEvent.type}（${lastEvent.dir === 'bull' ? '看多' : '看空'}），突破價位 ${lastEvent.price.toFixed(2)}。`);
    en.push(`Latest structure event: ${lastEvent.type} (${lastEvent.dir}) breaking ${lastEvent.price.toFixed(2)}.`);
  }
  if (pd) {
    zh.push(`目前價格位於交易區間的 ${pd.pct.toFixed(1)}%（${pd.zone === 'premium' ? '溢價區' : pd.zone === 'discount' ? '折價區' : '均衡區'}）。`);
    en.push(`Price sits at ${pd.pct.toFixed(1)}% of the dealing range (${pd.zone}).`);
  }
  if (lastSweep) {
    zh.push(`最近一次流動性掃除發生在 ${lastSweep.side === 'buyside' ? '買方（前高之上）' : '賣方（前低之下）'}，深度 ${lastSweep.depthAtr.toFixed(2)} ATR。`);
    en.push(`Most recent sweep took ${lastSweep.side} liquidity, depth ${lastSweep.depthAtr.toFixed(2)} ATR.`);
  }
  zh.push(`建議在 ${poi.type} 區間（${poi.bottom.toFixed(2)} – ${poi.top.toFixed(2)}）等待反應後再進場，避免直接追價。`);
  en.push(`Wait for a reaction inside the ${poi.type} zone (${poi.bottom.toFixed(2)} – ${poi.top.toFixed(2)}) rather than chasing price.`);
  return { zh, en };
}

/** 部位大小計算（風險固定法） */
export function positionSize({ accountSize, riskPct, entry, stop, leverage = 1 }) {
  const riskAmount = (accountSize * riskPct) / 100;
  const perUnit = Math.abs(entry - stop);
  if (!(perUnit > 0) || !(accountSize > 0)) return null;
  const qty = riskAmount / perUnit;
  const notional = qty * entry;
  return {
    riskAmount,
    qty,
    notional,
    marginRequired: notional / Math.max(1, leverage),
    leverageUsed: notional / Math.max(1e-9, accountSize),
    liquidationWarning: notional / Math.max(1, leverage) > accountSize,
  };
}
