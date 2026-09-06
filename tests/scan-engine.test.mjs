import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BLOWN_OFF,
  ENTRY,
  MAX_DISPLAYED,
  PROVIDER,
  UNIVERSE,
  assessDepth,
  blownOffReasons,
  buildCandidate,
  buildTargets,
  buildUniverse,
  bybitContractUrl,
  checkInvariants,
  classifyMeme,
  computeMetrics,
  computeScore,
  deriveStage,
  evaluateEntryGates,
  maxTolerablePositionUsd,
  parseKlines,
  parseOpenInterest,
  parseOrderbook,
  passesUniverseFilter,
  rankCandidates,
  suggestStop,
} from '../app/scan-engine.js';

/* --- Bybit 回應格式的最小樣本（欄位名稱與型別依照 v5 文件） --- */

const INSTRUMENTS = [
  { symbol: 'BTCUSDT', quoteCoin: 'USDT', contractType: 'LinearPerpetual', status: 'Trading', launchTime: '1585555200000' },
  { symbol: 'ABCUSDT', quoteCoin: 'USDT', contractType: 'LinearPerpetual', status: 'Trading', launchTime: '1700000000000' },
  { symbol: 'ETHUSDC', quoteCoin: 'USDC', contractType: 'LinearPerpetual', status: 'Trading', launchTime: '1585555200000' },
  { symbol: 'BTCUSD', quoteCoin: 'USD', contractType: 'InversePerpetual', status: 'Trading', launchTime: '1585555200000' },
  { symbol: 'USDCUSDT', quoteCoin: 'USDT', contractType: 'LinearPerpetual', status: 'Trading', launchTime: '1585555200000' },
  { symbol: 'OLDUSDT', quoteCoin: 'USDT', contractType: 'LinearPerpetual', status: 'Closed', launchTime: '1585555200000' },
];

const TICKERS = [
  { symbol: 'BTCUSDT', lastPrice: '90000', bid1Price: '89995', ask1Price: '90005', highPrice24h: '91000', lowPrice24h: '88000', turnover24h: '900000000', openInterestValue: '500000000', price24hPcnt: '0.02', fundingRate: '0.0001' },
  { symbol: 'ABCUSDT', lastPrice: '100', bid1Price: '99.95', ask1Price: '100.05', highPrice24h: '104', lowPrice24h: '96', turnover24h: '5000000', openInterestValue: '2000000', price24hPcnt: '0.03', fundingRate: '0.0001' },
  { symbol: 'ETHUSDC', lastPrice: '3000', bid1Price: '2999', ask1Price: '3001', highPrice24h: '3100', lowPrice24h: '2900', turnover24h: '1000000', openInterestValue: '1000000', price24hPcnt: '0.01', fundingRate: '0.0001' },
  { symbol: 'USDCUSDT', lastPrice: '1', bid1Price: '0.9999', ask1Price: '1.0001', highPrice24h: '1.001', lowPrice24h: '0.999', turnover24h: '9000000', openInterestValue: '9000000', price24hPcnt: '0.0001', fundingRate: '0' },
];

const NOW = Date.parse('2026-09-06T00:00:00Z');

/** 產生一段 15m K 線：先橫盤壓縮，最後貼近前高，量能溫和放大 */
function makeKlines({ base = 100, count = 40, compress = true, volumeMultiple = 1.6, finalClose = 99.1 } = {}) {
  const out = [];
  const startT = NOW - count * 15 * 60_000;
  for (let i = 0; i < count; i += 1) {
    const late = i >= count - 8;
    const spread = compress && late ? 0.15 : 0.6;
    const close = i === count - 1 ? finalClose : base + Math.sin(i / 3) * 0.3;
    const vol = late && i >= count - 3 ? 1000 * volumeMultiple : 1000;
    out.push([
      String(startT + i * 15 * 60_000),
      String(close),
      String(close + spread),
      String(close - spread),
      String(close),
      String(vol),
      '0',
    ]);
  }
  // Bybit 回傳是新到舊
  return out.reverse();
}

