/**
 * 流動性（Liquidity）模組
 *
 * SMC 的核心觀念：價格不是「隨機遊走」，而是在「流動性之間移動」。
 *  - Buy-side liquidity (BSL)  : 前高／等高之上的買單停損 → 空方的目標。
 *  - Sell-side liquidity (SSL) : 前低／等低之下的多單停損 → 多方的目標。
 *  - Liquidity Sweep / Stop Hunt: 影線穿越但收盤收回 → 流動性被掃，常見反轉起點。
 *  - Inducement (IDM)          : 進入真正 POI 之前，故意製造的假回調，用來誘出散戶單。
 *  - Equal Highs / Lows (EQH/EQL): 明顯的等高等低，是機構最愛的流動性池。
 */

import { atr } from '../core/indicators.js';
import { detectSwings, alternateSwings } from './swings.js';

/**
 * 建立流動性池：把容差內的擺動點群聚成一個「池」。
 */
export function liquidityPools(candles, swings, opts = {}) {
  const { tolAtr = 0.18, minTouches = 1, maxAgeBars = 500 } = opts;
  const a = atr(candles, 14);
  const tolOf = (i) => (a[i] || candles[i].high - candles[i].low || 1) * tolAtr;
  const pools = [];

  for (const s of swings) {
    if (candles.length - s.index > maxAgeBars) continue;
    const tol = tolOf(s.index);
    const side = s.type === 'high' ? 'buyside' : 'sellside';
    const pool = pools.find(
      (p) => p.side === side && Math.abs(p.price - s.price) <= tol && !p.swept,
    );
    if (pool) {
      pool.touches += 1;
      pool.price = side === 'buyside' ? Math.max(pool.price, s.price) : Math.min(pool.price, s.price);
      pool.lastIndex = s.index;
      pool.indices.push(s.index);
      pool.equal = true;
    } else {
      pools.push({
        id: `liq-${side}-${s.index}`,
        side,
        price: s.price,
        touches: 1,
        equal: false,
        firstIndex: s.index,
        lastIndex: s.index,
        indices: [s.index],
        time: s.time,
        swept: false,
        sweptIndex: null,
      });
    }
  }

  // 標記是否已被掃除
  for (const p of pools) {
    for (let i = p.lastIndex + 1; i < candles.length; i++) {
      const c = candles[i];
      if (p.side === 'buyside' ? c.high > p.price : c.low < p.price) {
        p.swept = true;
        p.sweptIndex = i;
        p.sweptByClose = p.side === 'buyside' ? c.close > p.price : c.close < p.price;
        break;
      }
    }
    p.strength = Math.min(100, 30 + p.touches * 18 + (p.equal ? 15 : 0) + (p.swept ? -25 : 10));
  }

  return pools.filter((p) => p.touches >= minTouches).sort((x, y) => x.price - y.price);
}

/** 未被掃除的流動性（即潛在目標） */
export function untappedLiquidity(pools, price) {
  return {
    above: pools.filter((p) => !p.swept && p.price > price).sort((a, b) => a.price - b.price),
    below: pools.filter((p) => !p.swept && p.price < price).sort((a, b) => b.price - a.price),
  };
}

/**
 * 流動性掃除（Sweep / Stop Hunt）偵測：
 * 影線穿越擺動點，但收盤收回 → 視為掃除。
 */
export function detectSweeps(candles, swings, opts = {}) {
  const { lookforward = 60, minWickAtr = 0.05 } = opts;
  const a = atr(candles, 14);
  const sweeps = [];
  for (const s of swings) {
    const limit = Math.min(candles.length - 1, s.index + lookforward);
    for (let i = s.index + 2; i <= limit; i++) {
      const c = candles[i];
      const ref = a[i] || 1;
      if (s.type === 'high' && c.high > s.price) {
        const wick = c.high - Math.max(c.open, c.close);
        if (c.close < s.price && wick / ref >= minWickAtr) {
          sweeps.push(mkSweep('buyside', 'bear', s, i, c, (c.high - s.price) / ref));
        }
        break;
      }
      if (s.type === 'low' && c.low < s.price) {
        const wick = Math.min(c.open, c.close) - c.low;
        if (c.close > s.price && wick / ref >= minWickAtr) {
          sweeps.push(mkSweep('sellside', 'bull', s, i, c, (s.price - c.low) / ref));
        }
        break;
      }
    }
  }
  return sweeps.sort((x, y) => x.index - y.index);
}

function mkSweep(side, dir, swing, index, candle, depthAtr) {
  return {
    id: `sweep-${side}-${index}`,
    side,
    dir,
    index,
    time: candle.time,
    level: swing.price,
    extreme: side === 'buyside' ? candle.high : candle.low,
    depthAtr,
    strength: Math.min(100, 45 + depthAtr * 45),
  };
}

/**
 * 誘導（Inducement）：在最近一次結構事件的推動腿中，最後一個「反向次級擺動點」。
 * 價格通常會先取走這個流動性，再進入真正的 OB。
 */
export function findInducement(candles, event, opts = {}) {
  if (!event) return null;
  const { strength = 2 } = opts;
  const minor = alternateSwings(detectSwings(candles, strength));
  const wantType = event.dir === 'bull' ? 'low' : 'high';
  const inRange = minor.filter(
    (s) => s.type === wantType && s.index > Math.min(event.fromIndex, event.breakIndex) && s.index < event.breakIndex,
  );
  const idm = inRange[inRange.length - 1];
  if (!idm) return null;
  let taken = false;
  let takenIndex = null;
  for (let i = event.breakIndex + 1; i < candles.length; i++) {
    const c = candles[i];
    if (wantType === 'low' ? c.low <= idm.price : c.high >= idm.price) {
      taken = true;
      takenIndex = i;
      break;
    }
  }
  return {
    id: `idm-${idm.index}`,
    dir: event.dir,
    price: idm.price,
    index: idm.index,
    time: idm.time,
    taken,
    takenIndex,
  };
}

/**
 * 流動性熱力圖：把所有池依價格分箱，量化上下方的流動性密度。
 * 用來回答：「價格接下來最可能被吸引到哪一側？」
 */
export function liquidityBias(pools, price) {
  const above = pools.filter((p) => !p.swept && p.price > price);
  const below = pools.filter((p) => !p.swept && p.price < price);
  const w = (arr) => arr.reduce((s, p) => s + p.strength / Math.max(1, Math.abs(p.price - price) / price * 100), 0);
  const up = w(above);
  const down = w(below);
  const total = up + down || 1;
  return {
    up,
    down,
    upPct: (up / total) * 100,
    downPct: (down / total) * 100,
    bias: up > down * 1.2 ? 'buyside' : down > up * 1.2 ? 'sellside' : 'balanced',
  };
}
