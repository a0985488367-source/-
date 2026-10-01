import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMtfPlan } from '../src/smc/mtf-plan.js';

const M15 = 900_000;

/** 固定種子的 15m 隨機漫步（有趨勢段、盤整段），再合成 1h／4h／日線 */
function makeTf(seed, bars = 24 * 4 * 200) {
  let s = seed >>> 0;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
  let price = 100 + rnd() * 900;
  let drift = 0;
  const start = Date.UTC(2026, 0, 1);
  const m15 = [];
  for (let i = 0; i < bars; i++) {
    if (i % 400 === 0) drift = (rnd() - 0.5) * 0.0012;
    const vol = 0.0015 + rnd() * 0.004;
    const open = price;
    const close = open * (1 + drift + (rnd() - 0.5) * vol * 2);
    m15.push({ time: start + i * M15, open, high: Math.max(open, close) * (1 + rnd() * vol), low: Math.min(open, close) * (1 - rnd() * vol), close, volume: 1000 + rnd() * 9000 });
    price = close;
  }
  const agg = (ms) => {
    const out = [];
    for (const c of m15) {
      const t = Math.floor(c.time / ms) * ms;
      const last = out[out.length - 1];
      if (!last || last.time !== t) out.push({ ...c, time: t });
      else { last.high = Math.max(last.high, c.high); last.low = Math.min(last.low, c.low); last.close = c.close; last.volume += c.volume; }
    }
    return out;
  };
  return { m15, h1: agg(3_600_000), h4: agg(14_400_000), d1: agg(86_400_000) };
}

/** 到某個時間點為止「已收盤」的各週期 K 棒（跟回測、線上一樣不偷看未來） */
function upTo(tf, t) {
  const cut = (list, ms, n) => list.filter((c) => c.time + ms <= t).slice(-n);
  return { d1: cut(tf.d1, 86_400_000, 400), h4: cut(tf.h4, 14_400_000, 500), h1: cut(tf.h1, 3_600_000, 500), m15: cut(tf.m15, M15, 400) };
}

test('資料不夠就沒有計畫，並說明原因', () => {
  const p = buildMtfPlan({ d1: [], h4: [], h1: [], m15: [] });
  assert.equal(p.none, true);
  assert.equal(p.stage, 'data');
});

test('多週期計畫的基本規則：多單停損在進場下方、目標在上方；空單相反；有效計畫四個關卡都要過', () => {
  let valid = 0, none = 0, total = 0, invalid = 0;
  const stages = {};
  for (let seed = 1; seed <= 12; seed++) {
    const tf = makeTf(seed * 7919);
    const end = tf.m15[tf.m15.length - 1].time;
    for (let k = 0; k < 40; k++) {
      total++;
      const t = end - k * 36 * 3_600_000;
      const p = buildMtfPlan(upTo(tf, t));
      if (p.none) { none++; stages[p.stage] = (stages[p.stage] ?? 0) + 1; assert.ok(p.reasonZh); continue; }
      const long = p.dir === 'long';
      assert.ok(long ? p.stop < p.entry : p.stop > p.entry, `停損方向 ${JSON.stringify({ dir: p.dir, entry: p.entry, stop: p.stop })}`);
      for (const tg of p.targets) assert.ok(long ? tg.price > p.entry : tg.price < p.entry, '目標在進場價的有利方向');
      assert.ok(p.targets.every((tg, i) => i === 0 || tg.rr >= p.targets[i - 1].rr), '目標由近到遠');
      assert.ok(['limit', 'market'].includes(p.entryType));
      if (!p.valid) invalid++;
      if (p.valid) {
        valid++;
        assert.ok(p.checklist.filter((c) => c.gate).every((c) => c.ok));
        assert.ok(p.rrFinal >= 2);
        // 四層都同向：1h、15m 最近的結構突破都跟日線同方向；PO3／MMXM 只是加分
        assert.ok(p.structure.h1 && p.structure.m15);
        if (p.po3.po3) assert.ok(long ? p.po3.extreme < p.po3.accumulation.low : p.po3.extreme > p.po3.accumulation.high);
        assert.equal(p.checklist.find((c) => c.key === 'po3').ok, !!p.po3.po3);
        // 去重：同一個 4h 區只有一個 id；轉向是不是發生在碰到進場區之後
        assert.ok(p.id.startsWith(`${p.dir}:${p.poi.type}:`) && p.touchId !== p.id);
        assert.equal(typeof p.fresh.h1, 'boolean');
        assert.equal(typeof p.fresh.m15, 'boolean');
      }
      assert.ok(p.htf.profile, '日線固定範圍成交量分布有算出來');
    }
  }
  // 確認不是全部都卡在同一關：各關卡都會擋掉一些，也要真的有算出計畫
  assert.ok(none > 0, JSON.stringify(stages));
  assert.ok(Object.keys(stages).length >= 2, JSON.stringify(stages));
  assert.equal(valid + invalid + none, total);
  assert.ok(valid > 0, `隨機資料裡也要找得到有效計畫：${JSON.stringify({ valid, invalid, none, stages })}`);
});
