import test from 'node:test';
import assert from 'node:assert/strict';

import { detectSwings, alternateSwings, labelSwings, dealingRange, structuredSwings } from '../src/smc/swings.js';
import { analyzeStructure, dualStructure } from '../src/smc/structure.js';
import { detectFVG } from '../src/smc/fvg.js';
import { detectOrderBlocks } from '../src/smc/orderblocks.js';
import { liquidityPools, detectSweeps, liquidityBias } from '../src/smc/liquidity.js';
import { premiumDiscount, oteZone, fibLevels, stackConfluence } from '../src/smc/zones.js';
import { keyLevels, resample, sessionOf } from '../src/smc/sessions.js';
import { analyze } from '../src/smc/engine.js';
import { positionSize } from '../src/smc/setups.js';
import { aggregateBias, tfSuite } from '../src/smc/mtf.js';
import { summarize } from '../src/smc/backtest.js';
import { atr, ema, rsi, volumeProfile } from '../src/core/indicators.js';
import { generateDemoCandles } from '../src/data/providers.js';
import { mkCandles, fromCloses, zigzag } from './helpers.mjs';

/* ------------------------------------------------------------- 擺動點 */

test('detectSwings 找出對稱分形高低點', () => {
  const c = mkCandles([
    [10, 11, 9, 10], [10, 12, 10, 11], [11, 15, 11, 14],  // index 2 = swing high
    [14, 13, 11, 12], [12, 12, 8, 9],                     // index 4 = swing low
    [9, 11, 9, 10], [10, 12, 10, 11],
  ]);
  const swings = detectSwings(c, 2);
  const high = swings.find((s) => s.type === 'high');
  const low = swings.find((s) => s.type === 'low');
  assert.equal(high.index, 2);
  assert.equal(high.price, 15);
  assert.equal(low.index, 4);
  assert.equal(low.price, 8);
});

test('alternateSwings 強制高低交替並保留極值', () => {
  const swings = [
    { index: 1, type: 'high', price: 10, time: 1 },
    { index: 2, type: 'high', price: 12, time: 2 },
    { index: 3, type: 'low', price: 5, time: 3 },
    { index: 4, type: 'low', price: 4, time: 4 },
  ];
  const out = alternateSwings(swings);
  assert.equal(out.length, 2);
  assert.equal(out[0].price, 12);
  assert.equal(out[1].price, 4);
});

test('labelSwings 標記 HH/HL/LH/LL', () => {
  const labelled = labelSwings([
    { index: 0, type: 'low', price: 10 }, { index: 1, type: 'high', price: 20 },
    { index: 2, type: 'low', price: 14 }, { index: 3, type: 'high', price: 25 },
    { index: 4, type: 'low', price: 12 }, { index: 5, type: 'high', price: 22 },
  ]);
  assert.equal(labelled[2].label, 'HL');
  assert.equal(labelled[3].label, 'HH');
  assert.equal(labelled[4].label, 'LL');
  assert.equal(labelled[5].label, 'LH');
});

/* --------------------------------------------------------------- 結構 */

test('上升走勢產生 BOS，反轉時產生 CHoCH', () => {
  const candles = zigzag([120, 108, 140, 125, 150, 118, 95], 8, 100);
  const st = analyzeStructure(candles, { strength: 2, scale: 'swing' });
  const types = st.events.map((e) => `${e.type}:${e.dir}`);
  assert.ok(st.events.length >= 2, '應偵測到多個結構事件');
  assert.ok(types.some((t) => t === 'BOS:bull'), '上升腿應出現看多 BOS');
  assert.ok(types.some((t) => t.startsWith('CHoCH')), '反轉時應出現 CHoCH');
});

test('CHoCH 一定發生在趨勢方向改變時', () => {
  const candles = zigzag([130, 110, 160, 130, 170, 100], 10, 100);
  const st = analyzeStructure(candles, { strength: 2 });
  let trend = 0;
  for (const e of st.events) {
    const dir = e.dir === 'bull' ? 1 : -1;
    if (trend !== 0 && dir !== trend) assert.equal(e.type, 'CHoCH', '逆勢突破必須標記為 CHoCH');
    if (trend !== 0 && dir === trend) assert.equal(e.type, 'BOS', '順勢突破必須標記為 BOS');
    trend = dir;
  }
});

test('dualStructure 同時回傳內部與擺動結構', () => {
  const candles = zigzag([120, 108, 140, 125, 150], 9, 100);
  const d = dualStructure(candles, { internalStrength: 2, swingStrength: 5 });
  assert.equal(d.internal.scale, 'internal');
  assert.equal(d.swing.scale, 'swing');
  assert.ok(d.internal.events.length >= d.swing.events.length);
});

/* ----------------------------------------------------------------- FVG */

