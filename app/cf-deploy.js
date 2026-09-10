/**
 * cf-deploy — 用 Cloudflare API 直接部署 Worker
 *
 * 為什麼需要：Cloudflare 儀表板的程式編輯器在手機上不穩，
 * 貼上大檔案後按 Deploy 常常沒反應。改用 API 就完全不碰編輯器。
 *
 * 這個模組只組請求與判讀回應，實際發送由宿主環境注入，
 * 方便在沒有網路的環境下測試請求構造。
 *
 * API Token 是機密：由呼叫端從 iOS Keychain 取得，
 * 不寫進程式碼、不寫進 Git、不出現在任何回傳或錯誤訊息裡。
 */

export const CF_API = 'https://api.cloudflare.com/client/v4';

/** 建立 Token 需要的權限，顯示給使用者看 */
export const REQUIRED_TOKEN_PERMISSIONS = Object.freeze([
  'Account → Workers Scripts → Edit',
  'Account → Workers KV Storage → Edit',
]);

/**
 * 清掉貼上時常夾帶的隱形字元。
 * 在 iPhone 上複製 Token 很容易帶到不斷行空格或零寬字元，
 * 而它們會讓認證失敗，錯誤訊息卻只說 invalid，非常難查。
 */
export function sanitizeToken(value) {
  return String(value ?? '').replace(/[\s\u00A0\u200B-\u200D\u2060\uFEFF]/g, '');
}

/**
 * Token 格式的粗略檢查。
 *
 * 目的是在還沒發出請求前，先擋掉明顯複製錯的情況（例如整段說明文字
 * 都被貼進來）。只回報看起來哪裡不對，不保證格式對就一定能用。
 */
export function inspectTokenShape(token) {
  const t = sanitizeToken(token);
  if (!t) return { ok: false, reason: 'Token 是空的。' };
  if (/[^A-Za-z0-9_-]/.test(t)) {
    return { ok: false, reason: 'Token 含有不該出現的字元，可能複製到多餘的文字。Cloudflare 的 Token 只會有英數字、底線與連字號。' };
  }
  if (t.length < 30) {
    return { ok: false, reason: `Token 只有 ${t.length} 個字元，看起來太短，可能沒複製完整。` };
  }
  if (t.length > 80) {
    return { ok: false, reason: `Token 有 ${t.length} 個字元，看起來太長，可能複製到多餘內容。` };
  }
  return { ok: true, reason: null };
}

export class CloudflareError extends Error {
  constructor(step, message, code) {
    super(message);
    this.name = 'CloudflareError';
    this.step = step;
    this.code = code ?? null;
  }
}

/**
 * 從 Cloudflare 的回應取出錯誤訊息。
 * 它的錯誤格式是 { success:false, errors:[{code, message}] }。
 */
export function describeCfErrors(body) {
  const errors = body?.errors;
  if (Array.isArray(errors) && errors.length) {
    return errors.map((e) => `${e.code ? `[${e.code}] ` : ''}${e.message ?? '未知錯誤'}`).join('；');
  }
  if (typeof body?.message === 'string') return body.message;
  return '未知錯誤';
}

/**
 * 為已知的錯誤碼補上一句「該怎麼辦」。
 *
 * 重點：**原始訊息一定保留**。之前的寫法會用自己的解讀整個取代
 * Cloudflare 的說法，結果像「Script startup exceeded CPU limit」這種
 * 訊息因為含有 exceeded 就被翻成「超出帳號額度限制」，
 * 完全是另一回事，會把人帶去查錯方向。
 *
 * 只在「非常確定」的情況下才加解讀，而且是附加，不是取代。
 */
export function explainCfError(code, message) {
  const c = Number(code);
  const raw = String(message ?? '未知錯誤');
  const hint = hintForCfError(c, raw);
  return hint ? `${raw}\n\n${hint}` : raw;
}

