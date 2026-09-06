#!/usr/bin/env node
/**
 * 產生 public/crypto-radar-guardian.scriptable.js —— iPhone 版
 *
 * 給 iOS 的 Scriptable App 執行。與瀏覽器版共用同一份掃描引擎與畫面模組，
 * 差別在於：
 *   1. 用 iOS 原生 Request 抓資料，沒有跨來源限制，不需要伺服器或電腦。
 *   2. 憑證存在 iOS Keychain，因此可以連接 Bybit 唯讀帳戶與 Discord 通知。
 *      瀏覽器版刻意不支援這兩項，因為把金鑰放進瀏覽器儲存空間並不安全。
 *
 * 邏輯改在 app/scan-engine.js，畫面改在 app/render.js，樣式改在 app/theme.css。
 * 改完重跑本產生器。不要手改產生後的 .js。
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { ROOT, engineVersion, inlineModule, readText } from './lib-inline.mjs';

const outPath = resolve(ROOT, 'public/crypto-radar-guardian.scriptable.js');

const base = inlineModule('app/bybit-base.js');
const format = inlineModule('app/format.js');
const engine = inlineModule('app/scan-engine.js');
const render = inlineModule('app/render.js');
const hmac = inlineModule('app/hmac-sha256.js');
const bybitPrivate = inlineModule('app/bybit-private.js');
const discord = inlineModule('app/discord.js');
const css = readText('app/theme.css');
const disclaimer = readText('app/disclaimer.html');
const version = engineVersion(engine);

const GLUE = String.raw`
/* ================= 憑證：只存在 iOS Keychain ================= */

const KEY_API_KEY = 'crg.bybit.apiKey';
const KEY_API_SECRET = 'crg.bybit.apiSecret';
const KEY_WEBHOOK = 'crg.discord.webhook';
const KEY_NOTIFY_STATE = 'crg.notify.state';
const KEY_ENV = 'crg.bybit.env';

function kcGet(key) {
  try {
    return Keychain.contains(key) ? Keychain.get(key) : null;
  } catch (e) {
    return null;
  }
}
function kcSet(key, value) { Keychain.set(key, value); }
function kcRemove(key) { try { if (Keychain.contains(key)) Keychain.remove(key); } catch (e) {} }

function currentEnv() {
  return normalizeEnv(kcGet(KEY_ENV));
}

function bybitCreds() {
  const apiKey = sanitizeCredential(kcGet(KEY_API_KEY));
  const apiSecret = sanitizeCredential(kcGet(KEY_API_SECRET));
  return (apiKey && apiSecret) ? { apiKey: apiKey, apiSecret: apiSecret } : null;
}

function loadNotifyState() {
  const raw = kcGet(KEY_NOTIFY_STATE);
  if (!raw) return { sent: {}, lastSentAt: null };
  try { return JSON.parse(raw); } catch (e) { return { sent: {}, lastSentAt: null }; }
}
function saveNotifyState(state) {
  try { kcSet(KEY_NOTIFY_STATE, JSON.stringify(state)); } catch (e) {}
}

/* ================= Bybit 公開行情 ================= */

async function bybitPublic(path, params) {
  let url = publicHostFor(currentEnv()) + path;
  const pairs = [];
  for (const key of Object.keys(params || {})) {
    pairs.push(encodeURIComponent(key) + '=' + encodeURIComponent(String(params[key])));
  }
  if (pairs.length) url += '?' + pairs.join('&');

  const req = new Request(url);
  req.method = 'GET';
  req.timeoutInterval = 25;
  req.headers = { accept: 'application/json' };

  const json = await req.loadJSON();
  if (!json || typeof json !== 'object') throw new Error('回應格式不正確');
  if (json.retCode !== 0) throw new Error(describeBybitError(json.retCode, json.retMsg, currentEnv()));
  return json.result;
}

/* ================= Bybit 唯讀私有端點 ================= */

async function bybitSigned(path, params, creds) {
  // signGetRequest 內含端點白名單守門，下單類端點會直接丟出例外
  const signed = signGetRequest({
    path: path,
    params: params,
    apiKey: creds.apiKey,
    apiSecret: creds.apiSecret,
    timestamp: Date.now(),
    env: currentEnv(),
  });

  const req = new Request(signed.url);
  req.method = 'GET';
  req.timeoutInterval = 25;
  req.headers = signed.headers;

  const json = await req.loadJSON();
  if (!json || typeof json !== 'object') throw new Error('回應格式不正確');
  if (json.retCode !== 0) throw new Error(describeBybitError(json.retCode, json.retMsg, currentEnv()));
  return json.result;
}

