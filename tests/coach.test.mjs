import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { analyze, coachState, coachFollow } from '../src/smc/coach.js';
import worker from '../worker/index.js';

/* dojo/ 裡打包的 Binance BTC 1h 真實 K 棒（壓縮格式）解回 {t,o,h,l,c} */
function decode(o) {
  const d = o.d.split(','), C = [], m = 10 ** o.dec;
  let pc = o.o0, t = o.t0, i = 0;
  while (i < d.length) {
    const tk = d[i];
    if (tk[0] === '~') { t += parseInt(tk.slice(1), 36) * o.dt; i++; continue; }
    const a = parseInt(tk, 36), bh = parseInt(d[i + 1], 36), c = parseInt(d[i + 2], 36), bl = parseInt(d[i + 3], 36);
    i += 4;
    const op = pc + a, cl = op + c;
    C.push({ t, o: op / m, h: (Math.max(op, cl) + bh) / m, l: (Math.min(op, cl) - bl) / m, c: cl / m });
    pc = cl; t += o.dt;
  }
  return C;
}
const BTC = decode(JSON.parse(fs.readFileSync(new URL('../dojo/mdata/BTC_1h.json', import.meta.url))));

test('教練劇本：只用已收盤 K 棒，階段跟欄位一致', () => {
  let ready = 0, formed = 0;
  for (let j = 600; j < 3000; j += 3) {
    const W = BTC.slice(j - 499, j + 1), st = coachState(W, analyze(W, 4, 2), 1);
    for (const r of [st.L, st.S]) {
      assert.ok(r.stage >= 0 && r.stage <= 4);
      if (r.stage >= 1) assert.ok(r.sweep && r.sweep.u < W.length);
      if (r.stage >= 2) { formed++; assert.ok(r.ev && r.ev.i > r.sweep.u); }
      if (r.stage >= 3) assert.ok(r.poi && r.poi.top > r.poi.bot);
      if (r.ready) {
        ready++;
        assert.equal(r.stage, 4);
        assert.ok(r.d * (r.plan.en - r.plan.sl) > 0, '停損在進場價的保護方向');
        assert.ok(r.d * (r.plan.tp - r.plan.en) > 0, '目標在獲利方向');
      }
    }
  }
  assert.ok(formed > 10 && ready > 5, `應該找得到劇本（成形 ${formed}、到位 ${ready}）`);
});

test('劇本後續：到目標／停損／不追的判斷跟之後的 K 棒一致', () => {
  const seen = {};
  for (let j = 600; j < 6000; j += 2) {
    const W = BTC.slice(j - 499, j + 1), A = analyze(W, 4, 2), st = coachState(W, A, 0);
    for (const r of [st.L, st.S]) {
      const f = coachFollow(W, A, r), d = r.d;
      seen[f.status] = (seen[f.status] || 0) + 1;
      assert.ok(f.next && (f.next.ssl == null || f.next.ssl < W.at(-1).c) && (f.next.bsl == null || f.next.bsl > W.at(-1).c), '下一個流動性在現價兩邊');
      if (f.fromDead) { assert.equal(r.stage, 0); assert.ok(['fail', 'tp', 'sl', 'missed'].includes(f.status), f.status); continue; }
      if (r.stage < 3) { assert.equal(f.status, 'wait'); continue; }
      if (!f.plan) continue;
      const { en, sl, tp } = f.plan;
      assert.ok(d * (en - sl) > 0 && d * (tp - en) > 0, '計畫方向正確');
      if (f.status === 'tp') assert.ok(d > 0 ? W[f.at].h >= tp : W[f.at].l <= tp);
      if (f.status === 'sl') assert.ok(d > 0 ? W[f.at].l <= sl : W[f.at].h >= sl);
      if (['near', 'ran', 'deep'].includes(f.status)) {
        for (let u = r.rt; u < W.length; u++) assert.ok(d > 0 ? W[u].l > sl : W[u].h < sl, '還在場內就不該碰過停損');
        assert.equal(f.status, f.cur > 0.5 ? 'ran' : f.cur < -0.5 ? 'deep' : 'near');
      }
      if (f.status === 'pending') assert.equal(r.rt, null);
    }
  }
  for (const s of ['wait', 'pending', 'missed', 'near', 'ran', 'tp', 'sl']) assert.ok(seen[s] > 3, `應該出現 ${s}：${JSON.stringify(seen)}`);
});

/* ---------------------------------------------------------- Worker 教練模式 */

