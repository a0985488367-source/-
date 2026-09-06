import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertNoSecrets,
  entrySlippagePct,
  inferExitReason,
  journalKey,
  loadRecords,
  openRecord,
  protectionQty,
  reconcile,
  saveRecord,
  slippageBySymbol,
  summarize,
} from '../app/trade-journal.ts';

const SNAPSHOT = Object.freeze({
  capturedAt: '2026-09-06T00:00:00.000Z',
  source: 'main-signal',
  symbol: 'SOLUSDT',
  side: 'Buy',
  grade: 'A',
  directionScore: 88,
  displayScore: 88,
  gateSummary: [{ id: 'volume-multiple', passed: true, actual: 1.42 }],
  intendedEntry: 200,
  intendedStop: 196,
  intendedTp1: 206,
  intendedTp2: 210,
  riskPercent: 0.25,
  sizingReason: 'A 級 85～89 分',
  isMeme: false,
  tradeMode: 'demo',
  workerVersion: '10.0',
});

function open(overrides = {}) {
  return openRecord({
    snapshot: { ...SNAPSHOT, ...(overrides.snapshot ?? {}) },
    orderId: overrides.orderId ?? 'order-1',
    requestedQty: overrides.requestedQty ?? 10,
    openedAt: overrides.openedAt ?? '2026-09-06T00:00:01.000Z',
  });
}

test('快噴候選不得產生自動交易紀錄', () => {
  assert.throws(() => open({ snapshot: { source: 'moonshot' } }), /快噴候選不得產生自動交易紀錄/);
});

test('進場滑價：買單成交價高於預期為正值（不利）', () => {
  assert.equal(entrySlippagePct(200, 200.4, 'Buy').toFixed(3), '0.200');
  assert.equal(entrySlippagePct(200, 199.6, 'Buy').toFixed(3), '-0.200');
});

test('進場滑價：賣單成交價低於預期為正值（不利）', () => {
  assert.equal(entrySlippagePct(200, 199.6, 'Sell').toFixed(3), '0.200');
  assert.equal(entrySlippagePct(200, 200.4, 'Sell').toFixed(3), '-0.200');
});

test('進場滑價：資料無效時回傳 null 而不是猜測值', () => {
  assert.equal(entrySlippagePct(0, 100, 'Buy'), null);
  assert.equal(entrySlippagePct(100, Number.NaN, 'Buy'), null);
});

test('對帳：由 Bybit 成交明細算出實際均價、滑價與 R 倍數', () => {
  const closed = reconcile(open(), {
    closedAt: '2026-09-06T02:00:00.000Z',
    executions: [
      { execTime: 't1', price: 200.0, qty: 5, fee: 0.1, side: 'Buy', execType: 'Trade' },
      { execTime: 't2', price: 200.8, qty: 5, fee: 0.1, side: 'Buy', execType: 'Trade' },
      { execTime: 't3', price: 206.0, qty: 10, fee: 0.2, side: 'Sell', execType: 'Trade' },
      { execTime: 't4', price: 0, qty: 0, fee: 0.05, side: 'Buy', execType: 'Funding' },
    ],
    closedPnl: {
      symbol: 'SOLUSDT', side: 'Buy', avgEntryPrice: 200.4, avgExitPrice: 206,
      closedSize: 10, closedPnl: 56, createdTime: 't3',
    },
  });
  assert.equal(closed.status, 'closed');
  assert.equal(closed.actualEntryPrice, 200.4);
  assert.equal(closed.actualExitPrice, 206);
  assert.equal(closed.filledQty, 10);
  assert.equal(closed.entrySlippagePct.toFixed(3), '0.200');
  assert.equal(closed.totalFees.toFixed(2), '0.40');
  assert.equal(closed.fundingPaid, 0.05);
  assert.equal(closed.rMultiple, 56 / (4 * 10));
  assert.equal(closed.partiallyFilled, false);
  assert.deepEqual(closed.dataGaps, []);
});

test('對帳：資料缺漏時記入 dataGaps 而不是填推測值', () => {
  const closed = reconcile(open(), {
    closedAt: '2026-09-06T02:00:00.000Z',
    executions: [],
    closedPnl: null,
  });
  assert.equal(closed.actualEntryPrice, null);
  assert.equal(closed.realizedPnl, null);
  assert.equal(closed.rMultiple, null);
  assert.equal(closed.exitReason, 'unknown');
  assert.ok(closed.dataGaps.includes('缺少 Bybit 已平倉紀錄'));
  assert.ok(closed.dataGaps.includes('缺少進場成交價'));
});

