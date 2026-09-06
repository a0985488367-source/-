/**
 * worker-core — Cloudflare Worker 的掃描、狀態與通知邏輯
 *
 * 與 iPhone 版、瀏覽器版共用同一份掃描引擎與畫面模組。
 * 差別在於這裡由 cron 定時觸發，狀態存在 KV，手機關機也照跑。
 *
 * 子請求預算（Cloudflare 免費方案每次執行上限 50 個）：
 *   instruments-info + tickers        2
 *   第一段 12 檔 × (kline + OI)      24
 *   第二段 只對可進場的抓盤口 最多 4   4
 *   帳戶（設定了才抓）                3
 *   Discord 通知 最多                5
 *                              合計 ≤ 38
 * 所以刻意分兩段：先用 K 線與未平倉量跑完閘門，
 * 只有通過的少數標的才值得再花一個請求去看盤口深度。
 *
 * 機密一律從 env 讀（Cloudflare Secrets），不寫進程式碼、不寫進 KV、
 * 不出現在任何回應或錯誤訊息裡。
 */

import {
  buildCandidate,
  buildUniverse,
  parseKlines,
  parseOpenInterest,
  parseOrderbook,
  passesUniverseFilter,
  rankUniverse,
  splitByGroup,
  MAIN_WATCHLIST,
} from './scan-engine.js';
import { publicHostFor, privateHostFor, normalizeEnv, describeBybitError, sanitizeCredential } from './bybit-base.js';
import { signGetRequest, parseWalletBalance, parsePositions, parseClosedPnl, protectionStatus, realizedPnlSince, maskApiKey } from './bybit-private.js';
import {
  candidateMessage,
  isValidWebhookUrl,
  protectionAlertMessage,
  selectNotifications,
  sendNotification,
} from './discord.js';

export const WORKER_VERSION = 'Crypto Radar Guardian 10.0';
export const CRON_MINUTES = 5;

/** 第一段詳細分析的上限，扣掉主幣觀察清單後的名額 */
export const MAX_SCAN_TARGETS = 9;
/** 第二段只對可進場的標的抓盤口，避免子請求爆掉 */
export const MAX_DEPTH_LOOKUPS = 4;

export const KV_KEYS = Object.freeze({
  latest: 'state:latest',
  heartbeat: 'state:heartbeat',
  notify: 'state:notify',
  /** 帳戶資料另外存，讀取需要管理 Token */
  account: 'state:account',
});

/* ------------------------------------------------------------------ */
/* 抓取輔助                                                             */
/* ------------------------------------------------------------------ */

function qs(params) {
  const pairs = [];
  for (const key of Object.keys(params || {})) {
    const v = params[key];
    if (v === undefined || v === null || v === '') continue;
    pairs.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
  }
  return pairs.join('&');
}

/**
 * 建立一組綁定環境的 Bybit 讀取函式。
 * fetchImpl 可注入，測試時換成假的。
 */
