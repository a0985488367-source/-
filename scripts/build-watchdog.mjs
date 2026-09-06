#!/usr/bin/env node
/**
 * 產生 public/crypto-radar-watchdog.worker.js —— 獨立 Discord 心跳守衛
 *
 * 刻意做成另一支 Worker：Guardian 整個掛掉時，守衛還活著才叫得出來。
 * 邏輯改在 app/watchdog-core.js，改完重跑本產生器。
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { ROOT, inlineModule } from './lib-inline.mjs';

const outPath = resolve(ROOT, 'public/crypto-radar-watchdog.worker.js');

const core = inlineModule('app/watchdog-core.js');
const discord = inlineModule('app/discord.js');
const format = inlineModule('app/format.js');

const ENTRY = `
/* ============================================================
   Worker 進入點
   ============================================================ */

const STATE_KEY = 'watchdog:state';

async function loadState(kv) {
  try {
    const raw = await kv.get(STATE_KEY);
    return raw ? JSON.parse(raw) : initialState();
  } catch (e) {
    return initialState();
  }
}

async function post(url, payload) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error('Discord 回應 HTTP ' + res.status);
}

async function probe(guardianUrl) {
  try {
    const res = await fetch(guardianUrl.replace(/\\/+$/, '') + '/health', {
      headers: { accept: 'application/json' },
    });
    let health = null;
    try { health = await res.json(); } catch (e) { health = null; }
    return { reachable: true, httpStatus: res.status, health };
  } catch (e) {
    return { reachable: false, httpStatus: null, health: null };
  }
}

async function runCheck(env, kv, now) {
  if (!env.GUARDIAN_URL) return { skipped: '缺少 GUARDIAN_URL' };

  const prev = await loadState(kv);
  const result = await probe(env.GUARDIAN_URL);
  const decision = evaluate({
    state: prev,
    now,
    reachable: result.reachable,
    health: result.health,
    httpStatus: result.httpStatus,
  });

  await kv.put(STATE_KEY, JSON.stringify(decision.state));

  if (decision.notify && isValidWebhookUrl(env.DISCORD_WEBHOOK)) {
    const sent = await sendNotification(post, env.DISCORD_WEBHOOK, decision.message);
    return { kind: decision.kind, sent: sent.ok, error: sent.error, reasons: decision.reasons };
  }
  return { kind: decision.kind, sent: false, error: null, reasons: decision.reasons };
}

export default {
  /**
   * Cron 觸發。設定為錯開整點的每 10 分鐘： 4,14,24,34,44,54 * * * *
   * 刻意與 Guardian 的排程錯開，避免同時執行時看到半完成的狀態。
   */
  async scheduled(event, env, ctx) {
    const kv = env.WATCHDOG_KV;
    if (!kv) {
      console.log('缺少 KV 綁定 WATCHDOG_KV，略過這一輪');
      return;
    }
    const out = await runCheck(env, kv, Date.now());
    console.log('守衛檢查：' + JSON.stringify(out));
  },

  async fetch(request, env, ctx) {
    const kv = env.WATCHDOG_KV;
    const headers = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
    if (!kv) {
      return new Response(JSON.stringify({ error: '缺少 KV 綁定 WATCHDOG_KV' }, null, 2), { status: 500, headers });
    }
    const state = await loadState(kv);
    const alive = watchdogAlive(state.checkedAt, Date.now());
    return new Response(JSON.stringify({
      ok: alive.alive,
      role: 'discord-heartbeat-watchdog',
      guardianUrl: env.GUARDIAN_URL ? '已設定' : '未設定',
      discordConfigured: Boolean(env.DISCORD_WEBHOOK),
      lastCheckedAt: state.checkedAt,
      lastCheckAgeMinutes: alive.ageMinutes === null ? null : Math.round(alive.ageMinutes),
      alerting: state.alerting,
      consecutiveMisses: state.consecutiveMisses,
      detail: alive.detail,
      note: '本服務只做監控與通知，不會改動任何交易或風險設定。',
    }, null, 2), { status: alive.alive ? 200 : 503, headers });
  },
};
`;

const out = `// Crypto Radar Guardian — Discord 心跳守衛 (Cloudflare Worker)
//
// 這是什麼
//   每 10 分鐘去看 Guardian 的 /health。連不上、狀態異常、或心跳過期時
//   發 Discord 通知；恢復了也通知一次。
//
//   刻意做成另一支獨立的 Worker：Guardian 整個掛掉時，
//   守衛還活著才叫得出來。
//
//   它只做監控與通知，沒有任何交易或風險相關的程式路徑。
//
// 兩個刻意的設計
//   遲滯：連續兩次偵測不到才告警。Guardian 每 5 分鐘跑、守衛每 10 分鐘看，
//         單次漏跑很正常，不該立刻叫。
//   節流：重送間隔 0 → 60 → 360 分鐘，長時間斷線不會洗版。
//
// 部署（同樣可以在手機瀏覽器操作）
//   1. dash.cloudflare.com → Workers & Pages → Create → Start from Hello World
//      命名為 crypto-radar-watchdog
//   2. Edit code，貼上這整份檔案，Deploy
//   3. Settings → Bindings → KV Namespace
//        Variable name: WATCHDOG_KV
//   4. Settings → Variables and Secrets：
//        GUARDIAN_URL     Guardian Worker 的網址（必填）
//        DISCORD_WEBHOOK  Discord Webhook 網址（必填）
//   5. Settings → Trigger Events → Cron Triggers：
//        4,14,24,34,44,54 * * * *
//
// 端點
//   /  守衛自己的狀態，包含 dead-man switch（守衛自己多久沒執行了）
//
// 要改邏輯
//   改 app/watchdog-core.js，然後執行 node scripts/build-watchdog.mjs

${format}

${discord}

${core}
${ENTRY}`;

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, out, 'utf8');
console.log(`已產生 ${outPath}`);
console.log(`大小 ${(Buffer.byteLength(out, 'utf8') / 1024).toFixed(1)} KB`);
