// Crypto Radar Guardian — Cloudflare Worker
// 引擎版本 10.0-standalone
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

/**
 * Bybit API 位址與環境
 *
 * Bybit 有三套互不相通的環境，各自發自己的 API Key：
 *   正式站    api.bybit.com
 *   模擬交易  api-demo.bybit.com    （Demo Trading，共用正式站的行情）
 *   測試網    api-testnet.bybit.com （獨立的行情與帳戶）
 *
 * 把模擬或測試網的 Key 拿去打正式站，Bybit 會回 retCode 10003
 * 「API key is invalid」—— 這不是簽章錯，是那個 host 根本不認得這把 Key。
 * 這是最常見的連接失敗原因，所以環境要讓使用者自己選。
 */

const BYBIT_ENVIRONMENTS = Object.freeze(['live', 'demo', 'testnet']);

const ENV_LABEL = Object.freeze({
  live: '正式站',
  demo: '模擬交易 Demo',
  testnet: '測試網 Testnet',
});

const PRIVATE_HOSTS = Object.freeze({
  live: 'https://api.bybit.com',
  demo: 'https://api-demo.bybit.com',
  testnet: 'https://api-testnet.bybit.com',
});

const PUBLIC_HOSTS = Object.freeze({
  // 模擬交易沒有自己的行情，直接用正式站的
  live: 'https://api.bybit.com',
  demo: 'https://api.bybit.com',
  testnet: 'https://api-testnet.bybit.com',
});

/** 公開行情預設走正式站 */
const BYBIT_BASE = PUBLIC_HOSTS.live;

function normalizeEnv(env) {
  return BYBIT_ENVIRONMENTS.includes(env) ? env : 'live';
}

function privateHostFor(env) {
  return PRIVATE_HOSTS[normalizeEnv(env)];
}

function publicHostFor(env) {
  return PUBLIC_HOSTS[normalizeEnv(env)];
}

/**
 * 清掉貼上時常見的雜訊：前後空白、換行、不斷行空格、零寬字元、BOM。
 *
 * 在 iPhone 上貼 API Key 很容易夾帶這些看不見的字元，
 * 而它們會讓 Key 比對失敗，錯誤訊息卻只說「invalid」，非常難查。
 */
function sanitizeCredential(value) {
  // \s 涵蓋一般空白與換行；另外明確列出貼上時常見的不可見字元：
  // U+00A0 不斷行空格、U+200B~U+200D 零寬字元、U+2060 word joiner、U+FEFF BOM
  return String(value ?? '').replace(/[\s\u00A0\u200B-\u200D\u2060\uFEFF]/g, '');
}

/**
 * 把 Bybit 的錯誤碼翻成看得懂、而且講得出下一步的說明。
 *
 * 只描述已知的對應關係，沒把握的就照實說不確定，不亂猜。
 */
function describeBybitError(retCode, retMsg, env) {
  const code = Number(retCode);
  const envName = ENV_LABEL[normalizeEnv(env)];
  const raw = retMsg ? `（${retMsg}）` : '';

  if (code === 10003) {
    return `目前連的是「${envName}」，但這個環境不認得這把 API Key${raw}。\n\n`
      + '最常見的原因是環境選錯：模擬交易與測試網各自發自己的 Key，不能拿去打正式站。\n'
      + '請確認你的 Key 是在哪裡建立的，回設定選單改選對應的環境。\n'
      + '若環境沒選錯，請檢查 Key 是否有多打或漏打字元、是否已被刪除或過期。';
  }
  if (code === 10004) {
    return `簽章驗證失敗${raw}。請確認 API Secret 有沒有貼錯或貼不完整。`;
  }
  if (code === 10002) {
    return `時間戳超出容許範圍${raw}。請到 iPhone 設定 → 一般 → 日期與時間，開啟「自動設定」。`;
  }
  if (code === 10005 || code === 10016) {
    return `這把 Key 沒有讀取權限${raw}。請在 Bybit 給它「帳戶查詢」與「持倉查詢」的唯讀權限。`;
  }
  if (code === 10010) {
    return `這把 Key 設了 IP 白名單，但目前的網路不在名單內${raw}。\n`
      + '手機的 IP 會變動，建議改用不綁 IP 的唯讀 Key，或把目前 IP 加進白名單。';
  }
  if (code === 10018) {
    return `請求頻率過高${raw}。請稍等一下再試。`;
  }
  if (code === 30086 || code === 3400026) {
    return `帳戶類型不符${raw}。這個查詢需要統一帳戶（Unified Trading Account）。`;
  }
  return `Bybit retCode ${retCode}${raw}`;
}

/**
 * format — 共用數值格式化
 *
 * 畫面（render.js）與通知（discord.js）都要把同一批數字寫成字串。
 * 抽在這裡，兩邊格式一致，也避免內嵌成單一作用域時重複宣告。
 */

/** 依價格量級決定小數位數，避免低價幣顯示成 0.0000 */
function priceDigits(p) {
  if (!Number.isFinite(p)) return 4;
  if (p >= 1000) return 1;
  if (p >= 10) return 3;
  if (p >= 1) return 4;
  if (p >= 0.01) return 5;
  return 7;
}

const fx = (v, d) => (Number.isFinite(v) ? v.toFixed(d ?? 4) : '—');

const fpct = (v) => (Number.isFinite(v) ? (v >= 0 ? '+' : '') + v.toFixed(2) + '%' : '—');

const fmoney = (v) => (Number.isFinite(v) ? (v >= 0 ? '' : '-') + Math.abs(v).toFixed(2) : '—');

function fusd(v) {
  if (!Number.isFinite(v) || v <= 0) return '—';
  if (v >= 1e9) return (v / 1e9).toFixed(2) + 'B';
  if (v >= 1e6) return (v / 1e6).toFixed(2) + 'M';
  if (v >= 1e3) return (v / 1e3).toFixed(1) + 'K';
  return v.toFixed(0);
}

/** CSS class 用的正負號 */
const sgn = (v) => (Number.isFinite(v) ? (v >= 0 ? 'pos' : 'neg') : '');

function ago(ts, now) {
  if (!ts) return '尚未掃描';
  const s = Math.max(0, Math.round(((now ?? Date.now()) - ts) / 1000));
  if (s < 60) return s + ' 秒前';
  return Math.round(s / 60) + ' 分鐘前';
}

/**
 * hmac-sha256 — 純 JavaScript 實作
 *
 * 為什麼自己寫：Scriptable 沒有 WebCrypto，也沒有 Node 的 crypto 模組，
 * 但 Bybit V5 的私有端點需要 HMAC-SHA256 簽章。
 *
 * 以 RFC 4231 的標準測試向量驗證（見 tests/hmac-sha256.test.mjs）。
 *
 * 這個檔案只做雜湊運算，不接觸也不儲存任何金鑰。
 */

/* ------------------------------------------------------------------ */
/* SHA-256                                                             */
/* ------------------------------------------------------------------ */

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const rotr = (x, n) => ((x >>> n) | (x << (32 - n))) >>> 0;

/** @param {Uint8Array} bytes @returns {Uint8Array} 32 bytes */
function sha256(bytes) {
  const H = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);

  const bitLen = bytes.length * 8;
  // 補位：0x80，然後補 0 到長度 ≡ 56 (mod 64)，最後 8 bytes 放位元長度
  const padded = new Uint8Array((((bytes.length + 8) >> 6) + 1) << 6);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  // 位元長度以 64 位元大端寫入；這裡用 float 拆高低 32 位元以支援 >512MB 以外的一般情形
  const hi = Math.floor(bitLen / 0x100000000);
  const lo = bitLen >>> 0;
  const dv = new DataView(padded.buffer);
  dv.setUint32(padded.length - 8, hi, false);
  dv.setUint32(padded.length - 4, lo, false);

  const w = new Uint32Array(64);

  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i += 1) w[i] = dv.getUint32(off + i * 4, false);
    for (let i = 16; i < 64; i += 1) {
      const s0 = (rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3)) >>> 0;
      const s1 = (rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10)) >>> 0;
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }

    let [a, b, c, d, e, f, g, h] = H;

    for (let i = 0; i < 64; i += 1) {
      const S1 = (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) >>> 0;
      const ch = ((e & f) ^ (~e & g)) >>> 0;
      const t1 = (h + S1 + ch + K[i] + w[i]) >>> 0;
      const S0 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) >>> 0;
      const maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
      const t2 = (S0 + maj) >>> 0;

      h = g; g = f; f = e;
      e = (d + t1) >>> 0;
      d = c; c = b; b = a;
      a = (t1 + t2) >>> 0;
    }

    H[0] = (H[0] + a) >>> 0; H[1] = (H[1] + b) >>> 0;
    H[2] = (H[2] + c) >>> 0; H[3] = (H[3] + d) >>> 0;
    H[4] = (H[4] + e) >>> 0; H[5] = (H[5] + f) >>> 0;
    H[6] = (H[6] + g) >>> 0; H[7] = (H[7] + h) >>> 0;
  }

  const out = new Uint8Array(32);
  const odv = new DataView(out.buffer);
  for (let i = 0; i < 8; i += 1) odv.setUint32(i * 4, H[i], false);
  return out;
}

/* ------------------------------------------------------------------ */
/* 編碼輔助                                                             */
/* ------------------------------------------------------------------ */

/** UTF-8 編碼，不依賴 TextEncoder（Scriptable 環境不保證有） */
function utf8Bytes(str) {
  const s = String(str);
  const out = [];
  for (let i = 0; i < s.length; i += 1) {
    let code = s.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < s.length) {
      const next = s.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
        i += 1;
      }
    }
    if (code < 0x80) {
      out.push(code);
    } else if (code < 0x800) {
      out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code < 0x10000) {
      out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    } else {
      out.push(
        0xf0 | (code >> 18), 0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f),
      );
    }
  }
  return new Uint8Array(out);
}

function toHex(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 1) s += bytes[i].toString(16).padStart(2, '0');
  return s;
}

function fromHex(hex) {
  const clean = String(hex).trim();
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(clean.substr(i * 2, 2), 16);
  return out;
}

/* ------------------------------------------------------------------ */
/* HMAC                                                                */
/* ------------------------------------------------------------------ */

const BLOCK_SIZE = 64;

/**
 * HMAC-SHA256。
 * @param {Uint8Array|string} key 金鑰。字串會以 UTF-8 編碼。
 * @param {Uint8Array|string} message 訊息。
 * @returns {Uint8Array} 32 bytes
 */
function hmacSha256(key, message) {
  let k = typeof key === 'string' ? utf8Bytes(key) : key;
  const m = typeof message === 'string' ? utf8Bytes(message) : message;

  if (k.length > BLOCK_SIZE) k = sha256(k);

  const padded = new Uint8Array(BLOCK_SIZE);
  padded.set(k);

  const inner = new Uint8Array(BLOCK_SIZE + m.length);
  const outerPrefix = new Uint8Array(BLOCK_SIZE);
  for (let i = 0; i < BLOCK_SIZE; i += 1) {
    inner[i] = padded[i] ^ 0x36;
    outerPrefix[i] = padded[i] ^ 0x5c;
  }
  inner.set(m, BLOCK_SIZE);

  const innerHash = sha256(inner);
  const outer = new Uint8Array(BLOCK_SIZE + 32);
  outer.set(outerPrefix);
  outer.set(innerHash, BLOCK_SIZE);

  return sha256(outer);
}

/** HMAC-SHA256 的十六進位字串，Bybit 簽章要的格式 */
function hmacSha256Hex(key, message) {
  return toHex(hmacSha256(key, message));
}

/**
 * bybit-private — Bybit V5 私有端點的唯讀存取
 *
 * 安全設計（對應交接規格三.6、三.7、十）：
 *
 * 1. 端點白名單。只有下面 PRIVATE_READ_ENDPOINTS 列出的 GET 端點可以呼叫。
 *    任何下單、改單、撤單、劃轉、提領端點都不在清單裡，呼叫會直接丟出例外。
 *    這是結構性限制，不是靠自律。
 *
 * 2. 憑證不進原始碼。API Key 與 Secret 由宿主環境提供（iPhone 版存在
 *    iOS Keychain），不寫進 Git、不寫進產生後的檔案、不出現在對話。
 *
 * 3. 建議使用唯讀 API Key。即使 Key 有交易權限，本模組也沒有下單路徑。
 *
 * 4. Secret 只用於計算簽章，不會被回傳、記錄或放進錯誤訊息。
 */



