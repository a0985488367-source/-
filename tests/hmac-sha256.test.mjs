import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { fromHex, hmacSha256Hex, sha256, toHex, utf8Bytes } from '../app/hmac-sha256.js';

test('SHA-256 對照 NIST 標準向量', () => {
  assert.equal(toHex(sha256(utf8Bytes(''))),
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(toHex(sha256(utf8Bytes('abc'))),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(toHex(sha256(utf8Bytes('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'))),
    '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');
});

test('SHA-256 對照 node:crypto，涵蓋各種補位邊界長度', () => {
  for (const len of [0, 1, 55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 1000, 5000]) {
    const data = Buffer.alloc(len);
    for (let i = 0; i < len; i += 1) data[i] = (i * 37 + 11) & 0xff;
    const mine = toHex(sha256(new Uint8Array(data)));
    const theirs = createHash('sha256').update(data).digest('hex');
    assert.equal(mine, theirs, `長度 ${len} 不一致`);
  }
});

test('HMAC-SHA256 對照 RFC 4231 測試向量', () => {
  // Case 1
  assert.equal(
    hmacSha256Hex(fromHex('0b'.repeat(20)), utf8Bytes('Hi There')),
    'b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7',
  );
  // Case 2
  assert.equal(
    hmacSha256Hex('Jefe', 'what do ya want for nothing?'),
    '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843',
  );
  // Case 3
  assert.equal(
    hmacSha256Hex(fromHex('aa'.repeat(20)), fromHex('dd'.repeat(50))),
    '773ea91e36800e46854db8ebd09181a72959098b3ef8c122d9635514ced565fe',
  );
  // Case 6：金鑰長度超過區塊大小，需先雜湊
  assert.equal(
    hmacSha256Hex(fromHex('aa'.repeat(131)),
      utf8Bytes('Test Using Larger Than Block-Size Key - Hash Key First')),
    '60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54',
  );
});

test('HMAC-SHA256 對照 node:crypto，涵蓋各種金鑰與訊息長度', () => {
  for (const keyLen of [0, 1, 32, 63, 64, 65, 200]) {
    for (const msgLen of [0, 1, 55, 64, 100, 1000]) {
      const key = Buffer.alloc(keyLen);
      for (let i = 0; i < keyLen; i += 1) key[i] = (i * 13 + 7) & 0xff;
      const msg = Buffer.alloc(msgLen);
      for (let i = 0; i < msgLen; i += 1) msg[i] = (i * 29 + 3) & 0xff;

      const mine = hmacSha256Hex(new Uint8Array(key), new Uint8Array(msg));
      const theirs = createHmac('sha256', key).update(msg).digest('hex');
      assert.equal(mine, theirs, `金鑰 ${keyLen} 訊息 ${msgLen} 不一致`);
    }
  }
});

test('UTF-8 編碼處理中文與表情符號', () => {
  for (const s of ['abc', '快噴掃描', 'BTC 突破 🚀', '🇹🇼', 'é中𝄞']) {
    assert.deepEqual(Array.from(utf8Bytes(s)), Array.from(Buffer.from(s, 'utf8')), s);
  }
});

test('中文訊息的 HMAC 與 node:crypto 一致', () => {
  const key = '測試金鑰-not-a-real-secret';
  const msg = '1700000000000abcdef5000category=linear&symbol=BTCUSDT';
  assert.equal(hmacSha256Hex(key, msg), createHmac('sha256', key).update(msg, 'utf8').digest('hex'));
});

test('十六進位轉換來回一致', () => {
  const bytes = new Uint8Array([0, 1, 15, 16, 127, 128, 255]);
  assert.equal(toHex(bytes), '00010f107f80ff');
  assert.deepEqual(Array.from(fromHex('00010f107f80ff')), Array.from(bytes));
});