async function fetchAccount() {
  const creds = bybitCreds();
  if (!creds) return null;

  try {
    const walletRes = await bybitSigned('/v5/account/wallet-balance', { accountType: 'UNIFIED' }, creds);
    const posRes = await bybitSigned('/v5/position/list', { category: 'linear', settleCoin: 'USDT' }, creds);
    const pnlRes = await bybitSigned('/v5/position/closed-pnl', { category: 'linear', limit: 50 }, creds);

    const positions = parsePositions(posRes).map(function (p) {
      return Object.assign({}, p, { protection: protectionStatus(p) });
    });
    const closed = parseClosedPnl(pnlRes);

    return {
      wallet: parseWalletBalance(walletRes),
      positions: positions,
      todayPnl: realizedPnlSince(closed, Date.now() - 86400000),
      keyMask: maskApiKey(creds.apiKey) + ' · ' + ENV_LABEL[currentEnv()],
      error: null,
    };
  } catch (err) {
    const raw = String((err && err.message) ? err.message : err);
    // 保險：確保錯誤訊息不會夾帶憑證
    const safe = raw.split(creds.apiKey).join('[key]').split(creds.apiSecret).join('[secret]');
    return { error: safe, keyMask: maskApiKey(creds.apiKey) + ' · ' + ENV_LABEL[currentEnv()] };
  }
}

/* ================= Discord ================= */

async function discordPost(url, payload) {
  const req = new Request(url);
  req.method = 'POST';
  req.timeoutInterval = 20;
  req.headers = { 'Content-Type': 'application/json' };
  req.body = JSON.stringify(payload);
  await req.loadString();
  if (req.response && req.response.statusCode >= 400) {
    throw new Error('Discord 回應 HTTP ' + req.response.statusCode);
  }
}

async function notifyDiscord(state) {
  const webhook = kcGet(KEY_WEBHOOK);
  if (!isValidWebhookUrl(webhook)) return { sent: 0, error: null };

  const groups = state.groups || { main: [], meme: [] };
  const ready = groups.main.concat(groups.meme).filter(function (c) { return c.entryReady; });

  const prev = loadNotifyState();
  const picked = selectNotifications(ready, prev, Date.now());

  let sent = 0;
  let lastError = null;
  for (const c of picked.toSend) {
    const res = await sendNotification(discordPost, webhook, candidateMessage(c));
    if (res.ok) sent += 1; else lastError = res.error;
  }

  if (state.account && state.account.positions) {
    const msg = protectionAlertMessage(state.account.positions);
    if (msg) {
      const res = await sendNotification(discordPost, webhook, msg);
      if (res.ok) sent += 1; else lastError = res.error;
    }
  }

  saveNotifyState(picked.state);
  return { sent: sent, error: lastError };
}

/* ================= 掃描 ================= */

async function runScan() {
  const state = {
    candidates: [], groups: { main: [], meme: [] }, failed: [], scannedAt: null,
    universeCount: 0, analyzedCount: 0, busy: false, error: null, account: null,
  };

  const instRes = await bybitPublic('/v5/market/instruments-info', { category: 'linear', limit: 1000 });
  const tickRes = await bybitPublic('/v5/market/tickers', { category: 'linear' });

  const rows = buildUniverse(instRes.list || [], tickRes.list || [], Date.now());
  state.universeCount = rows.filter(passesUniverseFilter).length;

  const targets = selectTargets(rows);
  const shortlist = targets.all;
  state.analyzedCount = shortlist.length;
  console.log('第一階段通過 ' + state.universeCount + ' 檔，詳細分析 ' + shortlist.length + ' 檔');

  const built = [];
  for (const row of shortlist) {
    try {
      const kl = await bybitPublic('/v5/market/kline', { category: 'linear', symbol: row.symbol, interval: 15, limit: 40 });
      const oi = await bybitPublic('/v5/market/open-interest', { category: 'linear', symbol: row.symbol, intervalTime: '15min', limit: 5 });
      let ob = null;
      try {
        ob = await bybitPublic('/v5/market/orderbook', { category: 'linear', symbol: row.symbol, limit: 50 });
      } catch (e) { ob = null; }
      built.push(buildCandidate(row, parseKlines(kl.list), parseOpenInterest(oi.list), ob ? parseOrderbook(ob) : null));
    } catch (err) {
      console.log('抓取失敗 ' + row.symbol);
      built.push({ symbol: row.symbol, failed: true });
    }
  }

  state.candidates = built.filter(function (c) { return !c.failed; });
  state.groups = splitByGroup(state.candidates);
  state.failed = built.filter(function (c) { return c.failed; });
  state.account = await fetchAccount();
  state.scannedAt = Date.now();
  return state;
}

