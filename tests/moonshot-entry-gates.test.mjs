import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ENTRY,
  MAX_DISPLAYED_CANDIDATES,
  MOONSHOT_PROVIDER,
  UNIVERSE,
  buildMoonshotCandidate,
  buildTargets,
  bybitContractUrl,
  checkMoonshotInvariants,
  passesUniverseFilter,
  scanMoonshots,
} from '../app/moonshot-entry-gates.ts';

/** 一個乾淨、剛好符合全部進場條件的標的 */
const READY = Object.freeze({
  symbol: 'ABCUSDT',
  contractType: 'linear',
  quoteCoin: 'USDT',
  category: 'linear',
  turnover24hUsd: 5_000_000,
  openInterestUsd: 2_000_000,
  listedHours: 5_000,
  spreadPct: 0.1,
  change24hPct: 3,
  change1hPct: 0.8,
  change6hPct: 2,
  rangePosition24h: 0.8,
  breakoutDistancePct: 0.9,
  compressionRatio: 0.7,
  volumeMultiple: 1.6,
  oiChangePct: 1.2,
  fundingRatePct: 0.01,
  score: 86,
  stage: 'NEAR_BREAKOUT',
  dataAgeMinutes: 4,
  suggestedEntry: 100,
  suggestedStop: 96,
});

test('快噴候選的 autoTradeEligible 永遠是 false', () => {
  for (const patch of [{}, { score: 100 }, { stage: 'NEAR_BREAKOUT', score: 99 }, { volumeMultiple: 0.2 }]) {
    const c = buildMoonshotCandidate({ ...READY, ...patch });
    assert.equal(c.autoTradeEligible, false);
  }
});

test('資料來源標示為 Bybit Pre-Breakout，連結指向 Bybit', () => {
  const c = buildMoonshotCandidate(READY);
  assert.equal(c.provider, MOONSHOT_PROVIDER);
  assert.equal(c.provider, 'Bybit Pre-Breakout');
  assert.match(c.bybitUrl, /^https:\/\/www\.bybit\.com\/trade\/usdt\/ABCUSDT$/);
});

test('合約連結絕不指向 DEX Screener 或其他非 Bybit 來源', () => {
  for (const symbol of ['ABCUSDT', '1000PEPEUSDT', 'btcusdt']) {
    const url = bybitContractUrl(symbol);
    assert.ok(url.startsWith('https://www.bybit.com/'), url);
    assert.doesNotMatch(url, /dexscreener|dextools|birdeye|pump\.fun/i);
  }
});

test('條件全過時給出 Entry、SL、TP1 1.5R 與 TP2 2.5R', () => {
  const c = buildMoonshotCandidate(READY);
  assert.equal(c.entryReady, true);
  assert.equal(c.stopLoss, 96);
  assert.equal(c.riskPerUnit, 4);
  assert.equal(c.takeProfit1, 100 + 4 * 1.5);
  assert.equal(c.takeProfit2, 100 + 4 * 2.5);
  assert.deepEqual(checkMoonshotInvariants(c), []);
});

test('未就緒就不得帶出 Entry 或 SL', () => {
  const c = buildMoonshotCandidate({ ...READY, volumeMultiple: 1.0 });
  assert.equal(c.entryReady, false);
  assert.equal(c.entryZone, null);
  assert.equal(c.stopLoss, null);
  assert.equal(c.takeProfit1, null);
  assert.deepEqual(checkMoonshotInvariants(c), []);
});

test('golden：已經噴完的標的永遠不會被列為可進場', () => {
  const pumped = [
    { label: '24H 已噴', patch: { change24hPct: 14 } },
    { label: '1H 已噴', patch: { change1hPct: 6 } },
    { label: '6H 已噴', patch: { change6hPct: 13 } },
    { label: '已突破前高', patch: { breakoutDistancePct: -3 } },
    { label: '量能暴衝', patch: { volumeMultiple: 7 } },
    { label: '距突破點太遠', patch: { breakoutDistancePct: 6 } },
    { label: '壓縮比過大', patch: { compressionRatio: 1.5 } },
    { label: '資金費率極端', patch: { fundingRatePct: 0.4 } },
  ];
  for (const { label, patch } of pumped) {
    const c = buildMoonshotCandidate({ ...READY, ...patch });
    assert.equal(c.entryReady, false, `${label} 不該可進場`);
    assert.equal(c.stage, 'EXCLUDED', `${label} 應被標記為已排除`);
    assert.ok(c.blockingReasons.length > 0, `${label} 應說明排除原因`);
    assert.deepEqual(checkMoonshotInvariants(c), []);
  }
});

test('十道進場條件逐一驗證：任一項越界就擋下', () => {
  const violations = [
    ['score', ENTRY.minScore - 1],
    ['stage', 'WATCH'],
    ['breakoutDistancePct', ENTRY.maxBreakoutDistancePct + 0.5],
    ['compressionRatio', ENTRY.maxCompressionRatio + 0.01],
    ['volumeMultiple', ENTRY.minVolumeMultiple - 0.01],
    ['oiChangePct', ENTRY.minOiChangePct - 0.01],
    ['change1hPct', ENTRY.maxChange1hPct + 0.1],
    ['change6hPct', ENTRY.minChange6hPct - 0.1],
    ['dataAgeMinutes', ENTRY.maxDataAgeMinutes + 1],
  ];
  for (const [field, value] of violations) {
    const c = buildMoonshotCandidate({ ...READY, [field]: value });
    assert.equal(c.entryReady, false, `${field}=${value} 應該擋下`);
  }
  const flagged = buildMoonshotCandidate({ ...READY, riskFlags: ['低流動性'] });
  assert.equal(flagged.entryReady, false, '有風險標記應該擋下');
});