test('detectFVG 偵測多方與空方缺口並追蹤填補', () => {
  const base = fromCloses(Array.from({ length: 20 }, (_, i) => 100 + i * 0.05));
  const candles = [...base,
    { time: base.at(-1).time + 900000, open: 101, high: 102, low: 100.5, close: 101.8, volume: 100 },
    { time: base.at(-1).time + 1800000, open: 102, high: 108, low: 101.9, close: 107.5, volume: 300 },
    { time: base.at(-1).time + 2700000, open: 107.5, high: 110, low: 106, close: 109, volume: 200 },
  ];
  const gaps = detectFVG(candles, { minSizeAtr: 0.01, includeVolumeImbalance: false });
  const bulls = gaps.filter((g) => g.dir === 'bull');
  assert.ok(bulls.length >= 1, '應偵測到多方 FVG');
  const bull = bulls.at(-1); // 取最後一個：由位移 K 棒造成的 102–106 缺口
  assert.equal(bull.bottom, 102);
  assert.equal(bull.top, 106);
  assert.equal(bull.mid, 104);
  assert.equal(bull.state, 'fresh');
});

test('FVG 被穿越後狀態轉為 inverted', () => {
  const seed = fromCloses(Array.from({ length: 16 }, () => 100));
  const t0 = seed.at(-1).time;
  const candles = [...seed,
    { time: t0 + 900000, open: 100, high: 101, low: 99.5, close: 100.5, volume: 100 },
    { time: t0 + 1800000, open: 100.5, high: 106, low: 100.4, close: 105.5, volume: 400 },
    { time: t0 + 2700000, open: 105.5, high: 107, low: 103, close: 104, volume: 200 },
    { time: t0 + 3600000, open: 104, high: 104.5, low: 98, close: 98.5, volume: 500 },
  ];
  const gaps = detectFVG(candles, { minSizeAtr: 0.01, includeVolumeImbalance: false });
  const g = gaps.find((x) => x.dir === 'bull');
  assert.equal(g.state, 'inverted');
  assert.equal(g.invertedDir, 'bear');
});

/* --------------------------------------------------------- Order Block */

test('detectOrderBlocks 找出突破前最後一根反向 K 棒', () => {
  const candles = zigzag([118, 106, 150], 10, 100);
  const st = analyzeStructure(candles, { strength: 2 });
  const obs = detectOrderBlocks(candles, st.events, { minDisplacementAtr: 0.2 });
  assert.ok(obs.length > 0, '應至少找到一個 OB');
  for (const ob of obs) {
    assert.ok(ob.top > ob.bottom, 'OB 區間必須有效');
    assert.ok(ob.score >= 0 && ob.score <= 100);
    assert.ok(['fresh', 'tapped', 'mitigated', 'breaker'].includes(ob.state));
    const c = candles[ob.index];
    if (ob.dir === 'bull') assert.ok(c.close < c.open, '看多 OB 必須是下跌 K 棒');
    else assert.ok(c.close > c.open, '看空 OB 必須是上漲 K 棒');
  }
});

/* ----------------------------------------------------------- 流動性 */

test('liquidityPools 將等高群聚為同一個流動性池', () => {
  const swings = [
    { index: 10, type: 'high', price: 100, time: 1 },
    { index: 30, type: 'high', price: 100.05, time: 2 },
    { index: 50, type: 'low', price: 90, time: 3 },
  ];
  const candles = fromCloses(Array.from({ length: 60 }, () => 95));
  const pools = liquidityPools(candles, swings, { tolAtr: 5 });
  const bs = pools.filter((p) => p.side === 'buyside');
  assert.equal(bs.length, 1);
  assert.equal(bs[0].touches, 2);
  assert.equal(bs[0].equal, true);
});

test('detectSweeps 偵測影線穿越但收盤收回', () => {
  const candles = mkCandles([
    [100, 101, 99, 100], [100, 105, 100, 104], [104, 106, 103, 105],
    [105, 104, 100, 101], [101, 102, 99, 100],
    [100, 112, 99, 101],  // index 5：掃過 index 2 的高點 106 後收回
    [101, 102, 98, 99],
  ]);
  const swings = detectSwings(candles, 2);
  const sweeps = detectSweeps(candles, swings, { minWickAtr: 0 });
  assert.ok(sweeps.length >= 1);
  assert.equal(sweeps[0].side, 'buyside');
  assert.equal(sweeps[0].dir, 'bear');
});

test('liquidityBias 依上下方流動性給出吸引方向', () => {
  const pools = [
    { side: 'buyside', price: 110, swept: false, strength: 80 },
    { side: 'buyside', price: 112, swept: false, strength: 70 },
    { side: 'sellside', price: 80, swept: false, strength: 30 },
  ];
  const b = liquidityBias(pools, 100);
  assert.equal(b.bias, 'buyside');
  assert.ok(b.upPct > b.downPct);
});

