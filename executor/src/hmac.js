import crypto from 'node:crypto';
import { config } from './config.js';

/**
 * Worker → Executor 的請求驗證：HMAC-SHA256(timestamp + body) 用共享密鑰
 * 簽章，加上 timestamp 防重放（超過 REQUEST_MAX_AGE_SEC 就拒絕，即使
 * 簽章是對的——被錄下來的舊請求不能重播）。
 *
 * 標頭：
 *   X-Executor-Timestamp   毫秒級時間戳
 *   X-Executor-Signature   HMAC_SHA256(secret, timestamp + rawBody) 的十六進位字串
 *
 * 用 crypto.timingSafeEqual 比對簽章，避免時間差側錄攻擊。
 */
export function verifyRequest(timestampHeader, signatureHeader, rawBody) {
  if (!timestampHeader || !signatureHeader) return { ok: false, reason: '缺少驗證標頭' };

  const timestamp = Number(timestampHeader);
  if (!Number.isFinite(timestamp)) return { ok: false, reason: 'timestamp 格式不對' };

  const ageSec = Math.abs(Date.now() - timestamp) / 1000;
  if (ageSec > config.requestMaxAgeSec) {
    return { ok: false, reason: `timestamp 超過允許範圍（${ageSec.toFixed(1)} 秒，上限 ${config.requestMaxAgeSec} 秒）——可能是重放攻擊，或兩邊主機時間沒對齊` };
  }

  const expected = crypto.createHmac('sha256', config.hmacSecret).update(timestampHeader + rawBody).digest('hex');
  const expectedBuf = Buffer.from(expected, 'hex');
  const gotBuf = Buffer.from(String(signatureHeader), 'hex');
  if (expectedBuf.length !== gotBuf.length || !crypto.timingSafeEqual(expectedBuf, gotBuf)) {
    return { ok: false, reason: '簽章不符' };
  }
  return { ok: true };
}

/** 給 Worker 那邊組請求用的簽章邏輯（worker/index.js 會用對應的實作打這個服務） */
export function signRequest(timestamp, rawBody) {
  return crypto.createHmac('sha256', config.hmacSecret).update(String(timestamp) + rawBody).digest('hex');
}
