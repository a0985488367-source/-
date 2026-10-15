import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { analyze, coachState } from '../src/smc/coach.js';
import { appTokenOk, loadCoachLive, saveCoachLive, trackCoachLive, resolveLive, coachLiveResponse, handleWatch, checkWatches, journalResponse } from '../worker/coach-extras.js';

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
function makeKv() {
  const m = new Map();
  return { store: m, async get(k) { return m.get(k) ?? null; }, async put(k, v) { m.set(k, v); }, async delete(k) { m.delete(k); } };
}

test('App 密碼：接受 APP_TOKEN／AI_TOKEN／AUTO_TRADE_TOKEN 其中一個', () => {
  const env = { AI_TOKEN: 'abc123' };
  assert.equal(appTokenOk(new Request('https://w/journal', { headers: { 'x-app-token': 'abc123' } }), env), true);
  assert.equal(appTokenOk(new Request('https://w/journal', { headers: { 'x-app-token': 'abc12' } }), env), false);
  assert.equal(appTokenOk(new Request('https://w/journal'), {}), false, '一個 token 都沒設定時一律拒絕');
});

test('教練即時戰績：每根收盤記錄回踩的劇本，之後照停損／目標結算，不重複記', async () => {
  const env = { SMC_KV: makeKv() };
  let S = await loadCoachLive(env);
  for (let j = 600; j < 2600; j++) {
    const W = BTC.slice(j - 499, j + 1), A = analyze(W, 4, 2), st = coachState(W, A, 0);
    trackCoachLive(S, { sym: 'BTCUSDT', iv: '1h' }, W, A, st, '4h');
    if (j % 200 === 0) { await saveCoachLive(env, S); S = await loadCoachLive(env); }
  }
  await saveCoachLive(env, S);
  const r = await coachLiveResponse(env);
  assert.ok(r.done.length > 10, `應該有結算的紀錄（${r.done.length}）`);
  const ids = [...r.done, ...r.open].map((x) => x.id);
  assert.equal(new Set(ids).size, ids.length, '同一個劇本只記一次');
  for (const x of r.done) {
    assert.ok(['tp', 'sl', 'timeout'].includes(x.out));
    if (x.out === 'sl') assert.ok(x.r < -1 && x.r > -1.2, '停損約 -1R（含手續費）');
    if (x.out === 'tp') assert.ok(Math.abs(x.r - x.rr) < 0.2, '到目標約等於盈虧比（扣手續費）');
    assert.ok(x.endT >= x.rtT);
  }
});

test('resolveLive：回踩那根同時碰到停損和目標，先算停損', () => {
  const rec = { side: 'L', en: 100, sl: 95, tp: 110, rtT: 10 };
  const W = [{ t: 9, o: 101, h: 102, l: 100.5, c: 101 }, { t: 10, o: 101, h: 111, l: 94, c: 100 }];
  assert.equal(resolveLive(rec, W).out, 'sl');
  const W2 = [{ t: 10, o: 101, h: 111, l: 99, c: 100 }, { t: 11, o: 100, h: 111, l: 99, c: 110 }];
  assert.equal(resolveLive(rec, W2).out, 'tp', '回踩那根碰到目標不算，下一根才算');
});

