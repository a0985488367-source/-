import test from 'node:test';
import assert from 'node:assert/strict';
import { attributeClosedPnl, ledgerByWindow } from '../scripts/lib/demo-ledger.mjs';

const ex = (o) => ({ execType: 'Trade', execQty: 1, closedSize: 0, execFee: 0, orderLinkId: '', ...o });

test('已平倉損益依同幣最近一次開倉的 orderLinkId 分策略，找不到算不明', () => {
  const executions = [
    ex({ symbol: 'BTCUSDT', execTime: 100, orderLinkId: 'st:BTC:l:4h:x' }),
    ex({ symbol: 'BTCUSDT', execTime: 200, closedSize: 1 }),
    ex({ symbol: 'BTCUSDT', execTime: 300 }), // 手動
    ex({ symbol: 'BTCUSDT', execTime: 400, closedSize: 1 }),
  ];
  const closed = [
    { symbol: 'BTCUSDT', updatedTime: 200, closedPnl: 10 },
    { symbol: 'BTCUSDT', updatedTime: 400, closedPnl: -5 },
    { symbol: 'ETHUSDT', updatedTime: 400, closedPnl: -7 },
  ];
  assert.deepEqual(attributeClosedPnl(executions, closed).map((p) => p.strategy), ['st', 'manual', 'unknown']);
});

test('每段餘額變化拆成已平倉＋資金費＋對不上', () => {
  const executions = [
    ex({ symbol: 'ETHUSDT', execTime: 150, orderLinkId: 'gc:ETH:s:6h:x' }),
    { symbol: 'ETHUSDT', execType: 'Funding', execTime: 160, execFee: 2, execQty: 0 },
    { symbol: 'ETHUSDT', execType: 'BustTrade', execTime: 170, execFee: 0, execQty: 1 },
  ];
  const closedPnl = [{ symbol: 'ETHUSDT', createdTime: 90, updatedTime: 180, closedPnl: -30 }];
  const [r] = ledgerByWindow({ executions, closedPnl, snapshots: [{ time: 100, balance: 1000 }, { time: 200, balance: 900 }] });
  assert.equal(r.change, -100);
  assert.equal(r.closed, -30);
  assert.equal(r.funding, -2);
  assert.equal(r.unexplained, -68);
  assert.deepEqual(r.byStrategy, { gc: -30 });
  assert.deepEqual(r.special, { BustTrade: 1 });
});