const RECV_WINDOW = '5000';

/**
 * 允許呼叫的私有端點。全部是 GET、全部唯讀。
 * 要新增端點必須同時通過 tests/bybit-private.test.mjs 的白名單測試。
 */
const PRIVATE_READ_ENDPOINTS = Object.freeze([
  '/v5/account/wallet-balance',
  '/v5/position/list',
  '/v5/position/closed-pnl',
  '/v5/execution/list',
  '/v5/order/realtime',
]);

/**
 * 明確禁止的端點型態。即使有人日後手滑加進白名單，
 * 這道檢查也會擋下來。
 */
const FORBIDDEN_PATTERNS = [
  /\/order\/create/i,
  /\/order\/amend/i,
  /\/order\/cancel/i,
  /\/order\/disconnected/i,
  /\/position\/set-/i,
  /\/position\/trading-stop/i,
  /\/position\/switch/i,
  /\/asset\/transfer/i,
  /\/asset\/withdraw/i,
  /\/account\/upgrade/i,
  /\/account\/set-/i,
  /\/user\//i,
];

class ForbiddenEndpointError extends Error {
  constructor(path) {
    super(`端點不在唯讀白名單內，拒絕呼叫：${path}`);
    this.name = 'ForbiddenEndpointError';
  }
}

/**
 * 端點守門。任何不在白名單、或命中禁止樣式的路徑都會丟出例外。
 */
function assertReadOnlyEndpoint(path) {
  const clean = String(path).split('?')[0];
  for (const pattern of FORBIDDEN_PATTERNS) {
    if (pattern.test(clean)) throw new ForbiddenEndpointError(clean);
  }
  if (!PRIVATE_READ_ENDPOINTS.includes(clean)) throw new ForbiddenEndpointError(clean);
  return clean;
}

/**
 * 依 Bybit V5 規則組出查詢字串。
 * 參數順序必須與實際送出的網址一致，否則簽章不會通過。
 */
