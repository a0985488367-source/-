import test from 'node:test';
import assert from 'node:assert/strict';
import { emaCrossSignal } from '../src/strategies/ema-cross.js';
import { breakoutSignal } from '../src/strategies/breakout.js';
import { fakeoutSignal } from '../src/strategies/fakeout.js';
import { prepare, ZOO } from '../scripts/research/strategy-zoo.mjs';
import worker from '../worker/index.js';

const H4 = 4 * 3_600_000;

/** 緩漲＋上下擺動：EMA20 會週期性上穿 EMA50，收盤一直在 EMA200 之上 */
const wave = (i) => 100 + 0.03 * i + 3 * Math.sin(i / 15);
function series(n, f, start = 0) {
  return Array.from({ length: n }, (_, i) => {
    const p = f(i);
    return { time: start + i * H4, open: p, high: p + 0.4, low: p - 0.4, close: p, volume: 1 };
  });
}

test('emaCrossSignal：EMA20 剛上穿 EMA50 且收在 EMA200 之上 → 做多，停損 2 ATR；只在交叉那一根', () => {
  const c = series(700, wave);
  const hits = [];
  for (let e = 299; e < 700; e++) {
    const s = emaCrossSignal(c.slice(e - 299, e + 1));
    if (s) hits.push([e, s]);
  }
  assert.ok(hits.length >= 3, '擺動幾次就交叉幾次');
  for (const [, s] of hits) {
    assert.equal(s.dir, 'long', '收在 EMA200 之上，下穿也不做空');
    assert.ok(Math.abs(s.stopDistance - 2 * s.atr) < 1e-9);
  }
  // 交叉的下一根（還在上面）不再給訊號
  const [e] = hits[0];
  assert.equal(emaCrossSignal(c.slice(e - 298, e + 2)), null);
});

test('emaCrossSignal：下跌趨勢裡 EMA20 下穿 EMA50 → 做空', () => {
  const c = series(700, (i) => 200 - 0.03 * i - 3 * Math.sin(i / 15));
  const dirs = new Set();
  for (let e = 299; e < 700; e++) {
    const s = emaCrossSignal(c.slice(e - 299, e + 1));
    if (s) dirs.add(s.dir);
  }
  assert.deepEqual([...dirs], ['short']);
});

test('emaCrossSignal 跟回測策略庫的 EMA_20_50 判斷完全一致', () => {
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) - 0.5;
  let p = 100;
  const c = Array.from({ length: 3000 }, (_, i) => {
    const o = p;
    p = Math.max(1, p * (1 + rnd() * 0.03));
    return { time: i * H4, open: o, high: Math.max(o, p) * (1 + Math.abs(rnd()) * 0.01), low: Math.min(o, p) * (1 - Math.abs(rnd()) * 0.01), close: p, volume: 1 };
  });
  const x = prepare(c);
  let n = 0;
  for (let i = 210; i < c.length; i++) {
    const zoo = ZOO.EMA_20_50(x, i);
    const s = emaCrossSignal(c, {}, i);
    assert.equal(s?.dir ?? null, zoo?.dir ?? null, `第 ${i} 根`);
    if (s) { n++; assert.ok(Math.abs(s.stopDistance - x.a[i] * zoo.stopAtr) < 1e-9); }
  }
  assert.ok(n > 10, `隨機資料要有足夠的交叉（${n}）`);
});

/* ------------------------------------------------------------ Worker 串接 */

const MARKET_URL = 'https://market.test/market.json';
const EXECUTOR_URL = 'https://executor.test';

function makeKv(init = {}) {
  const m = new Map(Object.entries(init));
  return {
    store: m,
    async get(k) { return m.get(k) ?? null; },
    async put(k, v) { m.set(k, v); },
    async delete(k) { m.delete(k); },
    async list({ prefix = '' } = {}) { return { keys: [...m.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })) }; },
  };
}

/** EMAUSDT 最後一根收盤剛好 EMA 交叉（沒有突破）；其他幣沒有訊號 */
function klinesFor(symbol, step = H4) {
  const lastClosed = Math.floor(Date.now() / step) * step - step;
  const start = lastClosed - 299 * step;
  if (!symbol.startsWith('EMA')) return series(301, (i) => 100 + i * 0.001, start).map((k, i) => ({ ...k, time: start + i * step }));
  const all = series(700, wave);
  let end = 299;
  while (!emaCrossSignal(all.slice(end - 299, end + 1))) end++;
  const w = all.slice(end - 299, end + 2); // 300 根收盤＋1 根還沒收盤
  assert.equal(breakoutSignal(w.slice(0, 300)), null);
  return w.map((k, i) => ({ ...k, time: start + i * step }));
}

