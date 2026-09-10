import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const PATH = new URL('../public/crypto-radar-deploy.scriptable.js', import.meta.url).pathname;
const source = readFileSync(PATH, 'utf8');

// 擬真長度：Cloudflare 的 API Token 是 40 個字元
const CF_TOKEN = 'cfTOKEN0123456789abcdefghijklmnopqrs-_XY';
const HOOK = 'https://discord.com/api/webhooks/123456789012345678/abcDEF-ghi_JKL123';
const BYBIT_KEY = 'bybitkey1234567890';
const BYBIT_SECRET = 'bybitsecret1234567890';

const ok = (result) => ({ success: true, result, errors: [] });

/**
 * 模擬 Scriptable 環境並驅動選單。
 * sheetAnswers 依序回應 presentSheet，alertAnswers 依序回應 present。
 */
async function run({ sheetAnswers = [], alertAnswers = [], textValues = [], store = new Map(), failAt = null, existingScripts = [], rawResponse = null, schedulesByScript = {}, scriptMeta = {} } = {}) {
  const cfCalls = [];
  const multipartParts = [];
  const alerts = [];
  const opened = [];
  const copied = [];
  let sheetIdx = 0;
  let alertIdx = 0;
  let textIdx = 0;

  globalThis.Keychain = {
    contains: (k) => store.has(k),
    get: (k) => store.get(k),
    set: (k, v) => store.set(k, v),
    remove: (k) => store.delete(k),
  };
  globalThis.Data = { fromString: (s) => ({ __data: s }) };
  globalThis.Safari = { open: (u) => opened.push(u) };
  globalThis.Pasteboard = { copy: (v) => copied.push(v) };
  globalThis.Script = { complete() {} };

  globalThis.Request = class {
    constructor(url) {
      this.url = url;
      this.headers = {};
      this.method = 'GET';
      this.response = { statusCode: 200 };
      this._parts = null;
    }
    addParameterToMultipart(name, value) {
      this._parts = this._parts ?? {};
      this._parts[name] = value;
    }
    addFileDataToMultipart(data, mime, name, filename) {
      this._parts = this._parts ?? {};
      this._parts.__file = { data: data.__data, mime, name, filename };
    }
    async loadString() {
      if (rawResponse !== null) {
        const u = new URL(this.url);
        cfCalls.push({ method: this.method, path: u.pathname.replace('/client/v4', ''), headers: this.headers });
        this.response = { statusCode: 502 };
        return rawResponse;
      }
      return JSON.stringify(await this._respond());
    }
    async loadJSON() {
      return this._respond();
    }
    async _respond() {
      const u = new URL(this.url);
      const path = u.pathname.replace('/client/v4', '');
      cfCalls.push({ method: this.method, path, headers: this.headers, body: this.body, parts: this._parts });
      if (this._parts) multipartParts.push(this._parts);

      const forced = failAt ? failAt(path, this.method) : null;
      if (forced) return { success: false, result: null, errors: [forced] };

      if (path === '/user/tokens/verify') return ok({ status: 'active' });
      if (path === '/accounts') return ok([{ id: 'acct123', name: '我的帳號' }]);
      if (path.endsWith('/workers/scripts') && this.method === 'GET') {
        return ok(existingScripts.map((id) => ({ id, ...(scriptMeta[id] ?? {}) })));
      }
      if (path.endsWith('/schedules') && this.method === 'GET') {
        const name = path.split('/workers/scripts/')[1].replace('/schedules', '');
        return ok({ schedules: (schedulesByScript[decodeURIComponent(name)] ?? []).map((cron) => ({ cron })) });
      }
      if (path.endsWith('/storage/kv/namespaces') && this.method === 'GET') return ok([]);
      if (path.endsWith('/storage/kv/namespaces') && this.method === 'POST') return ok({ id: 'kv-1' });
      if (/\/workers\/scripts\/[^/]+$/.test(path)) return ok({ id: 'script' });
      if (path.endsWith('/schedules')) return ok({ schedules: [] });
      if (path.endsWith('/subdomain') && path.includes('scripts')) return ok({ enabled: true });
      if (path.endsWith('/workers/subdomain')) return ok({ subdomain: 'my-account' });
      if (path.endsWith('/api/status')) return { version: 'Crypto Radar Guardian 10.0', health: 'healthy', cron: '每 5 分鐘', moonshotProvider: 'Bybit Pre-Breakout', tradeMode: 'read-only', analyzedCount: 12, readyCount: 1 };
      throw new Error('未預期的路徑 ' + path);
    }
  };

  globalThis.Alert = class {
    constructor() { this.title = ''; this.message = ''; }
    addAction() {} addDestructiveAction() {} addCancelAction() {}
    addTextField() {} addSecureTextField() {}
    textFieldValue() { return textValues[textIdx++] ?? ''; }
    async present() {
      alerts.push({ title: this.title, message: this.message });
      return alertAnswers[alertIdx++] ?? -1;
    }
    async presentSheet() {
      alerts.push({ title: this.title, message: this.message });
      return sheetAnswers[sheetIdx++] ?? -1;
    }
  };

  const realLog = console.log;
  console.log = () => {};
  try {
    await import(PATH + '?t=' + Date.now() + Math.random());
  } finally {
    console.log = realLog;
  }
  return { cfCalls, multipartParts, alerts, opened, copied, store };
}

