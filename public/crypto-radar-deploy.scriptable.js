// Crypto Radar — Cloudflare 部署工具 (Scriptable)
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

const CF_API = 'https://api.cloudflare.com/client/v4';

/** 建立 Token 需要的權限，顯示給使用者看 */
const REQUIRED_TOKEN_PERMISSIONS = Object.freeze([
  'Account → Workers Scripts → Edit',
  'Account → Workers KV Storage → Edit',
]);

/**
 * 清掉貼上時常夾帶的隱形字元。
 * 在 iPhone 上複製 Token 很容易帶到不斷行空格或零寬字元，
 * 而它們會讓認證失敗，錯誤訊息卻只說 invalid，非常難查。
 */
function sanitizeToken(value) {
  return String(value ?? '').replace(/[\s\u00A0\u200B-\u200D\u2060\uFEFF]/g, '');
}

/**
 * Token 格式的粗略檢查。
 *
 * 目的是在還沒發出請求前，先擋掉明顯複製錯的情況（例如整段說明文字
 * 都被貼進來）。只回報看起來哪裡不對，不保證格式對就一定能用。
 */
function inspectTokenShape(token) {
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

class CloudflareError extends Error {
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
function describeCfErrors(body) {
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
function explainCfError(code, message) {
  const c = Number(code);
  const raw = String(message ?? '未知錯誤');
  const hint = hintForCfError(c, raw);
  return hint ? `${raw}\n\n${hint}` : raw;
}

/** 回傳補充說明，沒把握就回 null，絕不亂猜 */
function hintForCfError(code, message) {
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
function makeClient(token, doFetch) {
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

async function verifyToken(client) {
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
async function verifyAccountAccess(client, accountId) {
  const scripts = await client.call(
    '確認權限', 'GET',
    `/accounts/${accountId}/workers/scripts`,
  );
  return (Array.isArray(scripts) ? scripts : []).map((s) => s.id).filter(Boolean);
}

async function listAccounts(client) {
  const result = await client.call('讀取帳號', 'GET', '/accounts?per_page=50');
  const accounts = Array.isArray(result) ? result : [];
  if (!accounts.length) throw new CloudflareError('讀取帳號', '這個 Token 看不到任何帳號');
  return accounts.map((a) => ({ id: a.id, name: a.name }));
}

/** 找同名的 KV namespace，沒有就建一個 */
async function ensureKvNamespace(client, accountId, title) {
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
function buildMetadata({ mainModule, kvBindingName, kvNamespaceId, secrets, vars, compatibilityDate }) {
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
async function listScripts(client, accountId) {
  const result = await client.call('讀取現有 Worker', 'GET', `/accounts/${accountId}/workers/scripts`);
  return (Array.isArray(result) ? result : []).map((s) => s.id).filter(Boolean);
}

/** 上傳 Worker。multipart 的組裝由宿主環境負責，這裡只給它需要的材料。 */
async function uploadScript(client, accountId, scriptName, { metadata, script, mainModule, buildMultipart }) {
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
async function setSchedules(client, accountId, scriptName, crons) {
  return client.call(
    '設定排程', 'PUT',
    `/accounts/${accountId}/workers/scripts/${encodeURIComponent(scriptName)}/schedules`,
    { json: (crons ?? []).map((cron) => ({ cron })) },
  );
}

/** 讀取某支 Worker 目前的 cron 排程 */
async function getSchedules(client, accountId, scriptName) {
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
async function auditCrons(client, accountId) {
  const scripts = await listScripts(client, accountId);
  const rows = [];
  let total = 0;
  for (const name of scripts) {
    try {
      const crons = await getSchedules(client, accountId, name);
      rows.push({ script: name, crons });
      total += crons.length;
    } catch {
      rows.push({ script: name, crons: null });
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
async function clearSchedules(client, accountId, scriptName) {
  return client.call(
    '清除排程', 'PUT',
    `/accounts/${accountId}/workers/scripts/${encodeURIComponent(scriptName)}/schedules`,
    { json: [] },
  );
}

/** 這幾支是本工具自己部署的，釋出它們的排程沒有外部影響 */
const OWN_SCRIPTS = Object.freeze(['crypto-radar-guardian', 'crypto-radar-watchdog']);

/**
 * 把盤點結果整理成「可以釋出哪些」的清單。
 *
 * 本工具自己部署的標成 own，其餘標成 foreign。
 * foreign 的可能正在跑別的事情（例如既有的交易系統），
 * 釋出前必須額外確認。
 */
function freeableCrons(audit) {
  const out = [];
  for (const row of audit.rows ?? []) {
    if (!row.crons || row.crons.length === 0) continue;
    out.push({
      script: row.script,
      crons: row.crons,
      count: row.crons.length,
      origin: OWN_SCRIPTS.includes(row.script) ? 'own' : 'foreign',
    });
  }
  // 自己的排前面，比較不會誤刪別人的
  return out.sort((a, b) => (a.origin === b.origin ? 0 : a.origin === 'own' ? -1 : 1));
}

/** 判斷錯誤是不是撞到免費方案的 cron 上限 */
function isCronLimitError(err) {
  if (!err) return false;
  return Number(err.code) === 10072 || /cron triggers per account/i.test(String(err.message ?? ''));
}

/** 開啟 workers.dev 網址 */
async function enableSubdomain(client, accountId, scriptName) {
  return client.call(
    '開啟網址', 'POST',
    `/accounts/${accountId}/workers/scripts/${encodeURIComponent(scriptName)}/subdomain`,
    { json: { enabled: true } },
  );
}

/** 取得帳號的 workers.dev 子網域名稱，用來組出最終網址 */
async function accountSubdomain(client, accountId) {
  const result = await client.call('讀取網域', 'GET', `/accounts/${accountId}/workers/subdomain`);
  return result?.subdomain ?? null;
}

function workerUrl(scriptName, subdomain) {
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
async function deployWorker({
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

/* ============================================================
   Scriptable 接線
   ============================================================ */

/* ================= 內嵌的 Worker 程式碼 ================= */

const GUARDIAN_SCRIPT = "const Ne=Object.freeze([\"live\",\"demo\",\"testnet\"]),Q=Object.freeze({live:\"\\u6B63\\u5F0F\\u7AD9\",demo:\"\\u6A21\\u64EC\\u4EA4\\u6613 Demo\",testnet:\"\\u6E2C\\u8A66\\u7DB2 Testnet\"}),we=Object.freeze({live:\"https://api.bybit.com\",demo:\"https://api-demo.bybit.com\",testnet:\"https://api-testnet.bybit.com\"}),ee=Object.freeze({live:\"https://api.bybit.com\",demo:\"https://api.bybit.com\",testnet:\"https://api-testnet.byb\\\nit.com\"}),te=ee.live;function _(e){return Ne.includes(e)?e:\"live\"}function Se(e){return we[_(e)]}function $e(e){return ee[_(e)]}function R(e){return String(e??\"\").replace(/[\\s\\u00A0\\u200B-\\u200D\\u2060\\uFEFF]/g,\"\")}function ne(e,t,n){const s=Number(e),i=Q[_(n)],r=t?`\\uFF08${t}\\uFF09`:\"\";return s===10003?`\\u76EE\\u524D\\u9023\\u7684\\u662F\\u300C${i}\\u300D\\uFF0C\\u4F46\\u9019\\u500B\\u74B0\\u5883\\u4E0D\\u8A8D\\u5F97\\u9019\\u628A API Key${r}\\\n\\u3002\n\n\\u6700\\u5E38\\u898B\\u7684\\u539F\\u56E0\\u662F\\u74B0\\u5883\\u9078\\u932F\\uFF1A\\u6A21\\u64EC\\u4EA4\\u6613\\u8207\\u6E2C\\u8A66\\u7DB2\\u5404\\u81EA\\u767C\\u81EA\\u5DF1\\u7684 Key\\uFF0C\\u4E0D\\u80FD\\u62FF\\u53BB\\u6253\\u6B63\\u5F0F\\u7AD9\\u3002\n\\u8ACB\\u78BA\\u8A8D\\u4F60\\u7684 Key \\u662F\\u5728\\u54EA\\u88E1\\u5EFA\\u7ACB\\u7684\\uFF0C\\u56DE\\u8A2D\\u5B9A\\u9078\\u55AE\\u6539\\u9078\\u5C0D\\u61C9\\u7684\\u74B0\\u5883\\u3002\n\\u82E5\\u74B0\\u5883\\u6C92\\u9078\\u932F\\uFF0C\\u8ACB\\u6AA2\\u67E5 Key \\u662F\\u5426\\u6709\\u591A\\u6253\\u6216\\u6F0F\\u6253\\u5B57\\u5143\\u3001\\u662F\\u5426\\u5DF2\\u88AB\\u522A\\u9664\\u6216\\u904E\\u671F\\u3002`:s===10004?`\\u7C3D\\u7AE0\\u9A57\\u8B49\\u5931\\u6557${r}\\u3002\\u8ACB\\u78BA\\u8A8D API Secret \\u6709\\u6C92\\u6709\\u8CBC\\u932F\\u6216\\u8CBC\\u4E0D\\u5B8C\\u6574\\u3002`:s===10002?`\\u6642\\u9593\\u6233\\u8D85\\u51FA\\u5BB9\\u8A31\\u7BC4\\u570D${r}\\\n\\u3002\\u8ACB\\u5230 iPhone \\u8A2D\\u5B9A \\u2192 \\u4E00\\u822C \\u2192 \\u65E5\\u671F\\u8207\\u6642\\u9593\\uFF0C\\u958B\\u555F\\u300C\\u81EA\\u52D5\\u8A2D\\u5B9A\\u300D\\u3002`:s===10005||s===10016?`\\u9019\\u628A Key \\u6C92\\u6709\\u8B80\\u53D6\\u6B0A\\u9650${r}\\u3002\\u8ACB\\u5728 Bybit \\u7D66\\u5B83\\u300C\\u5E33\\u6236\\u67E5\\u8A62\\u300D\\u8207\\u300C\\u6301\\u5009\\u67E5\\u8A62\\u300D\\u7684\\u552F\\u8B80\\u6B0A\\u9650\\u3002`:s===10010?\n`\\u9019\\u628A Key \\u8A2D\\u4E86 IP \\u767D\\u540D\\u55AE\\uFF0C\\u4F46\\u76EE\\u524D\\u7684\\u7DB2\\u8DEF\\u4E0D\\u5728\\u540D\\u55AE\\u5167${r}\\u3002\n\\u624B\\u6A5F\\u7684 IP \\u6703\\u8B8A\\u52D5\\uFF0C\\u5EFA\\u8B70\\u6539\\u7528\\u4E0D\\u7D81 IP \\u7684\\u552F\\u8B80 Key\\uFF0C\\u6216\\u628A\\u76EE\\u524D IP \\u52A0\\u9032\\u767D\\u540D\\u55AE\\u3002`:s===10018?`\\u8ACB\\u6C42\\u983B\\u7387\\u904E\\u9AD8${r}\\u3002\\u8ACB\\u7A0D\\u7B49\\u4E00\\u4E0B\\u518D\\u8A66\\u3002`:s===30086||s===3400026?`\\u5E33\\u6236\\u985E\\u578B\\u4E0D\\u7B26${r}\\u3002\\u9019\\u500B\\u67E5\\u8A62\\u9700\\u8981\\u7D71\\u4E00\\u5E33\\u6236\\uFF08Unified Trading Account\\uFF09\\u3002`:\n`Bybit retCode ${e}${r}`}function K(e){return Number.isFinite(e)?e>=1e3?1:e>=10?3:e>=1?4:e>=.01?5:7:4}const b=(e,t)=>Number.isFinite(e)?e.toFixed(t??4):\"\\u2014\",U=e=>Number.isFinite(e)?(e>=0?\"+\":\"\")+e.toFixed(2)+\"%\":\"\\u2014\",L=e=>Number.isFinite(e)?(e>=0?\"\":\"-\")+Math.abs(e).toFixed(2):\"\\u2014\";function X(e){return!Number.isFinite(e)||e<=0?\"\\u2014\":e>=1e9?(e/1e9).toFixed(2)+\"B\":e>=1e6?(e/1e6).toFixed(\n2)+\"M\":e>=1e3?(e/1e3).toFixed(1)+\"K\":e.toFixed(0)}const D=e=>Number.isFinite(e)?e>=0?\"pos\":\"neg\":\"\";function ke(e,t){if(!e)return\"\\u5C1A\\u672A\\u6383\\u63CF\";const n=Math.max(0,Math.round(((t??Date.now())-e)/1e3));return n<60?n+\" \\u79D2\\u524D\":Math.round(n/60)+\" \\u5206\\u9418\\u524D\"}const Ce=new Uint32Array([1116352408,1899447441,3049323471,3921009573,961987163,1508970993,2453635748,2870763221,3624381080,\n310598401,607225278,1426881987,1925078388,2162078206,2614888103,3248222580,3835390401,4022224774,264347078,604807628,770255983,1249150122,1555081692,1996064986,2554220882,2821834349,2952996808,3210313671,3336571891,3584528711,113926993,338241895,666307205,773529912,1294757372,1396182291,1695183700,1986661051,2177026350,2456956037,2730485921,2820302411,3259730800,3345764771,3516065817,3600352804,4094571909,\n275423344,430227734,506948616,659060556,883997877,958139571,1322822218,1537002063,1747873779,1955562222,2024104815,2227730452,2361852424,2428436474,2756734187,3204031479,3329325298]),$=(e,t)=>(e>>>t|e<<32-t)>>>0;function Y(e){const t=new Uint32Array([1779033703,3144134277,1013904242,2773480762,1359893119,2600822924,528734635,1541459225]),n=e.length*8,s=new Uint8Array((e.length+8>>6)+1<<6);s.set(e),\ns[e.length]=128;const i=Math.floor(n/4294967296),r=n>>>0,a=new DataView(s.buffer);a.setUint32(s.length-8,i,!1),a.setUint32(s.length-4,r,!1);const o=new Uint32Array(64);for(let u=0;u<s.length;u+=64){for(let m=0;m<16;m+=1)o[m]=a.getUint32(u+m*4,!1);for(let m=16;m<64;m+=1){const I=($(o[m-15],7)^$(o[m-15],18)^o[m-15]>>>3)>>>0,O=($(o[m-2],17)^$(o[m-2],19)^o[m-2]>>>10)>>>0;o[m]=o[m-16]+I+o[m-7]+O>>>0}let[\nl,f,p,h,P,w,S,T]=t;for(let m=0;m<64;m+=1){const I=($(P,6)^$(P,11)^$(P,25))>>>0,O=(P&w^~P&S)>>>0,M=T+I+O+Ce[m]+o[m]>>>0,W=($(l,2)^$(l,13)^$(l,22))>>>0,v=(l&f^l&p^f&p)>>>0,j=W+v>>>0;T=S,S=w,w=P,P=h+M>>>0,h=p,p=f,f=l,l=M+j>>>0}t[0]=t[0]+l>>>0,t[1]=t[1]+f>>>0,t[2]=t[2]+p>>>0,t[3]=t[3]+h>>>0,t[4]=t[4]+P>>>0,t[5]=t[5]+w>>>0,t[6]=t[6]+S>>>0,t[7]=t[7]+T>>>0}const c=new Uint8Array(32),d=new DataView(c.buffer);\nfor(let u=0;u<8;u+=1)d.setUint32(u*4,t[u],!1);return c}function se(e){const t=String(e),n=[];for(let s=0;s<t.length;s+=1){let i=t.charCodeAt(s);if(i>=55296&&i<=56319&&s+1<t.length){const r=t.charCodeAt(s+1);r>=56320&&r<=57343&&(i=65536+(i-55296<<10)+(r-56320),s+=1)}i<128?n.push(i):i<2048?n.push(192|i>>6,128|i&63):i<65536?n.push(224|i>>12,128|i>>6&63,128|i&63):n.push(240|i>>18,128|i>>12&63,128|i>>6&\n63,128|i&63)}return new Uint8Array(n)}function Ae(e){let t=\"\";for(let n=0;n<e.length;n+=1)t+=e[n].toString(16).padStart(2,\"0\");return t}function zt(e){const t=String(e).trim(),n=new Uint8Array(t.length/2);for(let s=0;s<n.length;s+=1)n[s]=parseInt(t.substr(s*2,2),16);return n}const A=64;function Ee(e,t){let n=typeof e==\"string\"?se(e):e;const s=typeof t==\"string\"?se(t):t;n.length>A&&(n=Y(n));const i=new Uint8Array(\nA);i.set(n);const r=new Uint8Array(A+s.length),a=new Uint8Array(A);for(let d=0;d<A;d+=1)r[d]=i[d]^54,a[d]=i[d]^92;r.set(s,A);const o=Y(r),c=new Uint8Array(A+32);return c.set(a),c.set(o,A),Y(c)}function Te(e,t){return Ae(Ee(e,t))}const Re=\"5000\",Ue=Object.freeze([\"/v5/account/wallet-balance\",\"/v5/position/list\",\"/v5/position/closed-pnl\",\"/v5/execution/list\",\"/v5/order/realtime\"]),De=[/\\/order\\/create/i,\n/\\/order\\/amend/i,/\\/order\\/cancel/i,/\\/order\\/disconnected/i,/\\/position\\/set-/i,/\\/position\\/trading-stop/i,/\\/position\\/switch/i,/\\/asset\\/transfer/i,/\\/asset\\/withdraw/i,/\\/account\\/upgrade/i,/\\/account\\/set-/i,/\\/user\\//i];class ie extends Error{constructor(t){super(`\\u7AEF\\u9EDE\\u4E0D\\u5728\\u552F\\u8B80\\u767D\\u540D\\u55AE\\u5167\\uFF0C\\u62D2\\u7D55\\u547C\\u53EB\\uFF1A${t}`),this.name=\"ForbiddenEndp\\\nointError\"}}function Fe(e){const t=String(e).split(\"?\")[0];for(const n of De)if(n.test(t))throw new ie(t);if(!Ue.includes(t))throw new ie(t);return t}function Ie(e){return Object.keys(e??{}).filter(n=>{const s=e[n];return s!=null&&s!==\"\"}).map(n=>`${encodeURIComponent(n)}=${encodeURIComponent(String(e[n]))}`).join(\"&\")}function Me({path:e,params:t,apiKey:n,apiSecret:s,timestamp:i,recvWindow:r,env:a}){\nconst o=Fe(e);if(typeof n!=\"string\"||n.length===0)throw new Error(\"\\u7F3A\\u5C11 API Key\");if(typeof s!=\"string\"||s.length===0)throw new Error(\"\\u7F3A\\u5C11 API Secret\");const c=String(i??Date.now()),d=String(r??Re),u=Ie(t),l=c+n+d+u,f=Te(s,l);return{url:(a?Se(a):te)+o+(u?`?${u}`:\"\"),queryString:u,headers:{\"X-BAPI-API-KEY\":n,\"X-BAPI-TIMESTAMP\":c,\"X-BAPI-RECV-WINDOW\":d,\"X-BAPI-SIGN\":f,\"X-BAPI-SIGN-T\\\nYPE\":\"2\",accept:\"application/json\"}}}const x=e=>{const t=typeof e==\"number\"?e:Number(e);return Number.isFinite(t)?t:NaN};function Be(e){const t=e?.list?.[0];if(!t)return null;const n=(t.coin??[]).find(s=>s.coin===\"USDT\");return{accountType:t.accountType??null,totalEquityUsd:x(t.totalEquity),totalAvailableUsd:x(t.totalAvailableBalance),unrealizedPnlUsd:x(t.totalPerpUPL),usdtEquity:n?x(n.equity):NaN,\nusdtAvailable:n?x(n.availableToWithdraw??n.walletBalance):NaN}}function Oe(e){return(e?.list??[]).map(t=>({symbol:t.symbol,side:t.side===\"Buy\"?\"long\":t.side===\"Sell\"?\"short\":null,size:x(t.size),entryPrice:x(t.avgPrice),markPrice:x(t.markPrice),leverage:x(t.leverage),unrealizedPnl:x(t.unrealisedPnl),positionValue:x(t.positionValue),takeProfit:x(t.takeProfit),stopLoss:x(t.stopLoss),liqPrice:x(t.liqPrice)})).\nfilter(t=>Number.isFinite(t.size)&&t.size>0)}function _e(e){return(e?.list??[]).map(t=>({symbol:t.symbol,side:t.side===\"Buy\"?\"short\":\"long\",closedPnl:x(t.closedPnl),avgEntryPrice:x(t.avgEntryPrice),avgExitPrice:x(t.avgExitPrice),closedSize:x(t.closedSize),leverage:x(t.leverage),createdTime:x(t.createdTime)}))}function Le(e){const t=Number.isFinite(e.takeProfit)&&e.takeProfit>0,n=Number.isFinite(e.\nstopLoss)&&e.stopLoss>0;return t&&n?{level:\"ok\",text:\"TP\\uFF0FSL \\u7686\\u5DF2\\u8A2D\\u5B9A\"}:n?{level:\"warn\",text:\"\\u53EA\\u6709 SL\\uFF0C\\u7F3A TP\"}:t?{level:\"danger\",text:\"\\u53EA\\u6709 TP\\uFF0C\\u7F3A SL\"}:{level:\"danger\",text:\"\\u6C92\\u6709 TP \\u4E5F\\u6C92\\u6709 SL\"}}function ze(e,t){const n=(e??[]).filter(s=>Number.isFinite(s.createdTime)&&s.createdTime>=t);return n.length?{total:n.reduce((s,i)=>s+\n(Number.isFinite(i.closedPnl)?i.closedPnl:0),0),count:n.length}:{total:0,count:0}}function re(e){const t=String(e??\"\");return t.length<=8?\"\\u2022\\u2022\\u2022\\u2022\":`${t.slice(0,4)}\\u2022\\u2022\\u2022\\u2022${t.slice(-4)}`}const He=/^https:\\/\\/(?:\\w+\\.)?discord(?:app)?\\.com\\/api\\/webhooks\\/\\d+\\/[\\w-]+$/;function ae(e){return typeof e==\"string\"&&He.test(e.trim())}function Ht(e){if(typeof e!=\"string\"||\n!e)return\"\\u672A\\u8A2D\\u5B9A\";const t=/\\/webhooks\\/(\\d+)\\//.exec(e);return t?`Webhook \\u2022\\u2022\\u2022\\u2022${t[1].slice(-4)}`:\"Webhook \\u2022\\u2022\\u2022\\u2022\"}function je(e){const t=K(e.lastPrice),n=e.isMeme?\"\\u8FF7\\u56E0\\u5E63\\uFF0F\\u9AD8\\u98A8\\u96AA\":\"\\u4E3B\\u5E63\",s=[`**${e.symbol}** \\xB7 ${n} \\xB7 \\u5B8C\\u6210\\u5EA6 ${e.score}`,`\\u9032\\u5834\\u689D\\u4EF6 ${e.readiness.passed}/${e.readiness.\ntotal} \\u5DF2\\u901A\\u904E`,\"\",`Entry\\u3000${b(e.entryLow,t)} \\u2013 ${b(e.entryHigh,t)}`,`SL\\u3000\\u3000${b(e.stopLoss,t)}`,`TP1\\u3000 ${b(e.takeProfit1,t)}\\u3000(1.5R)`,`TP2\\u3000 ${b(e.takeProfit2,t)}\\u3000(2.5R)`,\"\",`\\u8DDD\\u7A81\\u7834\\u9EDE ${U(e.breakoutDistancePct)}\\u3000\\u58D3\\u7E2E\\u6BD4 ${b(e.compressionRatio,3)}`,`\\u91CF\\u80FD ${b(e.volumeMultiple,2)}x\\u3000OI ${U(e.oiChangePct)}`];return e.\nriskLabel&&s.push(\"\",`\\u26A0 ${e.riskLabel}`),s.push(\"\",\"\\u5B8C\\u6210\\u5EA6\\u4E0D\\u662F\\u52DD\\u7387\\u3002\\u9019\\u662F\\u6383\\u63CF\\u7D50\\u679C\\uFF0C\\u4E0D\\u662F\\u6295\\u8CC7\\u5EFA\\u8B70\\uFF0C\\u4E5F\\u4E0D\\u6703\\u81EA\\u52D5\\u4E0B\\u55AE\\u3002\"),s.push(e.bybitUrl),s.join(`\n`)}function jt(e){const t=new Date(e.scannedAt).toISOString().replace(\"T\",\" \").slice(0,16);if(!e.ready.length)return`**Crypto Radar \\u6383\\u63CF\\u5B8C\\u6210** \\xB7 ${t} UTC\n\\u4E3B\\u5E63 ${e.mainCount} \\u6A94\\u3001\\u8FF7\\u56E0\\u5E63 ${e.memeCount} \\u6A94\\u5DF2\\u5206\\u6790\\uFF0C\\u76EE\\u524D\\u6C92\\u6709\\u7B26\\u5408\\u5168\\u90E8\\u9032\\u5834\\u689D\\u4EF6\\u7684\\u5019\\u9078\\u3002`;const n=e.ready.map(s=>`${s.symbol}(${s.score})`).join(\"\\u3001\");return`**Crypto Radar \\u6383\\u63CF\\u5B8C\\u6210** \\xB7 ${t} UTC\n\\u7B26\\u5408\\u5168\\u90E8\\u9032\\u5834\\u689D\\u4EF6\\uFF1A${n}\n\\u5B8C\\u6210\\u5EA6\\u4E0D\\u662F\\u52DD\\u7387\\uFF0C\\u8ACB\\u81EA\\u884C\\u78BA\\u8A8D\\u98A8\\u96AA\\u3002`}function Ke(e){const t=e.filter(s=>s.protection&&s.protection.level!==\"ok\");if(!t.length)return null;const n=[\"**\\u6301\\u5009\\u4FDD\\u8B77\\u6AA2\\u67E5**\",\"\"];for(const s of t)n.push(`${s.symbol} ${s.side===\"long\"?\"\\u591A\":\"\\u7A7A\"}\\u3000${s.protection.text}`);return n.push(\"\",\"\\u9019\\u662F\\u552F\\u8B80\\u6AA2\\u67E5\\uFF0C\\u672C\\u5DE5\\u5177\\u4E0D\\u6703\\u66FF\\u4F60\\u639B\\u55AE\\u6216\\u5E73\\u5009\\u3002\"),\nn.join(`\n`)}function Kt(){return`**Crypto Radar** \\u901A\\u77E5\\u6E2C\\u8A66\\u6210\\u529F\\u3002\n\\u672C\\u5DE5\\u5177\\u53EA\\u8B80\\u53D6 Bybit \\u516C\\u958B\\u884C\\u60C5\\u8207\\u552F\\u8B80\\u5E33\\u6236\\u8CC7\\u6599\\uFF0C\\u4E0D\\u6703\\u4E0B\\u55AE\\u3002`}function Ve(e){return`${e.symbol}:${e.entryReady?\"ready\":\"watch\"}:${e.stage}`}function Ge(e,t,n,s=60){const i={...t?.sent??{}},r=s*6e4,a=[];for(const o of e??[]){const c=Ve(o),d=i[c];(!Number.isFinite(d)||n-d>=r)&&(a.push(o),i[c]=n)}for(const o of Object.\nkeys(i))n-i[o]>864e5&&delete i[o];return{toSend:a,state:{sent:i,lastSentAt:a.length?n:t?.lastSentAt??null}}}const oe=1900;function We(e){const t=String(e??\"\");return{content:t.length>oe?`${t.slice(0,oe)}\\u2026`:t,allowed_mentions:{parse:[]}}}async function ce(e,t,n){if(!ae(t))return{ok:!1,error:\"Webhook \\u7DB2\\u5740\\u683C\\u5F0F\\u4E0D\\u6B63\\u78BA\"};try{return await e(t,We(n)),{ok:!0,error:null}}catch(s){\nreturn{ok:!1,error:String(s&&s.message?s.message:s).split(t).join(\"[webhook]\")}}}const le=\"Bybit Pre-Breakout\",Xe=\"10.0-standalone\",k=Object.freeze({minTurnover24hUsd:5e5,minOpenInterestUsd:1e5,minListedHours:24,maxListedHours:24*365*3,maxSpreadPct:.6,minChange24hPct:-12,maxChange24hPct:10,minRangePosition:.35,maxRangePosition:.96,maxDetailedAnalysis:12}),N=Object.freeze({maxChange24hPct:10,maxChange1hPct:4,\nmaxChange6hPct:10,maxBreakoutOvershootPct:.8,maxVolumeMultiple:5,maxBreakoutDistancePct:4,maxCompressionRatio:1.2,maxAbsFundingRatePct:.15}),g=Object.freeze({minScore:80,minBreakoutDistancePct:-.25,maxBreakoutDistancePct:2,maxCompressionRatio:.95,minVolumeMultiple:1.1,maxVolumeMultiple:3,minOiChangePct:.25,maxOiChangePct:5,minChange1hPct:-1,maxChange1hPct:2.5,minChange6hPct:-3,maxChange6hPct:6,maxDataAgeMinutes:45,\nstaleWarningMinutes:15}),ue=8,Ye=Object.freeze([\"PEPE\",\"DOGE\",\"SHIB\",\"WIF\",\"BONK\",\"FLOKI\",\"TRUMP\"]),Je=Object.freeze([\"BTC\",\"ETH\",\"SOL\",\"BNB\",\"XRP\",\"ADA\",\"AVAX\",\"LINK\",\"LTC\",\"DOT\",\"ATOM\",\"ARB\",\"OP\",\"MATIC\",\"TON\",\"TRX\",\"NEAR\",\"APT\",\"SUI\",\"INJ\",\"FIL\",\"ETC\",\"BCH\",\"UNI\",\"AAVE\",\"XLM\",\"ICP\",\"HBAR\",\"VET\",\"ALGO\"]),qe=.15,J=Object.freeze([\"BTCUSDT\",\"ETHUSDT\",\"SOLUSDT\"]);function Ze(e,t,n){return(n??J).includes(\nString(e).toUpperCase())?\"main\":t?\"meme\":\"main\"}const Qe=new Set([\"USDC\",\"USDT\",\"DAI\",\"TUSD\",\"FDUSD\",\"USDE\",\"PYUSD\",\"BUSD\",\"USDD\"]),y=e=>{const t=typeof e==\"number\"?e:Number(e);return Number.isFinite(t)?t:NaN},V=e=>e.length?e.reduce((t,n)=>t+n,0)/e.length:NaN;function de(e){return String(e).toUpperCase().replace(/USDT$/,\"\").replace(/^(1000000|10000|1000)/,\"\")}function et(e){return`https://www.bybi\\\nt.com/trade/usdt/${encodeURIComponent(String(e).toUpperCase())}`}function tt(e,t,n,s){const i=de(e);if(Ye.includes(i))return{isMeme:!0,confidence:\"high\",reasons:[`${i} \\u5728\\u660E\\u78BA\\u8FF7\\u56E0\\u5E63\\u6E05\\u55AE\\u5167`]};if(Je.includes(i))return{isMeme:!1,confidence:\"high\",reasons:[`${i} \\u5728\\u4E3B\\u6D41\\u6A19\\u7684\\u6E05\\u55AE\\u5167`]};const r=[];return/^(1000000|10000|1000)[A-Z]/.test(String(\ne).toUpperCase())&&r.push(\"\\u5E36\\u6709\\u9762\\u984D\\u524D\\u7DB4\\uFF0C\\u5C6C\\u6975\\u4F4E\\u55AE\\u50F9\\u6A19\\u7684\"),Number.isFinite(t)&&t<180&&r.push(`\\u4E0A\\u7DDA\\u50C5 ${Math.round(t)} \\u5929`),Number.isFinite(n)&&Number.isFinite(s)&&s>0&&n/s>8&&r.push(`\\u6210\\u4EA4\\u984D\\u70BA\\u672A\\u5E73\\u5009\\u503C\\u7684 ${(n/s).toFixed(1)} \\u500D`),r.length>=2?{isMeme:!0,confidence:\"medium\",reasons:r}:r.length===\n1?{isMeme:!0,confidence:\"low\",reasons:r}:{isMeme:!0,confidence:\"low\",reasons:[`${i} \\u4E0D\\u5728\\u5DF2\\u77E5\\u4E3B\\u6D41\\u6E05\\u55AE\\u5167\\uFF0C\\u4F9D\\u4FDD\\u5B88\\u539F\\u5247\\u5957\\u7528\\u76F8\\u540C\\u98A8\\u63A7`]}}function nt(e){return e.isMeme?e.confidence===\"high\"?\"\\u8FF7\\u56E0\\u5E63 \\xB7 \\u56FA\\u5B9A 0.15% \\u9632\\u5B88\\u5009\":e.confidence===\"medium\"?\"\\u7591\\u4F3C\\u8FF7\\u56E0\\u5E63 \\xB7 \\u4FDD\\u5B88 0.15% \\u5009\\u4F4D\":\n\"\\u672A\\u5217\\u5165\\u4E3B\\u6D41 \\xB7 \\u4FDD\\u5B88 0.15% \\u5009\\u4F4D\":null}function st(e,t,n=Date.now()){const s=new Map;for(const r of t??[])s.set(r.symbol,r);const i=[];for(const r of e??[]){if(r.status&&r.status!==\"Trading\"||r.quoteCoin!==\"USDT\"||r.contractType&&!/LinearPerpetual/i.test(r.contractType)||Qe.has(de(r.symbol)))continue;const a=s.get(r.symbol);if(!a)continue;const o=y(a.lastPrice),\nc=y(a.bid1Price),d=y(a.ask1Price),u=y(a.highPrice24h),l=y(a.lowPrice24h),f=y(a.turnover24h),p=y(a.openInterestValue),h=y(a.price24hPcnt)*100,P=y(a.fundingRate)*100,w=y(r.launchTime);if(!Number.isFinite(o)||o<=0)continue;const S=Number.isFinite(c)&&Number.isFinite(d)&&c>0&&d>0?(d-c)/((d+c)/2)*100:NaN,T=Number.isFinite(u)&&Number.isFinite(l)&&u>l?(o-l)/(u-l):NaN,m=Number.isFinite(w)&&w>0?(n-w)/36e5:\nNaN;i.push({symbol:r.symbol,lastPrice:o,turnover24hUsd:f,openInterestUsd:p,listedHours:m,listedDays:Number.isFinite(m)?m/24:NaN,spreadPct:S,change24hPct:h,rangePosition24h:T,fundingRatePct:P,high24h:u,low24h:l})}return i}function q(e){return Number.isFinite(e.turnover24hUsd)&&e.turnover24hUsd>=k.minTurnover24hUsd&&Number.isFinite(e.openInterestUsd)&&e.openInterestUsd>=k.minOpenInterestUsd&&Number.\nisFinite(e.listedHours)&&e.listedHours>=k.minListedHours&&e.listedHours<=k.maxListedHours&&Number.isFinite(e.spreadPct)&&e.spreadPct<=k.maxSpreadPct&&Number.isFinite(e.change24hPct)&&e.change24hPct>=k.minChange24hPct&&e.change24hPct<=k.maxChange24hPct&&Number.isFinite(e.rangePosition24h)&&e.rangePosition24h>=k.minRangePosition&&e.rangePosition24h<=k.maxRangePosition}function pe(e){return[...e].sort(\n(t,n)=>{const s=i=>i.rangePosition24h*.7+Math.min(1,Math.log10(Math.max(i.turnover24hUsd,1))/9)*.3;return s(n)-s(t)}).slice(0,k.maxDetailedAnalysis)}function Vt(e,t){const n=(t??J).map(o=>o.toUpperCase()),s=new Map;for(const o of e??[])s.set(String(o.symbol).toUpperCase(),o);const i=[];for(const o of n){const c=s.get(o);c&&i.push(c)}const r=(e??[]).filter(o=>!n.includes(String(o.symbol).toUpperCase())),\na=pe(r.filter(q));return{main:i,scan:a,all:[...i,...a]}}function it(e){return(e??[]).map(t=>({t:y(t[0]),open:y(t[1]),high:y(t[2]),low:y(t[3]),close:y(t[4]),volume:y(t[5])})).filter(t=>Number.isFinite(t.close)&&Number.isFinite(t.high)&&Number.isFinite(t.low)).sort((t,n)=>t.t-n.t)}function rt(e){return(e??[]).map(t=>({t:y(t.timestamp),oi:y(t.openInterest)})).filter(t=>Number.isFinite(t.oi)).sort((t,n)=>t.\nt-n.t)}function at(e,t){const n=e.length,s=e[n-1],i=v=>n-1-v>=0?e[n-1-v].close:NaN,r=(v,j)=>Number.isFinite(v)&&v>0&&Number.isFinite(j)?(j-v)/v*100:NaN,a=r(i(4),s?.close),o=r(i(24),s?.close),c=e.map(v=>(v.high-v.low)/(v.close||1)),d=V(c.slice(-8)),u=V(c.slice(-32,-8)),l=Number.isFinite(d)&&Number.isFinite(u)&&u>0?d/u:NaN,f=e.map(v=>v.volume).filter(Number.isFinite),p=V(f.slice(-3)),h=V(f.slice(-23,\n-3)),P=Number.isFinite(p)&&Number.isFinite(h)&&h>0?p/h:NaN,w=e.slice(0,Math.max(0,n-2)).map(v=>v.high).filter(Number.isFinite),S=w.length?Math.max(...w):NaN,T=Number.isFinite(S)&&Number.isFinite(s?.close)&&s.close>0?(S-s.close)/s.close*100:NaN,m=t[0]?.oi,I=t[t.length-1]?.oi,O=Number.isFinite(m)&&m>0&&Number.isFinite(I)?(I-m)/m*100:NaN,M=n>=2&&Number.isFinite(e[n-1].t)&&Number.isFinite(e[n-2].t)?e[n-\n1].t-e[n-2].t:NaN,W=Number.isFinite(s?.t)&&Number.isFinite(M)?Math.max(0,(Date.now()-(s.t+M))/6e4):NaN;return{change1hPct:a,change6hPct:o,compressionRatio:l,volumeMultiple:P,breakoutDistancePct:T,oiChangePct:O,priorHigh:S,lastClose:s?.close??NaN,dataAgeMinutes:W,intervalMs:M,candleCount:n}}function ot(e){const t=[],n=(r,a)=>{Number.isFinite(a)&&t.push({weight:r,value:Math.max(0,Math.min(1,a))})};if(n(\n30,(1.2-e.compressionRatio)/.7),Number.isFinite(e.volumeMultiple)){const r=e.volumeMultiple,a=r<1?r*.5:r<=2?1:r<=3?1-(r-2)*.3:Math.max(0,.7-(r-3)*.35);n(25,a)}if(Number.isFinite(e.breakoutDistancePct)){const r=e.breakoutDistancePct,a=r<-.8?0:r<=2?1-Math.abs(r-.6)/2.6:Math.max(0,1-(r-2)/3);n(25,a)}if(Number.isFinite(e.oiChangePct)){const r=e.oiChangePct,a=r<0?0:r<=5?Math.min(1,r/2):Math.max(0,1-(r-\n5)/5);n(20,a)}const s=t.reduce((r,a)=>r+a.weight,0);if(s===0)return 0;const i=t.reduce((r,a)=>r+a.weight*a.value,0)/s;return Math.round(i*100)}function ct(e,t){return Number.isFinite(t.breakoutDistancePct)?t.breakoutDistancePct<-N.maxBreakoutOvershootPct?\"EXCLUDED\":e>=g.minScore&&t.breakoutDistancePct<=g.maxBreakoutDistancePct?\"NEAR_BREAKOUT\":e>=60?\"BUILDING\":\"WATCH\":\"WATCH\"}const lt=Object.freeze(\n{NEAR_BREAKOUT:\"\\u63A5\\u8FD1\\u7A81\\u7834\",BUILDING:\"\\u919E\\u91C0\\u4E2D\",WATCH:\"\\u89C0\\u5BDF\",EXCLUDED:\"\\u5DF2\\u6392\\u9664\"}),E=e=>Number.isFinite(e)?`${e.toFixed(2)}%`:\"\\u7121\\u8CC7\\u6599\",fe=e=>Number.isFinite(e)?`${e.toFixed(3)} \\u500D`:\"\\u7121\\u8CC7\\u6599\",me=e=>Number.isFinite(e)?e.toFixed(3):\"\\u7121\\u8CC7\\u6599\",z=(e,t,n)=>Number.isFinite(e)&&e>=t&&e<=n;function ut(e){const t=(i,r,a,o,c)=>({id:i,\nlabel:r,passed:a,actualText:o,requirement:c,reason:a?null:`${r} ${o}\\uFF08\\u9700 ${c}\\uFF09`}),n=[t(\"score\",\"\\u5206\\u6578\",Number.isFinite(e.score)&&e.score>=g.minScore,Number.isFinite(e.score)?`${e.score} \\u5206`:\"\\u7121\\u8CC7\\u6599\",`\\u2265 ${g.minScore} \\u5206`),t(\"stage\",\"\\u7B49\\u7D1A\",e.stage===\"NEAR_BREAKOUT\",lt[e.stage]??\"\\u7121\\u8CC7\\u6599\",\"\\u63A5\\u8FD1\\u7A81\\u7834\"),t(\"breakout\",\"\\u8DDD\\u7A81\\u7834\\u9EDE\",\nz(e.breakoutDistancePct,g.minBreakoutDistancePct,g.maxBreakoutDistancePct),E(e.breakoutDistancePct),`${g.minBreakoutDistancePct}% \\uFF5E ${g.maxBreakoutDistancePct}%`),t(\"compression\",\"15m \\u58D3\\u7E2E\\u6BD4\",Number.isFinite(e.compressionRatio)&&e.compressionRatio<=g.maxCompressionRatio,me(e.compressionRatio),`\\u2264 ${g.maxCompressionRatio}`),t(\"volume\",\"\\u91CF\\u80FD\",z(e.volumeMultiple,g.minVolumeMultiple,\ng.maxVolumeMultiple),fe(e.volumeMultiple),`${g.minVolumeMultiple} \\uFF5E ${g.maxVolumeMultiple} \\u500D`),t(\"oi\",\"OI \\u8B8A\\u5316\",z(e.oiChangePct,g.minOiChangePct,g.maxOiChangePct),E(e.oiChangePct),`${g.minOiChangePct}% \\uFF5E ${g.maxOiChangePct}%`),t(\"change1h\",\"1H \\u6F32\\u8DCC\",z(e.change1hPct,g.minChange1hPct,g.maxChange1hPct),E(e.change1hPct),`${g.minChange1hPct}% \\uFF5E ${g.maxChange1hPct}%`),\nt(\"change6h\",\"6H \\u6F32\\u8DCC\",z(e.change6hPct,g.minChange6hPct,g.maxChange6hPct),E(e.change6hPct),`${g.minChange6hPct}% \\uFF5E ${g.maxChange6hPct}%`),t(\"risk\",\"\\u98A8\\u96AA\\u6A19\\u8A18\",(e.riskFlags??[]).length===0,(e.riskFlags??[]).length?`${e.riskFlags.length} \\u9805`:\"\\u7121\",\"\\u7121\\u98A8\\u96AA\\u6A19\\u8A18\"),t(\"fresh\",\"\\u8CC7\\u6599\\u5E74\\u9F61\",Number.isFinite(e.dataAgeMinutes)&&e.dataAgeMinutes<=\ng.maxDataAgeMinutes,Number.isFinite(e.dataAgeMinutes)?`${Math.round(e.dataAgeMinutes)} \\u5206\\u9418`:\"\\u7121\\u8CC7\\u6599\",`\\u2264 ${g.maxDataAgeMinutes} \\u5206\\u9418`)],s=n.filter(i=>!i.passed);return{gates:n,ready:s.length===0,reasons:s.map(i=>i.reason),readiness:{passed:n.length-s.length,total:n.length}}}function dt(e){const t=[];return e.change24hPct>N.maxChange24hPct&&t.push(`24H \\u6F32\\u5E45 ${E(\ne.change24hPct)} \\u5DF2\\u8D85\\u904E ${N.maxChange24hPct}%`),e.change1hPct>N.maxChange1hPct&&t.push(`1H \\u6F32\\u5E45 ${E(e.change1hPct)} \\u5DF2\\u8D85\\u904E ${N.maxChange1hPct}%`),e.change6hPct>N.maxChange6hPct&&t.push(`6H \\u6F32\\u5E45 ${E(e.change6hPct)} \\u5DF2\\u8D85\\u904E ${N.maxChange6hPct}%`),e.breakoutDistancePct<-N.maxBreakoutOvershootPct&&t.push(`\\u5DF2\\u7A81\\u7834\\u524D\\u9AD8 ${Math.abs(e.breakoutDistancePct).\ntoFixed(2)}%`),e.volumeMultiple>N.maxVolumeMultiple&&t.push(`\\u91CF\\u80FD ${fe(e.volumeMultiple)} \\u5DF2\\u66B4\\u885D`),e.breakoutDistancePct>N.maxBreakoutDistancePct&&t.push(`\\u8DDD\\u7A81\\u7834\\u9EDE\\u4ECD\\u6709 ${E(e.breakoutDistancePct)}`),e.compressionRatio>N.maxCompressionRatio&&t.push(`\\u58D3\\u7E2E\\u6BD4 ${me(e.compressionRatio)} \\u904E\\u5927`),Math.abs(e.fundingRatePct)>N.maxAbsFundingRatePct&&\nt.push(`\\u8CC7\\u91D1\\u8CBB\\u7387 ${e.fundingRatePct.toFixed(4)}% \\u904E\\u5EA6\\u6975\\u7AEF`),t}function pt(e,t){if(!Number.isFinite(e)||e<=0)return NaN;const n=.5,s=2.5,i=(t??[]).slice(-12).map(d=>d.low).filter(Number.isFinite),r=i.length?Math.min(...i):NaN,a=Number.isFinite(r)?r*.998:e*.985,o=(e-a)/e*100,c=Math.min(s,Math.max(n,o));return e*(1-c/100)}function ft(e,t){if(!Number.isFinite(e)||!Number.\nisFinite(t))return null;const n=e-t;return n>0?{riskPerUnit:n,takeProfit1:e+n*1.5,takeProfit2:e+n*2.5}:null}function mt(e){const t=n=>(n??[]).map(([s,i])=>({price:y(s),size:y(i)})).filter(s=>Number.isFinite(s.price)&&Number.isFinite(s.size)&&s.price>0&&s.size>0);return{bids:t(e?.b).sort((n,s)=>s.price-n.price),asks:t(e?.a).sort((n,s)=>n.price-s.price)}}function ge(e,t=.3){const n=e.bids[0]?.price,\ns=e.asks[0]?.price;if(!Number.isFinite(n)||!Number.isFinite(s))return{mid:NaN,bidUsd:0,askUsd:0,thinnerSideUsd:0};const i=(n+s)/2,r=1e-9,a=i*(1-t/100)*(1-r),o=i*(1+t/100)*(1+r),c=e.bids.filter(u=>u.price>=a).reduce((u,l)=>u+l.price*l.size,0),d=e.asks.filter(u=>u.price<=o).reduce((u,l)=>u+l.price*l.size,0);return{mid:i,bidUsd:c,askUsd:d,thinnerSideUsd:Math.min(c,d)}}function be(e,t=10){return!Number.\nisFinite(e)||e<=0?0:e*(t/100)}function gt(e,t,n,s){const i=at(t,n),r=ot(i),a=ct(r,i),o=tt(e.symbol,e.listedDays,e.turnover24hUsd,e.openInterestUsd),c={symbol:e.symbol,provider:le,lastPrice:e.lastPrice,score:r,stage:a,change24hPct:e.change24hPct,fundingRatePct:e.fundingRatePct,turnover24hUsd:e.turnover24hUsd,openInterestUsd:e.openInterestUsd,listedDays:e.listedDays,spreadPct:e.spreadPct,...i,riskFlags:[],\nisMeme:o.isMeme,memeReasons:o.reasons,memeConfidence:o.confidence,autoTradeEligible:!1},d=dt(c),u=ut(c),l=u.ready&&d.length===0,f=l?pt(i.lastClose,t):NaN,p=l?ft(i.lastClose,f):null,h=s?ge(s):null,P=h?be(h.thinnerSideUsd):0;return{...c,stage:d.length?\"EXCLUDED\":a,entryReady:l,entryLow:l&&p?i.lastClose-p.riskPerUnit*.15:null,entryHigh:l?i.lastClose:null,stopLoss:l&&p?f:null,takeProfit1:p?.takeProfit1??\nnull,takeProfit2:p?.takeProfit2??null,riskPerUnit:p?.riskPerUnit??null,gates:u.gates,readiness:u.readiness,blockingReasons:[...d,...u.reasons],staleWarning:Number.isFinite(i.dataAgeMinutes)&&i.dataAgeMinutes>g.staleWarningMinutes,depthUsd:h?h.thinnerSideUsd:null,maxPositionUsd:P,suggestedRiskPercent:o.isMeme?qe:null,riskLabel:nt(o),group:Ze(e.symbol,o.isMeme),bybitUrl:et(e.symbol)}}function Gt(e){\nreturn[...e].sort((t,n)=>t.entryReady!==n.entryReady?t.entryReady?-1:1:n.score-t.score).slice(0,ue)}function Wt(e){const t=[];return e.autoTradeEligible!==!1&&t.push(\"autoTradeEligible \\u5FC5\\u9808\\u6C38\\u9060\\u662F false\"),e.entryReady&&e.blockingReasons.length&&t.push(\"entryReady \\u70BA true \\u4F46\\u4ECD\\u6709\\u963B\\u64CB\\u539F\\u56E0\"),e.entryReady&&(e.stopLoss===null||e.takeProfit1===null||e.takeProfit2===\nnull)&&t.push(\"entryReady \\u70BA true \\u4F46\\u7F3A\\u5C11 SL \\u6216 TP\"),!e.entryReady&&(e.stopLoss!==null||e.takeProfit1!==null)&&t.push(\"\\u672A\\u5C31\\u7DD2\\u537B\\u5E36\\u51FA SL \\u6216 TP\"),e.stage===\"EXCLUDED\"&&e.entryReady&&t.push(\"\\u5DF2\\u6392\\u9664\\u537B\\u6A19\\u8A18\\u70BA\\u53EF\\u9032\\u5834\"),/^https:\\/\\/www\\.bybit\\.com\\//.test(e.bybitUrl)||t.push(\"\\u9023\\u7D50\\u672A\\u6307\\u5411 Bybit\"),t}function bt(e){\nconst t=(s,i)=>s.entryReady!==i.entryReady?s.entryReady?-1:1:i.score-s.score,n=e??[];return{main:n.filter(s=>s.group===\"main\").sort(t),meme:n.filter(s=>s.group===\"meme\").sort(t).slice(0,ue)}}const C=e=>String(e).replace(/[&<>\"]/g,t=>({\"&\":\"&amp;\",\"<\":\"&lt;\",\">\":\"&gt;\",'\"':\"&quot;\"})[t]),he=e=>C(e).replace(/\\r?\\n/g,\"<br>\"),ht={NEAR_BREAKOUT:\"\\u63A5\\u8FD1\\u7A81\\u7834\",BUILDING:\"\\u919E\\u91C0\\u4E2D\",WATCH:\"\\\n\\u89C0\\u5BDF\",EXCLUDED:\"\\u5DF2\\u6392\\u9664\"};function xe(e){const t=K(e.lastPrice),n=e.stage===\"NEAR_BREAKOUT\"?\"near\":e.stage===\"EXCLUDED\"?\"excl\":\"build\",s=Array.from({length:e.readiness.total},(o,c)=>'<i class=\"dot'+(c<e.readiness.passed?\" on\":\"\")+'\"></i>').join(\"\"),i=e.entryReady?`\n    <div class=\"entry\">\n      <div class=\"erow\"><span>Entry \\u5340</span><b>${b(e.entryLow,t)} \\u2013 ${b(e.entryHigh,t)}</b></div>\n      <div class=\"erow sl\"><span>\\u505C\\u640D SL</span><b>${b(e.stopLoss,t)}</b></div>\n      <div class=\"erow tp\"><span>TP1 \\xB7 1.5R</span><b>${b(e.takeProfit1,t)}</b></div>\n      <div class=\"erow tp\"><span>TP2 \\xB7 2.5R</span><b>${b(e.takeProfit2,t)}</b></div>\n      ${e.maxPositionUsd>0?'<div class=\"erow\"><span>\\u76E4\\u53E3\\u53EF\\u627F\\u53D7</span><b>\\u7D04 '+X(e.maxPositionUsd)+\" USDT</b></div>\":\"\"}\n    </div>`:\"\",r=e.blockingReasons.length?'<div class=\"reasons\">'+e.blockingReasons.map(o=>\"<div>\"+C(o)+\"</div>\").join(\"\")+\"</div>\":\"\",a=e.staleWarning?'<div class=\"banner\"><div class=\"bt\">\\u8CC7\\u6599\\u504F\\u820A</div><div class=\"bd\">\\u6B64\\u6A19\\u7684\\u8CC7\\u6599\\u5DF2 '+Math.round(e.dataAgeMinutes)+\" \\u5206\\u9418\\u672A\\u66F4\\u65B0\\u3002</div></div>\":\"\";return`\n  <div class=\"card ${e.entryReady?\"ready\":\"\"} ${e.stage===\"EXCLUDED\"?\"excluded\":\"\"}\">\n    <div class=\"chead\">\n      <span class=\"sym\">${C(e.symbol)}</span>\n      <span class=\"tag ${n}\">${ht[e.stage]??C(e.stage)}</span>\n      ${e.riskLabel?'<span class=\"tag meme\">'+C(e.riskLabel)+\"</span>\":\"\"}\n      <span class=\"score\"><b>${e.score}</b><span>\\u5B8C\\u6210\\u5EA6</span></span>\n    </div>\n\n    <div class=\"readiness\">\n      <span class=\"dots\">${s}</span>\n      <span class=\"rtext\">\\u9032\\u5834\\u689D\\u4EF6 ${e.readiness.passed}/${e.readiness.total}</span>\n    </div>\n\n    ${i}\n    ${r}\n    ${a}\n\n    <div class=\"grid\">\n      <div class=\"cell\"><span>\\u73FE\\u50F9</span><b>${b(e.lastPrice,t)}</b></div>\n      <div class=\"cell\"><span>\\u8DDD\\u7A81\\u7834\\u9EDE</span><b>${U(e.breakoutDistancePct)}</b></div>\n      <div class=\"cell\"><span>15m \\u58D3\\u7E2E\\u6BD4</span><b>${b(e.compressionRatio,3)}</b></div>\n      <div class=\"cell\"><span>\\u91CF\\u80FD\\u500D\\u7387</span><b>${b(e.volumeMultiple,2)}x</b></div>\n      <div class=\"cell\"><span>OI \\u8B8A\\u5316</span><b class=\"${D(e.oiChangePct)}\">${U(e.oiChangePct)}</b></div>\n      <div class=\"cell\"><span>\\u8CC7\\u91D1\\u8CBB\\u7387</span><b>${b(e.fundingRatePct,4)}%</b></div>\n      <div class=\"cell\"><span>1H / 6H</span><b><span class=\"${D(e.change1hPct)}\">${U(e.change1hPct)}</span> / <span class=\"${D(e.change6hPct)}\">${U(e.change6hPct)}</span></b></div>\n      <div class=\"cell\"><span>24H \\u6210\\u4EA4\\u984D</span><b>${X(e.turnover24hUsd)}</b></div>\n    </div>\n\n    <div class=\"foot\">\n      <a href=\"${e.bybitUrl}\" target=\"_blank\" rel=\"noopener noreferrer\">\\u5728 Bybit \\u958B\\u555F\\u5408\\u7D04 \\u2197</a>\n      <span class=\"noauto\">\\u50C5\\u4F9B\\u7814\\u7A76\\u89C0\\u5BDF \\xB7 \\u4E0D\\u81EA\\u52D5\\u4E0B\\u55AE</span>\n    </div>\n  </div>`}function xt(e){if(!e)return\"\";if(e.error)return`<h2>Bybit \\u5E33\\u6236</h2>\n      <div class=\"banner err\">\n        <div class=\"bt\">\\u7121\\u6CD5\\u8B80\\u53D6\\u5E33\\u6236\\u8CC7\\u6599</div>\n        <div class=\"bd\">${he(e.error)}</div>\n      </div>`;const t=e.wallet,n=e.positions??[],s=e.todayPnl,i=t?`\n    <div class=\"grid\">\n      <div class=\"cell\"><span>\\u7E3D\\u6B0A\\u76CA</span><b>${L(t.totalEquityUsd)} USDT</b></div>\n      <div class=\"cell\"><span>\\u53EF\\u7528</span><b>${L(t.totalAvailableUsd)} USDT</b></div>\n      <div class=\"cell\"><span>\\u672A\\u5BE6\\u73FE</span><b class=\"${D(t.unrealizedPnlUsd)}\">${L(t.unrealizedPnlUsd)}</b></div>\n      <div class=\"cell\"><span>\\u4ECA\\u65E5\\u5DF2\\u5BE6\\u73FE</span><b class=\"${D(s?.total)}\">${L(s?.total)}</b></div>\n    </div>`:\"\",r=n.length?n.map(a=>{const o=a.protection??{level:\"danger\",text:\"\\u672A\\u77E5\"},c=K(a.entryPrice);return`\n        <div class=\"card ${o.level===\"ok\"?\"\":\"excluded\"}\">\n          <div class=\"chead\">\n            <span class=\"sym\">${C(a.symbol)}</span>\n            <span class=\"tag ${a.side===\"long\"?\"near\":\"excl\"}\">${a.side===\"long\"?\"\\u25B2 \\u591A\":\"\\u25BC \\u7A7A\"}</span>\n            <span class=\"tag ${o.level===\"ok\"?\"build\":\"meme\"}\">${C(o.text)}</span>\n            <span class=\"score\"><b class=\"${D(a.unrealizedPnl)}\">${L(a.unrealizedPnl)}</b><span>\\u672A\\u5BE6\\u73FE</span></span>\n          </div>\n          <div class=\"grid\">\n            <div class=\"cell\"><span>\\u9032\\u5834</span><b>${b(a.entryPrice,c)}</b></div>\n            <div class=\"cell\"><span>\\u6A19\\u8A18\\u50F9</span><b>${b(a.markPrice,c)}</b></div>\n            <div class=\"cell\"><span>\\u6578\\u91CF</span><b>${b(a.size,4)}</b></div>\n            <div class=\"cell\"><span>\\u69D3\\u687F</span><b>${b(a.leverage,0)}x</b></div>\n            <div class=\"cell\"><span>TP</span><b>${a.takeProfit>0?b(a.takeProfit,c):\"\\u672A\\u8A2D\\u5B9A\"}</b></div>\n            <div class=\"cell\"><span>SL</span><b>${a.stopLoss>0?b(a.stopLoss,c):\"\\u672A\\u8A2D\\u5B9A\"}</b></div>\n          </div>\n        </div>`}).join(\"\"):'<div class=\"empty\">\\u76EE\\u524D\\u6C92\\u6709\\u6301\\u5009\\u3002</div>';return`<h2>Bybit \\u5E33\\u6236 \\xB7 \\u552F\\u8B80</h2>\n    <div class=\"card\">\n      <div class=\"chead\">\n        <span class=\"sym\">\\u5E33\\u6236\\u6458\\u8981</span>\n        <span class=\"tag build\">${C(e.keyMask??\"\\u5DF2\\u9023\\u63A5\")}</span>\n        <span class=\"noauto\" style=\"margin-left:auto\">\\u552F\\u8B80 \\xB7 \\u4E0D\\u6703\\u4E0B\\u55AE</span>\n      </div>\n      ${i}\n    </div>\n    ${r}`}function ye(e,t,n,s){if(!n.length)return`<h2>${e}</h2><div class=\"empty\">${s}</div>`;const i=n.filter(o=>o.entryReady),r=n.filter(o=>!o.entryReady);let a=`<h2>${e} \\xB7 ${n.length} \\u6A94</h2>`;return t&&(a+=`<div class=\"note\" style=\"margin:0 0 10px\">${t}</div>`),i.length&&(a+=`<div class=\"subhead\">\\u7B26\\u5408\\u5168\\u90E8\\u9032\\u5834\\u689D\\u4EF6 \\xB7 ${i.length} \\u6A94</div>`+i.map(xe).\njoin(\"\")),r.length&&(a+=`<div class=\"subhead\">\\u89C0\\u5BDF\\u4E2D \\xB7 ${r.length} \\u6A94</div>`+r.map(xe).join(\"\")),a}function yt(e){let t=\"\";e.error&&(t+=`<div class=\"banner err\">\n      <div class=\"bt\">\\u7121\\u6CD5\\u53D6\\u5F97 Bybit \\u8CC7\\u6599</div>\n      <div class=\"bd\">${he(e.error)}</div>\n    </div>`),e.failed&&e.failed.length&&(t+=`<div class=\"banner\">\n      <div class=\"bt\">${e.failed.length} \\u6A94\\u6A19\\u7684\\u8CC7\\u6599\\u6293\\u53D6\\u5931\\u6557</div>\n      <div class=\"bd\">${e.failed.map(s=>C(s.symbol)).join(\"\\u3001\")}</div>\n    </div>`),t+=xt(e.account);const n=e.groups??{main:[],meme:[]};return!e.busy&&e.scannedAt&&(t+=ye(\"\\u4E3B\\u5E63\",\"\\u56FA\\u5B9A\\u89C0\\u5BDF\\u6E05\\u55AE\\uFF0C\\u4E0D\\u8AD6\\u662F\\u5426\\u7B26\\u5408\\u5FEB\\u5674\\u578B\\u614B\\u90FD\\u6703\\u986F\\u793A\\u76EE\\u524D\\u72C0\\u614B\\u3002\",n.main,\"\\u4E3B\\u5E63\\u8CC7\\u6599\\u5C1A\\u672A\\u53D6\\u5F97\\u3002\"),t+=ye(\"\\u8FF7\\u56E0\\u5E63\\uFF0F\\u9AD8\\u98A8\\u96AA\",\"\\u4E00\\u5F8B\\u5957\\u7528\\u56FA\\u5B9A 0\\\n.15% \\u9632\\u5B88\\u5009\\uFF0C\\u4E0D\\u56E0\\u5206\\u6578\\u63D0\\u9AD8\\u5009\\u4F4D\\u3002\\u5224\\u65B7\\u4E0D\\u51FA\\u4F86\\u7684\\u6A19\\u7684\\u4E5F\\u6B78\\u5728\\u9019\\u4E00\\u5340\\u3002\",n.meme,\"\\u76EE\\u524D\\u6C92\\u6709\\u7B26\\u5408\\u689D\\u4EF6\\u7684\\u5019\\u9078\\u3002\\u591A\\u6578\\u6642\\u9593\\u5E02\\u5834\\u90FD\\u4E0D\\u5728\\u58D3\\u7E2E\\u5F85\\u7A81\\u7834\\u7684\\u72C0\\u614B\\u3002\")),t}function vt(e){return!e.scannedAt||\ne.busy?\"\":`\\u901A\\u904E\\u7B2C\\u4E00\\u968E\\u6BB5 ${e.universeCount} \\u6A94\\uFF0C\\u8A73\\u7D30\\u5206\\u6790 ${e.analyzedCount} \\u6A94`}const Pt=`\n  <div class=\"disc\">\n    <b>\\u4F7F\\u7528\\u524D\\u8ACB\\u52D9\\u5FC5\\u4E86\\u89E3</b>\n    <ul>\n      <li>\\u672C\\u9801\\u53EA\\u8B80\\u53D6 Bybit \\u516C\\u958B\\u884C\\u60C5\\u7AEF\\u9EDE\\uFF0C<strong>\\u4E0D\\u9023\\u63A5\\u4EFB\\u4F55\\u5E33\\u6236\\u3001\\u4E0D\\u9700\\u8981\\u4E5F\\u4E0D\\u63A5\\u53D7 API Key</strong>\\uFF0C\\u4E26\\u4E14<strong>\\u6C38\\u9060\\u4E0D\\u6703\\u4E0B\\u55AE</strong>\\u3002</li>\n      <li>\\u5B8C\\u6210\\u5EA6\\u5206\\u6578\\u8861\\u91CF\\u7684\\u662F\\u300C\\u578B\\u614B\\u6210\\u719F\\u7A0B\\u5EA6\\u300D\\uFF0C<strong>\\u4E0D\\u662F\\u52DD\\u7387\\uFF0C\\u4E5F\\u4E0D\\u662F\\u5831\\u916C\\u9810\\u671F</strong>\\u3002\\u5206\\u6578\\u9AD8\\u4E0D\\u7B49\\u65BC\\u53EF\\u4EE5\\u9032\\u5834\\uFF0C\\u5FC5\\u9808\\u5341\\u9805\\u9032\\u5834\\u689D\\u4EF6\\u5168\\u90E8\\u901A\\u904E\\u3002</li>\n      <li>Entry\\u3001SL\\u3001TP \\u70BA\\u4F9D 1.5R \\u8207 2.5R \\u6A5F\\u68B0\\u63DB\\u7B97\\u7684\\u53C3\\u8003\\u503C\\uFF0C\\u4E0D\\u662F\\u6295\\u8CC7\\u5EFA\\u8B70\\u3002\\u5BE6\\u969B\\u4E0B\\u55AE\\u524D\\u8ACB\\u81EA\\u884C\\u78BA\\u8A8D\\u76E4\\u53E3\\u6DF1\\u5EA6\\u8207\\u53EF\\u627F\\u53D7\\u98A8\\u96AA\\u3002</li>\n      <li>\\u8FF7\\u56E0\\u5E63\\u4E00\\u5F8B\\u6A19\\u8A18\\u4E26\\u5957\\u7528\\u56FA\\u5B9A 0.15% \\u9632\\u5B88\\u5009\\uFF0C\\u4E0D\\u56E0\\u5206\\u6578\\u63D0\\u9AD8\\u5009\\u4F4D\\u3002</li>\n      <li>\\u52A0\\u5BC6\\u8CA8\\u5E63\\u6C38\\u7E8C\\u5408\\u7D04\\u98A8\\u96AA\\u6975\\u9AD8\\uFF0C\\u53EF\\u80FD\\u640D\\u5931\\u5168\\u90E8\\u672C\\u91D1\\u3002\\u672C\\u5DE5\\u5177\\u4E0D\\u5C0D\\u4EFB\\u4F55\\u7D50\\u679C\\u4F5C\\u51FA\\u4FDD\\u8B49\\u3002</li>\n    </ul>\n  </div>`,H=\"Crypto Radar Guardian 10.0\",G=5,Nt=9,wt=4,F=Object.freeze({latest:\"state:latest\",heartbeat:\"state:heartbeat\",notify:\"state:notify\"});function St(e){const t=[];for(const n of Object.keys(e||{})){const s=e[n];s==null||s===\"\"||t.push(`${encodeURIComponent(n)}=${encodeURIComponent(String(s))}`)}return t.join(\"&\")}function ve(e,t){const n=t??fetch,s=_(e.BYBIT_ENV);async function i(a,o){const c=St(\no),d=$e(s)+a+(c?`?${c}`:\"\"),u=await n(d,{headers:{accept:\"application/json\"}});if(!u.ok)throw new Error(`HTTP ${u.status}`);const l=await u.json();if(l.retCode!==0)throw new Error(ne(l.retCode,l.retMsg,s));return l.result}async function r(a,o){const c=R(e.BYBIT_API_KEY),d=R(e.BYBIT_API_SECRET);if(!c||!d)throw new Error(\"\\u672A\\u8A2D\\u5B9A Bybit \\u6191\\u8B49\");const u=Me({path:a,params:o,apiKey:c,apiSecret:d,\ntimestamp:Date.now(),env:s}),l=await n(u.url,{headers:u.headers});if(!l.ok)throw new Error(`HTTP ${l.status}`);const f=await l.json();if(f.retCode!==0)throw new Error(ne(f.retCode,f.retMsg,s));return f.result}return{publicGet:i,signedGet:r,bybitEnv:s,hasCredentials:!!(R(e.BYBIT_API_KEY)&&R(e.BYBIT_API_SECRET))}}function $t(e,t=Nt){const n=J.map(o=>o.toUpperCase()),s=new Map;for(const o of e??[])s.\nset(String(o.symbol).toUpperCase(),o);const i=[];for(const o of n){const c=s.get(o);c&&i.push(c)}const r=(e??[]).filter(o=>!n.includes(String(o.symbol).toUpperCase())),a=pe(r.filter(q)).slice(0,t);return{main:i,scan:a,all:[...i,...a]}}async function kt(e,t=Date.now()){const[n,s]=await Promise.all([e.publicGet(\"/v5/market/instruments-info\",{category:\"linear\",limit:1e3}),e.publicGet(\"/v5/market/tick\\\ners\",{category:\"linear\"})]),i=st(n.list??[],s.list??[],t),r=i.filter(q).length,a=$t(i),o=[],c=[];for(const l of a.all)try{const[f,p]=await Promise.all([e.publicGet(\"/v5/market/kline\",{category:\"linear\",symbol:l.symbol,interval:15,limit:40}),e.publicGet(\"/v5/market/open-interest\",{category:\"linear\",symbol:l.symbol,intervalTime:\"15min\",limit:5})]);o.push({row:l,candidate:gt(l,it(f.list),rt(p.list),null)})}catch(f){\nc.push({symbol:l.symbol,error:String(f?.message??f)})}const d=o.filter(l=>l.candidate.entryReady).slice(0,wt);for(const l of d)try{const f=await e.publicGet(\"/v5/market/orderbook\",{category:\"linear\",symbol:l.row.symbol,limit:50}),p=ge(mt(f));l.candidate.depthUsd=p.thinnerSideUsd,l.candidate.maxPositionUsd=be(p.thinnerSideUsd)}catch{}const u=o.map(l=>l.candidate);return{version:H,scannedAt:t,universeCount:r,\nanalyzedCount:a.all.length,candidates:u,groups:bt(u),failed:c,busy:!1,error:null,account:null}}async function Pe(e,t){if(!e.hasCredentials)return null;try{const[n,s,i]=await Promise.all([e.signedGet(\"/v5/account/wallet-balance\",{accountType:\"UNIFIED\"}),e.signedGet(\"/v5/position/list\",{category:\"linear\",settleCoin:\"USDT\"}),e.signedGet(\"/v5/position/closed-pnl\",{category:\"linear\",limit:50})]),r=Oe(s).\nmap(a=>({...a,protection:Le(a)}));return{wallet:Be(n),positions:r,todayPnl:ze(_e(i),Date.now()-864e5),keyMask:re(R(t.BYBIT_API_KEY)),error:null}}catch(n){const s=String(n?.message??n),i=R(t.BYBIT_API_KEY),r=R(t.BYBIT_API_SECRET);return{error:s.split(i).join(\"[key]\").split(r).join(\"[secret]\"),keyMask:re(i)}}}function Ct(e){const t=e??fetch;return async(n,s)=>{const i=await t(n,{method:\"POST\",headers:{\n\"Content-Type\":\"application/json\"},body:JSON.stringify(s)});if(!i.ok)throw new Error(`Discord \\u56DE\\u61C9 HTTP ${i.status}`)}}async function At(e,t,n,s,i=Date.now()){const r=t.DISCORD_WEBHOOK;if(!ae(r))return{sent:0,error:null,skipped:\"\\u672A\\u8A2D\\u5B9A Webhook\"};const a=e.groups??{main:[],meme:[]},o=[...a.main,...a.meme].filter(p=>p.entryReady);let c={sent:{},lastSentAt:null};try{const p=await n.\nget(F.notify);p&&(c=JSON.parse(p))}catch{}const d=Ge(o,c,i);let u=0,l=null;for(const p of d.toSend){const h=await ce(s,r,je(p));h.ok?u+=1:l=h.error}if(e.account?.positions){const p=Ke(e.account.positions);if(p){const h=await ce(s,r,p);h.ok?u+=1:l=h.error}}const f=JSON.stringify(d.state);return f!==JSON.stringify(c)&&await n.put(F.notify,f),{sent:u,error:l,skipped:null}}async function Et(e,t,n=Date.\nnow()){const s={...t,account:null};await e.put(F.latest,JSON.stringify(s)),await e.put(F.heartbeat,JSON.stringify({at:n,version:H,ok:!t.error,analyzed:t.analyzedCount,failed:t.failed?.length??0}))}async function Z(e){try{const t=await e.get(F.latest);return t?JSON.parse(t):null}catch{return null}}async function Tt(e){try{const t=await e.get(F.heartbeat);return t?JSON.parse(t):null}catch{return null}}\nasync function Rt({env:e,kv:t,fetchImpl:n,now:s=Date.now()}){const i=ve(e,n),r=Ct(n);try{const a=await kt(i,s);a.account=await Pe(i,e);const o=await At(a,e,t,r,s);return await Et(t,a,s),{ok:!0,state:a,notifyResult:o}}catch(a){const o=String(a?.message??a);return await t.put(F.heartbeat,JSON.stringify({at:s,version:H,ok:!1,error:o})),{ok:!1,error:o}}}const Ut={\"content-type\":\"application/json; char\\\nset=utf-8\",\"cache-control\":\"no-store\"},Dt={\"content-type\":\"text/html; charset=utf-8\",\"cache-control\":\"no-store\"},B=(e,t=200)=>new Response(JSON.stringify(e,null,2),{status:t,headers:Ut});function Ft(e,t){const n=String(e??\"\"),s=String(t??\"\");if(n.length===0||s.length===0||n.length!==s.length)return!1;let i=0;for(let r=0;r<n.length;r+=1)i|=n.charCodeAt(r)^s.charCodeAt(r);return i===0}function It(e,t){\nconst n=t.ADMIN_TOKEN;return n?Ft(e.searchParams.get(\"token\"),n):!1}function Mt(e,t){return!e||!Number.isFinite(e.at)?null:Math.max(0,Math.round((t-e.at)/1e3))}function Bt(e,t){const n=Mt(e,t),s=G*60*2+60;return n===null?{ok:!1,status:\"no-heartbeat\",ageSeconds:null}:e.ok?n>s?{ok:!1,status:\"stale\",ageSeconds:n}:{ok:!0,status:\"healthy\",ageSeconds:n}:{ok:!1,status:\"last-run-failed\",ageSeconds:n}}async function Ot({\nrequest:e,env:t,kv:n,now:s=Date.now()}){const i=new URL(e.url),r=i.pathname.replace(/\\/+$/,\"\")||\"/\";if(e.method!==\"GET\"&&e.method!==\"HEAD\")return B({error:\"method not allowed\"},405);const a=await Tt(n),o=Bt(a,s);if(r===\"/health\")return B({ok:o.ok,status:o.status,version:H,heartbeatAt:a?.at??null,ageSeconds:o.ageSeconds},o.ok?200:503);if(r===\"/api/status\"){const c=await Z(n);return B({version:H,engine:Xe,\nhealth:o.status,ok:o.ok,heartbeatAt:a?.at??null,heartbeatAgeSeconds:o.ageSeconds,cron:`\\u6BCF ${G} \\u5206\\u9418`,moonshotProvider:le,bybitEnvironment:Q[_(t.BYBIT_ENV)],tradeMode:\"read-only\",autoTrading:!1,discordConfigured:!!t.DISCORD_WEBHOOK,bybitAccountConfigured:!!(t.BYBIT_API_KEY&&t.BYBIT_API_SECRET),lastScanAt:c?.scannedAt??null,universeCount:c?.universeCount??null,analyzedCount:c?.analyzedCount??\nnull,readyCount:c?[...c.groups?.main??[],...c.groups?.meme??[]].filter(d=>d.entryReady).length:null,failedCount:c?.failed?.length??null})}if(r===\"/api/scan\"){const c=await Z(n);return c?B(c):B({error:\"\\u5C1A\\u672A\\u6709\\u6383\\u63CF\\u7D50\\u679C\"},503)}if(r===\"/\"){const c=await Z(n),d=It(i,t)?await Pe(ve(t),t):null;return new Response(Lt(c,d,a,o,t,s),{headers:Dt})}return B({error:\"not found\"},404)}function _t(e){\nreturn Number.isFinite(e)?new Date(e).toISOString().replace(\"T\",\" \").slice(0,16)+\" UTC\":\"\\u2014\"}function Lt(e,t,n,s,i,r){const a=e?.groups??{main:[],meme:[]},o=[...a.main,...a.meme].filter(p=>p.entryReady).length,c=s.ok?\"ok\":\"warn\",d=s.ok?`\\u904B\\u4F5C\\u6B63\\u5E38 \\xB7 \\u5FC3\\u8DF3 ${s.ageSeconds} \\u79D2\\u524D`:s.status===\"no-heartbeat\"?\"\\u5C1A\\u672A\\u57F7\\u884C\\u904E\\u6392\\u7A0B\\u6383\\u63CF\":s.status===\n\"last-run-failed\"?\"\\u4E0A\\u4E00\\u6B21\\u6392\\u7A0B\\u57F7\\u884C\\u5931\\u6557\":`\\u5FC3\\u8DF3\\u5DF2 ${Math.round((s.ageSeconds??0)/60)} \\u5206\\u9418\\u672A\\u66F4\\u65B0`,u=s.ok?\"\":`\n    <div class=\"banner\">\n      <div class=\"bt\">${d}</div>\n      <div class=\"bd\">\\u6392\\u7A0B\\u70BA\\u6BCF ${G} \\u5206\\u9418\\u4E00\\u6B21\\u3002\\u82E5\\u6301\\u7E8C\\u7570\\u5E38\\uFF0C\\u8ACB\\u5230 Cloudflare \\u6AA2\\u67E5 Worker \\u7684 Cron \\u89F8\\u767C\\u5668\\u8207\\u8A18\\u9304\\u3002</div>\n    </div>`,l=e?{...e,account:t,busy:!1}:{candidates:[],groups:{main:[],meme:[]},failed:[],scannedAt:null,busy:!1,error:null,account:null},f=t?\"\":`\n    <div style=\"margin-top:6px;color:var(--muted)\">\\u5E33\\u6236\\u8CC7\\u6599\\u672A\\u986F\\u793A\\u3002\\u82E5\\u5DF2\\u8A2D\\u5B9A ADMIN_TOKEN\\uFF0C\\u8ACB\\u5728\\u7DB2\\u5740\\u52A0\\u4E0A <code>?token=\\u4F60\\u7684Token</code>\\u3002</div>`;return`<!doctype html>\n<html lang=\"zh-Hant\">\n<head>\n<meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1, viewport-fit=cover\">\n<meta name=\"apple-mobile-web-app-capable\" content=\"yes\">\n<meta name=\"apple-mobile-web-app-status-bar-style\" content=\"black-translucent\">\n<meta name=\"color-scheme\" content=\"dark\">\n<meta name=\"robots\" content=\"noindex, nofollow\">\n<meta http-equiv=\"refresh\" content=\"300\">\n<title>Crypto Radar Guardian</title>\n<style>:root {\n  color-scheme: dark;\n  --bg: #050d17;\n  --panel: #081321;\n  --panel-2: #0b1a2c;\n  --line: rgba(34, 211, 238, 0.16);\n  --line-soft: rgba(34, 211, 238, 0.08);\n  --text: #cfe6f2;\n  --muted: #6d8ca6;\n  --cyan: #22d3ee;\n  --green: #34d399;\n  --amber: #ffb020;\n  --red: #ff4d6d;\n  --violet: #a78bfa;\n}\n* { box-sizing: border-box; }\nhtml, body { margin: 0; background: var(--bg); }\nbody {\n  font: 15px/1.55 -apple-system, BlinkMacSystemFont, \"Segoe UI\", \"Noto Sans TC\", \"PingFang TC\", sans-serif;\n  color: var(--text);\n  padding: env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left);\n  -webkit-text-size-adjust: 100%;\n}\n.wrap { max-width: 640px; margin: 0 auto; padding: 14px 12px 40px; }\n\nheader { position: sticky; top: 0; z-index: 20; background: linear-gradient(180deg, var(--bg) 72%, transparent); padding-top: 8px; }\n.title { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }\nh1 { font-size: 19px; margin: 0; letter-spacing: .02em; }\n.ver { font-size: 11px; color: var(--muted); font-variant-numeric: tabular-nums; }\n.srcbadge {\n  display: inline-flex; align-items: center; gap: 5px;\n  font-size: 11px; color: var(--cyan); border: 1px solid var(--line);\n  border-radius: 999px; padding: 2px 9px; background: rgba(34, 211, 238, .06);\n}\n.srcbadge b { font-weight: 600; }\n\n.bar { display: flex; gap: 8px; align-items: center; margin-top: 10px; }\nbutton {\n  font: inherit; font-size: 14px; color: var(--text);\n  background: var(--panel-2); border: 1px solid var(--line);\n  border-radius: 10px; padding: 9px 14px; cursor: pointer;\n  min-height: 42px; -webkit-tap-highlight-color: transparent;\n}\nbutton:active { background: #10263c; }\nbutton[disabled] { opacity: .5; cursor: default; }\nbutton.primary { border-color: rgba(34, 211, 238, .45); color: #e6fbff; }\n.meta { font-size: 12px; color: var(--muted); font-variant-numeric: tabular-nums; margin-left: auto; text-align: right; }\n\n.note {\n  margin: 12px 0 0; padding: 10px 12px; border-radius: 10px;\n  background: var(--panel); border: 1px solid var(--line-soft);\n  font-size: 12.5px; color: var(--muted);\n}\n.note strong { color: var(--text); font-weight: 600; }\n\n.banner { margin-top: 12px; padding: 11px 13px; border-radius: 11px; background: var(--panel); border-left: 3px solid var(--amber); }\n.banner.err { border-left-color: var(--red); }\n.banner .bt { font-size: 13.5px; color: #ffe9c2; font-weight: 600; }\n.banner.err .bt { color: #ffd6de; }\n.banner .bd { font-size: 12.5px; color: var(--muted); margin-top: 3px; }\n\n.progress { height: 3px; background: var(--panel-2); border-radius: 2px; overflow: hidden; margin-top: 12px; }\n.progress i { display: block; height: 100%; background: linear-gradient(90deg, var(--cyan), var(--violet)); width: 0; transition: width .25s ease; }\n\nh2 { font-size: 13px; color: var(--muted); font-weight: 600; letter-spacing: .06em; margin: 22px 0 10px; text-transform: uppercase; }\n\n.card {\n  background: var(--panel); border: 1px solid var(--line-soft);\n  border-radius: 13px; padding: 13px; margin-bottom: 11px;\n}\n.card.ready { border-color: rgba(52, 211, 153, .38); box-shadow: 0 0 0 1px rgba(52, 211, 153, .09), 0 6px 22px -14px rgba(52, 211, 153, .5); }\n.card.excluded { opacity: .72; }\n\n.chead { display: flex; align-items: center; gap: 9px; flex-wrap: wrap; }\n.sym { font-size: 17px; font-weight: 650; letter-spacing: .01em; }\n.tag { font-size: 10.5px; padding: 2px 7px; border-radius: 5px; border: 1px solid var(--line); color: var(--muted); white-space: nowrap; }\n.tag.near { color: var(--green); border-color: rgba(52, 211, 153, .4); }\n.tag.build { color: var(--cyan); border-color: rgba(34, 211, 238, .35); }\n.tag.excl { color: var(--red); border-color: rgba(255, 77, 109, .35); }\n.tag.meme { color: var(--amber); border-color: rgba(255, 176, 32, .4); }\n.score { margin-left: auto; text-align: right; }\n.score b { font-size: 21px; font-variant-numeric: tabular-nums; letter-spacing: -.01em; }\n.score span { display: block; font-size: 10.5px; color: var(--muted); }\n\n.readiness { display: flex; align-items: center; gap: 8px; margin-top: 10px; }\n.dots { display: flex; gap: 3px; }\n.dot { width: 7px; height: 7px; border-radius: 2px; background: rgba(255,255,255,.13); }\n.dot.on { background: var(--green); }\n.rtext { font-size: 12px; color: var(--muted); font-variant-numeric: tabular-nums; }\n\n.reasons { margin: 9px 0 0; padding: 9px 11px; border-radius: 9px; background: rgba(255, 77, 109, .06); border: 1px solid rgba(255, 77, 109, .18); }\n.reasons div { font-size: 12.5px; color: #ffc9d4; padding: 1.5px 0; }\n.reasons div::before { content: \"\\u2715 \"; color: var(--red); }\n\n.entry { margin-top: 10px; padding: 10px 11px; border-radius: 9px; background: rgba(52, 211, 153, .06); border: 1px solid rgba(52, 211, 153, .2); }\n.erow { display: flex; justify-content: space-between; font-size: 13px; padding: 2.5px 0; font-variant-numeric: tabular-nums; }\n.erow span { color: var(--muted); }\n.erow b { font-weight: 600; }\n.erow.tp b { color: var(--green); }\n.erow.sl b { color: var(--red); }\n\n.grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 7px 12px; margin-top: 11px; }\n.cell { font-size: 12px; display: flex; justify-content: space-between; gap: 6px; font-variant-numeric: tabular-nums; }\n.cell span { color: var(--muted); }\n.cell b { font-weight: 600; }\n.pos { color: var(--green); }\n.neg { color: var(--red); }\n\n.foot { display: flex; align-items: center; gap: 10px; margin-top: 11px; padding-top: 10px; border-top: 1px solid var(--line-soft); }\n.foot a { color: var(--cyan); font-size: 12.5px; text-decoration: none; border-bottom: 1px solid rgba(34,211,238,.3); }\n.noauto { font-size: 11px; color: var(--muted); margin-left: auto; }\n\n.empty { padding: 26px 14px; text-align: center; color: var(--muted); font-size: 13.5px; background: var(--panel); border-radius: 12px; border: 1px dashed var(--line-soft); }\n\n.disc { margin-top: 26px; padding: 13px; border-radius: 11px; background: var(--panel); border: 1px solid var(--line-soft); font-size: 11.5px; line-height: 1.65; color: var(--muted); }\n.disc b { color: var(--text); display: block; margin-bottom: 5px; font-size: 12.5px; }\n.disc li { margin: 3px 0; }\n.disc ul { margin: 5px 0 0; padding-left: 17px; }\n\n@media (max-width: 380px) { .grid { grid-template-columns: 1fr; } h1 { font-size: 17px; } }\n\n.subhead {\n  font-size: 12px; color: var(--muted); margin: 14px 0 8px;\n  display: flex; align-items: center; gap: 8px;\n}\n.subhead::after { content: \"\"; flex: 1; height: 1px; background: var(--line-soft); }</style>\n</head>\n<body>\n<div class=\"wrap\">\n  <header>\n    <div class=\"title\">\n      <h1>Crypto Radar Guardian</h1>\n      <span class=\"ver\">v10.0 \\xB7 Cloudflare Worker</span>\n    </div>\n    <div style=\"margin-top:6px\">\n      <span class=\"srcbadge\">\\u25C8 \\u8CC7\\u6599\\u4F86\\u6E90 <b>Bybit /v5/market</b></span>\n    </div>\n    <div class=\"bar\">\n      <span class=\"meta\" style=\"margin-left:0\">\n        \\u6383\\u63CF\\u65BC ${_t(e?.scannedAt)}\\u3000\\xB7\\u3000\\u7B26\\u5408\\u9032\\u5834\\u689D\\u4EF6 ${o} \\u6A94\n      </span>\n    </div>\n  </header>\n\n  ${u}\n\n  <div class=\"note\">\n    <strong>\\u65E9\\u671F\\u5FEB\\u5674\\u6383\\u63CF</strong>\\uFF1A\\u5728 Bybit USDT \\u7DDA\\u6027\\u6C38\\u7E8C\\u4E2D\\uFF0C\\u5C0B\\u627E\\u300C\\u5DF2\\u58D3\\u7E2E\\u3001\\u91CF\\u80FD\\u6EAB\\u548C\\u653E\\u5927\\u3001\\u672A\\u5E73\\u5009\\u91CF\\u589E\\u52A0\\u3001\\u4E14\\u5C1A\\u672A\\u7A81\\u7834\\u524D\\u9AD8\\u300D\\u7684\\u6A19\\u7684\\u3002\n    \\u5DF2\\u7D93\\u5674\\u904E\\u7684\\u4E00\\u5F8B\\u6392\\u9664\\u3002${vt({...l,scannedAt:e?.scannedAt})}\n    <div style=\"margin-top:6px;color:var(--muted)\">\n      \\u7531 Cloudflare Worker \\u6BCF ${G} \\u5206\\u9418\\u81EA\\u52D5\\u6383\\u63CF\\uFF0C${d}\\u3002\\u672C\\u9801\\u6BCF 5 \\u5206\\u9418\\u81EA\\u52D5\\u91CD\\u65B0\\u6574\\u7406\\u3002\n    </div>${f}\n  </div>\n\n  ${yt(l)}\n${Pt}\n</div>\n</body>\n</html>`}var Xt={async scheduled(e,t,n){const s=t.GUARDIAN_KV;if(!s){console.log(\"\\u7F3A\\u5C11 KV \\u7D81\\u5B9A GUARDIAN_KV\\uFF0C\\u7565\\u904E\\u9019\\u4E00\\u8F2A\");return}const i=await Rt({env:t,kv:s,now:Date.now()});if(i.ok){const r=i.state.groups,a=[...r.main,...r.meme].filter(o=>o.entryReady).length;console.log(\"\\u6383\\u63CF\\u5B8C\\u6210\\uFF1A\\u5206\\u6790 \"+i.state.analyzedCount+\" \\u6A94\\uFF0C\\u53EF\\u9032\\u5834 \"+\na+\" \\u6A94\\uFF0C\\u901A\\u77E5 \"+i.notifyResult.sent+\" \\u5247\")}else console.log(\"\\u6383\\u63CF\\u5931\\u6557\\uFF1A\"+i.error)},async fetch(e,t,n){const s=t.GUARDIAN_KV;if(!s)return new Response(JSON.stringify({error:\"\\u7F3A\\u5C11 KV \\u7D81\\u5B9A GUARDIAN_KV\"},null,2),{status:500,headers:{\"content-type\":\"application/json; charset=utf-8\"}});try{return await Ot({request:e,env:t,kv:s,now:Date.now()})}catch(i){\nreturn new Response(JSON.stringify({error:String(i&&i.message?i.message:i)},null,2),{status:500,headers:{\"content-type\":\"application/json; charset=utf-8\"}})}}};export{Xt as default};\n";
const WATCHDOG_SCRIPT = "function k(t){return Number.isFinite(t)?t>=1e3?1:t>=10?3:t>=1?4:t>=.01?5:7:4}const u=(t,e)=>Number.isFinite(t)?t.toFixed(e??4):\"\\u2014\",h=t=>Number.isFinite(t)?(t>=0?\"+\":\"\")+t.toFixed(2)+\"%\":\"\\u2014\",_=t=>Number.isFinite(t)?(t>=0?\"\":\"-\")+Math.abs(t).toFixed(2):\"\\u2014\";function D(t){return!Number.isFinite(t)||t<=0?\"\\u2014\":t>=1e9?(t/1e9).toFixed(2)+\"B\":t>=1e6?(t/1e6).toFixed(2)+\"M\":t>=1e3?(t/1e3).\ntoFixed(1)+\"K\":t.toFixed(0)}const E=t=>Number.isFinite(t)?t>=0?\"pos\":\"neg\":\"\";function F(t,e){if(!t)return\"\\u5C1A\\u672A\\u6383\\u63CF\";const s=Math.max(0,Math.round(((e??Date.now())-t)/1e3));return s<60?s+\" \\u79D2\\u524D\":Math.round(s/60)+\" \\u5206\\u9418\\u524D\"}const $=/^https:\\/\\/(?:\\w+\\.)?discord(?:app)?\\.com\\/api\\/webhooks\\/\\d+\\/[\\w-]+$/;function g(t){return typeof t==\"string\"&&$.test(t.trim())}function x(t){\nif(typeof t!=\"string\"||!t)return\"\\u672A\\u8A2D\\u5B9A\";const e=/\\/webhooks\\/(\\d+)\\//.exec(t);return e?`Webhook \\u2022\\u2022\\u2022\\u2022${e[1].slice(-4)}`:\"Webhook \\u2022\\u2022\\u2022\\u2022\"}function G(t){const e=k(t.lastPrice),s=t.isMeme?\"\\u8FF7\\u56E0\\u5E63\\uFF0F\\u9AD8\\u98A8\\u96AA\":\"\\u4E3B\\u5E63\",n=[`**${t.symbol}** \\xB7 ${s} \\xB7 \\u5B8C\\u6210\\u5EA6 ${t.score}`,`\\u9032\\u5834\\u689D\\u4EF6 ${t.readiness.\npassed}/${t.readiness.total} \\u5DF2\\u901A\\u904E`,\"\",`Entry\\u3000${u(t.entryLow,e)} \\u2013 ${u(t.entryHigh,e)}`,`SL\\u3000\\u3000${u(t.stopLoss,e)}`,`TP1\\u3000 ${u(t.takeProfit1,e)}\\u3000(1.5R)`,`TP2\\u3000 ${u(t.takeProfit2,e)}\\u3000(2.5R)`,\"\",`\\u8DDD\\u7A81\\u7834\\u9EDE ${h(t.breakoutDistancePct)}\\u3000\\u58D3\\u7E2E\\u6BD4 ${u(t.compressionRatio,3)}`,`\\u91CF\\u80FD ${u(t.volumeMultiple,2)}x\\u3000OI ${h(t.\noiChangePct)}`];return t.riskLabel&&n.push(\"\",`\\u26A0 ${t.riskLabel}`),n.push(\"\",\"\\u5B8C\\u6210\\u5EA6\\u4E0D\\u662F\\u52DD\\u7387\\u3002\\u9019\\u662F\\u6383\\u63CF\\u7D50\\u679C\\uFF0C\\u4E0D\\u662F\\u6295\\u8CC7\\u5EFA\\u8B70\\uFF0C\\u4E5F\\u4E0D\\u6703\\u81EA\\u52D5\\u4E0B\\u55AE\\u3002\"),n.push(t.bybitUrl),n.join(`\n`)}function L(t){const e=new Date(t.scannedAt).toISOString().replace(\"T\",\" \").slice(0,16);if(!t.ready.length)return`**Crypto Radar \\u6383\\u63CF\\u5B8C\\u6210** \\xB7 ${e} UTC\n\\u4E3B\\u5E63 ${t.mainCount} \\u6A94\\u3001\\u8FF7\\u56E0\\u5E63 ${t.memeCount} \\u6A94\\u5DF2\\u5206\\u6790\\uFF0C\\u76EE\\u524D\\u6C92\\u6709\\u7B26\\u5408\\u5168\\u90E8\\u9032\\u5834\\u689D\\u4EF6\\u7684\\u5019\\u9078\\u3002`;const s=t.ready.map(n=>`${n.symbol}(${n.score})`).join(\"\\u3001\");return`**Crypto Radar \\u6383\\u63CF\\u5B8C\\u6210** \\xB7 ${e} UTC\n\\u7B26\\u5408\\u5168\\u90E8\\u9032\\u5834\\u689D\\u4EF6\\uFF1A${s}\n\\u5B8C\\u6210\\u5EA6\\u4E0D\\u662F\\u52DD\\u7387\\uFF0C\\u8ACB\\u81EA\\u884C\\u78BA\\u8A8D\\u98A8\\u96AA\\u3002`}function U(t){const e=t.filter(n=>n.protection&&n.protection.level!==\"ok\");if(!e.length)return null;const s=[\"**\\u6301\\u5009\\u4FDD\\u8B77\\u6AA2\\u67E5**\",\"\"];for(const n of e)s.push(`${n.symbol} ${n.side===\"long\"?\"\\u591A\":\"\\u7A7A\"}\\u3000${n.protection.text}`);return s.push(\"\",\"\\u9019\\u662F\\u552F\\u8B80\\u6AA2\\u67E5\\uFF0C\\u672C\\u5DE5\\u5177\\u4E0D\\u6703\\u66FF\\u4F60\\u639B\\u55AE\\u6216\\u5E73\\u5009\\u3002\"),\ns.join(`\n`)}function I(){return`**Crypto Radar** \\u901A\\u77E5\\u6E2C\\u8A66\\u6210\\u529F\\u3002\n\\u672C\\u5DE5\\u5177\\u53EA\\u8B80\\u53D6 Bybit \\u516C\\u958B\\u884C\\u60C5\\u8207\\u552F\\u8B80\\u5E33\\u6236\\u8CC7\\u6599\\uFF0C\\u4E0D\\u6703\\u4E0B\\u55AE\\u3002`}function m(t){return`${t.symbol}:${t.entryReady?\"ready\":\"watch\"}:${t.stage}`}function K(t,e,s,n=60){const r={...e?.sent??{}},o=n*6e4,a=[];for(const l of t??[]){const c=m(l),f=r[c];(!Number.isFinite(f)||s-f>=o)&&(a.push(l),r[c]=s)}for(const l of Object.keys(\nr))s-r[l]>864e5&&delete r[l];return{toSend:a,state:{sent:r,lastSentAt:a.length?s:e?.lastSentAt??null}}}const p=1900;function S(t){const e=String(t??\"\");return{content:e.length>p?`${e.slice(0,p)}\\u2026`:e,allowed_mentions:{parse:[]}}}async function w(t,e,s){if(!g(e))return{ok:!1,error:\"Webhook \\u7DB2\\u5740\\u683C\\u5F0F\\u4E0D\\u6B63\\u78BA\"};try{return await t(e,S(s)),{ok:!0,error:null}}catch(n){return{\nok:!1,error:String(n&&n.message?n.message:n).split(e).join(\"[webhook]\")}}}const M=2,y=Object.freeze([0,60,360]);function d(){return{consecutiveMisses:0,lastAlertAt:null,alertCount:0,alerting:!1,checkedAt:null}}function N(t){const e=t.state??d(),s=t.now,n=[];if(!t.reachable)n.push(\"Guardian /health \\u7121\\u6CD5\\u9023\\u7DDA\");else{const i=t.health;!i||typeof i!=\"object\"?n.push(\"Guardian /health \\u56DE\\u61C9\\u683C\\u5F0F\\\n\\u4E0D\\u6B63\\u78BA\"):(i.ok!==!0&&n.push(`Guardian \\u72C0\\u614B\\u7570\\u5E38\\uFF1A${i.status??\"\\u672A\\u77E5\"}`),Number.isFinite(i.ageSeconds)&&i.ageSeconds>900&&n.push(`Guardian \\u5FC3\\u8DF3\\u5DF2 ${Math.round(i.ageSeconds/60)} \\u5206\\u9418\\u672A\\u66F4\\u65B0`),(i.heartbeatAt===null||i.heartbeatAt===void 0)&&n.push(\"Guardian \\u6C92\\u6709\\u56DE\\u5831\\u5FC3\\u8DF3\\u6642\\u9593\"))}const r=n.length>0,o={...e,\ncheckedAt:s};if(!r&&e.alerting)return{state:{consecutiveMisses:0,lastAlertAt:e.lastAlertAt,alertCount:0,alerting:!1,checkedAt:s},notify:!0,kind:\"recovery\",message:\"Guardian \\u5DF2\\u6062\\u5FA9\\u6B63\\u5E38\\u3002\\u5FC3\\u8DF3\\u8207\\u72C0\\u614B\\u5747\\u6B63\\u5E38\\u3002\",reasons:[]};if(!r)return{state:{...o,consecutiveMisses:0,alerting:!1},notify:!1,kind:\"none\",message:null,reasons:[]};const a=e.consecutiveMisses+\n1;if(a<M)return{state:{...o,consecutiveMisses:a},notify:!1,kind:\"none\",message:null,reasons:n};const l=Number.isFinite(e.lastAlertAt)?(s-e.lastAlertAt)/6e4:null,c=Math.min(e.alertCount,y.length-1),f=y[c];return e.alerting&&l!==null&&l<f?{state:{...o,consecutiveMisses:a},notify:!1,kind:\"none\",message:null,reasons:n}:{state:{consecutiveMisses:a,lastAlertAt:s,alertCount:e.alertCount+1,alerting:!0,checkedAt:s},\nnotify:!0,kind:\"alert\",message:`**Guardian \\u7570\\u5E38**\n${n.map(i=>`\\xB7 ${i}`).join(`\n`)}\n\n\\u9019\\u662F\\u76E3\\u63A7\\u901A\\u77E5\\uFF0C\\u5B88\\u885B\\u4E0D\\u6703\\u6539\\u52D5\\u4EFB\\u4F55\\u4EA4\\u6613\\u6216\\u98A8\\u96AA\\u8A2D\\u5B9A\\u3002`,reasons:n}}function C(t,e,s=25){if(!Number.isFinite(t))return{alive:!1,ageMinutes:null,detail:\"\\u5B88\\u885B\\u6C92\\u6709\\u56DE\\u5831\\u6642\\u9593\\uFF0C\\u53EF\\u80FD\\u672A\\u90E8\\u7F72\\u6216\\u5DF2\\u505C\\u6B62\"};const n=(e-t)/6e4;return n>s?{alive:!1,ageMinutes:n,detail:`\\\n\\u5B88\\u885B\\u5DF2 ${Math.round(n)} \\u5206\\u9418\\u672A\\u57F7\\u884C`}:{alive:!0,ageMinutes:n,detail:`\\u5B88\\u885B\\u6B63\\u5E38\\uFF0C${Math.round(n)} \\u5206\\u9418\\u524D\\u57F7\\u884C`}}const A=\"watchdog:state\";async function b(t){try{const e=await t.get(A);return e?JSON.parse(e):d()}catch{return d()}}async function O(t,e){const s=await fetch(t,{method:\"POST\",headers:{\"Content-Type\":\"application/json\"},\nbody:JSON.stringify(e)});if(!s.ok)throw new Error(\"Discord \\u56DE\\u61C9 HTTP \"+s.status)}async function R(t){try{const e=await fetch(t.replace(/\\/+$/,\"\")+\"/health\",{headers:{accept:\"application/json\"}});let s=null;try{s=await e.json()}catch{s=null}return{reachable:!0,httpStatus:e.status,health:s}}catch{return{reachable:!1,httpStatus:null,health:null}}}async function T(t,e,s){if(!t.GUARDIAN_URL)return{\nskipped:\"\\u7F3A\\u5C11 GUARDIAN_URL\"};const n=await b(e),r=await R(t.GUARDIAN_URL),o=N({state:n,now:s,reachable:r.reachable,health:r.health,httpStatus:r.httpStatus});if(await e.put(A,JSON.stringify(o.state)),o.notify&&g(t.DISCORD_WEBHOOK)){const a=await w(O,t.DISCORD_WEBHOOK,o.message);return{kind:o.kind,sent:a.ok,error:a.error,reasons:o.reasons}}return{kind:o.kind,sent:!1,error:null,reasons:o.reasons}}\nvar W={async scheduled(t,e,s){const n=e.WATCHDOG_KV;if(!n){console.log(\"\\u7F3A\\u5C11 KV \\u7D81\\u5B9A WATCHDOG_KV\\uFF0C\\u7565\\u904E\\u9019\\u4E00\\u8F2A\");return}const r=await T(e,n,Date.now());console.log(\"\\u5B88\\u885B\\u6AA2\\u67E5\\uFF1A\"+JSON.stringify(r))},async fetch(t,e,s){const n=e.WATCHDOG_KV,r={\"content-type\":\"application/json; charset=utf-8\",\"cache-control\":\"no-store\"};if(!n)return new Response(\nJSON.stringify({error:\"\\u7F3A\\u5C11 KV \\u7D81\\u5B9A WATCHDOG_KV\"},null,2),{status:500,headers:r});const o=await b(n),a=C(o.checkedAt,Date.now());return new Response(JSON.stringify({ok:a.alive,role:\"discord-heartbeat-watchdog\",guardianUrl:e.GUARDIAN_URL?\"\\u5DF2\\u8A2D\\u5B9A\":\"\\u672A\\u8A2D\\u5B9A\",discordConfigured:!!e.DISCORD_WEBHOOK,lastCheckedAt:o.checkedAt,lastCheckAgeMinutes:a.ageMinutes===null?null:\nMath.round(a.ageMinutes),alerting:o.alerting,consecutiveMisses:o.consecutiveMisses,detail:a.detail,note:\"\\u672C\\u670D\\u52D9\\u53EA\\u505A\\u76E3\\u63A7\\u8207\\u901A\\u77E5\\uFF0C\\u4E0D\\u6703\\u6539\\u52D5\\u4EFB\\u4F55\\u4EA4\\u6613\\u6216\\u98A8\\u96AA\\u8A2D\\u5B9A\\u3002\"},null,2),{status:a.alive?200:503,headers:r})}};export{W as default};\n";

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