/** 回傳補充說明，沒把握就回 null，絕不亂猜 */
export function hintForCfError(code, message) {
  const c = Number(code);
  const raw = String(message ?? '');

  // 認證問題：這幾個碼與訊息型態非常明確
  if (c === 10000 || /invalid api token|authentication error|unauthorized/i.test(raw)) {
    return 'Token 無效或權限不足。請確認 Token 有這兩項權限：\n'
      + REQUIRED_TOKEN_PERMISSIONS.map((p) => `· ${p}`).join('\n');
  }
  if (c === 9109 || /not entitled/i.test(raw)) {
    return '這個帳號沒有使用該功能的權限，可能需要先在 Cloudflare 啟用 Workers。';
  }
  // 額度：只在訊息明確指向用量時才這樣說
  if (/exceeded your.*limit|quota exceeded|too many namespaces|maximum number of/i.test(raw)) {
    return '看起來是帳號額度用完了。請到 Cloudflare 檢查 Workers 或 KV 的用量。';
  }
  return null;
}

/**
 * 建立一個綁定 Token 的 Cloudflare API 客戶端。
 *
 * @param {string} token API Token
 * @param {(url:string, init:object)=>Promise<{status:number, json:()=>Promise<any>, text:()=>Promise<string>}>} doFetch
 */
export function makeClient(token, doFetch) {
  const clean = sanitizeToken(token);
  if (!clean) throw new Error('缺少 Cloudflare API Token');
  const auth = { Authorization: `Bearer ${clean}` };

  async function call(step, method, path, { json, headers, body } = {}) {
    const init = {
      method,
      headers: { ...auth, ...(json ? { 'Content-Type': 'application/json' } : {}), ...(headers ?? {}) },
    };
    if (json !== undefined) init.body = JSON.stringify(json);
    if (body !== undefined) init.body = body;

    let res;
    try {
      res = await doFetch(CF_API + path, init);
    } catch (err) {
      // 網路層錯誤不該把 Token 帶出去
      const raw = String(err?.message ?? err).split(clean).join('[token]');
      throw new CloudflareError(step, `連線失敗：${raw}`);
    }

    let parsed = null;
    let rawText = null;
    try {
      parsed = await res.json();
    } catch {
      parsed = null;
      // JSON 解析失敗時，原始內容才是有用的線索，不能只回「未知錯誤」
      try { rawText = await res.text(); } catch { rawText = null; }
    }

    if (!parsed || parsed.success !== true) {
      if (!parsed) {
        const snippet = rawText ? `\n\n回應內容：${String(rawText).slice(0, 300)}` : '';
        throw new CloudflareError(step, `HTTP ${res.status}：回應不是預期的 JSON${snippet}`, null);
      }
      const detail = describeCfErrors(parsed);
      const code = parsed.errors?.[0]?.code ?? null;
      throw new CloudflareError(step, `${explainCfError(code, detail)}\n\n(HTTP ${res.status})`, code);
    }
    return parsed.result;
  }

  return { call, token: clean };
}

/* ------------------------------------------------------------------ */
/* 個別步驟                                                             */
/* ------------------------------------------------------------------ */

export async function verifyToken(client) {
  const result = await client.call('驗證 Token', 'GET', '/user/tokens/verify');
  if (result?.status && result.status !== 'active') {
    throw new CloudflareError('驗證 Token', `Token 狀態為 ${result.status}，不是 active`);
  }
  return result;
}

/**
 * 用我們真正需要的權限去驗證，而不是用 /user/tokens/verify。
 *
 * 帳號層級的 Token 只給了 Workers Scripts 與 Workers KV 兩項權限時，
 * /user/ 底下的端點與列出帳號都未必有權限，拿它們當驗證會誤判成
 * 「Token 無效」，但那把 Token 其實部署得動。
 * 所以直接打列出 Worker 的端點：能過就代表權限夠。
 */