test('對帳：偵測部分成交', () => {
  const closed = reconcile(open({ requestedQty: 10 }), {
    closedAt: '2026-09-06T02:00:00.000Z',
    executions: [
      { execTime: 't1', price: 200, qty: 4, fee: 0.1, side: 'Buy', execType: 'Trade' },
      { execTime: 't2', price: 206, qty: 4, fee: 0.1, side: 'Sell', execType: 'Trade' },
    ],
    closedPnl: {
      symbol: 'SOLUSDT', side: 'Buy', avgEntryPrice: 200, avgExitPrice: 206,
      closedSize: 4, closedPnl: 24, createdTime: 't2',
    },
  });
  assert.equal(closed.partiallyFilled, true);
  assert.equal(closed.filledQty, 4);
});

test('出場原因：明確的觸發旗標優先於價格推斷', () => {
  const base = { closedAt: 't', executions: [], closedPnl: null };
  assert.equal(inferExitReason(196, SNAPSHOT, { ...base, protectionTriggered: { tp1: true } }), 'tp1');
  assert.equal(inferExitReason(206, SNAPSHOT, { ...base, protectionTriggered: { stop: true } }), 'stop');
  assert.equal(inferExitReason(206, SNAPSHOT, { ...base, emergencyLockEngaged: true }), 'emergency');
});

test('出場原因：價格落在容差外時回傳 unknown，不猜測', () => {
  const base = { closedAt: 't', executions: [], closedPnl: null };
  assert.equal(inferExitReason(206.05, SNAPSHOT, base), 'tp1');
  assert.equal(inferExitReason(203, SNAPSHOT, base), 'unknown');
  assert.equal(inferExitReason(null, SNAPSHOT, base), 'unknown');
});

test('保護單數量必須跟隨回查到的實際持倉', () => {
  assert.equal(protectionQty(6), 6);
  assert.equal(protectionQty(0), null, '零持倉不得掛保護單');
  assert.equal(protectionQty(null), null, '回查不到就視為保護失敗');
  assert.equal(protectionQty(undefined), null);
  assert.equal(protectionQty(Number.NaN), null);
});

test('日誌不得包含任何金鑰或 Token', () => {
  assert.throws(() => assertNoSecrets({ apiKey: 'x' }), /敏感欄位/);
  assert.throws(() => assertNoSecrets({ nested: { apiSecret: 'x' } }), /敏感欄位/);
  assert.throws(() => assertNoSecrets({ list: [{ webhookUrl: 'x' }] }), /敏感欄位/);
  assert.throws(() => assertNoSecrets({ Authorization: 'Bearer x' }), /敏感欄位/);
  assert.doesNotThrow(() => assertNoSecrets(open()));
});

test('儲存層：寫入後可依狀態讀回', async () => {
  const kv = new Map();
  const store = {
    put: async (k, v) => { kv.set(k, v); },
    get: async (k) => kv.get(k) ?? null,
    list: async ({ prefix }) => ({ keys: [...kv.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })) }),
  };
  const record = open();
  await saveRecord(store, record);
  assert.ok(journalKey(record).includes('open'));
  const loaded = await loadRecords(store, 'open');
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].orderId, 'order-1');
  assert.equal((await loadRecords(store, 'closed')).length, 0);
});

test('儲存層：含金鑰的紀錄會被擋在寫入之前', async () => {
  const store = { put: async () => { throw new Error('不該寫入'); }, get: async () => null, list: async () => ({ keys: [] }) };
  const bad = { ...open(), apiSecret: 'leak' };
  await assert.rejects(() => saveRecord(store, bad), /敏感欄位/);
});

test('統計：滙總真實 PnL、滑價與出場原因分布', () => {
  const mk = (symbol, slip, r, reason) => ({
    ...open({ snapshot: { symbol } }),
    status: 'closed', closedAt: 't',
    actualEntryPrice: 100, actualExitPrice: 105, filledQty: 1,
    entrySlippagePct: slip, realizedPnl: r * 4, totalFees: 0.1, fundingPaid: 0,
    rMultiple: r, exitReason: reason, partiallyFilled: false, dataGaps: [],
  });
  const stats = summarize([
    mk('SOLUSDT', 0.2, 1.5, 'tp1'),
    mk('SOLUSDT', 0.4, -1, 'stop'),
    mk('BTCUSDT', 0.0, 2.5, 'tp2'),
  ]);
  assert.equal(stats.count, 3);
  assert.equal(stats.avgEntrySlippagePct.toFixed(4), '0.2000');
  assert.equal(stats.exitReasonCounts.tp1, 1);
  assert.equal(stats.exitReasonCounts.stop, 1);
  assert.equal(stats.exitReasonCounts.tp2, 1);
  assert.equal(stats.recordsWithGaps, 0);

  const bySymbol = slippageBySymbol([mk('SOLUSDT', 0.2, 1, 'tp1'), mk('SOLUSDT', 0.4, 1, 'tp1')]);
  assert.equal(bySymbol.get('SOLUSDT').toFixed(4), '0.3000');
});
