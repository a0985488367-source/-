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

export const BYBIT_ENVIRONMENTS = Object.freeze(['live', 'demo', 'testnet']);

export const ENV_LABEL = Object.freeze({
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
export const BYBIT_BASE = PUBLIC_HOSTS.live;

export function normalizeEnv(env) {
  return BYBIT_ENVIRONMENTS.includes(env) ? env : 'live';
}

export function privateHostFor(env) {
  return PRIVATE_HOSTS[normalizeEnv(env)];
}

export function publicHostFor(env) {
  return PUBLIC_HOSTS[normalizeEnv(env)];
}

/**
 * 清掉貼上時常見的雜訊：前後空白、換行、不斷行空格、零寬字元、BOM。
 *
 * 在 iPhone 上貼 API Key 很容易夾帶這些看不見的字元，
 * 而它們會讓 Key 比對失敗，錯誤訊息卻只說「invalid」，非常難查。
 */
export function sanitizeCredential(value) {
  // \s 涵蓋一般空白與換行；另外明確列出貼上時常見的不可見字元：
  // U+00A0 不斷行空格、U+200B~U+200D 零寬字元、U+2060 word joiner、U+FEFF BOM
  return String(value ?? '').replace(/[\s\u00A0\u200B-\u200D\u2060\uFEFF]/g, '');
}

/**
 * 把 Bybit 的錯誤碼翻成看得懂、而且講得出下一步的說明。
 *
 * 只描述已知的對應關係，沒把握的就照實說不確定，不亂猜。
 */
export function describeBybitError(retCode, retMsg, env) {
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
