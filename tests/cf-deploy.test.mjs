import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CF_API,
  CloudflareError,
  REQUIRED_TOKEN_PERMISSIONS,
  buildMetadata,
  deployWorker,
  describeCfErrors,
  ensureKvNamespace,
  explainCfError,
  hintForCfError,
  listAccounts,
  listScripts,
  makeClient,
  setSchedules,
  verifyToken,
  workerUrl,
} from '../app/cf-deploy.js';

const TOKEN = 'cf-token-abcdef1234567890';
const ACCOUNT = 'acct123';

/** 假的 Cloudflare。routes 是 "METHOD /path" → 回應或函式 */
function mockCf(routes) {
  const calls = [];
  const doFetch = async (url, init) => {
    const path = url.replace(CF_API, '').split('?')[0];
    const key = `${init.method} ${path}`;
    calls.push({ key, url, init });
    const handler = routes[key];
    if (handler === undefined) {
      return { status: 404, async json() { return { success: false, errors: [{ code: 7003, message: '找不到路由 ' + key }] }; } };
    }
    const body = typeof handler === 'function' ? handler(init) : handler;
    return { status: 200, async json() { return body; } };
  };
  return { calls, doFetch };
}

const ok = (result) => ({ success: true, result, errors: [] });
const fail = (code, message) => ({ success: false, result: null, errors: [{ code, message }] });

const HAPPY_ROUTES = {
  'GET /user/tokens/verify': ok({ status: 'active' }),
  'GET /accounts/acct123/workers/scripts': ok([]),
  'GET /accounts': ok([{ id: ACCOUNT, name: '我的帳號' }]),
  'GET /accounts/acct123/storage/kv/namespaces': ok([]),
  'POST /accounts/acct123/storage/kv/namespaces': ok({ id: 'kv-new-id', title: 'crypto-radar-guardian' }),
  'PUT /accounts/acct123/workers/scripts/crypto-radar-guardian': ok({ id: 'crypto-radar-guardian' }),
  'PUT /accounts/acct123/workers/scripts/crypto-radar-guardian/schedules': ok({ schedules: [] }),
  'POST /accounts/acct123/workers/scripts/crypto-radar-guardian/subdomain': ok({ enabled: true }),
  'GET /accounts/acct123/workers/subdomain': ok({ subdomain: 'my-account' }),
};

const buildMultipart = (parts) => ({ headers: {}, body: { __multipart: parts } });

/* ------------------------------------------------------------------ */

test('缺少 Token 時直接拒絕建立客戶端', () => {
  assert.throws(() => makeClient('', async () => {}), /缺少 Cloudflare API Token/);
  assert.throws(() => makeClient('   ', async () => {}), /缺少 Cloudflare API Token/);
  assert.throws(() => makeClient(null, async () => {}), /缺少 Cloudflare API Token/);
});

test('每個請求都帶 Bearer Token', async () => {
  const cf = mockCf(HAPPY_ROUTES);
  const client = makeClient(TOKEN, cf.doFetch);
  await verifyToken(client);
  assert.equal(cf.calls[0].init.headers.Authorization, `Bearer ${TOKEN}`);
});

test('Token 狀態不是 active 就擋下', async () => {
  const cf = mockCf({ 'GET /user/tokens/verify': ok({ status: 'disabled' }) });
  const client = makeClient(TOKEN, cf.doFetch);
  await assert.rejects(() => verifyToken(client), /disabled/);
});

test('看不到帳號時給出明確訊息', async () => {
  const cf = mockCf({ 'GET /accounts': ok([]) });
  const client = makeClient(TOKEN, cf.doFetch);
  await assert.rejects(() => listAccounts(client), /看不到任何帳號/);
});

test('KV 已存在就沿用，不重複建立', async () => {
  const cf = mockCf({
    'GET /accounts/acct123/storage/kv/namespaces': ok([
      { id: 'other', title: '別的' },
      { id: 'kv-existing', title: 'crypto-radar-guardian' },
    ]),
  });
  const client = makeClient(TOKEN, cf.doFetch);
  const kv = await ensureKvNamespace(client, ACCOUNT, 'crypto-radar-guardian');
  assert.deepEqual(kv, { id: 'kv-existing', created: false });
  assert.ok(!cf.calls.some((c) => c.key.startsWith('POST')), '不應發出建立請求');
});