function makeOi(changePct = 1.2) {
  const start = 1_000_000;
  return [4, 3, 2, 1, 0].map((back) => ({
    timestamp: String(NOW - back * 15 * 60_000),
    openInterest: String(start * (1 + (changePct / 100) * ((4 - back) / 4))),
  }));
}

const ORDERBOOK = { b: [['99.9', '500'], ['99.7', '800']], a: [['100.1', '400'], ['100.3', '700']] };

/* ------------------------------------------------------------------ */

test('宇宙建構：只保留 Bybit USDT 線性永續，排除穩定幣與非交易中', () => {
  const rows = buildUniverse(INSTRUMENTS, TICKERS, NOW);
  const symbols = rows.map((r) => r.symbol);
  assert.ok(symbols.includes('BTCUSDT'));
  assert.ok(symbols.includes('ABCUSDT'));
  assert.ok(!symbols.includes('ETHUSDC'), 'USDC 計價要排除');
  assert.ok(!symbols.includes('BTCUSD'), '反向合約要排除');
  assert.ok(!symbols.includes('USDCUSDT'), '穩定幣要排除');
  assert.ok(!symbols.includes('OLDUSDT'), '非 Trading 狀態要排除');
});

test('宇宙建構：正確換算價差、區間位置與上線時間', () => {
  const row = buildUniverse(INSTRUMENTS, TICKERS, NOW).find((r) => r.symbol === 'ABCUSDT');
  assert.ok(Math.abs(row.spreadPct - 0.1) < 0.01);
  assert.ok(Math.abs(row.rangePosition24h - 0.5) < 1e-9);
  assert.equal(row.change24hPct, 3);
  assert.ok(row.listedHours > UNIVERSE.minListedHours);
});

test('第一階段門檻逐項生效', () => {
  const base = buildUniverse(INSTRUMENTS, TICKERS, NOW).find((r) => r.symbol === 'ABCUSDT');
  assert.equal(passesUniverseFilter(base), true);
  assert.equal(passesUniverseFilter({ ...base, turnover24hUsd: 400_000 }), false);
  assert.equal(passesUniverseFilter({ ...base, openInterestUsd: 90_000 }), false);
  assert.equal(passesUniverseFilter({ ...base, listedHours: 10 }), false);
  assert.equal(passesUniverseFilter({ ...base, spreadPct: 0.7 }), false);
  assert.equal(passesUniverseFilter({ ...base, change24hPct: 11 }), false);
  assert.equal(passesUniverseFilter({ ...base, change24hPct: -13 }), false);
  assert.equal(passesUniverseFilter({ ...base, rangePosition24h: 0.3 }), false);
  assert.equal(passesUniverseFilter({ ...base, rangePosition24h: 0.97 }), false);
  assert.equal(passesUniverseFilter({ ...base, spreadPct: NaN }), false, '缺資料要 fail-safe');
});

test('K 線解析：Bybit 新到舊要轉成舊到新', () => {
  const k = parseKlines(makeKlines());
  assert.equal(k.length, 40);
  for (let i = 1; i < k.length; i += 1) assert.ok(k[i].t > k[i - 1].t, '時間必須遞增');
});

test('未平倉量解析與變化率', () => {
  const oi = parseOpenInterest(makeOi(1.2));
  assert.equal(oi.length, 5);
  const m = computeMetrics(parseKlines(makeKlines()), oi);
  assert.ok(Math.abs(m.oiChangePct - 1.2) < 0.01);
});

test('指標計算：壓縮比在收斂盤下小於 1', () => {
  const m = computeMetrics(parseKlines(makeKlines({ compress: true })), parseOpenInterest(makeOi()));
  assert.ok(m.compressionRatio < 1, `壓縮比為 ${m.compressionRatio}`);
});

