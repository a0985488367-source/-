/**
 * SMC 分析引擎 — 單一週期的完整分析流程
 *
 * 流程：K 線 → 擺動點 → 結構(BOS/CHoCH) → 流動性/掃除 → FVG → OB/Breaker
 *      → 折溢價/OTE → POI 排序 → 偏向評分 → 交易計畫
 *
 * 全部為純函式，不依賴瀏覽器，方便單元測試與回放（replay）重算。
 */

import { atr, ema, rsi, sessionVwap, volumeProfile, relativeVolume } from '../core/indicators.js';
import { structuredSwings, dealingRange } from './swings.js';
import { dualStructure } from './structure.js';
import { detectFVG, activeGaps } from './fvg.js';
import { detectOrderBlocks, activeOrderBlocks } from './orderblocks.js';
import { liquidityPools, untappedLiquidity, detectSweeps, findInducement, liquidityBias } from './liquidity.js';
import { premiumDiscount, fibLevels, oteZone, buildPois, stackConfluence } from './zones.js';
import { keyLevels, sessionRanges, sessionOf } from './sessions.js';
import { buildSetup } from './setups.js';

export const DEFAULT_SETTINGS = {
  internalStrength: 2,
  swingStrength: 7,
  breakBy: 'close',        // 'close' | 'wick'
  obZoneMode: 'wick',      // 'wick' | 'body'
  minDisplacementAtr: 1.0,
  fvgMinAtr: 0.25,
  liquidityTolAtr: 0.18,
  minRR: 2,
  riskBufferAtr: 0.35,
  maxPois: 14,
  showVolumeImbalance: true,
};

/**
 * @param {any[]} candles OHLCV（時間升冪）
 * @param {object} settings
 */
export function analyze(candles, settings = {}) {
  const cfg = { ...DEFAULT_SETTINGS, ...settings };
  if (!candles || candles.length < 30) {
    return { empty: true, candles: candles || [], settings: cfg };
  }

  const price = candles[candles.length - 1].close;
  const atrArr = atr(candles, 14);
  const atrValue = atrArr[atrArr.length - 1] || price * 0.004;

  const swings = structuredSwings(candles, cfg.swingStrength);
  const microSwings = structuredSwings(candles, cfg.internalStrength);
  const structure = dualStructure(candles, {
    internalStrength: cfg.internalStrength,
    swingStrength: cfg.swingStrength,
    breakBy: cfg.breakBy,
  });

  const sweeps = detectSweeps(candles, microSwings, { minWickAtr: 0.05 });
  const gaps = detectFVG(candles, {
    minSizeAtr: cfg.fvgMinAtr,
    includeVolumeImbalance: cfg.showVolumeImbalance,
  });

  const allEvents = [...structure.swing.events, ...structure.internal.events].sort(
    (a, b) => a.breakIndex - b.breakIndex,
  );
  const orderBlocks = detectOrderBlocks(candles, allEvents, {
    zoneMode: cfg.obZoneMode,
    minDisplacementAtr: cfg.minDisplacementAtr,
    fvgList: gaps,
    sweeps,
  });

  const pools = liquidityPools(candles, swings.concat(microSwings).sort((a, b) => a.index - b.index), {
    tolAtr: cfg.liquidityTolAtr,
  });
  const liq = untappedLiquidity(pools, price);
  const liqBias = liquidityBias(pools, price);
  const inducement = findInducement(candles, structure.internal.lastEvent, { strength: cfg.internalStrength });

  const range = dealingRange(swings, candles);
  const pd = premiumDiscount(range, price);
  const ote = oteZone(range);
  const fib = fibLevels(range);

  const closes = candles.map((c) => c.close);
  const indicators = {
    ema20: ema(closes, 20),
    ema50: ema(closes, 50),
    ema200: ema(closes, 200),
    rsi: rsi(candles, 14),
    atr: atrArr,
    rvol: relativeVolume(candles, 20),
    ...sessionVwap(candles),
    volumeProfile: volumeProfile(candles.slice(-200)),
  };

  const bias = computeBias({ structure, pd, liqBias, indicators, price });

  const activeOb = activeOrderBlocks(orderBlocks, price);
  const activeFvg = activeGaps(gaps, price);
  const pois = buildPois({
    orderBlocks: activeOb,
    gaps: activeFvg,
    ote,
    price,
    bias: bias.label,
  }).slice(0, cfg.maxPois);
  const stacks = stackConfluence(pois);

  const ctx = {
    candles,
    price,
    atrValue,
    swings,
    microSwings,
    structure,
    sweeps,
    gaps,
    orderBlocks,
    pools,
    liq,
    liqBias,
    inducement,
    range,
    pd,
    ote,
    fib,
    indicators,
    bias,
    pois,
    stacks,
    keyLevels: keyLevels(candles),
    sessions: sessionRanges(candles, { maxDays: 4 }),
    currentSession: sessionOf(candles[candles.length - 1].time),
    settings: cfg,
  };

  ctx.setup = buildSetup(ctx, { minRR: cfg.minRR, riskBufferAtr: cfg.riskBufferAtr, htfBias: settings.htfBias || null });
  return ctx;
}