function stub({ discord = [], executor, prices = {} }) {
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    const j = (o) => new Response(JSON.stringify(o), { status: 200 });
    if (u.startsWith(MARKET_URL)) return j({ generatedAt: new Date().toISOString(), rows: [] });
    if (u.includes('api.bybit.com/v5/market/kline')) {
      const q = new URL(u).searchParams;
      // K 棒時間照請求的週期排（Bybit interval 是分鐘數），6h 的收盤時間才會對得上
      const list = klinesFor(q.get('symbol'), Number(q.get('interval')) * 60_000 || H4).reverse().map((k) => [String(k.time), String(k.open), String(k.high), String(k.low), String(k.close), '1', '1']);
      return j({ retCode: 0, result: { list } });
    }
    if (u.includes('api.bybit.com/v5/market/tickers')) {
      return j({ retCode: 0, result: { list: Object.entries(prices).map(([symbol, lastPrice]) => ({ symbol, lastPrice: String(lastPrice) })) } });
    }
    if (u.includes('discord')) { discord.push(JSON.parse(init.body)); return new Response(null, { status: 204 }); }
    if (u.startsWith(EXECUTOR_URL)) {
      const body = init.body ? JSON.parse(init.body) : null;
      executor.calls.push({ url: u, body });
      if (u.includes('/balance')) return j({ totalAvailableBalance: 1000, totalWalletBalance: 1000 });
      if (u.includes('/instrument')) return j({ qtyStep: 0.01, minQty: 0.01, tickSize: 0.01, maxLeverage: 25 });
      if (u.includes('/position')) return j({ positions: executor.positions ?? [] });
      if (u.endsWith('/trade')) return j({ orderId: 'ema-order', ladder: body.ladder.map((l) => ({ ...l, orderId: 'tp-order' })) });
      if (u.endsWith('/set-stop')) return j({ ok: true });
    }
    throw new Error('未預期的請求：' + u);
  };
}

const makeEnv = (kv = {}, over = {}) => ({
  MARKET_URL,
  DISCORD_WEBHOOK_URL: 'https://discord.com/api/webhooks/1/abc',
  EXECUTOR_URL,
  EXECUTOR_HMAC_SECRET: 'a'.repeat(32),
  SMC_KV: makeKv({ 'auto-trade:enabled': 'true', ...kv }),
  BREAKOUT_ENABLED: 'true',
  EMA_CROSS_ENABLED: 'true',
  BREAKOUT_SYMBOLS: 'EMAUSDT,XYZUSDT',
  BREAKOUT_MAX_DELAY_MIN: '100000',
  WORKER_SCAN_PROVIDERS: 'bybit',
  BREAKOUT_PROVIDERS: 'bybit-linear',
  ...over,
});

const runWorker = async (env) => (await worker.fetch(new Request('https://w.test/run'), env)).json();
const altPos = (symbol, dir, strategy = 'breakout') => [`open-pos:${symbol}:${dir}`, JSON.stringify({
  symbol, dir, entry: 1, stop: dir === 'long' ? 0.9 : 1.1, initialStop: dir === 'long' ? 0.9 : 1.1, qty: 1, strategy, management: 'fixed', ladder: [],
})];