/* ================= 畫面 ================= */

function pageHtml(state, notifyResult) {
  const when = new Date(state.scannedAt).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' });
  const groups = state.groups || { main: [], meme: [] };
  const readyCount = groups.main.concat(groups.meme).filter(function (c) { return c.entryReady; }).length;

  let notifyLine = '';
  if (notifyResult && notifyResult.sent > 0) {
    notifyLine = '<div style="margin-top:6px;color:var(--green)">已送出 ' + notifyResult.sent + ' 則 Discord 通知。</div>';
  } else if (notifyResult && notifyResult.error) {
    notifyLine = '<div style="margin-top:6px;color:var(--amber)">Discord 通知失敗：' + esc(notifyResult.error) + '</div>';
  }

  return '<!doctype html>'
    + '<html lang="zh-Hant"><head>'
    + '<meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">'
    + '<meta name="color-scheme" content="dark">'
    + '<title>Crypto Radar Guardian</title>'
    + '<style>' + CSS + '</style>'
    + '</head><body><div class="wrap">'
    + '<header>'
    +   '<div class="title"><h1>Crypto Radar Guardian</h1>'
    +   '<span class="ver">v' + ENGINE_VERSION + ' · iPhone</span></div>'
    +   '<div style="margin-top:6px"><span class="srcbadge">◈ 資料來源 <b>Bybit /v5/market</b></span></div>'
    +   '<div class="bar"><span class="meta" style="margin-left:0">掃描於 ' + when
    +   '　·　符合進場條件 ' + readyCount + ' 檔</span></div>'
    + '</header>'
    + '<div class="note"><strong>早期快噴掃描</strong>：在 Bybit USDT 線性永續中，尋找「已壓縮、量能溫和放大、'
    + '未平倉量增加、且尚未突破前高」的標的。已經噴過的一律排除。'
    + statText(state)
    + notifyLine
    + '<div style="margin-top:6px;color:var(--muted)">要更新資料，請回到 Scriptable 再執行一次。</div></div>'
    + listHtml(state)
    + DISCLAIMER
    + '</div></body></html>';
}

async function presentScan() {
  const state = await runScan();
  const notifyResult = await notifyDiscord(state);
  const wv = new WebView();
  await wv.loadHTML(pageHtml(state, notifyResult));
  await wv.present(true);
}

/* ================= 設定 ================= */

async function chooseEnv() {
  const a = new Alert();
  a.title = '選擇 Bybit 環境';
  a.message = 'API Key 是綁環境的。模擬交易與測試網各自發自己的 Key，'
    + '拿去打正式站會被拒絕（retCode 10003）。\n\n目前：' + ENV_LABEL[currentEnv()];
  for (const env of BYBIT_ENVIRONMENTS) a.addAction(ENV_LABEL[env]);
  a.addCancelAction('取消');
  const idx = await a.presentSheet();
  if (idx === -1) return false;
  kcSet(KEY_ENV, BYBIT_ENVIRONMENTS[idx]);
  return true;
}

async function setupBybit() {
  if (!(await chooseEnv())) return;

  const a = new Alert();
  a.title = '連接 Bybit（' + ENV_LABEL[currentEnv()] + '，唯讀）';
  a.message = '請在 Bybit 建立一組「只讀」權限的 API Key。\n\n'
    + '本工具只呼叫查詢類端點，沒有任何下單、改單或提領的程式路徑。\n'
    + '憑證只會存在這支手機的 Keychain，不會上傳到任何地方。';
  a.addTextField('API Key', kcGet(KEY_API_KEY) || '');
  a.addSecureTextField('API Secret', '');
  a.addAction('儲存');
  a.addCancelAction('取消');
  const idx = await a.present();
  if (idx === -1) return;

  const key = sanitizeCredential(a.textFieldValue(0));
  const secret = sanitizeCredential(a.textFieldValue(1));
  if (!key || !secret) {
    await notice('未儲存', 'API Key 與 Secret 都要填寫。');
    return;
  }

  kcSet(KEY_API_KEY, key);
  kcSet(KEY_API_SECRET, secret);

  // 立刻驗證一次，讓使用者馬上知道有沒有打錯
  const account = await fetchAccount();
  if (account && account.error) {
    await notice('已儲存，但讀取失敗', account.error);
  } else {
    await notice('連接成功', '已讀取到 ' + ENV_LABEL[currentEnv()] + ' 的帳戶資料。\n憑證存在本機 Keychain。');
  }
}

