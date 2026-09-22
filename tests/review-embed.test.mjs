import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReviewEmbed } from '../scripts/lib/review-embed.mjs';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 0, 10);

const trade = (over = {}) => ({
  symbol: 'BTCUSDT', interval: '1h', dir: 'long', grade: 'A', poiType: 'Order Block',
  status: 'target', r: 1, closedTime: NOW - DAY, filledTime: NOW - DAY * 2,
  ...over,
});

test('沒有任何交易 → 提示這次回顧略過，不會出現獲利/虧損欄位', () => {
  const embed = buildReviewEmbed({ closed: [] }, 3, NOW);
  assert.match(embed.description, /沒有結算的交易/);
  assert.equal(embed.fields.length, 0);
});

test('只算視窗內的交易：超過 N 天前結算的不列入', () => {
  const journal = { closed: [
    trade({ closedTime: NOW - DAY }),
    trade({ closedTime: NOW - 10 * DAY }),
  ] };
  const embed = buildReviewEmbed(journal, 3, NOW);
  assert.match(embed.description, /共結算 1 筆/);
});

test('未成交就逾時作廢的限價單不算一筆交易（跟 computeStats 一致）', () => {
  const journal = { closed: [
    trade({ status: 'expired', exitReason: 'timeout', filledTime: null, r: 0 }),
  ] };
  const embed = buildReviewEmbed(journal, 3, NOW);
  assert.match(embed.description, /沒有結算的交易/);
});

test('獲利與虧損分開列出各自的等級/方向/週期/型態/來源共同點', () => {
  const journal = { closed: [
    trade({ grade: 'A', dir: 'long', r: 1.5 }),
    trade({ grade: 'A', dir: 'long', r: 2 }),
    trade({ grade: 'A+', dir: 'short', r: -1, status: 'stop' }),
    trade({ grade: 'A+', dir: 'short', r: -1, status: 'stop' }),
  ] };
  const embed = buildReviewEmbed(journal, 3, NOW);
  const win = embed.fields.find((f) => f.name.includes('獲利'));
  const loss = embed.fields.find((f) => f.name.includes('虧損'));
  assert.match(win.value, /等級：A×2/);
  assert.match(win.value, /方向：多×2/);
  assert.match(loss.value, /等級：A\+×2/);
  assert.match(loss.value, /方向：空×2/);
});

test('全市場掃描來源的交易標記成「全市場掃描」，固定監控的沒有 source 欄位也能正常顯示', () => {
  const journal = { closed: [
    trade({ source: 'market', r: 1 }),
    trade({ r: 1 }), // 沒有 source 欄位 → 應視為固定監控
  ] };
  const embed = buildReviewEmbed(journal, 3, NOW);
  const win = embed.fields.find((f) => f.name.includes('獲利'));
  assert.match(win.value, /來源：全市場掃描×1、固定監控×1/);
});

test('只有虧損沒有獲利時，只顯示虧損欄位', () => {
  const journal = { closed: [trade({ r: -1, status: 'stop' })] };
  const embed = buildReviewEmbed(journal, 3, NOW);
  assert.equal(embed.fields.some((f) => f.name.includes('獲利')), false);
  assert.equal(embed.fields.some((f) => f.name.includes('虧損')), true);
});