export async function verifyAccountAccess(client, accountId) {
  const scripts = await client.call(
    '確認權限', 'GET',
    `/accounts/${accountId}/workers/scripts`,
  );
  return (Array.isArray(scripts) ? scripts : []).map((s) => s.id).filter(Boolean);
}

export async function listAccounts(client) {
  const result = await client.call('讀取帳號', 'GET', '/accounts?per_page=50');
  const accounts = Array.isArray(result) ? result : [];
  if (!accounts.length) throw new CloudflareError('讀取帳號', '這個 Token 看不到任何帳號');
  return accounts.map((a) => ({ id: a.id, name: a.name }));
}

/** 找同名的 KV namespace，沒有就建一個 */
export async function ensureKvNamespace(client, accountId, title) {
  const existing = await client.call(
    '讀取 KV', 'GET',
    `/accounts/${accountId}/storage/kv/namespaces?per_page=100`,
  );
  const found = (Array.isArray(existing) ? existing : []).find((n) => n.title === title);
  if (found) return { id: found.id, created: false };

  const created = await client.call(
    '建立 KV', 'POST',
    `/accounts/${accountId}/storage/kv/namespaces`,
    { json: { title } },
  );
  if (!created?.id) throw new CloudflareError('建立 KV', 'Cloudflare 沒有回傳 namespace id');
  return { id: created.id, created: true };
}

/**
 * 組出上傳 Worker 用的 metadata。
 *
 * bindings 一次帶齊 KV 與所有機密。Cloudflare 的上傳是整份取代，
 * 沒有列進來的 binding 會消失，所以每次都要帶完整清單。
 */
export function buildMetadata({ mainModule, kvBindingName, kvNamespaceId, secrets, vars, compatibilityDate }) {
  const bindings = [];

  if (kvBindingName && kvNamespaceId) {
    bindings.push({ type: 'kv_namespace', name: kvBindingName, namespace_id: kvNamespaceId });
  }
  for (const [name, text] of Object.entries(secrets ?? {})) {
    if (typeof text === 'string' && text.length > 0) {
      bindings.push({ type: 'secret_text', name, text });
    }
  }
  for (const [name, text] of Object.entries(vars ?? {})) {
    if (typeof text === 'string' && text.length > 0) {
      bindings.push({ type: 'plain_text', name, text });
    }
  }

  return {
    main_module: mainModule,
    compatibility_date: compatibilityDate ?? '2025-01-01',
    bindings,
  };
}

/** 列出帳號上已經存在的 Worker 名稱 */
export async function listScripts(client, accountId) {
  return (await listScriptsDetailed(client, accountId)).map((s) => s.name);
}

/**
 * 連同建立與最後修改時間一起取回。
 *
 * 使用者常常分不清哪支 Worker 還在用。最後修改時間是最直接的線索：
 * 一年沒動過的多半已經沒在維護。
 */
export async function listScriptsDetailed(client, accountId) {
  const result = await client.call('讀取現有 Worker', 'GET', `/accounts/${accountId}/workers/scripts`);
  return (Array.isArray(result) ? result : [])
    .filter((s) => s && s.id)
    .map((s) => ({
      name: s.id,
      createdOn: s.created_on ?? null,
      modifiedOn: s.modified_on ?? null,
    }));
}

/** 距今多久，用中文粗略描述。無法判斷時回 null。 */
export function describeAge(iso, now = Date.now()) {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const days = Math.floor((now - t) / 86400000);
  if (days < 0) return null;
  if (days === 0) return '今天';
  if (days < 30) return `${days} 天前`;
  if (days < 365) return `${Math.floor(days / 30)} 個月前`;
  return `${Math.floor(days / 365)} 年前`;
}

/** 上傳 Worker。multipart 的組裝由宿主環境負責，這裡只給它需要的材料。 */
export async function uploadScript(client, accountId, scriptName, { metadata, script, mainModule, buildMultipart }) {
  const body = buildMultipart({
    metadata: JSON.stringify(metadata),
    script,
    mainModule,
  });
  return client.call(
    '上傳 Worker', 'PUT',
    `/accounts/${accountId}/workers/scripts/${encodeURIComponent(scriptName)}`,
    { body: body.body, headers: body.headers },
  );
}

