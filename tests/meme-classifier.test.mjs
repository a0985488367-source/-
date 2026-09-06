import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CLOUD_MULTIPLIER,
  DEFAULT_AUTO_TRADE_WHITELIST,
  EXPLICIT_MEME_BASES,
  MEME_FIXED_RISK_PERCENT,
  allowsNewPosition,
  classifyMeme,
  cloudQualityMultiplier,
  correlationBucket,
  localRiskPercent,
  normalizeBase,
} from '../app/meme-classifier.ts';

test('面額前綴會被正規化掉', () => {
  assert.equal(normalizeBase('1000PEPEUSDT'), 'PEPE');
  assert.equal(normalizeBase('10000SATSUSDT'), 'SATS');
  assert.equal(normalizeBase('1000000MOGUSDT'), 'MOG');
  assert.equal(normalizeBase('BTCUSDT'), 'BTC');
});

test('明列的迷因幣一律高信心判定為迷因幣', () => {
  for (const base of EXPLICIT_MEME_BASES) {
    for (const symbol of [`${base}USDT`, `1000${base}USDT`]) {
      const r = classifyMeme({ symbol });
      assert.equal(r.isMeme, true, symbol);
      assert.equal(r.confidence, 'high', symbol);
    }
  }
});

test('主流標的判定為非迷因幣', () => {
  for (const symbol of ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'LINKUSDT']) {
    const r = classifyMeme({ symbol });
    assert.equal(r.isMeme, false, symbol);
    assert.equal(r.confidence, 'high', symbol);
  }
});

test('預設自動下單白名單全部是非迷因幣', () => {
  for (const symbol of DEFAULT_AUTO_TRADE_WHITELIST) {
    assert.equal(classifyMeme({ symbol }).isMeme, false, symbol);
  }
});

test('啟發式：新上市的低單價高周轉標的判為迷因幣', () => {
  const r = classifyMeme({ symbol: '1000XYZUSDT', listedDays: 20, turnover24hUsd: 9_000_000, openInterestUsd: 500_000 });
  assert.equal(r.isMeme, true);
  assert.equal(r.confidence, 'medium');
  assert.equal(r.reasons.length, 3);
});

test('fail-safe：完全未知的標的一律以迷因幣風控處理', () => {
  const r = classifyMeme({ symbol: 'QQQUSDT' });
  assert.equal(r.isMeme, true, '判斷不出來必須偏保守');
  assert.match(r.reasons[0], /保守原則/);
});

test('迷因幣不論分數多高都固定 0.15% 防守倉', () => {
  for (const score of [50, 85, 90, 95, 100]) {
    const r = localRiskPercent({ symbol: '1000PEPEUSDT', grade: 'A', score, isMeme: true });
    assert.equal(r.riskPercent, MEME_FIXED_RISK_PERCENT, `${score} 分`);
    assert.equal(r.tier, '防守倉');
  }
});

test('非迷因幣的分級倉位符合規格', () => {
  const mk = (grade, score) => localRiskPercent({ symbol: 'SOLUSDT', grade, score, isMeme: false });
  assert.equal(mk('B', 70).riskPercent, 0.10);
  assert.equal(mk('WATCH', 94).riskPercent, 0.10);
  assert.equal(mk('A', 80).riskPercent, 0.15);
  assert.equal(mk('A', 85).riskPercent, 0.25);
  assert.equal(mk('A', 89).riskPercent, 0.25);
  assert.equal(mk('A', 90).riskPercent, 0.30);
  assert.equal(mk('A', 99).riskPercent, 0.30);
});

test('沒有任何情況會讓倉位超過 0.30%', () => {
  for (const isMeme of [true, false]) {
    for (const grade of ['A', 'B', 'WATCH', 'NONE']) {
      for (let score = 0; score <= 100; score += 1) {
        const r = localRiskPercent({ symbol: 'XUSDT', grade, score, isMeme });
        assert.ok(r.riskPercent <= 0.30, `${grade}/${score}/${isMeme} 得到 ${r.riskPercent}`);
        if (isMeme) assert.ok(r.riskPercent <= MEME_FIXED_RISK_PERCENT);
      }
    }
  }
});

test('連虧與學習偏弱會繼續降倉', () => {
  const base = { symbol: 'SOLUSDT', grade: 'A', score: 92, isMeme: false };
  const normal = localRiskPercent(base);
  const losing = localRiskPercent({ ...base, consecutiveLosses: 3 });
  const weak = localRiskPercent({ ...base, learningWeak: true });
  const both = localRiskPercent({ ...base, consecutiveLosses: 4, learningWeak: true });
  assert.ok(losing.riskPercent < normal.riskPercent);
  assert.ok(weak.riskPercent < normal.riskPercent);
  assert.ok(both.riskPercent < losing.riskPercent);
  assert.match(losing.reason, /連續 3 筆虧損/);
});

test('迷因幣不得取得 A+ 加碼，倍率降為 60%', () => {
  const r = cloudQualityMultiplier({ isMeme: true, strongSignal: true, aPlus: true });
  assert.equal(r.aPlusAllowed, false);
  assert.equal(r.multiplier, CLOUD_MULTIPLIER.memeRiskMultiplier);
  assert.ok(r.notes.some((n) => n.includes('A+')));
});

test('非迷因幣強訊號倍率上限 1.2', () => {
  const r = cloudQualityMultiplier({ isMeme: false, strongSignal: true, aPlus: true, baseMultiplier: 1.3 });
  assert.equal(r.aPlusAllowed, true);
  assert.ok(r.multiplier <= CLOUD_MULTIPLIER.maxNonMemeStrongMultiplier);
});

test('最終品質倍率永遠夾在 0.5 到 1.4 之間', () => {
  for (const baseMultiplier of [0, 0.1, 0.5, 1, 1.4, 3, 100]) {
    for (const isMeme of [true, false]) {
      for (const strongSignal of [true, false]) {
        const r = cloudQualityMultiplier({ isMeme, strongSignal, aPlus: false, baseMultiplier });
        assert.ok(r.multiplier >= CLOUD_MULTIPLIER.floor, JSON.stringify(r));
        assert.ok(r.multiplier <= CLOUD_MULTIPLIER.ceiling, JSON.stringify(r));
      }
    }
  }
});

test('相關性分組：每組最多一個部位', () => {
  const btc = { symbol: 'BTCUSDT', isMeme: false };
  const eth = { symbol: 'ETHUSDT', isMeme: false };
  const sol = { symbol: 'SOLUSDT', isMeme: false };
  assert.equal(correlationBucket('BTCUSDT', false), 'major');
  assert.equal(correlationBucket('SOLUSDT', false), 'alt-l1');
  assert.equal(correlationBucket('1000PEPEUSDT', true), 'meme');

  assert.equal(allowsNewPosition([], btc, 3).allowed, true);
  assert.equal(allowsNewPosition([btc], eth, 3).allowed, false, 'BTC 與 ETH 同屬 major');
  assert.equal(allowsNewPosition([btc], sol, 3).allowed, true, 'SOL 屬於不同分組');
  assert.equal(allowsNewPosition([btc, sol], { symbol: 'LINKUSDT', isMeme: false }, 3).allowed, false);
});

test('部位上限仍然優先生效', () => {
  const r = allowsNewPosition([{ symbol: 'BTCUSDT', isMeme: false }], { symbol: 'SOLUSDT', isMeme: false }, 1);
  assert.equal(r.allowed, false);
  assert.match(r.reason, /部位上限/);
});
