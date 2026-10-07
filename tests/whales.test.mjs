import test from 'node:test';
import assert from 'node:assert/strict';
import { bigTradeThreshold, detectWalls, trackWalls, tradeStats, whaleVsCrowd } from '../src/radar/whales.js';

test('大額成交門檻：BTC／ETH 固定，其他依成交額，夾在 1 萬～20 萬', () => {
  assert.equal(bigTradeThreshold('BTCUSDT', 1e10), 500_000);
  assert.equal(bigTradeThreshold('ETHUSDT', 1e9), 200_000);
  assert.equal(bigTradeThreshold('PEPEUSDT', 1e6), 10_000);
  assert.equal(bigTradeThreshold('SOLUSDT', 5e8), 100_000);
  assert.equal(bigTradeThreshold('XRPUSDT', 1e11), 200_000);
});

test('大單牆：比附近大很多倍的掛單會被抓出來，買牆在現價下、賣牆在上', () => {
  const price = 100;
  const bids = [], asks = [];
  for (let i = 1; i <= 200; i++) {
    bids.push([price - i * 0.01, 10]);
    asks.push([price + i * 0.01, 10]);
  }
  bids.push([98.5, 2000]); // 買牆
  asks.push([101.2, 1500]); // 賣牆
  const walls = detectWalls({ bids, asks }, price, { binPct: 0.05, ratio: 5 });
  const bid = walls.find((w) => w.side === 'bid');
  const ask = walls.find((w) => w.side === 'ask');
  assert.ok(bid && Math.abs(bid.price - 98.5) < 0.06, JSON.stringify(walls));
  assert.ok(ask && Math.abs(ask.price - 101.2) < 0.06);
  assert.ok(bid.distPct < 0 && ask.distPct > 0);
  assert.ok(walls.every((w) => w.times >= 5));
});

test('大單牆追蹤：一直在的牆次數會累加，消失超過時間就忘掉', () => {
  const tr = new Map();
  const w = [{ side: 'bid', price: 98.5, notional: 2e5, times: 9, distPct: -1.5 }];
  trackWalls(tr, w, 1000);
  trackWalls(tr, [{ ...w[0], price: 98.52 }], 6000);
  const now = trackWalls(tr, [{ ...w[0], price: 98.49 }], 11000);
  assert.equal(now.length, 1);
  assert.equal(now[0].seenCount, 3);
  assert.equal(now[0].firstSeen, 1000);
  trackWalls(tr, [], 200_000);
  assert.equal(tr.size, 0);
});

test('成交統計：只把門檻以上的算大單，CVD＝主動買減主動賣', () => {
  const now = 10 * 60_000;
  const trades = [
    { time: now - 30_000, price: 100, qty: 2000, side: 'buy' }, // 20 萬 大單
    { time: now - 20_000, price: 100, qty: 10, side: 'sell' },
    { time: now - 10_000, price: 100, qty: 1500, side: 'sell' }, // 15 萬 大單
  ];
  const s = tradeStats(trades, 100_000, now);
  assert.equal(s.big.length, 2);
  assert.equal(s.big[0].side, 'sell'); // 新到舊
  assert.equal(s.windows[0].bigBuy, 200_000);
  assert.equal(s.windows[0].bigSell, 150_000);
  assert.equal(s.cvd.at(-1).value, 200_000 - 1_000 - 150_000);
});

test('大戶 vs 散戶：方向相反時給出提醒', () => {
  const r = whaleVsCrowd([{ time: 1, long: 0.5, short: 0.5 }, { time: 2, long: 0.6, short: 0.4 }], [{ time: 2, long: 0.42, short: 0.58 }]);
  assert.match(r.zh, /大戶偏多、散戶偏空/);
  assert.match(r.zh, /在加多/);
  assert.equal(whaleVsCrowd([], []), null);
});