test('KV 不存在就建立', async () => {
  const cf = mockCf(HAPPY_ROUTES);
  const client = makeClient(TOKEN, cf.doFetch);
  const kv = await ensureKvNamespace(client, ACCOUNT, 'crypto-radar-guardian');
  assert.deepEqual(kv, { id: 'kv-new-id', created: true });
  const post = cf.calls.find((c) => c.key.startsWith('POST'));
  assert.deepEqual(JSON.parse(post.init.body), { title: 'crypto-radar-guardian' });
});

test('metadata 帶齊 KV 與機密綁定，空值不佔位', () => {
  const meta = buildMetadata({
    mainModule: 'worker.js',
    kvBindingName: 'GUARDIAN_KV',
    kvNamespaceId: 'kv1',
    secrets: { DISCORD_WEBHOOK: 'https://discord.com/x', BYBIT_API_KEY: '', ADMIN_TOKEN: 'tok' },
    vars: { BYBIT_ENV: 'demo' },
  });
  assert.equal(meta.main_module, 'worker.js');
  const byName = Object.fromEntries(meta.bindings.map((b) => [b.name, b]));
  assert.equal(byName.GUARDIAN_KV.type, 'kv_namespace');
  assert.equal(byName.GUARDIAN_KV.namespace_id, 'kv1');
  assert.equal(byName.DISCORD_WEBHOOK.type, 'secret_text');
  assert.equal(byName.ADMIN_TOKEN.type, 'secret_text');
  assert.equal(byName.BYBIT_ENV.type, 'plain_text');
  assert.ok(!('BYBIT_API_KEY' in byName), '空字串不該產生綁定');
});

test('排程送出的是 Cloudflare 要的陣列格式', async () => {
  const cf = mockCf(HAPPY_ROUTES);
  const client = makeClient(TOKEN, cf.doFetch);
  await setSchedules(client, ACCOUNT, 'crypto-radar-guardian', ['*/5 * * * *']);
  const call = cf.calls.find((c) => c.key.includes('schedules'));
  assert.deepEqual(JSON.parse(call.init.body), [{ cron: '*/5 * * * *' }]);
});

test('完整部署會依序走完每一步', async () => {
  const cf = mockCf(HAPPY_ROUTES);
  const client = makeClient(TOKEN, cf.doFetch);
  const progress = [];
  const result = await deployWorker({
    client, accountId: ACCOUNT, scriptName: 'crypto-radar-guardian',
    script: 'export default {};', kvBindingName: 'GUARDIAN_KV', kvTitle: 'crypto-radar-guardian',
    secrets: { DISCORD_WEBHOOK: 'https://discord.com/x' },
    vars: { BYBIT_ENV: 'live' },
    crons: ['*/5 * * * *'],
    buildMultipart,
    onProgress: (m) => progress.push(m),
  });

  assert.deepEqual(cf.calls.map((c) => c.key), [
    'GET /user/tokens/verify',
    'GET /accounts/acct123/storage/kv/namespaces',
    'POST /accounts/acct123/storage/kv/namespaces',
    'GET /accounts/acct123/workers/scripts',
    'PUT /accounts/acct123/workers/scripts/crypto-radar-guardian',
    'PUT /accounts/acct123/workers/scripts/crypto-radar-guardian/schedules',
    'POST /accounts/acct123/workers/scripts/crypto-radar-guardian/subdomain',
    'GET /accounts/acct123/workers/subdomain',
  ]);
  assert.equal(result.url, 'https://crypto-radar-guardian.my-account.workers.dev');
  assert.ok(progress.length >= 4, '每一步都要回報進度');
  assert.ok(result.steps.some((s) => s.includes('已建立 KV')));
});

test('上傳用 multipart，程式碼與 metadata 分開兩份', async () => {
  const cf = mockCf(HAPPY_ROUTES);
  const client = makeClient(TOKEN, cf.doFetch);
  await deployWorker({
    client, accountId: ACCOUNT, scriptName: 'crypto-radar-guardian',
    script: 'export default { fetch(){} };', kvBindingName: 'GUARDIAN_KV', kvTitle: 'crypto-radar-guardian',
    secrets: {}, crons: [], buildMultipart,
  });
  const upload = cf.calls.find((c) => c.key === 'PUT /accounts/acct123/workers/scripts/crypto-radar-guardian');
  const parts = upload.init.body.__multipart;
  assert.equal(parts.mainModule, 'worker.js');
  assert.match(parts.script, /export default/);
  const meta = JSON.parse(parts.metadata);
  assert.equal(meta.main_module, 'worker.js');
  assert.ok(Array.isArray(meta.bindings));
});

