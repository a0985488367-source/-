import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import {
  ForbiddenEndpointError,
  PRIVATE_READ_ENDPOINTS,
  assertReadOnlyEndpoint,
  buildQueryString,
  maskApiKey,
  parseClosedPnl,
  parsePositions,
  parseWalletBalance,
  protectionStatus,
  realizedPnlSince,
  signGetRequest,
} from '../app/bybit-private.js';

const KEY = 'testkey0000000000';
const SECRET = 'testsecret00000000000000';

test('白名單只包含唯讀端點', () => {
  for (const p of PRIVATE_READ_ENDPOINTS) {
    assert.doesNotMatch(p, /create|amend|cancel|transfer|withdraw|set-|switch|trading-stop/i, p);
  }
});

test('下單與資金移動端點一律拒絕', () => {
  const forbidden = [
    '/v5/order/create',
    '/v5/order/amend',
    '/v5/order/cancel',
    '/v5/order/cancel-all',
    '/v5/position/set-leverage',
    '/v5/position/trading-stop',
    '/v5/position/switch-isolated',
    '/v5/asset/transfer/inter-transfer',
    '/v5/asset/withdraw/create',
    '/v5/account/set-margin-mode',
    '/v5/user/create-sub-member',
  ];
  for (const p of forbidden) {
    assert.throws(() => assertReadOnlyEndpoint(p), ForbiddenEndpointError, `${p} 應被拒絕`);
  }
});

test('不在白名單的端點一律拒絕，即使看起來無害', () => {
  for (const p of ['/v5/market/tickers', '/v5/account/info', '/v5/spot/order', '/anything']) {
    assert.throws(() => assertReadOnlyEndpoint(p), ForbiddenEndpointError, p);
  }
});

test('白名單端點通過守門', () => {
  for (const p of PRIVATE_READ_ENDPOINTS) {
    assert.equal(assertReadOnlyEndpoint(p), p);
    assert.equal(assertReadOnlyEndpoint(`${p}?category=linear`), p, '查詢字串不影響判定');
  }
});

test('簽章符合 Bybit V5 規則，且與 node:crypto 一致', () => {
  const ts = 1700000000000;
  const params = { category: 'linear', settleCoin: 'USDT' };
  const signed = signGetRequest({
    path: '/v5/position/list', params, apiKey: KEY, apiSecret: SECRET, timestamp: ts,
  });

  const qs = 'category=linear&settleCoin=USDT';
  const expected = createHmac('sha256', SECRET).update(`${ts}${KEY}5000${qs}`).digest('hex');

  assert.equal(signed.queryString, qs);
  assert.equal(signed.headers['X-BAPI-SIGN'], expected);
  assert.equal(signed.headers['X-BAPI-API-KEY'], KEY);
  assert.equal(signed.headers['X-BAPI-TIMESTAMP'], String(ts));
  assert.equal(signed.headers['X-BAPI-RECV-WINDOW'], '5000');
  assert.equal(signed.url, `https://api.bybit.com/v5/position/list?${qs}`);
});

test('簽章不會把 Secret 洩漏到任何回傳欄位', () => {
  const signed = signGetRequest({
    path: '/v5/account/wallet-balance', params: { accountType: 'UNIFIED' },
    apiKey: KEY, apiSecret: SECRET, timestamp: 1,
  });
  const dump = JSON.stringify(signed);
  assert.ok(!dump.includes(SECRET), '回傳內容不得包含 Secret');
});

test('缺少憑證時丟出明確錯誤，且錯誤訊息不含憑證內容', () => {
  assert.throws(() => signGetRequest({ path: '/v5/position/list', apiKey: '', apiSecret: SECRET }), /缺少 API Key/);
  assert.throws(() => signGetRequest({ path: '/v5/position/list', apiKey: KEY, apiSecret: '' }), /缺少 API Secret/);
  try {
    signGetRequest({ path: '/v5/position/list', apiKey: KEY, apiSecret: '' });
  } catch (err) {
    assert.ok(!err.message.includes(KEY));
  }
});

