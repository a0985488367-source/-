import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyFunding, oiChangePct, priceOiRegime, derivativesVerdict,
  annualizeFunding, fundingCountdown, FUNDING_THRESHOLDS,
} from '../src/smc/derivatives.js';

test('資金費率分級：中性 / 偏高 / 極端', () => {
  assert.equal(classifyFunding(0.00005).level, 'neutral');
  assert.equal(classifyFunding(0.0002).level, 'mild');
  assert.equal(classifyFunding(0.0004).level, 'elevated');
  assert.equal(classifyFunding(0.0009).level, 'extreme');
  assert.equal(classifyFunding(null).level, 'unknown');
});

test('負費率代表空方擁擠，方向要標對', () => {
  const f = classifyFunding(-0.0009);
  assert.equal(f.side, 'short');
  assert.equal(f.level, 'extreme');
  assert.match(f.zh, /空方付給多方/);
});

test('年化換算：每 8 小時 0.01% → 約 10.95%', () => {
  assert.ok(Math.abs(annualizeFunding(0.0001) - 10.95) < 0.01);
});

test('未平倉量變化率', () => {
  assert.equal(oiChangePct([{ value: 100 }, { value: 110 }]), 10);
  assert.equal(oiChangePct([100, 90]), -10);
  assert.equal(oiChangePct([{ value: 0 }, { value: 5 }]), null, '起始為 0 無法算變化率');
  assert.equal(oiChangePct([{ value: 100 }]), null, '只有一筆資料不能算');
});

test('價格與未平倉量的四象限', () => {
  assert.equal(priceOiRegime({ priceChangePct: 3, oiChangePct: 10 }).key, 'longBuild');
  assert.equal(priceOiRegime({ priceChangePct: 3, oiChangePct: -10 }).key, 'shortCover');
  assert.equal(priceOiRegime({ priceChangePct: -3, oiChangePct: 10 }).key, 'shortBuild');
  assert.equal(priceOiRegime({ priceChangePct: -3, oiChangePct: -10 }).key, 'longFlush');
  assert.equal(priceOiRegime({ priceChangePct: 0.1, oiChangePct: 10 }).key, 'buildup');
  assert.equal(priceOiRegime({ priceChangePct: 3, oiChangePct: null }).key, 'unknown');
});

test('上漲但持倉減少會被標為「弱」，不是健康趨勢', () => {
  const r = priceOiRegime({ priceChangePct: 3, oiChangePct: -10 });
  assert.equal(r.quality, 'weak');
  assert.match(r.zh, /空單回補/);
});

test('站在擁擠側的反方向會加分，對手停損就是目標流動性', () => {
  const v = derivativesVerdict({ dir: 'short', funding: 0.0009, priceChangePct: 0.1, oiChangePct: 0 });
  assert.ok(v.score > 0, `應為正分，實得 ${v.score}`);
  assert.match(v.notes.join(' '), /多方擁擠.*反向/s);
});

test('站在擁擠側會扣分並明確警告', () => {
  const v = derivativesVerdict({ dir: 'long', funding: 0.0009, priceChangePct: 0.1, oiChangePct: 0 });
  assert.ok(v.score < 0, `應為負分，實得 ${v.score}`);
  assert.match(v.notes.join(' '), /⚠.*擁擠/s);
});

test('費率中性時不因為費率加減分', () => {
  const v = derivativesVerdict({ dir: 'long', funding: 0.00002, priceChangePct: 0.1, oiChangePct: 0 });
  assert.equal(v.score, 0);
  assert.equal(v.notes.length, 0);
});

test('持倉結構與方向一致時加分，缺乏新資金時扣分', () => {
  const good = derivativesVerdict({ dir: 'long', funding: 0, priceChangePct: 3, oiChangePct: 10 });
  assert.ok(good.score > 0);
  const weak = derivativesVerdict({ dir: 'long', funding: 0, priceChangePct: 3, oiChangePct: -10 });
  assert.ok(weak.score < 0, '空單回補推上來的漲勢，追多要扣分');
});

test('分數是用來微調信心度，不會大到足以否決訊號', () => {
  const worst = derivativesVerdict({ dir: 'long', funding: 0.002, priceChangePct: 5, oiChangePct: -20 });
  const best = derivativesVerdict({ dir: 'short', funding: 0.002, priceChangePct: 5, oiChangePct: -20 });
  assert.ok(worst.score >= -20 && best.score <= 20, `範圍應在 ±20 內：${worst.score} / ${best.score}`);
});

test('資金費率倒數', () => {
  const now = Date.UTC(2026, 0, 1, 0, 0);
  const c = fundingCountdown(now + 2 * 3600000 + 30 * 60000, now);
  assert.equal(c.hours, 2);
  assert.equal(c.minutes, 30);
  assert.equal(fundingCountdown(now - 1000, now).ms, 0);
  assert.equal(fundingCountdown(null), null);
});

test('門檻值有匯出，方便之後依實測調整', () => {
  assert.ok(FUNDING_THRESHOLDS.neutral < FUNDING_THRESHOLDS.elevated);
  assert.ok(FUNDING_THRESHOLDS.elevated < FUNDING_THRESHOLDS.extreme);
});
