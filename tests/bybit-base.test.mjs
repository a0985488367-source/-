import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BYBIT_ENVIRONMENTS,
  ENV_LABEL,
  describeBybitError,
  normalizeEnv,
  privateHostFor,
  publicHostFor,
  sanitizeCredential,
} from '../app/bybit-base.js';

test('三個環境各自指向正確的私有端點主機', () => {
  assert.equal(privateHostFor('live'), 'https://api.bybit.com');
  assert.equal(privateHostFor('demo'), 'https://api-demo.bybit.com');
  assert.equal(privateHostFor('testnet'), 'https://api-testnet.bybit.com');
});

test('模擬交易共用正式站行情，測試網有自己的行情', () => {
  assert.equal(publicHostFor('demo'), 'https://api.bybit.com', 'Demo 沒有自己的行情');
  assert.equal(publicHostFor('live'), 'https://api.bybit.com');
  assert.equal(publicHostFor('testnet'), 'https://api-testnet.bybit.com');
});

test('未知環境一律退回正式站', () => {
  for (const bad of [undefined, null, '', 'mainnet', 'prod', 123]) {
    assert.equal(normalizeEnv(bad), 'live');
    assert.equal(privateHostFor(bad), 'https://api.bybit.com');
  }
  for (const env of BYBIT_ENVIRONMENTS) {
    assert.equal(normalizeEnv(env), env);
    assert.ok(ENV_LABEL[env], `${env} 應有中文標籤`);
  }
});

test('憑證清理會移除貼上時夾帶的不可見字元', () => {
  assert.equal(sanitizeCredential('  abc123  '), 'abc123');
  assert.equal(sanitizeCredential('abc\n123'), 'abc123');
  assert.equal(sanitizeCredential('abc\t123'), 'abc123');
  assert.equal(sanitizeCredential('abc 123'), 'abc123', '不斷行空格');
  assert.equal(sanitizeCredential('abc​123'), 'abc123', '零寬空格');
  assert.equal(sanitizeCredential('﻿abc123'), 'abc123', 'BOM');
  assert.equal(sanitizeCredential('a b‍c⁠ 1'), 'abc1');
  assert.equal(sanitizeCredential(null), '');
  assert.equal(sanitizeCredential(undefined), '');
});

test('憑證清理不會動到合法字元', () => {
  const key = 'AbCd1234-_efGH5678';
  assert.equal(sanitizeCredential(key), key);
});

test('10003 明確指出環境選錯是最常見原因', () => {
  const msg = describeBybitError(10003, 'API key is invalid.', 'live');
  assert.match(msg, /正式站/);
  assert.match(msg, /環境選錯/);
  assert.match(msg, /模擬交易與測試網各自發自己的 Key/);
});

test('10003 的說明會反映目前選的環境', () => {
  assert.match(describeBybitError(10003, '', 'demo'), /模擬交易 Demo/);
  assert.match(describeBybitError(10003, '', 'testnet'), /測試網 Testnet/);
});

test('其他錯誤碼各有可執行的下一步', () => {
  assert.match(describeBybitError(10004, '', 'live'), /Secret/);
  assert.match(describeBybitError(10002, '', 'live'), /日期與時間/);
  assert.match(describeBybitError(10005, '', 'live'), /唯讀權限/);
  assert.match(describeBybitError(10010, '', 'live'), /IP 白名單/);
  assert.match(describeBybitError(10018, '', 'live'), /頻率過高/);
  assert.match(describeBybitError(30086, '', 'live'), /統一帳戶/);
});

test('未知錯誤碼照實回報，不亂猜原因', () => {
  const msg = describeBybitError(99999, 'something odd', 'live');
  assert.match(msg, /99999/);
  assert.match(msg, /something odd/);
  assert.doesNotMatch(msg, /請確認|請檢查/, '沒把握就不要給誤導性的建議');
});
