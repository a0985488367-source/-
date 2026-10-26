import test from 'node:test';
import assert from 'node:assert/strict';
import { gate, reportDue, buildReport, runDigest } from '../worker/notify.js';

const kv = () => { const m = new Map(); return { get: async (k) => m.get(k) ?? null, put: async (k, v) => { m.set(k, v); }, _m: m }; };
const tpe = (s) => Date.parse(s + '+08:00');

test('安靜模式：一般通知擋掉，兩天報告和緊急警報放行；一般模式全部放行', () => {
  const quiet = { DISCORD_MODE: 'quiet' };
  assert.equal(gate(quiet, { content: '✅ 超級趨勢平倉 +1.2R' }).send, false);
  assert.equal(gate(quiet, { embeds: [{ title: '🧭 大方向：多' }] }).send, false);
  assert.equal(gate(quiet, { embeds: [{ title: 'BTC 突破單', description: '有突破訊號，但下單失敗：餘額不足' }] }).send, true);
  assert.equal(gate(quiet, { urgent: true, content: 'x' }).send, true);
  const r = gate(quiet, { report: true, embeds: [{ title: '兩天報告' }] });
  assert.equal(r.send, true);
  assert.equal(r.payload.report, undefined, '內部旗標不送出去');
  assert.equal(gate({}, { content: '平倉' }).send, true);
});

test('兩天報告：從 10/27 起每隔一天台灣早上 9 點', () => {
  const env = { REPORT_ANCHOR: '2026-10-27' };
  assert.equal(reportDue(env, tpe('2026-10-27T09:05:00')), true);
  assert.equal(reportDue(env, tpe('2026-10-28T09:05:00')), false);
  assert.equal(reportDue(env, tpe('2026-10-29T09:10:00')), true);
  assert.equal(reportDue(env, tpe('2026-10-29T10:05:00')), false);
  assert.equal(reportDue(env, tpe('2026-10-29T09:45:00')), false);
  assert.equal(reportDue(env, tpe('2026-10-26T09:05:00')), false, '起始日之前不推');
});

test('報告內容：權益變化當標題，各策略分開', () => {
  const now = tpe('2026-10-29T09:00:00');
  const trades = [
    { strategy: 'rsi', pnl: 12, closeTime: now - 3600e3 },
    { strategy: 'st', pnl: -20, closeTime: now - 7200e3 },
    { strategy: 'st', pnl: 5, closeTime: now - 7200e3 },
    { strategy: 'st', pnl: -99, closeTime: now - 5 * 86400e3 }, // 兩天前的不算
  ];
  const p = buildReport({ trades, positions: [{ unrealisedPnl: 3 }], eqNow: 690, eqThen: { eq: 700 }, periodMs: 2 * 86400e3, now });
  const e = p.embeds[0];
  assert.ok(p.report);
  assert.match(e.title, /虧 10\.0U/);
  assert.match(e.description, /已平倉 3 筆：−3\.0U/);
  assert.match(e.description, /RSI 回歸：\+12\.0U/);
  assert.match(e.description, /超級趨勢：−15\.0U（2 筆，贏 1）/);
});

test('runDigest：兩天掉超過 10% 推緊急警報、離強平太近推警報、時間到推報告（各只推一次）', async () => {
  const env = { EXECUTOR_URL: 'x', EXECUTOR_HMAC_SECRET: 'y', SMC_KV: kv(), DISCORD_MODE: 'quiet', REPORT_ANCHOR: '2026-10-27' };
  const sent = [];
  const postDiscord = async (_e, p) => { sent.push(p); };
  let eq = 1000;
  const executorCall = async (_e, _m, path) => {
    if (path === '/balance') return { totalEquity: eq, totalWalletBalance: eq };
    if (path === '/position') return { positions: [{ symbol: 'ETHUSDT', side: 'Buy', size: 1, avgPrice: 2500, markPrice: 2450, liqPrice: 2400, unrealisedPnl: -50 }] };
    if (path === '/history') return { executions: [] };
    return {};
  };
  const t0 = tpe('2026-10-27T03:00:00');
  // 先累積 2 天的快照（每小時）
  for (let h = 0; h < 50; h++) { eq = 1000 - h * 2.5; await runDigest(env, { executorCall, postDiscord, now: t0 + h * 3600e3 }); }
  assert.ok(sent.some((p) => p.urgent && /離強平價只剩 2\.0%/.test(p.content)), '離強平太近要推');
  assert.equal(sent.filter((p) => /強平/.test(p.content || '')).length, 1, '同一個幣 12 小時內只推一次');
  assert.ok(sent.some((p) => p.urgent && /兩天內掉了/.test(p.content)), '兩天掉超過 10% 要推');
  assert.ok(sent.some((p) => p.report), '10/27 09:00 要推報告');
  assert.equal(sent.filter((p) => p.report).length, 1, '10/28 不推');
});
