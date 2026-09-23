import test from 'node:test';
import assert from 'node:assert/strict';

process.env.BYBIT_API_KEY = 'k';
process.env.BYBIT_API_SECRET = 's';
process.env.EXECUTOR_HMAC_SECRET = 'a'.repeat(32);
process.env.REQUEST_MAX_AGE_SEC = '30';

const { verifyRequest, signRequest } = await import('../src/hmac.js');

test('簽章正確、時間在範圍內：驗證通過', () => {
  const ts = Date.now();
  const body = JSON.stringify({ foo: 'bar' });
  const sig = signRequest(ts, body);
  const result = verifyRequest(String(ts), sig, body);
  assert.equal(result.ok, true);
});

test('簽章不符：拒絕', () => {
  const ts = Date.now();
  const body = JSON.stringify({ foo: 'bar' });
  const result = verifyRequest(String(ts), 'deadbeef'.repeat(8), body);
  assert.equal(result.ok, false);
  assert.match(result.reason, /簽章不符/);
});

test('body 被竄改（簽章對應的是原本的 body）：拒絕', () => {
  const ts = Date.now();
  const sig = signRequest(ts, JSON.stringify({ foo: 'bar' }));
  const result = verifyRequest(String(ts), sig, JSON.stringify({ foo: 'baz' }));
  assert.equal(result.ok, false);
});

test('timestamp 太舊（超過 REQUEST_MAX_AGE_SEC）：判定為可能的重放攻擊，拒絕', () => {
  const ts = Date.now() - 60_000; // 60 秒前
  const body = '';
  const sig = signRequest(ts, body);
  const result = verifyRequest(String(ts), sig, body);
  assert.equal(result.ok, false);
  assert.match(result.reason, /timestamp/);
});

test('缺少標頭：拒絕', () => {
  const result = verifyRequest(undefined, undefined, '');
  assert.equal(result.ok, false);
});

test('timestamp 不是數字：拒絕', () => {
  const result = verifyRequest('not-a-number', 'abc', '');
  assert.equal(result.ok, false);
  assert.match(result.reason, /timestamp/);
});
