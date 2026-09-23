import { config } from './config.js';
import { logger } from './logger.js';

/**
 * Executor 自己的 Discord 告警——跟 Worker 那邊的訊號通知是分開的兩件事：
 * 這裡只在「Executor 這個服務本身」出狀況時發話（健康檢查失敗、緊急停止
 * 觸發、下單過程出現無法自動處理的例外），不會重複 Worker 已經在發的
 * 「訊號到了」「已平倉」那些通知。失敗只記 log，不丟例外——推播本身
 * 掛掉不該連帶讓呼叫端的請求跟著失敗。
 */
export async function alertDiscord(text) {
  if (!config.discordWebhookUrl) {
    logger.warn('沒有設定 DISCORD_WEBHOOK_URL，這則告警只會留在 log 裡', { text });
    return;
  }
  try {
    const res = await fetch(config.discordWebhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'Bybit Executor', content: text.slice(0, 1900) }),
    });
    if (!res.ok && res.status !== 204) logger.error('Discord 告警送不出去', { status: res.status });
  } catch (e) {
    logger.error('Discord 告警送不出去', { error: e.message });
  }
}
