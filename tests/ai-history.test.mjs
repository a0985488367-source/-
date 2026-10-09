import test from 'node:test';
import assert from 'node:assert/strict';
import { needFullSnapshot, validChat, chatsToPrune, agoZh, FULL_SNAPSHOT_EVERY_MS } from '../src/radar/ai-history.js';

test('完整快照：新對話一定附；追問時上次完整快照太舊就再附一次', () => {
  const now = Date.UTC(2026, 9, 9, 3);
  assert.equal(needFullSnapshot({ messages: [] }, now), true);
  assert.equal(needFullSnapshot(null, now), true);
  const msgs = [{ role: 'user', content: 'a' }, { role: 'assistant', content: [] }];
  assert.equal(needFullSnapshot({ messages: msgs, lastFullAt: now - 60_000 }, now), false);
  assert.equal(needFullSnapshot({ messages: msgs, lastFullAt: now - FULL_SNAPSHOT_EVERY_MS - 1 }, now), true);
  assert.equal(needFullSnapshot({ messages: msgs }, now), true, '舊紀錄沒有時間就當太舊');
});

test('紀錄格式壞掉就不用', () => {
  assert.ok(validChat({ symbol: 'BTCUSDT', messages: [], view: [{ k: 'user', text: 'hi' }, { k: 'ai', text: 'yo', meta: 'x' }] }));
  assert.ok(!validChat(null));
  assert.ok(!validChat({ symbol: 'BTCUSDT', messages: 'x', view: [] }));
  assert.ok(!validChat({ symbol: 'BTCUSDT', messages: [], view: [{ k: 'sys', text: 'x' }] }));
});

test('清舊紀錄：超過保存天數、或超過幾個幣時最舊的要刪', () => {
  const now = Date.UTC(2026, 9, 9);
  const day = 864e5;
  const chats = [
    { symbol: 'A', updated: now - 1 * day },
    { symbol: 'B', updated: now - 20 * day },
    { symbol: 'C', updated: now - 2 * day },
    { symbol: 'D', updated: now - 3 * day },
    { symbol: 'E' },
  ];
  assert.deepEqual(chatsToPrune(chats, now, { keepDays: 14, keepCount: 2 }).sort(), ['B', 'D', 'E']);
  assert.deepEqual(chatsToPrune(chats.slice(0, 1), now), []);
});

test('多久以前', () => {
  const now = Date.UTC(2026, 9, 9, 12);
  assert.equal(agoZh(now - 10_000, now), '剛剛');
  assert.equal(agoZh(now - 5 * 60_000, now), '5 分鐘前');
  assert.equal(agoZh(now - 3 * 3600e3, now), '3 小時前');
  assert.equal(agoZh(now - 3 * 864e5, now), '3 天前');
});