/** 設定 cron 排程。整份取代。 */
export async function setSchedules(client, accountId, scriptName, crons) {
  return client.call(
    '設定排程', 'PUT',
    `/accounts/${accountId}/workers/scripts/${encodeURIComponent(scriptName)}/schedules`,
    { json: (crons ?? []).map((cron) => ({ cron })) },
  );
}

/** 讀取某支 Worker 目前的 cron 排程 */
export async function getSchedules(client, accountId, scriptName) {
  const result = await client.call(
    '讀取排程', 'GET',
    `/accounts/${accountId}/workers/scripts/${encodeURIComponent(scriptName)}/schedules`,
  );
  return (result?.schedules ?? []).map((s) => s.cron).filter(Boolean);
}

/**
 * 盤點整個帳號的 cron 用量。
 *
 * 免費方案每個帳號只有 5 個 cron 觸發器。用滿之後再設就會被拒，
 * 所以要能一眼看出是誰佔著。讀不到某支的排程就跳過，
 * 不讓單一支失敗擋掉整份盤點。
 */
export async function auditCrons(client, accountId, now = Date.now()) {
  const scripts = await listScriptsDetailed(client, accountId);
  const rows = [];
  let total = 0;
  for (const info of scripts) {
    const base = { script: info.name, modifiedOn: info.modifiedOn, age: describeAge(info.modifiedOn, now) };
    try {
      const crons = await getSchedules(client, accountId, info.name);
      rows.push({ ...base, crons });
      total += crons.length;
    } catch {
      rows.push({ ...base, crons: null });
    }
  }
  return { rows, total, limitFree: 5 };
}

/**
 * 清掉某支 Worker 的全部排程，釋出 cron 額度。
 *
 * 這是破壞性操作：那支 Worker 會停止自動執行。
 * 呼叫端必須先取得明確同意，本函式不做任何判斷。
 */
export async function clearSchedules(client, accountId, scriptName) {
  return client.call(
    '清除排程', 'PUT',
    `/accounts/${accountId}/workers/scripts/${encodeURIComponent(scriptName)}/schedules`,
    { json: [] },
  );
}

/** 這幾支是本工具自己部署的，釋出它們的排程沒有外部影響 */
export const OWN_SCRIPTS = Object.freeze(['crypto-radar-guardian', 'crypto-radar-watchdog']);

/**
 * 把盤點結果整理成「可以釋出哪些」的清單。
 *
 * 本工具自己部署的標成 own，其餘標成 foreign。
 * foreign 的可能正在跑別的事情（例如既有的交易系統），
 * 釋出前必須額外確認。
 */
export function freeableCrons(audit) {
  const out = [];
  for (const row of audit.rows ?? []) {
    if (!row.crons || row.crons.length === 0) continue;
    out.push({
      script: row.script,
      crons: row.crons,
      count: row.crons.length,
      origin: OWN_SCRIPTS.includes(row.script) ? 'own' : 'foreign',
      age: row.age ?? null,
      modifiedOn: row.modifiedOn ?? null,
    });
  }
  // 自己的排前面，比較不會誤刪別人的
  return out.sort((a, b) => (a.origin === b.origin ? 0 : a.origin === 'own' ? -1 : 1));
}

/** 判斷錯誤是不是撞到免費方案的 cron 上限 */
export function isCronLimitError(err) {
  if (!err) return false;
  return Number(err.code) === 10072 || /cron triggers per account/i.test(String(err.message ?? ''));
}

/** 開啟 workers.dev 網址 */
export async function enableSubdomain(client, accountId, scriptName) {
  return client.call(
    '開啟網址', 'POST',
    `/accounts/${accountId}/workers/scripts/${encodeURIComponent(scriptName)}/subdomain`,
    { json: { enabled: true } },
  );
}