async function setupDiscord() {
  const a = new Alert();
  a.title = '連接 Discord';
  a.message = '在 Discord 頻道設定裡建立一個 Webhook，把網址貼進來。\n\n'
    + '網址只會存在這支手機的 Keychain。';
  a.addTextField('Webhook 網址', kcGet(KEY_WEBHOOK) || '');
  a.addAction('儲存');
  a.addCancelAction('取消');
  const idx = await a.present();
  if (idx === -1) return;

  const url = (a.textFieldValue(0) || '').trim();
  if (!isValidWebhookUrl(url)) {
    await notice('未儲存', '這不是有效的 Discord Webhook 網址。');
    return;
  }
  kcSet(KEY_WEBHOOK, url);
  await notice('已儲存', maskWebhookUrl(url));
}

async function testDiscord() {
  const webhook = kcGet(KEY_WEBHOOK);
  if (!isValidWebhookUrl(webhook)) {
    await notice('尚未設定', '請先設定 Discord Webhook。');
    return;
  }
  const res = await sendNotification(discordPost, webhook, testMessage());
  await notice(res.ok ? '已送出' : '送出失敗', res.ok ? '請到 Discord 頻道確認。' : String(res.error));
}

async function clearCredentials() {
  const a = new Alert();
  a.title = '清除所有憑證';
  a.message = '會刪除這支手機上儲存的 Bybit API Key、Secret 與 Discord Webhook。';
  a.addDestructiveAction('刪除');
  a.addCancelAction('取消');
  if (await a.present() === -1) return;

  kcRemove(KEY_API_KEY);
  kcRemove(KEY_API_SECRET);
  kcRemove(KEY_WEBHOOK);
  kcRemove(KEY_NOTIFY_STATE);
  kcRemove(KEY_ENV);
  await notice('已清除', '所有憑證都已從 Keychain 移除。');
}

async function notice(title, message) {
  const a = new Alert();
  a.title = title;
  a.message = message;
  a.addAction('好');
  await a.present();
}

async function switchEnvOnly() {
  if (!(await chooseEnv())) return;
  if (!bybitCreds()) {
    await notice('已切換', '目前環境：' + ENV_LABEL[currentEnv()] + '\n尚未設定這個環境的 API Key。');
    return;
  }
  const account = await fetchAccount();
  if (account && account.error) {
    await notice('切換後讀取失敗', account.error);
  } else {
    await notice('切換成功', '已讀取到 ' + ENV_LABEL[currentEnv()] + ' 的帳戶資料。');
  }
}

async function showMenu() {
  const creds = bybitCreds();
  const webhook = kcGet(KEY_WEBHOOK);

  const a = new Alert();
  a.title = 'Crypto Radar Guardian';
  a.message = 'Bybit：' + (creds ? maskApiKey(creds.apiKey) + '（唯讀）' : '未連接')
    + '\n環境：' + ENV_LABEL[currentEnv()]
    + '\nDiscord：' + (isValidWebhookUrl(webhook) ? maskWebhookUrl(webhook) : '未連接');
  a.addAction('開始掃描');
  a.addAction(creds ? '重新設定 Bybit' : '連接 Bybit（唯讀）');
  a.addAction('只切換環境');
  a.addAction(isValidWebhookUrl(webhook) ? '重新設定 Discord' : '連接 Discord');
  a.addAction('測試 Discord 通知');
  a.addDestructiveAction('清除所有憑證');
  a.addCancelAction('關閉');

  const idx = await a.presentSheet();
  if (idx === 0) await presentScan();
  else if (idx === 1) { await setupBybit(); await showMenu(); }
  else if (idx === 2) { await switchEnvOnly(); await showMenu(); }
  else if (idx === 3) { await setupDiscord(); await showMenu(); }
  else if (idx === 4) { await testDiscord(); await showMenu(); }
  else if (idx === 5) { await clearCredentials(); await showMenu(); }
}

/* ================= 進入點 ================= */

