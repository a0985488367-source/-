/**
 * 溢價／折價（Premium / Discount）與最佳進場區（OTE）
 *
 * 機構思維：只在「折價」買、在「溢價」賣。
 *  - Equilibrium (EQ) = 交易區間 50%
 *  - Discount  = EQ 以下（買方有利）
 *  - Premium   = EQ 以上（賣方有利）
 *  - OTE (Optimal Trade Entry) = 回撤 0.618 ~ 0.79 之間的黃金區
 */

export const FIB_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 0.705, 0.79, 1];

/**
 * @param {{high:number,low:number,direction:'up'|'down'}} range
 * @param {number} price
 */
export function premiumDiscount(range, price) {
  if (!range) return null;
  const { high, low } = range;
  const span = high - low;
  if (!(span > 0)) return null;
  const rawRatio = (price - low) / span;
  const ratio = Math.max(0, Math.min(1, rawRatio));
  const eq = (high + low) / 2;
  let zone = 'equilibrium';
  if (ratio > 0.55) zone = 'premium';
  else if (ratio < 0.45) zone = 'discount';
  return {
    high,
    low,
    eq,
    span,
    ratio,
    rawRatio,
    outside: rawRatio > 1 ? 'above' : rawRatio < 0 ? 'below' : null,
    pct: ratio * 100,
    zone,
    /** 對多方有利 = 折價；對空方有利 = 溢價 */
    favors: zone === 'discount' ? 'long' : zone === 'premium' ? 'short' : 'neutral',
    deepDiscount: ratio < 0.25,
    deepPremium: ratio > 0.75,
  };
}

/** 回撤斐波那契等級（依區間方向計算） */
export function fibLevels(range) {
  if (!range) return [];
  const { high, low, direction } = range;
  return FIB_LEVELS.map((l) => ({
    level: l,
    price: direction === 'up' ? high - (high - low) * l : low + (high - low) * l,
    label: l === 0.5 ? 'EQ' : `${(l * 100).toFixed(1)}%`,
  }));
}

/** OTE 區（0.618–0.79 回撤） */
export function oteZone(range) {
  if (!range) return null;
  const { high, low, direction } = range;
  const span = high - low;
  if (!(span > 0)) return null;
  if (direction === 'up') {
    return { dir: 'long', top: high - span * 0.618, bottom: high - span * 0.79, sweet: high - span * 0.705 };
  }
  return { dir: 'short', top: low + span * 0.79, bottom: low + span * 0.618, sweet: low + span * 0.705 };
}

/**
 * 綜合 POI（Point of Interest）清單：把 OB、FVG、OTE、流動性整合成排序後的關鍵價位。
 */
export function buildPois({ orderBlocks = [], gaps = [], ote = null, price, bias = 'neutral' }) {
  const pois = [];
  for (const b of orderBlocks) {
    const dir = b.state === 'breaker' ? b.breakerDir : b.dir;
    pois.push({
      id: b.id,
      type: b.state === 'breaker' ? 'Breaker' : 'Order Block',
      dir,
      top: b.top,
      bottom: b.bottom,
      mid: b.mid,
      score: b.score,
      state: b.state,
      scale: b.scale,
      meta: b,
    });
  }
  for (const g of gaps) {
    const dir = g.state === 'inverted' ? g.invertedDir : g.dir;
    pois.push({
      id: g.id,
      type: g.kind === 'vi' ? 'Volume Imbalance' : g.state === 'inverted' ? 'Inversion FVG' : 'FVG',
      dir,
      top: g.top,
      bottom: g.bottom,
      mid: g.mid,
      score: g.score,
      state: g.state,
      meta: g,
    });
  }
  if (ote) {
    pois.push({
      id: 'ote',
      type: 'OTE',
      dir: ote.dir === 'long' ? 'bull' : 'bear',
      top: ote.top,
      bottom: ote.bottom,
      mid: ote.sweet,
      score: 60,
      state: 'zone',
    });
  }
  const biasDir = bias === 'bullish' ? 'bull' : bias === 'bearish' ? 'bear' : null;
  return pois
    .map((p) => ({
      ...p,
      distancePct: ((p.mid - price) / price) * 100,
      aligned: biasDir ? p.dir === biasDir : true,
      // 綜合分數：品質分 + 與偏向一致 + 距離現價越近越優先
      rank: (p.score || 50) + (biasDir && p.dir === biasDir ? 12 : -8) - Math.min(25, Math.abs((p.mid - price) / price) * 900),
    }))
    .sort((a, b) => b.rank - a.rank);
}

/**
 * 區塊匯流（Confluence Stack）：多個 POI 價格重疊 → 強度倍增。
 */
export function stackConfluence(pois, tolerancePct = 0.12) {
  const stacks = [];
  for (const p of pois) {
    const s = stacks.find(
      (st) => st.dir === p.dir && Math.abs(st.mid - p.mid) / Math.max(1e-9, p.mid) * 100 <= tolerancePct,
    );
    if (s) {
      s.members.push(p);
      s.top = Math.max(s.top, p.top);
      s.bottom = Math.min(s.bottom, p.bottom);
      s.mid = (s.top + s.bottom) / 2;
      s.score = Math.min(100, s.score + p.score * 0.35);
    } else {
      stacks.push({ dir: p.dir, top: p.top, bottom: p.bottom, mid: p.mid, score: p.score, members: [p] });
    }
  }
  return stacks.sort((a, b) => b.score - a.score);
}
