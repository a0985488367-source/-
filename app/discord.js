/**
 * discord — Discord Webhook 通知
 *
 * 只做通知，不觸發任何交易動作（對應交接規格第八節的守衛原則）。
 *
 * Webhook URL 本身是機密：由宿主環境提供（iPhone 版存在 iOS Keychain），
 * 不寫進原始碼、不寫進 Git、不出現在通知內容或錯誤訊息裡。
 */

import { fpct, fx, priceDigits } from './format.js';

/** Discord Webhook 的合法網址型態 */
const WEBHOOK_PATTERN = /^https:\/\/(?:\w+\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]+$/;

export function isValidWebhookUrl(url) {
  return typeof url === 'string' && WEBHOOK_PATTERN.test(url.trim());
}

/** 遮罩後的顯示字串，永遠不顯示完整 URL */
export function maskWebhookUrl(url) {
  if (typeof url !== 'string' || !url) return '未設定';
  const m = /\/webhooks\/(\d+)\//.exec(url);
  return m ? `Webhook ••••${m[1].slice(-4)}` : 'Webhook ••••';
}

/* ------------------------------------------------------------------ */
/* 訊息組裝                                                             */
/* ------------------------------------------------------------------ */

/**
 * 單一候選的通知內容。
 *
 * 刻意不寫任何勝率、獲利或「必漲」字眼。
 * 只陳述掃描結果與機械換算出的參考價位。
 */
export function candidateMessage(c) {
  const d = priceDigits(c.lastPrice);
  const group = c.isMeme ? '迷因幣／高風險' : '主幣';
  const lines = [
    `**${c.symbol}** · ${group} · 完成度 ${c.score}`,
    `進場條件 ${c.readiness.passed}/${c.readiness.total} 已通過`,
    '',
    `Entry　${fx(c.entryLow, d)} – ${fx(c.entryHigh, d)}`,
    `SL　　${fx(c.stopLoss, d)}`,
    `TP1　 ${fx(c.takeProfit1, d)}　(1.5R)`,
    `TP2　 ${fx(c.takeProfit2, d)}　(2.5R)`,
    '',
    `距突破點 ${fpct(c.breakoutDistancePct)}　壓縮比 ${fx(c.compressionRatio, 3)}`,
    `量能 ${fx(c.volumeMultiple, 2)}x　OI ${fpct(c.oiChangePct)}`,
  ];
  if (c.riskLabel) lines.push('', `⚠ ${c.riskLabel}`);
  lines.push('', '完成度不是勝率。這是掃描結果，不是投資建議，也不會自動下單。');
  lines.push(c.bybitUrl);
  return lines.join('\n');
}

/**
 * 掃描摘要通知。
 * @param {{ready: Array, mainCount: number, memeCount: number, scannedAt: number}} summary
 */
export function summaryMessage(summary) {
  const when = new Date(summary.scannedAt).toISOString().replace('T', ' ').slice(0, 16);
  if (!summary.ready.length) {
    return `**Crypto Radar 掃描完成** · ${when} UTC\n主幣 ${summary.mainCount} 檔、迷因幣 ${summary.memeCount} 檔已分析，目前沒有符合全部進場條件的候選。`;
  }
  const names = summary.ready.map((c) => `${c.symbol}(${c.score})`).join('、');
  return `**Crypto Radar 掃描完成** · ${when} UTC\n符合全部進場條件：${names}\n完成度不是勝率，請自行確認風險。`;
}

/** 帳戶保護單缺漏的警示 */
export function protectionAlertMessage(positions) {
  const bad = positions.filter((p) => p.protection && p.protection.level !== 'ok');
  if (!bad.length) return null;
  const lines = ['**持倉保護檢查**', ''];
  for (const p of bad) {
    lines.push(`${p.symbol} ${p.side === 'long' ? '多' : '空'}　${p.protection.text}`);
  }
  lines.push('', '這是唯讀檢查，本工具不會替你掛單或平倉。');
  return lines.join('\n');
}

export function testMessage() {
  return '**Crypto Radar** 通知測試成功。\n本工具只讀取 Bybit 公開行情與唯讀帳戶資料，不會下單。';
}

/* ------------------------------------------------------------------ */
/* 去重與節流                                                           */
/* ------------------------------------------------------------------ */

/** 一則通知的識別碼：同一標的、同一狀態不重複發 */
export function notificationKey(c) {
  return `${c.symbol}:${c.entryReady ? 'ready' : 'watch'}:${c.stage}`;
}

/**
 * 決定這一輪要發哪些通知。
 *
 * @param {Array} readyCandidates 目前符合全部進場條件的候選
 * @param {{sent: Object, lastSentAt: number}} state 先前狀態
 * @param {number} now
 * @param {number} cooldownMinutes 同一標的的重複通知間隔
 */
export function selectNotifications(readyCandidates, state, now, cooldownMinutes = 60) {
  const sent = { ...(state?.sent ?? {}) };
  const cooldownMs = cooldownMinutes * 60_000;
  const toSend = [];

  for (const c of readyCandidates ?? []) {
    const key = notificationKey(c);
    const last = sent[key];
    if (!Number.isFinite(last) || now - last >= cooldownMs) {
      toSend.push(c);
      sent[key] = now;
    }
  }

  // 清掉超過一天的舊紀錄，避免狀態無限成長
  for (const key of Object.keys(sent)) {
    if (now - sent[key] > 86_400_000) delete sent[key];
  }

  return { toSend, state: { sent, lastSentAt: toSend.length ? now : (state?.lastSentAt ?? null) } };
}

/* ------------------------------------------------------------------ */
/* 送出                                                                */
/* ------------------------------------------------------------------ */

export const MAX_CONTENT_LENGTH = 1900;

export function buildPayload(content) {
  const text = String(content ?? '');
  return {
    content: text.length > MAX_CONTENT_LENGTH ? `${text.slice(0, MAX_CONTENT_LENGTH)}…` : text,
    allowed_mentions: { parse: [] },
  };
}

/**
 * 送出一則通知。
 *
 * @param {(url: string, payload: Object) => Promise<any>} post 由宿主環境注入的 POST 實作
 * @returns {Promise<{ok: boolean, error: string|null}>} 永遠不把 webhook URL 放進回傳
 */
export async function sendNotification(post, webhookUrl, content) {
  if (!isValidWebhookUrl(webhookUrl)) {
    return { ok: false, error: 'Webhook 網址格式不正確' };
  }
  try {
    await post(webhookUrl, buildPayload(content));
    return { ok: true, error: null };
  } catch (err) {
    const raw = String((err && err.message) ? err.message : err);
    // 錯誤訊息可能被記錄，先把 webhook URL 從裡面清掉
    return { ok: false, error: raw.split(webhookUrl).join('[webhook]') };
  }
}
