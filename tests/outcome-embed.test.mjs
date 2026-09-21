import test from 'node:test';
import assert from 'node:assert/strict';
import { buildOutcomeEmbed, fmtR, price } from '../scripts/lib/outcome-embed.mjs';

const cfg = { siteUrl: 'https://example.test', tracking: { entryWindowBars: 24 } };
const stats = { count: 0 };

const trade = (over = {}) => ({
  id: 't1', symbol: 'BTCUSDT', interval: '1h', dir: 'long',
  entry: 100, stop: 95, hitTargets: [], maxFavorableR: 0.5,
  targets: [{ name: 'TP1', price: 105 }, { name: 'TP2', price: 130 }],
  filledTime: 1000, ...over,
});

test('迴歸測試：breakeven 事件不會崩潰，且不推播（這是原本讓整批推播失敗的 bug）', () => {
  // 重現原始崩潰：交易還在進行中（trade.r 尚未存在），
  // 打到第一個目標時 tracker.mjs 會多推一個 breakeven 事件。
  const active = trade({ status: 'active', r: undefined });
  assert.doesNotThrow(() => {
    const embed = buildOutcomeEmbed(active, { type: 'breakeven', time: 2000, price: 105 }, stats, cfg);
    assert.equal(embed, null, 'breakeven 不應該產生獨立的推播內容');
  });
});

test('未知的事件類型：安全回傳 null，不會嘗試讀取 trade.r', () => {
  const active = trade({ status: 'active', r: undefined });
  assert.doesNotThrow(() => {
    const embed = buildOutcomeEmbed(active, { type: 'some-future-event-type', time: 2000 }, stats, cfg);
    assert.equal(embed, null);
  });
});

test('fmtR 對非有限數字一律安全，絕不丟例外', () => {
  assert.equal(fmtR(undefined), '—');
  assert.equal(fmtR(null), '—');
  assert.equal(fmtR(NaN), '—');
  assert.equal(fmtR(Infinity), '—');
  assert.equal(fmtR(2.456), '+2.46R');
  assert.equal(fmtR(-1), '-1.00R');
  assert.equal(fmtR(1.5, { sign: false }), '1.50R');
});

test('即使 trade.r 意外為 undefined，stop/expired 訊息也不會崩潰', () => {
  const stopped = trade({ status: 'stop', r: undefined });
  assert.doesNotThrow(() => {
    const embed = buildOutcomeEmbed(stopped, { type: 'stop', time: 2000, price: 95 }, stats, cfg);
    assert.match(embed.title, /—/, '應該用安全預設值而不是丟例外');
  });

  const expired = trade({ status: 'expired', r: undefined, exitPrice: 101 });
  assert.doesNotThrow(() => {
    const embed = buildOutcomeEmbed(expired, { type: 'expired', time: 2000 }, stats, cfg);
    assert.ok(embed.description.includes('—'));
  });
});

test('filled 事件產生正確訊息', () => {
  const t = trade({ status: 'active' });
  const embed = buildOutcomeEmbed(t, { type: 'filled', time: 1000 }, stats, cfg);
  assert.match(embed.title, /已進場/);
  assert.match(embed.description, /100/);
});

test('target 非最終目標：訊息說明停損已移到成本價', () => {
  const t = trade({ status: 'active', hitTargets: ['TP1'] });
  const embed = buildOutcomeEmbed(t, { type: 'target', name: 'TP1', time: 2000, price: 105, rr: 1 }, stats, cfg);
  assert.match(embed.title, /TP1 達成/);
  assert.match(embed.description, /移到成本價/);
});

test('target 最終目標：訊息標記為全部達成', () => {
  const t = trade({ status: 'target', hitTargets: ['TP1', 'TP2'], r: 6 });
  const embed = buildOutcomeEmbed(t, { type: 'target', name: 'TP2', time: 3000, price: 130, rr: 6 }, stats, cfg);
  assert.match(embed.title, /🎉/);
  assert.match(embed.description, /全部目標達成/);
});

test('stop：已達部分目標後保本出場，標題與顏色不同於直接停損', () => {
  const saved = trade({ status: 'stop', hitTargets: ['TP1'], r: 0.5 });
  const embedSaved = buildOutcomeEmbed(saved, { type: 'stop', time: 3000, price: 100 }, stats, cfg);
  assert.match(embedSaved.title, /回到成本價出場/);

  const lost = trade({ status: 'stop', hitTargets: [], r: -1 });
  const embedLost = buildOutcomeEmbed(lost, { type: 'stop', time: 3000, price: 95 }, stats, cfg);
  assert.match(embedLost.title, /停損/);
  assert.doesNotMatch(embedLost.title, /回到成本價/);
});

test('price() 對缺值安全顯示', () => {
  assert.equal(price(undefined), '—');
  assert.equal(price(null), '—');
  assert.equal(price(50000), '50,000.0');
});
