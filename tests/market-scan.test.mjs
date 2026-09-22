import test from 'node:test';
import assert from 'node:assert/strict';
import { scanMarket, EXCLUDE_SYMBOL } from '../src/market/scan.js';

/**
 * 用 'demo' 資料源（src/data/providers.js 的離線合成行情，固定亂數種子、
 * 不打網路）測試 scanMarket() 本身的邏輯——範圍過濾、粗篩門檻、兩階段
 * 精算開關、輸出格狀——不用 mock fetch。
 */

test('回傳的結構符合 data/market.json 的格式', async () => {
  const out = await scanMarket({ providerIds: ['demo'], top: 12, detailTop: 5, minScore: 0 });
  assert.equal(out.provider, 'demo');
  assert.ok(out.generatedAt);
  assert.ok(Array.isArray(out.rows));
  assert.equal(typeof out.counts.ready, 'number');
  assert.equal(typeof out.counts.waiting, 'number');
  assert.equal(out.counts.total, out.rows.length);
});

test('top 限制掃描範圍', async () => {
  const out = await scanMarket({ providerIds: ['demo'], top: 3, detailTop: 0, minScore: 0 });
  assert.equal(out.universe, 3);
});

test('minScore 濾掉低於門檻的計畫', async () => {
  const low = await scanMarket({ providerIds: ['demo'], top: 12, detailTop: 0, minScore: 0 });
  const high = await scanMarket({ providerIds: ['demo'], top: 12, detailTop: 0, minScore: 999 });
  assert.ok(low.rows.length >= high.rows.length);
  assert.equal(high.rows.length, 0, '門檻設 999 分不可能有任何計畫達標');
});

test('detailTop=0 跳過精算階段，仍然回傳粗篩結果', async () => {
  const out = await scanMarket({ providerIds: ['demo'], top: 12, detailTop: 0, minScore: 0 });
  assert.ok(Array.isArray(out.rows));
  // 沒有精算就不會有 htfBias 這個欄位
  assert.ok(out.rows.every((r) => !('htfBias' in r)));
});

test('detailTop>0 會對前段補上 htfBias', async () => {
  const out = await scanMarket({ providerIds: ['demo'], top: 12, detailTop: 12, minScore: 0 });
  const withHtf = out.rows.filter((r) => 'htfBias' in r);
  assert.ok(withHtf.length > 0, '精算過的應該要有 htfBias 欄位（可能是 null，但欄位要在）');
});

test('資料源會依序 fallback：第一個掛掉就換下一個', async () => {
  const brokenProvider = 'not-a-real-provider-id';
  const out = await scanMarket({ providerIds: [brokenProvider, 'demo'], top: 5, detailTop: 0, minScore: 0 });
  assert.equal(out.provider, 'demo');
});

test('所有資料源都失敗就丟出錯誤', async () => {
  await assert.rejects(
    () => scanMarket({ providerIds: ['not-a-real-provider'], top: 5 }),
    /沒有可用的資料源/,
  );
});

test('EXCLUDE_SYMBOL 會擋掉穩定幣與槓桿代幣', () => {
  assert.equal(EXCLUDE_SYMBOL.test('USDCUSDT'), true);
  assert.equal(EXCLUDE_SYMBOL.test('BTCUPUSDT'), true);
  assert.equal(EXCLUDE_SYMBOL.test('BTCUSDT'), false);
});

test('rows 依評分排序（高到低）', async () => {
  const out = await scanMarket({ providerIds: ['demo'], top: 12, detailTop: 5, minScore: 0 });
  for (let i = 1; i < out.rows.length; i++) {
    assert.ok(out.rows[i - 1].score >= out.rows[i].score, '應該是高分排在前面');
  }
});

/* ------------------------------------------------------- batching（分批掃描） */

test('batchSize 只算這一批，不是整個候選池；poolTotal 回報候選池總大小', async () => {
  const out = await scanMarket({ providerIds: ['demo'], top: 12, batchSize: 5, offset: 0, detailTop: 0, minScore: 0 });
  assert.equal(out.universe, 5, '這一批只算 5 檔');
  assert.equal(out.poolTotal, 12, '候選池總共有 12 檔可以循環');
  assert.equal(out.universeSymbols.length, 5);
});

test('universeSymbols 含這一批算過的所有代號，即使沒通過門檻也在裡面', async () => {
  const out = await scanMarket({ providerIds: ['demo'], top: 12, batchSize: 5, offset: 0, detailTop: 0, minScore: 999 });
  assert.equal(out.rows.length, 0, '門檻設 999 分不會有任何計畫通過');
  assert.equal(out.universeSymbols.length, 5, '但 universeSymbols 還是要列出這一批考慮過的 5 檔');
});

test('offset 往前推可以拿到候選池裡不同的那一批', async () => {
  const first = await scanMarket({ providerIds: ['demo'], top: 12, batchSize: 4, offset: 0, detailTop: 0, minScore: 0 });
  const second = await scanMarket({ providerIds: ['demo'], top: 12, batchSize: 4, offset: 4, detailTop: 0, minScore: 0 });
  assert.deepEqual(
    first.universeSymbols.filter((s) => second.universeSymbols.includes(s)),
    [],
    '兩批應該是候選池裡不重疊的兩段',
  );
});

test('offset 超過候選池長度會循環回開頭（round-robin）', async () => {
  const out = await scanMarket({ providerIds: ['demo'], top: 12, batchSize: 5, offset: 10, detailTop: 0, minScore: 0 });
  const first = await scanMarket({ providerIds: ['demo'], top: 12, batchSize: 3, offset: 0, detailTop: 0, minScore: 0 });
  // offset=10、batchSize=5、池子共 12 檔：10,11,0,1,2 → 算完第 10、11 檔後應該繞回第 0、1、2 檔
  assert.deepEqual(out.universeSymbols.slice(-3), first.universeSymbols);
});

test('不帶 offset/batchSize 時維持舊行為：等同一次算完整個候選池', async () => {
  const out = await scanMarket({ providerIds: ['demo'], top: 12, detailTop: 0, minScore: 0 });
  assert.equal(out.universe, 12);
  assert.equal(out.poolTotal, 12);
});
