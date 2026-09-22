import test from 'node:test';
import assert from 'node:assert/strict';
import { PROVIDERS } from '../src/data/providers.js';

/**
 * 測試共用的 fetch 重試邏輯（src/data/providers.js 的 J()）：從 Cloudflare
 * Worker 的共用邊緣 IP 打出去，逾時／429／5xx 常常只是暫時性的，值得重試
 * 一次；4xx（除了 429，通常是網址或參數本身有問題）重試也沒用，不該浪費
 * 這次請求額度去重試。用 bybit.fetchTicker() 間接測（J 本身沒有 export）。
 */

test('遇到 5xx 會重試一次，重試後成功就正常回傳', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    if (calls === 1) return { ok: false, status: 503 };
    return { ok: true, json: async () => ({ retCode: 0, result: { list: [{ symbol: 'BTCUSDT', lastPrice: '1', price24hPcnt: '0', highPrice24h: '1', lowPrice24h: '1', turnover24h: '1' }] } }) };
  };
  const out = await PROVIDERS.bybit.fetchTicker('BTCUSDT');
  assert.equal(calls, 2, '第一次 503 應該要重試一次');
  assert.equal(out.symbol, 'BTCUSDT');
});

test('遇到 429（限流）一樣會重試', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    if (calls === 1) return { ok: false, status: 429 };
    return { ok: true, json: async () => ({ retCode: 0, result: { list: [{ symbol: 'BTCUSDT', lastPrice: '1', price24hPcnt: '0', highPrice24h: '1', lowPrice24h: '1', turnover24h: '1' }] } }) };
  };
  const out = await PROVIDERS.bybit.fetchTicker('BTCUSDT');
  assert.equal(calls, 2);
  assert.equal(out.symbol, 'BTCUSDT');
});

test('遇到 404 這種不會自己好的錯誤，不重試、直接丟出去', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return { ok: false, status: 404 };
  };
  await assert.rejects(() => PROVIDERS.bybit.fetchTicker('BTCUSDT'), /HTTP 404/);
  assert.equal(calls, 1, '4xx（非 429）不該浪費請求去重試');
});

test('重試一次後還是失敗，就照重試次數丟出最後一次的錯誤', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return { ok: false, status: 500 };
  };
  await assert.rejects(() => PROVIDERS.bybit.fetchTicker('BTCUSDT'), /HTTP 500/);
  assert.equal(calls, 2, '預設 retries=1，總共應該打 2 次（原本 1 次 + 重試 1 次）');
});
