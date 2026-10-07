import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCoinReport, liquidationClusters, REPORT_TFS } from '../src/radar/coin-report.js';

const MS = { '15m': 9e5, '30m': 18e5, '1h': 36e5, '2h': 72e5, '4h': 144e5, '6h': 216e5, '1d': 864e5, '1w': 6048e5 };

/** 固定種子的 1h 隨機漫步，合成 15m（拆四根）以外的各週期 */
function makeAll(seed = 7) {
  let s = seed >>> 0;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
  const start = Date.UTC(2025, 0, 6); // 星期一，週線對齊
  const h1 = [];
  let price = 100, drift = 0;
  for (let i = 0; i < 24 * 7 * 80; i++) {
    if (i % 300 === 0) drift = (rnd() - 0.5) * 0.004;
    const open = price;
    const close = open * (1 + drift + (rnd() - 0.5) * 0.012);
    h1.push({ time: start + i * MS['1h'], open, high: Math.max(open, close) * (1 + rnd() * 0.006), low: Math.min(open, close) * (1 - rnd() * 0.006), close, volume: 1000 + rnd() * 9000 });
    price = close;
  }
  const agg = (ms, from = h1) => {
    const out = [];
    for (const c of from) {
      const t = ms === MS['1w'] ? Math.floor((c.time - 4 * 864e5) / ms) * ms + 4 * 864e5 : Math.floor(c.time / ms) * ms;
      const last = out[out.length - 1];
      if (!last || last.time !== t) out.push({ ...c, time: t });
      else { last.high = Math.max(last.high, c.high); last.low = Math.min(last.low, c.low); last.close = c.close; last.volume += c.volume; }
    }
    return out;
  };
  const m15 = h1.slice(-600).flatMap((c) => [0, 1, 2, 3].map((k) => {
    const o = c.open + ((c.close - c.open) * k) / 4;
    const cl = c.open + ((c.close - c.open) * (k + 1)) / 4;
    return { time: c.time + k * MS['15m'], open: o, close: cl, high: Math.max(o, cl) + (c.high - Math.max(c.open, c.close)) / 2, low: Math.min(o, cl) - (Math.min(c.open, c.close) - c.low) / 2, volume: c.volume / 4 };
  }));
  return { '15m': m15, '30m': agg(MS['30m'], m15), '1h': h1, '2h': agg(MS['2h']), '4h': agg(MS['4h']), '6h': agg(MS['6h']), '1d': agg(MS['1d']), '1w': agg(MS['1w']) };
}

test('全週期報告：每個週期都有偏向、流動性、計畫；總結的方向和最值得看的週期合理', () => {
  const all = makeAll();
  const r = buildCoinReport(all, { daily: all['1d'], h1: all['1h'] });
  assert.ok(!r.empty);
  assert.deepEqual(r.tfs.map((t) => t.interval), REPORT_TFS);
  const price = r.price;
  for (const t of r.tfs) {
    assert.ok(Number.isFinite(t.bias.score), t.interval);
    for (const p of t.liquidity.above) assert.ok(p.price > t.price, `${t.interval} 上方流動性在現價上面`);
    for (const p of t.liquidity.below) assert.ok(p.price < t.price, `${t.interval} 下方流動性在現價下面`);
    if (!t.setup.none) {
      const long = t.setup.dir === 'long';
      assert.ok(long ? t.setup.stop < t.setup.entry : t.setup.stop > t.setup.entry, `${t.interval} 停損方向`);
      for (const tg of t.setup.targets) assert.ok(long ? tg.price > t.setup.entry : tg.price < t.setup.entry, `${t.interval} 目標方向`);
    } else assert.ok(t.setup.reasonZh);
    assert.ok(t.trend == null || ['breakout', 'ema', 'macd', 'vol', 'st', 'gc'].every((k) => k in t.trend.last));
  }
  for (const x of r.liqAbove) assert.ok(x.price > price && x.tfs.length >= 1);
  for (const x of r.liqBelow) assert.ok(x.price < price);
  assert.ok(r.liqAbove.every((x, i) => i === 0 || x.price >= r.liqAbove[i - 1].price), '上方由近到遠');
  assert.ok(['bullish', 'bearish', 'neutral'].includes(r.agg.label));
  if (r.best) assert.ok(r.best.valid && r.plans.some((p) => p.tf === r.best.tf));
  assert.ok(r.levels.some((l) => l.code === 'PDH') && r.levels.some((l) => l.code === 'PWL'));
  assert.ok(r.narrative.length >= 2 && r.narrative.every((s) => typeof s === 'string' && s.length > 5));
});

test('爆倉估算：多單強平在現價下方、空單在上方；已經被走過的強平價不算', () => {
  const xs = [];
  for (let i = 0; i < 100; i++) xs.push({ time: i * 36e5, open: 100, high: 100.8, low: 99.2, close: 100, volume: 1000 });
  const r = liquidationClusters(xs, 100);
  assert.ok(r.longs.length && r.shorts.length);
  for (const x of r.longs) assert.ok(x.price < 100);
  for (const x of r.shorts) assert.ok(x.price > 100);
  // 100 倍的強平（約 ±0.5%）已經被每根 K 棒的高低點（±0.8%）走過 → 不該出現在 99.2～100.8 之間
  for (const x of [...r.longs, ...r.shorts]) assert.ok(x.price < 99.2 || x.price > 100.8, JSON.stringify(x));
});
