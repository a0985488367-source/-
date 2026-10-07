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

test('多空打架：同一帶價位有效計畫一多一空要抓出來；不同價位不算', async () => {
  const { planConflicts } = await import('../src/radar/coin-report.js');
  const c = planConflicts([
    { tf: '15m', dir: 'short', entry: 2620 },
    { tf: '1h', dir: 'long', entry: 2608 },
    { tf: '4h', dir: 'long', entry: 2614.5 },
    { tf: '1d', dir: 'long', entry: 2400 },
  ]);
  assert.equal(c.length, 1);
  assert.deepEqual(c[0].shorts, ['15m']);
  assert.deepEqual(c[0].longs.sort(), ['1h', '4h']);
  assert.ok(c[0].low === 2608 && c[0].high === 2620);
  assert.equal(planConflicts([{ tf: '1h', dir: 'long', entry: 100 }, { tf: '4h', dir: 'short', entry: 110 }]).length, 0);
});

test('整體中性時最值得看的計畫要跟日線／週線同方向（有的話）', () => {
  for (const seed of [3, 7, 11, 19, 23]) {
    const all = makeAll(seed);
    const r = buildCoinReport(all, { daily: all['1d'], h1: all['1h'] });
    if (!r.best || r.agg.label !== 'neutral' || !r.htf?.dir) continue;
    const aligned = r.plans.filter((p) => p.valid && p.dir === r.htf.dir);
    if (aligned.length) assert.equal(r.best.dir, r.htf.dir, `seed ${seed}`);
  }
});

test('下一根收盤時間：一般週期照 UTC 對齊，週線從星期一 00:00 UTC 起算', async () => {
  const { nextCloseTime } = await import('../src/radar/coin-report.js');
  const t = Date.UTC(2026, 9, 7, 10, 22); // 星期三 10:22 UTC
  assert.equal(nextCloseTime('15m', t), Date.UTC(2026, 9, 7, 10, 30));
  assert.equal(nextCloseTime('4h', t), Date.UTC(2026, 9, 7, 12, 0));
  assert.equal(nextCloseTime('1d', t), Date.UTC(2026, 9, 8, 0, 0));
  assert.equal(nextCloseTime('1w', t), Date.UTC(2026, 9, 12, 0, 0)); // 下週一
});

test('兩次重算的差異：偏向變號、計畫換方向、最值得看換掉都要列出來', async () => {
  const { diffReports } = await import('../src/radar/coin-report.js');
  const tf = (interval, score, setup, sweeps = []) => ({ interval, bias: { score }, setup, liquidity: { sweeps } });
  const prev = {
    agg: { label: 'neutral', score: -12 }, best: { tf: '15m', dir: 'short' }, conflicts: [],
    tfs: [tf('15m', -70, { dir: 'short', entry: 2620, valid: true }), tf('1h', 5, { none: true })],
  };
  const next = {
    agg: { label: 'neutral', score: -11 }, best: { tf: '2h', dir: 'long' }, conflicts: [{ low: 2595, high: 2620, longs: ['1h'], shorts: ['15m'] }],
    tfs: [tf('15m', 20, { dir: 'long', entry: 2600, valid: true }), tf('1h', -30, { dir: 'long', entry: 2595, valid: true }, [{ time: 9, side: 'sellside', level: 2590 }])],
  };
  const zh = diffReports(prev, next).map((d) => d.zh).join('\n');
  assert.match(zh, /15m 偏空 → 偏多/);
  assert.match(zh, /15m 計畫換方向/);
  assert.match(zh, /1h 出現新計畫/);
  assert.match(zh, /1h 新的獵取/);
  assert.match(zh, /最值得看 15m 做空 → 2h 做多/);
  assert.match(zh, /新的多空打架/);
  assert.deepEqual(diffReports(next, next), []);
});
