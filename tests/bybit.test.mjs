import test from 'node:test';
import assert from 'node:assert/strict';
import { roundStep, roundTick, planToOrder, explainError, BybitError, createClient, isRealMoney } from '../src/exchange/bybit.js';

test('數量一律無條件捨去到步進值（寧可少買也不要因為超額被退單）', () => {
  assert.equal(roundStep(1.23456, 0.001), 1.234);
  assert.equal(roundStep(0.0009, 0.001), 0);
  assert.equal(roundStep(7, 1), 7);
});

test('價格對齊到 tick', () => {
  assert.equal(roundTick(43215.7, 0.5), 43215.5);
  assert.equal(roundTick(0.123456, 0.0001), 0.1235);
});

const inst = { symbol: 'BTCUSDT', tickSize: 0.1, qtyStep: 0.001, minQty: 0.001, maxLeverage: 50 };

test('部位大小用固定風險法：停損越寬數量越小，最大虧損維持不變', () => {
  const wide = planToOrder({
    plan: { dir: 'long', entry: 100, stop: 90, entryType: 'limit', targets: [{ price: 130 }] },
    instrument: inst, accountSize: 10000, riskPct: 1, leverage: 10,
  });
  const tight = planToOrder({
    plan: { dir: 'long', entry: 100, stop: 95, entryType: 'limit', targets: [{ price: 130 }] },
    instrument: inst, accountSize: 10000, riskPct: 1, leverage: 10,
  });
  assert.equal(wide.riskAmount, 100);
  assert.equal(tight.riskAmount, 100);
  assert.equal(wide.qty, 10);
  assert.equal(tight.qty, 20, '停損縮一半，數量應該加倍');
});

test('市價計畫不帶限價，限價計畫要帶對齊後的價格', () => {
  const mkt = planToOrder({
    plan: { dir: 'short', entry: 100.07, stop: 105, entryType: 'market', targets: [{ price: 90 }] },
    instrument: inst, accountSize: 10000, riskPct: 1, leverage: 10,
  });
  assert.equal(mkt.price, null);
  assert.equal(mkt.side, 'short');
  assert.equal(mkt.stopLoss, 105);

  const lim = planToOrder({
    plan: { dir: 'short', entry: 100.07, stop: 105, entryType: 'limit', targets: [{ price: 90 }] },
    instrument: inst, accountSize: 10000, riskPct: 1, leverage: 10,
  });
  assert.equal(lim.price, 100.1, '應該對齊到 0.1 的 tick');
});

test('數量小於交易所最小下單量時回報原因，而不是硬送出去被退單', () => {
  const r = planToOrder({
    plan: { dir: 'long', entry: 100000, stop: 99000, entryType: 'market', targets: [{ price: 103000 }] },
    instrument: { ...inst, minQty: 1 }, accountSize: 100, riskPct: 1, leverage: 10,
  });
  assert.ok(r.error, '應該回報錯誤');
  assert.match(r.error, /最小下單量/);
});

test('沒有目標時不帶停利，但停損一定存在', () => {
  const r = planToOrder({
    plan: { dir: 'long', entry: 100, stop: 95, entryType: 'market', targets: [] },
    instrument: inst, accountSize: 10000, riskPct: 1, leverage: 10,
  });
  assert.equal(r.takeProfit, null);
  assert.equal(r.stopLoss, 95);
});

test('錯誤碼會翻成看得懂、而且說得出下一步的訊息', () => {
  assert.match(explainError(new BybitError(10004, 'error sign')).zh, /Secret/);
  assert.match(explainError(new BybitError(10010, 'ip')).zh, /白名單/);
  assert.match(explainError(new BybitError(-1, 'fail', { network: true })).zh, /CORS|網路/);
});

test('保證金與名目價值依槓桿計算', () => {
  const r = planToOrder({
    plan: { dir: 'long', entry: 100, stop: 96, entryType: 'market', targets: [{ price: 112 }] },
    instrument: inst, accountSize: 10000, riskPct: 1, leverage: 10,
  });
  assert.equal(r.qty, 25);
  assert.equal(r.notional, 2500);
  assert.equal(r.margin, 250);
});

/* ------------------------------------------- Bybit 的三套獨立環境 */

test('三個環境各自對應正確的網址，金鑰不會被送錯地方', () => {
  assert.equal(createClient({ apiKey: 'k', apiSecret: 's', mode: 'demo' }).host, 'https://api-demo.bybit.com');
  assert.equal(createClient({ apiKey: 'k', apiSecret: 's', mode: 'testnet' }).host, 'https://api-testnet.bybit.com');
  assert.equal(createClient({ apiKey: 'k', apiSecret: 's', mode: 'live' }).host, 'https://api.bybit.com');
});

test('只有 live 算真錢，模擬交易與測試網都不是', () => {
  assert.equal(isRealMoney('live'), true);
  assert.equal(isRealMoney('demo'), false);
  assert.equal(isRealMoney('testnet'), false);
});

test('10003 的說明要指出「環境選錯」這個最常見的原因', () => {
  const msg = explainError(new BybitError(10003, 'API key is invalid')).zh;
  assert.match(msg, /模擬交易/);
  assert.match(msg, /測試網/);
  assert.match(msg, /不能互通/);
});

test('未知的環境名稱退回模擬交易，不會誤連到實盤', () => {
  assert.equal(createClient({ apiKey: 'k', apiSecret: 's', mode: 'nonsense' }).host, 'https://api-demo.bybit.com');
});

test('舊的 testnet 布林參數仍然相容', () => {
  assert.equal(createClient({ apiKey: 'k', apiSecret: 's', mode: null, testnet: false }).host, 'https://api.bybit.com');
  assert.equal(createClient({ apiKey: 'k', apiSecret: 's', mode: null, testnet: true }).host, 'https://api-testnet.bybit.com');
});
