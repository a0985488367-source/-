#!/usr/bin/env node
/**
 * 產生 public/crypto-radar-deploy.scriptable.js
 *
 * 一支專門用來部署的 Scriptable 腳本。
 * 用 Cloudflare API 直接建 KV、上傳 Worker、設排程、開網址，
 * 完全不碰儀表板的程式編輯器。
 *
 * 兩支 Worker 的程式碼直接內嵌在裡面，所以這一份就是全部所需。
 */

import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { ROOT, inlineModule } from './lib-inline.mjs';

const outPath = resolve(ROOT, 'public/crypto-radar-deploy.scriptable.js');

const deployCore = inlineModule('app/cf-deploy.js');
const guardianScript = readFileSync(resolve(ROOT, 'public/crypto-radar-guardian.worker.min.js'), 'utf8');
const watchdogScript = readFileSync(resolve(ROOT, 'public/crypto-radar-watchdog.worker.min.js'), 'utf8');

const GLUE = String.raw`
/* ================= 內嵌的 Worker 程式碼 ================= */

const GUARDIAN_SCRIPT = __GUARDIAN__;
const WATCHDOG_SCRIPT = __WATCHDOG__;

/* ================= Keychain ================= */

const KEY_CF_TOKEN = 'crg.cf.token';
const KEY_CF_ACCOUNT = 'crg.cf.account';
const KEY_GUARDIAN_URL = 'crg.cf.guardianUrl';

// 這幾把跟掃描器共用。Scriptable 的 Keychain 是全 App 共通的，
// 所以你在掃描器裡設過的憑證，這裡直接讀得到。
const KEY_API_KEY = 'crg.bybit.apiKey';
const KEY_API_SECRET = 'crg.bybit.apiSecret';
const KEY_ENV = 'crg.bybit.env';
const KEY_WEBHOOK = 'crg.discord.webhook';
const KEY_ADMIN_TOKEN = 'crg.admin.token';

function kcGet(key) {
  try { return Keychain.contains(key) ? Keychain.get(key) : null; } catch (e) { return null; }
}
function kcSet(key, value) { Keychain.set(key, value); }
function kcRemove(key) { try { if (Keychain.contains(key)) Keychain.remove(key); } catch (e) {} }

function mask(value) {
  const s = String(value || '');
  if (s.length <= 8) return '••••';
  return s.slice(0, 4) + '••••' + s.slice(-4);
}

/* ================= Scriptable 的 fetch 轉接 ================= */

/**
 * 把 Scriptable 的 Request 包成 cf-deploy 期待的介面。
 * multipart 的部分要用 Scriptable 專屬 API，所以特別處理。
 */
async function scriptableFetch(url, init) {
  const req = new Request(url);
  req.method = init.method || 'GET';
  req.timeoutInterval = 120;

  const multipart = init.body && init.body.__multipart;
  if (multipart) {
    // Cloudflare 的 Worker 上傳是 multipart：一份 metadata JSON，一份程式碼
    const headers = Object.assign({}, init.headers);
    delete headers['Content-Type'];
    req.headers = headers;
    req.addParameterToMultipart('metadata', multipart.metadata);
    req.addFileDataToMultipart(
      Data.fromString(multipart.script),
      'application/javascript+module',
      multipart.mainModule,
      multipart.mainModule,
    );
  } else {
    req.headers = init.headers || {};
    if (init.body !== undefined) req.body = init.body;
  }

  // 一律先拿原始字串再自己解析。直接用 loadJSON 的話，
  // 解析失敗時就再也拿不到回應內容，錯誤訊息只能寫「未知錯誤」。
  let raw = '';
  try {
    raw = await req.loadString();
  } catch (e) {
    raw = '';
  }
  const status = (req.response && req.response.statusCode) || 0;

  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    parsed = null;
  }

  return {
    status,
    async json() {
      if (parsed !== null) return parsed;
      throw new Error('回應不是 JSON');
    },
    async text() { return raw; },
  };
}

function buildMultipart(parts) {
  return { headers: {}, body: { __multipart: parts } };
}

/* ================= 介面輔助 ================= */

async function notice(title, message) {
  const a = new Alert();
  a.title = title;
  a.message = message;
  a.addAction('好');
  await a.present();
}

async function confirm(title, message, okLabel) {
  const a = new Alert();
  a.title = title;
  a.message = message;
  a.addAction(okLabel || '繼續');
  a.addCancelAction('取消');
  return (await a.present()) === 0;
}

async function askText(title, message, label, initial, secure) {
  const a = new Alert();
  a.title = title;
  a.message = message;
  if (secure) a.addSecureTextField(label, initial || '');
  else a.addTextField(label, initial || '');
  a.addAction('確定');
  a.addCancelAction('取消');
  if ((await a.present()) === -1) return null;
  return (a.textFieldValue(0) || '').trim();
}

/* ================= 設定 ================= */

async function setupToken() {
  const guide = 'Cloudflare 儀表板 → 右上角頭像 → My Profile → API Tokens\n'
    + '→ Create Token → Create Custom Token\n\n'
    + '權限要加這兩項：\n'
    + REQUIRED_TOKEN_PERMISSIONS.map(function (p) { return '· ' + p; }).join('\n')
    + '\n\nToken 只存在這支手機的 Keychain。';

  const rawToken = await askText('Cloudflare API Token', guide, 'Token', '', true);
  if (rawToken === null) return false;

  // 貼上很容易帶到隱形字元，先清乾淨再看格式對不對，
  // 免得白跑一趟 API 才得到一句沒幫助的「invalid」
  const token = sanitizeToken(rawToken);
  const shape = inspectTokenShape(token);
  if (!shape.ok) {
    await notice('Token 看起來不對', shape.reason + '\n\n請重新複製一次完整的 Token。');
    return false;
  }

  const accountId = await resolveAccountId(token);
  if (!accountId) return false;

  // 用真正需要的權限去驗證，而不是用 /user/ 底下的端點。
  // 帳號層級的 Token 未必能呼叫那些，拿來驗會誤判成 Token 無效。
  try {
    const client = makeClient(token, scriptableFetch);
    const scripts = await verifyAccountAccess(client, accountId);
    kcSet(KEY_CF_TOKEN, token);
    kcSet(KEY_CF_ACCOUNT, accountId);
    await notice('連接成功',
      '權限確認完成。\n\n這個帳號目前有 ' + scripts.length + ' 支 Worker'
      + (scripts.length ? '：\n' + scripts.map(function (n) { return '· ' + n; }).join('\n') : '。')
      + '\n\n接下來可以選「② 部署 Guardian」。');
    return true;
  } catch (err) {
    await notice('權限確認失敗', describeStepError(err)
      + '\n\n請確認 Token 有這兩項權限：\n'
      + REQUIRED_TOKEN_PERMISSIONS.map(function (p) { return '· ' + p; }).join('\n')
      + '\n\n也請確認 Account ID 沒有貼錯。');
    return false;
  }
}

/**
 * 取得 Account ID。
 *
 * 先試著自動抓，抓不到就讓使用者自己貼。
 * 列出帳號需要的權限和部署需要的權限不一樣，
 * 抓不到不代表 Token 有問題，所以不能因此中斷。
 */
async function resolveAccountId(token) {
  const saved = kcGet(KEY_CF_ACCOUNT);

  try {
    const client = makeClient(token, scriptableFetch);
    const accounts = await listAccounts(client);
    if (accounts.length === 1) return accounts[0].id;

    const a = new Alert();
    a.title = '選擇 Cloudflare 帳號';
    a.message = '這個 Token 看得到多個帳號。';
    for (const acc of accounts) a.addAction(acc.name);
    a.addCancelAction('取消');
    const idx = await a.presentSheet();
    if (idx === -1) return null;
    return accounts[idx].id;
  } catch (e) {
    // 自動抓不到就手動輸入，這是很常見的情況，不是錯誤
    const hint = '這個 Token 沒有列出帳號的權限（很正常，部署用不到）。\n\n'
      + '請手動填 Account ID。它在 Cloudflare 儀表板網址裡：\n'
      + 'dash.cloudflare.com/<這一段就是>/workers\n\n'
      + '帳號首頁右下角也看得到，是一串 32 位的英數字。';
    const id = await askText('Account ID', hint, 'Account ID', saved || '', false);
    if (id === null) return null;
    const clean = sanitizeToken(id);
    if (!/^[0-9a-f]{32}$/i.test(clean)) {
      await notice('格式不對', 'Account ID 應該是 32 位的英數字。\n\n你輸入的是 ' + clean.length + ' 個字元。');
      return null;
    }
    return clean;
  }
}

function describeStepError(err) {
  if (err && err.step) return '卡在「' + err.step + '」這一步。\n\n' + err.message;
  return String((err && err.message) ? err.message : err);
}

/* ================= 部署 ================= */

async function deployGuardian() {
  const token = kcGet(KEY_CF_TOKEN);
  const accountId = kcGet(KEY_CF_ACCOUNT);
  if (!token || !accountId) { await notice('尚未設定', '請先設定 Cloudflare API Token。'); return; }

  const webhook = kcGet(KEY_WEBHOOK);
  const apiKey = kcGet(KEY_API_KEY);
  const apiSecret = kcGet(KEY_API_SECRET);
  const bybitEnv = kcGet(KEY_ENV) || 'live';
  let adminToken = kcGet(KEY_ADMIN_TOKEN);

  if (!adminToken) {
    // 沒設過就自動產一組，比使用者自己想的更難猜
    adminToken = randomToken();
    kcSet(KEY_ADMIN_TOKEN, adminToken);
  }

  const summary = 'Worker 名稱：crypto-radar-guardian\n'
    + '排程：每 5 分鐘\n'
    + 'Discord：' + (webhook ? '已帶入' : '未設定，不會通知') + '\n'
    + 'Bybit 帳戶：' + (apiKey && apiSecret ? '已帶入（' + bybitEnv + '）' : '未設定') + '\n\n'
    + '機密會直接寫進 Worker 的 Secrets，不會出現在網頁上。';

  if (!(await confirm('部署 Guardian', summary, '開始部署'))) return;

  try {
    const client = makeClient(token, scriptableFetch);
    const result = await deployWorker({
      client,
      accountId,
      scriptName: 'crypto-radar-guardian',
      script: GUARDIAN_SCRIPT,
      kvBindingName: 'GUARDIAN_KV',
      kvTitle: 'crypto-radar-guardian',
      secrets: {
        DISCORD_WEBHOOK: webhook,
        BYBIT_API_KEY: apiKey,
        BYBIT_API_SECRET: apiSecret,
        ADMIN_TOKEN: adminToken,
      },
      vars: { BYBIT_ENV: bybitEnv },
      crons: ['*/5 * * * *'],
      buildMultipart,
      onProgress: function (msg) { console.log(msg); },
      confirmReplace: confirmReplaceWorker,
    });

    if (result.url) kcSet(KEY_GUARDIAN_URL, result.url);

    await notice('部署完成', result.steps.join('\n')
      + '\n\n第一次掃描要等排程觸發，最多 5 分鐘。'
      + (result.url ? '\n\n看帳戶請在網址後面加：\n?token=' + adminToken : ''));
  } catch (err) {
    await notice('部署失敗', describeStepError(err));
  }
}

async function deployWatchdog() {
  const token = kcGet(KEY_CF_TOKEN);
  const accountId = kcGet(KEY_CF_ACCOUNT);
  if (!token || !accountId) { await notice('尚未設定', '請先設定 Cloudflare API Token。'); return; }

  const guardianUrl = kcGet(KEY_GUARDIAN_URL);
  const webhook = kcGet(KEY_WEBHOOK);
  if (!guardianUrl) { await notice('順序不對', '請先部署 Guardian，守衛才知道要監控誰。'); return; }
  if (!webhook) { await notice('缺少 Webhook', '守衛的唯一功能是發 Discord，沒有 Webhook 就沒有意義。'); return; }

  if (!(await confirm('部署心跳守衛',
    '監控對象：' + guardianUrl + '\n排程：每 10 分鐘\n\n'
    + '守衛只做監控與通知，沒有任何交易相關的程式路徑。', '開始部署'))) return;

  try {
    const client = makeClient(token, scriptableFetch);
    const result = await deployWorker({
      client,
      accountId,
      scriptName: 'crypto-radar-watchdog',
      script: WATCHDOG_SCRIPT,
      kvBindingName: 'WATCHDOG_KV',
      kvTitle: 'crypto-radar-watchdog',
      secrets: { GUARDIAN_URL: guardianUrl, DISCORD_WEBHOOK: webhook },
      crons: ['4,14,24,34,44,54 * * * *'],
      buildMultipart,
      onProgress: function (msg) { console.log(msg); },
      confirmReplace: confirmReplaceWorker,
    });
    await notice('部署完成', result.steps.join('\n'));
  } catch (err) {
    await notice('部署失敗', describeStepError(err));
  }
}

/**
 * 覆蓋既有 Worker 前的確認。
 *
 * Cloudflare 的上傳是整份取代，舊的程式碼與綁定會直接被換掉。
 * 如果那支 Worker 正在管理交易部位，覆蓋會讓部位失去保護，
 * 所以這裡一定要人點過才繼續。
 */
async function confirmReplaceWorker(info) {
  const others = info.otherScripts && info.otherScripts.length
    ? '\n\n帳號上其他 Worker（不會被動到）：\n'
      + info.otherScripts.map(function (n) { return '· ' + n; }).join('\n')
    : '';

  const a = new Alert();
  a.title = '這個名字已經有 Worker 了';
  a.message = '「' + info.scriptName + '」已經存在。\n\n'
    + '繼續的話會整份取代：原本的程式碼、KV 綁定、Secrets 都會換成這次上傳的內容。\n\n'
    + '如果那支正在管理交易部位，覆蓋後那些部位會失去保護。'
    + others;
  a.addDestructiveAction('確定覆蓋');
  a.addCancelAction('取消');
  return (await a.present()) === 0;
}

function randomToken() {
  const chars = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < 32; i += 1) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

/* ================= 檢查 ================= */

async function checkStatus() {
  const url = kcGet(KEY_GUARDIAN_URL);
  if (!url) { await notice('尚未部署', '還沒有 Guardian 的網址。'); return; }
  try {
    const req = new Request(url + '/api/status');
    req.timeoutInterval = 30;
    const s = await req.loadJSON();
    await notice('目前狀態',
      '版本：' + s.version + '\n'
      + '健康：' + s.health + '\n'
      + '排程：' + s.cron + '\n'
      + '資料來源：' + s.moonshotProvider + '\n'
      + '交易模式：' + s.tradeMode + '\n'
      + '最近分析：' + (s.analyzedCount === null ? '尚未執行' : s.analyzedCount + ' 檔')
      + '\n符合進場：' + (s.readyCount === null ? '—' : s.readyCount + ' 檔'));
  } catch (err) {
    await notice('讀取失敗', String((err && err.message) ? err.message : err));
  }
}

async function openSite() {
  const url = kcGet(KEY_GUARDIAN_URL);
  const adminToken = kcGet(KEY_ADMIN_TOKEN);
  if (!url) { await notice('尚未部署', '還沒有 Guardian 的網址。'); return; }
  Safari.open(adminToken ? url + '?token=' + encodeURIComponent(adminToken) : url);
}

async function clearAll() {
  if (!(await confirm('清除 Cloudflare 設定',
    '會刪除這支手機上的 Cloudflare Token、帳號與網址記錄。\n'
    + '已經部署的 Worker 不會被刪，要刪請到 Cloudflare 儀表板。', '刪除'))) return;
  kcRemove(KEY_CF_TOKEN);
  kcRemove(KEY_CF_ACCOUNT);
  kcRemove(KEY_GUARDIAN_URL);
  await notice('已清除', 'Cloudflare 相關設定都已移除。');
}

/* ================= 選單 ================= */

async function menu() {
  const token = kcGet(KEY_CF_TOKEN);
  const url = kcGet(KEY_GUARDIAN_URL);

  const a = new Alert();
  a.title = 'Crypto Radar 部署工具';
  a.message = 'Cloudflare：' + (token ? mask(token) : '未設定')
    + '\nGuardian：' + (url || '未部署');
  a.addAction(token ? '重新設定 Cloudflare Token' : '① 設定 Cloudflare Token');
  a.addAction('② 部署 Guardian');
  a.addAction('③ 部署心跳守衛（選配）');
  a.addAction('查看目前狀態');
  a.addAction('開啟網頁');
  a.addDestructiveAction('清除 Cloudflare 設定');
  a.addCancelAction('關閉');

  const idx = await a.presentSheet();
  if (idx === 0) { await setupToken(); await menu(); }
  else if (idx === 1) { await deployGuardian(); await menu(); }
  else if (idx === 2) { await deployWatchdog(); await menu(); }
  else if (idx === 3) { await checkStatus(); await menu(); }
  else if (idx === 4) { await openSite(); }
  else if (idx === 5) { await clearAll(); await menu(); }
}

try {
  await menu();
} catch (err) {
  await notice('執行失敗', describeStepError(err));
}

Script.complete();
`;

