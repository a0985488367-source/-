#!/usr/bin/env node
/**
 * 產生 public/crypto-radar-guardian.worker.js —— Cloudflare Worker 版
 *
 * 單一檔案，可以直接貼進 Cloudflare 儀表板的編輯器，不需要 wrangler、
 * 不需要 npm、不需要電腦。
 *
 * 邏輯改在 app/ 底下的原始檔，改完重跑本產生器。
 * 不要手改產生後的 .js。
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { ROOT, engineVersion, inlineModule, readText } from './lib-inline.mjs';

const outPath = resolve(ROOT, 'public/crypto-radar-guardian.worker.js');

const parts = [
  'app/bybit-base.js',
  'app/format.js',
  'app/hmac-sha256.js',
  'app/bybit-private.js',
  'app/discord.js',
  'app/scan-engine.js',
  'app/render.js',
  'app/worker-core.js',
  'app/worker-routes.js',
].map(inlineModule);

const css = readText('app/theme.css');
const version = engineVersion(parts[5]);

// worker-routes 裡的 __CSS__ 佔位符在這裡填入實際樣式
const body = parts.join('\n\n').replace('__CSS__', css.replace(/`/g, '\\`').replace(/\$\{/g, '\\${'));

const ENTRY = `
/* ============================================================
   Worker 進入點
   ============================================================ */

export default {
  // Cron 觸發。在 Cloudflare 設定為每 5 分鐘一次。
  // 排程字串見本檔開頭的部署說明第 5 步。
  async scheduled(event, env, ctx) {
    const kv = env.GUARDIAN_KV;
    if (!kv) {
      console.log('缺少 KV 綁定 GUARDIAN_KV，略過這一輪');
      return;
    }
    const result = await runScheduled({ env, kv, now: Date.now() });
    if (result.ok) {
      const g = result.state.groups;
      const ready = [...g.main, ...g.meme].filter((c) => c.entryReady).length;
      console.log('掃描完成：分析 ' + result.state.analyzedCount + ' 檔，可進場 ' + ready
        + ' 檔，通知 ' + result.notifyResult.sent + ' 則');
    } else {
      console.log('掃描失敗：' + result.error);
    }
  },

  async fetch(request, env, ctx) {
    const kv = env.GUARDIAN_KV;
    if (!kv) {
      return new Response(JSON.stringify({ error: '缺少 KV 綁定 GUARDIAN_KV' }, null, 2), {
        status: 500,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      });
    }
    try {
      return await handleRequest({ request, env, kv, now: Date.now() });
    } catch (err) {
      return new Response(JSON.stringify({ error: String(err && err.message ? err.message : err) }, null, 2), {
        status: 500,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      });
    }
  },
};
`;

const out = `// Crypto Radar Guardian — Cloudflare Worker
// 引擎版本 ${version}
//
// 這是什麼
//   每 5 分鐘自動掃描 Bybit USDT 線性永續，找出「已壓縮、量能溫和放大、
//   未平倉量增加、且尚未突破前高」的早期候選。主幣與迷因幣分開。
//   手機關機也照跑，有符合條件的標的就發 Discord。
//
// 部署（可以完全在手機瀏覽器操作）
//   1. dash.cloudflare.com → Workers & Pages → Create → Start from Hello World
//   2. 進 Edit code，把這整份檔案貼上去取代原本內容，Deploy
//   3. Settings → Bindings → 新增 KV Namespace
//        Variable name: GUARDIAN_KV
//        （先在 Storage & Databases → KV 建一個 namespace）
//   4. Settings → Variables and Secrets → 新增 Secret：
//        DISCORD_WEBHOOK   你的 Discord Webhook 網址（必填才會發通知）
//        BYBIT_API_KEY     唯讀 API Key（選填，要看帳戶才需要）
//        BYBIT_API_SECRET  唯讀 API Secret（選填）
//        BYBIT_ENV         live / demo / testnet（選填，預設 live）
//        ADMIN_TOKEN       自訂一組字串（選填，用來在網頁上看帳戶）
//   5. Settings → Trigger Events → Cron Triggers → 新增：
//        */5 * * * *
//   6. 開 Worker 的網址就看得到畫面
//
// 端點
//   /            最近一次掃描的網頁
//   /health      給心跳守衛用的健康檢查
//   /api/status  版本、心跳、排程等自檢資訊
//   /api/scan    最近一次掃描的原始 JSON
//
// 帳戶資料保護
//   餘額與持倉不會出現在公開網頁。要看必須在網址加上 ?token=你的ADMIN_TOKEN。
//
// 安全性
//   只呼叫 Bybit 公開行情與唯讀查詢端點，端點白名單寫死在程式裡，
//   任何下單、改單、撤單、提領路徑都會被 assertReadOnlyEndpoint 擋下。
//   機密只從 Cloudflare Secrets 讀，不寫進程式碼、不寫進 KV、
//   不出現在任何回應或錯誤訊息。
//
// 要改邏輯
//   改 app/ 底下的原始檔，然後執行 node scripts/build-worker.mjs
//   不要直接改這個檔案，它是產生出來的。

${body}
${ENTRY}`;

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, out, 'utf8');
console.log(`已產生 ${outPath}`);
console.log(`引擎版本 ${version}，大小 ${(Buffer.byteLength(out, 'utf8') / 1024).toFixed(1)} KB`);