export function makeBybitClient(env, fetchImpl) {
  const doFetch = fetchImpl ?? fetch;
  const bybitEnv = normalizeEnv(env.BYBIT_ENV);

  async function publicGet(path, params) {
    const query = qs(params);
    const url = publicHostFor(bybitEnv) + path + (query ? `?${query}` : '');
    const res = await doFetch(url, { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    if (json.retCode !== 0) throw new Error(describeBybitError(json.retCode, json.retMsg, bybitEnv));
    return json.result;
  }

  async function signedGet(path, params) {
    const apiKey = sanitizeCredential(env.BYBIT_API_KEY);
    const apiSecret = sanitizeCredential(env.BYBIT_API_SECRET);
    if (!apiKey || !apiSecret) throw new Error('未設定 Bybit 憑證');

    // signGetRequest 內含唯讀端點白名單，下單類端點會被擋下
    const signed = signGetRequest({
      path, params, apiKey, apiSecret, timestamp: Date.now(), env: bybitEnv,
    });
    const res = await doFetch(signed.url, { headers: signed.headers });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    if (json.retCode !== 0) throw new Error(describeBybitError(json.retCode, json.retMsg, bybitEnv));
    return json.result;
  }

  return { publicGet, signedGet, bybitEnv, hasCredentials: Boolean(sanitizeCredential(env.BYBIT_API_KEY) && sanitizeCredential(env.BYBIT_API_SECRET)) };
}

/* ------------------------------------------------------------------ */
/* 掃描                                                                */
/* ------------------------------------------------------------------ */

/**
 * 選出這一輪要分析的標的。
 * 主幣觀察清單一律納入，其餘依第一階段排名補到上限。
 */
export function selectWorkerTargets(rows, maxScan = MAX_SCAN_TARGETS) {
  const list = MAIN_WATCHLIST.map((s) => s.toUpperCase());
  const bySymbol = new Map();
  for (const r of rows ?? []) bySymbol.set(String(r.symbol).toUpperCase(), r);

  const main = [];
  for (const symbol of list) {
    const row = bySymbol.get(symbol);
    if (row) main.push(row);
  }
  const rest = (rows ?? []).filter((r) => !list.includes(String(r.symbol).toUpperCase()));
  const scan = rankUniverse(rest.filter(passesUniverseFilter)).slice(0, maxScan);
  return { main, scan, all: [...main, ...scan] };
}

/**
 * 跑一輪完整掃描。
 * 回傳的 state 會被寫進 KV，也是網頁與 /api/scan 的資料來源。
 */
export async function runScan(client, now = Date.now()) {
  const [instRes, tickRes] = await Promise.all([
    client.publicGet('/v5/market/instruments-info', { category: 'linear', limit: 1000 }),
    client.publicGet('/v5/market/tickers', { category: 'linear' }),
  ]);

  const rows = buildUniverse(instRes.list ?? [], tickRes.list ?? [], now);
  const universeCount = rows.filter(passesUniverseFilter).length;
  const targets = selectWorkerTargets(rows);

  // 第一段：K 線與未平倉量，先跑完閘門
  const built = [];
  const failed = [];
  for (const row of targets.all) {
    try {
      const [kl, oi] = await Promise.all([
        client.publicGet('/v5/market/kline', { category: 'linear', symbol: row.symbol, interval: 15, limit: 40 }),
        client.publicGet('/v5/market/open-interest', { category: 'linear', symbol: row.symbol, intervalTime: '15min', limit: 5 }),
      ]);
      built.push({ row, candidate: buildCandidate(row, parseKlines(kl.list), parseOpenInterest(oi.list), null) });
    } catch (err) {
      failed.push({ symbol: row.symbol, error: String(err?.message ?? err) });
    }
  }

  // 第二段：只有可進場的標的才值得再花一個請求看盤口深度
  const needsDepth = built.filter((b) => b.candidate.entryReady).slice(0, MAX_DEPTH_LOOKUPS);
  for (const item of needsDepth) {
    try {
      const ob = await client.publicGet('/v5/market/orderbook', { category: 'linear', symbol: item.row.symbol, limit: 50 });
      const kl = item.candidate;
      // 只補深度資訊，不重算閘門
      const depth = parseOrderbook(ob);
      const rebuilt = buildCandidate(item.row, [], [], depth);
      item.candidate.depthUsd = rebuilt.depthUsd;
      item.candidate.maxPositionUsd = rebuilt.maxPositionUsd;
      void kl;
    } catch {
      // 深度抓不到就維持沒有深度資訊，不影響閘門結果
    }
  }

  const candidates = built.map((b) => b.candidate);
  return {
    version: WORKER_VERSION,
    scannedAt: now,
    universeCount,
    analyzedCount: targets.all.length,
    candidates,
    groups: splitByGroup(candidates),
    failed,
    busy: false,
    error: null,
    account: null,
  };
}

/* ------------------------------------------------------------------ */
/* 帳戶（唯讀）                                                         */
/* ------------------------------------------------------------------ */

export async function fetchAccount(client, env) {
  if (!client.hasCredentials) return null;
  try {
    const [walletRes, posRes, pnlRes] = await Promise.all([
      client.signedGet('/v5/account/wallet-balance', { accountType: 'UNIFIED' }),
      client.signedGet('/v5/position/list', { category: 'linear', settleCoin: 'USDT' }),
      client.signedGet('/v5/position/closed-pnl', { category: 'linear', limit: 50 }),
    ]);
    const positions = parsePositions(posRes).map((p) => ({ ...p, protection: protectionStatus(p) }));
    return {
      wallet: parseWalletBalance(walletRes),
      positions,
      todayPnl: realizedPnlSince(parseClosedPnl(pnlRes), Date.now() - 86_400_000),
      keyMask: maskApiKey(sanitizeCredential(env.BYBIT_API_KEY)),
      error: null,
    };
  } catch (err) {
    const raw = String(err?.message ?? err);
    const key = sanitizeCredential(env.BYBIT_API_KEY);
    const secret = sanitizeCredential(env.BYBIT_API_SECRET);
    const safe = raw.split(key).join('[key]').split(secret).join('[secret]');
    return { error: safe, keyMask: maskApiKey(key) };
  }
}

/* ------------------------------------------------------------------ */
/* Discord                                                             */
/* ------------------------------------------------------------------ */

export function makeDiscordPoster(fetchImpl) {
  const doFetch = fetchImpl ?? fetch;
  return async (url, payload) => {
    const res = await doFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`Discord 回應 HTTP ${res.status}`);
  };
}

/**
 * 依掃描結果決定要發哪些通知並送出。
 * 通知狀態存在 KV，跨執行去重。
 */
export async function notify(state, env, kv, poster, now = Date.now()) {
  const webhook = env.DISCORD_WEBHOOK;
  if (!isValidWebhookUrl(webhook)) return { sent: 0, error: null, skipped: '未設定 Webhook' };

  const groups = state.groups ?? { main: [], meme: [] };
  const ready = [...groups.main, ...groups.meme].filter((c) => c.entryReady);

  let prev = { sent: {}, lastSentAt: null };
  try {
    const raw = await kv.get(KV_KEYS.notify);
    if (raw) prev = JSON.parse(raw);
  } catch { /* 壞掉的狀態就當成空的重來 */ }

  const picked = selectNotifications(ready, prev, now);

  let sent = 0;
  let lastError = null;
  for (const c of picked.toSend) {
    const res = await sendNotification(poster, webhook, candidateMessage(c));
    if (res.ok) sent += 1; else lastError = res.error;
  }

  if (state.account?.positions) {
    const msg = protectionAlertMessage(state.account.positions);
    if (msg) {
      const res = await sendNotification(poster, webhook, msg);
      if (res.ok) sent += 1; else lastError = res.error;
    }
  }

  await kv.put(KV_KEYS.notify, JSON.stringify(picked.state));
  return { sent, error: lastError, skipped: null };
}

/* ------------------------------------------------------------------ */
/* KV 狀態                                                             */
/* ------------------------------------------------------------------ */

/**
 * 寫入掃描結果與心跳。
 *
 * 帳戶資料刻意不寫進 latest：那份會被公開網頁讀到。
 * 帳戶只在本次執行的記憶體裡用來發保護單警示。
 */
export async function saveState(kv, state, now = Date.now()) {
  const publicState = { ...state, account: null };
  await kv.put(KV_KEYS.latest, JSON.stringify(publicState));
  if (state.account) {
    await kv.put(KV_KEYS.account, JSON.stringify({ ...state.account, savedAt: now }));
  }
  await kv.put(KV_KEYS.heartbeat, JSON.stringify({
    at: now,
    version: WORKER_VERSION,
    ok: !state.error,
    analyzed: state.analyzedCount,
    failed: state.failed?.length ?? 0,
  }));
}

export async function loadState(kv) {
  try {
    const raw = await kv.get(KV_KEYS.latest);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export async function loadAccount(kv) {
  try {
    const raw = await kv.get(KV_KEYS.account);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export async function loadHeartbeat(kv) {
  try {
    const raw = await kv.get(KV_KEYS.heartbeat);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* cron 進入點                                                          */
/* ------------------------------------------------------------------ */

/**
 * 一次排程執行：掃描 → 讀帳戶 → 發通知 → 寫 KV。
 * 任何一段失敗都會寫入心跳，讓守衛看得到狀態。
 */
export async function runScheduled({ env, kv, fetchImpl, now = Date.now() }) {
  const client = makeBybitClient(env, fetchImpl);
  const poster = makeDiscordPoster(fetchImpl);

  try {
    const state = await runScan(client, now);
    state.account = await fetchAccount(client, env);
    const notifyResult = await notify(state, env, kv, poster, now);
    await saveState(kv, state, now);
    return { ok: true, state, notifyResult };
  } catch (err) {
    const raw = String(err?.message ?? err);
    await kv.put(KV_KEYS.heartbeat, JSON.stringify({
      at: now, version: WORKER_VERSION, ok: false, error: raw,
    }));
    return { ok: false, error: raw };
  }
}