/** 取得帳號的 workers.dev 子網域名稱，用來組出最終網址 */
export async function accountSubdomain(client, accountId) {
  const result = await client.call('讀取網域', 'GET', `/accounts/${accountId}/workers/subdomain`);
  return result?.subdomain ?? null;
}

export function workerUrl(scriptName, subdomain) {
  if (!subdomain) return null;
  return `https://${scriptName}.${subdomain}.workers.dev`;
}

/* ------------------------------------------------------------------ */
/* 完整流程                                                             */
/* ------------------------------------------------------------------ */

/**
 * 一次跑完部署。每一步都回報進度，任何一步失敗都會說清楚是哪一步。
 *
 * @param {object} options
 * @param {(msg: string) => void} options.onProgress
 */
export async function deployWorker({
  client, accountId, scriptName, script, mainModule = 'worker.js',
  kvBindingName, kvTitle, secrets, vars, crons, buildMultipart, onProgress, confirmReplace,
}) {
  const say = onProgress ?? (() => {});
  const steps = [];

  // 刻意不呼叫 /user/tokens/verify。帳號層級的 Token 未必有 /user/ 的權限，
  // 拿它當前置檢查會讓一把其實部署得動的 Token 被判成無效。
  // 後面列出 Worker 那一步用的正是我們真正需要的權限，等於同時完成驗證。
  let kvNamespaceId = null;
  if (kvBindingName && kvTitle) {
    say('準備 KV 儲存空間…');
    const kv = await ensureKvNamespace(client, accountId, kvTitle);
    kvNamespaceId = kv.id;
    steps.push(kv.created ? `已建立 KV「${kvTitle}」` : `沿用既有 KV「${kvTitle}」`);
  }

  // 上傳是整份取代：程式碼、KV 綁定、Secrets 全部以這次為準，
  // 沒帶到的就消失。所以覆蓋既有的 Worker 前一定要問過。
  say('檢查是否已存在同名 Worker…');
  const existing = await listScripts(client, accountId);
  const willReplace = existing.includes(scriptName);
  if (willReplace) {
    const approved = confirmReplace
      ? await confirmReplace({ scriptName, otherScripts: existing.filter((n) => n !== scriptName) })
      : false;
    if (!approved) {
      throw new CloudflareError('上傳 Worker', `帳號上已經有名為「${scriptName}」的 Worker，未取得覆蓋確認，已中止。`);
    }
  }

  say('上傳 Worker…');
  const metadata = buildMetadata({ mainModule, kvBindingName, kvNamespaceId, secrets, vars });
  await uploadScript(client, accountId, scriptName, { metadata, script, mainModule, buildMultipart });
  steps.push(`${willReplace ? '已覆蓋' : '已建立'} ${scriptName}（${Math.round(script.length / 1024)} KB）`);
  if (existing.length && !willReplace) {
    steps.push(`帳號上其他 ${existing.length} 支 Worker 未受影響`);
  }

  // 排程失敗不該讓整個部署算失敗：Worker 這時已經上傳好了，
  // 少的只是自動觸發。把它記成警告，讓呼叫端據實呈現。
  let scheduleError = null;
  if (crons && crons.length) {
    say('設定排程…');
    try {
      await setSchedules(client, accountId, scriptName, crons);
      steps.push(`排程 ${crons.join('、')}`);
    } catch (err) {
      scheduleError = err;
      steps.push('排程未設定');
    }
  }

  say('開啟網址…');
  await enableSubdomain(client, accountId, scriptName);
  const subdomain = await accountSubdomain(client, accountId);
  const url = workerUrl(scriptName, subdomain);
  steps.push(url ? `網址 ${url}` : '網址已開啟，但讀不到子網域名稱');

  return { url, steps, bindingCount: metadata.bindings.length, scheduleError };
}
