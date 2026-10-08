import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAiSnapshot, aiUserMessage } from '../src/radar/ai-context.js';
import { handleAiAsk, validateConversation, AI_MODEL, AI_SYSTEM } from '../worker/ai.js';

const report = {
  agg: { labelZh: '中性', score: -11, alignment: 75 },
  htf: { labelZh: '偏多', score: 60 },
  best: { tf: '2h', dir: 'long', entry: 2595.2, stop: 2569.4, targets: [{ price: 2633.5, rr: 1.48 }], grade: 'B', score: 60, againstHtf: false },
  conflicts: [{ low: 2595.2, high: 2619.5, longs: ['1h', '2h'], shorts: ['15m'] }],
  liqAbove: [{ price: 2622.9, tfs: ['15m', '1h'], touches: 4 }],
  liqBelow: [{ price: 2577.1, tfs: ['30m'], touches: 5 }],
  levels: [{ zh: '前日高', price: 2650 }],
  liquidation: { longs: [{ price: 2500, strength: 80 }], shorts: [{ price: 2700, strength: 60 }] },
  tfs: [{
    interval: '1h', bias: { score: -66 }, htfBias: { score: 62 }, swingTrend: 'bearish', internalTrend: 'bullish',
    events: [{ scope: 'internal', type: 'CHoCH', dir: 'bull', price: 2601, barsAgo: 3 }],
    liquidity: { above: [{ price: 2622.9, touches: 4 }], below: [{ price: 2577.1, touches: 5 }], sweeps: [{ side: 'sellside', level: 2580, extreme: 2575, time: 1 }], inducement: null },
    pd: { zone: 'discount', pct: 30, low: 2500, high: 2700 }, vp: { poc: 2600, vah: 2640, val: 2570 }, ema: { e20: 2600, e50: 2610, e200: 2650 }, rsi: 45, atrPct: 0.8,
    pois: [{ type: 'FVG', dir: 'bull', bottom: 2587, top: 2612 }],
    setup: { dir: 'long', entry: 2595.2, stop: 2571, entryType: 'limit', grade: 'B', score: 60, valid: true, targets: [{ name: 'TP1', price: 2633.5, rr: 1.48 }] },
    trend: { supertrend: -1, emaFastAbove: false, aboveEma200: false, macdAboveZero: false, sma50Above200: true, last: { st: { dir: 'short', barsAgo: 5 }, ema: null } },
  }],
};

test('市場快照：完整版有各週期細節、追問版只有摘要；價格距離照現價算', () => {
  const s = buildAiSnapshot({ symbol: 'ETHUSDT', mode: 'live', price: 2590, report, ticker: { change: -1.2, high: 2700, low: 2550 }, deriv: { fundingRate: -0.000118, oiSeries: [{ value: 100 }, { value: 110 }], provider: 'binance' }, ls: [{ buy: 0.7, sell: 0.3 }], whales: { threshold: 200000, walls: [{ side: 'bid', price: 2550, notional: 3e6, times: 9, ex: 'Bybit', seenCount: 5, firstSeen: 0 }], stats: { windows: [{ minutes: 5, bigBuy: 1e6, bigSell: 5e5, bigCount: 3 }] }, ratio: null }, now: 600000 });
  assert.equal(s.symbol, 'ETHUSDT');
  assert.equal(s.summary.best.distPct, 0.2);
  assert.equal(s.derivatives.oiChange24hPct, 10);
  assert.equal(s.bybitAccountLongPct, 70);
  assert.equal(s.timeframes.length, 1);
  assert.equal(s.timeframes[0].plan.dir, 'long');
  assert.match(s.whales.walls[0], /買牆 2550/);
  const short = buildAiSnapshot({ symbol: 'ETHUSDT', mode: 'live', price: 2590, report, full: false });
  assert.equal(short.timeframes, undefined);
  assert.ok(short.note);
  const msg = aiUserMessage(s, '  能做多嗎？ ');
  assert.ok(msg.startsWith('<snapshot>\n{') && msg.endsWith('能做多嗎？'));
  assert.ok(JSON.stringify(s).length < 40000);
});

test('對話格式檢查：要從使用者開始、最後一則是使用者', () => {
  assert.equal(validateConversation({ messages: [{ role: 'user', content: 'hi' }] }), null);
  assert.ok(validateConversation({ messages: [] }));
  assert.ok(validateConversation({ messages: [{ role: 'assistant', content: 'x' }] }));
  assert.ok(validateConversation({ messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: [] }] }));
  assert.ok(validateConversation({ messages: [{ role: 'system', content: 'x' }] }));
});

