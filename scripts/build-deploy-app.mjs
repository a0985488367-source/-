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

async function deployGuardian(opts) {
  const token = kcGet(KEY_CF_TOKEN);
  const accountId = kcGet(KEY_CF_ACCOUNT);
  const silent = opts && opts.silent;
  if (!token || !accountId) { await notice('尚未設定', '請先設定 Cloudflare API Token。'); return null; }

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

  if (!(await confirm('部署 Guardian', summary, '開始部署'))) return null;

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

    // 一鍵流程要自己接手處理排程問題，所以這裡不重複跳訊息
    if (!silent) {
      if (result.scheduleError) {
        await reportScheduleFailure(result, 'crypto-radar-guardian');
      } else {
        await notice('部署完成', result.steps.join('\n')
          + '\n\n第一次掃描要等排程觸發，最多 5 分鐘。'
          + (result.url ? '\n\n看帳戶請在網址後面加：\n?token=' + adminToken : ''));
      }
    }
    return result;
  } catch (err) {
    await notice('部署失敗', describeStepError(err));
    return null;
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
    if (result.scheduleError) await reportScheduleFailure(result, 'crypto-radar-watchdog');
    else await notice('部署完成', result.steps.join('\n'));
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

/**
 * 排程沒設成功時的說明。
 *
 * 這時 Worker 已經部署好了，少的只是自動觸發，所以不能寫成「部署失敗」。
 * 撞到免費方案的 cron 上限是最常見的原因，直接把解法講出來。
 */
async function reportScheduleFailure(result, scriptName) {
  const err = result.scheduleError;
  const base = result.steps.join('\n')
    + '\n\nWorker 本身已經部署好了，網頁打得開。\n少的是自動觸發，所以還不會自己掃描。\n\n';

  if (isCronLimitError(err)) {
    await notice('已部署，但排程沒設成',
      base
      + '原因：免費方案每個帳號只有 5 個 cron 觸發器，已經用完。\n\n'
      + '兩條路：\n'
      + '· 選「查看 Cron 用量」看是誰佔著，把不用的刪掉，再選「只設定排程」\n'
      + '· 或升級 Workers Paid（每月 5 美元），上限變 1000');
  } else {
    await notice('已部署，但排程沒設成', base + '原因：\n' + describeStepError(err));
  }
}

/**
 * 只補設排程，不重新上傳。
 * 給「Worker 已經在了，但當初排程沒設成」的情況用。
 */
async function setCronOnly() {
  const token = kcGet(KEY_CF_TOKEN);
  const accountId = kcGet(KEY_CF_ACCOUNT);
  if (!token || !accountId) { await notice('尚未設定', '請先設定 Cloudflare API Token。'); return; }

  const a = new Alert();
  a.title = '只設定排程';
  a.message = '要幫哪一支補設排程？Worker 本身不會重新上傳。';
  a.addAction('Guardian（每 5 分鐘）');
  a.addAction('守衛（每 10 分鐘）');
  a.addCancelAction('取消');
  const idx = await a.presentSheet();
  if (idx === -1) return;

  const target = idx === 0
    ? { name: 'crypto-radar-guardian', crons: ['*/5 * * * *'] }
    : { name: 'crypto-radar-watchdog', crons: ['4,14,24,34,44,54 * * * *'] };

  try {
    const client = makeClient(token, scriptableFetch);
    await setSchedules(client, accountId, target.name, target.crons);
    await notice('排程已設定', target.name + '\n' + target.crons.join('、')
      + '\n\n第一次觸發最多要等一個排程週期。');
  } catch (err) {
    if (isCronLimitError(err)) {
      await notice('額度仍然不足',
        '免費方案的 5 個 cron 觸發器還是滿的。\n\n'
        + '請先用「查看 Cron 用量」找出可以釋出的，刪掉之後再試一次。');
    } else {
      await notice('設定失敗', describeStepError(err));
    }
  }
}

/**
 * 盤點帳號上的 cron 用量。
 * 免費方案上限是 5 個，用滿了新的就設不上去。
 */
async function showCronUsage() {
  const token = kcGet(KEY_CF_TOKEN);
  const accountId = kcGet(KEY_CF_ACCOUNT);
  if (!token || !accountId) { await notice('尚未設定', '請先設定 Cloudflare API Token。'); return; }

  try {
    const client = makeClient(token, scriptableFetch);
    const audit = await auditCrons(client, accountId);

    const lines = audit.rows.map(function (r) {
      if (r.crons === null) return '· ' + r.script + '：讀不到';
      if (!r.crons.length) return '· ' + r.script + '：無';
      return '· ' + r.script + '：' + r.crons.length + ' 個\n    ' + r.crons.join('\n    ');
    });

    await notice('Cron 用量 ' + audit.total + ' / ' + audit.limitFree,
      lines.join('\n')
      + '\n\n免費方案每個帳號上限 ' + audit.limitFree + ' 個。'
      + (audit.total >= audit.limitFree
        ? '\n已經用滿。要新增就得先刪掉不用的，或升級付費方案。'
        : '\n還有 ' + (audit.limitFree - audit.total) + ' 個可用。')
      + '\n\n要刪除排程請到 Cloudflare 儀表板，'
      + '進該支 Worker 的 Settings → Trigger Events。');
  } catch (err) {
    await notice('讀取失敗', describeStepError(err));
  }
}

/**
 * cron 額度滿了的時候，讓使用者挑一個釋出。
 *
 * 絕不自動選。帳號上那些排程可能正在跑別的東西
 * （例如既有的交易系統），刪掉是不可逆的。
 *
 * @returns {Promise<boolean>} 有沒有成功釋出
 */
async function freeCronSlot(client, accountId) {
  const audit = await auditCrons(client, accountId);
  const options = freeableCrons(audit);

  if (!options.length) {
    await notice('沒有可以釋出的排程',
      '帳號上找不到任何已設定的 cron 排程，但 Cloudflare 說額度已滿。\n\n'
      + '請直接到 Cloudflare 儀表板檢查各個 Worker 的 Trigger Events。');
    return false;
  }

  const a = new Alert();
  a.title = 'Cron 額度已滿（' + audit.total + '/' + audit.limitFree + '）';
  a.message = '要釋出哪一支的排程給 Guardian 用？\n\n'
    + '釋出後那支 Worker 就不會再自動執行。\n'
    + '「本工具」標記的是這支腳本自己部署的，刪掉沒有外部影響。';
  for (const opt of options) {
    a.addAction((opt.origin === 'own' ? '［本工具］' : '［其他］') + opt.script
      + '（' + opt.count + ' 個）');
  }
  a.addCancelAction('取消');
  const idx = await a.presentSheet();
  if (idx === -1) return false;

  const chosen = options[idx];

  // 不是自己部署的，再確認一次。這可能是正在跑的東西。
  if (chosen.origin !== 'own') {
    const warn = new Alert();
    warn.title = '這不是本工具部署的';
    warn.message = '「' + chosen.script + '」的排程：\n'
      + chosen.crons.join('\n')
      + '\n\n清掉之後這支 Worker 就不會再自動執行。\n'
      + '如果它正在管理交易或做其他定時工作，那些都會停止。\n\n'
      + '確定要釋出嗎？';
    warn.addDestructiveAction('確定釋出');
    warn.addCancelAction('取消');
    if ((await warn.present()) === -1) return false;
  }

  try {
    await clearSchedules(client, accountId, chosen.script);
    await notice('已釋出', chosen.script + ' 的排程已清除，釋出 ' + chosen.count + ' 個額度。');
    return true;
  } catch (err) {
    await notice('釋出失敗', describeStepError(err));
    return false;
  }
}

/**
 * 一鍵安裝：設定、部署、處理 cron 額度、驗證，一路走完。
 *
 * 中間只有兩件事會停下來問你：Cloudflare Token，
 * 以及 cron 額度不夠時要釋出哪一支。其餘全部自動。
 */
async function oneTapInstall() {
  // 一、確保有 Token 與帳號
  if (!kcGet(KEY_CF_TOKEN) || !kcGet(KEY_CF_ACCOUNT)) {
    if (!(await setupToken())) return;
  }

  const token = kcGet(KEY_CF_TOKEN);
  const accountId = kcGet(KEY_CF_ACCOUNT);
  const client = makeClient(token, scriptableFetch);

  // 二、部署 Guardian
  const deployed = await deployGuardian({ silent: true });
  if (!deployed) return;

  // 三、排程沒設成就處理額度後重試
  if (deployed.scheduleError) {
    if (!isCronLimitError(deployed.scheduleError)) {
      await notice('已部署，但排程沒設成', describeStepError(deployed.scheduleError));
      return;
    }
    const freed = await freeCronSlot(client, accountId);
    if (!freed) {
      await notice('安裝未完成',
        'Worker 已經部署好，網頁打得開，但還沒有自動排程。\n\n'
        + '之後可以隨時回到選單選「只設定排程」補上。');
      return;
    }
    try {
      await setSchedules(client, accountId, 'crypto-radar-guardian', ['*/5 * * * *']);
    } catch (err) {
      await notice('排程仍然設不上', describeStepError(err));
      return;
    }
  }

  // 四、驗證
  const url = kcGet(KEY_GUARDIAN_URL);
  let statusLine = '第一次掃描要等排程觸發，最多 5 分鐘。';
  try {
    const req = new Request(url + '/api/status');
    req.timeoutInterval = 30;
    const st = await req.loadJSON();
    statusLine = '版本 ' + st.version + '｜狀態 ' + st.health
      + '｜排程 ' + st.cron + '｜' + st.tradeMode;
  } catch (e) {
    // 剛部署完還沒跑過排程，讀不到是正常的
  }

  await notice('安裝完成',
    '網址：\n' + url + '\n\n'
    + statusLine + '\n\n'
    + '看帳戶請在網址後面加：\n?token=' + kcGet(KEY_ADMIN_TOKEN)
    + '\n\n（選單裡有「開啟網頁」會自動帶上）');
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
  a.addAction('★ 一鍵安裝（推薦）');
  a.addAction(token ? '重新設定 Cloudflare Token' : '① 設定 Cloudflare Token');
  a.addAction('② 部署 Guardian');
  a.addAction('③ 部署心跳守衛（選配）');
  a.addAction('只設定排程');
  a.addAction('查看 Cron 用量');
  a.addAction('查看目前狀態');
  a.addAction('開啟網頁');
  a.addDestructiveAction('清除 Cloudflare 設定');
  a.addCancelAction('關閉');

  const idx = await a.presentSheet();
  if (idx === 0) { await oneTapInstall(); await menu(); }
  else if (idx === 1) { await setupToken(); await menu(); }
  else if (idx === 2) { await deployGuardian(); await menu(); }
  else if (idx === 3) { await deployWatchdog(); await menu(); }
  else if (idx === 4) { await setCronOnly(); await menu(); }
  else if (idx === 5) { await showCronUsage(); await menu(); }
  else if (idx === 6) { await checkStatus(); await menu(); }
  else if (idx === 7) { await openSite(); }
  else if (idx === 8) { await clearAll(); await menu(); }
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
