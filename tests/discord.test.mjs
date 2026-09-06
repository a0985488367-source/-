import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_CONTENT_LENGTH,
  buildPayload,
  candidateMessage,
  isValidWebhookUrl,
  maskWebhookUrl,
  notificationKey,
  protectionAlertMessage,
  selectNotifications,
  sendNotification,
  summaryMessage,
  testMessage,
} from '../app/discord.js';

const HOOK = 'https://discord.com/api/webhooks/123456789012345678/abcDEF-ghi_JKL123';

const CAND = {
  symbol: 'ABCUSDT', score: 86, isMeme: false, riskLabel: null,
  readiness: { passed: 10, total: 10 }, entryReady: true, stage: 'NEAR_BREAKOUT',
  lastPrice: 100, entryLow: 99.3, entryHigh: 99.4, stopLoss: 98.9,
  takeProfit1: 100.15, takeProfit2: 100.65,
  breakoutDistancePct: 1.51, compressionRatio: 0.251, volumeMultiple: 1.6, oiChangePct: 1.2,
  bybitUrl: 'https://www.bybit.com/trade/usdt/ABCUSDT',
};

test('只接受合法的 Discord Webhook 網址', () => {
  assert.equal(isValidWebhookUrl(HOOK), true);
  assert.equal(isValidWebhookUrl('https://discordapp.com/api/webhooks/1/abc'), true);
  assert.equal(isValidWebhookUrl('https://evil.example.com/api/webhooks/1/abc'), false);
  assert.equal(isValidWebhookUrl('http://discord.com/api/webhooks/1/abc'), false, '必須是 https');
  assert.equal(isValidWebhookUrl('https://discord.com/api/webhooks/'), false);
  assert.equal(isValidWebhookUrl(''), false);
  assert.equal(isValidWebhookUrl(null), false);
});

test('Webhook 遮罩不顯示完整網址', () => {
  const masked = maskWebhookUrl(HOOK);
  assert.ok(!masked.includes('abcDEF'));
  assert.ok(!masked.includes('123456789012345678'));
  assert.equal(maskWebhookUrl(''), '未設定');
});

test('候選通知包含關鍵價位與 Bybit 連結', () => {
  const msg = candidateMessage(CAND);
  assert.match(msg, /ABCUSDT/);
  assert.match(msg, /完成度 86/);
  assert.match(msg, /進場條件 10\/10/);
  assert.match(msg, /SL/);
  assert.match(msg, /1\.5R/);
  assert.match(msg, /2\.5R/);
  assert.match(msg, /https:\/\/www\.bybit\.com\/trade\/usdt\/ABCUSDT/);
});

test('通知一律聲明完成度不是勝率，且不承諾獲利', () => {
  for (const msg of [candidateMessage(CAND), summaryMessage({ ready: [CAND], mainCount: 3, memeCount: 5, scannedAt: Date.now() })]) {
    assert.match(msg, /不是勝率/);
    for (const bad of [/保證/, /穩賺/, /必漲/, /勝率\s*\d/, /百倍/]) {
      assert.doesNotMatch(msg, bad, `不得出現 ${bad}`);
    }
  }
});

test('通知不會誤導成會自動下單', () => {
  assert.match(candidateMessage(CAND), /不會自動下單/);
  assert.match(testMessage(), /不會下單/);
});

test('迷因幣通知帶出風控標籤與分組', () => {
  const meme = { ...CAND, symbol: '1000PEPEUSDT', isMeme: true, riskLabel: '迷因幣 · 固定 0.15% 防守倉' };
  const msg = candidateMessage(meme);
  assert.match(msg, /迷因幣／高風險/);
  assert.match(msg, /固定 0\.15% 防守倉/);
});

test('沒有候選時的摘要文字誠實描述', () => {
  const msg = summaryMessage({ ready: [], mainCount: 3, memeCount: 9, scannedAt: Date.now() });
  assert.match(msg, /沒有符合全部進場條件/);
  assert.match(msg, /主幣 3 檔/);
  assert.match(msg, /迷因幣 9 檔/);
});

test('保護單缺漏警示只列出有問題的持倉', () => {
  const msg = protectionAlertMessage([
    { symbol: 'BTCUSDT', side: 'long', protection: { level: 'ok', text: 'TP／SL 皆已設定' } },
    { symbol: 'SOLUSDT', side: 'short', protection: { level: 'danger', text: '沒有 TP 也沒有 SL' } },
  ]);
  assert.match(msg, /SOLUSDT/);
  assert.ok(!msg.includes('BTCUSDT'), '正常的持倉不該出現');
  assert.match(msg, /不會替你掛單或平倉/);
  assert.equal(protectionAlertMessage([]), null);
});

test('同一標的在冷卻時間內不重複通知', () => {
  const now = Date.now();
  const first = selectNotifications([CAND], { sent: {} }, now);
  assert.equal(first.toSend.length, 1);

  const soon = selectNotifications([CAND], first.state, now + 30 * 60_000);
  assert.equal(soon.toSend.length, 0, '30 分鐘內不重送');

  const later = selectNotifications([CAND], first.state, now + 61 * 60_000);
  assert.equal(later.toSend.length, 1, '超過冷卻時間可再送');
});

test('狀態改變會產生新的通知識別碼', () => {
  assert.notEqual(notificationKey(CAND), notificationKey({ ...CAND, entryReady: false }));
  assert.notEqual(notificationKey(CAND), notificationKey({ ...CAND, stage: 'EXCLUDED' }));
});

test('超過一天的通知紀錄會被清掉，狀態不會無限成長', () => {
  const now = Date.now();
  const stale = { sent: { 'OLD:ready:NEAR_BREAKOUT': now - 86_400_000 * 2 } };
  const result = selectNotifications([], stale, now);
  assert.deepEqual(Object.keys(result.state.sent), []);
});

test('內容過長會截斷，且停用所有 mention', () => {
  const payload = buildPayload('x'.repeat(5000));
  assert.ok(payload.content.length <= MAX_CONTENT_LENGTH + 1);
  assert.deepEqual(payload.allowed_mentions, { parse: [] });
});

test('送出成功與失敗的回傳都不含 webhook 網址', async () => {
  const ok = await sendNotification(async () => ({}), HOOK, 'hi');
  assert.deepEqual(ok, { ok: true, error: null });
  assert.ok(!JSON.stringify(ok).includes('abcDEF'));

  const failed = await sendNotification(async () => { throw new Error(`POST ${HOOK} failed 401`); }, HOOK, 'hi');
  assert.equal(failed.ok, false);
  assert.ok(!failed.error.includes('abcDEF'), 'webhook 不得留在錯誤訊息裡');
  assert.match(failed.error, /\[webhook\]/);
});

test('網址不合法時不會發出任何請求', async () => {
  let called = false;
  const result = await sendNotification(async () => { called = true; }, 'https://evil.example.com/x', 'hi');
  assert.equal(called, false);
  assert.equal(result.ok, false);
  assert.match(result.error, /格式不正確/);
});