test('指標計算：量能倍率反映最近放量', () => {
  const m = computeMetrics(parseKlines(makeKlines({ volumeMultiple: 1.6 })), parseOpenInterest(makeOi()));
  assert.ok(Math.abs(m.volumeMultiple - 1.6) < 0.05, `量能倍率為 ${m.volumeMultiple}`);
});

test('指標計算：資料不足時回傳 NaN 而不是亂算', () => {
  const m = computeMetrics([], []);
  assert.ok(Number.isNaN(m.compressionRatio));
  assert.ok(Number.isNaN(m.volumeMultiple));
  assert.ok(Number.isNaN(m.oiChangePct));
});

test('距突破點：價格在前高下方時為正值', () => {
  const m = computeMetrics(parseKlines(makeKlines({ finalClose: 99 })), parseOpenInterest(makeOi()));
  assert.ok(m.breakoutDistancePct > 0, `距突破點 ${m.breakoutDistancePct}`);
});

test('分數為 0 到 100 的整數，缺資料時為 0', () => {
  const m = computeMetrics(parseKlines(makeKlines()), parseOpenInterest(makeOi()));
  const s = computeScore(m);
  assert.ok(Number.isInteger(s) && s >= 0 && s <= 100, `分數 ${s}`);
  assert.equal(computeScore({}), 0);
});

test('等級推導：已突破過多一律 EXCLUDED', () => {
  assert.equal(deriveStage(95, { breakoutDistancePct: -2 }), 'EXCLUDED');
  assert.equal(deriveStage(95, { breakoutDistancePct: 1 }), 'NEAR_BREAKOUT');
  assert.equal(deriveStage(65, { breakoutDistancePct: 1 }), 'BUILDING');
  assert.equal(deriveStage(20, { breakoutDistancePct: 1 }), 'WATCH');
  assert.equal(deriveStage(95, {}), 'WATCH', '缺資料不得升級');
});

test('十道閘門：全部通過才 ready', () => {
  const ok = {
    score: 86, stage: 'NEAR_BREAKOUT', breakoutDistancePct: 0.9, compressionRatio: 0.7,
    volumeMultiple: 1.6, oiChangePct: 1.2, change1hPct: 0.8, change6hPct: 2,
    riskFlags: [], dataAgeMinutes: 4,
  };
  const ev = evaluateEntryGates(ok);
  assert.equal(ev.ready, true);
  assert.equal(ev.readiness.passed, 10);
  assert.equal(ev.reasons.length, 0);
});

test('十道閘門：逐項越界都會擋下並給出原因', () => {
  const ok = {
    score: 86, stage: 'NEAR_BREAKOUT', breakoutDistancePct: 0.9, compressionRatio: 0.7,
    volumeMultiple: 1.6, oiChangePct: 1.2, change1hPct: 0.8, change6hPct: 2,
    riskFlags: [], dataAgeMinutes: 4,
  };
  const cases = [
    ['score', 79], ['stage', 'WATCH'], ['breakoutDistancePct', 3],
    ['compressionRatio', 1.0], ['volumeMultiple', 1.0], ['oiChangePct', 0.1],
    ['change1hPct', 3], ['change6hPct', -4], ['dataAgeMinutes', 60],
  ];
  for (const [field, value] of cases) {
    const ev = evaluateEntryGates({ ...ok, [field]: value });
    assert.equal(ev.ready, false, `${field}=${value} 應擋下`);
    assert.ok(ev.reasons.length > 0);
  }
  assert.equal(evaluateEntryGates({ ...ok, riskFlags: ['薄盤'] }).ready, false);
});

test('閘門對 NaN 一律 fail-safe', () => {
  const ev = evaluateEntryGates({
    score: NaN, stage: 'NEAR_BREAKOUT', breakoutDistancePct: NaN, compressionRatio: NaN,
    volumeMultiple: NaN, oiChangePct: NaN, change1hPct: NaN, change6hPct: NaN,
    riskFlags: [], dataAgeMinutes: NaN,
  });
  assert.equal(ev.ready, false);
  assert.equal(ev.readiness.passed, 2, '只有等級與風險標記兩項會過');
});