test('盯這單：回到進場價 → 到目標，各推一次；方向錯的單不收', async () => {
  const env = { SMC_KV: makeKv() };
  const req = (method, body) => new Request('https://w/watch', { method, body: body && JSON.stringify(body) });
  assert.equal((await handleWatch(req('POST', { sym: 'BTCUSDT', iv: '15m', side: 'L', en: 100, sl: 105, tp: 110 }), env)).status, 400);
  const ok = await handleWatch(req('POST', { sym: 'BTCUSDT', iv: '15m', side: 'L', en: 100, sl: 95, tp: 110 }), env);
  assert.equal(ok.status, 200);
  const base = Math.floor(Date.now() / 9e5) * 9e5, msgs = [];
  let bars = [{ time: base, open: 104, high: 105, low: 101, close: 103 }];
  const deps = { fetchKlines: async () => bars, postDiscord: async (e, p) => msgs.push(p.content), intervalToMs: () => 9e5 };
  await checkWatches(env, deps);
  assert.equal(msgs.length, 0, '還沒碰到進場價');
  bars = [{ time: base, open: 104, high: 105, low: 99.5, close: 101 }];
  await checkWatches(env, deps);
  assert.match(msgs.at(-1), /回到進場價/);
  await checkWatches(env, deps);
  assert.equal(msgs.length, 1, '不重複推');
  bars = [{ time: base, open: 104, high: 105, low: 99.5, close: 101 }, { time: base + 9e5, open: 101, high: 111, low: 100.5, close: 110 }];
  await checkWatches(env, deps);
  assert.match(msgs.at(-1), /到目標/);
  const left = (await handleWatch(req('GET'), env)).body.watches;
  assert.equal(left.length, 0, '結束就移除');
});

test('交易日誌：把 Executor 的成交明細還原成交易', async () => {
  const ex = [
    { symbol: 'SOLUSDT', side: 'Buy', orderLinkId: '', execPrice: 100, execQty: 10, execFee: 0.5, closedSize: 0, execTime: 1000 },
    { symbol: 'SOLUSDT', side: 'Sell', orderLinkId: '', execPrice: 103, execQty: 10, execFee: 0.5, closedSize: 10, execTime: 2000 },
  ];
  const r = await journalResponse({ EXECUTOR_URL: 'x', EXECUTOR_HMAC_SECRET: 'y' }, 30, async () => ({ configured: true, executions: ex, balance: 223, positions: [] }));
  assert.equal(r.configured, true);
  assert.equal(r.trades.length, 1);
  assert.equal(r.trades[0].dir, 'long');
  assert.equal(r.trades[0].strategy, 'manual');
  assert.equal(r.trades[0].pnl, 29);
  assert.equal(r.balance, 223);
  const no = await journalResponse({}, 30, async () => ({}));
  assert.equal(no.configured, false);
});

test('每日戰報：台灣 8 點推一次、同一天不重複，內容有總計 R', async () => {
  const { maybeDailyReport } = await import('../worker/coach-extras.js');
  const env = { SMC_KV: makeKv() };
  const now = Date.UTC(2026, 9, 15, 0, 4), sec = now / 1000;
  await env.SMC_KV.put('coachlive2:done', JSON.stringify([
    { sym: 'BTCUSDT', iv: '15m', side: 'L', r: 2.1, rr: 2.2, bias: 2, rtT: sec - 40000, endT: sec - 30000 },
    { sym: 'ETHUSDT', iv: '1h', side: 'S', r: -1.03, rr: 1.5, bias: 1, rtT: sec - 20000, endT: sec - 10000 },
    { sym: 'SOLUSDT', iv: '30m', side: 'S', r: 3, rr: 3, bias: 2, rtT: sec - 300000, endT: sec - 200000 },
  ]));
  const msgs = [];
  const deps = { postDiscord: async (e, p) => msgs.push(p.embeds[0]), now };
  assert.equal((await maybeDailyReport(env, { ...deps, now: Date.UTC(2026, 9, 15, 3, 0) })).skipped, 'not-time');
  const r = await maybeDailyReport(env, deps);
  assert.equal(r.sent, true);
  assert.match(msgs[0].description, /2 筆・勝率 50%・總計 \*\*\+1\.1R\*\*/);
  assert.match(msgs[0].description, /開始記錄以來.*3 筆・總計 \+4\.1R/);
  assert.equal((await maybeDailyReport(env, deps)).skipped, 'already-sent');
  assert.equal(msgs.length, 1);
});

test('教練劇本紀錄：事後才看到的回踩（超過 2 根）不記、舊的也不算進戰績', async () => {
  const { fairLive } = await import('../worker/coach-extras.js');
  assert.equal(fairLive({ late: 0 }), true);
  assert.equal(fairLive({ late: 2 }), true);
  assert.equal(fairLive({ late: 40 }), false);
  assert.equal(fairLive({}), true);
});
