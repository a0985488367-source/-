/**
 * worker-routes — Cloudflare Worker 的 HTTP 端點
 *
 *   GET /              最近一次掃描的網頁，手機直接開
 *   GET /health        給 Discord 心跳守衛用的極簡健康檢查
 *   GET /api/status    版本、心跳、排程、資料來源等自檢資訊
 *   GET /api/scan      最近一次掃描的原始 JSON
 *
 * 帳戶資料（餘額與持倉）不會出現在公開頁面。
 * 要看必須帶 ?token= 且與 ADMIN_TOKEN 相符。
 */

import { listHtml, statText, DISCLAIMER_HTML } from './render.js';
import { PROVIDER, ENGINE_VERSION } from './scan-engine.js';
import { normalizeEnv, ENV_LABEL } from './bybit-base.js';
import { CRON_MINUTES, WORKER_VERSION, fetchAccount, loadHeartbeat, loadState, makeBybitClient, runScheduled } from './worker-core.js';

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
const HTML_HEADERS = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' };

const json = (body, status = 200) => new Response(JSON.stringify(body, null, 2), { status, headers: JSON_HEADERS });

/**
 * 定時比較，避免用字串長度或提早返回洩漏 Token 資訊。
 */
export function safeEqual(a, b) {
  const x = String(a ?? '');
  const y = String(b ?? '');
  if (x.length === 0 || y.length === 0) return false;
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i += 1) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

/**
 * 兩種帶 Token 的方式都接受：
 *   網址參數 ?token=   給手機直接開網頁用
 *   X-Admin-Token 標頭  給外部排程用，不會留在網址與記錄裡
 */
export function isAuthorized(url, env, request) {
  const expected = env.ADMIN_TOKEN;
  if (!expected) return false;
  if (safeEqual(url.searchParams.get('token'), expected)) return true;
  const header = request?.headers?.get?.('x-admin-token');
  return safeEqual(header, expected);
}

/** 心跳年齡（秒）。沒有心跳時回傳 null。 */
export function heartbeatAgeSeconds(heartbeat, now) {
  if (!heartbeat || !Number.isFinite(heartbeat.at)) return null;
  return Math.max(0, Math.round((now - heartbeat.at) / 1000));
}

/**
 * 健康狀態判定。
 * 心跳超過兩個排程週期就算不健康，讓守衛在真的漏跑時才叫。
 */
export function healthOf(heartbeat, now) {
  const ageSeconds = heartbeatAgeSeconds(heartbeat, now);
  const staleAfter = CRON_MINUTES * 60 * 2 + 60;
  if (ageSeconds === null) return { ok: false, status: 'no-heartbeat', ageSeconds: null };
  if (!heartbeat.ok) return { ok: false, status: 'last-run-failed', ageSeconds };
  if (ageSeconds > staleAfter) return { ok: false, status: 'stale', ageSeconds };
  return { ok: true, status: 'healthy', ageSeconds };
}

export async function handleRequest({ request, env, kv, now = Date.now() }) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';

  // 手動觸發一次掃描。
  //
  // 為什麼需要：Cloudflare 免費方案每個帳號只有 5 個 cron 觸發器。
  // 額度用完時，可以改用外部排程（例如 GitHub Actions）定時打這個端點，
  // 效果與 cron 一樣，不佔用 Cloudflare 的額度。
  //
  // 一定要帶管理 Token，否則任何人都能叫它掃描。
  if (path === '/scan') {
    if (!env.ADMIN_TOKEN) {
      return json({ error: '未設定 ADMIN_TOKEN，手動觸發已停用' }, 403);
    }
    if (!isAuthorized(url, env, request)) {
      return json({ error: 'unauthorized' }, 401);
    }
    const result = await runScheduled({ env, kv, now });
    if (!result.ok) return json({ ok: false, error: result.error }, 500);
    const g = result.state.groups;
    return json({
      ok: true,
      scannedAt: result.state.scannedAt,
      analyzed: result.state.analyzedCount,
      ready: [...g.main, ...g.meme].filter((c) => c.entryReady).length,
      notified: result.notifyResult?.sent ?? 0,
    });
  }

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return json({ error: 'method not allowed' }, 405);
  }

  const heartbeat = await loadHeartbeat(kv);
  const health = healthOf(heartbeat, now);

  if (path === '/health') {
    return json({
      ok: health.ok,
      status: health.status,
      version: WORKER_VERSION,
      heartbeatAt: heartbeat?.at ?? null,
      ageSeconds: health.ageSeconds,
    }, health.ok ? 200 : 503);
  }

  if (path === '/api/status') {
    const state = await loadState(kv);
    return json({
      version: WORKER_VERSION,
      engine: ENGINE_VERSION,
      health: health.status,
      ok: health.ok,
      heartbeatAt: heartbeat?.at ?? null,
      heartbeatAgeSeconds: health.ageSeconds,
      cron: `每 ${CRON_MINUTES} 分鐘`,
      moonshotProvider: PROVIDER,
      bybitEnvironment: ENV_LABEL[normalizeEnv(env.BYBIT_ENV)],
      // 這個服務只讀取行情與唯讀帳戶資料，沒有下單路徑
      tradeMode: 'read-only',
      autoTrading: false,
      discordConfigured: Boolean(env.DISCORD_WEBHOOK),
      bybitAccountConfigured: Boolean(env.BYBIT_API_KEY && env.BYBIT_API_SECRET),
      lastScanAt: state?.scannedAt ?? null,
      universeCount: state?.universeCount ?? null,
      analyzedCount: state?.analyzedCount ?? null,
      readyCount: state ? [...(state.groups?.main ?? []), ...(state.groups?.meme ?? [])].filter((c) => c.entryReady).length : null,
      failedCount: state?.failed?.length ?? null,
    });
  }

  if (path === '/api/scan') {
    const state = await loadState(kv);
    if (!state) return json({ error: '尚未有掃描結果' }, 503);
    return json(state);
  }

  if (path === '/') {
    const state = await loadState(kv);
    // 帳戶資料不存 KV。帶對 Token 的人才即時去 Bybit 查一次。
    const account = isAuthorized(url, env, request)
      ? await fetchAccount(makeBybitClient(env), env)
      : null;
    return new Response(pageHtml(state, account, heartbeat, health, env, now), { headers: HTML_HEADERS });
  }

  return json({ error: 'not found' }, 404);
}

