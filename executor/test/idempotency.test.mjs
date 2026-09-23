import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { IdempotencyStore } from '../src/idempotency.js';

function tmpStorePath() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'idem-test-')), 'store.json');
}

test('沒處理過的 signal_id：has 是 false，get 是 undefined', () => {
  const store = new IdempotencyStore(tmpStorePath());
  assert.equal(store.has('sig-1'), false);
  assert.equal(store.get('sig-1'), undefined);
});

test('set 之後 has 變 true，get 拿得到當初存的結果', () => {
  const store = new IdempotencyStore(tmpStorePath());
  store.set('sig-1', { orderId: 'abc' });
  assert.equal(store.has('sig-1'), true);
  assert.deepEqual(store.get('sig-1'), { orderId: 'abc' });
});

test('失敗的結果也要記住，不會因為是 error 就沒被視為「已處理過」', () => {
  const store = new IdempotencyStore(tmpStorePath());
  store.set('sig-1', { error: '保證金不足' });
  assert.equal(store.has('sig-1'), true);
  assert.deepEqual(store.get('sig-1'), { error: '保證金不足' });
});

test('重啟後（重新從磁碟載入）還記得處理過的 signal_id', () => {
  const p = tmpStorePath();
  const store1 = new IdempotencyStore(p);
  store1.set('sig-1', { orderId: 'abc' });

  const store2 = new IdempotencyStore(p); // 模擬程序重啟，重新從同一個檔案載入
  assert.equal(store2.has('sig-1'), true);
  assert.deepEqual(store2.get('sig-1'), { orderId: 'abc' });
});

test('檔案不存在時不會噴例外，當作空的開始', () => {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'idem-test-')), 'nope.json');
  assert.doesNotThrow(() => new IdempotencyStore(p));
});