try {
  // 從 Scriptable App 裡執行 → 顯示選單（可以進設定）
  // 從主畫面圖示或捷徑執行 → 直接掃描
  if (typeof config !== 'undefined' && config.runsInApp) {
    await showMenu();
  } else {
    await presentScan();
  }
} catch (err) {
  const raw = String((err && err.message) ? err.message : err);
  await notice('執行失敗', raw + '\n\n請確認網路連線正常，稍後再試一次。');
}

Script.complete();
`;

const out = `// Crypto Radar Guardian — iPhone 版 (Scriptable)
// 引擎版本 ${version}
//
// 這是什麼
//   在 Bybit USDT 線性永續合約中，找出「已壓縮、量能溫和放大、未平倉量增加、
//   且尚未突破前高」的早期候選。主幣與迷因幣分開顯示。
//   已經噴過的一律排除。
//
// 安裝
//   1. App Store 安裝免費的 Scriptable
//   2. 打開 Scriptable，右上角 + 新增一個 Script
//   3. 把這整份檔案的內容貼進去，命名為 Crypto Radar
//   4. 按右下角播放鍵。在 App 裡執行會出現選單，可以進設定。
//   不需要電腦，不需要伺服器。
//
// 放到主畫面
//   1. 開「捷徑 Shortcuts」App，新增捷徑
//   2. 加入動作 → 搜尋 Scriptable → 選「Run Script」
//   3. Script 選 Crypto Radar
//   4. 捷徑選單 →「加入主畫面」，可自訂名稱與圖示
//   從主畫面圖示啟動會直接開始掃描，不會出現選單。
//
// 連接 Bybit
//   在 Scriptable 裡執行 → 選「連接 Bybit（唯讀）」。
//   會先問你環境：正式站 / 模擬交易 Demo / 測試網 Testnet。
//   API Key 是綁環境的，模擬與測試網各自發自己的 Key，
//   拿去打正式站會得到 retCode 10003「API key is invalid」。
//   如果連接失敗，第一個要檢查的就是環境有沒有選對。
//   請在 Bybit 建立「只讀」權限的 API Key。
//   本程式只呼叫查詢類端點，沒有任何下單、改單、撤單或提領的程式路徑，
//   端點白名單在程式碼裡是硬性限制。
//   憑證只存在這支手機的 iOS Keychain，不會上傳，也不在這個檔案裡。
//
// 連接 Discord
//   在 Discord 頻道設定建立 Webhook，執行本程式 → 選「連接 Discord」貼上網址。
//   有標的通過全部進場條件時會通知，同一標的一小時內不重複。
//   持倉缺 TP 或 SL 時也會提醒。通知只是通知，不會觸發任何交易動作。
//
// 要改邏輯
//   改 app/scan-engine.js 等原始檔，然後執行
//   node scripts/build-scriptable-app.mjs
//   不要直接改這個檔案，它是產生出來的。

/* ============================================================
   共用常數與格式化 —— 由 app/bybit-base.js 與 app/format.js 內嵌
   ============================================================ */
${base}

${format}

/* ============================================================
   HMAC-SHA256 —— 由 app/hmac-sha256.js 內嵌
   Scriptable 沒有 WebCrypto，Bybit 私有端點簽章需要自帶實作
   ============================================================ */
${hmac}

/* ============================================================
   Bybit 唯讀私有端點 —— 由 app/bybit-private.js 內嵌
   端點白名單在此，下單類端點會被 assertReadOnlyEndpoint 擋下
   ============================================================ */
${bybitPrivate}

/* ============================================================
   Discord 通知 —— 由 app/discord.js 內嵌
   ============================================================ */
${discord}

/* ============================================================
   掃描引擎 —— 由 app/scan-engine.js 內嵌
   ============================================================ */
${engine}

/* ============================================================
   畫面 —— 由 app/render.js 內嵌
   ============================================================ */
${render}

/* ============================================================
   樣式與免責 —— 由 app/theme.css 與 app/disclaimer.html 內嵌
   ============================================================ */
const CSS = ${JSON.stringify(css)};
const DISCLAIMER = ${JSON.stringify(disclaimer)};

/* ============================================================
   Scriptable 接線
   ============================================================ */
${GLUE}
`;

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, out, 'utf8');
console.log(`已產生 ${outPath}`);
console.log(`引擎版本 ${version}，大小 ${(Buffer.byteLength(out, 'utf8') / 1024).toFixed(1)} KB`);