/* ------------------------------------------------------------------ */
/* 網頁                                                                */
/* ------------------------------------------------------------------ */

function fmtTime(ms) {
  if (!Number.isFinite(ms)) return '—';
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}

export function pageHtml(state, account, heartbeat, health, env, now) {
  const groups = state?.groups ?? { main: [], meme: [] };
  const readyCount = [...groups.main, ...groups.meme].filter((c) => c.entryReady).length;

  const healthTone = health.ok ? 'ok' : 'warn';
  const healthText = health.ok
    ? `運作正常 · 心跳 ${health.ageSeconds} 秒前`
    : health.status === 'no-heartbeat'
      ? '尚未執行過排程掃描'
      : health.status === 'last-run-failed'
        ? '上一次排程執行失敗'
        : `心跳已 ${Math.round((health.ageSeconds ?? 0) / 60)} 分鐘未更新`;

  const banner = health.ok ? '' : `
    <div class="banner">
      <div class="bt">${healthText}</div>
      <div class="bd">排程為每 ${CRON_MINUTES} 分鐘一次。若持續異常，請到 Cloudflare 檢查 Worker 的 Cron 觸發器與記錄。</div>
    </div>`;

  const viewState = state
    ? { ...state, account, busy: false }
    : { candidates: [], groups: { main: [], meme: [] }, failed: [], scannedAt: null, busy: false, error: null, account: null };

  const accountHint = account ? '' : `
    <div style="margin-top:6px;color:var(--muted)">帳戶資料未顯示。若已設定 ADMIN_TOKEN，請在網址加上 <code>?token=你的Token</code>。</div>`;

  return `<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="color-scheme" content="dark">
<meta name="robots" content="noindex, nofollow">
<meta http-equiv="refresh" content="300">
<title>Crypto Radar Guardian</title>
<style>__CSS__</style>
</head>
<body>
<div class="wrap">
  <header>
    <div class="title">
      <h1>Crypto Radar Guardian</h1>
      <span class="ver">v10.0 · Cloudflare Worker</span>
    </div>
    <div style="margin-top:6px">
      <span class="srcbadge">◈ 資料來源 <b>Bybit /v5/market</b></span>
    </div>
    <div class="bar">
      <span class="meta" style="margin-left:0">
        掃描於 ${fmtTime(state?.scannedAt)}　·　符合進場條件 ${readyCount} 檔
      </span>
    </div>
  </header>

  ${banner}

  <div class="note">
    <strong>早期快噴掃描</strong>：在 Bybit USDT 線性永續中，尋找「已壓縮、量能溫和放大、未平倉量增加、且尚未突破前高」的標的。
    已經噴過的一律排除。${statText({ ...viewState, scannedAt: state?.scannedAt })}
    <div style="margin-top:6px;color:var(--muted)">
      由 Cloudflare Worker 每 ${CRON_MINUTES} 分鐘自動掃描，${healthText}。本頁每 5 分鐘自動重新整理。
    </div>${accountHint}
  </div>

  ${listHtml(viewState)}
${DISCLAIMER_HTML}
</div>
</body>
</html>`;
}
