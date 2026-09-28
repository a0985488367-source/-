import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeoutEvents, fakeoutSignal, htfLevels, FAKEOUT_DEFAULTS } from '../src/strategies/fakeout.js';
import { atr } from '../src/core/indicators.js';

const H4 = 4 * 3_600_000;

function randomWalk(n, seed = 11) {
  let s = seed;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647) - 0.5;
  let p = 100;
  return Array.from({ length: n }, (_, i) => {
    const o = p;
    p = Math.max(1, p * (1 + rnd() * 0.03));
    return { time: i * H4, open: o, high: Math.max(o, p) * (1 + Math.abs(rnd()) * 0.01), low: Math.min(o, p) * (1 - Math.abs(rnd()) * 0.01), close: p, volume: 1 };
  });
}

test('fakeoutSignal（線上只看到最後一根）跟整段跑出來的 MSS 事件完全一致', () => {
  const c = randomWalk(1500);
  const a = atr(c, 14);
  const full = fakeoutEvents(c, { from: 210 }).filter((e) => e.type === 'mss');
  const expected = new Map(full
    .filter((e) => (e.rdir === 'long' ? c[e.index].close - e.stop : e.stop - c[e.index].close) > FAKEOUT_DEFAULTS.minRiskAtr * a[e.index])
    .map((e) => [e.index, e]));
  let hits = 0;
  for (let i = 260; i < c.length; i++) {
    const s = fakeoutSignal(c.slice(0, i + 1), { from: 210 });
    const e = expected.get(i);
    assert.equal(s?.dir ?? null, e?.rdir ?? null, `第 ${i} 根`);
    if (s) {
      hits++;
      assert.ok(Math.abs(s.stopPrice - e.stop) < 1e-9);
      // 反手做空：停損在假突破最高點上面；做多反過來
      if (s.dir === 'short') assert.ok(s.stopPrice > s.extreme && s.stopPrice > s.close);
      else assert.ok(s.stopPrice < s.extreme && s.stopPrice < s.close);
      assert.equal(s.breakoutDir, s.dir === 'short' ? 'long' : 'short');
    }
  }
  assert.ok(hits > 5, `隨機資料要有足夠的假突破（${hits}）`);
});

test('htfLevels：1h 每一根只看得到「確認那根 4h 已經收盤」的結構點；HTF 模式跑得出事件', () => {
  const H1 = 3_600_000;
  const small = randomWalk(4000, 21).map((k, i) => ({ ...k, time: i * H1 }));
  // 用 1h 組出 4h（跟交易所的 4h 一樣從整點對齊）
  const big = [];
  for (let i = 0; i + 4 <= small.length; i += 4) {
    const s = small.slice(i, i + 4);
    big.push({ time: s[0].time, open: s[0].open, high: Math.max(...s.map((x) => x.high)), low: Math.min(...s.map((x) => x.low)), close: s[3].close, volume: 4 });
  }
  const { sHigh, sLow } = htfLevels(small, big, 5);
  let seen = 0;
  for (let j = 0; j < small.length; j++) {
    for (const lv of [sHigh[j], sLow[j]]) {
      if (!lv) continue;
      seen++;
      assert.ok(lv.confirmClose <= small[j].time + H1, `第 ${j} 根看到了還沒確認的點`);
      assert.ok(lv.index < j, '關卡的起點要在這根之前');
    }
  }
  assert.ok(seen > 1000);
  const ev = fakeoutEvents(small, { mode: 'HTF', from: 210 }, { levels: { sHigh, sLow } });
  assert.ok(ev.some((e) => e.type === 'mss'));
});

test('fakeoutEvents：每個被追蹤的突破最多只有一個結果（延續或 MSS），而且都在 window 根內', () => {
  const c = randomWalk(2000, 5);
  const ev = fakeoutEvents(c, { from: 210 });
  const byB = new Map();
  for (const e of ev) if (e.type !== 'breakout') byB.set(e.b, (byB.get(e.b) ?? 0) + 1);
  assert.ok([...byB.values()].every((v) => v === 1));
  for (const e of ev) if (e.type !== 'breakout') assert.ok(e.index > e.b && e.index <= e.b + FAKEOUT_DEFAULTS.window);
  assert.ok(ev.some((e) => e.type === 'cont') && ev.some((e) => e.type === 'mss'));
});
