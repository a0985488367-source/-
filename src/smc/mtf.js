/**
 * 多週期分析（Multi-Timeframe / Top-Down Analysis）
 *
 * SMC 的標準流程：
 *   1. HTF（1D/4H）定「敘事」與流動性目標
 *   2. MTF（1H/15m）定「結構」與 POI
 *   3. LTF（5m/1m）找「進場」確認（CHoCH + FVG）
 *
 * 本模組把各週期偏向加權彙整，並輸出一致性（Alignment）指標。
 */

export const TF_ORDER = ['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '12h', '1d', '3d', '1w'];

/** 週期權重：越高週期影響越大 */
export const TF_WEIGHT = {
  '1m': 0.4, '3m': 0.5, '5m': 0.7, '15m': 1.0, '30m': 1.2,
  '1h': 1.6, '2h': 1.8, '4h': 2.2, '6h': 2.3, '12h': 2.6,
  '1d': 3.0, '3d': 3.2, '1w': 3.4,
};

/** 依進場週期推薦的 HTF / LTF 組合（採用交易員實務上的標準配對） */
export const HTF_MAP = {
  '1m': '15m', '3m': '30m', '5m': '1h', '15m': '4h', '30m': '4h',
  '1h': '1d', '2h': '1d', '4h': '1d', '6h': '1w', '12h': '1w',
  '1d': '1w', '3d': '1w', '1w': '1w',
};
export const LTF_MAP = {
  '1m': '1m', '3m': '1m', '5m': '1m', '15m': '5m', '30m': '5m',
  '1h': '15m', '2h': '15m', '4h': '1h', '6h': '1h', '12h': '1h',
  '1d': '4h', '3d': '4h', '1w': '1d',
};

export function tfSuite(interval) {
  return {
    htf: HTF_MAP[interval] || '4h',
    mtf: interval,
    ltf: LTF_MAP[interval] || '5m',
  };
}

/**
 * @param {Array<{interval:string, bias:{score:number,label:string}, structure:any, pd:any}>} rows
 */
export function aggregateBias(rows) {
  if (!rows.length) return null;
  let wsum = 0;
  let total = 0;
  for (const r of rows) {
    const w = TF_WEIGHT[r.interval] ?? 1;
    wsum += w;
    total += (r.bias?.score ?? 0) * w;
  }
  const score = Math.round(total / (wsum || 1));
  const bulls = rows.filter((r) => (r.bias?.score ?? 0) > 10).length;
  const bears = rows.filter((r) => (r.bias?.score ?? 0) < -10).length;
  const dominant = Math.max(bulls, bears);
  const alignment = Math.round((dominant / rows.length) * 100);
  const label = score >= 25 ? 'bullish' : score <= -25 ? 'bearish' : 'neutral';
  return {
    score,
    label,
    labelZh: label === 'bullish' ? '看多' : label === 'bearish' ? '看空' : '中性',
    alignment,
    bulls,
    bears,
    neutrals: rows.length - bulls - bears,
    rows,
    conflict: bulls > 0 && bears > 0 && Math.abs(bulls - bears) <= 1,
  };
}

/**
 * 由上而下的文字敘事（可直接貼進交易日誌）
 */
export function narrative(rows, agg, lang = 'zh') {
  if (!agg) return '';
  const htf = rows[rows.length - 1];
  const ltf = rows[0];
  if (lang === 'zh') {
    const parts = [
      `整體偏向：${agg.labelZh}（分數 ${agg.score}，一致性 ${agg.alignment}%）。`,
      htf ? `高週期 ${htf.interval} 為 ${zh(htf.bias.label)}，結構 ${htf.structure?.swing?.trendLabel ?? '—'}。` : '',
      ltf ? `進場週期 ${ltf.interval} 為 ${zh(ltf.bias.label)}；${ltf.pd ? `價格位於區間 ${ltf.pd.pct.toFixed(0)}%（${zhZone(ltf.pd.zone)}）。` : ''}` : '',
      agg.conflict ? '⚠️ 各週期方向分歧，建議降低風險或等待高週期表態。' : '各週期方向大致一致，可依計畫執行。',
    ];
    return parts.filter(Boolean).join('\n');
  }
  const parts = [
    `Overall bias: ${agg.label} (score ${agg.score}, alignment ${agg.alignment}%).`,
    htf ? `HTF ${htf.interval} is ${htf.bias.label}, swing structure ${htf.structure?.swing?.trendLabel ?? '—'}.` : '',
    ltf ? `Entry TF ${ltf.interval} is ${ltf.bias.label}; ${ltf.pd ? `price at ${ltf.pd.pct.toFixed(0)}% of range (${ltf.pd.zone}).` : ''}` : '',
    agg.conflict ? '⚠️ Timeframes disagree — reduce risk or wait for HTF confirmation.' : 'Timeframes broadly agree — execute the plan.',
  ];
  return parts.filter(Boolean).join('\n');
}

const zh = (l) => (l === 'bullish' ? '看多' : l === 'bearish' ? '看空' : '中性');
const zhZone = (z) => (z === 'premium' ? '溢價' : z === 'discount' ? '折價' : '均衡');
