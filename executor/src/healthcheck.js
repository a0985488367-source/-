import { config } from './config.js';
import { logger } from './logger.js';
import { alertDiscord } from './discord.js';
import { bybitCall } from './bybit.js';

/**
 * 緊急停止狀態——啟動時、以及之後每隔 HEALTH_CHECK_INTERVAL_MIN 分鐘都
 * 會重新檢查一次。任何會下單／改單的路由開頭都要先檢查這個旗標；旗標
 * 是這個程序自己記在記憶體裡的，跟 Cloudflare KV 的 auto-trade:enabled
 * 開關完全獨立——就算 Worker 那邊沒查覺、繼續送單過來，Executor 自己
 * 判斷連不到 Bybit 就會直接拒絕，不會因為 Worker 沒發現而繼續嘗試。
 */
const state = {
  tripped: false,
  reason: null,
  lastCheckedAt: null,
  publicIp: null,
};

export function emergencyState() {
  return { ...state };
}

/** 手動觸發／解除緊急停止（給 /emergency-stop 管理端點用） */
export function setEmergencyStop(tripped, reason) {
  state.tripped = tripped;
  state.reason = tripped ? reason : null;
}

async function fetchPublicIp() {
  try {
    const res = await fetch('https://ipinfo.io/json', { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const j = await res.json();
    return { ip: j.ip, country: j.country, region: j.region };
  } catch {
    return null;
  }
}

/**
 * 依序測：對外 IP／地區、Bybit 伺服器時間（不需要簽章的公開端點，純粹
 * 測連線）、簽章過的私有端點（查餘額，確認金鑰跟簽章邏輯本身沒問題）。
 * 任何一步出現 403 就直接判定是「connectivity / region failure」，觸發
 * 緊急停止並通知 Discord——啟動時就先擋下來，不要等到真的送出下單請求
 * 才發現連不上。
 */
export async function runHealthCheck({ announceRecovery = false } = {}) {
  const ipInfo = await fetchPublicIp();
  state.publicIp = ipInfo;

  let bybitReachable = false;
  let reason = null;
  try {
    await bybitCall('GET', '/v5/market/time', {});
    bybitReachable = true;
  } catch (e) {
    reason = `連不到 Bybit（${config.bybitHost}）：${e.message}`;
  }

  state.lastCheckedAt = new Date().toISOString();

  if (!bybitReachable) {
    const wasTripped = state.tripped;
    state.tripped = true;
    state.reason = reason;
    if (!wasTripped) {
      logger.error('健康檢查失敗，觸發緊急停止', { reason, ip: ipInfo });
      await alertDiscord(
        `🚨 **Executor 緊急停止**：健康檢查失敗，禁止任何交易\n` +
        `- 原因：${reason}\n` +
        `- 目前對外 IP：${ipInfo ? `${ipInfo.ip}（${ipInfo.country || '?'}）` : '查不到'}\n` +
        `- 會每 ${config.healthCheckIntervalMin} 分鐘自動重新檢查，恢復正常會再通知`,
      );
    }
    return { healthy: false, reason, ip: ipInfo };
  }

  const wasTripped = state.tripped;
  state.tripped = false;
  state.reason = null;
  if (wasTripped && announceRecovery) {
    logger.info('健康檢查恢復正常，解除緊急停止');
    await alertDiscord(`✅ **Executor 恢復正常**：健康檢查通過，交易功能已自動恢復\n- 目前對外 IP：${ipInfo ? `${ipInfo.ip}（${ipInfo.country || '?'}）` : '查不到'}`);
  }
  return { healthy: true, ip: ipInfo };
}

export function startHealthCheckLoop() {
  const intervalMs = config.healthCheckIntervalMin * 60 * 1000;
  setInterval(() => {
    runHealthCheck({ announceRecovery: true }).catch((e) => logger.error('健康檢查本身出例外', { error: e.message }));
  }, intervalMs);
}