function buildQueryString(params) {
  const keys = Object.keys(params ?? {}).filter((k) => {
    const v = params[k];
    return v !== undefined && v !== null && v !== '';
  });
  return keys.map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(String(params[k]))}`).join('&');
}

/**
 * Bybit V5 GET 簽章：
 *   payload = timestamp + apiKey + recvWindow + queryString
 *   sign    = HMAC_SHA256(secret, payload) 的十六進位字串
 *
 * @returns {{url: string, headers: Object, queryString: string}}
 */
function signGetRequest({ path, params, apiKey, apiSecret, timestamp, recvWindow, env }) {
  const cleanPath = assertReadOnlyEndpoint(path);

  if (typeof apiKey !== 'string' || apiKey.length === 0) throw new Error('缺少 API Key');
  if (typeof apiSecret !== 'string' || apiSecret.length === 0) throw new Error('缺少 API Secret');

  const ts = String(timestamp ?? Date.now());
  const recv = String(recvWindow ?? RECV_WINDOW);
  const queryString = buildQueryString(params);
  const payload = ts + apiKey + recv + queryString;
  const sign = hmacSha256Hex(apiSecret, payload);
  const host = env ? privateHostFor(env) : BYBIT_BASE;

  return {
    url: host + cleanPath + (queryString ? `?${queryString}` : ''),
    queryString,
    headers: {
      'X-BAPI-API-KEY': apiKey,
      'X-BAPI-TIMESTAMP': ts,
      'X-BAPI-RECV-WINDOW': recv,
      'X-BAPI-SIGN': sign,
      'X-BAPI-SIGN-TYPE': '2',
      accept: 'application/json',
    },
  };
}

/* ------------------------------------------------------------------ */
/* 回應正規化                                                           */
/* ------------------------------------------------------------------ */

const toNum = (v) => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : NaN;
};

/** /v5/account/wallet-balance → 統一帳戶權益摘要 */
function parseWalletBalance(result) {
  const account = result?.list?.[0];
  if (!account) return null;
  const usdt = (account.coin ?? []).find((c) => c.coin === 'USDT');
  return {
    accountType: account.accountType ?? null,
    totalEquityUsd: toNum(account.totalEquity),
    totalAvailableUsd: toNum(account.totalAvailableBalance),
    unrealizedPnlUsd: toNum(account.totalPerpUPL),
    usdtEquity: usdt ? toNum(usdt.equity) : NaN,
    usdtAvailable: usdt ? toNum(usdt.availableToWithdraw ?? usdt.walletBalance) : NaN,
  };
}

/** /v5/position/list → 目前持倉 */
function parsePositions(result) {
  return (result?.list ?? [])
    .map((p) => ({
      symbol: p.symbol,
      side: p.side === 'Buy' ? 'long' : p.side === 'Sell' ? 'short' : null,
      size: toNum(p.size),
      entryPrice: toNum(p.avgPrice),
      markPrice: toNum(p.markPrice),
      leverage: toNum(p.leverage),
      unrealizedPnl: toNum(p.unrealisedPnl),
      positionValue: toNum(p.positionValue),
      takeProfit: toNum(p.takeProfit),
      stopLoss: toNum(p.stopLoss),
      liqPrice: toNum(p.liqPrice),
    }))
    .filter((p) => Number.isFinite(p.size) && p.size > 0);
}

/** /v5/position/closed-pnl → 已平倉紀錄 */
function parseClosedPnl(result) {
  return (result?.list ?? []).map((r) => ({
    symbol: r.symbol,
    side: r.side === 'Buy' ? 'short' : 'long', // Bybit 記錄的是平倉方向，與開倉相反
    closedPnl: toNum(r.closedPnl),
    avgEntryPrice: toNum(r.avgEntryPrice),
    avgExitPrice: toNum(r.avgExitPrice),
    closedSize: toNum(r.closedSize),
    leverage: toNum(r.leverage),
    createdTime: toNum(r.createdTime),
  }));
}

/**
 * 持倉的保護單狀態。
 * TP 或 SL 任一缺漏都要在畫面上明確標示，這是交接規格反覆強調的保護。
 */
function protectionStatus(position) {
  const hasTp = Number.isFinite(position.takeProfit) && position.takeProfit > 0;
  const hasSl = Number.isFinite(position.stopLoss) && position.stopLoss > 0;
  if (hasTp && hasSl) return { level: 'ok', text: 'TP／SL 皆已設定' };
  if (hasSl) return { level: 'warn', text: '只有 SL，缺 TP' };
  if (hasTp) return { level: 'danger', text: '只有 TP，缺 SL' };
  return { level: 'danger', text: '沒有 TP 也沒有 SL' };
}

/** 依已平倉紀錄計算當日已實現損益 */
function realizedPnlSince(closedRecords, sinceMs) {
  const rows = (closedRecords ?? []).filter((r) => Number.isFinite(r.createdTime) && r.createdTime >= sinceMs);
  if (!rows.length) return { total: 0, count: 0 };
  return {
    total: rows.reduce((s, r) => s + (Number.isFinite(r.closedPnl) ? r.closedPnl : 0), 0),
    count: rows.length,
  };
}

/** 只顯示 Key 的前後幾碼，用於畫面確認，永遠不顯示完整值 */
function maskApiKey(apiKey) {
  const s = String(apiKey ?? '');
  if (s.length <= 8) return '••••';
  return `${s.slice(0, 4)}••••${s.slice(-4)}`;
}

/**
 * discord — Discord Webhook 通知
 *
 * 只做通知，不觸發任何交易動作（對應交接規格第八節的守衛原則）。
 *
 * Webhook URL 本身是機密：由宿主環境提供（iPhone 版存在 iOS Keychain），
 * 不寫進原始碼、不寫進 Git、不出現在通知內容或錯誤訊息裡。
 */


/** Discord Webhook 的合法網址型態 */
const WEBHOOK_PATTERN = /^https:\/\/(?:\w+\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]+$/;

function isValidWebhookUrl(url) {
  return typeof url === 'string' && WEBHOOK_PATTERN.test(url.trim());
}

/** 遮罩後的顯示字串，永遠不顯示完整 URL */
function maskWebhookUrl(url) {
  if (typeof url !== 'string' || !url) return '未設定';
  const m = /\/webhooks\/(\d+)\//.exec(url);
  return m ? `Webhook ••••${m[1].slice(-4)}` : 'Webhook ••••';
}

/* ------------------------------------------------------------------ */
/* 訊息組裝                                                             */
/* ------------------------------------------------------------------ */

/**
 * 單一候選的通知內容。
 *
 * 刻意不寫任何勝率、獲利或「必漲」字眼。
 * 只陳述掃描結果與機械換算出的參考價位。
 */
function candidateMessage(c) {
  const d = priceDigits(c.lastPrice);
  const group = c.isMeme ? '迷因幣／高風險' : '主幣';
  const lines = [
    `**${c.symbol}** · ${group} · 完成度 ${c.score}`,
    `進場條件 ${c.readiness.passed}/${c.readiness.total} 已通過`,
    '',
    `Entry　${fx(c.entryLow, d)} – ${fx(c.entryHigh, d)}`,
    `SL　　${fx(c.stopLoss, d)}`,
    `TP1　 ${fx(c.takeProfit1, d)}　(1.5R)`,
    `TP2　 ${fx(c.takeProfit2, d)}　(2.5R)`,
    '',
    `距突破點 ${fpct(c.breakoutDistancePct)}　壓縮比 ${fx(c.compressionRatio, 3)}`,
    `量能 ${fx(c.volumeMultiple, 2)}x　OI ${fpct(c.oiChangePct)}`,
  ];
  if (c.riskLabel) lines.push('', `⚠ ${c.riskLabel}`);
  lines.push('', '完成度不是勝率。這是掃描結果，不是投資建議，也不會自動下單。');
  lines.push(c.bybitUrl);
  return lines.join('\n');
}

/**
 * 掃描摘要通知。
 * @param {{ready: Array, mainCount: number, memeCount: number, scannedAt: number}} summary
 */
function summaryMessage(summary) {
  const when = new Date(summary.scannedAt).toISOString().replace('T', ' ').slice(0, 16);
  if (!summary.ready.length) {
    return `**Crypto Radar 掃描完成** · ${when} UTC\n主幣 ${summary.mainCount} 檔、迷因幣 ${summary.memeCount} 檔已分析，目前沒有符合全部進場條件的候選。`;
  }
  const names = summary.ready.map((c) => `${c.symbol}(${c.score})`).join('、');
  return `**Crypto Radar 掃描完成** · ${when} UTC\n符合全部進場條件：${names}\n完成度不是勝率，請自行確認風險。`;
}

/** 帳戶保護單缺漏的警示 */
function protectionAlertMessage(positions) {
  const bad = positions.filter((p) => p.protection && p.protection.level !== 'ok');
  if (!bad.length) return null;
  const lines = ['**持倉保護檢查**', ''];
  for (const p of bad) {
    lines.push(`${p.symbol} ${p.side === 'long' ? '多' : '空'}　${p.protection.text}`);
  }
  lines.push('', '這是唯讀檢查，本工具不會替你掛單或平倉。');
  return lines.join('\n');
}

function testMessage() {
  return '**Crypto Radar** 通知測試成功。\n本工具只讀取 Bybit 公開行情與唯讀帳戶資料，不會下單。';
}

/* ------------------------------------------------------------------ */
/* 去重與節流                                                           */
/* ------------------------------------------------------------------ */

/** 一則通知的識別碼：同一標的、同一狀態不重複發 */
function notificationKey(c) {
  return `${c.symbol}:${c.entryReady ? 'ready' : 'watch'}:${c.stage}`;
}

/**
 * 決定這一輪要發哪些通知。
 *
 * @param {Array} readyCandidates 目前符合全部進場條件的候選
 * @param {{sent: Object, lastSentAt: number}} state 先前狀態
 * @param {number} now
 * @param {number} cooldownMinutes 同一標的的重複通知間隔
 */
function selectNotifications(readyCandidates, state, now, cooldownMinutes = 60) {
  const sent = { ...(state?.sent ?? {}) };
  const cooldownMs = cooldownMinutes * 60_000;
  const toSend = [];

  for (const c of readyCandidates ?? []) {
    const key = notificationKey(c);
    const last = sent[key];
    if (!Number.isFinite(last) || now - last >= cooldownMs) {
      toSend.push(c);
      sent[key] = now;
    }
  }

  // 清掉超過一天的舊紀錄，避免狀態無限成長
  for (const key of Object.keys(sent)) {
    if (now - sent[key] > 86_400_000) delete sent[key];
  }

  return { toSend, state: { sent, lastSentAt: toSend.length ? now : (state?.lastSentAt ?? null) } };
}

/* ------------------------------------------------------------------ */
/* 送出                                                                */
/* ------------------------------------------------------------------ */

const MAX_CONTENT_LENGTH = 1900;

function buildPayload(content) {
  const text = String(content ?? '');
  return {
    content: text.length > MAX_CONTENT_LENGTH ? `${text.slice(0, MAX_CONTENT_LENGTH)}…` : text,
    allowed_mentions: { parse: [] },
  };
}

/**
 * 送出一則通知。
 *
 * @param {(url: string, payload: Object) => Promise<any>} post 由宿主環境注入的 POST 實作
 * @returns {Promise<{ok: boolean, error: string|null}>} 永遠不把 webhook URL 放進回傳
 */
async function sendNotification(post, webhookUrl, content) {
  if (!isValidWebhookUrl(webhookUrl)) {
    return { ok: false, error: 'Webhook 網址格式不正確' };
  }
  try {
    await post(webhookUrl, buildPayload(content));
    return { ok: true, error: null };
  } catch (err) {
    const raw = String((err && err.message) ? err.message : err);
    // 錯誤訊息可能被記錄，先把 webhook URL 從裡面清掉
    return { ok: false, error: raw.split(webhookUrl).join('[webhook]') };
  }
}

/**
 * scan-engine — Crypto Radar Guardian 獨立版掃描引擎
 *
 * 純邏輯，不碰 DOM，可在瀏覽器與 node 測試中共用。
 * 由 scripts/build-standalone-app.mjs 內嵌進 public/crypto-radar-guardian.html。
 * 修改本檔後必須重新執行產生器，不要手改產生後的 HTML。
 *
 * 資料來源一律是 Bybit 公開行情端點，不需要 API Key：
 *   /v5/market/instruments-info
 *   /v5/market/tickers
 *   /v5/market/kline
 *   /v5/market/open-interest
 *   /v5/market/orderbook
 *
 * 本引擎只做研究與觀察，不下單、不連接帳戶、不處理任何金鑰。
 */


{ BYBIT_BASE };
const PROVIDER = 'Bybit Pre-Breakout';
const ENGINE_VERSION = '10.0-standalone';

/* ------------------------------------------------------------------ */
/* 門檻常數                                                             */
/* ------------------------------------------------------------------ */

const UNIVERSE = Object.freeze({
  minTurnover24hUsd: 500_000,
  minOpenInterestUsd: 100_000,
  minListedHours: 24,
  maxListedHours: 24 * 365 * 3,
  maxSpreadPct: 0.6,
  minChange24hPct: -12,
  maxChange24hPct: 10,
  minRangePosition: 0.35,
  maxRangePosition: 0.96,
  maxDetailedAnalysis: 12,
});

const BLOWN_OFF = Object.freeze({
  maxChange24hPct: 10,
  maxChange1hPct: 4,
  maxChange6hPct: 10,
  maxBreakoutOvershootPct: 0.8,
  maxVolumeMultiple: 5,
  maxBreakoutDistancePct: 4,
  maxCompressionRatio: 1.2,
  maxAbsFundingRatePct: 0.15,
});

const ENTRY = Object.freeze({
  minScore: 80,
  minBreakoutDistancePct: -0.25,
  maxBreakoutDistancePct: 2,
  maxCompressionRatio: 0.95,
  minVolumeMultiple: 1.1,
  maxVolumeMultiple: 3,
  minOiChangePct: 0.25,
  maxOiChangePct: 5,
  minChange1hPct: -1,
  maxChange1hPct: 2.5,
  minChange6hPct: -3,
  maxChange6hPct: 6,
  maxDataAgeMinutes: 45,
  staleWarningMinutes: 15,
});

const MAX_DISPLAYED = 8;

const EXPLICIT_MEME_BASES = Object.freeze([
  'PEPE', 'DOGE', 'SHIB', 'WIF', 'BONK', 'FLOKI', 'TRUMP',
]);

const MAJOR_BASES = Object.freeze([
  'BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'ADA', 'AVAX', 'LINK', 'LTC', 'DOT',
  'ATOM', 'ARB', 'OP', 'MATIC', 'TON', 'TRX', 'NEAR', 'APT', 'SUI', 'INJ',
  'FIL', 'ETC', 'BCH', 'UNI', 'AAVE', 'XLM', 'ICP', 'HBAR', 'VET', 'ALGO',
]);

const MEME_FIXED_RISK_PERCENT = 0.15;

/**
 * 主幣固定觀察清單。
 *
 * 這幾檔不論有沒有擠進第一階段排名都會被分析，
 * 因為使用者要的是「隨時看得到主幣狀態」，而不是等它剛好符合快噴型態。
 */
const MAIN_WATCHLIST = Object.freeze(['BTCUSDT', 'ETHUSDT', 'SOLUSDT']);

/**
 * 分組：主幣 或 迷因幣／高風險。
 *
 * 主幣 = 在觀察清單內，或被判定為主流標的。
 * 其餘一律歸到迷因幣／高風險（含判斷不出來而 fail-safe 的標的）。
 */
function coinGroup(symbol, isMeme, watchlist) {
  const list = watchlist ?? MAIN_WATCHLIST;
  if (list.includes(String(symbol).toUpperCase())) return 'main';
  return isMeme ? 'meme' : 'main';
}

const STABLECOINS = new Set(['USDC', 'USDT', 'DAI', 'TUSD', 'FDUSD', 'USDE', 'PYUSD', 'BUSD', 'USDD']);

/* ------------------------------------------------------------------ */
/* 小工具                                                              */
/* ------------------------------------------------------------------ */

const num = (v) => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : NaN;
};

const mean = (arr) => (arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : NaN);

function normalizeBase(symbol) {
  return String(symbol).toUpperCase().replace(/USDT$/, '').replace(/^(1000000|10000|1000)/, '');
}

function bybitContractUrl(symbol) {
  return `${'https://www.bybit.com/trade/usdt/'}${encodeURIComponent(String(symbol).toUpperCase())}`;
}

function classifyMeme(symbol, listedDays, turnoverUsd, oiUsd) {
  const base = normalizeBase(symbol);
  if (EXPLICIT_MEME_BASES.includes(base)) {
    return { isMeme: true, confidence: 'high', reasons: [`${base} 在明確迷因幣清單內`] };
  }
  if (MAJOR_BASES.includes(base)) {
    return { isMeme: false, confidence: 'high', reasons: [`${base} 在主流標的清單內`] };
  }
  const reasons = [];
  if (/^(1000000|10000|1000)[A-Z]/.test(String(symbol).toUpperCase())) {
    reasons.push('帶有面額前綴，屬極低單價標的');
  }
  if (Number.isFinite(listedDays) && listedDays < 180) {
    reasons.push(`上線僅 ${Math.round(listedDays)} 天`);
  }
  if (Number.isFinite(turnoverUsd) && Number.isFinite(oiUsd) && oiUsd > 0 && turnoverUsd / oiUsd > 8) {
    reasons.push(`成交額為未平倉值的 ${(turnoverUsd / oiUsd).toFixed(1)} 倍`);
  }
  if (reasons.length >= 2) return { isMeme: true, confidence: 'medium', reasons };
  if (reasons.length === 1) return { isMeme: true, confidence: 'low', reasons };
  return { isMeme: true, confidence: 'low', reasons: [`${base} 不在已知主流清單內，依保守原則套用相同風控`] };
}

/**
 * 風控標籤。
 *
 * 只有高信心才可以在畫面上斷言「這是迷因幣」。
 * 低信心是「不在已知主流清單內」的保守處理，把它寫成迷因幣是不實陳述。
 */
function riskLabel(meme) {
  if (!meme.isMeme) return null;
  if (meme.confidence === 'high') return '迷因幣 · 固定 0.15% 防守倉';
  if (meme.confidence === 'medium') return '疑似迷因幣 · 保守 0.15% 倉位';
  return '未列入主流 · 保守 0.15% 倉位';
}

/* ------------------------------------------------------------------ */
/* 第一階段：宇宙篩選                                                    */
/* ------------------------------------------------------------------ */

/**
 * 合併 instruments-info 與 tickers，算出第一階段所需欄位。
 * 只保留 Bybit USDT 線性永續，排除穩定幣。
 */
function buildUniverse(instruments, tickers, now = Date.now()) {
  const tickerBySymbol = new Map();
  for (const t of tickers ?? []) tickerBySymbol.set(t.symbol, t);

  const rows = [];
  for (const inst of instruments ?? []) {
    if (inst.status && inst.status !== 'Trading') continue;
    if (inst.quoteCoin !== 'USDT') continue;
    if (inst.contractType && !/LinearPerpetual/i.test(inst.contractType)) continue;
    if (STABLECOINS.has(normalizeBase(inst.symbol))) continue;

    const t = tickerBySymbol.get(inst.symbol);
    if (!t) continue;

    const last = num(t.lastPrice);
    const bid = num(t.bid1Price);
    const ask = num(t.ask1Price);
    const high = num(t.highPrice24h);
    const low = num(t.lowPrice24h);
    const turnover = num(t.turnover24h);
    const oiValue = num(t.openInterestValue);
    const change24hPct = num(t.price24hPcnt) * 100;
    const fundingRatePct = num(t.fundingRate) * 100;
    const launchMs = num(inst.launchTime);

    if (!Number.isFinite(last) || last <= 0) continue;

    const spreadPct = Number.isFinite(bid) && Number.isFinite(ask) && bid > 0 && ask > 0
      ? ((ask - bid) / ((ask + bid) / 2)) * 100
      : NaN;
    const rangePosition24h = Number.isFinite(high) && Number.isFinite(low) && high > low
      ? (last - low) / (high - low)
      : NaN;
    const listedHours = Number.isFinite(launchMs) && launchMs > 0 ? (now - launchMs) / 3_600_000 : NaN;

    rows.push({
      symbol: inst.symbol,
      lastPrice: last,
      turnover24hUsd: turnover,
      openInterestUsd: oiValue,
      listedHours,
      listedDays: Number.isFinite(listedHours) ? listedHours / 24 : NaN,
      spreadPct,
      change24hPct,
      rangePosition24h,
      fundingRatePct,
      high24h: high,
      low24h: low,
    });
  }
  return rows;
}

function passesUniverseFilter(r) {
  return (
    Number.isFinite(r.turnover24hUsd) && r.turnover24hUsd >= UNIVERSE.minTurnover24hUsd &&
    Number.isFinite(r.openInterestUsd) && r.openInterestUsd >= UNIVERSE.minOpenInterestUsd &&
    Number.isFinite(r.listedHours) &&
    r.listedHours >= UNIVERSE.minListedHours && r.listedHours <= UNIVERSE.maxListedHours &&
    Number.isFinite(r.spreadPct) && r.spreadPct <= UNIVERSE.maxSpreadPct &&
    Number.isFinite(r.change24hPct) &&
    r.change24hPct >= UNIVERSE.minChange24hPct && r.change24hPct <= UNIVERSE.maxChange24hPct &&
    Number.isFinite(r.rangePosition24h) &&
    r.rangePosition24h >= UNIVERSE.minRangePosition && r.rangePosition24h <= UNIVERSE.maxRangePosition
  );
}

/**
 * 第一階段排序：越接近「壓縮後貼近前高」越優先。
 * 這裡還沒有 K 線，只能用 24H 區間位置與成交額做初排。
 */
function rankUniverse(rows) {
  return [...rows].sort((a, b) => {
    const score = (r) => r.rangePosition24h * 0.7 + Math.min(1, Math.log10(Math.max(r.turnover24hUsd, 1)) / 9) * 0.3;
    return score(b) - score(a);
  }).slice(0, UNIVERSE.maxDetailedAnalysis);
}

/**
 * 決定要詳細分析哪些標的。
 *
 * 主幣觀察清單一律納入（即使沒通過第一階段門檻，使用者仍要看到它的狀態）。
 * 其餘標的走正常的第一階段篩選與排名，最多取 UNIVERSE.maxDetailedAnalysis 檔。
 */
function selectTargets(rows, watchlist) {
  const list = (watchlist ?? MAIN_WATCHLIST).map((s) => s.toUpperCase());
  const bySymbol = new Map();
  for (const r of rows ?? []) bySymbol.set(String(r.symbol).toUpperCase(), r);

  const main = [];
  for (const symbol of list) {
    const row = bySymbol.get(symbol);
    if (row) main.push(row);
  }

  const rest = (rows ?? []).filter((r) => !list.includes(String(r.symbol).toUpperCase()));
  const scan = rankUniverse(rest.filter(passesUniverseFilter));

  return { main, scan, all: [...main, ...scan] };
}

/* ------------------------------------------------------------------ */
/* 第二階段：K 線與未平倉量指標                                          */
/* ------------------------------------------------------------------ */

/**
 * Bybit kline 回傳為新到舊的陣列：
 * [startTime, open, high, low, close, volume, turnover]
 * 這裡轉成舊到新，方便計算。
 */
function parseKlines(list) {
  return (list ?? [])
    .map((k) => ({
      t: num(k[0]), open: num(k[1]), high: num(k[2]), low: num(k[3]),
      close: num(k[4]), volume: num(k[5]),
    }))
    .filter((k) => Number.isFinite(k.close) && Number.isFinite(k.high) && Number.isFinite(k.low))
    .sort((a, b) => a.t - b.t);
}

/** Bybit open-interest 回傳新到舊，轉成舊到新 */
function parseOpenInterest(list) {
  return (list ?? [])
    .map((o) => ({ t: num(o.timestamp), oi: num(o.openInterest) }))
    .filter((o) => Number.isFinite(o.oi))
    .sort((a, b) => a.t - b.t);
}

/**
 * 由 15m K 線計算詳細指標。
 * 資料不足時對應欄位為 NaN，後續閘門會因此判定未通過（fail-safe）。
 */
function computeMetrics(klines, oiSeries) {
  const n = klines.length;
  const last = klines[n - 1];
  const closeAt = (back) => (n - 1 - back >= 0 ? klines[n - 1 - back].close : NaN);

  const pctChange = (from, to) => (Number.isFinite(from) && from > 0 && Number.isFinite(to) ? ((to - from) / from) * 100 : NaN);

  // 15m K 線：1H = 4 根，6H = 24 根
  const change1hPct = pctChange(closeAt(4), last?.close);
  const change6hPct = pctChange(closeAt(24), last?.close);

  // 壓縮比：最近 8 根的平均實體區間 ÷ 更早 24 根的平均實體區間
  const ranges = klines.map((k) => (k.high - k.low) / (k.close || 1));
  const recentRange = mean(ranges.slice(-8));
  const baseRange = mean(ranges.slice(-32, -8));
  const compressionRatio = Number.isFinite(recentRange) && Number.isFinite(baseRange) && baseRange > 0
    ? recentRange / baseRange
    : NaN;

  // 量能倍率：最近 3 根均量 ÷ 更早 20 根均量
  const vols = klines.map((k) => k.volume).filter(Number.isFinite);
  const recentVol = mean(vols.slice(-3));
  const baseVol = mean(vols.slice(-23, -3));
  const volumeMultiple = Number.isFinite(recentVol) && Number.isFinite(baseVol) && baseVol > 0
    ? recentVol / baseVol
    : NaN;

  // 距突破點：前高取「不含最後 2 根」的最高價
  const priorHighs = klines.slice(0, Math.max(0, n - 2)).map((k) => k.high).filter(Number.isFinite);
  const priorHigh = priorHighs.length ? Math.max(...priorHighs) : NaN;
  const breakoutDistancePct = Number.isFinite(priorHigh) && Number.isFinite(last?.close) && last.close > 0
    ? ((priorHigh - last.close) / last.close) * 100
    : NaN;

  // 未平倉量變化
  const oiFirst = oiSeries[0]?.oi;
  const oiLast = oiSeries[oiSeries.length - 1]?.oi;
  const oiChangePct = Number.isFinite(oiFirst) && oiFirst > 0 && Number.isFinite(oiLast)
    ? ((oiLast - oiFirst) / oiFirst) * 100
    : NaN;

  // 資料年齡要算「最後一根 K 線收盤後過了多久」，不是它的開盤時間。
  // 用開盤時間會讓正在形成中的 K 線一律顯示成 0～15 分鐘舊，
  // 在 15 分鐘門檻上反覆誤報。餵得上資料時這個值應該接近 0。
  const intervalMs = n >= 2 && Number.isFinite(klines[n - 1].t) && Number.isFinite(klines[n - 2].t)
    ? klines[n - 1].t - klines[n - 2].t
    : NaN;
  const dataAgeMinutes = Number.isFinite(last?.t) && Number.isFinite(intervalMs)
    ? Math.max(0, (Date.now() - (last.t + intervalMs)) / 60_000)
    : NaN;

  return {
    change1hPct, change6hPct, compressionRatio, volumeMultiple,
    breakoutDistancePct, oiChangePct, priorHigh,
    lastClose: last?.close ?? NaN,
    dataAgeMinutes,
    intervalMs,
    candleCount: n,
  };
}

/* ------------------------------------------------------------------ */
/* 評分                                                                */
/* ------------------------------------------------------------------ */

/**
 * 完成度分數：衡量「壓縮 + 溫和放量 + OI 增加 + 貼近突破點」的成熟度。
 *
 * 這個分數不是勝率，也不是報酬預期。畫面上必須同時顯示就緒度與阻擋原因。
 */
function computeScore(m) {
  const parts = [];
  const add = (weight, value) => { if (Number.isFinite(value)) parts.push({ weight, value: Math.max(0, Math.min(1, value)) }); };

  // 壓縮越緊越高分：0.5 以下滿分，1.2 以上零分
  add(30, (1.2 - m.compressionRatio) / 0.7);
  // 量能溫和放大最理想落在 1.1~3；過低或暴衝都扣分
  if (Number.isFinite(m.volumeMultiple)) {
    const v = m.volumeMultiple;
    const volScore = v < 1 ? v * 0.5 : v <= 2 ? 1 : v <= 3 ? 1 - (v - 2) * 0.3 : Math.max(0, 0.7 - (v - 3) * 0.35);
    add(25, volScore);
  }
  // 距突破點 0~2% 最理想
  if (Number.isFinite(m.breakoutDistancePct)) {
    const d = m.breakoutDistancePct;
    const distScore = d < -0.8 ? 0 : d <= 2 ? 1 - Math.abs(d - 0.6) / 2.6 : Math.max(0, 1 - (d - 2) / 3);
    add(25, distScore);
  }
  // OI 增加 0.25%~5% 最理想
  if (Number.isFinite(m.oiChangePct)) {
    const o = m.oiChangePct;
    const oiScore = o < 0 ? 0 : o <= 5 ? Math.min(1, o / 2) : Math.max(0, 1 - (o - 5) / 5);
    add(20, oiScore);
  }

  const totalWeight = parts.reduce((s, p) => s + p.weight, 0);
  if (totalWeight === 0) return 0;
  const raw = parts.reduce((s, p) => s + p.weight * p.value, 0) / totalWeight;
  return Math.round(raw * 100);
}

function deriveStage(score, m) {
  if (!Number.isFinite(m.breakoutDistancePct)) return 'WATCH';
  if (m.breakoutDistancePct < -BLOWN_OFF.maxBreakoutOvershootPct) return 'EXCLUDED';
  if (score >= ENTRY.minScore && m.breakoutDistancePct <= ENTRY.maxBreakoutDistancePct) return 'NEAR_BREAKOUT';
  if (score >= 60) return 'BUILDING';
  return 'WATCH';
}

const STAGE_LABEL = Object.freeze({
  NEAR_BREAKOUT: '接近突破',
  BUILDING: '醞釀中',
  WATCH: '觀察',
  EXCLUDED: '已排除',
});

/* ------------------------------------------------------------------ */
/* 閘門                                                                */
/* ------------------------------------------------------------------ */

const pctFmt = (v) => (Number.isFinite(v) ? `${v.toFixed(2)}%` : '無資料');
const mulFmt = (v) => (Number.isFinite(v) ? `${v.toFixed(3)} 倍` : '無資料');
const numFmt = (v) => (Number.isFinite(v) ? v.toFixed(3) : '無資料');

const inR = (v, lo, hi) => Number.isFinite(v) && v >= lo && v <= hi;

/** 十道進場閘門。任一項讀不到值即判定未通過。 */
function evaluateEntryGates(c) {
  const g = (id, label, passed, actualText, requirement) => ({
    id, label, passed, actualText, requirement,
    reason: passed ? null : `${label} ${actualText}（需 ${requirement}）`,
  });

  const gates = [
    g('score', '分數', Number.isFinite(c.score) && c.score >= ENTRY.minScore,
      Number.isFinite(c.score) ? `${c.score} 分` : '無資料', `≥ ${ENTRY.minScore} 分`),
    g('stage', '等級', c.stage === 'NEAR_BREAKOUT', STAGE_LABEL[c.stage] ?? '無資料', '接近突破'),
    g('breakout', '距突破點', inR(c.breakoutDistancePct, ENTRY.minBreakoutDistancePct, ENTRY.maxBreakoutDistancePct),
      pctFmt(c.breakoutDistancePct), `${ENTRY.minBreakoutDistancePct}% ～ ${ENTRY.maxBreakoutDistancePct}%`),
    g('compression', '15m 壓縮比', Number.isFinite(c.compressionRatio) && c.compressionRatio <= ENTRY.maxCompressionRatio,
      numFmt(c.compressionRatio), `≤ ${ENTRY.maxCompressionRatio}`),
    g('volume', '量能', inR(c.volumeMultiple, ENTRY.minVolumeMultiple, ENTRY.maxVolumeMultiple),
      mulFmt(c.volumeMultiple), `${ENTRY.minVolumeMultiple} ～ ${ENTRY.maxVolumeMultiple} 倍`),
    g('oi', 'OI 變化', inR(c.oiChangePct, ENTRY.minOiChangePct, ENTRY.maxOiChangePct),
      pctFmt(c.oiChangePct), `${ENTRY.minOiChangePct}% ～ ${ENTRY.maxOiChangePct}%`),
    g('change1h', '1H 漲跌', inR(c.change1hPct, ENTRY.minChange1hPct, ENTRY.maxChange1hPct),
      pctFmt(c.change1hPct), `${ENTRY.minChange1hPct}% ～ ${ENTRY.maxChange1hPct}%`),
    g('change6h', '6H 漲跌', inR(c.change6hPct, ENTRY.minChange6hPct, ENTRY.maxChange6hPct),
      pctFmt(c.change6hPct), `${ENTRY.minChange6hPct}% ～ ${ENTRY.maxChange6hPct}%`),
    g('risk', '風險標記', (c.riskFlags ?? []).length === 0,
      (c.riskFlags ?? []).length ? `${c.riskFlags.length} 項` : '無', '無風險標記'),
    g('fresh', '資料年齡', Number.isFinite(c.dataAgeMinutes) && c.dataAgeMinutes <= ENTRY.maxDataAgeMinutes,
      Number.isFinite(c.dataAgeMinutes) ? `${Math.round(c.dataAgeMinutes)} 分鐘` : '無資料',
      `≤ ${ENTRY.maxDataAgeMinutes} 分鐘`),
  ];

  const failed = gates.filter((x) => !x.passed);
  return {
    gates,
    ready: failed.length === 0,
    reasons: failed.map((x) => x.reason),
    readiness: { passed: gates.length - failed.length, total: gates.length },
  };
}

/** 已經噴出的直接排除 */
function blownOffReasons(c) {
  const out = [];
  if (c.change24hPct > BLOWN_OFF.maxChange24hPct) out.push(`24H 漲幅 ${pctFmt(c.change24hPct)} 已超過 ${BLOWN_OFF.maxChange24hPct}%`);
  if (c.change1hPct > BLOWN_OFF.maxChange1hPct) out.push(`1H 漲幅 ${pctFmt(c.change1hPct)} 已超過 ${BLOWN_OFF.maxChange1hPct}%`);
  if (c.change6hPct > BLOWN_OFF.maxChange6hPct) out.push(`6H 漲幅 ${pctFmt(c.change6hPct)} 已超過 ${BLOWN_OFF.maxChange6hPct}%`);
  if (c.breakoutDistancePct < -BLOWN_OFF.maxBreakoutOvershootPct) out.push(`已突破前高 ${Math.abs(c.breakoutDistancePct).toFixed(2)}%`);
  if (c.volumeMultiple > BLOWN_OFF.maxVolumeMultiple) out.push(`量能 ${mulFmt(c.volumeMultiple)} 已暴衝`);
  if (c.breakoutDistancePct > BLOWN_OFF.maxBreakoutDistancePct) out.push(`距突破點仍有 ${pctFmt(c.breakoutDistancePct)}`);
  if (c.compressionRatio > BLOWN_OFF.maxCompressionRatio) out.push(`壓縮比 ${numFmt(c.compressionRatio)} 過大`);
  if (Math.abs(c.fundingRatePct) > BLOWN_OFF.maxAbsFundingRatePct) out.push(`資金費率 ${c.fundingRatePct.toFixed(4)}% 過度極端`);
  return out;
}

/* ------------------------------------------------------------------ */
/* TP／SL 與盤口深度                                                    */
/* ------------------------------------------------------------------ */

/** SL 取「近期低點再退一點」與固定百分比之中較保守者 */
/**
 * 建議停損：以近期擺動低點再退 0.2% 為基準，
 * 並把風險寬度夾在現價的 0.5%～2.5% 之間。
 *
 * 太緊會被雜訊掃掉，太寬會讓 1.5R 的 TP1 距離失真。
 * 取不到 K 線時退回固定 1.5%。
 */
function suggestStop(lastClose, klines) {
  if (!Number.isFinite(lastClose) || lastClose <= 0) return NaN;

  const MIN_RISK_PCT = 0.5;
  const MAX_RISK_PCT = 2.5;

  const lows = (klines ?? []).slice(-12).map((k) => k.low).filter(Number.isFinite);
  const swingLow = lows.length ? Math.min(...lows) : NaN;
  const structural = Number.isFinite(swingLow) ? swingLow * 0.998 : lastClose * 0.985;

  const riskPct = ((lastClose - structural) / lastClose) * 100;
  const clamped = Math.min(MAX_RISK_PCT, Math.max(MIN_RISK_PCT, riskPct));
  return lastClose * (1 - clamped / 100);
}

function buildTargets(entry, stop) {
  if (!Number.isFinite(entry) || !Number.isFinite(stop)) return null;
  const risk = entry - stop;
  if (!(risk > 0)) return null;
  return { riskPerUnit: risk, takeProfit1: entry + risk * 1.5, takeProfit2: entry + risk * 2.5 };
}

function parseOrderbook(result) {
  const toLevels = (rows) => (rows ?? [])
    .map(([p, s]) => ({ price: num(p), size: num(s) }))
    .filter((l) => Number.isFinite(l.price) && Number.isFinite(l.size) && l.price > 0 && l.size > 0);
  return {
    bids: toLevels(result?.b).sort((a, b) => b.price - a.price),
    asks: toLevels(result?.a).sort((a, b) => a.price - b.price),
  };
}

function assessDepth(book, bandPct = 0.3) {
  const bestBid = book.bids[0]?.price;
  const bestAsk = book.asks[0]?.price;
  if (!Number.isFinite(bestBid) || !Number.isFinite(bestAsk)) {
    return { mid: NaN, bidUsd: 0, askUsd: 0, thinnerSideUsd: 0 };
  }
  const mid = (bestBid + bestAsk) / 2;
  const EPS = 1e-9;
  const lower = mid * (1 - bandPct / 100) * (1 - EPS);
  const upper = mid * (1 + bandPct / 100) * (1 + EPS);
  const bidUsd = book.bids.filter((l) => l.price >= lower).reduce((s, l) => s + l.price * l.size, 0);
  const askUsd = book.asks.filter((l) => l.price <= upper).reduce((s, l) => s + l.price * l.size, 0);
  return { mid, bidUsd, askUsd, thinnerSideUsd: Math.min(bidUsd, askUsd) };
}

function maxTolerablePositionUsd(thinnerSideUsd, participationPct = 10) {
  if (!Number.isFinite(thinnerSideUsd) || thinnerSideUsd <= 0) return 0;
  return thinnerSideUsd * (participationPct / 100);
}

/* ------------------------------------------------------------------ */
/* 候選組裝                                                            */
/* ------------------------------------------------------------------ */

/**
 * 把宇宙資料 + K 線 + OI + 盤口 組成一個候選。
 * autoTradeEligible 永遠是 false —— 本工具不下單。
 */
function buildCandidate(row, klines, oiSeries, orderbook) {
  const m = computeMetrics(klines, oiSeries);
  const score = computeScore(m);
  const stage = deriveStage(score, m);
  const meme = classifyMeme(row.symbol, row.listedDays, row.turnover24hUsd, row.openInterestUsd);

  const c = {
    symbol: row.symbol,
    provider: PROVIDER,
    lastPrice: row.lastPrice,
    score,
    stage,
    change24hPct: row.change24hPct,
    fundingRatePct: row.fundingRatePct,
    turnover24hUsd: row.turnover24hUsd,
    openInterestUsd: row.openInterestUsd,
    listedDays: row.listedDays,
    spreadPct: row.spreadPct,
    ...m,
    riskFlags: [],
    isMeme: meme.isMeme,
    memeReasons: meme.reasons,
    memeConfidence: meme.confidence,
    autoTradeEligible: false,
  };

  const blown = blownOffReasons(c);
  const ev = evaluateEntryGates(c);
  const entryReady = ev.ready && blown.length === 0;

  const stop = entryReady ? suggestStop(m.lastClose, klines) : NaN;
  const targets = entryReady ? buildTargets(m.lastClose, stop) : null;

  const depth = orderbook ? assessDepth(orderbook) : null;
  const maxPositionUsd = depth ? maxTolerablePositionUsd(depth.thinnerSideUsd) : 0;

  return {
    ...c,
    stage: blown.length ? 'EXCLUDED' : stage,
    entryReady,
    entryLow: entryReady && targets ? m.lastClose - targets.riskPerUnit * 0.15 : null,
    entryHigh: entryReady ? m.lastClose : null,
    stopLoss: entryReady && targets ? stop : null,
    takeProfit1: targets?.takeProfit1 ?? null,
    takeProfit2: targets?.takeProfit2 ?? null,
    riskPerUnit: targets?.riskPerUnit ?? null,
    gates: ev.gates,
    readiness: ev.readiness,
    blockingReasons: [...blown, ...ev.reasons],
    staleWarning: Number.isFinite(m.dataAgeMinutes) && m.dataAgeMinutes > ENTRY.staleWarningMinutes,
    depthUsd: depth ? depth.thinnerSideUsd : null,
    maxPositionUsd,
    suggestedRiskPercent: meme.isMeme ? MEME_FIXED_RISK_PERCENT : null,
    riskLabel: riskLabel(meme),
    group: coinGroup(row.symbol, meme.isMeme),
    bybitUrl: bybitContractUrl(row.symbol),
  };
}

function rankCandidates(candidates) {
  return [...candidates]
    .sort((a, b) => {
      if (a.entryReady !== b.entryReady) return a.entryReady ? -1 : 1;
      return b.score - a.score;
    })
    .slice(0, MAX_DISPLAYED);
}

/** 不變量：任何情況下都不得出現「可進場卻缺保護」或「可自動下單」 */
function checkInvariants(c) {
  const v = [];
  if (c.autoTradeEligible !== false) v.push('autoTradeEligible 必須永遠是 false');
  if (c.entryReady && c.blockingReasons.length) v.push('entryReady 為 true 但仍有阻擋原因');
  if (c.entryReady && (c.stopLoss === null || c.takeProfit1 === null || c.takeProfit2 === null)) {
    v.push('entryReady 為 true 但缺少 SL 或 TP');
  }
  if (!c.entryReady && (c.stopLoss !== null || c.takeProfit1 !== null)) v.push('未就緒卻帶出 SL 或 TP');
  if (c.stage === 'EXCLUDED' && c.entryReady) v.push('已排除卻標記為可進場');
  if (!/^https:\/\/www\.bybit\.com\//.test(c.bybitUrl)) v.push('連結未指向 Bybit');
  return v;
}

/**
 * 依分組拆開候選，各組內部都是「可進場的排前面，其餘依分數」。
 * 主幣不套用 MAX_DISPLAYED 上限：觀察清單有幾檔就顯示幾檔。
 */
function splitByGroup(candidates) {
  const sortFn = (a, b) => {
    if (a.entryReady !== b.entryReady) return a.entryReady ? -1 : 1;
    return b.score - a.score;
  };
  const list = candidates ?? [];
  return {
    main: list.filter((c) => c.group === 'main').sort(sortFn),
    meme: list.filter((c) => c.group === 'meme').sort(sortFn).slice(0, MAX_DISPLAYED),
  };
}

/**
 * render — 純字串渲染，不碰 DOM
 *
 * 網頁版與 iPhone Scriptable 版共用同一份卡片標記，
 * 避免兩邊各寫一套後逐漸長歪。
 *
 * 這裡只負責把候選資料變成 HTML 字串。
 * 抓資料在各自的宿主環境做（瀏覽器用 fetch，Scriptable 用 Request）。
 */


{ ago, fpct, fusd, fx, priceDigits, sgn };

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;',
}[c]));

/** 逸出後把換行轉成 <br>，給診斷訊息這種多行文字用 */
const escMultiline = (s) => esc(s).replace(/\r?\n/g, '<br>');

const STAGE_TEXT = {
  NEAR_BREAKOUT: '接近突破',
  BUILDING: '醞釀中',
  WATCH: '觀察',
  EXCLUDED: '已排除',
};

function cardHtml(c) {
  const d = priceDigits(c.lastPrice);
  const stageClass = c.stage === 'NEAR_BREAKOUT' ? 'near' : c.stage === 'EXCLUDED' ? 'excl' : 'build';
  const dots = Array.from({ length: c.readiness.total }, (_, i) =>
    '<i class="dot' + (i < c.readiness.passed ? ' on' : '') + '"></i>').join('');

  const entryBlock = c.entryReady ? `
    <div class="entry">
      <div class="erow"><span>Entry 區</span><b>${fx(c.entryLow, d)} – ${fx(c.entryHigh, d)}</b></div>
      <div class="erow sl"><span>停損 SL</span><b>${fx(c.stopLoss, d)}</b></div>
      <div class="erow tp"><span>TP1 · 1.5R</span><b>${fx(c.takeProfit1, d)}</b></div>
      <div class="erow tp"><span>TP2 · 2.5R</span><b>${fx(c.takeProfit2, d)}</b></div>
      ${c.maxPositionUsd > 0 ? '<div class="erow"><span>盤口可承受</span><b>約 ' + fusd(c.maxPositionUsd) + ' USDT</b></div>' : ''}
    </div>` : '';

  const reasonBlock = c.blockingReasons.length
    ? '<div class="reasons">' + c.blockingReasons.map((r) => '<div>' + esc(r) + '</div>').join('') + '</div>'
    : '';

  const staleBlock = c.staleWarning
    ? '<div class="banner"><div class="bt">資料偏舊</div><div class="bd">此標的資料已 '
      + Math.round(c.dataAgeMinutes) + ' 分鐘未更新。</div></div>'
    : '';

  return `
  <div class="card ${c.entryReady ? 'ready' : ''} ${c.stage === 'EXCLUDED' ? 'excluded' : ''}">
    <div class="chead">
      <span class="sym">${esc(c.symbol)}</span>
      <span class="tag ${stageClass}">${STAGE_TEXT[c.stage] ?? esc(c.stage)}</span>
      ${c.riskLabel ? '<span class="tag meme">' + esc(c.riskLabel) + '</span>' : ''}
      <span class="score"><b>${c.score}</b><span>完成度</span></span>
    </div>

    <div class="readiness">
      <span class="dots">${dots}</span>
      <span class="rtext">進場條件 ${c.readiness.passed}/${c.readiness.total}</span>
    </div>

    ${entryBlock}
    ${reasonBlock}
    ${staleBlock}

    <div class="grid">
      <div class="cell"><span>現價</span><b>${fx(c.lastPrice, d)}</b></div>
      <div class="cell"><span>距突破點</span><b>${fpct(c.breakoutDistancePct)}</b></div>
      <div class="cell"><span>15m 壓縮比</span><b>${fx(c.compressionRatio, 3)}</b></div>
      <div class="cell"><span>量能倍率</span><b>${fx(c.volumeMultiple, 2)}x</b></div>
      <div class="cell"><span>OI 變化</span><b class="${sgn(c.oiChangePct)}">${fpct(c.oiChangePct)}</b></div>
      <div class="cell"><span>資金費率</span><b>${fx(c.fundingRatePct, 4)}%</b></div>
      <div class="cell"><span>1H / 6H</span><b><span class="${sgn(c.change1hPct)}">${fpct(c.change1hPct)}</span> / <span class="${sgn(c.change6hPct)}">${fpct(c.change6hPct)}</span></b></div>
      <div class="cell"><span>24H 成交額</span><b>${fusd(c.turnover24hUsd)}</b></div>
    </div>

    <div class="foot">
      <a href="${c.bybitUrl}" target="_blank" rel="noopener noreferrer">在 Bybit 開啟合約 ↗</a>
      <span class="noauto">僅供研究觀察 · 不自動下單</span>
    </div>
  </div>`;
}

/* ------------------------------------------------------------------ */
/* 帳戶面板（唯讀）                                                      */
/* ------------------------------------------------------------------ */

/**
 * 帳戶摘要與持倉。
 * 全部來自 Bybit 唯讀端點，本工具不會下單也不會改單。
 */
function accountHtml(account) {
  if (!account) return '';

  if (account.error) {
    return `<h2>Bybit 帳戶</h2>
      <div class="banner err">
        <div class="bt">無法讀取帳戶資料</div>
        <div class="bd">${escMultiline(account.error)}</div>
      </div>`;
  }

  const w = account.wallet;
  const positions = account.positions ?? [];
  const today = account.todayPnl;

  const walletBlock = w ? `
    <div class="grid">
      <div class="cell"><span>總權益</span><b>${fmoney(w.totalEquityUsd)} USDT</b></div>
      <div class="cell"><span>可用</span><b>${fmoney(w.totalAvailableUsd)} USDT</b></div>
      <div class="cell"><span>未實現</span><b class="${sgn(w.unrealizedPnlUsd)}">${fmoney(w.unrealizedPnlUsd)}</b></div>
      <div class="cell"><span>今日已實現</span><b class="${sgn(today?.total)}">${fmoney(today?.total)}</b></div>
    </div>` : '';

  const posBlocks = positions.length
    ? positions.map((p) => {
        const prot = p.protection ?? { level: 'danger', text: '未知' };
        const d = priceDigits(p.entryPrice);
        return `
        <div class="card ${prot.level === 'ok' ? '' : 'excluded'}">
          <div class="chead">
            <span class="sym">${esc(p.symbol)}</span>
            <span class="tag ${p.side === 'long' ? 'near' : 'excl'}">${p.side === 'long' ? '▲ 多' : '▼ 空'}</span>
            <span class="tag ${prot.level === 'ok' ? 'build' : 'meme'}">${esc(prot.text)}</span>
            <span class="score"><b class="${sgn(p.unrealizedPnl)}">${fmoney(p.unrealizedPnl)}</b><span>未實現</span></span>
          </div>
          <div class="grid">
            <div class="cell"><span>進場</span><b>${fx(p.entryPrice, d)}</b></div>
            <div class="cell"><span>標記價</span><b>${fx(p.markPrice, d)}</b></div>
            <div class="cell"><span>數量</span><b>${fx(p.size, 4)}</b></div>
            <div class="cell"><span>槓桿</span><b>${fx(p.leverage, 0)}x</b></div>
            <div class="cell"><span>TP</span><b>${p.takeProfit > 0 ? fx(p.takeProfit, d) : '未設定'}</b></div>
            <div class="cell"><span>SL</span><b>${p.stopLoss > 0 ? fx(p.stopLoss, d) : '未設定'}</b></div>
          </div>
        </div>`;
      }).join('')
    : '<div class="empty">目前沒有持倉。</div>';

  return `<h2>Bybit 帳戶 · 唯讀</h2>
    <div class="card">
      <div class="chead">
        <span class="sym">帳戶摘要</span>
        <span class="tag build">${esc(account.keyMask ?? '已連接')}</span>
        <span class="noauto" style="margin-left:auto">唯讀 · 不會下單</span>
      </div>
      ${walletBlock}
    </div>
    ${posBlocks}`;
}

/* ------------------------------------------------------------------ */
/* 候選分區                                                             */
/* ------------------------------------------------------------------ */

function sectionHtml(title, subtitle, candidates, emptyText) {
  if (!candidates.length) {
    return `<h2>${title}</h2><div class="empty">${emptyText}</div>`;
  }
  const ready = candidates.filter((c) => c.entryReady);
  const watch = candidates.filter((c) => !c.entryReady);

  let html = `<h2>${title} · ${candidates.length} 檔</h2>`;
  if (subtitle) html += `<div class="note" style="margin:0 0 10px">${subtitle}</div>`;
  if (ready.length) {
    html += `<div class="subhead">符合全部進場條件 · ${ready.length} 檔</div>` + ready.map(cardHtml).join('');
  }
  if (watch.length) {
    html += `<div class="subhead">觀察中 · ${watch.length} 檔</div>` + watch.map(cardHtml).join('');
  }
  return html;
}

/** 候選清單，含錯誤與空狀態 */
function listHtml(state) {
  let html = '';

  if (state.error) {
    html += `<div class="banner err">
      <div class="bt">無法取得 Bybit 資料</div>
      <div class="bd">${escMultiline(state.error)}</div>
    </div>`;
  }

  if (state.failed && state.failed.length) {
    html += `<div class="banner">
      <div class="bt">${state.failed.length} 檔標的資料抓取失敗</div>
      <div class="bd">${state.failed.map((f) => esc(f.symbol)).join('、')}</div>
    </div>`;
  }

  html += accountHtml(state.account);

  const groups = state.groups ?? { main: [], meme: [] };

  if (!state.busy && state.scannedAt) {
    html += sectionHtml(
      '主幣',
      '固定觀察清單，不論是否符合快噴型態都會顯示目前狀態。',
      groups.main,
      '主幣資料尚未取得。',
    );
    html += sectionHtml(
      '迷因幣／高風險',
      '一律套用固定 0.15% 防守倉，不因分數提高倉位。判斷不出來的標的也歸在這一區。',
      groups.meme,
      '目前沒有符合條件的候選。多數時間市場都不在壓縮待突破的狀態。',
    );
  }

  return html;
}

/** 掃描統計文字 */
function statText(state) {
  if (!state.scannedAt || state.busy) return '';
  return `通過第一階段 ${state.universeCount} 檔，詳細分析 ${state.analyzedCount} 檔`;
}

const DISCLAIMER_HTML = `
  <div class="disc">
    <b>使用前請務必了解</b>
    <ul>
      <li>本頁只讀取 Bybit 公開行情端點，<strong>不連接任何帳戶、不需要也不接受 API Key</strong>，並且<strong>永遠不會下單</strong>。</li>
      <li>完成度分數衡量的是「型態成熟程度」，<strong>不是勝率，也不是報酬預期</strong>。分數高不等於可以進場，必須十項進場條件全部通過。</li>
      <li>Entry、SL、TP 為依 1.5R 與 2.5R 機械換算的參考值，不是投資建議。實際下單前請自行確認盤口深度與可承受風險。</li>
      <li>迷因幣一律標記並套用固定 0.15% 防守倉，不因分數提高倉位。</li>
      <li>加密貨幣永續合約風險極高，可能損失全部本金。本工具不對任何結果作出保證。</li>
    </ul>
  </div>`;

/**
 * worker-core — Cloudflare Worker 的掃描、狀態與通知邏輯
 *
 * 與 iPhone 版、瀏覽器版共用同一份掃描引擎與畫面模組。
 * 差別在於這裡由 cron 定時觸發，狀態存在 KV，手機關機也照跑。
 *
 * 子請求預算（Cloudflare 免費方案每次執行上限 50 個）：
 *   instruments-info + tickers        2
 *   第一段 12 檔 × (kline + OI)      24
 *   第二段 只對可進場的抓盤口 最多 4   4
 *   帳戶（設定了才抓）                3
 *   Discord 通知 最多                5
 *                              合計 ≤ 38
 * 所以刻意分兩段：先用 K 線與未平倉量跑完閘門，
 * 只有通過的少數標的才值得再花一個請求去看盤口深度。
 *
 * 機密一律從 env 讀（Cloudflare Secrets），不寫進程式碼、不寫進 KV、
 * 不出現在任何回應或錯誤訊息裡。
 */





const WORKER_VERSION = 'Crypto Radar Guardian 10.0';
const CRON_MINUTES = 5;

/** 第一段詳細分析的上限，扣掉主幣觀察清單後的名額 */
const MAX_SCAN_TARGETS = 9;
/** 第二段只對可進場的標的抓盤口，避免子請求爆掉 */
const MAX_DEPTH_LOOKUPS = 4;

const KV_KEYS = Object.freeze({
  latest: 'state:latest',
  heartbeat: 'state:heartbeat',
  notify: 'state:notify',
});

/* ------------------------------------------------------------------ */
/* 抓取輔助                                                             */
/* ------------------------------------------------------------------ */

function qs(params) {
  const pairs = [];
  for (const key of Object.keys(params || {})) {
    const v = params[key];
    if (v === undefined || v === null || v === '') continue;
    pairs.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
  }
  return pairs.join('&');
}

/**
 * 建立一組綁定環境的 Bybit 讀取函式。
 * fetchImpl 可注入，測試時換成假的。
 */
function makeBybitClient(env, fetchImpl) {
  const doFetch = fetchImpl ?? fetch;
  const bybitEnv = normalizeEnv(env.BYBIT_ENV);

  async function publicGet(path, params) {
    const query = qs(params);
    const url = publicHostFor(bybitEnv) + path + (query ? `?${query}` : '');
    const res = await doFetch(url, { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    if (json.retCode !== 0) throw new Error(describeBybitError(json.retCode, json.retMsg, bybitEnv));
    return json.result;
  }

  async function signedGet(path, params) {
    const apiKey = sanitizeCredential(env.BYBIT_API_KEY);
    const apiSecret = sanitizeCredential(env.BYBIT_API_SECRET);
    if (!apiKey || !apiSecret) throw new Error('未設定 Bybit 憑證');

    // signGetRequest 內含唯讀端點白名單，下單類端點會被擋下
    const signed = signGetRequest({
      path, params, apiKey, apiSecret, timestamp: Date.now(), env: bybitEnv,
    });
    const res = await doFetch(signed.url, { headers: signed.headers });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    if (json.retCode !== 0) throw new Error(describeBybitError(json.retCode, json.retMsg, bybitEnv));
    return json.result;
  }

  return { publicGet, signedGet, bybitEnv, hasCredentials: Boolean(sanitizeCredential(env.BYBIT_API_KEY) && sanitizeCredential(env.BYBIT_API_SECRET)) };
}

/* ------------------------------------------------------------------ */
/* 掃描                                                                */
/* ------------------------------------------------------------------ */

/**
 * 選出這一輪要分析的標的。
 * 主幣觀察清單一律納入，其餘依第一階段排名補到上限。
 */
function selectWorkerTargets(rows, maxScan = MAX_SCAN_TARGETS) {
  const list = MAIN_WATCHLIST.map((s) => s.toUpperCase());
  const bySymbol = new Map();
  for (const r of rows ?? []) bySymbol.set(String(r.symbol).toUpperCase(), r);

  const main = [];
  for (const symbol of list) {
    const row = bySymbol.get(symbol);
    if (row) main.push(row);
  }
  const rest = (rows ?? []).filter((r) => !list.includes(String(r.symbol).toUpperCase()));
  const scan = rankUniverse(rest.filter(passesUniverseFilter)).slice(0, maxScan);
  return { main, scan, all: [...main, ...scan] };
}

/**
 * 跑一輪完整掃描。
 * 回傳的 state 會被寫進 KV，也是網頁與 /api/scan 的資料來源。
 */
async function runScan(client, now = Date.now()) {
  const [instRes, tickRes] = await Promise.all([
    client.publicGet('/v5/market/instruments-info', { category: 'linear', limit: 1000 }),
    client.publicGet('/v5/market/tickers', { category: 'linear' }),
  ]);

  const rows = buildUniverse(instRes.list ?? [], tickRes.list ?? [], now);
  const universeCount = rows.filter(passesUniverseFilter).length;
  const targets = selectWorkerTargets(rows);

  // 第一段：K 線與未平倉量，先跑完閘門
  const built = [];
  const failed = [];
  for (const row of targets.all) {
    try {
      const [kl, oi] = await Promise.all([
        client.publicGet('/v5/market/kline', { category: 'linear', symbol: row.symbol, interval: 15, limit: 40 }),
        client.publicGet('/v5/market/open-interest', { category: 'linear', symbol: row.symbol, intervalTime: '15min', limit: 5 }),
      ]);
      built.push({ row, candidate: buildCandidate(row, parseKlines(kl.list), parseOpenInterest(oi.list), null) });
    } catch (err) {
      failed.push({ symbol: row.symbol, error: String(err?.message ?? err) });
    }
  }

  // 第二段：只有可進場的標的才值得再花一個請求看盤口深度
  const needsDepth = built.filter((b) => b.candidate.entryReady).slice(0, MAX_DEPTH_LOOKUPS);
  for (const item of needsDepth) {
    try {
      const ob = await client.publicGet('/v5/market/orderbook', { category: 'linear', symbol: item.row.symbol, limit: 50 });
      // 只補深度資訊，閘門結果不重算
      const depth = assessDepth(parseOrderbook(ob));
      item.candidate.depthUsd = depth.thinnerSideUsd;
      item.candidate.maxPositionUsd = maxTolerablePositionUsd(depth.thinnerSideUsd);
    } catch {
      // 深度抓不到就維持沒有深度資訊，不影響閘門結果
    }
  }

  const candidates = built.map((b) => b.candidate);
  return {
    version: WORKER_VERSION,
    scannedAt: now,
    universeCount,
    analyzedCount: targets.all.length,
    candidates,
    groups: splitByGroup(candidates),
    failed,
    busy: false,
    error: null,
    account: null,
  };
}

/* ------------------------------------------------------------------ */
/* 帳戶（唯讀）                                                         */
/* ------------------------------------------------------------------ */

async function fetchAccount(client, env) {
  if (!client.hasCredentials) return null;
  try {
    const [walletRes, posRes, pnlRes] = await Promise.all([
      client.signedGet('/v5/account/wallet-balance', { accountType: 'UNIFIED' }),
      client.signedGet('/v5/position/list', { category: 'linear', settleCoin: 'USDT' }),
      client.signedGet('/v5/position/closed-pnl', { category: 'linear', limit: 50 }),
    ]);
    const positions = parsePositions(posRes).map((p) => ({ ...p, protection: protectionStatus(p) }));
    return {
      wallet: parseWalletBalance(walletRes),
      positions,
      todayPnl: realizedPnlSince(parseClosedPnl(pnlRes), Date.now() - 86_400_000),
      keyMask: maskApiKey(sanitizeCredential(env.BYBIT_API_KEY)),
      error: null,
    };
  } catch (err) {
    const raw = String(err?.message ?? err);
    const key = sanitizeCredential(env.BYBIT_API_KEY);
    const secret = sanitizeCredential(env.BYBIT_API_SECRET);
    const safe = raw.split(key).join('[key]').split(secret).join('[secret]');
    return { error: safe, keyMask: maskApiKey(key) };
  }
}

/* ------------------------------------------------------------------ */
/* Discord                                                             */
/* ------------------------------------------------------------------ */

function makeDiscordPoster(fetchImpl) {
  const doFetch = fetchImpl ?? fetch;
  return async (url, payload) => {
    const res = await doFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`Discord 回應 HTTP ${res.status}`);
  };
}

/**
 * 依掃描結果決定要發哪些通知並送出。
 * 通知狀態存在 KV，跨執行去重。
 */
async function notify(state, env, kv, poster, now = Date.now()) {
  const webhook = env.DISCORD_WEBHOOK;
  if (!isValidWebhookUrl(webhook)) return { sent: 0, error: null, skipped: '未設定 Webhook' };

  const groups = state.groups ?? { main: [], meme: [] };
  const ready = [...groups.main, ...groups.meme].filter((c) => c.entryReady);

  let prev = { sent: {}, lastSentAt: null };
  try {
    const raw = await kv.get(KV_KEYS.notify);
    if (raw) prev = JSON.parse(raw);
  } catch { /* 壞掉的狀態就當成空的重來 */ }

  const picked = selectNotifications(ready, prev, now);

  let sent = 0;
  let lastError = null;
  for (const c of picked.toSend) {
    const res = await sendNotification(poster, webhook, candidateMessage(c));
    if (res.ok) sent += 1; else lastError = res.error;
  }

  if (state.account?.positions) {
    const msg = protectionAlertMessage(state.account.positions);
    if (msg) {
      const res = await sendNotification(poster, webhook, msg);
      if (res.ok) sent += 1; else lastError = res.error;
    }
  }

  // 只有真的送出通知、或清掉了過期紀錄時才寫回，
  // 免費方案的 KV 每日寫入額度有限，不值得每輪都寫一次沒變的狀態。
  const nextJson = JSON.stringify(picked.state);
  if (nextJson !== JSON.stringify(prev)) await kv.put(KV_KEYS.notify, nextJson);

  return { sent, error: lastError, skipped: null };
}

/* ------------------------------------------------------------------ */
/* KV 狀態                                                             */
/* ------------------------------------------------------------------ */

/**
 * 寫入掃描結果與心跳。
 *
 * 帳戶資料刻意不寫進 latest：那份會被公開網頁讀到。
 * 帳戶只在本次執行的記憶體裡用來發保護單警示。
 */
async function saveState(kv, state, now = Date.now()) {
  // 帳戶資料刻意不落地。要看帳戶的人帶 Token 時才即時去 Bybit 查，
  // 這樣既不會有帳戶資料存在 KV 裡，也省下每天約 288 次 KV 寫入。
  const publicState = { ...state, account: null };
  await kv.put(KV_KEYS.latest, JSON.stringify(publicState));
  await kv.put(KV_KEYS.heartbeat, JSON.stringify({
    at: now,
    version: WORKER_VERSION,
    ok: !state.error,
    analyzed: state.analyzedCount,
    failed: state.failed?.length ?? 0,
  }));
}

async function loadState(kv) {
  try {
    const raw = await kv.get(KV_KEYS.latest);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

async function loadHeartbeat(kv) {
  try {
    const raw = await kv.get(KV_KEYS.heartbeat);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* cron 進入點                                                          */
/* ------------------------------------------------------------------ */

/**
 * 一次排程執行：掃描 → 讀帳戶 → 發通知 → 寫 KV。
 * 任何一段失敗都會寫入心跳，讓守衛看得到狀態。
 */
async function runScheduled({ env, kv, fetchImpl, now = Date.now() }) {
  const client = makeBybitClient(env, fetchImpl);
  const poster = makeDiscordPoster(fetchImpl);

  try {
    const state = await runScan(client, now);
    state.account = await fetchAccount(client, env);
    const notifyResult = await notify(state, env, kv, poster, now);
    await saveState(kv, state, now);
    return { ok: true, state, notifyResult };
  } catch (err) {
    const raw = String(err?.message ?? err);
    await kv.put(KV_KEYS.heartbeat, JSON.stringify({
      at: now, version: WORKER_VERSION, ok: false, error: raw,
    }));
    return { ok: false, error: raw };
  }
}

/**
 * worker-routes — Cloudflare Worker 的 HTTP 端點
 *
 *   GET /              最近一次掃描的網頁，手機直接開
 *   GET /health        給 Discord 心跳守衛用的極簡健康檢查
 *   GET /api/status    版本、心跳、排程、資料來源等自檢資訊
 *   GET /api/scan      最近一次掃描的原始 JSON
 *
 * 帳戶資料（餘額與持倉）不會出現在公開頁面。
 * 要看必須帶 ?token= 且與 ADMIN_TOKEN 相符。
 */





const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
const HTML_HEADERS = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' };

const json = (body, status = 200) => new Response(JSON.stringify(body, null, 2), { status, headers: JSON_HEADERS });

/**
 * 定時比較，避免用字串長度或提早返回洩漏 Token 資訊。
 */
function safeEqual(a, b) {
  const x = String(a ?? '');
  const y = String(b ?? '');
  if (x.length === 0 || y.length === 0) return false;
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i += 1) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

/**
 * 兩種帶 Token 的方式都接受：
 *   網址參數 ?token=   給手機直接開網頁用
 *   X-Admin-Token 標頭  給外部排程用，不會留在網址與記錄裡
 */
function isAuthorized(url, env, request) {
  const expected = env.ADMIN_TOKEN;
  if (!expected) return false;
  if (safeEqual(url.searchParams.get('token'), expected)) return true;
  const header = request?.headers?.get?.('x-admin-token');
  return safeEqual(header, expected);
}

/** 心跳年齡（秒）。沒有心跳時回傳 null。 */
function heartbeatAgeSeconds(heartbeat, now) {
  if (!heartbeat || !Number.isFinite(heartbeat.at)) return null;
  return Math.max(0, Math.round((now - heartbeat.at) / 1000));
}

/**
 * 健康狀態判定。
 * 心跳超過兩個排程週期就算不健康，讓守衛在真的漏跑時才叫。
 */
function healthOf(heartbeat, now) {
  const ageSeconds = heartbeatAgeSeconds(heartbeat, now);
  const staleAfter = CRON_MINUTES * 60 * 2 + 60;
  if (ageSeconds === null) return { ok: false, status: 'no-heartbeat', ageSeconds: null };
  if (!heartbeat.ok) return { ok: false, status: 'last-run-failed', ageSeconds };
  if (ageSeconds > staleAfter) return { ok: false, status: 'stale', ageSeconds };
  return { ok: true, status: 'healthy', ageSeconds };
}

async function handleRequest({ request, env, kv, now = Date.now() }) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';

  // 手動觸發一次掃描。
  //
  // 為什麼需要：Cloudflare 免費方案每個帳號只有 5 個 cron 觸發器。
  // 額度用完時，可以改用外部排程（例如 GitHub Actions）定時打這個端點，
  // 效果與 cron 一樣，不佔用 Cloudflare 的額度。
  //
  // 一定要帶管理 Token，否則任何人都能叫它掃描。
  if (path === '/scan') {
    if (!env.ADMIN_TOKEN) {
      return json({ error: '未設定 ADMIN_TOKEN，手動觸發已停用' }, 403);
    }
    if (!isAuthorized(url, env, request)) {
      return json({ error: 'unauthorized' }, 401);
    }
    const result = await runScheduled({ env, kv, now });
    if (!result.ok) return json({ ok: false, error: result.error }, 500);
    const g = result.state.groups;
    return json({
      ok: true,
      scannedAt: result.state.scannedAt,
      analyzed: result.state.analyzedCount,
      ready: [...g.main, ...g.meme].filter((c) => c.entryReady).length,
      notified: result.notifyResult?.sent ?? 0,
    });
  }

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return json({ error: 'method not allowed' }, 405);
  }

  const heartbeat = await loadHeartbeat(kv);
  const health = healthOf(heartbeat, now);

  if (path === '/health') {
    return json({
      ok: health.ok,
      status: health.status,
      version: WORKER_VERSION,
      heartbeatAt: heartbeat?.at ?? null,
      ageSeconds: health.ageSeconds,
    }, health.ok ? 200 : 503);
  }

  if (path === '/api/status') {
    const state = await loadState(kv);
    return json({
      version: WORKER_VERSION,
      engine: ENGINE_VERSION,
      health: health.status,
      ok: health.ok,
      heartbeatAt: heartbeat?.at ?? null,
      heartbeatAgeSeconds: health.ageSeconds,
      cron: `每 ${CRON_MINUTES} 分鐘`,
      moonshotProvider: PROVIDER,
      bybitEnvironment: ENV_LABEL[normalizeEnv(env.BYBIT_ENV)],
      // 這個服務只讀取行情與唯讀帳戶資料，沒有下單路徑
      tradeMode: 'read-only',
      autoTrading: false,
      discordConfigured: Boolean(env.DISCORD_WEBHOOK),
      bybitAccountConfigured: Boolean(env.BYBIT_API_KEY && env.BYBIT_API_SECRET),
      lastScanAt: state?.scannedAt ?? null,
      universeCount: state?.universeCount ?? null,
      analyzedCount: state?.analyzedCount ?? null,
      readyCount: state ? [...(state.groups?.main ?? []), ...(state.groups?.meme ?? [])].filter((c) => c.entryReady).length : null,
      failedCount: state?.failed?.length ?? null,
    });
  }

  if (path === '/api/scan') {
    const state = await loadState(kv);
    if (!state) return json({ error: '尚未有掃描結果' }, 503);
    return json(state);
  }

  if (path === '/') {
    const state = await loadState(kv);
    // 帳戶資料不存 KV。帶對 Token 的人才即時去 Bybit 查一次。
    const account = isAuthorized(url, env, request)
      ? await fetchAccount(makeBybitClient(env), env)
      : null;
    return new Response(pageHtml(state, account, heartbeat, health, env, now), { headers: HTML_HEADERS });
  }

  return json({ error: 'not found' }, 404);
}

/* ------------------------------------------------------------------ */
/* 網頁                                                                */
/* ------------------------------------------------------------------ */

function fmtTime(ms) {
  if (!Number.isFinite(ms)) return '—';
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}

function pageHtml(state, account, heartbeat, health, env, now) {
  const groups = state?.groups ?? { main: [], meme: [] };
  const readyCount = [...groups.main, ...groups.meme].filter((c) => c.entryReady).length;

  const healthTone = health.ok ? 'ok' : 'warn';
  const healthText = health.ok
    ? `運作正常 · 心跳 ${health.ageSeconds} 秒前`
    : health.status === 'no-heartbeat'
      ? '尚未執行過排程掃描'
      : health.status === 'last-run-failed'
        ? '上一次排程執行失敗'
        : `心跳已 ${Math.round((health.ageSeconds ?? 0) / 60)} 分鐘未更新`;

  const banner = health.ok ? '' : `
    <div class="banner">
      <div class="bt">${healthText}</div>
      <div class="bd">排程為每 ${CRON_MINUTES} 分鐘一次。若持續異常，請到 Cloudflare 檢查 Worker 的 Cron 觸發器與記錄。</div>
    </div>`;

  const viewState = state
    ? { ...state, account, busy: false }
    : { candidates: [], groups: { main: [], meme: [] }, failed: [], scannedAt: null, busy: false, error: null, account: null };

  const accountHint = account ? '' : `
    <div style="margin-top:6px;color:var(--muted)">帳戶資料未顯示。若已設定 ADMIN_TOKEN，請在網址加上 <code>?token=你的Token</code>。</div>`;

  return `<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="color-scheme" content="dark">