test('已噴出的八種情形都會被列為排除原因', () => {
  const base = {
    change24hPct: 3, change1hPct: 0.8, change6hPct: 2, breakoutDistancePct: 0.9,
    volumeMultiple: 1.6, compressionRatio: 0.7, fundingRatePct: 0.01,
  };
  assert.equal(blownOffReasons(base).length, 0);
  const cases = [
    { change24hPct: 14 }, { change1hPct: 6 }, { change6hPct: 13 },
    { breakoutDistancePct: -3 }, { volumeMultiple: 7 }, { breakoutDistancePct: 6 },
    { compressionRatio: 1.5 }, { fundingRatePct: 0.4 },
  ];
  for (const patch of cases) {
    assert.ok(blownOffReasons({ ...base, ...patch }).length > 0, JSON.stringify(patch));
  }
});

test('端到端：乾淨的壓縮盤產生可進場候選並帶完整 TP／SL', () => {
  const row = buildUniverse(INSTRUMENTS, TICKERS, NOW).find((r) => r.symbol === 'ABCUSDT');
  const c = buildCandidate(
    row,
    parseKlines(makeKlines({ finalClose: 99.4, volumeMultiple: 1.6 })),
    parseOpenInterest(makeOi(1.2)),
    parseOrderbook(ORDERBOOK),
  );
  assert.equal(c.provider, PROVIDER);
  assert.equal(c.autoTradeEligible, false);
  assert.deepEqual(checkInvariants(c), []);
  if (c.entryReady) {
    assert.ok(c.stopLoss < c.entryHigh, 'SL 必須低於進場價');
    assert.ok(c.takeProfit1 > c.entryHigh);
    assert.ok(c.takeProfit2 > c.takeProfit1);
    const r = c.riskPerUnit;
    assert.ok(Math.abs(c.takeProfit1 - (c.entryHigh + r * 1.5)) < 1e-9, 'TP1 必須是 1.5R');
    assert.ok(Math.abs(c.takeProfit2 - (c.entryHigh + r * 2.5)) < 1e-9, 'TP2 必須是 2.5R');
  }
});

test('端到端：已噴完的標的不會列為可進場', () => {
  const row = buildUniverse(INSTRUMENTS, TICKERS, NOW).find((r) => r.symbol === 'ABCUSDT');
  const c = buildCandidate(
    { ...row, change24hPct: 15 },
    parseKlines(makeKlines({ finalClose: 101.5 })),
    parseOpenInterest(makeOi(1.2)),
    parseOrderbook(ORDERBOOK),
  );
  assert.equal(c.entryReady, false);
  assert.equal(c.stage, 'EXCLUDED');
  assert.equal(c.stopLoss, null);
  assert.equal(c.takeProfit1, null);
  assert.deepEqual(checkInvariants(c), []);
});

