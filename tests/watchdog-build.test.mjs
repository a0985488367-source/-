import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const PATH = new URL('../public/crypto-radar-watchdog.worker.js', import.meta.url).pathname;
const source = readFileSync(PATH, 'utf8');

const HOOK = 'https://discord.com/api/webhooks/123456789012345678/abcDEF-ghi_JKL123';
const GUARDIAN = 'https://guardian.example.workers.dev';

function makeKv() {
  const store = new Map();
  return {
    store,
    async get(k) { return store.has(k) ? store.get(k) : null; },
    async put(k, v) { store.set(k, v); },
  };
}

/** health 為 null 代表連不上 */
function installFetch(healthSequence) {
  const posts = [];
  const original = globalThis.fetch;
  let i = 0;
  globalThis.fetch = async (url, init) => {
    const u = new URL(String(url));
    if (u.hostname.endsWith('discord.com')) {
      posts.push({ body: init?.body });
      return new Response('', { status: 204 });
    }
    const health = healthSequence[Math.min(i, healthSequence.length - 1)];
    i += 1;
    if (health === null) throw new Error('connection refused');
    return new Response(JSON.stringify(health), {
      status: health.ok ? 200 : 503, headers: { 'content-type': 'application/json' },
    });
  };
  return { posts, restore: () => { globalThis.fetch = original; } };
}

const healthy = { ok: true, status: 'healthy', ageSeconds: 60, heartbeatAt: Date.now() };
const stale = { ok: false, status: 'stale', ageSeconds: 1800, heartbeatAt: Date.now() - 1800_000 };

async function loadWorker() {
  const mod = await import(PATH + '?t=' + Date.now() + Math.random());
  return mod.default;
}

/* ------------------------------------------------------------------ */

test('產生後的守衛語法正確', () => {
  execFileSync(process.execPath, ['--check', PATH], { stdio: 'pipe' });
});

test('只保留一個 default export', () => {
  assert.doesNotMatch(source, /^import\s/m);
  assert.deepEqual([...source.matchAll(/^export\s+(\w+)/gm)].map((m) => m[1]), ['default']);
});

test('部署說明涵蓋 KV、Secrets 與錯開的 Cron', () => {
  assert.match(source, /WATCHDOG_KV/);
  assert.match(source, /GUARDIAN_URL/);
  assert.match(source, /DISCORD_WEBHOOK/);
  assert.match(source, /4,14,24,34,44,54/);
});

test('守衛完全沒有交易或風險相關的程式路徑', () => {
  for (const forbidden of ['/v5/order', '/v5/position', 'placeOrder', 'X-BAPI-SIGN', 'riskPercent', 'maxPositions']) {
    assert.ok(!source.includes(forbidden), `不得包含 ${forbidden}`);
  }
  assert.match(source, /不會改動任何交易或風險設定/);
});

test('健康時不發通知', async () => {
  const net = installFetch([healthy]);
  try {
    const kv = makeKv();
    const worker = await loadWorker();
    await worker.scheduled({}, { WATCHDOG_KV: kv, GUARDIAN_URL: GUARDIAN, DISCORD_WEBHOOK: HOOK }, {});
    assert.equal(net.posts.length, 0);
  } finally {
    net.restore();
  }
});

test('遲滯：單次異常不告警，連續兩次才告警', async () => {
  const net = installFetch([stale]);
  try {
    const kv = makeKv();
    const worker = await loadWorker();
    const env = { WATCHDOG_KV: kv, GUARDIAN_URL: GUARDIAN, DISCORD_WEBHOOK: HOOK };
    await worker.scheduled({}, env, {});
    assert.equal(net.posts.length, 0, '第一次不該告警');
    await worker.scheduled({}, env, {});
    assert.equal(net.posts.length, 1, '第二次才告警');
    assert.match(JSON.parse(net.posts[0].body).content, /Guardian 異常/);
  } finally {
    net.restore();
  }
});

test('連不上 Guardian 也會告警', async () => {
  const net = installFetch([null]);
  try {
    const kv = makeKv();
    const worker = await loadWorker();
    const env = { WATCHDOG_KV: kv, GUARDIAN_URL: GUARDIAN, DISCORD_WEBHOOK: HOOK };
    await worker.scheduled({}, env, {});
    await worker.scheduled({}, env, {});
    assert.equal(net.posts.length, 1);
    assert.match(JSON.parse(net.posts[0].body).content, /無法連線/);
  } finally {
    net.restore();
  }
});

