/**
 * bybit-private — Bybit V5 私有端點的唯讀存取
 *
 * 安全設計（對應交接規格三.6、三.7、十）：
 *
 * 1. 端點白名單。只有下面 PRIVATE_READ_ENDPOINTS 列出的 GET 端點可以呼叫。
 *    任何下單、改單、撤單、劃轉、提領端點都不在清單裡，呼叫會直接丟出例外。
 *    這是結構性限制，不是靠自律。
 *
 * 2. 憑證不進原始碼。API Key 與 Secret 由宿主環境提供（iPhone 版存在
 *    iOS Keychain），不寫進 Git、不寫進產生後的檔案、不出現在對話。
 *
 * 3. 建議使用唯讀 API Key。即使 Key 有交易權限，本模組也沒有下單路徑。
 *
 * 4. Secret 只用於計算簽章，不會被回傳、記錄或放進錯誤訊息。
 */

import { hmacSha256Hex } from './hmac-sha256.js';
import { BYBIT_BASE } from './bybit-base.js';

export const RECV_WINDOW = '5000';

/**
 * 允許呼叫的私有端點。全部是 GET、全部唯讀。
 * 要新增端點必須同時通過 tests/bybit-private.test.mjs 的白名單測試。
 */
export const PRIVATE_READ_ENDPOINTS = Object.freeze([
  '/v5/account/wallet-balance',
  '/v5/position/list',
  '/v5/position/closed-pnl',
  '/v5/execution/list',
  '/v5/order/realtime',
]);

/**
 * 明確禁止的端點型態。即使有人日後手滑加進白名單，
 * 這道檢查也會擋下來。
 */
const FORBIDDEN_PATTERNS = [
  /\/order\/create/i,
  /\/order\/amend/i,
  /\/order\/cancel/i,
  /\/order\/disconnected/i,
  /\/position\/set-/i,
  /\/position\/trading-stop/i,
  /\/position\/switch/i,
  /\/asset\/transfer/i,
  /\/asset\/withdraw/i,
  /\/account\/upgrade/i,
  /\/account\/set-/i,
  /\/user\//i,
];

export class ForbiddenEndpointError extends Error {
  constructor(path) {
    super(`端點不在唯讀白名單內，拒絕呼叫：${path}`);
    this.name = 'ForbiddenEndpointError';
  }
}

/**
 * 端點守門。任何不在白名單、或命中禁止樣式的路徑都會丟出例外。
 */
export function assertReadOnlyEndpoint(path) {
  const clean = String(path).split('?')[0];
  for (const pattern of FORBIDDEN_PATTERNS) {
    if (pattern.test(clean)) throw new ForbiddenEndpointError(clean);
  }
  if (!PRIVATE_READ_ENDPOINTS.includes(clean)) throw new ForbiddenEndpointError(clean);
  return clean;
}

/**
 * 依 Bybit V5 規則組出查詢字串。
 * 參數順序必須與實際送出的網址一致，否則簽章不會通過。
 */