/** 假的 SDK client：照順序回傳預先準備好的回應 */
function fakeClient(replies) {
  const calls = [];
  return {
    calls,
    beta: { messages: { stream(params) {
      calls.push({ ...params, messages: params.messages.slice() });
      const msg = replies[calls.length - 1];
      return {
        async *[Symbol.asyncIterator]() {
          for (const [i, b] of msg.content.entries()) {
            yield { type: 'content_block_start', index: i, content_block: { ...b, text: b.type === 'text' ? '' : b.text } };
            if (b.type === 'text') yield { type: 'content_block_delta', index: i, delta: { type: 'text_delta', text: b.text } };
          }
        },
        finalMessage: async () => msg,
      };
    } } },
  };
}
const kvStore = () => { const m = new Map(); return { m, get: async (k) => m.get(k) ?? null, put: async (k, v) => m.set(k, v) }; };
const lines = async (res) => (await res.text()).trim().split('\n').map((l) => JSON.parse(l));
const ask = (token, messages) => new Request('https://w/ai/ask', { method: 'POST', headers: { 'x-ai-token': token }, body: JSON.stringify({ symbol: 'BTCUSDT', messages }) });

test('問 AI：密碼不對擋掉；沒設定金鑰回 503', async () => {
  const kv = kvStore();
  let r = await handleAiAsk(ask('x', [{ role: 'user', content: 'hi' }]), { SMC_KV: kv }, { client: fakeClient([]) });
  assert.equal(r.status, 503);
  r = await handleAiAsk(ask('wrong', [{ role: 'user', content: 'hi' }]), { AI_TOKEN: 'pw', ANTHROPIC_API_KEY: 'k', SMC_KV: kv }, { client: fakeClient([]) });
  assert.equal(r.status, 401);
});

test('問 AI：串流文字、回傳要接上的 assistant 訊息；固定的 system／tools／模型；pause_turn 會接續', async () => {
  const kv = kvStore();
  const client = fakeClient([
    { content: [{ type: 'thinking', thinking: '', signature: 's' }, { type: 'text', text: '先查一下。' }], stop_reason: 'pause_turn', usage: { input_tokens: 10, output_tokens: 5 } },
    { content: [{ type: 'text', text: '結論：偏多。' }], stop_reason: 'end_turn', usage: { input_tokens: 12, output_tokens: 6, cache_read_input_tokens: 8 } },
  ]);
  const env = { AI_TOKEN: 'pw', ANTHROPIC_API_KEY: 'k', SMC_KV: kv };
  const res = await handleAiAsk(ask('pw', [{ role: 'user', content: '能做多嗎？' }]), env, { client });
  const out = await lines(res);
  assert.equal(out.filter((o) => o.t === 'text').map((o) => o.d).join(''), '先查一下。結論：偏多。');
  const done = out.find((o) => o.t === 'done');
  assert.equal(done.append.length, 2);
  assert.equal(done.append[0].content[0].type, 'thinking'); // 思考區塊原封不動回傳
  assert.equal(done.usage.input_tokens, 22);
  assert.equal(client.calls.length, 2);
  assert.equal(client.calls[0].model, AI_MODEL);
  assert.equal(client.calls[0].system, AI_SYSTEM);
  assert.equal(client.calls[0].fallbacks, 'default');
  assert.deepEqual(client.calls[0].betas, ['server-side-fallback-2026-07-01']);
  assert.equal(client.calls[1].messages.length, 2); // 暫停的那段接上去再送
  assert.equal(client.calls[1].system, client.calls[0].system);
  assert.deepEqual(client.calls[1].tools, client.calls[0].tools);
  assert.equal([...kv.m.values()][0], '1');
});

test('問 AI：被安全機制擋下時不回傳要接的訊息；每天次數到上限就擋', async () => {
  const kv = kvStore();
  const env = { AI_TOKEN: 'pw', ANTHROPIC_API_KEY: 'k', SMC_KV: kv, AI_DAILY_LIMIT: '1' };
  const res = await handleAiAsk(ask('pw', [{ role: 'user', content: 'x' }]), env, { client: fakeClient([{ content: [], stop_reason: 'refusal', usage: {} }]) });
  const out = await lines(res);
  assert.ok(out.some((o) => o.t === 'refusal'));
  assert.deepEqual(out.find((o) => o.t === 'done').append, []);
  const r2 = await handleAiAsk(ask('pw', [{ role: 'user', content: 'x' }]), env, { client: fakeClient([]) });
  assert.equal(r2.status, 429);
});
