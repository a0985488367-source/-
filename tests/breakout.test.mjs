import test from 'node:test';
import assert from 'node:assert/strict';
import { breakoutSignal } from '../src/strategies/breakout.js';
import worker from '../worker/index.js';

const H4 = 4 * 3_600_000;

/** 緩漲的 K 棒（收在 EMA200 之上），最後一根可以指定收盤價 */
function trendCandles(n, { start = 0, lastClose = null, drift = 0.01 } = {}) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const p = 100 + i * drift;
    out.push({ time: start + i * H4, open: p, high: p + 0.5, low: p - 0.5, close: p, volume: 1 });
  }
  if (lastClose != null) {
    const k = out[n - 1];
    k.close = lastClose;
    k.high = Math.max(k.high, lastClose);
    k.low = Math.min(k.low, k.open);
  }
  return out;
}

test('breakoutSignal：收盤突破前 55 根高點且在 EMA200 之上 → 做多，停損 2 ATR', () => {
  const c = trendCandles(300);
  const priorHigh = Math.max(...c.slice(-56, -1).map((k) => k.high));
  c[299].close = priorHigh + 1;
  c[299].high = priorHigh + 1.2;
  const s = breakoutSignal(c);
  assert.equal(s.dir, 'long');
  assert.ok(s.stopDistance > 0 && Math.abs(s.stopDistance - 2 * s.atr) < 1e-9);
  assert.equal(s.close, c[299].close);
});

test('breakoutSignal：只取剛突破的第一根，前一根已經突破就不再給訊號', () => {
  const c = trendCandles(300);
  const hi = Math.max(...c.slice(-57, -2).map((k) => k.high));
  c[298].close = hi + 1; c[298].high = hi + 1.2;
  c[299].close = hi + 3; c[299].high = hi + 3.2;
  assert.equal(breakoutSignal(c), null);
  assert.equal(breakoutSignal(c, {}, 298).dir, 'long');
});

test('breakoutSignal：跌破前 55 根低點但在 EMA200 之上 → 不做空；沒突破 → null', () => {
  const c = trendCandles(300, { drift: 0.05 });
  const lo = Math.min(...c.slice(-56, -1).map((k) => k.low));
  c[299].close = lo - 0.1; c[299].low = lo - 0.2;
  assert.equal(breakoutSignal(c), null, 'EMA200 還在下面，跌破也不做空');
  assert.equal(breakoutSignal(trendCandles(300)), null);
});

