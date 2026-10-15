import test from 'node:test';
import assert from 'node:assert/strict';
import { addReady, checkReady } from '../worker/coach-live5.js';

function makeKv() { const m = new Map(); return { async get(k) { return m.get(k) ?? null; }, async put(k, v) { m.set(k, v); } }; }
const k = (t, h, l, c) => ({ time: t, high: h, low: l, close: c });

test('到位劇本即時追蹤：跑掉→回到進場點→到目標，各推一次；打到停損就結束', async () => {
  const env = { SMC_KV: makeKv() }, msgs = [];
  const t0 = Date.UTC(2026, 9, 15, 14, 0);
  await addReady(env, [{ id: 'a', sym: 'PYTHUSDT', iv: '15m', ms: 9e5, side: 'S', en: 0.0825, sl: 0.0892, tp: 0.0784, rr: 0.6 }, { id: 'b', sym: 'ZECUSDT', iv: '15m', ms: 9e5, side: 'L', en: 1097, sl: 1071, tp: 1116, rr: 0.7 }], t0);
  let bars = { PYTHUSDT: [k(t0, 0.0826, 0.0820, 0.0821)], ZECUSDT: [k(t0, 1100, 1095, 1098)] };
  const deps = (now) => ({ fetchKlines: async (e, sym) => bars[sym], postDiscord: async (e, p) => msgs.push(p.content), now });
  await checkReady(env, deps(t0 + 60e3));
  assert.equal(msgs.length, 0, '還在進場點附近，不吵');
  // PYTH 往下跑 0.6R、ZEC 打到停損
  bars = { PYTHUSDT: [k(t0 + 60e3, 0.0822, 0.0784 + 0.0002, 0.0785)], ZECUSDT: [k(t0 + 60e3, 1099, 1070, 1072)] };
  await checkReady(env, deps(t0 + 120e3));
  assert.ok(msgs.some((m) => /PYTH 15m 空單劇本（即時）：跑掉了/.test(m)));
  assert.ok(msgs.some((m) => /ZEC 15m 多單劇本（即時）：⛔ 打到停損/.test(m)));
  // PYTH 回到進場點
  bars = { PYTHUSDT: [k(t0 + 120e3, 0.0826, 0.0800, 0.0826)], ZECUSDT: [k(t0 + 120e3, 1080, 1060, 1065)] };
  const n = msgs.length;
  await checkReady(env, deps(t0 + 180e3));
  assert.match(msgs.at(-1), /回到進場點附近/);
  assert.equal(msgs.length, n + 1, 'ZEC 已經結束，不再推');
  // PYTH 到目標
  bars = { PYTHUSDT: [k(t0 + 180e3, 0.0826, 0.0783, 0.0790)] };
  await checkReady(env, deps(t0 + 240e3));
  assert.match(msgs.at(-1), /✅ 到目標 0\.078400（\+0\.6R）/);
  const r = await checkReady(env, deps(t0 + 300e3));
  assert.equal(r.tracking, 0);
});
