import test from 'node:test';
import assert from 'node:assert/strict';
import { pickScanUniverse, runMarketScan, marketSnapshot, marketUserMessage, SCAN_TFS } from '../src/radar/market-scan.js';

const MS = { '1h': 36e5, '4h': 144e5, '6h': 216e5, '1d': 864e5, '1w': 6048e5 };

/** 固定種子的 1h 隨機漫步（drift 決定趨勢方向），合成各週期 */
function makeTfs(seed, drift) {
  let s = seed >>> 0;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
  const start = Date.UTC(2025, 0, 6);
  const h1 = [];
  let price = 100;
  for (let i = 0; i < 24 * 7 * 60; i++) {
    const open = price;
    const close = open * (1 + drift + (rnd() - 0.5) * 0.01);
    h1.push({ time: start + i * MS['1h'], open, high: Math.max(open, close) * (1 + rnd() * 0.004), low: Math.min(open, close) * (1 - rnd() * 0.004), close, volume: 1000 + rnd() * 9000 });
    price = close;
  }
  const agg = (ms) => {
    const out = [];
    for (const c of h1) {
      const t = ms === MS['1w'] ? Math.floor((c.time - 4 * 864e5) / ms) * ms + 4 * 864e5 : Math.floor(c.time / ms) * ms;
      const last = out[out.length - 1];
      if (!last || last.time !== t) out.push({ ...c, time: t });
      else { last.high = Math.max(last.high, c.high); last.low = Math.min(last.low, c.low); last.close = c.close; last.volume += c.volume; }
    }
    return out;
  };
  return { '1h': h1.slice(-500), '4h': agg(MS['4h']).slice(-500), '6h': agg(MS['6h']).slice(-500), '1d': agg(MS['1d']), '1w': agg(MS['1w']) };
}

test('掃描範圍：照成交額排、去掉穩定幣和成交額 0 的', () => {
  const u = pickScanUniverse([
    { symbol: 'BTCUSDT', turnover: 9e9 }, { symbol: 'USDCUSDT', turnover: 8e9 }, { symbol: 'ETHUSDT', turnover: 7e9 },
    { symbol: 'DEADUSDT', turnover: 0 }, { symbol: 'SOLUSDT', turnover: 5e9 }, { symbol: 'BTCPERP', turnover: 9e10 },
  ], 2);
  assert.deepEqual(u.map((x) => x.symbol), ['BTCUSDT', 'ETHUSDT']);
});

test('全市場掃描：上漲趨勢的幣判多、下跌的判空，排序用機會分數；抓不到的列出來', async () => {
  const data = { UPUSDT: makeTfs(1, 0.0012), DOWNUSDT: makeTfs(2, -0.0012), FLATUSDT: makeTfs(3, 0) };
  const tickers = [
    ...Object.keys(data).map((symbol, i) => ({ symbol, price: data[symbol]['1h'].at(-1).close, change: 1, turnover: 1e9 - i, funding: 0.0001 })),
    { symbol: 'BADUSDT', price: 1, change: 0, turnover: 1e6 },
  ];
  const progress = [];
  const scan = await runMarketScan({
    fetchTickers: async () => tickers,
    fetchKlines: async (sym, tf) => { if (!data[sym]) throw new Error('404'); assert.ok(SCAN_TFS.includes(tf)); return data[sym][tf]; },
    onProgress: (d, n) => progress.push(`${d}/${n}`),
  });
  assert.equal(scan.universe, 4);
  assert.deepEqual(scan.failed, ['BADUSDT']);
  assert.equal(progress.at(-1), '4/4');
  const by = Object.fromEntries(scan.rows.map((r) => [r.symbol, r]));
  assert.equal(by.UPUSDT.dir, 'long');
  assert.equal(by.DOWNUSDT.dir, 'short');
  assert.ok(scan.rows.every((r, i) => i === 0 || r.score <= scan.rows[i - 1].score), '照分數排');
  assert.ok(by.UPUSDT.score > by.FLATUSDT.score && by.DOWNUSDT.score > by.FLATUSDT.score, '有趨勢的分數比盤整高');

  const snap = marketSnapshot(scan, { topN: 2 });
  assert.equal(snap.top.length, 2);
  assert.equal(snap.rest.length, 1);
  assert.match(snap.scanned, /抓不到：BADUSDT/);
  assert.ok(snap.top.every((x) => !/USDT$/.test(x.symbol)));
  const msg = marketUserMessage(snap, ' 哪個幣最值得做？ ');
  assert.match(msg, /^<market_scan>\n\{/);
  assert.ok(msg.endsWith('</market_scan>\n\n哪個幣最值得做？'));
  assert.match(marketUserMessage(null, 'q'), /沿用前面的掃描/);
});