test('資料介於 15 到 45 分鐘之間會發出警告但不擋進場', () => {
  const c = buildMoonshotCandidate({ ...READY, dataAgeMinutes: 30 });
  assert.equal(c.entryReady, true, '仍符合既有 45 分鐘硬門檻');
  assert.ok(c.warnings.some((w) => w.includes('資料新鮮度')), '應提示資料偏舊');
});

test('宇宙篩選：只接受 Bybit USDT 線性永續，排除穩定幣與非加密類', () => {
  assert.equal(passesUniverseFilter(READY), true);
  assert.equal(passesUniverseFilter({ ...READY, contractType: 'inverse' }), false);
  assert.equal(passesUniverseFilter({ ...READY, quoteCoin: 'USDC' }), false);
  assert.equal(passesUniverseFilter({ ...READY, category: 'forex' }), false);
  assert.equal(passesUniverseFilter({ ...READY, symbol: 'USDCUSDT' }), false);
});

test('宇宙篩選：成交額、未平倉值、上線時間、價差與區間位置門檻', () => {
  assert.equal(passesUniverseFilter({ ...READY, turnover24hUsd: UNIVERSE.minTurnover24hUsd - 1 }), false);
  assert.equal(passesUniverseFilter({ ...READY, openInterestUsd: UNIVERSE.minOpenInterestUsd - 1 }), false);
  assert.equal(passesUniverseFilter({ ...READY, listedHours: 12 }), false);
  assert.equal(passesUniverseFilter({ ...READY, listedHours: UNIVERSE.maxListedHours + 1 }), false);
  assert.equal(passesUniverseFilter({ ...READY, spreadPct: 0.7 }), false);
  assert.equal(passesUniverseFilter({ ...READY, change24hPct: -13 }), false);
  assert.equal(passesUniverseFilter({ ...READY, rangePosition24h: 0.2 }), false);
  assert.equal(passesUniverseFilter({ ...READY, rangePosition24h: 0.99 }), false);
});

test('buildTargets 對無效風險回傳 null，不硬算', () => {
  assert.equal(buildTargets(100, 100), null);
  assert.equal(buildTargets(100, 105, 'long'), null);
  assert.equal(buildTargets(Number.NaN, 96), null);
  const short = buildTargets(100, 104, 'short');
  assert.equal(short.riskPerUnit, 4);
  assert.equal(short.takeProfit1, 94);
});

test('掃描最多顯示八個候選，可進場的排前面', () => {
  const many = Array.from({ length: 20 }, (_, i) => ({
    ...READY,
    symbol: `SYM${i}USDT`,
    score: 80 + (i % 15),
    volumeMultiple: i % 2 === 0 ? 1.6 : 1.0,
  }));
  const out = scanMoonshots(many);
  assert.ok(out.length <= MAX_DISPLAYED_CANDIDATES);
  const firstNotReady = out.findIndex((c) => !c.entryReady);
  if (firstNotReady !== -1) {
    assert.ok(out.slice(firstNotReady).every((c) => !c.entryReady), '可進場的必須排在前面');
  }
  for (const c of out) assert.deepEqual(checkMoonshotInvariants(c), []);
});

test('缺資料時 fail-safe 為不可進場', () => {
  const c = buildMoonshotCandidate({ ...READY, compressionRatio: Number.NaN, oiChangePct: undefined });
  assert.equal(c.entryReady, false);
});

test('不變量：大量隨機組合下 entryReady 一定伴隨完整 TP／SL 且無阻擋原因', () => {
  let rng = 42;
  const rand = () => ((rng = (rng * 1103515245 + 12345) % 2147483648) / 2147483648);
  for (let i = 0; i < 800; i += 1) {
    const c = buildMoonshotCandidate({
      ...READY,
      score: Math.round(rand() * 100),
      stage: ['NEAR_BREAKOUT', 'BUILDING', 'WATCH'][Math.floor(rand() * 3)],
      breakoutDistancePct: rand() * 8 - 2,
      compressionRatio: rand() * 2,
      volumeMultiple: rand() * 7,
      oiChangePct: rand() * 8 - 1,
      change1hPct: rand() * 8 - 3,
      change6hPct: rand() * 16 - 6,
      change24hPct: rand() * 16 - 6,
      fundingRatePct: rand() * 0.5 - 0.25,
      dataAgeMinutes: rand() * 60,
    });
    assert.deepEqual(checkMoonshotInvariants(c), [], JSON.stringify(c.blockingReasons));
    if (c.entryReady) {
      assert.equal(c.blockingReasons.length, 0);
      assert.ok(c.takeProfit1 !== null && c.takeProfit2 !== null && c.stopLoss !== null);
      assert.equal(c.autoTradeEligible, false);
    }
  }
});
