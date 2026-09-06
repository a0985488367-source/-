import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GRADE_DISPLAY_CAP,
  MAIN_SIGNAL_MIN_VOLUME_MULTIPLE,
  buildSignalView,
  checkSignalInvariants,
  toDisplayScore,
} from '../app/signal-score-display.ts';

const GRADES = ['A', 'B', 'WATCH', 'NONE'];

/** 交接規格第五節記載的那筆 PEPE 資料 */
const PEPE_HANDOVER = {
  symbol: '1000PEPEUSDT',
  side: 'short',
  directionScore: 94,
  grade: 'WATCH',
  whitelisted: false,
  entryValid: false,
  protectionPlannable: true,
  volumeMultiple: 0.773,
  inEntryZone: false,
  dataAgeMinutes: 3,
};

test('PEPE 迴歸：94 分的 WATCH 訊號不得顯示 90 分以上', () => {
  const view = buildSignalView(PEPE_HANDOVER);
  assert.equal(view.directionScore, 94, '方向分保留原始值供追查');
  assert.equal(view.displayScore, 67, 'WATCH 級顯示分數必須壓到 67');
  assert.ok(view.displayScore <= GRADE_DISPLAY_CAP.WATCH);
});

test('PEPE 迴歸：entryReady 為 false 且列出量能未達標的原因', () => {
  const view = buildSignalView(PEPE_HANDOVER);
  assert.equal(view.entryReady, false);
  assert.equal(view.autoTradeEligible, false);
  const volumeReason = view.blockingReasons.find((r) => r.includes('量能'));
  assert.ok(volumeReason, '必須明講量能未達標');
  assert.match(volumeReason, /0\.773/, '要顯示實際量能倍率');
  assert.match(volumeReason, /1\.05/, '要顯示要求的門檻');
});

test('PEPE 迴歸：分數說明必須澄清這不是勝率', () => {
  const view = buildSignalView(PEPE_HANDOVER);
  assert.match(view.scoreCaption, /不是勝率/);
});

test('不變量：任何等級的顯示分數都不得超過該等級上限', () => {
  for (const grade of GRADES) {
    for (let raw = 0; raw <= 100; raw += 1) {
      const score = toDisplayScore(raw, grade);
      assert.ok(
        score <= GRADE_DISPLAY_CAP[grade],
        `${grade} 級原始 ${raw} 分產生 ${score} 分，超過上限 ${GRADE_DISPLAY_CAP[grade]}`,
      );
      assert.ok(score <= raw, '校正只能往下壓，不得把分數拉高');
    }
  }
});

test('不變量：WATCH 永遠不會顯示 90 分以上', () => {
  for (let raw = 0; raw <= 100; raw += 1) {
    assert.ok(toDisplayScore(raw, 'WATCH') < 90);
  }
});

test('不變量：entryReady 為 true 時所有 blocking 閘門都必須通過', () => {
  const flags = ['whitelisted', 'entryValid', 'protectionPlannable', 'inEntryZone'];
  // 窮舉四個布林旗標與兩種量能、兩種等級的組合
  for (let mask = 0; mask < 16; mask += 1) {
    for (const volumeMultiple of [0.9, 1.5]) {
      for (const grade of GRADES) {
        const input = {
          ...PEPE_HANDOVER,
          grade,
          volumeMultiple,
          dataAgeMinutes: 2,
        };
        flags.forEach((flag, i) => {
          input[flag] = Boolean(mask & (1 << i));
        });
        const view = buildSignalView(input);
        assert.deepEqual(checkSignalInvariants(view), [], JSON.stringify(input));
        if (view.entryReady) {
          assert.equal(view.blockingReasons.length, 0);
          assert.equal(view.grade, 'A', '只有 A 級能就緒');
          assert.ok(volumeMultiple >= MAIN_SIGNAL_MIN_VOLUME_MULTIPLE);
        }
      }
    }
  }
});

test('高分不會跳過進場條件：A 級 99 分但量能不足仍不得進場', () => {
  const view = buildSignalView({
    ...PEPE_HANDOVER,
    symbol: 'BTCUSDT',
    grade: 'A',
    directionScore: 99,
    whitelisted: true,
    entryValid: true,
    inEntryZone: true,
    volumeMultiple: 1.0,
  });
  assert.equal(view.displayScore, 99, 'A 級保留原始分數');
  assert.equal(view.entryReady, false, '量能不足仍不得進場');
  assert.equal(view.autoTradeEligible, false);
});

test('全部條件通過時才可自動交易', () => {
  const view = buildSignalView({
    symbol: 'BTCUSDT',
    side: 'long',
    directionScore: 91,
    grade: 'A',
    whitelisted: true,
    entryValid: true,
    protectionPlannable: true,
    volumeMultiple: 1.4,
    inEntryZone: true,
    dataAgeMinutes: 2,
  });
  assert.equal(view.entryReady, true);
  assert.equal(view.autoTradeEligible, true);
  assert.equal(view.readiness.passed, view.readiness.total);
});

test('TP／SL 掛不上去就不得自動交易', () => {
  const view = buildSignalView({
    symbol: 'BTCUSDT',
    side: 'long',
    directionScore: 95,
    grade: 'A',
    whitelisted: true,
    entryValid: true,
    protectionPlannable: false,
    volumeMultiple: 1.4,
    inEntryZone: true,
    dataAgeMinutes: 2,
  });
  assert.equal(view.autoTradeEligible, false);
  assert.ok(view.blockingReasons.some((r) => r.includes('TP')));
});

test('資料缺漏一律 fail-safe 為不可進場', () => {
  const view = buildSignalView({
    symbol: 'BTCUSDT',
    side: 'long',
    directionScore: 95,
    grade: 'A',
    whitelisted: true,
    entryValid: true,
    protectionPlannable: true,
    volumeMultiple: Number.NaN,
    inEntryZone: true,
    dataAgeMinutes: Number.NaN,
  });
  assert.equal(view.entryReady, false);
  assert.equal(view.autoTradeEligible, false);
});