/* ------------------------------------------------------------------ */

test('產生後的腳本語法正確，且沒有殘留 import/export', () => {
  execFileSync(process.execPath, ['--check', PATH], { stdio: 'pipe' });
  assert.doesNotMatch(source, /^import\s/m);
  assert.doesNotMatch(source, /^export\s/m);
});

test('檔頭說明涵蓋 Token 權限與誠實聲明', () => {
  assert.match(source, /Workers Scripts → Edit/);
  assert.match(source, /Workers KV Storage → Edit/);
  assert.match(source, /沒有辦法在開發環境實測/, '必須誠實說明未實測');
});

test('兩支 Worker 的程式碼都已內嵌', () => {
  assert.match(source, /const GUARDIAN_SCRIPT = "/);
  assert.match(source, /const WATCHDOG_SCRIPT = "/);
  // 內嵌的應該是真的 Worker，不是佔位字串
  assert.ok(source.includes('Crypto Radar Guardian 10.0'), '應含 Guardian 版本字串');
});

test('原始碼裡沒有任何真實憑證', () => {
  assert.doesNotMatch(source, /discord\.com\/api\/webhooks\/\d+/);
  assert.doesNotMatch(source, /(cf-token|Bearer)\s*[:=]\s*['"][A-Za-z0-9_-]{16,}/);
});

test('未設定時選單顯示未設定，不會誤導', async () => {
  const { alerts } = await run({ sheetAnswers: [-1] });
  assert.match(alerts[0].message, /Cloudflare：未設定/);
  assert.match(alerts[0].message, /Guardian：未部署/);
});

test('設定 Token 會用真正需要的權限驗證，不碰 /user/ 端點', async () => {
  const store = new Map();
  const { cfCalls, store: after } = await run({
    sheetAnswers: [1, -1], alertAnswers: [0, 0], textValues: [CF_TOKEN], store,
  });
  const paths = cfCalls.map((c) => c.path);
  assert.ok(!paths.includes('/user/tokens/verify'),
    '不該依賴 /user/ 端點，帳號層級 Token 未必有權限');
  assert.ok(paths.includes('/accounts/acct123/workers/scripts'),
    '應該用列出 Worker 來驗證權限');
  assert.equal(cfCalls[0].headers.Authorization, `Bearer ${CF_TOKEN}`);
  assert.equal(after.get('crg.cf.token'), CF_TOKEN);
  assert.equal(after.get('crg.cf.account'), 'acct123');
});

test('Token 夾帶隱形字元時會先清乾淨再用', async () => {
  const store = new Map();
  const dirty = ' ' + CF_TOKEN.slice(0, 10) + '\u200B' + CF_TOKEN.slice(10) + '\n';
  const { cfCalls, store: after } = await run({
    sheetAnswers: [1, -1], alertAnswers: [0, 0], textValues: [dirty], store,
  });
  assert.equal(after.get('crg.cf.token'), CF_TOKEN, '存進去的必須是清乾淨的');
  assert.equal(cfCalls[0].headers.Authorization, `Bearer ${CF_TOKEN}`);
});

test('Token 明顯複製錯時，連請求都不發', async () => {
  for (const bad of ['太短', 'abc def 這是說明文字不是 token', 'x'.repeat(200)]) {
    const { cfCalls, alerts } = await run({
      sheetAnswers: [1, -1], alertAnswers: [0, 0], textValues: [bad], store: new Map(),
    });
    assert.equal(cfCalls.length, 0, `"${bad.slice(0, 12)}" 不該發出請求`);
    assert.ok(alerts.some((a) => a.title === 'Token 看起來不對'));
  }
});

test('列不出帳號時退回手動輸入 Account ID，不當成 Token 失效', async () => {
  const store = new Map();
  const { cfCalls, alerts, store: after } = await run({
    sheetAnswers: [1, -1], alertAnswers: [0, 0, 0],
    textValues: [CF_TOKEN, 'abcdef0123456789abcdef0123456789'], store,
    failAt: (path) => (path === '/accounts' ? { code: 9109, message: 'not entitled' } : null),
  });
  assert.equal(after.get('crg.cf.account'), 'abcdef0123456789abcdef0123456789');
  assert.ok(alerts.some((a) => a.title === '連接成功'), '仍應成功');
  assert.ok(cfCalls.some((c) => c.path === '/accounts/abcdef0123456789abcdef0123456789/workers/scripts'));
});

test('手動輸入的 Account ID 格式不對會擋下', async () => {
  const { alerts, store: after } = await run({
    sheetAnswers: [1, -1], alertAnswers: [0, 0, 0],
    textValues: [CF_TOKEN, '這不是ID'], store: new Map(),
    failAt: (path) => (path === '/accounts' ? { code: 9109, message: 'not entitled' } : null),
  });
  assert.ok(alerts.some((a) => a.title === '格式不對'));
  assert.equal(after.get('crg.cf.account'), undefined);
});

test('回應不是 JSON 時，錯誤訊息帶出狀態碼與原始內容', async () => {
  const store = new Map([['crg.cf.token', CF_TOKEN], ['crg.cf.account', 'acct123']]);
  const { alerts } = await run({
    sheetAnswers: [2, -1], alertAnswers: [0, 0], store, rawResponse: '<html>502 Bad Gateway</html>',
  });
  const failure = alerts.find((a) => a.title === '部署失敗');
  assert.ok(failure, '應顯示失敗');
  assert.match(failure.message, /502 Bad Gateway/, '要帶出原始回應');
});

test('部署 Guardian 會走完建 KV、上傳、排程、開網址', async () => {
  const store = new Map([
    ['crg.cf.token', CF_TOKEN],
    ['crg.cf.account', 'acct123'],
    ['crg.discord.webhook', HOOK],
    ['crg.bybit.apiKey', BYBIT_KEY],
    ['crg.bybit.apiSecret', BYBIT_SECRET],
    ['crg.bybit.env', 'demo'],
  ]);
  const { cfCalls, multipartParts, store: after, alerts } = await run({
    sheetAnswers: [2, -1], alertAnswers: [0, 0], store,
  });

  const paths = cfCalls.map((c) => `${c.method} ${c.path}`);
  assert.deepEqual(paths, [
    'GET /accounts/acct123/storage/kv/namespaces',
    'POST /accounts/acct123/storage/kv/namespaces',
    'GET /accounts/acct123/workers/scripts',
    'PUT /accounts/acct123/workers/scripts/crypto-radar-guardian',
    'PUT /accounts/acct123/workers/scripts/crypto-radar-guardian/schedules',
    'POST /accounts/acct123/workers/scripts/crypto-radar-guardian/subdomain',
    'GET /accounts/acct123/workers/subdomain',
  ]);
  assert.equal(after.get('crg.cf.guardianUrl'), 'https://crypto-radar-guardian.my-account.workers.dev');
  assert.ok(alerts.some((a) => a.title === '部署完成'));
});

test('上傳的 multipart 帶著真正的 Worker 程式碼與完整綁定', async () => {
  const store = new Map([
    ['crg.cf.token', CF_TOKEN], ['crg.cf.account', 'acct123'],
    ['crg.discord.webhook', HOOK], ['crg.bybit.apiKey', BYBIT_KEY],
    ['crg.bybit.apiSecret', BYBIT_SECRET], ['crg.bybit.env', 'demo'],
  ]);
  const { multipartParts } = await run({ sheetAnswers: [2, -1], alertAnswers: [0, 0], store });

  assert.equal(multipartParts.length, 1);
  const parts = multipartParts[0];
  assert.equal(parts.__file.mime, 'application/javascript+module');
  assert.equal(parts.__file.filename, 'worker.js');
  assert.ok(parts.__file.data.includes('Crypto Radar Guardian 10.0'), '上傳的必須是真的 Worker');

  const meta = JSON.parse(parts.metadata);
  assert.equal(meta.main_module, 'worker.js');
  const byName = Object.fromEntries(meta.bindings.map((b) => [b.name, b]));
  assert.equal(byName.GUARDIAN_KV.namespace_id, 'kv-1');
  assert.equal(byName.DISCORD_WEBHOOK.text, HOOK);
  assert.equal(byName.BYBIT_API_KEY.text, BYBIT_KEY);
  assert.equal(byName.BYBIT_ENV.type, 'plain_text');
  assert.equal(byName.BYBIT_ENV.text, 'demo');
  assert.equal(byName.ADMIN_TOKEN.type, 'secret_text');
  assert.ok(byName.ADMIN_TOKEN.text.length >= 24, '自動產生的管理 Token 要夠長');
});

test('沒設過 ADMIN_TOKEN 會自動產生並存起來', async () => {
  const store = new Map([['crg.cf.token', CF_TOKEN], ['crg.cf.account', 'acct123']]);
  const { store: after } = await run({ sheetAnswers: [2, -1], alertAnswers: [0, 0], store });
  const token = after.get('crg.admin.token');
  assert.ok(token && token.length === 32, `自動產生的 Token 長度為 ${token && token.length}`);
});

test('未設定 Token 就部署會被擋下，不會發任何請求', async () => {
  const { cfCalls, alerts } = await run({ sheetAnswers: [2, -1], alertAnswers: [0], store: new Map() });
  assert.equal(cfCalls.length, 0);
  assert.ok(alerts.some((a) => a.title === '尚未設定'));
});

test('沒部署 Guardian 就部署守衛會被擋下', async () => {
  const store = new Map([['crg.cf.token', CF_TOKEN], ['crg.cf.account', 'acct123'], ['crg.discord.webhook', HOOK]]);
  const { cfCalls, alerts } = await run({ sheetAnswers: [3, -1], alertAnswers: [0], store });
  assert.equal(cfCalls.length, 0);
  assert.ok(alerts.some((a) => a.title === '順序不對'));
});

test('沒有 Webhook 就部署守衛會被擋下', async () => {
  const store = new Map([
    ['crg.cf.token', CF_TOKEN], ['crg.cf.account', 'acct123'],
    ['crg.cf.guardianUrl', 'https://g.example.workers.dev'],
  ]);
  const { cfCalls, alerts } = await run({ sheetAnswers: [3, -1], alertAnswers: [0], store });
  assert.equal(cfCalls.length, 0);
  assert.ok(alerts.some((a) => a.title === '缺少 Webhook'));
});

test('部署守衛帶入 Guardian 網址與錯開的排程', async () => {
  const store = new Map([
    ['crg.cf.token', CF_TOKEN], ['crg.cf.account', 'acct123'],
    ['crg.cf.guardianUrl', 'https://g.example.workers.dev'], ['crg.discord.webhook', HOOK],
  ]);
  const { cfCalls, multipartParts } = await run({ sheetAnswers: [3, -1], alertAnswers: [0, 0], store });
  const sched = cfCalls.find((c) => c.path.endsWith('/schedules'));
  assert.deepEqual(JSON.parse(sched.body), [{ cron: '4,14,24,34,44,54 * * * *' }]);
  const meta = JSON.parse(multipartParts[0].metadata);
  const byName = Object.fromEntries(meta.bindings.map((b) => [b.name, b]));
  assert.equal(byName.GUARDIAN_URL.text, 'https://g.example.workers.dev');
  assert.equal(byName.WATCHDOG_KV.type, 'kv_namespace');
});

// 選單順序：0 一鍵安裝 / 1 設定Token / 2 部署Guardian / 3 部署守衛 /
//           4 只設定排程 / 5 查看Cron用量 / 6 查看狀態 / 7 開啟網頁 / 8 清除
test('開啟網頁會帶上管理 Token', async () => {
  const store = new Map([
    ['crg.cf.guardianUrl', 'https://g.example.workers.dev'],
    ['crg.admin.token', 'tok12345'],
  ]);
  const { opened } = await run({ sheetAnswers: [7], store });
  assert.equal(opened[0], 'https://g.example.workers.dev?token=tok12345');
});

test('查看狀態會讀 /api/status 並顯示關鍵欄位', async () => {
  const store = new Map([['crg.cf.guardianUrl', 'https://g.example.workers.dev']]);
  const { alerts } = await run({ sheetAnswers: [6, -1], alertAnswers: [0], store });
  const status = alerts.find((a) => a.title === '目前狀態');
  assert.ok(status);
  assert.match(status.message, /Crypto Radar Guardian 10\.0/);
  assert.match(status.message, /read-only/);
});

test('上傳失敗時明確指出卡在哪一步，並轉述 Cloudflare 的說法', async () => {
  const store = new Map([['crg.cf.token', CF_TOKEN], ['crg.cf.account', 'acct123']]);
  const { alerts } = await run({
    sheetAnswers: [2, -1], alertAnswers: [0, 0], store,
    failAt: (path, method) => (method === 'PUT' && /\/workers\/scripts\/[^/]+$/.test(path)
      ? { code: 10021, message: 'Script startup exceeded CPU limit' }
      : null),
  });
  const failure = alerts.find((a) => a.title === '部署失敗');
  assert.ok(failure, '應顯示部署失敗');
  assert.match(failure.message, /上傳 Worker/, '要指出是哪一步');
  assert.match(failure.message, /CPU limit/, '要轉述 Cloudflare 的原始說法');
});

test('權限不足時，錯誤訊息會講出要加哪些權限', async () => {
  const { alerts } = await run({
    sheetAnswers: [1, -1], alertAnswers: [0, 0], textValues: [CF_TOKEN], store: new Map(),
    failAt: (path) => (path.endsWith('/workers/scripts')
      ? { code: 10000, message: 'Invalid API Token' } : null),
  });
  const failure = alerts.find((a) => a.title === '權限確認失敗');
  assert.ok(failure);
  assert.match(failure.message, /Workers Scripts/);
  assert.match(failure.message, /Workers KV Storage/);
  assert.match(failure.message, /Invalid API Token/, '原始訊息要保留');
});

test('Cloudflare Token 不會出現在任何顯示訊息裡', async () => {
  const store = new Map([['crg.cf.token', CF_TOKEN], ['crg.cf.account', 'acct123']]);
  const { alerts } = await run({ sheetAnswers: [-1], store });
  for (const a of alerts) {
    assert.ok(!a.message.includes(CF_TOKEN), '選單不得顯示完整 Token');
  }
  assert.match(alerts[0].message, /cfTO••••-_XY/, '應顯示遮罩');
});

test('產生器輸出是決定性的', () => {
  const before = readFileSync(PATH, 'utf8');
  execFileSync(process.execPath, ['scripts/build-deploy-app.mjs'], {
    cwd: new URL('..', import.meta.url).pathname, stdio: 'pipe',
  });
  assert.equal(readFileSync(PATH, 'utf8'), before);
});

test('帳號上有別的 Worker 時不會被動到，也不會多問', async () => {
  const store = new Map([['crg.cf.token', CF_TOKEN], ['crg.cf.account', 'acct123']]);
  const { cfCalls, alerts } = await run({
    sheetAnswers: [2, -1], alertAnswers: [0, 0], store,
    existingScripts: ['crypto-radar-guardian-24x7'],
  });
  assert.ok(cfCalls.some((c) => c.path.endsWith('/workers/scripts/crypto-radar-guardian')),
    '應該有上傳');
  assert.ok(!alerts.some((a) => a.title === '這個名字已經有 Worker 了'), '不同名不該問');
  const done = alerts.find((a) => a.title === '部署完成');
  assert.match(done.message, /其他 1 支 Worker 未受影響/);
});

test('同名時會跳出覆蓋警告，取消就不上傳', async () => {
  const store = new Map([['crg.cf.token', CF_TOKEN], ['crg.cf.account', 'acct123']]);
  const { cfCalls, alerts } = await run({
    // 第一個 alertAnswers 是部署確認，第二個是覆蓋確認（回 -1 代表取消）
    sheetAnswers: [2, -1], alertAnswers: [0, -1, 0], store,
    existingScripts: ['crypto-radar-guardian'],
  });
  const warn = alerts.find((a) => a.title === '這個名字已經有 Worker 了');
  assert.ok(warn, '應跳出覆蓋警告');
  assert.match(warn.message, /整份取代/);
  assert.match(warn.message, /部位會失去保護/);
  assert.ok(
    !cfCalls.some((c) => c.method === 'PUT' && c.path.endsWith('/workers/scripts/crypto-radar-guardian')),
    '取消後不得上傳',
  );
  assert.ok(alerts.some((a) => a.title === '部署失敗'));
});

test('cron 額度滿時，回報成「已部署但排程沒設成」而不是部署失敗', async () => {
  const store = new Map([['crg.cf.token', CF_TOKEN], ['crg.cf.account', 'acct123']]);
  const { alerts, store: after } = await run({
    sheetAnswers: [2, -1], alertAnswers: [0, 0], store,
    failAt: (path, method) => (method === 'PUT' && path.endsWith('/schedules')
      ? { code: 10072, message: 'This account has reached the Workers Free limit of 5 cron triggers per account.' }
      : null),
  });

  assert.ok(!alerts.some((a) => a.title === '部署失敗'), '不該報成部署失敗');
  const partial = alerts.find((a) => a.title === '已部署，但排程沒設成');
  assert.ok(partial, '應如實說是部分完成');
  assert.match(partial.message, /Worker 本身已經部署好了/);
  assert.match(partial.message, /5 個 cron 觸發器/);
  assert.match(partial.message, /查看 Cron 用量/, '要指出下一步');
  assert.ok(after.get('crg.cf.guardianUrl'), '網址仍應存起來');
});

test('查看 Cron 用量會逐支列出並算總數', async () => {
  const store = new Map([['crg.cf.token', CF_TOKEN], ['crg.cf.account', 'acct123']]);
  const { alerts } = await run({
    sheetAnswers: [5, -1], alertAnswers: [0], store,
    existingScripts: ['crypto-radar-guardian-24x7', 'old-worker'],
    schedulesByScript: {
      'crypto-radar-guardian-24x7': ['*/5 * * * *', '4,14,24,34,44,54 * * * *'],
      'old-worker': ['0 0 * * *'],
    },
  });
  const usage = alerts.find((a) => a.title && a.title.startsWith('Cron 用量'));
  assert.ok(usage, '應顯示用量');
  assert.match(usage.title, /3 \/ 5/);
  assert.match(usage.message, /crypto-radar-guardian-24x7/);
  assert.match(usage.message, /還有 2 個可用/);
});

test('cron 用滿時，用量畫面會講出解法', async () => {
  const store = new Map([['crg.cf.token', CF_TOKEN], ['crg.cf.account', 'acct123']]);
  const { alerts } = await run({
    sheetAnswers: [5, -1], alertAnswers: [0], store,
    existingScripts: ['a', 'b'],
    schedulesByScript: { a: ['1 * * * *', '2 * * * *', '3 * * * *'], b: ['4 * * * *', '5 * * * *'] },
  });
  const usage = alerts.find((a) => a.title && a.title.startsWith('Cron 用量'));
  assert.match(usage.title, /5 \/ 5/);
  assert.match(usage.message, /已經用滿/);
  assert.match(usage.message, /Trigger Events/, '要說去哪裡刪');
});

test('只設定排程不會重新上傳 Worker', async () => {
  const store = new Map([['crg.cf.token', CF_TOKEN], ['crg.cf.account', 'acct123']]);
  const { cfCalls, alerts } = await run({
    sheetAnswers: [4, 0, -1], alertAnswers: [0], store,
  });
  assert.ok(!cfCalls.some((c) => c.parts), '不該有 multipart 上傳');
  const sched = cfCalls.find((c) => c.method === 'PUT' && c.path.endsWith('/schedules'));
  assert.ok(sched, '應設定排程');
  assert.deepEqual(JSON.parse(sched.body), [{ cron: '*/5 * * * *' }]);
  assert.ok(alerts.some((a) => a.title === '排程已設定'));
});

test('只設定排程時若額度仍滿，說明要先釋出', async () => {
  const store = new Map([['crg.cf.token', CF_TOKEN], ['crg.cf.account', 'acct123']]);
  const { alerts } = await run({
    sheetAnswers: [4, 0, -1], alertAnswers: [0], store,
    failAt: (path, method) => (method === 'PUT' && path.endsWith('/schedules')
      ? { code: 10072, message: '5 cron triggers per account' } : null),
  });
  const failure = alerts.find((a) => a.title === '額度仍然不足');
  assert.ok(failure);
  assert.match(failure.message, /查看 Cron 用量/);
});

/* ------------------------------------------------------------------ */
/* 一鍵安裝與釋出 cron 額度                                              */
/* ------------------------------------------------------------------ */

/** 只讓第一次設定排程失敗，重試時放行 */
function failFirstScheduleOnly(code, message) {
  let seen = 0;
  return (path, method) => {
    if (method === 'PUT' && path.endsWith('/schedules')) {
      seen += 1;
      if (seen === 1) return { code, message };
    }
    return null;
  };
}

test('一鍵安裝：cron 滿了會讓你挑一支釋出，然後自動重試', async () => {
  const store = new Map([
    ['crg.cf.token', CF_TOKEN], ['crg.cf.account', 'acct123'],
    ['crg.discord.webhook', HOOK],
  ]);
  const { cfCalls, alerts, store: after } = await run({
    // 0=一鍵安裝, 1=路線選「釋出額度」, 0=清單挑第一個(本工具自己的), -1=回選單
    sheetAnswers: [0, 1, 0, -1],
    // 部署確認 / 已釋出 / 安裝完成
    alertAnswers: [0, 0, 0],
    store,
    existingScripts: ['crypto-radar-guardian', 'crypto-radar-guardian-24x7'],
    schedulesByScript: {
      'crypto-radar-guardian': ['*/5 * * * *'],
      'crypto-radar-guardian-24x7': ['*/5 * * * *', '0 * * * *'],
    },
    failAt: failFirstScheduleOnly(10072, '5 cron triggers per account'),
  });

  // 應該清掉了排程（PUT schedules 帶空陣列）
  const cleared = cfCalls.filter((c) => c.method === 'PUT' && c.path.endsWith('/schedules')
    && c.body === '[]');
  assert.equal(cleared.length, 1, '應清除一支的排程');

  // 然後重試設定 Guardian 的排程
  const retried = cfCalls.filter((c) => c.method === 'PUT'
    && c.path.includes('crypto-radar-guardian/schedules') && c.body !== '[]');
  assert.equal(retried.length, 2, '第一次失敗加重試共兩次');
  assert.deepEqual(JSON.parse(retried[1].body), [{ cron: '*/5 * * * *' }]);

  assert.ok(alerts.some((a) => a.title === '已釋出'));
  assert.ok(alerts.some((a) => a.title === '安裝完成'));
  assert.ok(after.get('crg.cf.guardianUrl'));
});

test('釋出清單把本工具自己的排在前面並標記來源', async () => {
  const store = new Map([['crg.cf.token', CF_TOKEN], ['crg.cf.account', 'acct123']]);
  const { alerts } = await run({
    sheetAnswers: [0, 1, -1, -1], alertAnswers: [0, 0], store,
    existingScripts: ['zzz-other', 'crypto-radar-guardian'],
    schedulesByScript: { 'zzz-other': ['0 * * * *'], 'crypto-radar-guardian': ['*/5 * * * *'] },
    failAt: failFirstScheduleOnly(10072, '5 cron triggers per account'),
  });
  const picker = alerts.find((a) => a.title === '要釋出哪一支？');
  assert.ok(picker, '應顯示釋出清單');
  assert.match(picker.message, /本工具/);
  assert.match(picker.message, /不會再自動執行/, '要講清楚後果');
  assert.match(picker.message, /最後修改時間/, '要提供判斷依據');
});

test('選到別人的 Worker 時要再確認一次，取消就不清除', async () => {
  const store = new Map([['crg.cf.token', CF_TOKEN], ['crg.cf.account', 'acct123']]);
  const { cfCalls, alerts } = await run({
    // 0=一鍵安裝, 1=路線選「釋出額度」, 0=清單只有一項(別人的)選它, -1=回選單
    sheetAnswers: [0, 1, 0, -1],
    // 部署確認 / 二次確認取消(-1) / 安裝未完成
    alertAnswers: [0, -1, 0],
    store,
    existingScripts: ['crypto-radar-guardian-24x7'],
    schedulesByScript: { 'crypto-radar-guardian-24x7': ['*/5 * * * *'] },
    failAt: failFirstScheduleOnly(10072, '5 cron triggers per account'),
  });

  const warn = alerts.find((a) => a.title === '這不是本工具部署的');
  assert.ok(warn, '非自有的必須再確認');
  assert.match(warn.message, /正在管理交易/, '要點出可能停掉交易');
  assert.equal(
    cfCalls.filter((c) => c.method === 'PUT' && c.body === '[]').length, 0,
    '取消後不得清除任何排程',
  );
  assert.ok(alerts.some((a) => a.title === '安裝未完成'));
});

test('一鍵安裝：完全順利時一路走到完成', async () => {
  const store = new Map([
    ['crg.cf.token', CF_TOKEN], ['crg.cf.account', 'acct123'], ['crg.discord.webhook', HOOK],
  ]);
  const { alerts, store: after } = await run({
    sheetAnswers: [0, -1], alertAnswers: [0, 0], store,
  });
  const done = alerts.find((a) => a.title === '安裝完成');
  assert.ok(done, '應顯示安裝完成');
  assert.match(done.message, /workers\.dev/);
  assert.match(done.message, /\?token=/, '要告訴使用者怎麼看帳戶');
  assert.ok(!alerts.some((a) => a.title && a.title.startsWith('Cron 額度已滿')),
    '沒撞到額度就不該出現釋出流程');
  assert.ok(after.get('crg.admin.token'));
});

test('一鍵安裝：沒有 Token 時先帶你設定', async () => {
  const { cfCalls, store: after } = await run({
    sheetAnswers: [0, -1], alertAnswers: [0, 0, 0], textValues: [CF_TOKEN], store: new Map(),
  });
  assert.equal(after.get('crg.cf.token'), CF_TOKEN);
  assert.ok(cfCalls.some((c) => c.path.endsWith('/workers/scripts')), '應完成權限驗證');
});

test('一鍵安裝：非額度問題的排程失敗不會進釋出流程', async () => {
  const store = new Map([['crg.cf.token', CF_TOKEN], ['crg.cf.account', 'acct123']]);
  const { alerts } = await run({
    sheetAnswers: [0, -1], alertAnswers: [0, 0], store,
    failAt: (path, method) => (method === 'PUT' && path.endsWith('/schedules')
      ? { code: 10022, message: 'cron 格式錯誤' } : null),
  });
  assert.ok(!alerts.some((a) => a.title && a.title.startsWith('Cron 額度已滿')));
  const failure = alerts.find((a) => a.title === '已部署，但排程沒設成');
  assert.ok(failure);
  assert.match(failure.message, /cron 格式錯誤/);
});

test('沒有任何排程可釋出時，據實說明而不是空清單', async () => {
  const store = new Map([['crg.cf.token', CF_TOKEN], ['crg.cf.account', 'acct123']]);
  const { alerts } = await run({
    sheetAnswers: [0, 1, -1], alertAnswers: [0, 0, 0], store,
    existingScripts: ['crypto-radar-guardian'],
    schedulesByScript: {},
    failAt: failFirstScheduleOnly(10072, '5 cron triggers per account'),
  });
  assert.ok(alerts.some((a) => a.title === '沒有可以釋出的排程'));
});

test('額度滿時，第一個選項是不用動任何現有排程的路線', async () => {
  const store = new Map([['crg.cf.token', CF_TOKEN], ['crg.cf.account', 'acct123']]);
  const { alerts } = await run({
    sheetAnswers: [0, -1, -1], alertAnswers: [0, 0], store,
    existingScripts: ['crypto-radar-guardian-24x7'],
    schedulesByScript: { 'crypto-radar-guardian-24x7': ['*/5 * * * *'] },
    failAt: failFirstScheduleOnly(10072, '5 cron triggers per account'),
  });
  const route = alerts.find((a) => a.title && a.title.startsWith('Cron 額度已滿'));
  assert.ok(route, '應先問走哪條路');
  assert.match(route.message, /兩條路/);
});

test('選 GitHub Actions 路線會給出網址與 Token，且不刪任何排程', async () => {
  const store = new Map([
    ['crg.cf.token', CF_TOKEN], ['crg.cf.account', 'acct123'],
    ['crg.admin.token', 'admintok12345678'],
  ]);
  const { cfCalls, alerts, copied } = await run({
    // 0=一鍵安裝, 0=路線選 GitHub Actions, -1=不複製, -1=回選單
    sheetAnswers: [0, 0, -1, -1], alertAnswers: [0, 0, 0], store,
    existingScripts: ['crypto-radar-guardian-24x7'],
    schedulesByScript: { 'crypto-radar-guardian-24x7': ['*/5 * * * *'] },
    failAt: failFirstScheduleOnly(10072, '5 cron triggers per account'),
  });

  const guide = alerts.find((a) => a.title === '用 GitHub Actions 定時觸發');
  assert.ok(guide, '應顯示替代方案說明');
  assert.match(guide.message, /crypto-radar-scan\.yml/, '要指出設定檔在哪');
  assert.match(guide.message, /GUARDIAN_URL/);
  assert.match(guide.message, /ADMIN_TOKEN/);
  assert.match(guide.message, /admintok12345678/, '要把 Token 給使用者');
  assert.equal(
    cfCalls.filter((c) => c.method === 'PUT' && c.body === '[]').length, 0,
    '這條路不該刪掉任何排程',
  );
  assert.deepEqual(copied, [], '沒選複製就不該動剪貼簿');
});

test('可以把網址或 Token 複製到剪貼簿', async () => {
  const store = new Map([
    ['crg.cf.token', CF_TOKEN], ['crg.cf.account', 'acct123'],
    ['crg.admin.token', 'admintok12345678'],
  ]);
  const { copied } = await run({
    sheetAnswers: [0, 0, 1, -1], alertAnswers: [0, 0, 0], store,
    existingScripts: ['x'], schedulesByScript: { x: ['*/5 * * * *'] },
    failAt: failFirstScheduleOnly(10072, '5 cron triggers per account'),
  });
  assert.deepEqual(copied, ['admintok12345678'], '選「複製 Token」應複製 Token');
});

test('釋出清單會顯示最後修改時間當判斷依據', async () => {
  const store = new Map([['crg.cf.token', CF_TOKEN], ['crg.cf.account', 'acct123']]);
  const { alerts } = await run({
    sheetAnswers: [0, 1, -1, -1], alertAnswers: [0, 0], store,
    existingScripts: ['old-worker'],
    schedulesByScript: { 'old-worker': ['0 0 * * *'] },
    scriptMeta: { 'old-worker': { modified_on: new Date(Date.now() - 400 * 86400000).toISOString() } },
    failAt: failFirstScheduleOnly(10072, '5 cron triggers per account'),
  });
  const picker = alerts.find((a) => a.title === '要釋出哪一支？');
  assert.ok(picker);
  assert.match(picker.message, /很久沒動過的通常已經沒在用/);
});