function makeKv() {
  const m = new Map();
  return { store: m, async get(k) { return m.get(k) ?? null; }, async put(k, v) { m.set(k, v); }, async delete(k) { m.delete(k); }, async list({ prefix = '' } = {}) { return { keys: [...m.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })) }; } };
}

/** 找一段「多單或空單劇本已成形」的真實行情，時間平移到現在（最後一根已收盤） */
function scenario() {
  for (let j = 700; j < BTC.length; j++) {
    const W = BTC.slice(j - 499, j + 1), st = coachState(W, analyze(W, 4, 2), 0);
    if (st.L.stage >= 2 || st.S.stage >= 2) {
      const hour = 3_600_000, lastOpen = Math.floor(Date.now() / hour) * hour - hour;
      const shift = lastOpen - W[W.length - 1].t * 1000;
      const rows = [...W, { ...W[W.length - 1] }].map((k, i, a) => ({ ...k, ms: k.t * 1000 + shift + (i === a.length - 1 ? hour : 0) }));
      return rows; // 最後一根是還沒收盤的那根
    }
  }
  throw new Error('找不到劇本');
}

function stubOkx(rows, discord, market) {
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.includes('okx.com/api/v5/market/')) {
      const q = new URL(u).searchParams, after = q.get('after');
      const list = rows.filter((k) => !after || k.ms < Number(after)).slice(-300).reverse()
        .map((k) => [String(k.ms), String(k.o), String(k.h), String(k.l), String(k.c), '1']);
      return new Response(JSON.stringify({ code: '0', data: list }), { status: 200 });
    }
    if (u.includes('discord')) { discord.push(JSON.parse(init.body)); return new Response(null, { status: 204 }); }
    if (u.startsWith('https://example.test/market.json')) return new Response(JSON.stringify(market), { status: 200 });
    if (u.includes('tickers') || u.includes('binance.com') || u.includes('bybit.com')) return new Response(JSON.stringify({ retCode: 0, result: { list: [{ symbol: 'BTCUSDT', lastPrice: '100' }] } }), { status: 200 });
    throw new Error('未預期的請求：' + u);
  };
}

test('SMC_PUSH_MODE=coach：推教練提醒、不推原本的進場區到價，同一個劇本不重複推', async () => {
  const rows = scenario(), discord = [];
  // 就算有一筆計畫剛好到價，教練模式也不推它
  const market = { generatedAt: new Date().toISOString(), interval: '1h', rows: [{ symbol: 'BTCUSDT', interval: '1h', dir: 'long', grade: 'A', score: 90, entry: 100, stop: 95, rr: 3, riskPct: 5, targets: [{ name: 'TP1', price: 115, rr: 3 }], poiType: 'FVG', status: 'waiting', valid: true }] };
  stubOkx(rows, discord, market);
  const env = { MARKET_URL: 'https://example.test/market.json', DISCORD_WEBHOOK_URL: 'https://discord.com/api/webhooks/1/abc', SMC_KV: makeKv(), SMC_PUSH_MODE: 'coach', SMC_SYMBOLS: 'BTCUSDT', SMC_PUSH_INTERVALS: '1h', COACH_BIAS_TF: '1h', COACH_ONLY_ALIGNED: 'false', BREAKOUT_PROVIDERS: 'okx' };
  const res = await (await worker.fetch(new Request('https://w.test/run'), env)).json();
  assert.equal(res.mode, 'coach');
  assert.ok(discord.length >= 1, '應該推出教練提醒');
  for (const p of discord) {
    const e = p.embeds[0];
    assert.match(e.title, /教練提醒｜BTCUSDT 1h (多單|空單)劇本/);
    assert.match(e.description, /掃流動性/);
    assert.doesNotMatch(e.title + e.description, /進場價|止盈 \d/);
  }
  const n = discord.length;
  await worker.fetch(new Request('https://w.test/run'), env);
  assert.equal(discord.length, n, '同一根 K 棒、同一個劇本不會再推一次');
  const rec = await (await worker.fetch(new Request('https://w.test/coach'), env)).json();
  assert.equal(rec.alerts.length, n, '/coach 回傳推過的提醒');
  assert.equal(rec.alerts[0].sym, 'BTCUSDT');
  assert.ok(['L', 'S'].includes(rec.alerts[0].side) && rec.alerts[0].sweep.p > 0);
  assert.equal(rec.alerts[0].entry, undefined, '不給進場價');
});