const out = `// Crypto Radar — Cloudflare 部署工具 (Scriptable)
//
// 這是什麼
//   用 Cloudflare API 直接把 Worker 部署上去，完全不碰儀表板的程式編輯器。
//   儀表板編輯器在手機上不穩，貼上大檔案後按 Deploy 常常沒反應，
//   這支腳本繞過那一段。
//
//   Guardian 與守衛的程式碼都已經內嵌在這個檔案裡，不需要另外準備。
//
// 使用步驟
//   1. 在 Scriptable 新增一個 Script，貼上這整份檔案
//   2. 執行，選「① 設定 Cloudflare Token」
//      Token 在 Cloudflare 儀表板 → 頭像 → My Profile → API Tokens
//      → Create Token → Create Custom Token，權限加這兩項：
//        Account → Workers Scripts → Edit
//        Account → Workers KV Storage → Edit
//   3. 選「② 部署 Guardian」，它會自動建 KV、上傳程式、設排程、開網址
//   4. 想要監控的話再選「③ 部署心跳守衛」
//
// 機密怎麼處理
//   Cloudflare Token 只存在這支手機的 Keychain。
//   Bybit 憑證與 Discord Webhook 會從掃描器那支腳本共用的 Keychain 讀取
//   （Scriptable 的 Keychain 是全 App 共通的），直接寫進 Worker 的
//   Secrets，不會出現在網頁上，也不會寫進任何檔案。
//   ADMIN_TOKEN 沒設過的話會自動產一組 32 字元隨機字串。
//
// 老實說
//   這支腳本的 Cloudflare API 呼叫沒有辦法在開發環境實測，
//   因為那個環境連不到 api.cloudflare.com。請求的組法有依照 Cloudflare
//   的 API 文件並寫了測試驗證構造，但實際能不能通要以你這邊執行為準。
//   任何一步失敗都會明確告訴你是哪一步、Cloudflare 回了什麼。

/* ============================================================
   部署邏輯 —— 由 app/cf-deploy.js 內嵌
   ============================================================ */
${deployCore}

/* ============================================================
   Scriptable 接線
   ============================================================ */
${GLUE
  .replace('__GUARDIAN__', JSON.stringify(guardianScript))
  .replace('__WATCHDOG__', JSON.stringify(watchdogScript))}
`;

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, out, 'utf8');
console.log(`已產生 ${outPath}`);
console.log(`大小 ${(Buffer.byteLength(out, 'utf8') / 1024).toFixed(1)} KB，${out.split('\n').length} 行`);