test('任何一步失敗都會指出是哪一步', async () => {
  const cases = [
    ['驗證 Token', { 'GET /user/tokens/verify': fail(10000, 'Invalid API Token') }],
    ['讀取 KV', { ...HAPPY_ROUTES, 'GET /accounts/acct123/storage/kv/namespaces': fail(10001, '沒權限') }],
    ['上傳 Worker', { ...HAPPY_ROUTES, 'PUT /accounts/acct123/workers/scripts/crypto-radar-guardian': fail(10021, '指令碼錯誤') }],
    ['設定排程', { ...HAPPY_ROUTES, 'PUT /accounts/acct123/workers/scripts/crypto-radar-guardian/schedules': fail(10022, 'cron 錯') }],
  ];
  for (const [expectedStep, routes] of cases) {
    const cf = mockCf(routes);
    const client = makeClient(TOKEN, cf.doFetch);
    await assert.rejects(
      () => deployWorker({
        client, accountId: ACCOUNT, scriptName: 'crypto-radar-guardian',
        script: 'x', kvBindingName: 'GUARDIAN_KV', kvTitle: 'crypto-radar-guardian',
        secrets: {}, crons: ['*/5 * * * *'], buildMultipart,
      }),
      (err) => {
        assert.ok(err instanceof CloudflareError, '應為 CloudflareError');
        assert.equal(err.step, expectedStep, `預期卡在「${expectedStep}」，實際「${err.step}」`);
        return true;
      },
    );
  }
});

test('Token 無效的錯誤會講清楚要加哪些權限', () => {
  const msg = explainCfError(10000, 'Invalid API Token');
  assert.match(msg, /Invalid API Token/, '原始訊息必須保留');
  assert.match(msg, /Workers Scripts/);
  assert.match(msg, /Workers KV Storage/);
  assert.equal(REQUIRED_TOKEN_PERMISSIONS.length, 2);
});