test('端到端：候選永遠不可自動下單，連結永遠指向 Bybit', () => {
  const row = buildUniverse(INSTRUMENTS, TICKERS, NOW).find((r) => r.symbol === 'ABCUSDT');
  for (const finalClose of [98, 99.4, 100.5, 101.5]) {
    const c = buildCandidate(row, parseKlines(makeKlines({ finalClose })), parseOpenInterest(makeOi()), parseOrderbook(ORDERBOOK));
    assert.equal(c.autoTradeEligible, false);
    assert.match(c.bybitUrl, /^https:\/\/www\.bybit\.com\/trade\/usdt\//);
    assert.doesNotMatch(c.bybitUrl, /dexscreener|dextools|birdeye/i);
    assert.deepEqual(checkInvariants(c), []);
  }
});

test('迷因幣判定與固定防守倉', () => {
  assert.equal(classifyMeme('1000PEPEUSDT').isMeme, true);
  assert.equal(classifyMeme('BTCUSDT').isMeme, false);
  assert.equal(classifyMeme('QQQUSDT').isMeme, true, '未知標的偏保守');
  const row = buildUniverse(INSTRUMENTS, TICKERS, NOW).find((r) => r.symbol === 'ABCUSDT');
  const meme = buildCandidate({ ...row, symbol: '1000PEPEUSDT' }, parseKlines(makeKlines()), parseOpenInterest(makeOi()), parseOrderbook(ORDERBOOK));
  assert.equal(meme.isMeme, true);
  assert.equal(meme.suggestedRiskPercent, 0.15);
});

test('盤口深度與可承受倉位', () => {
  const d = assessDepth(parseOrderbook(ORDERBOOK), 0.3);
  assert.equal(d.mid, 100);
  assert.ok(d.thinnerSideUsd > 0);
  assert.ok(maxTolerablePositionUsd(d.thinnerSideUsd) < d.thinnerSideUsd);
  assert.equal(maxTolerablePositionUsd(0), 0);
  const empty = assessDepth(parseOrderbook({ b: [], a: [] }));
  assert.equal(empty.thinnerSideUsd, 0);
});

test('SL 一定低於進場價，TP 一定高於進場價', () => {
  const k = parseKlines(makeKlines({ finalClose: 99.4 }));
  const stop = suggestStop(99.4, k);
  assert.ok(stop < 99.4, `SL ${stop} 必須低於進場價`);
  const t = buildTargets(99.4, stop);
  assert.ok(t.takeProfit1 > 99.4 && t.takeProfit2 > t.takeProfit1);
  assert.equal(buildTargets(100, 100), null);
  assert.equal(buildTargets(100, 105), null);
});

test('最多顯示八個候選，可進場的排前面', () => {
  const many = Array.from({ length: 20 }, (_, i) => ({
    symbol: `S${i}USDT`, score: i * 5, entryReady: i % 3 === 0,
    autoTradeEligible: false, bybitUrl: bybitContractUrl(`S${i}USDT`),
    blockingReasons: [], stopLoss: null, takeProfit1: null, stage: 'WATCH',
  }));
  const out = rankCandidates(many);
  assert.ok(out.length <= MAX_DISPLAYED);
  const firstNotReady = out.findIndex((c) => !c.entryReady);
  if (firstNotReady !== -1) {
    assert.ok(out.slice(firstNotReady).every((c) => !c.entryReady));
  }
});

test('不變量：大量隨機組合下皆不違反', () => {
  const row = buildUniverse(INSTRUMENTS, TICKERS, NOW).find((r) => r.symbol === 'ABCUSDT');
  let seed = 7;
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  for (let i = 0; i < 300; i += 1) {
    const c = buildCandidate(
      { ...row, change24hPct: rand() * 26 - 14, fundingRatePct: rand() * 0.5 - 0.25 },
      parseKlines(makeKlines({ finalClose: 96 + rand() * 8, volumeMultiple: rand() * 7 })),
      parseOpenInterest(makeOi(rand() * 10 - 2)),
      parseOrderbook(ORDERBOOK),
    );
    assert.deepEqual(checkInvariants(c), [], JSON.stringify({ i, reasons: c.blockingReasons }));
  }
});

test('風控標籤只在高信心時斷言「迷因幣」', async () => {
  const { riskLabel } = await import('../app/scan-engine.js');
  assert.equal(riskLabel(classifyMeme('1000PEPEUSDT')), '迷因幣 · 固定 0.15% 防守倉');
  assert.equal(riskLabel(classifyMeme('BTCUSDT')), null, '主流標的沒有迷因幣標籤');

  const medium = riskLabel(classifyMeme('1000XYZUSDT', 20, 9e6, 5e5));
  assert.equal(medium, '疑似迷因幣 · 保守 0.15% 倉位');

  const low = riskLabel(classifyMeme('AAAUSDT'));
  assert.equal(low, '未列入主流 · 保守 0.15% 倉位');
  assert.doesNotMatch(low, /^迷因幣/, '低信心不得斷言是迷因幣');
});

test('停損風險寬度夾在現價的 0.5% 到 2.5% 之間', () => {
  const wide = suggestStop(100, [{ low: 50 }, { low: 50 }]);
  assert.ok(Math.abs(wide - 97.5) < 1e-9, `過寬要夾到 2.5%，實得 ${wide}`);

  const tight = suggestStop(100, [{ low: 99.99 }, { low: 99.99 }]);
  assert.ok(Math.abs(tight - 99.5) < 1e-9, `過緊要夾到 0.5%，實得 ${tight}`);

  const normal = suggestStop(100, [{ low: 98.5 }, { low: 98.7 }]);
  assert.ok(normal > 97.5 && normal < 99.5, `一般情況應落在區間內，實得 ${normal}`);

  assert.ok(Number.isNaN(suggestStop(NaN, [])));
  assert.ok(Number.isNaN(suggestStop(0, [])));
});

test('停損永遠低於進場價，TP 永遠高於進場價', () => {
  for (const price of [0.00001234, 0.5, 1, 87.3, 1000, 95000]) {
    for (const lows of [[], [{ low: price * 0.5 }], [{ low: price * 0.9999 }], [{ low: price * 0.98 }]]) {
      const stop = suggestStop(price, lows);
      assert.ok(stop < price, `SL ${stop} 必須低於 ${price}`);
      assert.ok(stop > 0, 'SL 必須為正');
      const t = buildTargets(price, stop);
      assert.ok(t.takeProfit1 > price && t.takeProfit2 > t.takeProfit1);
    }
  }
});

test('資料年齡以最後一根 K 線收盤時間為準，形成中的 K 線不算舊', () => {
  const now = Date.now();
  const step = 15 * 60_000;
  // 最後一根剛開盤（仍在形成中）：收盤時間在未來，年齡應為 0
  const forming = [];
  for (let i = 5; i >= 0; i -= 1) {
    const t = now - i * step;
    forming.push([String(t), '100', '100.5', '99.5', '100', '1000', '0']);
  }
  const m = computeMetrics(parseKlines(forming.reverse()), []);
  assert.equal(m.dataAgeMinutes, 0, `形成中的 K 線年齡應為 0，實得 ${m.dataAgeMinutes}`);

  // 資料流停擺：最後一根開盤於 60 分鐘前，代表它在 45 分鐘前就收盤了
  const stalled = [];
  for (let i = 5; i >= 0; i -= 1) {
    const t = now - 60 * 60_000 - i * step;
    stalled.push([String(t), '100', '100.5', '99.5', '100', '1000', '0']);
  }
  const m2 = computeMetrics(parseKlines(stalled.reverse()), []);
  assert.ok(Math.abs(m2.dataAgeMinutes - 45) < 1, `應約 45 分鐘（開盤 60 分鐘前 + 15 分鐘週期），實得 ${m2.dataAgeMinutes}`);
});

test('資料流停擺時進場閘門會擋下', () => {
  const now = Date.now();
  const step = 15 * 60_000;
  const stalled = [];
  for (let i = 39; i >= 0; i -= 1) {
    const t = now - 90 * 60_000 - i * step;
    stalled.push([String(t), '100', '100.1', '99.9', '100', '1000', '0']);
  }
  const m = computeMetrics(parseKlines(stalled.reverse()), []);
  assert.ok(m.dataAgeMinutes > ENTRY.maxDataAgeMinutes, `年齡 ${m.dataAgeMinutes} 應超過門檻`);
  const ev = evaluateEntryGates({
    score: 90, stage: 'NEAR_BREAKOUT', breakoutDistancePct: 1, compressionRatio: 0.7,
    volumeMultiple: 1.5, oiChangePct: 1, change1hPct: 0, change6hPct: 0,
    riskFlags: [], dataAgeMinutes: m.dataAgeMinutes,
  });
  assert.equal(ev.ready, false);
  assert.ok(ev.reasons.some((r) => r.includes('資料年齡')));
});