/* ------------------------------------------------------------ 折溢價 */

test('premiumDiscount 正確分類區間位置', () => {
  const range = { high: 200, low: 100, direction: 'up' };
  assert.equal(premiumDiscount(range, 180).zone, 'premium');
  assert.equal(premiumDiscount(range, 120).zone, 'discount');
  assert.equal(premiumDiscount(range, 150).zone, 'equilibrium');
  assert.equal(premiumDiscount(range, 120).favors, 'long');
  assert.equal(premiumDiscount(range, 150).ratio, 0.5);
});

test('oteZone 落在 0.618–0.79 回撤之間', () => {
  const ote = oteZone({ high: 200, low: 100, direction: 'up' });
  assert.equal(ote.dir, 'long');
  assert.ok(Math.abs(ote.top - 138.2) < 1e-9);
  assert.ok(Math.abs(ote.bottom - 121) < 1e-9);
  assert.ok(ote.sweet < ote.top && ote.sweet > ote.bottom);
});

test('fibLevels 依方向產生完整等級', () => {
  const levels = fibLevels({ high: 200, low: 100, direction: 'up' });
  assert.equal(levels.length, 8);
  assert.equal(levels.find((l) => l.level === 0.5).price, 150);
});

test('stackConfluence 合併重疊的 POI', () => {
  const stacks = stackConfluence([
    { dir: 'bull', top: 101, bottom: 100, mid: 100.5, score: 60 },
    { dir: 'bull', top: 100.8, bottom: 99.9, mid: 100.35, score: 55 },
    { dir: 'bear', top: 120, bottom: 119, mid: 119.5, score: 70 },
  ], 0.5);
  assert.equal(stacks.length, 2);
  const merged = stacks.find((s) => s.dir === 'bull');
  assert.equal(merged.members.length, 2);
});

/* ------------------------------------------------------------- 時段 */

test('sessionOf 依 UTC 時間判斷殺區', () => {
  assert.equal(sessionOf(Date.UTC(2024, 0, 1, 8)).id, 'london');
  assert.equal(sessionOf(Date.UTC(2024, 0, 1, 11)), null);
  assert.equal(sessionOf(Date.UTC(2024, 0, 1, 13)).id, 'nyam');
  assert.equal(sessionOf(Date.UTC(2024, 0, 1, 2)).id, 'asia');
});

test('keyLevels 由日 K 推導 PDH/PDL', () => {
  const day1 = Array.from({ length: 8 }, (_, i) => ({
    time: Date.UTC(2024, 0, 1, i * 3), open: 100, high: 110 + i, low: 90 - i, close: 105, volume: 10,
  }));
  const day2 = Array.from({ length: 8 }, (_, i) => ({
    time: Date.UTC(2024, 0, 2, i * 3), open: 105, high: 108, low: 95, close: 106, volume: 10,
  }));
  const levels = keyLevels([...day1, ...day2]);
  const pdh = levels.find((l) => l.code === 'PDH');
  const pdl = levels.find((l) => l.code === 'PDL');
  assert.equal(pdh.price, 117);
  assert.equal(pdl.price, 83);
});

test('resample 彙整為較大週期', () => {
  const c = Array.from({ length: 6 }, (_, i) => ({
    time: Date.UTC(2024, 0, 1, i * 4), open: 100 + i, high: 110 + i, low: 90 - i, close: 105 + i, volume: 5,
  }));
  const daily = resample(c, (ts) => {
    const d = new Date(ts);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  });
  assert.equal(daily.length, 1);
  assert.equal(daily[0].open, 100);
  assert.equal(daily[0].close, 110);
  assert.equal(daily[0].volume, 30);
});

/* ------------------------------------------------------------ 指標 */

test('EMA / ATR / RSI 產生合理數值', () => {
  const candles = fromCloses(Array.from({ length: 60 }, (_, i) => 100 + i));
  const e = ema(candles.map((c) => c.close), 10);
  assert.equal(e.slice(0, 9).every((v) => v === null), true);
  assert.ok(e.at(-1) > 140 && e.at(-1) < 160);
  const a = atr(candles, 14);
  assert.ok(a.at(-1) > 0);
  const r = rsi(candles, 14);
  assert.ok(r.at(-1) > 90, '持續上漲時 RSI 應接近 100');
});

test('volumeProfile 回傳 POC 與價值區', () => {
  const candles = fromCloses([100, 101, 100.5, 100.2, 100.8, 105, 110, 100.4, 100.6]);
  const vp = volumeProfile(candles, { bins: 20 });
  assert.ok(vp.poc >= vp.low && vp.poc <= vp.high);
  assert.ok(vp.vah >= vp.val);
});