test('補充說明是附加，永遠不會蓋掉 Cloudflare 的原始訊息', () => {
  // 這條是迴歸測試。原本的寫法看到 exceeded 就翻成「額度用完」，
  // 但 Script startup exceeded CPU limit 是程式啟動超時，完全不同的問題。
  const cpu = explainCfError(10021, 'Script startup exceeded CPU limit');
  assert.match(cpu, /Script startup exceeded CPU limit/);
  assert.doesNotMatch(cpu, /額度/, '不得誤導成額度問題');

  for (const [code, raw] of [[10000, 'Invalid API Token'], [9109, 'not entitled'], [99999, 'whatever']]) {
    assert.match(explainCfError(code, raw), new RegExp(raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      `原始訊息 "${raw}" 必須保留`);
  }
});

test('沒把握的錯誤碼不給任何解讀', () => {
  assert.equal(hintForCfError(99999, 'something odd'), null);
  assert.equal(hintForCfError(10021, 'Script startup exceeded CPU limit'), null);
  assert.equal(explainCfError(99999, 'something odd'), 'something odd');
});

test('網路層錯誤不會把 Token 帶進訊息', async () => {
  const doFetch = async () => { throw new Error(`connect failed with Bearer ${TOKEN}`); };
  const client = makeClient(TOKEN, doFetch);
  await assert.rejects(() => verifyToken(client), (err) => {
    assert.ok(!err.message.includes(TOKEN), 'Token 不得出現在錯誤訊息');
    assert.match(err.message, /\[token\]/);
    return true;
  });
});

test('回應不是 JSON 或 success 非 true 都算失敗', async () => {
  const notJson = makeClient(TOKEN, async () => ({ status: 500, async json() { throw new Error('not json'); } }));
  await assert.rejects(() => verifyToken(notJson), CloudflareError);

  const notSuccess = makeClient(TOKEN, async () => ({ status: 200, async json() { return { success: false, errors: [] }; } }));
  await assert.rejects(() => verifyToken(notSuccess), CloudflareError);
});

test('錯誤訊息解析涵蓋各種回應形狀', () => {
  assert.match(describeCfErrors({ errors: [{ code: 10000, message: 'bad' }] }), /\[10000\] bad/);
  assert.match(describeCfErrors({ errors: [{ message: 'bad' }] }), /bad/);
  assert.equal(describeCfErrors({ message: 'plain' }), 'plain');
  assert.equal(describeCfErrors(null), '未知錯誤');
  assert.equal(describeCfErrors({}), '未知錯誤');
});

test('讀不到子網域時仍然完成部署，只是沒有網址', async () => {
  const cf = mockCf({ ...HAPPY_ROUTES, 'GET /accounts/acct123/workers/subdomain': ok({}) });
  const client = makeClient(TOKEN, cf.doFetch);
  const result = await deployWorker({
    client, accountId: ACCOUNT, scriptName: 'crypto-radar-guardian',
    script: 'x', kvBindingName: 'GUARDIAN_KV', kvTitle: 'crypto-radar-guardian',
    secrets: {}, crons: [], buildMultipart,
  });
  assert.equal(result.url, null);
  assert.ok(result.steps.some((s) => s.includes('讀不到子網域')));
});

test('網址組法正確', () => {
  assert.equal(workerUrl('a', 'b'), 'https://a.b.workers.dev');
  assert.equal(workerUrl('a', null), null);
});

/* ------------------------------------------------------------------ */
/* 覆蓋既有 Worker 的保險                                                */
/* ------------------------------------------------------------------ */

const deployArgs = (extra = {}) => ({
  accountId: ACCOUNT, scriptName: 'crypto-radar-guardian', script: 'export default {};',
  kvBindingName: 'GUARDIAN_KV', kvTitle: 'crypto-radar-guardian',
  secrets: {}, crons: [], buildMultipart, ...extra,
});

test('列出帳號上既有的 Worker', async () => {
  const cf = mockCf({
    'GET /accounts/acct123/workers/scripts': ok([
      { id: 'crypto-radar-guardian-24x7' }, { id: '別的' }, {},
    ]),
  });
  const names = await listScripts(makeClient(TOKEN, cf.doFetch), ACCOUNT);
  assert.deepEqual(names, ['crypto-radar-guardian-24x7', '別的']);
});

test('名字沒被佔用時直接部署，不會多問', async () => {
  const cf = mockCf({
    ...HAPPY_ROUTES,
    'GET /accounts/acct123/workers/scripts': ok([{ id: 'crypto-radar-guardian-24x7' }]),
  });
  let asked = false;
  const result = await deployWorker(deployArgs({
    client: makeClient(TOKEN, cf.doFetch),
    confirmReplace: async () => { asked = true; return true; },
  }));
  assert.equal(asked, false, '不同名就不該問');
  assert.ok(result.steps.some((s) => s.includes('已建立')));
  assert.ok(result.steps.some((s) => s.includes('其他 1 支 Worker 未受影響')));
});

test('名字已存在且使用者取消時，絕不上傳', async () => {
  const cf = mockCf({
    ...HAPPY_ROUTES,
    'GET /accounts/acct123/workers/scripts': ok([{ id: 'crypto-radar-guardian' }]),
  });
  await assert.rejects(
    () => deployWorker(deployArgs({
      client: makeClient(TOKEN, cf.doFetch),
      confirmReplace: async () => false,
    })),
    /未取得覆蓋確認/,
  );
  assert.ok(
    !cf.calls.some((c) => c.key === 'PUT /accounts/acct123/workers/scripts/crypto-radar-guardian'),
    '取消後不得發出上傳請求',
  );
});

test('沒有提供確認函式時，等同拒絕覆蓋', async () => {
  const cf = mockCf({
    ...HAPPY_ROUTES,
    'GET /accounts/acct123/workers/scripts': ok([{ id: 'crypto-radar-guardian' }]),
  });
  await assert.rejects(
    () => deployWorker(deployArgs({ client: makeClient(TOKEN, cf.doFetch) })),
    /未取得覆蓋確認/,
  );
});

test('確認覆蓋後才上傳，並如實說是覆蓋不是新建', async () => {
  const cf = mockCf({
    ...HAPPY_ROUTES,
    'GET /accounts/acct123/workers/scripts': ok([
      { id: 'crypto-radar-guardian' }, { id: 'crypto-radar-guardian-24x7' },
    ]),
  });
  let shown = null;
  const result = await deployWorker(deployArgs({
    client: makeClient(TOKEN, cf.doFetch),
    confirmReplace: async (info) => { shown = info; return true; },
  }));
  assert.equal(shown.scriptName, 'crypto-radar-guardian');
  assert.deepEqual(shown.otherScripts, ['crypto-radar-guardian-24x7'],
    '要讓使用者看到其他不受影響的 Worker');
  // 只看上傳那一步的措辭，KV 那一步的「已建立」不算
  const uploadStep = result.steps.find((s) => s.includes('crypto-radar-guardian（'));
  assert.ok(uploadStep, `找不到上傳步驟，實得 ${JSON.stringify(result.steps)}`);
  assert.match(uploadStep, /^已覆蓋/, '覆蓋既有 Worker 時要如實說是覆蓋');
});
