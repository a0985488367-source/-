import test from 'node:test';
import assert from 'node:assert/strict';
import { rebuildTrades, summarize, strategyOf } from '../scripts/lib/demo-trades.mjs';

const fill = (symbol, side, qty, price, time, extra = {}) => ({ symbol, side, execQty: qty, execPrice: price, execFee: 0.1, execTime: time, execType: 'Trade', ...extra });

test('strategyOf：依 signal_id 前綴分策略', () => {
  assert.equal(strategyOf('bo:TRX:s:4h:abc'), 'breakout');
  assert.equal(strategyOf('bo:TRXUSDT:short:4h:1790467200000'), 'breakout');
  assert.equal(strategyOf('ema:ETH:l:4h:x'), 'ema');
  assert.equal(strategyOf('macd:SOL:l:6h:x'), 'macd');
  assert.equal(strategyOf('fo:ATOM:s:4h:x'), 'fakeout');
  assert.equal(strategyOf('BTCUSDT:long:1h:85681.83'), 'smc');
  assert.equal(strategyOf(''), 'manual');
});

test('rebuildTrades：分批出場算成同一筆，損益扣手續費；區間前就開著的部位略過', () => {
  const ex = [
    fill('ETHUSDT', 'Sell', 1, 2000, 1, { closedSize: 1 }), // 區間前的部位在平倉 → 略過
    fill('BTCUSDT', 'Buy', 2, 100, 10, { orderLinkId: 'BTCUSDT:long:1h:100' }),
    fill('BTCUSDT', 'Sell', 1, 110, 20, { closedSize: 1 }),   // TP1 +10
    fill('BTCUSDT', 'Sell', 1, 95, 30, { closedSize: 1 }),    // 停損 −5
    fill('SOLUSDT', 'Sell', 3, 50, 40, { orderLinkId: 'bo:SOL:s:4h:abc' }),
    fill('SOLUSDT', 'Buy', 3, 48, 50, { closedSize: 3 }),      // +6
    fill('ADAUSDT', 'Buy', 1, 1, 60, { orderLinkId: 'ema:ADA:l:4h:x' }), // 還開著
  ];
  const { trades, stillOpen } = rebuildTrades(ex);
  assert.equal(trades.length, 2);
  const btc = trades.find((t) => t.symbol === 'BTCUSDT');
  assert.equal(btc.strategy, 'smc');
  assert.ok(Math.abs(btc.pnl - (10 - 5 - 0.3)) < 1e-9);
  const sol = trades.find((t) => t.symbol === 'SOLUSDT');
  assert.equal(sol.strategy, 'breakout');
  assert.equal(sol.dir, 'short');
  assert.ok(Math.abs(sol.pnl - (6 - 0.2)) < 1e-9);
  assert.equal(stillOpen.length, 1);

  const s = summarize(trades);
  assert.equal(s.n, 2);
  assert.equal(s.winRate, 1);
  assert.ok(Math.abs(s.net - (4.7 + 5.8)) < 1e-9);
});