test('Worker EMA 交叉：市價進場、停損 2 ATR、不掛止盈、每單 3%，部位存保本／追蹤參數', async () => {
  const discord = [];
  const executor = { calls: [] };
  stub({ discord, executor });
  const env = makeEnv();
  const out = await runWorker(env);
  assert.equal(out.breakout.signals, 1, JSON.stringify(out.breakout));
  const order = out.breakout.orders[0];
  assert.equal(order.strategy, 'ema');
  assert.equal(order.orderId, 'ema-order');

  const trade = executor.calls.find((c) => c.url.endsWith('/trade')).body;
  assert.equal(trade.side, 'Buy');
  assert.deepEqual(trade.ladder, [], 'EMA 交叉單不設止盈');
  assert.match(trade.signal_id, /^ema:EMA:l:4h:[0-9a-z]+$/);
  const entry = order.entry;
  const stop = Number(trade.stop_loss);
  assert.ok(Math.abs(Number(trade.qty) * (entry - stop) - 30) < 1, '風險約 1000 × 3% = 30');

  const pos = JSON.parse(await env.SMC_KV.get('open-pos:EMAUSDT:long'));
  assert.equal(pos.strategy, 'ema');
  assert.deepEqual(pos.management, { breakevenAtR: 1, breakevenOffsetR: 0.05, trailFromR: 1.5, trailGapR: 1.5 });
  assert.ok(discord.some((d) => d.embeds?.[0]?.title.includes('EMA 交叉做多')));
});

test('Worker EMA 交叉：關掉 EMA_CROSS_ENABLED 就不判斷', async () => {
  const executor = { calls: [] };
  stub({ executor });
  const out = await runWorker(makeEnv({}, { EMA_CROSS_ENABLED: 'false' }));
  assert.equal(out.breakout.signals, 0);
  assert.equal(executor.calls.filter((c) => c.url.endsWith('/trade')).length, 0);
});

test('Worker EMA 交叉：跟突破單共用最多 5 張；同方向已有 3 張 → 不下單', async () => {
  const executor = { calls: [] };
  stub({ executor });
  const three = Object.fromEntries([altPos('AAAUSDT', 'long'), altPos('BBBUSDT', 'long', 'ema'), altPos('CCCUSDT', 'long')]);
  executor.positions = ['AAAUSDT', 'BBBUSDT', 'CCCUSDT'].map((symbol) => ({ symbol, side: 'Buy', size: '1' }));
  const same = await runWorker(makeEnv(three));
  assert.equal(same.breakout.orders[0].skipped, 'max-same-dir');

  const five = Object.fromEntries([
    altPos('AAAUSDT', 'short'), altPos('BBBUSDT', 'short', 'ema'), altPos('CCCUSDT', 'short'), altPos('DDDUSDT', 'long', 'ema'), altPos('EEEUSDT', 'long'),
  ]);
  executor.positions = [
    ...['AAAUSDT', 'BBBUSDT', 'CCCUSDT'].map((symbol) => ({ symbol, side: 'Sell', size: '1' })),
    ...['DDDUSDT', 'EEEUSDT'].map((symbol) => ({ symbol, side: 'Buy', size: '1' })),
  ];
  const full = await runWorker(makeEnv(five));
  assert.equal(full.breakout.orders[0].skipped, 'max-open');
  assert.equal(executor.calls.filter((c) => c.url.endsWith('/trade')).length, 0);
});

test('Worker EMA 交叉：停損照部位自己的參數搬（1R 才保本、1.5R 後追蹤 1.5R），不是 SMC 的預設值', async () => {
  const executor = { calls: [], positions: [{ symbol: 'EMAUSDT', side: 'Buy', size: '1' }] };
  const management = { breakevenAtR: 1, breakevenOffsetR: 0.05, trailFromR: 1.5, trailGapR: 1.5 };
  const pos = { symbol: 'EMAUSDT', dir: 'long', entry: 100, stop: 90, initialStop: 90, qty: 1, strategy: 'ema', management, ladder: [], tickSize: 0.01 };
  const off = { BREAKOUT_ENABLED: 'false', EMA_CROSS_ENABLED: 'false' };

  // +0.8R：SMC 預設（0.5R 保本）會搬，EMA 交叉單不搬
  stub({ executor, prices: { EMAUSDT: 108 } });
  const env = makeEnv({ 'open-pos:EMAUSDT:long': JSON.stringify(pos) }, off);
  await runWorker(env);
  assert.equal(executor.calls.filter((c) => c.url.endsWith('/set-stop')).length, 0);

  // +1.2R：停損移到成本 +0.05R
  stub({ executor, prices: { EMAUSDT: 112 } });
  await runWorker(env);
  assert.equal(JSON.parse(await env.SMC_KV.get('open-pos:EMAUSDT:long')).stop, 100.5);

  // +2.5R：追蹤停損鎖在 2.5 − 1.5 = 1R
  stub({ executor, prices: { EMAUSDT: 125 } });
  await runWorker(env);
  assert.equal(JSON.parse(await env.SMC_KV.get('open-pos:EMAUSDT:long')).stop, 110);
});