test('節流：告警後連續執行不會洗版', async () => {
  const net = installFetch([stale]);
  try {
    const kv = makeKv();
    const worker = await loadWorker();
    const env = { WATCHDOG_KV: kv, GUARDIAN_URL: GUARDIAN, DISCORD_WEBHOOK: HOOK };
    for (let i = 0; i < 6; i += 1) await worker.scheduled({}, env, {});
    assert.equal(net.posts.length, 1, '六輪之內只該告警一次');
  } finally {
    net.restore();
  }
});

test('恢復時送出恢復通知，且只送一次', async () => {
  const net = installFetch([stale, stale, healthy, healthy]);
  try {
    const kv = makeKv();
    const worker = await loadWorker();
    const env = { WATCHDOG_KV: kv, GUARDIAN_URL: GUARDIAN, DISCORD_WEBHOOK: HOOK };
    await worker.scheduled({}, env, {});
    await worker.scheduled({}, env, {});
    assert.equal(net.posts.length, 1);
    await worker.scheduled({}, env, {});
    assert.equal(net.posts.length, 2);
    assert.match(JSON.parse(net.posts[1].body).content, /已恢復正常/);
    await worker.scheduled({}, env, {});
    assert.equal(net.posts.length, 2, '恢復通知只送一次');
  } finally {
    net.restore();
  }
});

test('沒設 Webhook 時不會嘗試發送', async () => {
  const net = installFetch([stale]);
  try {
    const kv = makeKv();
    const worker = await loadWorker();
    const env = { WATCHDOG_KV: kv, GUARDIAN_URL: GUARDIAN };
    await worker.scheduled({}, env, {});
    await worker.scheduled({}, env, {});
    assert.equal(net.posts.length, 0);
  } finally {
    net.restore();
  }
});

test('自身端點回報 dead-man switch 狀態', async () => {
  const net = installFetch([healthy]);
  try {
    const kv = makeKv();
    const worker = await loadWorker();
    const env = { WATCHDOG_KV: kv, GUARDIAN_URL: GUARDIAN, DISCORD_WEBHOOK: HOOK };

    const before = await worker.fetch(new Request('https://w.example.dev/'), env, {});
    assert.equal(before.status, 503, '從未執行過應為不健康');
    assert.match((await before.json()).detail, /沒有回報時間/);

    await worker.scheduled({}, env, {});
    const after = await worker.fetch(new Request('https://w.example.dev/'), env, {});
    assert.equal(after.status, 200);
    const body = await after.json();
    assert.equal(body.ok, true);
    assert.equal(body.role, 'discord-heartbeat-watchdog');
    assert.equal(body.guardianUrl, '已設定');
    assert.equal(body.discordConfigured, true);
  } finally {
    net.restore();
  }
});

test('狀態端點不洩漏 Webhook 或 Guardian 網址', async () => {
  const net = installFetch([healthy]);
  try {
    const kv = makeKv();
    const worker = await loadWorker();
    const env = { WATCHDOG_KV: kv, GUARDIAN_URL: GUARDIAN, DISCORD_WEBHOOK: HOOK };
    await worker.scheduled({}, env, {});
    const text = await (await worker.fetch(new Request('https://w.example.dev/'), env, {})).text();
    assert.ok(!text.includes(HOOK));
    assert.ok(!text.includes(GUARDIAN), '不該回傳 Guardian 完整網址');
  } finally {
    net.restore();
  }
});

test('缺少 KV 綁定時給出明確錯誤', async () => {
  const worker = await loadWorker();
  const res = await worker.fetch(new Request('https://w.example.dev/'), {}, {});
  assert.equal(res.status, 500);
  assert.match((await res.json()).error, /WATCHDOG_KV/);
});

test('產生器輸出是決定性的', () => {
  const before = readFileSync(PATH, 'utf8');
  execFileSync(process.execPath, ['scripts/build-watchdog.mjs'], {
    cwd: new URL('..', import.meta.url).pathname, stdio: 'pipe',
  });
  assert.equal(readFileSync(PATH, 'utf8'), before);
});