<meta name="robots" content="noindex, nofollow">
<meta http-equiv="refresh" content="300">
<title>Crypto Radar Guardian</title>
<style>:root {
  color-scheme: dark;
  --bg: #050d17;
  --panel: #081321;
  --panel-2: #0b1a2c;
  --line: rgba(34, 211, 238, 0.16);
  --line-soft: rgba(34, 211, 238, 0.08);
  --text: #cfe6f2;
  --muted: #6d8ca6;
  --cyan: #22d3ee;
  --green: #34d399;
  --amber: #ffb020;
  --red: #ff4d6d;
  --violet: #a78bfa;
}
* { box-sizing: border-box; }
html, body { margin: 0; background: var(--bg); }
body {
  font: 15px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans TC", "PingFang TC", sans-serif;
  color: var(--text);
  padding: env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left);
  -webkit-text-size-adjust: 100%;
}
.wrap { max-width: 640px; margin: 0 auto; padding: 14px 12px 40px; }

header { position: sticky; top: 0; z-index: 20; background: linear-gradient(180deg, var(--bg) 72%, transparent); padding-top: 8px; }
.title { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
h1 { font-size: 19px; margin: 0; letter-spacing: .02em; }
.ver { font-size: 11px; color: var(--muted); font-variant-numeric: tabular-nums; }
.srcbadge {
  display: inline-flex; align-items: center; gap: 5px;
  font-size: 11px; color: var(--cyan); border: 1px solid var(--line);
  border-radius: 999px; padding: 2px 9px; background: rgba(34, 211, 238, .06);
}
.srcbadge b { font-weight: 600; }

.bar { display: flex; gap: 8px; align-items: center; margin-top: 10px; }
button {
  font: inherit; font-size: 14px; color: var(--text);
  background: var(--panel-2); border: 1px solid var(--line);
  border-radius: 10px; padding: 9px 14px; cursor: pointer;
  min-height: 42px; -webkit-tap-highlight-color: transparent;
}
button:active { background: #10263c; }
button[disabled] { opacity: .5; cursor: default; }
button.primary { border-color: rgba(34, 211, 238, .45); color: #e6fbff; }
.meta { font-size: 12px; color: var(--muted); font-variant-numeric: tabular-nums; margin-left: auto; text-align: right; }

.note {
  margin: 12px 0 0; padding: 10px 12px; border-radius: 10px;
  background: var(--panel); border: 1px solid var(--line-soft);
  font-size: 12.5px; color: var(--muted);
}
.note strong { color: var(--text); font-weight: 600; }

.banner { margin-top: 12px; padding: 11px 13px; border-radius: 11px; background: var(--panel); border-left: 3px solid var(--amber); }
.banner.err { border-left-color: var(--red); }
.banner .bt { font-size: 13.5px; color: #ffe9c2; font-weight: 600; }
.banner.err .bt { color: #ffd6de; }
.banner .bd { font-size: 12.5px; color: var(--muted); margin-top: 3px; }

.progress { height: 3px; background: var(--panel-2); border-radius: 2px; overflow: hidden; margin-top: 12px; }
.progress i { display: block; height: 100%; background: linear-gradient(90deg, var(--cyan), var(--violet)); width: 0; transition: width .25s ease; }

h2 { font-size: 13px; color: var(--muted); font-weight: 600; letter-spacing: .06em; margin: 22px 0 10px; text-transform: uppercase; }

.card {
  background: var(--panel); border: 1px solid var(--line-soft);
  border-radius: 13px; padding: 13px; margin-bottom: 11px;
}
.card.ready { border-color: rgba(52, 211, 153, .38); box-shadow: 0 0 0 1px rgba(52, 211, 153, .09), 0 6px 22px -14px rgba(52, 211, 153, .5); }
.card.excluded { opacity: .72; }

.chead { display: flex; align-items: center; gap: 9px; flex-wrap: wrap; }
.sym { font-size: 17px; font-weight: 650; letter-spacing: .01em; }
.tag { font-size: 10.5px; padding: 2px 7px; border-radius: 5px; border: 1px solid var(--line); color: var(--muted); white-space: nowrap; }
.tag.near { color: var(--green); border-color: rgba(52, 211, 153, .4); }
.tag.build { color: var(--cyan); border-color: rgba(34, 211, 238, .35); }
.tag.excl { color: var(--red); border-color: rgba(255, 77, 109, .35); }
.tag.meme { color: var(--amber); border-color: rgba(255, 176, 32, .4); }
.score { margin-left: auto; text-align: right; }
.score b { font-size: 21px; font-variant-numeric: tabular-nums; letter-spacing: -.01em; }
.score span { display: block; font-size: 10.5px; color: var(--muted); }

.readiness { display: flex; align-items: center; gap: 8px; margin-top: 10px; }
.dots { display: flex; gap: 3px; }
.dot { width: 7px; height: 7px; border-radius: 2px; background: rgba(255,255,255,.13); }
.dot.on { background: var(--green); }
.rtext { font-size: 12px; color: var(--muted); font-variant-numeric: tabular-nums; }

.reasons { margin: 9px 0 0; padding: 9px 11px; border-radius: 9px; background: rgba(255, 77, 109, .06); border: 1px solid rgba(255, 77, 109, .18); }
.reasons div { font-size: 12.5px; color: #ffc9d4; padding: 1.5px 0; }
.reasons div::before { content: "✕ "; color: var(--red); }

.entry { margin-top: 10px; padding: 10px 11px; border-radius: 9px; background: rgba(52, 211, 153, .06); border: 1px solid rgba(52, 211, 153, .2); }
.erow { display: flex; justify-content: space-between; font-size: 13px; padding: 2.5px 0; font-variant-numeric: tabular-nums; }
.erow span { color: var(--muted); }
.erow b { font-weight: 600; }
.erow.tp b { color: var(--green); }
.erow.sl b { color: var(--red); }

.grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 7px 12px; margin-top: 11px; }
.cell { font-size: 12px; display: flex; justify-content: space-between; gap: 6px; font-variant-numeric: tabular-nums; }
.cell span { color: var(--muted); }
.cell b { font-weight: 600; }
.pos { color: var(--green); }
.neg { color: var(--red); }

.foot { display: flex; align-items: center; gap: 10px; margin-top: 11px; padding-top: 10px; border-top: 1px solid var(--line-soft); }
.foot a { color: var(--cyan); font-size: 12.5px; text-decoration: none; border-bottom: 1px solid rgba(34,211,238,.3); }
.noauto { font-size: 11px; color: var(--muted); margin-left: auto; }

.empty { padding: 26px 14px; text-align: center; color: var(--muted); font-size: 13.5px; background: var(--panel); border-radius: 12px; border: 1px dashed var(--line-soft); }

.disc { margin-top: 26px; padding: 13px; border-radius: 11px; background: var(--panel); border: 1px solid var(--line-soft); font-size: 11.5px; line-height: 1.65; color: var(--muted); }
.disc b { color: var(--text); display: block; margin-bottom: 5px; font-size: 12.5px; }
.disc li { margin: 3px 0; }
.disc ul { margin: 5px 0 0; padding-left: 17px; }

@media (max-width: 380px) { .grid { grid-template-columns: 1fr; } h1 { font-size: 17px; } }

.subhead {
  font-size: 12px; color: var(--muted); margin: 14px 0 8px;
  display: flex; align-items: center; gap: 8px;
}
.subhead::after { content: ""; flex: 1; height: 1px; background: var(--line-soft); }</style>
</head>
<body>
<div class="wrap">
  <header>
    <div class="title">
      <h1>Crypto Radar Guardian</h1>
      <span class="ver">v10.0 · Cloudflare Worker</span>
    </div>
    <div style="margin-top:6px">
      <span class="srcbadge">◈ 資料來源 <b>Bybit /v5/market</b></span>
    </div>
    <div class="bar">
      <span class="meta" style="margin-left:0">
        掃描於 ${fmtTime(state?.scannedAt)}　·　符合進場條件 ${readyCount} 檔
      </span>
    </div>
  </header>

  ${banner}

  <div class="note">
    <strong>早期快噴掃描</strong>：在 Bybit USDT 線性永續中，尋找「已壓縮、量能溫和放大、未平倉量增加、且尚未突破前高」的標的。
    已經噴過的一律排除。${statText({ ...viewState, scannedAt: state?.scannedAt })}
    <div style="margin-top:6px;color:var(--muted)">
      由 Cloudflare Worker 每 ${CRON_MINUTES} 分鐘自動掃描，${healthText}。本頁每 5 分鐘自動重新整理。
    </div>${accountHint}
  </div>

  ${listHtml(viewState)}
${DISCLAIMER_HTML}
</div>
</body>
</html>`;
}

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