/* ------------------------------------------------------------ MACD 零軸、多週期 */

import { macdZeroSignal } from '../src/strategies/macd-zero.js';

test('macdZeroSignal 跟回測策略庫的 MACD_ZERO 判斷完全一致', () => {
  let seed = 11;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) - 0.5;
  let p = 100;
  const c = Array.from({ length: 3000 }, (_, i) => {
    const o = p;
    p = Math.max(1, p * (1 + rnd() * 0.03));
    return { time: i * H4, open: o, high: Math.max(o, p) * (1 + Math.abs(rnd()) * 0.01), low: Math.min(o, p) * (1 - Math.abs(rnd()) * 0.01), close: p, volume: 1 };
  });
  const x = prepare(c);
  let n = 0;
  for (let i = 210; i < c.length; i++) {
    const zoo = ZOO.MACD_ZERO(x, i);
    const s = macdZeroSignal(c, {}, i);
    assert.equal(s?.dir ?? null, zoo?.dir ?? null, `第 ${i} 根`);
    if (s) { n++; assert.ok(Math.abs(s.stopDistance - x.a[i] * zoo.stopAtr) < 1e-9); }
  }
  assert.ok(n > 10, `隨機資料要有足夠的訊號（${n}）`);
});

test('Worker：BREAKOUT_INTERVALS=4h,6h 兩個週期都判斷，每次 tick 的請求額度共用', async () => {
  const executor = { calls: [] };
  stub({ executor });
  // 只開 MACD（EMAUSDT 的 K 棒沒有 MACD 訊號也沒關係，這裡只看流程）
  const env = makeEnv({}, { BREAKOUT_ENABLED: 'false', EMA_CROSS_ENABLED: 'false', MACD_ZERO_ENABLED: 'true', BREAKOUT_INTERVALS: '4h,6h', BREAKOUT_BATCH_SIZE: '3' });
  const out = await runWorker(env);
  assert.deepEqual(Object.keys(out.breakout.intervals), ['4h', '6h']);
  // 4h 用掉 2 檔的額度，6h 只剩 1 檔
  const h6 = out.breakout.intervals['6h'];
  assert.ok(h6.waiting === 'batch-budget' || h6.remaining === 1 || h6.skipped, JSON.stringify(h6));
  const again = await runWorker(env);
  assert.equal(again.breakout.intervals['4h'].skipped, 'already-checked');
});

test('Worker MACD 零軸：訊號下單不掛止盈、部位用保本＋追蹤參數、signal_id 用 macd 開頭', async () => {
  // 找一段最後一根剛好 MACD 穿零軸（而且沒有 EMA 交叉、沒有突破）的 K 棒
  const all = series(900, (i) => 100 + 0.05 * i + 3 * Math.sin(i / 15));
  let end = 299;
  const pick = (w) => macdZeroSignal(w) && !emaCrossSignal(w) && !breakoutSignal(w);
  while (end < 899 && !pick(all.slice(end - 299, end + 1))) end++;
  assert.ok(end < 899, '測試資料要找得到 MACD 訊號');
  const lastClosed = Math.floor(Date.now() / H4) * H4 - H4;
  const w = all.slice(end - 299, end + 2).map((k, i) => ({ ...k, time: lastClosed - 299 * H4 + i * H4 }));
  const executor = { calls: [] };
  stub({ executor });
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('api.bybit.com/v5/market/kline') && new URL(String(url)).searchParams.get('symbol') === 'MACDUSDT') {
      const list = [...w].reverse().map((k) => [String(k.time), String(k.open), String(k.high), String(k.low), String(k.close), '1', '1']);
      return new Response(JSON.stringify({ retCode: 0, result: { list } }), { status: 200 });
    }
    return orig(url, init);
  };
  const env = makeEnv({}, { BREAKOUT_SYMBOLS: 'MACDUSDT', MACD_ZERO_ENABLED: 'true' });
  const out = await runWorker(env);
  assert.equal(out.breakout.orders[0]?.strategy, 'macd', JSON.stringify(out.breakout));
  const trade = executor.calls.find((c) => c.url.endsWith('/trade')).body;
  assert.deepEqual(trade.ladder, []);
  assert.match(trade.signal_id, /^macd:MACD:[ls]:4h:[0-9a-z]+$/);
  const pos = JSON.parse(await env.SMC_KV.get(`open-pos:MACDUSDT:${out.breakout.orders[0].dir}`));
  assert.equal(pos.strategy, 'macd');
  assert.equal(pos.management.breakevenAtR, 1);
});