/* ------------------------------------------------------------ 引擎 */

test('analyze 對真實形態資料輸出完整結構', () => {
  const candles = generateDemoCandles('BTCUSDT', '15m', 600);
  const a = analyze(candles);
  assert.equal(a.empty, undefined);
  assert.ok(a.price > 0);
  assert.ok(a.swings.length > 3);
  assert.ok(a.structure.swing.events.length > 0);
  assert.ok(Array.isArray(a.pois));
  assert.ok(a.bias.score >= -100 && a.bias.score <= 100);
  assert.ok(['bullish', 'bearish', 'neutral'].includes(a.bias.label));
  assert.ok(a.pd === null || (a.pd.ratio >= -1 && a.pd.ratio <= 2));
});

test('analyze 資料不足時安全回傳 empty', () => {
  const a = analyze(fromCloses([100, 101, 102]));
  assert.equal(a.empty, true);
});

test('交易計畫的停損永遠在進場的正確一側，且 R:R 遞增', () => {
  for (const sym of ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT']) {
    const a = analyze(generateDemoCandles(sym, '15m', 600));
    const s = a.setup;
    if (!s || s.none) continue;
    if (s.dir === 'long') {
      assert.ok(s.stop < s.entry, `${sym}: 多單停損應低於進場`);
      s.targets.forEach((t) => assert.ok(t.price > s.entry, `${sym}: 多單目標應高於進場`));
    } else {
      assert.ok(s.stop > s.entry, `${sym}: 空單停損應高於進場`);
      s.targets.forEach((t) => assert.ok(t.price < s.entry, `${sym}: 空單目標應低於進場`));
    }
    const rrs = s.targets.map((t) => t.rr);
    assert.deepEqual(rrs, [...rrs].sort((x, y) => x - y), `${sym}: 目標應依 R:R 遞增`);
    assert.ok(s.score >= 0 && s.score <= 100);
    assert.equal(s.checklist.length, 10);
  }
});

test('引擎為純函式：相同輸入得到相同輸出', () => {
  const candles = generateDemoCandles('ETHUSDT', '1h', 400);
  const a = analyze(candles);
  const b = analyze(candles);
  assert.equal(JSON.stringify(a.bias), JSON.stringify(b.bias));
  assert.equal(a.orderBlocks.length, b.orderBlocks.length);
  assert.equal(a.gaps.length, b.gaps.length);
});

test('分析不會讀取未來資料（切片前綴一致）', () => {
  const candles = generateDemoCandles('BTCUSDT', '15m', 500);
  const cut = 380;
  const full = analyze(candles);
  const partial = analyze(candles.slice(0, cut));
  const evFull = full.structure.swing.events.filter((e) => e.breakIndex < cut - 20).map((e) => e.id);
  const evPart = partial.structure.swing.events.filter((e) => e.breakIndex < cut - 20).map((e) => e.id);
  assert.deepEqual(evPart, evFull, '過去的結構事件不應因未來資料而改變');
});

/* ------------------------------------------------------------ 部位/MTF */

test('positionSize 依風險％計算部位', () => {
  const p = positionSize({ accountSize: 10000, riskPct: 1, entry: 100, stop: 95, leverage: 10 });
  assert.equal(p.riskAmount, 100);
  assert.equal(p.qty, 20);
  assert.equal(p.notional, 2000);
  assert.equal(p.marginRequired, 200);
});

test('aggregateBias 以週期權重加權', () => {
  const agg = aggregateBias([
    { interval: '15m', bias: { score: -40, label: 'bearish' } },
    { interval: '1d', bias: { score: 60, label: 'bullish' } },
  ]);
  assert.ok(agg.score > 0, '日線權重較高，總分應偏多');
  assert.equal(agg.bulls, 1);
  assert.equal(agg.bears, 1);
  assert.equal(agg.alignment, 50);
});

test('tfSuite 推薦合理的高低週期組合', () => {
  const s = tfSuite('15m');
  assert.equal(s.mtf, '15m');
  assert.equal(s.htf, '4h');
  assert.equal(s.ltf, '5m');
});

test('summarize 正確統計勝率與期望值', () => {
  const trades = [{ r: 2, exitTime: 1 }, { r: -1, exitTime: 2 }, { r: 3, exitTime: 3 }, { r: -1, exitTime: 4 }]
    .map((t) => ({ ...t, dir: 'long', grade: 'A', bars: 10 }));
  const s = summarize(trades);
  assert.equal(s.count, 4);
  assert.equal(s.wins, 2);
  assert.equal(s.winRate, 50);
  assert.equal(s.totalR, 3);
  assert.equal(s.expectancy, 0.75);
  assert.equal(s.profitFactor, 2.5);
});