export function buildQueryString(params) {
  const keys = Object.keys(params ?? {}).filter((k) => {
    const v = params[k];
    return v !== undefined && v !== null && v !== '';
  });
  return keys.map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(String(params[k]))}`).join('&');
}

/**
 * Bybit V5 GET 簽章：
 *   payload = timestamp + apiKey + recvWindow + queryString
 *   sign    = HMAC_SHA256(secret, payload) 的十六進位字串
 *
 * @returns {{url: string, headers: Object, queryString: string}}
 */
export function signGetRequest({ path, params, apiKey, apiSecret, timestamp, recvWindow }) {
  const cleanPath = assertReadOnlyEndpoint(path);

  if (typeof apiKey !== 'string' || apiKey.length === 0) throw new Error('缺少 API Key');
  if (typeof apiSecret !== 'string' || apiSecret.length === 0) throw new Error('缺少 API Secret');

  const ts = String(timestamp ?? Date.now());
  const recv = String(recvWindow ?? RECV_WINDOW);
  const queryString = buildQueryString(params);
  const payload = ts + apiKey + recv + queryString;
  const sign = hmacSha256Hex(apiSecret, payload);

  return {
    url: BYBIT_BASE + cleanPath + (queryString ? `?${queryString}` : ''),
    queryString,
    headers: {
      'X-BAPI-API-KEY': apiKey,
      'X-BAPI-TIMESTAMP': ts,
      'X-BAPI-RECV-WINDOW': recv,
      'X-BAPI-SIGN': sign,
      accept: 'application/json',
    },
  };
}

/* ------------------------------------------------------------------ */
/* 回應正規化                                                           */
/* ------------------------------------------------------------------ */

const toNum = (v) => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : NaN;
};

/** /v5/account/wallet-balance → 統一帳戶權益摘要 */
export function parseWalletBalance(result) {
  const account = result?.list?.[0];
  if (!account) return null;
  const usdt = (account.coin ?? []).find((c) => c.coin === 'USDT');
  return {
    accountType: account.accountType ?? null,
    totalEquityUsd: toNum(account.totalEquity),
    totalAvailableUsd: toNum(account.totalAvailableBalance),
    unrealizedPnlUsd: toNum(account.totalPerpUPL),
    usdtEquity: usdt ? toNum(usdt.equity) : NaN,
    usdtAvailable: usdt ? toNum(usdt.availableToWithdraw ?? usdt.walletBalance) : NaN,
  };
}

/** /v5/position/list → 目前持倉 */
export function parsePositions(result) {
  return (result?.list ?? [])
    .map((p) => ({
      symbol: p.symbol,
      side: p.side === 'Buy' ? 'long' : p.side === 'Sell' ? 'short' : null,
      size: toNum(p.size),
      entryPrice: toNum(p.avgPrice),
      markPrice: toNum(p.markPrice),
      leverage: toNum(p.leverage),
      unrealizedPnl: toNum(p.unrealisedPnl),
      positionValue: toNum(p.positionValue),
      takeProfit: toNum(p.takeProfit),
      stopLoss: toNum(p.stopLoss),
      liqPrice: toNum(p.liqPrice),
    }))
    .filter((p) => Number.isFinite(p.size) && p.size > 0);
}

/** /v5/position/closed-pnl → 已平倉紀錄 */
export function parseClosedPnl(result) {
  return (result?.list ?? []).map((r) => ({
    symbol: r.symbol,
    side: r.side === 'Buy' ? 'short' : 'long', // Bybit 記錄的是平倉方向，與開倉相反
    closedPnl: toNum(r.closedPnl),
    avgEntryPrice: toNum(r.avgEntryPrice),
    avgExitPrice: toNum(r.avgExitPrice),
    closedSize: toNum(r.closedSize),
    leverage: toNum(r.leverage),
    createdTime: toNum(r.createdTime),
  }));
}

/**
 * 持倉的保護單狀態。
 * TP 或 SL 任一缺漏都要在畫面上明確標示，這是交接規格反覆強調的保護。
 */
export function protectionStatus(position) {
  const hasTp = Number.isFinite(position.takeProfit) && position.takeProfit > 0;
  const hasSl = Number.isFinite(position.stopLoss) && position.stopLoss > 0;
  if (hasTp && hasSl) return { level: 'ok', text: 'TP／SL 皆已設定' };
  if (hasSl) return { level: 'warn', text: '只有 SL，缺 TP' };
  if (hasTp) return { level: 'danger', text: '只有 TP，缺 SL' };
  return { level: 'danger', text: '沒有 TP 也沒有 SL' };
}

/** 依已平倉紀錄計算當日已實現損益 */
export function realizedPnlSince(closedRecords, sinceMs) {
  const rows = (closedRecords ?? []).filter((r) => Number.isFinite(r.createdTime) && r.createdTime >= sinceMs);
  if (!rows.length) return { total: 0, count: 0 };
  return {
    total: rows.reduce((s, r) => s + (Number.isFinite(r.closedPnl) ? r.closedPnl : 0), 0),
    count: rows.length,
  };
}

/** 只顯示 Key 的前後幾碼，用於畫面確認，永遠不顯示完整值 */
export function maskApiKey(apiKey) {
  const s = String(apiKey ?? '');
  if (s.length <= 8) return '••••';
  return `${s.slice(0, 4)}••••${s.slice(-4)}`;
}