test('breakoutSignal：下跌趨勢跌破前 55 根低點 → 做空', () => {
  const c = trendCandles(300, { drift: -0.05 });
  const lo = Math.min(...c.slice(-56, -1).map((k) => k.low));
  c[299].close = lo - 1; c[299].low = lo - 1.2;
  assert.equal(breakoutSignal(c).dir, 'short');
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

/** ABCUSDT 最後一根收盤突破，XYZUSDT 沒有訊號 */
function klinesFor(symbol) {
  const lastClosed = Math.floor(Date.now() / H4) * H4 - H4;
  const c = trendCandles(301, { start: lastClosed - 299 * H4 }); // 最後一根是還沒收盤的
  if (symbol === 'ABCUSDT') {
    const hi = Math.max(...c.slice(244, 299).map((k) => k.high));
    c[299].close = hi + 1; c[299].high = hi + 1.2;
  }
  return c;
}

const klineCategories = [];
const rateLimited = new Set();
function stub({ discord, executor, lastPrice = 105 }) {
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    const j = (o) => new Response(JSON.stringify(o), { status: 200 });
    if (u.startsWith(MARKET_URL)) return j({ generatedAt: new Date().toISOString(), rows: [] });
    if (u.includes('api.bybit.com/v5/market/kline')) {
      const symbol = new URL(u).searchParams.get('symbol');
      if (rateLimited.has(symbol)) return new Response('too many', { status: 429 });
      klineCategories.push(new URL(u).searchParams.get('category'));
      const list = klinesFor(symbol).reverse().map((k) => [String(k.time), String(k.open), String(k.high), String(k.low), String(k.close), '1', '1']);
      return j({ retCode: 0, result: { list } });
    }
    if (u.includes('api.bybit.com/v5/market/tickers')) {
      return j({ retCode: 0, result: { list: [{ symbol: 'ABCUSDT', lastPrice: String(lastPrice) }, { symbol: 'XYZUSDT', lastPrice: '100' }] } });
    }
    if (u.includes('discord')) { discord.push(JSON.parse(init.body)); return new Response(null, { status: 204 }); }
    if (u.startsWith(EXECUTOR_URL)) {
      const body = init.body ? JSON.parse(init.body) : null;
      executor.calls.push({ url: u, body });
      if (u.includes('/balance')) return j({ totalAvailableBalance: 1000, totalWalletBalance: 1000 });
      if (u.includes('/instrument')) return j({ qtyStep: 0.01, minQty: 0.01, tickSize: 0.01, maxLeverage: 25 });
      if (u.includes('/position')) return j({ positions: executor.positions ?? [] });
      if (u.endsWith('/trade')) return j({ orderId: 'bo-order', ladder: body.ladder.map((l) => ({ ...l, orderId: 'tp-order' })) });
      if (u.endsWith('/set-stop')) return j({ ok: true });
      if (u.endsWith('/cancel-all')) return j({ ok: true });
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
  BREAKOUT_SYMBOLS: 'ABCUSDT,XYZUSDT',
  BREAKOUT_MAX_DELAY_MIN: '100000',
  WORKER_SCAN_PROVIDERS: 'bybit',
  ...over,
});

const runWorker = async (env) => (await worker.fetch(new Request('https://w.test/run'), env)).json();

test('Worker 突破：4h 收盤突破 → 市價進場、停損 2 ATR、止盈 1R、每單 3% 風險，同一根只判斷一次', async () => {
  const discord = [];
  const executor = { calls: [] };
  stub({ discord, executor });
  const env = makeEnv();
  const out = await runWorker(env);
  assert.equal(out.breakout.signals, 1);
  const order = out.breakout.orders[0];
  assert.equal(order.symbol, 'ABCUSDT');
  assert.equal(order.orderId, 'bo-order');

  const trade = executor.calls.find((c) => c.url.endsWith('/trade')).body;
  assert.equal(trade.side, 'Buy');
  const entry = 105;
  const stop = Number(trade.stop_loss);
  const tp = Number(trade.ladder[0].price);
  assert.ok(stop < entry);
  assert.ok(Math.abs((tp - entry) - (entry - stop)) < 0.02, '止盈距離 = 停損距離（1R）');
  assert.equal(trade.ladder.length, 1);
  assert.equal(trade.ladder[0].qty, trade.qty, '止盈一次全部出場');
  assert.ok(Math.abs(Number(trade.qty) * (entry - stop) - 30) < 1, '風險約 1000 × 3% = 30');
  assert.match(trade.signal_id, /^bo:ABCUSDT:long:4h:\d+$/);
  assert.ok(klineCategories.length && klineCategories.every((c) => c === 'linear'), '判斷用合約 K 棒');

  const pos = JSON.parse(await env.SMC_KV.get('open-pos:ABCUSDT:long'));
  assert.equal(pos.strategy, 'breakout');
  assert.equal(pos.management, 'fixed');
  assert.ok(discord.some((d) => d.embeds?.[0]?.title.includes('突破做多')));

  const again = await runWorker(env);
  assert.equal(again.breakout.skipped, 'already-checked');
  assert.equal(executor.calls.filter((c) => c.url.endsWith('/trade')).length, 1);
});

test('Worker 突破：同一個幣已經有部位、或突破單已達上限 → 不下單', async () => {
  const executor = { calls: [], positions: [{ symbol: 'ABCUSDT', side: 'Sell', size: '1' }] };
  stub({ discord: [], executor });
  const smcPos = JSON.stringify({ symbol: 'ABCUSDT', dir: 'short', entry: 110, stop: 115, qty: 1 });
  const out = await runWorker(makeEnv({ 'open-pos:ABCUSDT:short': smcPos }));
  assert.equal(out.breakout.orders[0].skipped, 'has-position');

  const other = JSON.stringify({ symbol: 'QQQUSDT', dir: 'long', entry: 1, stop: 0.9, qty: 1, strategy: 'breakout', management: 'fixed' });
  executor.positions = [{ symbol: 'QQQUSDT', side: 'Buy', size: '1' }];
  const capped = await runWorker(makeEnv({ 'open-pos:QQQUSDT:long': other }, { BREAKOUT_MAX_OPEN: '1' }));
  assert.equal(capped.breakout.orders[0].skipped, 'max-open');
  assert.equal(executor.calls.filter((c) => c.url.endsWith('/trade')).length, 0);
});

test('Worker 突破：固定止盈的部位不會被保本／追蹤停損搬動；預設關閉時完全不判斷', async () => {
  const executor = { calls: [], positions: [{ symbol: 'ABCUSDT', side: 'Buy', size: '1' }] };
  stub({ discord: [], executor, lastPrice: 130 });
  const pos = { symbol: 'ABCUSDT', dir: 'long', entry: 100, stop: 95, initialStop: 95, qty: 1, strategy: 'breakout', management: 'fixed', ladder: [] };
  const env = makeEnv({ 'open-pos:ABCUSDT:long': JSON.stringify(pos) }, { BREAKOUT_ENABLED: 'false' });
  const out = await runWorker(env);
  assert.deepEqual(out.breakout, { enabled: false });
  assert.equal(executor.calls.filter((c) => c.url.endsWith('/set-stop')).length, 0);
  assert.equal(JSON.parse(await env.SMC_KV.get('open-pos:ABCUSDT:long')).stop, 95);
});

test('SMC 自動下單：同一個幣有突破單或反方向部位 → 不下單（避免單向持倉互相平倉）', async () => {
  const executor = { calls: [], positions: [{ symbol: 'ABCUSDT', side: 'Buy', size: '1' }] };
  const discord = [];
  stub({ discord, executor, lastPrice: 99.9 });
  const bo = JSON.stringify({ symbol: 'ABCUSDT', dir: 'long', entry: 100, stop: 95, qty: 1, strategy: 'breakout', management: 'fixed' });
  const row = {
    symbol: 'ABCUSDT', interval: '1h', dir: 'long', valid: true, status: 'waiting', score: 80, grade: 'A',
    entry: 100, stop: 97, rr: 2, riskPct: 3, poiType: 'FVG', targets: [{ name: 'TP1', price: 106, rr: 2 }],
    checksPassed: 8, checksTotal: 10, pd: { zone: 'discount', pct: 30 },
  };
  globalThis.fetch = ((orig) => async (url, init) => (String(url).startsWith(MARKET_URL)
    ? new Response(JSON.stringify({ generatedAt: new Date().toISOString(), rows: [row] }), { status: 200 })
    : orig(url, init)))(globalThis.fetch);
  const out = await runWorker(makeEnv({ 'open-pos:ABCUSDT:long': bo }, { BREAKOUT_ENABLED: 'false', AUTO_TRADE_MIN_STOP_PCT: '0', AUTO_TRADE_EXCLUDE_POI: '' }));
  assert.equal(out.alerts, 1, JSON.stringify(out));
  assert.match(JSON.stringify(discord), /已經有突破單部位/);
  assert.equal(executor.calls.filter((c) => c.url.endsWith('/trade')).length, 0);
});

test('Worker 突破：每次只判斷一批，被限流（429）的幣下一次再試，全部判斷完才算這根做完', async () => {
  const executor = { calls: [] };
  stub({ discord: [], executor });
  const env = makeEnv({}, { BREAKOUT_BATCH_SIZE: '1' });

  rateLimited.add('ABCUSDT');
  const first = await runWorker(env);
  assert.equal(first.breakout.retryLater, 1);
  assert.equal(first.breakout.remaining, 2);

  rateLimited.clear();
  const second = await runWorker(env); // 輪到 XYZ
  assert.equal(second.breakout.signals, 0);
  assert.equal(second.breakout.remaining, 1);

  const third = await runWorker(env); // 重試 ABC → 有突破訊號、下單
  assert.equal(third.breakout.signals, 1);
  assert.equal(third.breakout.orders[0].orderId, 'bo-order');
  assert.equal(third.breakout.remaining, 0);

  const fourth = await runWorker(env);
  assert.equal(fourth.breakout.skipped, 'already-checked');
});

test('Worker 突破：同一個幣一直被限流，試滿次數就放棄，不會卡住整根 K 棒', async () => {
  const executor = { calls: [] };
  stub({ discord: [], executor });
  const env = makeEnv({}, { BREAKOUT_SYMBOLS: 'ABCUSDT', BREAKOUT_MAX_TRIES: '2' });
  rateLimited.add('ABCUSDT');
  assert.equal((await runWorker(env)).breakout.retryLater, 1);
  const last = await runWorker(env);
  assert.equal(last.breakout.remaining, 0);
  assert.match(last.breakout.gaveUp[0], /^ABCUSDT：/);
  assert.equal((await runWorker(env)).breakout.skipped, 'already-checked');
  rateLimited.clear();
});