test('Worker：KV 的 list 延遲（最終一致）時，同一輪連續下單也不會超過張數上限、同一個幣不會重複開', async () => {
  const executor = { calls: [] };
  stub({ executor });
  // list 只看得到一開始就有的 key（模擬剛寫入的 key 要等一陣子才列得出來）
  const kv = makeKv({ 'auto-trade:enabled': 'true' });
  const snapshot = [...kv.store.keys()];
  kv.list = async ({ prefix = '' } = {}) => ({ keys: snapshot.filter((k) => k.startsWith(prefix)).map((name) => ({ name })) });
  const env = { ...makeEnv({}, { BREAKOUT_SYMBOLS: 'EMA1USDT,EMA2USDT,EMA3USDT', BREAKOUT_MAX_OPEN: '2' }), SMC_KV: kv };
  const out = await runWorker(env);
  const placed = out.breakout.orders.filter((o) => o.orderId);
  assert.equal(placed.length, 2, JSON.stringify(out.breakout.orders));
  assert.equal(out.breakout.orders.find((o) => !o.orderId)?.skipped, 'max-open');
});

test('Worker 假突破反手：停損用假突破極值外的固定價格、止盈 1R、signal_id 用 fo 開頭、部位不移動停損', async () => {
  // 隨機走勢裡找一段最後一根剛好出現假突破 MSS 的 K 棒
  let s = 3;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647) - 0.5;
  let p = 100;
  const all = Array.from({ length: 1500 }, () => {
    const o = p;
    p = Math.max(1, p * (1 + rnd() * 0.03));
    return { time: 0, open: o, high: Math.max(o, p) * (1 + Math.abs(rnd()) * 0.01), low: Math.min(o, p) * (1 - Math.abs(rnd()) * 0.01), close: p, volume: 1 };
  });
  let end = 299;
  while (end < 1499 && !fakeoutSignal(all.slice(end - 299, end + 1))) end++;
  assert.ok(end < 1499, '測試資料要找得到假突破');
  const sig = fakeoutSignal(all.slice(end - 299, end + 1));
  const lastClosed = Math.floor(Date.now() / H4) * H4 - H4;
  const w = all.slice(end - 299, end + 2).map((k, i) => ({ ...k, time: lastClosed - 299 * H4 + i * H4 }));
  const executor = { calls: [] };
  stub({ executor });
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('api.bybit.com/v5/market/kline') && new URL(String(url)).searchParams.get('symbol') === 'FAKEUSDT') {
      const list = [...w].reverse().map((k) => [String(k.time), String(k.open), String(k.high), String(k.low), String(k.close), '1', '1']);
      return new Response(JSON.stringify({ retCode: 0, result: { list } }), { status: 200 });
    }
    return orig(url, init);
  };
  const env = makeEnv({}, { BREAKOUT_SYMBOLS: 'FAKEUSDT', BREAKOUT_ENABLED: 'false', EMA_CROSS_ENABLED: 'false', FAKEOUT_ENABLED: 'true' });
  const out = await runWorker(env);
  const order = out.breakout.orders[0];
  assert.equal(order?.strategy, 'fakeout', JSON.stringify(out.breakout));
  assert.equal(order.dir, sig.dir);
  const trade = executor.calls.find((c) => c.url.endsWith('/trade')).body;
  assert.match(trade.signal_id, /^fo:FAKE:[ls]:4h:[0-9a-z]+$/);
  assert.ok(Math.abs(Number(trade.stop_loss) - sig.stopPrice) <= 0.01);
  const risk = Math.abs(sig.close - sig.stopPrice);
  assert.equal(trade.ladder.length, 1);
  assert.ok(Math.abs(Number(trade.ladder[0].price) - (sig.close + (sig.dir === 'long' ? risk : -risk))) <= 0.01);
  const pos = JSON.parse(await env.SMC_KV.get(`open-pos:FAKEUSDT:${sig.dir}`));
  assert.equal(pos.strategy, 'fakeout');
  assert.equal(pos.management, 'fixed');
});