/**
 * 偏向評分（-100 ~ +100）— 每個因子都可解釋。
 */
export function computeBias({ structure, pd, liqBias, indicators, price }) {
  const factors = [];
  const add = (key, zh, en, score, detail) => factors.push({ key, zh, en, score, detail });

  const sw = structure.swing;
  add('swingStructure', '擺動結構', 'Swing structure',
    sw.trend * 34,
    sw.lastEvent ? `${sw.lastEvent.type} ${sw.lastEvent.dir}` : 'n/a');

  const it = structure.internal;
  add('internalStructure', '內部結構', 'Internal structure',
    it.trend * 16,
    it.lastEvent ? `${it.lastEvent.type} ${it.lastEvent.dir}` : 'n/a');

  if (pd) {
    // 折價區對多方有利，但若處於極端溢價則偏空
    const pdScore = (0.5 - pd.ratio) * 24;
    add('premiumDiscount', '折溢價位置', 'Premium/Discount', pdScore, `${pd.pct.toFixed(1)}% ${pd.zone}`);
  }

  if (liqBias) {
    const lb = ((liqBias.upPct - liqBias.downPct) / 100) * 12;
    add('liquidity', '流動性吸引', 'Liquidity draw', lb, liqBias.bias);
  }

  const ema50 = lastDefined(indicators.ema50);
  const ema200 = lastDefined(indicators.ema200);
  if (ema50 != null) add('ema50', '價格 vs EMA50', 'Price vs EMA50', price > ema50 ? 8 : -8, null);
  if (ema200 != null) add('ema200', '價格 vs EMA200', 'Price vs EMA200', price > ema200 ? 10 : -10, null);

  const r = lastDefined(indicators.rsi);
  if (r != null) add('rsi', 'RSI 動能', 'RSI momentum', ((r - 50) / 50) * 8, r.toFixed(1));

  const raw = factors.reduce((s, f) => s + f.score, 0);
  const score = Math.max(-100, Math.min(100, Math.round(raw)));
  const label = score >= 25 ? 'bullish' : score <= -25 ? 'bearish' : 'neutral';
  return {
    score,
    label,
    labelZh: label === 'bullish' ? '看多' : label === 'bearish' ? '看空' : '中性/盤整',
    strength: Math.min(100, Math.abs(score)),
    factors: factors.sort((a, b) => Math.abs(b.score) - Math.abs(a.score)),
  };
}

function lastDefined(arr) {
  if (!arr) return null;
  for (let i = arr.length - 1; i >= 0; i--) if (arr[i] != null) return arr[i];
  return null;
}
