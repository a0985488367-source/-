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
  if (typeof token !== 'string' || token.trim().length === 0) {
    throw new Error('缺少 Cloudflare API Token');
  }
  const auth = { Authorization: `Bearer ${token.trim()}` };

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
      const raw = String(err?.message ?? err).split(token).join('[token]');
      throw new CloudflareError(step, `連線失敗：${raw}`);
    }

    let parsed = null;
    try {
      parsed = await res.json();
    } catch {
      parsed = null;
    }

    if (!parsed || parsed.success !== true) {
      const detail = describeCfErrors(parsed);
      const code = parsed?.errors?.[0]?.code ?? null;
      throw new CloudflareError(step, explainCfError(code, detail), code);
    }
    return parsed.result;
  }

  return { call, token: token.trim() };
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
  kvBindingName, kvTitle, secrets, vars, crons, buildMultipart, onProgress,
}) {
  const say = onProgress ?? (() => {});
  const steps = [];

  say('驗證 Token…');
  await verifyToken(client);
  steps.push('Token 有效');

  let kvNamespaceId = null;
  if (kvBindingName && kvTitle) {
    say('準備 KV 儲存空間…');
    const kv = await ensureKvNamespace(client, accountId, kvTitle);
    kvNamespaceId = kv.id;
    steps.push(kv.created ? `已建立 KV「${kvTitle}」` : `沿用既有 KV「${kvTitle}」`);
  }

  say('上傳 Worker…');
  const metadata = buildMetadata({ mainModule, kvBindingName, kvNamespaceId, secrets, vars });
  await uploadScript(client, accountId, scriptName, { metadata, script, mainModule, buildMultipart });
  steps.push(`已上傳 ${scriptName}（${Math.round(script.length / 1024)} KB）`);

  if (crons && crons.length) {
    say('設定排程…');
    await setSchedules(client, accountId, scriptName, crons);
    steps.push(`排程 ${crons.join('、')}`);
  }

  say('開啟網址…');
  await enableSubdomain(client, accountId, scriptName);
  const subdomain = await accountSubdomain(client, accountId);
  const url = workerUrl(scriptName, subdomain);
  steps.push(url ? `網址 ${url}` : '網址已開啟，但讀不到子網域名稱');

  return { url, steps, bindingCount: metadata.bindings.length };
}
