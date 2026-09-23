/**
 * 集中讀環境變數、做基本驗證。故意在啟動當下就檢查完，缺什麼直接讓
 * process 起不來、印出清楚的錯誤，不要讓服務帶著「金鑰是空字串」這種
 * 半殘狀態上線，跑到第一筆交易才發現。
 */
function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`缺少必要的環境變數 ${name}（看 .env.example）`);
  return v;
}

const liveTradingRaw = (process.env.LIVE_TRADING || 'false').trim().toLowerCase();
// 故意只認完全等於 'true' 這個字串——任何其他值（空字串、'1'、拼錯字、
// 沒設定）一律當成 false，寧可保守也不要因為打字習慣不同就不小心切成真錢。
const liveTrading = liveTradingRaw === 'true';

export const config = {
  port: Number(process.env.PORT || 8787),
  trustProxy: (process.env.TRUST_PROXY || 'false').trim().toLowerCase() === 'true',

  bybitApiKey: required('BYBIT_API_KEY'),
  bybitApiSecret: required('BYBIT_API_SECRET'),
  liveTrading,
  // LIVE_TRADING 只能透過這個環境變數控制，程式碼其他地方（尤其是 HTTP
  // 請求的 body）絕對不能有任何欄位可以覆蓋這個值——見 src/bybit.js。
  bybitHost: liveTrading ? 'https://api.bybit.com' : 'https://api-demo.bybit.com',

  hmacSecret: required('EXECUTOR_HMAC_SECRET'),
  discordWebhookUrl: process.env.DISCORD_WEBHOOK_URL || '',

  healthCheckIntervalMin: Number(process.env.HEALTH_CHECK_INTERVAL_MIN || 5),
  requestMaxAgeSec: Number(process.env.REQUEST_MAX_AGE_SEC || 30),
  bybitTimeoutSec: Number(process.env.BYBIT_TIMEOUT_SEC || 15),
};

if (config.hmacSecret.length < 32) {
  throw new Error('EXECUTOR_HMAC_SECRET 太短（少於 32 字元），用 openssl rand -hex 32 重新產生一組');
}

if (config.liveTrading) {
  // 不是禁止，是要求「這是有意為之」——啟動 log 大聲印出來，不要讓人
  // 不小心用了別人留下來、或忘記改回去的正式環境設定。
  console.warn('⚠️⚠️⚠️ LIVE_TRADING=true —— 這是真錢交易模式，不是模擬盤 ⚠️⚠️⚠️');
}
