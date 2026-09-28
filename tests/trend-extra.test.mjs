import test from 'node:test';
import assert from 'node:assert/strict';
import { trendExtraSignal, trendExtraIndicators, TREND_EXTRA_STOP_ATR } from '../src/strategies/trend-extra.js';
import { prepare, ZOO } from '../scripts/research/strategy-zoo.mjs';

function randomWalk(n, seed = 7) {
  let s = seed;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647) - 0.5;
  let p = 100;
  return Array.from({ length: n }, (_, i) => {
    const o = p;
    p = Math.max(1, p * (1 + rnd() * 0.03));
    return {
      time: i * 21_600_000, open: o, close: p,
      high: Math.max(o, p) * (1 + Math.abs(rnd()) * 0.01), low: Math.min(o, p) * (1 - Math.abs(rnd()) * 0.01),
      volume: 100 * (1 + Math.abs(rnd()) * (i % 17 === 0 ? 8 : 1)),
    };
  });
}

const ZOO_NAME = { vol: 'VOL_BREAK', st: 'SUPERTREND', gc: 'GOLDEN_CROSS' };

for (const [key, zooName] of Object.entries(ZOO_NAME)) {
  test(`${zooName}：線上判斷（trend-extra.js）跟回測（strategy-zoo）每一根都一樣`, () => {
    const c = randomWalk(3000, key.length * 13);
    const x = prepare(c);
    const pre = trendExtraIndicators(c);
    let hits = 0;
    for (let i = 210; i < c.length; i++) {
      const want = ZOO[zooName](x, i);
      const got = trendExtraSignal(key, c, i, pre);
      assert.equal(got?.dir ?? null, want?.dir ?? null, `第 ${i} 根`);
      if (got) {
        hits++;
        assert.equal(TREND_EXTRA_STOP_ATR[key], want.stopAtr);
        assert.ok(Math.abs(got.stopDistance - x.a[i] * want.stopAtr) < 1e-9);
      }
    }
    assert.ok(hits > 3, `隨機資料要有足夠的訊號（${hits}）`);
  });
}

test('trendExtraSignal：只給到第 i 根（線上的情況）跟整段算出來的一樣', () => {
  const c = randomWalk(1200, 3);
  const pre = trendExtraIndicators(c);
  for (const key of ['vol', 'st', 'gc']) {
    for (let i = 300; i < c.length; i += 7) {
      assert.equal(trendExtraSignal(key, c.slice(0, i + 1))?.dir ?? null, trendExtraSignal(key, c, i, pre)?.dir ?? null, `${key} 第 ${i} 根`);
    }
  }
});