test('簽章前會先過端點守門', () => {
  assert.throws(
    () => signGetRequest({ path: '/v5/order/create', apiKey: KEY, apiSecret: SECRET }),
    ForbiddenEndpointError,
  );
});

test('查詢字串省略空值，順序與網址一致', () => {
  assert.equal(buildQueryString({ a: 1, b: '', c: null, d: undefined, e: 'x' }), 'a=1&e=x');
  assert.equal(buildQueryString({}), '');
  assert.equal(buildQueryString(null), '');
});

test('錢包餘額解析', () => {
  const parsed = parseWalletBalance({
    list: [{
      accountType: 'UNIFIED', totalEquity: '1234.5', totalAvailableBalance: '1000.25',
      totalPerpUPL: '-12.3', coin: [{ coin: 'USDT', equity: '1234.5', availableToWithdraw: '1000.25' }],
    }],
  });
  assert.equal(parsed.totalEquityUsd, 1234.5);
  assert.equal(parsed.unrealizedPnlUsd, -12.3);
  assert.equal(parsed.usdtAvailable, 1000.25);
  assert.equal(parseWalletBalance({ list: [] }), null);
  assert.equal(parseWalletBalance(null), null);
});

test('持倉解析，零倉位會被濾掉', () => {
  const positions = parsePositions({
    list: [
      { symbol: 'BTCUSDT', side: 'Buy', size: '0.5', avgPrice: '90000', markPrice: '91000', leverage: '3', unrealisedPnl: '500', positionValue: '45500', takeProfit: '95000', stopLoss: '88000', liqPrice: '70000' },
      { symbol: 'ETHUSDT', side: 'Sell', size: '0', avgPrice: '0', markPrice: '3000' },
    ],
  });
  assert.equal(positions.length, 1);
  assert.equal(positions[0].side, 'long');
  assert.equal(positions[0].unrealizedPnl, 500);
});

test('保護單狀態：缺 SL 是最高等級警示', () => {
  assert.equal(protectionStatus({ takeProfit: 1, stopLoss: 1 }).level, 'ok');
  assert.equal(protectionStatus({ takeProfit: 0, stopLoss: 1 }).level, 'warn');
  assert.equal(protectionStatus({ takeProfit: 1, stopLoss: 0 }).level, 'danger');
  assert.equal(protectionStatus({ takeProfit: 0, stopLoss: 0 }).level, 'danger');
  assert.match(protectionStatus({ takeProfit: 1, stopLoss: 0 }).text, /缺 SL/);
});

test('已平倉紀錄與當日損益', () => {
  const now = Date.now();
  const rows = parseClosedPnl({
    list: [
      { symbol: 'SOLUSDT', side: 'Sell', closedPnl: '25.5', avgEntryPrice: '200', avgExitPrice: '206', closedSize: '5', leverage: '3', createdTime: String(now - 1000) },
      { symbol: 'BTCUSDT', side: 'Sell', closedPnl: '-10', avgEntryPrice: '90000', avgExitPrice: '89000', closedSize: '0.1', leverage: '3', createdTime: String(now - 86_400_000 * 2) },
    ],
  });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].side, 'long', 'Bybit 記錄平倉方向，要轉回開倉方向');
  const today = realizedPnlSince(rows, now - 86_400_000);
  assert.equal(today.count, 1);
  assert.equal(today.total, 25.5);
  assert.deepEqual(realizedPnlSince([], 0), { total: 0, count: 0 });
});

test('API Key 遮罩，永遠不顯示完整值', () => {
  assert.equal(maskApiKey('ABCD1234EFGH5678'), 'ABCD••••5678');
  assert.equal(maskApiKey('short'), '••••');
  assert.equal(maskApiKey(''), '••••');
  assert.equal(maskApiKey(null), '••••');
});
